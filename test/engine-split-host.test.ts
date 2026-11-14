// OLYMPUS_TEST_LANE: deploy
// The engine split's host supervision (docs/design/engine-split.md, part 3):
// the native services start stand-in worker processes, so these tests wait
// on real processes and carry wall-clock budgets; they live in the deploy
// lane (test/deploy-lane-partition.test.ts). The rest of the split's tests
// run on the test clock in test/engine-split.test.ts.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNativeEngineBackgroundService,
  createNativeWorkerService,
  WORKER_BACKGROUND_STARTING_MESSAGE,
  type NativeWorkerServiceDefinition,
} from '../src/core/native-worker-service.ts';
import { createEngineCommandHandler, EngineCommandLedger, type EngineCommandHandlers } from '../src/workers/engine-split/commands.ts';
import { backgroundBootDone, waitForBackgroundBootDone } from '../src/workers/engine-split/runtime.ts';
import type { BootProgress } from '../src/core/boot-progress.ts';
import { createTestClock, flushMicrotasks, waitFor } from './helpers/test-clock.ts';

const TOKEN = 'engine-split-test-token';
const roots: string[] = [];
const services: NativeWorkerServiceDefinition[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-engine-split-'));
  roots.push(root);
  return root;
}

/** A background reached in-process: the client's fetch calls the handler directly. */
function background(handlers: EngineCommandHandlers, instanceId = 'background-1') {
  let ready = true;
  const ledger = new EngineCommandLedger({ instanceId, handlers });
  const handler = createEngineCommandHandler({ authToken: TOKEN, ledger, ready: () => ready });
  const fetchBackground = ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
  return { ledger, handler, fetch: fetchBackground, setReady: (value: boolean) => { ready = value; } };
}

describe('the host starts the background, then the front', () => {
  test('the front opens its stores on the background\'s receipt, never on its answer or a clock, and never gives up (gate7 on 893087f5)', async () => {
    const clock = createTestClock();
    const at = new Date().toISOString();
    let boot: BootProgress | undefined = { schema: 'olympus.boot-progress.v1', pid: process.pid, phase: 'backing_up', startedAt: at, updatedAt: at, completedStores: 3 };
    let alive = true;
    const waiting = waitForBackgroundBootDone({ env: {}, sleep: clock.sleep, pollMs: 250, read: () => boot, alive: () => alive });
    let settled = false;
    void waiting.then(() => { settled = true; });
    await flushMicrotasks();
    // A long boot, then a done receipt from a process that has gone: still waiting.
    await clock.advance(60 * 60_000);
    expect(settled).toBe(false);
    boot = { ...boot!, phase: 'done' };
    alive = false;
    await clock.advance(1_000);
    expect(settled).toBe(false);
    // Done, by a live process, however busy: the front goes on.
    alive = true;
    await clock.advance(250);
    await waiting;
    expect(backgroundBootDone(boot, () => false)).toBe(false);
    expect(backgroundBootDone(undefined)).toBe(false);
  });

  test('a front worker service does not start while its background is not ready', async () => {
    const fixture = fakeWorker(tempRoot());
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig({ engineSplit: true }), moduleUrl: import.meta.url, workerEnvPath: fixture.envPath,
      fetch, startupTimeoutMs: 2_000, readinessPollMs: 10, stopGraceMs: 50, restartDelaysMs: [60_000],
      engineBackground: { isReady: () => false }, engineBackgroundWaitMs: 0,
    }));
    await expect(service.start({})).rejects.toThrow(WORKER_BACKGROUND_STARTING_MESSAGE);
    expect(service.isReady()).toBe(false);
  });

  test('switch on: the front starts with the front role once the background is ready; switch off: no role', async () => {
    for (const engineSplit of [true, false]) {
      const fixture = fakeWorker(tempRoot());
      const service = track(createNativeWorkerService({
        initialPluginConfig: fixture.pluginConfig({ engineSplit }), moduleUrl: import.meta.url, workerEnvPath: fixture.envPath,
        fetch, startupTimeoutMs: 10_000, readinessPollMs: 10, stopGraceMs: 50,
        engineBackground: { isReady: () => true },
      }));
      await service.start({});
      expect(service.isReady()).toBe(true);
      const env = JSON.parse(readFileSync(fixture.rolePath, 'utf8')) as Record<string, string | undefined>;
      expect(env.role).toBe(engineSplit ? 'front' : undefined);
      expect(Boolean(env.socket)).toBe(engineSplit);
      await service.stop();
    }
  }, 30_000);

  test('off Linux the front binds the port the host gives it, and is checked there', async () => {
    const fixture = fakeWorker(tempRoot());
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const frontPort = probe.port;
    probe.stop(true);
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig({ engineSplit: true }), moduleUrl: import.meta.url, workerEnvPath: fixture.envPath,
      startupTimeoutMs: 10_000, readinessPollMs: 10, stopGraceMs: 50,
      engineBackground: { isReady: () => true }, frontPort,
    }));
    // Nothing listens on the worker's own port here: readiness is the front's port.
    await service.start({});
    expect(service.isReady()).toBe(true);
    expect(JSON.parse(readFileSync(fixture.rolePath, 'utf8')).listenPort).toBe(String(frontPort));
  }, 30_000);

  test('under the Gateway the service holds the worker endpoint from its start until its stop (holdEndpoint)', async () => {
    const root = tempRoot();
    const fixture = fakeWorker(root);
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig({ engineSplit: true }), moduleUrl: import.meta.url, workerEnvPath: fixture.envPath,
      startupTimeoutMs: 10_000, readinessPollMs: 10, stopGraceMs: 50, restartDelaysMs: [10],
      engineBackground: { isReady: () => true }, holdEndpoint: true,
    }));
    await service.start({});
    expect(service.isReady()).toBe(true);
    const role = JSON.parse(readFileSync(fixture.rolePath, 'utf8'));
    const ask = async () => {
      const response = await fetch('http://127.0.0.1/v1/service/readiness', { unix: holdPath, headers: { authorization: `Bearer ${TOKEN}`, connection: 'close' } } as RequestInit);
      return response.status;
    };
    // Linux: the front binds front.sock; the held worker socket pipes to it.
    const holdPath = process.platform === 'linux' ? join(root, 'run', 'olympus', 'worker.sock') : '';
    if (process.platform !== 'linux') { expect(role.listenPort).toBeDefined(); return; }
    expect(role.listenSocket).toBe(join(root, 'run', 'olympus', 'front.sock'));
    expect(await ask()).toBe(200);
    // A front that exits is replaced behind the held socket.
    const firstPid = Number(readFileSync(fixture.pidPath, 'utf8'));
    process.kill(firstPid, 'SIGKILL');
    await waitFor(() => service.isReady() && Number(readFileSync(fixture.pidPath, 'utf8')) !== firstPid, { timeoutMs: 20_000 });
    expect(await ask()).toBe(200);
    await service.stop();
    expect(existsSync(holdPath)).toBe(false);
  }, 30_000);

  test('the background is ready on its command socket, and is restarted when it exits', async () => {
    const fixture = fakeWorker(tempRoot());
    const background = createNativeEngineBackgroundService({
      initialPluginConfig: fixture.pluginConfig({ engineSplit: true }), moduleUrl: import.meta.url, workerEnvPath: fixture.envPath,
      startupTimeoutMs: 10_000, readinessPollMs: 10, stopGraceMs: 50, restartDelaysMs: [10],
    });
    track(background);
    await background.start({});
    expect(background.isReady()).toBe(true);
    const firstPid = Number(readFileSync(fixture.pidPath, 'utf8'));
    process.kill(firstPid, 'SIGKILL');
    await waitFor(() => background.isReady() && Number(readFileSync(fixture.pidPath, 'utf8')) !== firstPid, { timeoutMs: 20_000 });
    expect(JSON.parse(readFileSync(fixture.rolePath, 'utf8')).role).toBe('background');
  }, 30_000);

  test('switch off: the background service starts nothing', async () => {
    const fixture = fakeWorker(tempRoot());
    const background = track(createNativeEngineBackgroundService({
      initialPluginConfig: fixture.pluginConfig({ engineSplit: false }), moduleUrl: import.meta.url, workerEnvPath: fixture.envPath,
    }));
    await background.start({});
    expect(background.isReady()).toBe(false);
    expect(() => readFileSync(fixture.pidPath)).toThrow();
  });
});

function track<T extends NativeWorkerServiceDefinition>(service: T): T {
  services.push(service);
  return service;
}

/**
 * A stand-in worker: it records its role, serves the readiness route on its
 * port as a front or single worker, and as a background serves /engine/ready
 * on the command socket the host named.
 */
function fakeWorker(root: string) {
  const scriptPath = join(root, 'fake-worker.mjs');
  const envPath = join(root, 'worker.env');
  const rolePath = join(root, 'role.json');
  const pidPath = join(root, 'worker.pid');
  mkdirSync(join(root, 'run'), { recursive: true, mode: 0o700 });
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port!;
  server.stop(true);
  writeFileSync(scriptPath, `
import { rmSync, writeFileSync } from 'node:fs';
const env = process.env;
// The real background removes a stopped background's socket after taking the data lock.
if (env.OLYMPUS_WORKER_ENGINE_ROLE === 'background') rmSync(env.OLYMPUS_ENGINE_BACKGROUND_SOCKET, { force: true });
writeFileSync(env.FAKE_ROLE_PATH, JSON.stringify({ role: env.OLYMPUS_WORKER_ENGINE_ROLE, socket: env.OLYMPUS_ENGINE_BACKGROUND_SOCKET, listenPort: env.OLYMPUS_WORKER_LISTEN_PORT, listenSocket: env.OLYMPUS_WORKER_LISTEN_SOCKET }));
writeFileSync(env.FAKE_PID_PATH, String(process.pid));
const token = env.OLYMPUS_WORKER_AUTH_TOKEN;
const authed = (request) => request.headers.get('authorization') === 'Bearer ' + token;
const server = env.OLYMPUS_WORKER_ENGINE_ROLE === 'background'
  ? Bun.serve({ unix: env.OLYMPUS_ENGINE_BACKGROUND_SOCKET, fetch(request) {
      if (!authed(request)) return new Response('', { status: 401 });
      return Response.json({ ready: true, schema_current: true, instance_id: env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID });
    } })
  : Bun.serve({ ...(env.OLYMPUS_WORKER_LISTEN_SOCKET ? { unix: env.OLYMPUS_WORKER_LISTEN_SOCKET } : { hostname: '127.0.0.1', port: Number(env.OLYMPUS_WORKER_LISTEN_PORT || env.OLYMPUS_EMAIL_SOURCE_PORT) }), fetch(request) {
      if (!authed(request)) return new Response('', { status: 401 });
      return Response.json({ instance_id: env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID });
    } });
process.once('SIGTERM', () => { server.stop(true); process.exit(0); });
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  writeFileSync(envPath, [
    `OLYMPUS_EMAIL_SOURCE_PORT=${port}`,
    `OLYMPUS_WORKER_AUTH_TOKEN=${TOKEN}`,
    `FAKE_ROLE_PATH=${rolePath}`,
    `FAKE_PID_PATH=${pidPath}`,
    `HOME=${root}`,
    `XDG_DATA_HOME=${join(root, 'data')}`,
    `XDG_RUNTIME_DIR=${join(root, 'run')}`,
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(envPath, 0o600);
  return {
    envPath, rolePath, pidPath,
    pluginConfig: (worker: { engineSplit: boolean }) => ({
      worker: { authToken: TOKEN, engineSplit: worker.engineSplit, service: { enabled: true, runtimePath: process.execPath, executablePath: scriptPath } },
      email: { baseUrl: `http://127.0.0.1:${port}/v1` },
    }),
  };
}
