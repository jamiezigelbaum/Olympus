/**
 * The native relay service end to end over loopback: the Gateway-side service
 * spawns the real relay runtime (through a fixture standing in for
 * `cli.js __relay-service-run`), which keeps a session to a real test relay
 * and publishes the public base URL and install id the worker then serves
 * without a restart. Requests reach the worker only through that session.
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
  createRemotePublicUrlSource,
  readRemoteAccessStatus,
  remoteAccessDir,
  remoteAccessStatusView,
  resolveRemoteAccessUrls,
  type RemoteAccessStatusFile,
} from '../src/core/remote-access.ts';
import { remoteAccessFromStatus } from '../src/workers/agent-connections.ts';
import { MemoryInstallRegistry } from '../connect-relay/server/registry.ts';
import { startRelay, type RelayHandle } from '../connect-relay/server/relay.ts';
import { mintCredential } from '../connect-relay/shared/tokens.ts';

setDefaultTimeout(60_000);

const RELAY_HOST = 'mcp.olympus.test';
const CHILD = join(import.meta.dir, 'fixtures', 'relay', 'relay-runtime-child.ts');
const CRASHING_CHILD = join(import.meta.dir, 'fixtures', 'relay', 'crashing-relay-child.ts');

let relay: RelayHandle;
let worker: http.Server;
let workerBaseUrl: string;
const workerRequests: Array<{ url: string | undefined; headers: IncomingHttpHeaders }> = [];
const roots: string[] = [];
const services: NativeProcessServiceDefinition[] = [];
const savedXdg = process.env.XDG_DATA_HOME;

beforeAll(async () => {
  relay = await startRelay({ publicHost: RELAY_HOST, registry: new MemoryInstallRegistry(), listen: { host: '127.0.0.1', port: 0 } });
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
  await new Promise<void>((resolve) => worker.close(() => resolve()));
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

function relayService(
  workerEnvPath: string,
  remote: Record<string, unknown>,
  overrides: { executablePath?: string; restartDelaysMs?: number[]; stableUptimeMs?: number; childEnv?: Record<string, string> } = {},
) {
  const service = createNativeRelayService({
    initialPluginConfig: { remote, email: { baseUrl: workerBaseUrl } },
    moduleUrl: import.meta.url,
    executablePath: overrides.executablePath ?? CHILD,
    workerEnvPath,
    childEnv: {
      TEST_RELAY_PORT: String(relay.port),
      ...overrides.childEnv,
    },
    startupTimeoutMs: 20_000,
    readinessPollMs: 20,
    stopGraceMs: 2_000,
    restartDelaysMs: overrides.restartDelaysMs ?? [50],
    ...(overrides.stableUptimeMs !== undefined ? { stableUptimeMs: overrides.stableUptimeMs } : {}),
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
  test('keeps a relay session and publishes the public URL and install id live; requests arrive marked', async () => {
    const { dataHome, workerEnvPath, dir } = fixtureRoot();
    // The worker's live view, created before the relay is up: no restart later.
    const publicUrls = createRemotePublicUrlSource({ XDG_DATA_HOME: dataHome }, { minIntervalMs: 0 });
    expect(publicUrls.current()).toBeUndefined();

    const events: string[] = [];
    const service = relayService(workerEnvPath, { enabled: true, relayHost: RELAY_HOST });
    await service.start({ serviceHealth: healthRecorder(events) });
    expect(events).toEqual(['failure:Olympus remote relay is starting.', 'clear']);

    const online = await until(() => readRemoteAccessStatus(dir), (s) => s.relay?.state === 'online');
    expect(online).toMatchObject({
      mode: 'relay',
      relay_host: RELAY_HOST,
      public_base_url: `https://${RELAY_HOST}`,
      local_url: new URL(workerBaseUrl).origin,
    });
    expect(online.install_id).toMatch(/^[a-z2-7]{32}$/);
    expect(Date.parse(online.last_connected_at!)).toBeGreaterThan(Date.now() - 60_000);
    expect(relay.onlineInstalls()).toEqual([online.install_id!]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of ['status.json', 'install-key.pem']) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    }
    // The per-boot relay secret is never written down.
    expect(() => statSync(join(dir, 'relay-auth'))).toThrow();

    // The worker's source now answers the relay origin, with this install's id.
    expect(publicUrls.current()).toMatchObject({
      issuer: `https://${RELAY_HOST}`,
      resource: `https://${RELAY_HOST}/mcp`,
      installId: online.install_id,
    });

    // A hosted agent reaches the worker through the relay; the forwarded
    // request carries the relay marker (never the caller's forged copy).
    const response = await fetch(`${relay.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mintCredential('access', online.install_id!)}`,
        'content-type': 'application/json',
        'x-olympus-relay': 'forged-by-caller',
        'x-forwarded-for': '203.0.113.7',
      },
      body: '{}',
    });
    expect(response.status).toBe(200);
    const seen = workerRequests.at(-1)!;
    expect(seen.url).toBe('/mcp');
    expect(seen.headers['x-olympus-relay']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(seen.headers['x-forwarded-for']).toBeUndefined();

    // Stop clears the public URL: the worker stops advertising OAuth.
    await service.stop();
    const stopped = readRemoteAccessStatus(dir)!;
    expect(stopped.relay?.state).toBe('stopped');
    expect(stopped.public_base_url).toBeNull();
    expect(publicUrls.current()).toBeUndefined();
  });

  test('restarts a crashed relay child with backoff and keeps the install identity', async () => {
    const { workerEnvPath, dir } = fixtureRoot();
    const service = relayService(workerEnvPath, { enabled: true, relayHost: RELAY_HOST });
    await service.start({});
    const first = await until(() => readRemoteAccessStatus(dir), (s) => s.relay?.state === 'online');

    process.kill(first.pid!, 'SIGKILL');
    const second = await until(
      () => readRemoteAccessStatus(dir),
      (s: RemoteAccessStatusFile) => s.instance_id !== first.instance_id && s.relay?.state === 'online',
    );
    expect(second.pid).not.toBe(first.pid);
    expect(second.install_id).toBe(first.install_id);
    expect(second.public_base_url).toBe(first.public_base_url);
  });

  test('a child that crashes soon after ready keeps backing off instead of hammering the relay', async () => {
    const spawns = async (stableUptimeMs: number | undefined) => {
      const { root, workerEnvPath } = fixtureRoot();
      const log = join(root, 'spawns.log');
      writeFileSync(log, '');
      const service = relayService(workerEnvPath, { enabled: true, relayHost: RELAY_HOST }, {
        executablePath: CRASHING_CHILD,
        restartDelaysMs: [100, 800, 5_000],
        childEnv: { TEST_SPAWN_LOG: log },
        ...(stableUptimeMs !== undefined ? { stableUptimeMs } : {}),
      });
      await service.start({});
      await Bun.sleep(3_500);
      await service.stop();
      return readFileSync(log, 'utf8').trim().split('\n').map(Number);
    };
    // Default: readiness does not reset backoff, so the delays climb
    // (100 ms, 800 ms, then 5 s): at most three starts in 3.5 s.
    const backedOff = await spawns(undefined);
    expect(backedOff.length).toBeGreaterThanOrEqual(2);
    expect(backedOff.length).toBeLessThanOrEqual(3);
    if (backedOff.length === 3) expect(backedOff[2]! - backedOff[1]!).toBeGreaterThan(backedOff[1]! - backedOff[0]!);
    // Control: resetting at readiness restarts at the first delay every time.
    const hammering = await spawns(0);
    expect(hammering.length).toBeGreaterThanOrEqual(4);
  });

  test('a crash withdraws the public URL at once, before the backoff relaunch', async () => {
    const { dataHome, workerEnvPath, dir } = fixtureRoot();
    const publicUrls = createRemotePublicUrlSource({ XDG_DATA_HOME: dataHome }, { minIntervalMs: 0 });
    const service = relayService(workerEnvPath, { enabled: true, relayHost: RELAY_HOST }, { restartDelaysMs: [3_000] });
    await service.start({});
    const first = await until(() => readRemoteAccessStatus(dir), (s) => s.relay?.state === 'online');
    expect(publicUrls.current()).toBeDefined();

    process.kill(first.pid!, 'SIGKILL');
    const down = await until(() => readRemoteAccessStatus(dir), (s) => s.public_base_url === null, 2_000);
    // Still the crashed instance: the replacement has not started yet.
    expect(down.instance_id).toBe(first.instance_id);
    expect(down.relay).toMatchObject({ state: 'offline' });
    expect(publicUrls.current()).toBeUndefined();

    const back = await until(() => readRemoteAccessStatus(dir), (s) => s.instance_id !== first.instance_id && s.public_base_url !== null);
    expect(back.public_base_url).toBe(first.public_base_url);
  });

  test('refuses a relay and a manual public URL together, by name, and starts nothing', async () => {
    const { workerEnvPath, dir } = fixtureRoot();
    const events: string[] = [];
    const service = relayService(workerEnvPath, { enabled: true, relayHost: RELAY_HOST, publicBaseUrl: 'https://tunnel.example' });
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
    const service = relayService(workerEnvPath, { enabled: true, relayHost: RELAY_HOST });
    await expect(service.start({ serviceHealth: healthRecorder(events) })).rejects.toThrow('worker.env');
    expect(readRemoteAccessStatus(dir)?.error).toContain('OLYMPUS_PUBLIC_BASE_URL in worker.env');
  });

  test('turned on before the Olympus relay is live: a steady "relay unavailable", retried with backoff, never a crash loop', async () => {
    const { dir, workerEnvPath } = fixtureRoot();
    // Nothing listens here: the relay host resolves, but no relay answers.
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const events: string[] = [];
    // Only remote.enabled, as the dashboard's Turn on remote access writes it.
    const service = relayService(workerEnvPath, { enabled: true }, { childEnv: { TEST_RELAY_PORT: String(port) } });
    await service.start({ serviceHealth: healthRecorder(events) });
    const first = await until(() => readRemoteAccessStatus(dir), (s) => s.relay?.state === 'offline');
    expect(first.relay_host).toBe('mcp.olympusplugin.ai');
    expect(first.relay?.reason).toBe('could not reach the relay');
    expect(first.relay?.retry_in_ms).toBeGreaterThan(0);
    // The issuer does not move with the network; reachability is relay.state.
    expect(first.public_base_url).toBe('https://mcp.olympusplugin.ai');

    // Across many reconnect attempts (50–200 ms backoff in the fixture) the
    // same child keeps running and the status stays "offline" with its reason.
    const seen = new Set<string>();
    const delays: number[] = [];
    for (let sample = 0; sample < 30; sample++) {
      await Bun.sleep(50);
      const status = readRemoteAccessStatus(dir)!;
      seen.add(status.relay!.state);
      if (status.relay?.retry_in_ms) delays.push(status.relay.retry_in_ms);
      expect(status.pid).toBe(first.pid);
      expect(status.instance_id).toBe(first.instance_id);
    }
    expect([...seen]).toEqual(['offline']);
    expect(Math.max(...delays)).toBeLessThanOrEqual(200);
    // Health: the start was reported once and cleared; no crash, no restart.
    expect(events.at(-1)).toBe('clear');
    expect(events.filter((event) => event.startsWith('failure') && !event.includes('is starting'))).toEqual([]);

    const view = remoteAccessStatusView({
      status: readRemoteAccessStatus(dir),
      urls: resolveRemoteAccessUrls({ layeredEnv: {}, env: {}, status: readRemoteAccessStatus(dir), configuredWorkerBaseUrl: workerBaseUrl }),
    });
    expect(view).toMatchObject({ remote_enabled: true, relay: { state: 'offline', connected: false } });
    expect(view.next_step).toContain('Olympus relay unavailable');
    expect(remoteAccessFromStatus({ live: undefined, status: view })).toMatchObject({
      state: 'not_connected',
      detail: expect.stringContaining('Olympus relay unavailable'),
    });
  });

  test('remote access that was never turned on writes nothing', async () => {
    const { dir, workerEnvPath } = fixtureRoot();
    const service = relayService(workerEnvPath, { enabled: false });
    await service.start({});
    expect(readRemoteAccessStatus(dir)).toBeUndefined();
  });
});
