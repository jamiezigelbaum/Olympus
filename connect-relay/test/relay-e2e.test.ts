/**
 * End to end over loopback: relay + install client + mock ACME + fake worker.
 * A hosted agent opens TLS with SNI `<install-id>.<zone>` to the relay and
 * reaches the fake worker; the relay only ever forwards ciphertext.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConnect, type ConnectHandle } from '../client/connect.ts';
import { loadOrCreateIdentity } from '../client/identity.ts';
import {
  PROTOCOL_VERSION,
  acmeChallengeName,
  base64url,
  installIdForPublicKey,
  signInstallMessage,
  spkiOf,
} from '../shared/protocol.ts';
import { tlsAlertRecord, TLS_ALERT } from '../shared/sni.ts';
import { MemoryDnsProvider } from '../server/dns.ts';
import type { RelayLimits } from '../server/public-path.ts';
import { MemoryInstallRegistry } from '../server/registry.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';
import { startMockAcme, type MockAcme } from './helpers/mock-acme.ts';
import { agentRequest, captureClientHello, openControl, rawExchange } from './helpers/net.ts';
import { createTestCa, type TestCa } from './helpers/pki.ts';

const ZONE = 'connect.olympus.test';
const CONTROL_HOST = `relay.${ZONE}`;
const REQUEST_MARKER = 'agent-question-7f3a91c2-plaintext';
const RESPONSE_MARKER = 'olympus-answer-5bd204e8-plaintext';

let ca: TestCa;
let acme: MockAcme;
let dns: MemoryDnsProvider;
let worker: http.Server;
let workerUrl: string;
const workerRequests: Array<{ url: string | undefined; headers: IncomingHttpHeaders; body: string }> = [];
const stateDirs: string[] = [];
const relays: RelayHandle[] = [];
const connects: ConnectHandle[] = [];

function newStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-install-'));
  stateDirs.push(dir);
  return dir;
}

async function makeRelay(limits: Partial<RelayLimits> = {}, tap?: (direction: 'to-install' | 'to-agent', chunk: Buffer) => void) {
  const registry = new MemoryInstallRegistry();
  const controlTls = ca.issue(CONTROL_HOST);
  const relay = await startRelay({
    zone: ZONE,
    controlHost: CONTROL_HOST,
    controlTls,
    registry,
    dns,
    listen: { host: '127.0.0.1', port: 0 },
    limits,
    ...(tap ? { tap } : {}),
  });
  relays.push(relay);
  return { relay, registry };
}

async function connectInstall(relay: RelayHandle, stateDir = newStateDir()) {
  const handle = await startConnect({
    stateDir,
    relayHost: '127.0.0.1',
    relayPort: relay.port,
    controlServerName: CONTROL_HOST,
    ca: ca.cert,
    target: workerUrl,
    heartbeatMs: 1_000,
    backoff: { minMs: 50, maxMs: 200 },
    acme: { directoryUrl: acme.directoryUrl, termsOfServiceAgreed: true, propagationDelayMs: 0, pollIntervalMs: 20 },
  });
  connects.push(handle);
  return { handle, stateDir, hostname: new URL(await handle.url()).hostname };
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  ca = createTestCa();
  dns = new MemoryDnsProvider();
  acme = await startMockAcme({ lookupTxt: (name) => dns.lookupTxt(name), signCsr: (der) => ca.signCsr(der) });
  worker = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      workerRequests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answer: RESPONSE_MARKER, path: req.url }));
    });
  });
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
  workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const handle of connects) await handle.stop().catch(() => {});
  for (const relay of relays) await relay.close().catch(() => {});
  await acme.close();
  await new Promise<void>((resolve) => worker.close(() => resolve()));
  for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true });
  ca.cleanup();
});

describe('connect relay end to end', () => {
  test('a hosted agent reaches the local worker through SNI pass-through, and the relay sees only ciphertext', async () => {
    const forwarded: Record<'to-install' | 'to-agent', Buffer[]> = { 'to-install': [], 'to-agent': [] };
    const { relay, registry } = await makeRelay({}, (direction, chunk) => forwarded[direction].push(Buffer.from(chunk)));
    const { stateDir, hostname } = await connectInstall(relay);
    const installId = hostname.split('.')[0]!;

    // Registration proved possession of the key the id is derived from.
    expect(registry.get(installId)?.installId).toBe(installId);
    expect(hostname).toBe(`${installId}.${ZONE}`);
    // DNS-01 ran through the relay: explicit address record, TXT cleared after issuance.
    expect(acme.issued).toContain(hostname);
    expect(dns.addresses.has(hostname)).toBe(true);
    expect(dns.lookupTxt(acmeChallengeName(installId, ZONE))).toEqual([]);
    for (const file of ['install-key.pem', 'acme-account-key.pem', 'tls-key.pem', 'tls-cert.pem']) {
      expect(statSync(join(stateDir, file)).mode & 0o777).toBe(0o600);
    }

    const before = workerRequests.length;
    const response = await agentRequest({
      port: relay.port,
      servername: hostname,
      ca: ca.cert,
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', 'x-olympus-relay': 'forged' },
      body: JSON.stringify({ question: REQUEST_MARKER }),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).answer).toBe(RESPONSE_MARKER);

    const seen = workerRequests.slice(before);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/mcp');
    expect(seen[0]!.body).toContain(REQUEST_MARKER);
    expect(seen[0]!.headers.host).toBe(hostname);
    expect(seen[0]!.headers['x-olympus-relay']).toBe('1');
    expect(seen[0]!.headers['x-forwarded-proto']).toBe('https');
    // The agent's own forwarding claims are discarded; the relay's view is used.
    expect(seen[0]!.headers['x-forwarded-for']).toBe('127.0.0.1');

    // Everything the relay forwarded was TLS records, and no plaintext marker
    // appears in either direction.
    const toInstall = Buffer.concat(forwarded['to-install']);
    const toAgent = Buffer.concat(forwarded['to-agent']);
    expect(toInstall.length).toBeGreaterThan(0);
    expect(toAgent.length).toBeGreaterThan(0);
    expect(toInstall[0]).toBe(0x16);
    expect(toAgent[0]).toBe(0x16);
    for (const stream of [toInstall, toAgent]) {
      expect(stream.includes(REQUEST_MARKER)).toBe(false);
      expect(stream.includes(RESPONSE_MARKER)).toBe(false);
      expect(stream.includes('HTTP/1.1')).toBe(false);
      expect(stream.includes('/mcp')).toBe(false);
    }
  });

  test('only the remote agent surface is forwarded; loopback-only worker routes stay unreachable', async () => {
    const { relay } = await makeRelay();
    const { hostname } = await connectInstall(relay);
    const before = workerRequests.length;
    for (const path of ['/dashboard', '/', '/mcp/../dashboard', '/mcp%2f..%2fdashboard', '/mcpx', '//mcp']) {
      const response = await agentRequest({ port: relay.port, servername: hostname, ca: ca.cert, path });
      expect(response.status).toBe(404);
    }
    expect(workerRequests.length).toBe(before);
    const allowed = await agentRequest({ port: relay.port, servername: hostname, ca: ca.cert, path: '/mcp/session?x=1' });
    expect(allowed.status).toBe(200);
  });

  test('a restarted install reuses its identity, registration and certificate', async () => {
    const { relay } = await makeRelay();
    const first = await connectInstall(relay);
    await first.handle.stop();
    const issuedBefore = acme.issued.length;
    const second = await connectInstall(relay, first.stateDir);
    expect(second.hostname).toBe(first.hostname);
    expect(acme.issued.length).toBe(issuedBefore);
    const response = await agentRequest({ port: relay.port, servername: second.hostname, ca: ca.cert, path: '/mcp' });
    expect(response.status).toBe(200);
  });

  test('an unknown install name gets a fatal unrecognized_name alert', async () => {
    const { relay } = await makeRelay();
    const unknown = `${'a'.repeat(32)}.${ZONE}`;
    const reply = await rawExchange(relay.port, await captureClientHello(unknown));
    expect(reply).toEqual(tlsAlertRecord(TLS_ALERT.unrecognizedName));
    const foreign = await rawExchange(relay.port, await captureClientHello('example.com'));
    expect(foreign).toEqual(tlsAlertRecord(TLS_ALERT.unrecognizedName));
    await expect(agentRequest({ port: relay.port, servername: unknown, ca: ca.cert, path: '/mcp' })).rejects.toThrow();
  });

  test('an offline install gets an immediate fatal internal_error alert, not a hang', async () => {
    const { relay } = await makeRelay();
    const { handle, hostname } = await connectInstall(relay);
    await handle.stop();
    await until(() => relay.onlineInstalls().length === 0);
    const started = Date.now();
    const reply = await rawExchange(relay.port, await captureClientHello(hostname));
    expect(reply).toEqual(tlsAlertRecord(TLS_ALERT.internalError));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('an install that does not attach in time gets internal_error, and concurrency is capped per install', async () => {
    const { relay, registry } = await makeRelay({ attachTimeoutMs: 300, maxConcurrentPerInstall: 1 });
    // A registered install whose session ignores `open` (e.g. still waiting for its certificate).
    const identity = loadOrCreateIdentity(newStateDir());
    const control = openControl(relay.port, CONTROL_HOST, ca.cert);
    const challenge = await control.next();
    control.send({
      type: 'register',
      v: PROTOCOL_VERSION,
      installId: identity.installId,
      publicKey: identity.publicKeySpki,
      sig: signInstallMessage(identity.privateKey, 'register', String(challenge.nonce), identity.installId),
    });
    expect((await control.next()).type).toBe('ready');
    expect(registry.get(identity.installId)).toBeDefined();
    const hello = await captureClientHello(`${identity.installId}.${ZONE}`);
    const first = rawExchange(relay.port, hello);
    expect((await control.next()).type).toBe('open');
    const second = await rawExchange(relay.port, hello);
    expect(second).toEqual(tlsAlertRecord(TLS_ALERT.internalError));
    expect(await first).toEqual(tlsAlertRecord(TLS_ALERT.internalError));
    control.destroy();
  });
});

describe('install authentication', () => {
  test('forged, replayed, and unregistered install keys are rejected', async () => {
    const { relay, registry } = await makeRelay();
    const owner = loadOrCreateIdentity(newStateDir());
    const attacker = generateKeyPairSync('ed25519');
    const attackerSpki = base64url(spkiOf(attacker.publicKey));

    // Unregistered install: hello is refused.
    let control = openControl(relay.port, CONTROL_HOST, ca.cert);
    let challenge = await control.next();
    control.send({ type: 'hello', v: PROTOCOL_VERSION, installId: owner.installId, sig: signInstallMessage(owner.privateKey, 'hello', String(challenge.nonce), owner.installId) });
    expect(await control.next()).toMatchObject({ type: 'error', code: 'unregistered' });

    // Claiming the owner's id with the attacker's key: the id is not derived from that key.
    control = openControl(relay.port, CONTROL_HOST, ca.cert);
    challenge = await control.next();
    control.send({ type: 'register', v: PROTOCOL_VERSION, installId: owner.installId, publicKey: attackerSpki, sig: signInstallMessage(attacker.privateKey, 'register', String(challenge.nonce), owner.installId) });
    expect(await control.next()).toMatchObject({ type: 'error', code: 'id_mismatch' });

    // Owner's public key, signed by someone else: no proof of possession.
    control = openControl(relay.port, CONTROL_HOST, ca.cert);
    challenge = await control.next();
    control.send({ type: 'register', v: PROTOCOL_VERSION, installId: owner.installId, publicKey: owner.publicKeySpki, sig: signInstallMessage(attacker.privateKey, 'register', String(challenge.nonce), owner.installId) });
    expect(await control.next()).toMatchObject({ type: 'error', code: 'bad_signature' });
    expect(registry.get(owner.installId)).toBeUndefined();

    // Genuine registration.
    control = openControl(relay.port, CONTROL_HOST, ca.cert);
    challenge = await control.next();
    const genuine = signInstallMessage(owner.privateKey, 'register', String(challenge.nonce), owner.installId);
    control.send({ type: 'register', v: PROTOCOL_VERSION, installId: owner.installId, publicKey: owner.publicKeySpki, sig: genuine });
    expect(await control.next()).toMatchObject({ type: 'ready', installId: owner.installId });

    // Replaying that signature on a new connection fails: the nonce differs.
    const replay = openControl(relay.port, CONTROL_HOST, ca.cert);
    await replay.next();
    replay.send({ type: 'register', v: PROTOCOL_VERSION, installId: owner.installId, publicKey: owner.publicKeySpki, sig: genuine });
    expect(await replay.next()).toMatchObject({ type: 'error', code: 'bad_signature' });

    // Hello for the registered id signed by the attacker.
    const forged = openControl(relay.port, CONTROL_HOST, ca.cert);
    challenge = await forged.next();
    forged.send({ type: 'hello', v: PROTOCOL_VERSION, installId: owner.installId, sig: signInstallMessage(attacker.privateKey, 'hello', String(challenge.nonce), owner.installId) });
    expect(await forged.next()).toMatchObject({ type: 'error', code: 'bad_signature' });

    // An attacker cannot attach to (hijack) the owner's pending public connection.
    const pendingAgent = rawExchange(relay.port, await captureClientHello(`${owner.installId}.${ZONE}`));
    const open = await control.next();
    expect(open.type).toBe('open');
    const hijack = openControl(relay.port, CONTROL_HOST, ca.cert);
    challenge = await hijack.next();
    hijack.send({ type: 'attach', v: PROTOCOL_VERSION, installId: owner.installId, connId: open.connId, sig: signInstallMessage(attacker.privateKey, 'attach', String(challenge.nonce), owner.installId, String(open.connId)) });
    expect(await hijack.next()).toMatchObject({ type: 'error', code: 'bad_signature' });
    // Nor guess a connection id, even with the right key.
    const guess = openControl(relay.port, CONTROL_HOST, ca.cert);
    challenge = await guess.next();
    const guessed = 'A'.repeat(22);
    guess.send({ type: 'attach', v: PROTOCOL_VERSION, installId: owner.installId, connId: guessed, sig: signInstallMessage(owner.privateKey, 'attach', String(challenge.nonce), owner.installId, guessed) });
    expect(await guess.next()).toMatchObject({ type: 'error', code: 'unknown_connection' });
    control.destroy();
    expect((await pendingAgent).length).toBeGreaterThan(0);
  });

  test('registrations are rate limited per source address', async () => {
    const { relay } = await makeRelay({ registrationsPerIp: { capacity: 1, refillPerSecond: 0 } });
    const results: unknown[] = [];
    for (let i = 0; i < 2; i += 1) {
      const identity = loadOrCreateIdentity(newStateDir());
      const control = openControl(relay.port, CONTROL_HOST, ca.cert);
      const challenge = await control.next();
      control.send({ type: 'register', v: PROTOCOL_VERSION, installId: identity.installId, publicKey: identity.publicKeySpki, sig: signInstallMessage(identity.privateKey, 'register', String(challenge.nonce), identity.installId) });
      results.push(await control.next());
      control.destroy();
    }
    expect(results[0]).toMatchObject({ type: 'ready' });
    expect(results[1]).toMatchObject({ type: 'error', code: 'rate_limited' });
  });

  test('an install can only publish ACME TXT values under its own name, within limits', async () => {
    const { relay } = await makeRelay({ acmeDnsPerInstall: { capacity: 1, refillPerSecond: 0 } });
    const identity = loadOrCreateIdentity(newStateDir());
    const control = openControl(relay.port, CONTROL_HOST, ca.cert);
    const challenge = await control.next();
    control.send({ type: 'register', v: PROTOCOL_VERSION, installId: identity.installId, publicKey: identity.publicKeySpki, sig: signInstallMessage(identity.privateKey, 'register', String(challenge.nonce), identity.installId) });
    await control.next();
    control.send({ type: 'acme-dns-set', id: 'bad', value: 'not a digest; also: _acme-challenge.other' });
    expect(await control.next()).toMatchObject({ type: 'acme-dns-result', id: 'bad', ok: false });
    const value = 'B'.repeat(43);
    control.send({ type: 'acme-dns-set', id: 'good', value });
    expect(await control.next()).toMatchObject({ type: 'acme-dns-result', id: 'good', ok: true });
    expect(dns.lookupTxt(acmeChallengeName(identity.installId, ZONE))).toEqual([value]);
    control.send({ type: 'acme-dns-set', id: 'again', value: 'C'.repeat(43) });
    expect(await control.next()).toMatchObject({ type: 'acme-dns-result', id: 'again', ok: false, error: 'rate_limited' });
    // Values a session published are withdrawn when the session ends.
    control.destroy();
    await until(() => dns.lookupTxt(acmeChallengeName(identity.installId, ZONE)).length === 0);
  });

  test('install ids are self-certifying', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const id = installIdForPublicKey(spkiOf(publicKey));
    expect(id).toMatch(/^[a-z2-7]{32}$/);
    expect(installIdForPublicKey(spkiOf(generateKeyPairSync('ed25519').publicKey))).not.toBe(id);
  });
});
