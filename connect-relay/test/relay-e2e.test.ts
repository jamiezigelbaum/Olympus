/**
 * End to end over loopback: relay + install client + mock ACME + fake worker.
 * A hosted agent opens TLS with SNI `<install-id>.<zone>` to the relay and
 * reaches the fake worker; the relay only ever forwards ciphertext.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { X509Certificate, createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import tls from 'node:tls';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestRenewalMoment, startConnect, type ConnectHandle } from '../client/connect.ts';
import { ariCertId } from '../client/ari.ts';
import { loadOrCreateIdentity } from '../client/identity.ts';
import { RelayClient } from '../client/relay-client.ts';
import {
  PROTOCOL_VERSION,
  acmeChallengeName,
  base64url,
  installIdForPublicKey,
  signInstallMessage,
  spkiOf,
} from '../shared/protocol.ts';
import { tlsAlertRecord, TLS_ALERT } from '../shared/sni.ts';
import { MemoryDnsProvider, type DnsProvider } from '../server/dns.ts';
import type { RelayLimits } from '../server/public-path.ts';
import { FileInstallRegistry, MemoryInstallRegistry, type InstallRegistry } from '../server/registry.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';
import { runAdmin, startAdminSocket } from '../server/admin.ts';
import { readRegistrySnapshot } from '../server/registry.ts';
import { startMockAcme, type MockAcme } from './helpers/mock-acme.ts';
import { agentRequest, captureClientHello, holdOpen, openControl, rawExchange, syntheticClientHello, trickle } from './helpers/net.ts';
import { createTestCa, type TestCa } from './helpers/pki.ts';

// Several tests issue a certificate through the mock CA (openssl) before exercising timeouts.
setDefaultTimeout(20_000);

const ZONE = 'connect.olympus.test';
const CONTROL_HOST = `relay.${ZONE}`;
const DATA_HOST = `data.${CONTROL_HOST}`;
const REQUEST_MARKER = 'agent-question-7f3a91c2-plaintext';
const RESPONSE_MARKER = 'olympus-answer-5bd204e8-plaintext';

/** Deterministic 8 MiB body for the backpressure test. */
const BIG = Buffer.alloc(8 * 1024 * 1024);
for (let i = 0; i < BIG.length; i += 4) BIG.writeUInt32LE((i * 2654435761) >>> 0, i);

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

async function makeRelay(
  limits: Partial<RelayLimits> = {},
  tap?: (direction: 'to-install' | 'to-agent', chunk: Buffer) => void,
  overrides: { dns?: DnsProvider; registry?: InstallRegistry } = {},
) {
  const registry = overrides.registry ?? new MemoryInstallRegistry();
  const controlTls = ca.issue(CONTROL_HOST, DATA_HOST);
  const relay = await startRelay({
    zone: ZONE,
    controlHost: CONTROL_HOST,
    controlTls,
    registry,
    dns: overrides.dns ?? dns,
    listen: { host: '127.0.0.1', port: 0 },
    limits,
    ...(tap ? { tap } : {}),
  });
  relays.push(relay);
  return { relay, registry };
}

async function connectInstall(
  relay: RelayHandle,
  stateDir = newStateDir(),
  extra: { maxDataConnections?: number; firstRequestTimeoutMs?: number; idleTimeoutMs?: number } = {},
) {
  const handle = await startConnect({
    ...extra,
    stateDir,
    relayHost: '127.0.0.1',
    relayPort: relay.port,
    controlServerName: CONTROL_HOST,
    zone: ZONE,
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
      if (req.url === '/mcp/slow') {
        setTimeout(() => res.end('slow answer'), 1_000);
        return;
      }
      if (req.url === '/mcp/big') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(BIG.length) });
        res.end(BIG);
        return;
      }
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
      expect(statSync(join(stateDir, 'connect-relay', file)).mode & 0o777).toBe(0o600);
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

  test('renewal follows the CA renewal window (ARI) and names the certificate it replaces', async () => {
    const { relay } = await makeRelay();
    const hour = 60 * 60 * 1000;
    try {
      // A window a month out: the install reports when it will renew, and does not renew now.
      acme.setRenewalWindow({ start: Date.now() + 30 * 24 * hour, end: Date.now() + 31 * 24 * hour });
      const first = await connectInstall(relay);
      const status = first.handle.certificate();
      expect(status.state).toBe('serving');
      const renewAt = Date.parse((status as { renewAt?: string }).renewAt ?? '');
      expect(renewAt).toBeGreaterThanOrEqual(Date.now() + 30 * 24 * hour - 60_000);
      expect(renewAt).toBeLessThanOrEqual(Date.now() + 31 * 24 * hour);
      const oldPem = readFileSync(join(first.stateDir, 'connect-relay', 'tls-cert.pem'), 'utf8');
      const oldId = ariCertId(oldPem)!;
      expect(acme.renewalInfoRequests).toContain(oldId);
      await first.handle.stop();

      // The CA pulls the window into the past (as before a mass revocation).
      // The certificate is 90 days fresh by the proportional rule, yet the
      // restarted install renews at once, with `replaces` naming the old one.
      acme.setRenewalWindow({ start: Date.now() - 2 * hour, end: Date.now() - hour });
      const issuedBefore = acme.issued.length;
      const second = await connectInstall(relay, first.stateDir);
      expect(acme.issued.length).toBe(issuedBefore + 1);
      expect(acme.replacements.at(-1)).toBe(oldId);
      const newPem = readFileSync(join(first.stateDir, 'connect-relay', 'tls-cert.pem'), 'utf8');
      expect(ariCertId(newPem)).not.toBe(oldId);
      // A CA still answering "overdue" for the brand-new certificate does not start a renewal loop.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(acme.issued.length).toBe(issuedBefore + 1);
      const response = await agentRequest({ port: relay.port, servername: second.hostname, ca: ca.cert, path: '/mcp' });
      expect(response.status).toBe(200);
    } finally {
      acme.setRenewalWindow(undefined);
    }
  });

  test('a renewal window the CA sets past expiry is clamped to the last sixth of the lifetime', async () => {
    const { relay } = await makeRelay();
    const day = 24 * 60 * 60 * 1000;
    try {
      acme.setRenewalWindow({ start: Date.now() + 200 * day, end: Date.now() + 201 * day });
      const { handle, stateDir } = await connectInstall(relay);
      const pem = readFileSync(join(stateDir, 'connect-relay', 'tls-cert.pem'), 'utf8');
      const renewAt = Date.parse((handle.certificate() as { renewAt?: string }).renewAt ?? '');
      expect(renewAt).toBe(latestRenewalMoment(pem));
      expect(renewAt).toBeLessThan(Date.parse(new X509Certificate(pem).validTo));
    } finally {
      acme.setRenewalWindow(undefined);
    }
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
    const hijack = openControl(relay.port, DATA_HOST, ca.cert);
    challenge = await hijack.next();
    hijack.send({ type: 'attach', v: PROTOCOL_VERSION, installId: owner.installId, connId: open.connId, sig: signInstallMessage(attacker.privateKey, 'attach', String(challenge.nonce), owner.installId, String(open.connId)) });
    expect(await hijack.next()).toMatchObject({ type: 'error', code: 'bad_signature' });
    // Nor guess a connection id, even with the right key.
    const guess = openControl(relay.port, DATA_HOST, ca.cert);
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

async function registerRaw(relay: RelayHandle) {
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
  const ready = await control.next();
  return { identity, control, ready };
}

class CountingDns extends MemoryDnsProvider {
  calls = 0;
  failRemovals = false;
  duringRemove?: () => void;
  override async removeAddress(hostname: string) {
    this.calls += 1;
    if (this.failRemovals) throw new Error('provider unavailable');
    this.duringRemove?.();
    return super.removeAddress(hostname);
  }
  override async ensureAddress(hostname: string) {
    this.calls += 1;
    return super.ensureAddress(hostname);
  }
  override async setTxt(name: string, value: string) {
    this.calls += 1;
    return super.setTxt(name, value);
  }
  override async clearTxt(name: string, value: string) {
    this.calls += 1;
    return super.clearTxt(name, value);
  }
}

describe('abuse resistance', () => {
  test('public traffic above the control budget does not starve the install (data host has its own limit)', async () => {
    // One session establishment per 2 s per address. Every agent below comes
    // from the same address as the install, and far faster than that.
    const { relay } = await makeRelay({
      controlConnectionsPerIp: { capacity: 2, refillPerSecond: 0.5 },
      newConnectionsPerInstall: { capacity: 100, refillPerSecond: 100 },
    });
    const { hostname } = await connectInstall(relay);
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) {
      const response = await agentRequest({ port: relay.port, servername: hostname, ca: ca.cert, path: '/mcp' });
      expect(response.status).toBe(200);
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(relay.onlineInstalls()).toContain(hostname.split('.')[0]!);
  });

  test('attach is only accepted on the data host, and session setup only on the control host', async () => {
    const { relay } = await makeRelay();
    const { identity, control } = await registerRaw(relay);
    const wrongPlane = openControl(relay.port, CONTROL_HOST, ca.cert);
    const challenge = await wrongPlane.next();
    const connId = 'A'.repeat(22);
    wrongPlane.send({ type: 'attach', v: PROTOCOL_VERSION, installId: identity.installId, connId, sig: signInstallMessage(identity.privateKey, 'attach', String(challenge.nonce), identity.installId, connId) });
    expect(await wrongPlane.next()).toMatchObject({ type: 'error', code: 'bad_request' });
    const dataPlane = openControl(relay.port, DATA_HOST, ca.cert);
    const dataChallenge = await dataPlane.next();
    dataPlane.send({ type: 'hello', v: PROTOCOL_VERSION, installId: identity.installId, sig: signInstallMessage(identity.privateKey, 'hello', String(dataChallenge.nonce), identity.installId) });
    expect(await dataPlane.next()).toMatchObject({ type: 'error', code: 'bad_request' });
    control.destroy();
  });

  test('clear floods cannot reach the DNS provider, and DNS calls have a relay-wide budget', async () => {
    const counting = new CountingDns();
    const { relay } = await makeRelay({ dnsCallsGlobal: { capacity: 2, refillPerSecond: 0 } }, undefined, { dns: counting });
    const first = await registerRaw(relay);
    for (let i = 0; i < 50; i += 1) first.control.send({ type: 'acme-dns-clear', id: `c${i}`, value: String(i).padStart(43, 'Z') });
    for (let i = 0; i < 50; i += 1) expect(await first.control.next()).toMatchObject({ type: 'acme-dns-result', ok: false });
    expect(counting.calls).toBe(0);
    // A first publish needs the address record plus the TXT: two calls, the whole budget.
    first.control.send({ type: 'acme-dns-set', id: 'p1', value: 'D'.repeat(43) });
    expect(await first.control.next()).toMatchObject({ ok: true });
    const second = await registerRaw(relay);
    second.control.send({ type: 'acme-dns-set', id: 'p2', value: 'E'.repeat(43) });
    expect(await second.control.next()).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(counting.calls).toBe(2);
    first.control.destroy();
    second.control.destroy();
  });

  test('registrations have a relay-wide rate and address records a relay-wide cap', async () => {
    const { relay } = await makeRelay({ registrationsGlobal: { capacity: 1, refillPerSecond: 0 }, maxAddressRecords: 0 });
    const first = await registerRaw(relay);
    expect(first.ready).toMatchObject({ type: 'ready' });
    first.control.send({ type: 'acme-dns-set', id: 'x', value: 'F'.repeat(43) });
    expect(await first.control.next()).toMatchObject({ ok: false, error: 'capacity' });
    const second = await registerRaw(relay);
    expect(second.ready).toMatchObject({ type: 'error', code: 'rate_limited' });
    first.control.destroy();
  });

  test('never-issued registrations expire only once offline; quiet ones expire and their address record is removed within budget, with retry', async () => {
    const counting = new CountingDns();
    const { relay, registry } = await makeRelay({}, undefined, { dns: counting });
    const idle = await registerRaw(relay);
    const active = await registerRaw(relay);
    active.control.send({ type: 'acme-dns-set', id: 'a', value: 'G'.repeat(43) });
    expect(await active.control.next()).toMatchObject({ ok: true });
    const hostname = `${active.identity.installId}.${ZONE}`;
    expect(counting.addresses.has(hostname)).toBe(true);
    expect(registry.addressRecordCount()).toBe(1);

    const day = 24 * 60 * 60_000;
    // Still connected: a live session is never expired as unactivated.
    expect(await relay.sweep(Date.now() + day + 60_000)).toEqual([]);
    expect(registry.get(idle.identity.installId)).toBeDefined();
    idle.control.destroy();
    await until(() => !relay.onlineInstalls().includes(idle.identity.installId));
    expect(await relay.sweep(Date.now() + day + 60_000)).toEqual([idle.identity.installId]);
    expect(registry.get(idle.identity.installId)).toBeUndefined();

    // Quiet for 90 days: expired, but the address record stays counted until DNS removal succeeds.
    active.control.destroy();
    await until(() => relay.onlineInstalls().length === 0);
    counting.failRemovals = true;
    expect(await relay.sweep(Date.now() + 91 * day)).toEqual([active.identity.installId]);
    expect(counting.addresses.has(hostname)).toBe(true);
    expect(registry.addressRecordCount()).toBe(1);
    expect(registry.pendingAddressRemovals()).toEqual([active.identity.installId]);
    counting.failRemovals = false;
    expect(await relay.sweep(Date.now() + 91 * day)).toEqual([]);
    expect(counting.addresses.has(hostname)).toBe(false);
    expect(registry.addressRecordCount()).toBe(0);
    expect(registry.pendingAddressRemovals()).toEqual([]);
  });

  test('an install that reclaims its record while the removal is in flight gets the record back', async () => {
    const counting = new CountingDns();
    const { relay, registry } = await makeRelay({}, undefined, { dns: counting });
    const active = await registerRaw(relay);
    active.control.send({ type: 'acme-dns-set', id: 'a', value: 'J'.repeat(43) });
    expect(await active.control.next()).toMatchObject({ ok: true });
    active.control.destroy();
    await until(() => relay.onlineInstalls().length === 0);
    const hostname = `${active.identity.installId}.${ZONE}`;
    counting.duringRemove = () => registry.register(active.identity.installId, active.identity.publicKeySpki);
    expect(await relay.sweep(Date.now() + 91 * 24 * 60 * 60_000)).toEqual([active.identity.installId]);
    expect(registry.get(active.identity.installId)?.hasAddressRecord).toBe(true);
    expect(counting.addresses.has(hostname)).toBe(true);
    expect(registry.addressRecordCount()).toBe(1);
    expect(registry.pendingAddressRemovals()).toEqual([]);
  });

  test('address-record removal waits for DNS budget', async () => {
    const counting = new CountingDns();
    const { relay, registry } = await makeRelay({ dnsCallsGlobal: { capacity: 2, refillPerSecond: 0 } }, undefined, { dns: counting });
    const active = await registerRaw(relay);
    active.control.send({ type: 'acme-dns-set', id: 'a', value: 'H'.repeat(43) });
    expect(await active.control.next()).toMatchObject({ ok: true }); // spends the whole budget
    active.control.destroy();
    await until(() => relay.onlineInstalls().length === 0);
    expect(await relay.sweep(Date.now() + 91 * 24 * 60 * 60_000)).toEqual([active.identity.installId]);
    expect(registry.pendingAddressRemovals()).toEqual([active.identity.installId]);
    expect(counting.addresses.size).toBe(1);
  });

  test('the file registry is append-only, survives a torn line, and replays expiry state', async () => {
    const dir = newStateDir();
    const path = join(dir, 'registry.jsonl');
    const identity = loadOrCreateIdentity(newStateDir());
    const registry = new FileInstallRegistry(path);
    registry.register(identity.installId, identity.publicKeySpki);
    registry.activate(identity.installId);
    registry.markAddressRecord(identity.installId);
    await registry.flush();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).op)).toEqual(['register', 'activate', 'address']);
    appendFileSync(path, '{"op":"seen","installId":"trunc');
    const reopened = new FileInstallRegistry(path);
    expect(reopened.get(identity.installId)).toMatchObject({ installId: identity.installId, hasAddressRecord: true });
    expect(reopened.get(identity.installId)?.activatedAt).toBeNumber();
    expect(reopened.addressRecordCount()).toBe(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('operator commands (server/admin.ts)', () => {
  test('revoke ends the install everywhere without a restart, goes through the DNS budget, and sticks', async () => {
    const dir = newStateDir();
    const registryPath = join(dir, 'registry.jsonl');
    const env = { RELAY_REGISTRY_PATH: registryPath, RELAY_ADMIN_SOCKET: join(dir, 'admin.sock') };
    const { relay, registry } = await makeRelay({}, undefined, { registry: new FileInstallRegistry(registryPath) });
    const admin = await startAdminSocket(env.RELAY_ADMIN_SOCKET, relay);
    try {
      const { hostname } = await connectInstall(relay);
      const installId = hostname.split('.')[0]!;
      expect(dns.addresses.has(hostname)).toBe(true);
      expect(statSync(env.RELAY_ADMIN_SOCKET).mode & 0o777).toBe(0o600);

      // Status: counts only, never an install id.
      const before = await runAdmin(['status'], env);
      expect(before.code).toBe(0);
      expect(before.out).toContain('Registered installs:        1 (1 have requested a certificate)');
      expect(before.out).toContain('Online now:                 1');
      expect(before.out).not.toContain(installId);

      const revoked = await runAdmin(['revoke', installId], env);
      expect(revoked).toEqual({
        code: 0,
        out: `Revoked ${installId}. Its registration was removed. Its session was ended. Its DNS address record was removed.\n`,
      });
      expect(dns.addresses.has(hostname)).toBe(false);
      await until(() => relay.onlineInstalls().length === 0);
      // The install does not simply re-register, though its reconnect backoff here is 50 ms.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(registry.get(installId)).toBeUndefined();
      expect(registry.isRevoked(installId)).toBe(true);
      expect(await rawExchange(relay.port, await captureClientHello(hostname))).toEqual(tlsAlertRecord(TLS_ALERT.unrecognizedName));
      const after = await runAdmin(['status'], env);
      expect(after.out).toContain('Registered installs:        0');
      expect(after.out).toContain('Revoked installs:           1');
      expect((await runAdmin(['revoke', installId], env)).out).toBe(`${installId} was already revoked.\n`);

      // It survives a relay restart (the registry log carries it), and restore lifts it.
      await registry.flush();
      expect(new FileInstallRegistry(registryPath).isRevoked(installId)).toBe(true);
      expect((await runAdmin(['restore', installId], env)).out).toBe(`Restored ${installId}; it may register again.\n`);
      expect(registry.isRevoked(installId)).toBe(false);
    } finally {
      await admin.close();
    }
  });

  test('a revoked install is refused at registration, and a revoke without DNS budget queues the record', async () => {
    const counting = new CountingDns();
    const { relay, registry } = await makeRelay({ dnsCallsGlobal: { capacity: 2, refillPerSecond: 0 } }, undefined, { dns: counting });
    const first = await registerRaw(relay);
    first.control.send({ type: 'acme-dns-set', id: 'a', value: 'H'.repeat(43) });
    expect(await first.control.next()).toMatchObject({ ok: true }); // spends the whole DNS budget
    const result = await relay.revoke(first.identity.installId);
    expect(result).toEqual({ installId: first.identity.installId, revoked: true, wasRegistered: true, wasOnline: true, addressRecord: 'pending' });
    expect(await first.control.next()).toMatchObject({ type: 'error', code: 'revoked' });
    expect(registry.pendingAddressRemovals()).toEqual([first.identity.installId]);
    expect(counting.addresses.size).toBe(1);
    // Registering again with the same key is refused.
    const control = openControl(relay.port, CONTROL_HOST, ca.cert);
    const challenge = await control.next();
    control.send({
      type: 'register',
      v: PROTOCOL_VERSION,
      installId: first.identity.installId,
      publicKey: first.identity.publicKeySpki,
      sig: signInstallMessage(first.identity.privateKey, 'register', String(challenge.nonce), first.identity.installId),
    });
    expect(await control.next()).toMatchObject({ type: 'error', code: 'revoked' });
    expect(registry.get(first.identity.installId)).toBeUndefined();
  });

  test('with the relay stopped, revoke is recorded in the log and status reads it', async () => {
    const dir = newStateDir();
    const registryPath = join(dir, 'registry.jsonl');
    const env = { RELAY_REGISTRY_PATH: registryPath, RELAY_ADMIN_SOCKET: join(dir, 'admin.sock') };
    const identity = loadOrCreateIdentity(newStateDir());
    const registry = new FileInstallRegistry(registryPath);
    registry.register(identity.installId, identity.publicKeySpki);
    registry.markAddressRecord(identity.installId);
    await registry.flush();
    appendFileSync(registryPath, '{"op":"seen","installId":"trunc'); // a torn final line
    const out = await runAdmin(['revoke', identity.installId], env);
    expect(out.code).toBe(0);
    expect(out.out).toContain('The relay is not running');
    const status = await runAdmin(['status'], env);
    expect(status.out).toContain('Relay not running');
    expect(status.out).toContain('Registered installs:        0');
    expect(status.out).toContain('Revoked installs:           1');
    expect(status.out).toContain('(1 queued for removal)');
    const reopened = new FileInstallRegistry(registryPath);
    expect(reopened.isRevoked(identity.installId)).toBe(true);
    expect(reopened.pendingAddressRemovals()).toEqual([identity.installId]);
    expect(readRegistrySnapshot(registryPath).counts().revoked).toBe(1);
    expect((await runAdmin(['restore', identity.installId], env)).code).toBe(1);
  });

  test('offline revoke writes the log only as its owner, and a starting relay is never mistaken for a stopped one', async () => {
    const dir = newStateDir();
    const registryPath = join(dir, 'registry.jsonl');
    const env = { RELAY_REGISTRY_PATH: registryPath, RELAY_ADMIN_SOCKET: join(dir, 'admin.sock') };
    const identity = loadOrCreateIdentity(newStateDir());
    const registry = new FileInstallRegistry(registryPath);
    registry.register(identity.installId, identity.publicKeySpki);
    await registry.flush();
    const before = readFileSync(registryPath, 'utf8');
    const ownUid = process.getuid!();
    // Another user (root, say) is refused rather than creating or extending a log it would own.
    const other = await runAdmin(['revoke', identity.installId], env, ownUid + 1);
    expect(other.code).toBe(1);
    expect(other.out).toContain('service user');
    expect(readFileSync(registryPath, 'utf8')).toBe(before);
    // A relay that holds its socket but is still starting answers "starting"; nothing is appended.
    const admin = await startAdminSocket(env.RELAY_ADMIN_SOCKET, () => undefined);
    try {
      const starting = await runAdmin(['revoke', identity.installId], env, ownUid);
      expect(starting.code).toBe(1);
      expect(starting.out).toContain('starting');
      expect(readFileSync(registryPath, 'utf8')).toBe(before);
    } finally {
      await admin.close();
    }
    // Missing state directory: nothing is created.
    const missing = await runAdmin(['revoke', identity.installId], { RELAY_REGISTRY_PATH: join(dir, 'absent', 'registry.jsonl'), RELAY_ADMIN_SOCKET: join(dir, 'none.sock') }, ownUid);
    expect(missing.code).toBe(1);
  });

  test('the command refuses malformed input', async () => {
    expect((await runAdmin([], {})).code).toBe(2);
    expect((await runAdmin(['revoke'], {})).code).toBe(2);
    expect((await runAdmin(['status', 'x'], {})).code).toBe(2);
    expect((await runAdmin(['revoke', 'NOT-AN-ID'], {})).code).toBe(2);
  });
});

describe('before the ClientHello', () => {
  test('a hello that never finishes times out; pre-hello connections are capped per address', async () => {
    const { relay } = await makeRelay({ clientHelloTimeoutMs: 300, maxPreHelloPerAddress: 2 });
    const a = holdOpen(relay.port);
    const b = holdOpen(relay.port, Buffer.from([0x16, 0x03, 0x01]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const c = holdOpen(relay.port);
    const third = await c.closed;
    expect(third.afterMs).toBeLessThan(250);
    const [first, second] = await Promise.all([a.closed, b.closed]);
    for (const result of [first, second]) {
      expect(result.afterMs).toBeGreaterThanOrEqual(250);
      expect(result.received.length).toBe(0);
    }
  });

  test('oversized, SNI-less, multi-name, and non-TLS hellos get unrecognized_name', async () => {
    const { relay } = await makeRelay({ maxClientHelloBytes: 64 });
    const alert = tlsAlertRecord(TLS_ALERT.unrecognizedName);
    expect(await rawExchange(relay.port, await captureClientHello(`${'b'.repeat(32)}.${ZONE}`))).toEqual(alert);
    const { relay: normal } = await makeRelay();
    expect(await rawExchange(normal.port, await captureClientHello(''))).toEqual(alert);
    expect(await rawExchange(normal.port, syntheticClientHello([CONTROL_HOST, `${'c'.repeat(32)}.${ZONE}`]))).toEqual(alert);
    expect(await rawExchange(normal.port, Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'))).toEqual(alert);
  });

  test('a byte-at-a-time hello is still routed', async () => {
    const { relay } = await makeRelay();
    const reply = await trickle(relay.port, await captureClientHello(`${'d'.repeat(32)}.${ZONE}`));
    expect(reply).toEqual(tlsAlertRecord(TLS_ALERT.unrecognizedName));
  });

  test('random garbage never takes the relay down', async () => {
    const { relay } = await makeRelay({ clientHelloTimeoutMs: 300, maxPreHelloPerAddress: 100 });
    const { hostname } = await connectInstall(relay);
    const hello = await captureClientHello(hostname);
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const mutated = Buffer.from(hello);
        for (let j = 0; j < 8; j += 1) mutated[Math.floor(Math.random() * mutated.length)] = Math.floor(Math.random() * 256);
        return rawExchange(relay.port, i % 2 ? mutated : randomBytes(1 + Math.floor(Math.random() * 600)), 3_000).catch(() => {});
      }),
    );
    const response = await agentRequest({ port: relay.port, servername: hostname, ca: ca.cert, path: '/mcp' });
    expect(response.status).toBe(200);
  });
});

describe('flow control and client limits', () => {
  test('a large response through a slow reader arrives intact (pause/resume backpressure)', async () => {
    const { relay } = await makeRelay();
    const { hostname } = await connectInstall(relay);
    const body = await new Promise<Buffer>((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port: relay.port, servername: hostname, ca: ca.cert }, () => {
        socket.write(`GET /mcp/big HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
      });
      const chunks: Buffer[] = [];
      let received = 0;
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        received += chunk.length;
        if (received % 5 === 0 || chunks.length % 16 === 0) {
          socket.pause();
          setTimeout(() => socket.resume(), 5);
        }
      });
      socket.on('error', reject);
      socket.on('end', () => {
        const all = Buffer.concat(chunks);
        resolve(all.subarray(all.indexOf('\r\n\r\n') + 4));
      });
    });
    expect(body.length).toBe(BIG.length);
    expect(createHash('sha256').update(body).digest('hex')).toBe(createHash('sha256').update(BIG).digest('hex'));
  });

  test('the relay cannot make the install open more than its data-connection cap', async () => {
    const { relay } = await makeRelay({ attachTimeoutMs: 400 });
    const { handle, hostname } = await connectInstall(relay, newStateDir(), { maxDataConnections: 1 });
    const held = tls.connect({ host: '127.0.0.1', port: relay.port, servername: hostname, ca: ca.cert });
    held.on('error', () => {});
    await new Promise((resolve) => held.once('secureConnect', resolve));
    expect(handle.client.activeDataConnections).toBe(1);
    const hello = await captureClientHello(hostname);
    const refused = await Promise.all([rawExchange(relay.port, hello), rawExchange(relay.port, hello)]);
    for (const reply of refused) expect(reply).toEqual(tlsAlertRecord(TLS_ALERT.internalError));
    expect(handle.client.activeDataConnections).toBe(1);
    held.destroy();
  });

  test('the client refuses a ready message that names another hostname', async () => {
    const tlsMaterial = ca.issue(CONTROL_HOST);
    const fake = tls.createServer({ key: tlsMaterial.key, cert: tlsMaterial.cert }, (socket) => {
      socket.write(`${JSON.stringify({ type: 'challenge', v: PROTOCOL_VERSION, nonce: 'n' })}\n`);
      socket.once('data', () => socket.write(`${JSON.stringify({ type: 'ready', installId: 'x', hostname: 'victim.example.com' })}\n`));
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const statuses: string[] = [];
    const client = new RelayClient({
      relayHost: '127.0.0.1',
      relayPort: (fake.address() as AddressInfo).port,
      controlServerName: CONTROL_HOST,
      zone: ZONE,
      ca: ca.cert,
      identity: loadOrCreateIdentity(newStateDir()),
      backoff: { minMs: 50, maxMs: 50 },
      onStatus: (status) => statuses.push(status.state === 'offline' ? `offline:${status.reason}` : status.state),
    });
    client.start();
    await until(() => statuses.filter((status) => status.startsWith('offline')).length >= 2);
    await client.stop();
    fake.close();
    expect(statuses).not.toContain('online');
    expect(statuses).toContain('offline:relay announced an unexpected hostname');
    expect(client.hostname).toBeUndefined();
  });

  test('one address cannot hold all of an install\'s slots, and stalled handshakes are closed', async () => {
    const { relay } = await makeRelay({ maxConcurrentPerInstallPerAddress: 3, newConnectionsPerInstall: { capacity: 100, refillPerSecond: 100 } });
    const { handle, hostname } = await connectInstall(relay, newStateDir(), { firstRequestTimeoutMs: 400 });
    const hello = await captureClientHello(hostname);
    // Three stalled ClientHellos from one address fill that address's share...
    const stalled = [holdOpen(relay.port, hello), holdOpen(relay.port, hello), holdOpen(relay.port, hello)];
    await until(() => handle.client.activeDataConnections === 3);
    // ...the fourth is refused at once...
    expect(await rawExchange(relay.port, hello)).toEqual(tlsAlertRecord(TLS_ALERT.internalError));
    // ...and the stalled ones are closed by the install's first-request deadline, freeing the slots.
    for (const result of await Promise.all(stalled.map((entry) => entry.closed))) {
      expect(result.afterMs).toBeLessThan(3_000);
    }
    await until(() => handle.client.activeDataConnections === 0);
    const response = await agentRequest({ port: relay.port, servername: hostname, ca: ca.cert, path: '/mcp' });
    expect(response.status).toBe(200);
  });

  test('an idle keep-alive connection is closed (portable across Node and Bun), but a slow in-flight response is not', async () => {
    const { relay } = await makeRelay();
    const { handle, hostname } = await connectInstall(relay, newStateDir(), { idleTimeoutMs: 400 });
    const started = Date.now();
    const closedAfter = await new Promise<number>((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port: relay.port, servername: hostname, ca: ca.cert }, () => {
        socket.write(`GET /mcp HTTP/1.1\r\nHost: ${hostname}\r\nConnection: keep-alive\r\n\r\n`);
      });
      socket.on('data', () => {});
      socket.on('error', reject);
      socket.on('close', () => resolve(Date.now() - started));
    });
    expect(closedAfter).toBeGreaterThanOrEqual(400);
    expect(closedAfter).toBeLessThan(3_000);
    await until(() => handle.client.activeDataConnections === 0);
    const slow = await agentRequest({ port: relay.port, servername: hostname, ca: ca.cert, path: '/mcp/slow' });
    expect(slow.status).toBe(200);
    expect(slow.body).toBe('slow answer');
  });
});
