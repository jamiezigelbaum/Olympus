/**
 * The native relay service end to end over loopback: the Gateway-side service
 * spawns the real relay runtime (through a fixture standing in for
 * `cli.js __relay-service-run`), which connects to a real test relay, waits for
 * the subscriber agreement, obtains a certificate from a mock ACME CA, and
 * publishes the public base URL the worker then serves without a restart.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeRelayService } from '../src/core/native-relay-service.ts';
import type { NativeProcessServiceDefinition } from '../src/core/native-process-service.ts';
import {
  createRelayRequestVerifier,
  createRemotePublicUrlSource,
  readRemoteAccessStatus,
  recordTermsAcceptance,
  remoteAccessDir,
  type RemoteAccessStatusFile,
} from '../src/core/remote-access.ts';
import { MemoryDnsProvider } from '../connect-relay/server/dns.ts';
import { MemoryInstallRegistry } from '../connect-relay/server/registry.ts';
import { startRelay, type RelayHandle } from '../connect-relay/server/relay.ts';
import { startMockAcme, type MockAcme } from '../connect-relay/test/helpers/mock-acme.ts';
import { agentRequest } from '../connect-relay/test/helpers/net.ts';
import { createTestCa, type TestCa } from '../connect-relay/test/helpers/pki.ts';

setDefaultTimeout(60_000);

const ZONE = 'connect.olympus.test';
const CONTROL_HOST = `relay.${ZONE}`;
const CHILD = join(import.meta.dir, 'fixtures', 'relay', 'relay-runtime-child.ts');

let ca: TestCa;
let acme: MockAcme;
let dns: MemoryDnsProvider;
let relay: RelayHandle;
let worker: http.Server;
let workerBaseUrl: string;
const workerRequests: Array<{ url: string | undefined; headers: IncomingHttpHeaders }> = [];
const roots: string[] = [];
const services: NativeProcessServiceDefinition[] = [];
const savedXdg = process.env.XDG_DATA_HOME;

beforeAll(async () => {
  ca = createTestCa();
  dns = new MemoryDnsProvider();
  acme = await startMockAcme({ lookupTxt: (name) => dns.lookupTxt(name), signCsr: (der) => ca.signCsr(der) });
  relay = await startRelay({
    zone: ZONE,
    controlHost: CONTROL_HOST,
    controlTls: ca.issue(CONTROL_HOST, `data.${CONTROL_HOST}`),
    registry: new MemoryInstallRegistry(),
    dns,
    listen: { host: '127.0.0.1', port: 0 },
  });
  worker = http.createServer((req, res) => {
    workerRequests.push({ url: req.url, headers: req.headers });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
  workerBaseUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await relay.close();
  await acme.close();
  await new Promise<void>((resolve) => worker.close(() => resolve()));
  ca.cleanup();
});

/** An isolated data root; the service reads it from its (process + worker.env) environment. */
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-relay-service-'));
  roots.push(root);
  const dataHome = join(root, 'data');
  process.env.XDG_DATA_HOME = dataHome;
  const workerEnvPath = join(root, 'worker.env');
  writeFileSync(workerEnvPath, '', { mode: 0o600 });
  return { root, dataHome, workerEnvPath, dir: remoteAccessDir({ XDG_DATA_HOME: dataHome }) };
}

function relayService(workerEnvPath: string, remote: Record<string, unknown>) {
  const service = createNativeRelayService({
    initialPluginConfig: { remote, email: { baseUrl: workerBaseUrl } },
    moduleUrl: import.meta.url,
    executablePath: CHILD,
    workerEnvPath,
    childEnv: {
      TEST_RELAY_PORT: String(relay.port),
      TEST_RELAY_CA: ca.cert,
      TEST_ACME_DIRECTORY: acme.directoryUrl,
    },
    startupTimeoutMs: 20_000,
    readinessPollMs: 20,
    stopGraceMs: 2_000,
    restartDelaysMs: [50],
  });
  services.push(service);
  return service;
}

function healthRecorder(events: string[]) {
  return {
    reportFailure(error: Error) { events.push(`failure:${error.message}`); },
    clearFailure() { events.push('clear'); },
  };
}

async function until<T>(read: () => T | undefined, accept: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not met in time; last value ${JSON.stringify(value)}`);
    await Bun.sleep(25);
  }
}

describe('native relay service', () => {
  test('keeps a relay session, waits for the agreement, gets a certificate, and publishes the public URL live', async () => {
    const { dataHome, workerEnvPath, dir } = fixtureRoot();
    // The worker's live view, created before the relay is up: no restart later.
    const publicUrls = createRemotePublicUrlSource({ XDG_DATA_HOME: dataHome }, { minIntervalMs: 0 });
    const trustRelay = createRelayRequestVerifier({ XDG_DATA_HOME: dataHome }, { minIntervalMs: 0 });
    expect(publicUrls.current()).toBeUndefined();

    const events: string[] = [];
    const service = relayService(workerEnvPath, { enabled: true, relayHost: ZONE });
    await service.start({ serviceHealth: healthRecorder(events) });
    expect(events).toEqual(['failure:Olympus remote relay is starting.', 'clear']);

    // Session up, but no ACME order before the owner accepts the agreement.
    const waiting = await until(() => readRemoteAccessStatus(dir), (s) => s.certificate?.state === 'awaiting_terms');
    expect(waiting.relay?.state).toBe('online');
    expect(waiting.terms_url).toBe(acme.directoryUrl.replace('/directory', '/terms/v1.pdf'));
    expect(waiting.public_base_url).toBeNull();
    expect(acme.issued).toHaveLength(0);
    expect(publicUrls.current()).toBeUndefined();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of ['status.json', 'relay-auth', 'install-key.pem', 'tls-key.pem']) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    }

    recordTermsAcceptance(dir, waiting.terms_url!);
    const serving = await until(() => readRemoteAccessStatus(dir), (s) => s.public_base_url !== null);
    const hostname = `${serving.install_id}.${ZONE}`;
    expect(serving).toMatchObject({
      mode: 'relay',
      hostname,
      public_base_url: `https://${hostname}`,
      relay: { state: 'online' },
      certificate: { state: 'serving' },
      local_url: new URL(workerBaseUrl).origin,
    });
    expect(Date.parse(serving.certificate!.not_after!)).toBeGreaterThan(Date.now());
    expect(acme.issued).toEqual([hostname]);

    // The worker's source now answers the relay origin: issuer and resource.
    expect(publicUrls.current()).toMatchObject({ issuer: `https://${hostname}`, resource: `https://${hostname}/mcp` });

    // A hosted agent reaches the worker; the forwarded request carries the
    // install's secret (never the agent's forged copy), which the worker trusts.
    const response = await agentRequest({
      port: relay.port,
      servername: hostname,
      ca: ca.cert,
      path: '/openapi.json',
      headers: { 'x-olympus-relay-auth': 'forged-by-agent', 'x-forwarded-for': '203.0.113.7' },
    });
    expect(response.status).toBe(200);
    const seen = workerRequests.at(-1)!;
    const secret = readFileSync(join(dir, 'relay-auth'), 'utf8').trim();
    expect(seen.headers['x-olympus-relay-auth']).toBe(secret);
    expect(trustRelay(new Request('http://127.0.0.1/openapi.json', { headers: seen.headers as Record<string, string> }))).toBe(true);

    // Stop clears the public URL: the worker stops advertising a dead address.
    await service.stop();
    const stopped = readRemoteAccessStatus(dir)!;
    expect(stopped.relay?.state).toBe('stopped');
    expect(stopped.public_base_url).toBeNull();
    expect(publicUrls.current()).toBeUndefined();
  });

  test('restarts a crashed relay child with backoff and reuses the stored certificate', async () => {
    const { workerEnvPath, dir } = fixtureRoot();
    recordTermsAcceptance(dir, acme.directoryUrl.replace('/directory', '/terms/v1.pdf'));
    const service = relayService(workerEnvPath, { enabled: true, relayHost: ZONE });
    await service.start({});
    const first = await until(() => readRemoteAccessStatus(dir), (s) => s.public_base_url !== null);
    const issued = acme.issued.length;

    process.kill(first.pid!, 'SIGKILL');
    const second = await until(
      () => readRemoteAccessStatus(dir),
      (s: RemoteAccessStatusFile) => s.instance_id !== first.instance_id && s.public_base_url !== null,
    );
    expect(second.pid).not.toBe(first.pid);
    expect(second.install_id).toBe(first.install_id);
    expect(second.public_base_url).toBe(first.public_base_url);
    // Fresh certificate on disk: no second order.
    expect(acme.issued.length).toBe(issued);
  });

  test('refuses a relay and a manual public URL together, by name, and starts nothing', async () => {
    const { workerEnvPath, dir } = fixtureRoot();
    const events: string[] = [];
    const service = relayService(workerEnvPath, { enabled: true, relayHost: ZONE, publicBaseUrl: 'https://tunnel.example' });
    await expect(service.start({ serviceHealth: healthRecorder(events) })).rejects.toThrow('mutually exclusive');
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('remote.relayHost and remote.publicBaseUrl are mutually exclusive');
    const status = readRemoteAccessStatus(dir)!;
    expect(status.error).toContain('mutually exclusive');
    expect(status.public_base_url).toBeNull();
    expect(status.pid).toBeNull();
  });

  test('a manual public URL needs no child and reaches the worker through status.json', async () => {
    const { dataHome, workerEnvPath, dir } = fixtureRoot();
    const service = relayService(workerEnvPath, { enabled: true, publicBaseUrl: 'https://tunnel.example' });
    await service.start({});
    expect(readRemoteAccessStatus(dir)).toMatchObject({ mode: 'manual', public_base_url: 'https://tunnel.example', pid: null });
    expect(createRemotePublicUrlSource({ XDG_DATA_HOME: dataHome }).current()?.issuer).toBe('https://tunnel.example');

    // Turning remote access off clears it on the next (reload) start.
    const off = relayService(workerEnvPath, { enabled: false, publicBaseUrl: 'https://tunnel.example' });
    await off.start({});
    expect(readRemoteAccessStatus(dir)).toMatchObject({ mode: 'off', public_base_url: null });
    expect(createRemotePublicUrlSource({ XDG_DATA_HOME: dataHome }).current()).toBeUndefined();
  });

  test('an OLYMPUS_PUBLIC_BASE_URL in worker.env conflicts with plugin remote config', async () => {
    const { workerEnvPath, dir } = fixtureRoot();
    writeFileSync(workerEnvPath, 'OLYMPUS_PUBLIC_BASE_URL=https://old-tunnel.example\n', { mode: 0o600 });
    const events: string[] = [];
    const service = relayService(workerEnvPath, { enabled: true, relayHost: ZONE });
    await expect(service.start({ serviceHealth: healthRecorder(events) })).rejects.toThrow('worker.env');
    expect(readRemoteAccessStatus(dir)?.error).toContain('OLYMPUS_PUBLIC_BASE_URL in worker.env');
  });

  test('remote access that was never turned on writes nothing', async () => {
    const { dir, workerEnvPath } = fixtureRoot();
    const service = relayService(workerEnvPath, { enabled: false });
    await service.start({});
    expect(readRemoteAccessStatus(dir)).toBeUndefined();
  });
});
