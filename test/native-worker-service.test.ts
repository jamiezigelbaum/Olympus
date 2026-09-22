import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNativeWorkerService,
  type NativeWorkerServiceDefinition,
  type NativeWorkerServiceHealth,
} from '../src/core/native-worker-service.ts';

const roots: string[] = [];
const services: NativeWorkerServiceDefinition[] = [];
const usedPorts = new Set<number>();

setDefaultTimeout(60_000);

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native Olympus worker service', () => {
  test('disabled service does not launch a child', async () => {
    const fixture = fakeWorkerFixture();
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig(false),
      moduleUrl: import.meta.url,
      startupTimeoutMs: 1_000,
      workerEnvPath: fixture.envFilePath,
    }));

    await service.start({});
    await Bun.sleep(100);

    expect(existsSync(fixture.countPath)).toBe(false);
  });

  test('fresh runtime config removal cannot resurrect the registration snapshot', async () => {
    const fixture = fakeWorkerFixture();
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig(true),
      moduleUrl: import.meta.url,
      workerEnvPath: fixture.envFilePath,
    }));

    await service.start({ config: { plugins: { entries: {} } } });
    await Bun.sleep(100);

    expect(existsSync(fixture.countPath)).toBe(false);
  });

  test('stop during an in-flight occupancy probe prevents the stale start from spawning', async () => {
    const fixture = fakeWorkerFixture();
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<void>();
    const fetchWithBlockedOccupancy = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (!new Headers(init?.headers).has('authorization')) {
        probeStarted.resolve();
        await releaseProbe.promise;
        throw new TypeError('fixture endpoint is free');
      }
      return fetch(url, init);
    }) as typeof fetch;
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig(true),
      moduleUrl: import.meta.url,
      startupTimeoutMs: 5_000,
      readinessPollMs: 20,
      stopGraceMs: 100,
      workerEnvPath: fixture.envFilePath,
      fetch: fetchWithBlockedOccupancy,
    }));

    const starting = service.start({});
    await probeStarted.promise;
    await service.stop();
    releaseProbe.resolve();
    await starting;
    await Bun.sleep(100);

    expect(existsSync(fixture.countPath)).toBe(false);
  });

  test('becomes healthy only after an authenticated worker response', async () => {
    const fixture = fakeWorkerFixture();
    const events: string[] = [];
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig(true),
      moduleUrl: import.meta.url,
      startupTimeoutMs: 20_000,
      readinessPollMs: 20,
      stopGraceMs: 100,
      workerEnvPath: fixture.envFilePath,
    }));

    await service.start({ serviceHealth: healthRecorder(events) });

    expect(readCount(fixture.countPath)).toBe(1);
    expect(events).toEqual(['failure:Olympus worker is starting.', 'clear']);
    expect(service.isReady()).toBe(true);
    await service.stop();
    expect(service.isReady()).toBe(false);
  });

  test('does not inherit Gateway and 1Password bootstrap credentials', async () => {
    const fixture = fakeWorkerFixture();
    const pluginConfig = fixture.pluginConfig(true);
    const workerService = (pluginConfig.worker as Record<string, unknown>).service as Record<string, unknown>;
    workerService.credentials = {
      OLYMPUS_CREDENTIAL_SYNTHETIC: 'gateway-resolved-synthetic-secret',
    };
    const previous = {
      OP_CONNECT_TOKEN: process.env.OP_CONNECT_TOKEN,
      OP_SESSION_personal: process.env.OP_SESSION_personal,
      OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    };
    process.env.OP_CONNECT_TOKEN = 'must-not-reach-worker';
    process.env.OP_SESSION_personal = 'must-not-reach-worker';
    process.env.OPENCLAW_GATEWAY_TOKEN = 'must-not-reach-worker';
    writeFileSync(join(fixture.root, '.env'), 'OPENCLAW_GATEWAY_TOKEN=must-not-return-from-bun-dotenv\n');
    const service = track(createNativeWorkerService({
      initialPluginConfig: pluginConfig,
      moduleUrl: import.meta.url,
      startupTimeoutMs: 20_000,
      readinessPollMs: 20,
      stopGraceMs: 100,
      workerEnvPath: fixture.envFilePath,
      workingDirectory: fixture.root,
    }));
    try {
      await service.start({});
      expect(JSON.parse(readFileSync(fixture.gatewaySecretPath, 'utf8'))).toEqual({});
      expect(JSON.parse(readFileSync(fixture.configEnvPath, 'utf8'))).toMatchObject({
        OLYMPUS_CREDENTIAL_SYNTHETIC: 'gateway-resolved-synthetic-secret',
      });
    } finally {
      restoreEnv('OP_CONNECT_TOKEN', previous.OP_CONNECT_TOKEN);
      restoreEnv('OP_SESSION_personal', previous.OP_SESSION_personal);
      restoreEnv('OPENCLAW_GATEWAY_TOKEN', previous.OPENCLAW_GATEWAY_TOKEN);
    }
  });

  test('native config overrides worker.env settings and materializes capture ownership', async () => {
    const fixture = fakeWorkerFixture();
    const pluginConfig = fixture.pluginConfig(true);
    const workerConfig = pluginConfig.worker as Record<string, unknown>;
    workerConfig.scheduler = {
      enabled: true,
      sourceIds: ['x.bookmarks'],
      tickSeconds: 7,
      syncIntervalSeconds: 90,
      freshnessThresholdHours: 5,
      errorBackoffSeconds: 11,
      maxTransientRetries: 2,
    };
    workerConfig.telegramCapture = { enabled: true };
    workerConfig.whatsappCapture = { enabled: false };
    pluginConfig.sovereignty = { configPath: '/opt/olympus/sovereignty.json' };
    const service = track(createNativeWorkerService({
      initialPluginConfig: pluginConfig,
      moduleUrl: import.meta.url,
      startupTimeoutMs: 20_000,
      readinessPollMs: 20,
      stopGraceMs: 100,
      workerEnvPath: fixture.envFilePath,
    }));

    await service.start({});

    expect(JSON.parse(readFileSync(fixture.configEnvPath, 'utf8'))).toEqual({
      OLYMPUS_EMAIL_SOURCE_HOST: '127.0.0.1',
      OLYMPUS_EMAIL_SOURCE_PORT: String(fixture.port),
      OLYMPUS_SOURCE_INDEX_ENABLED: 'true',
      OLYMPUS_WORKER_SCHEDULER_ENABLED: 'true',
      OLYMPUS_WORKER_SCHEDULER_SOURCE_IDS: 'x.bookmarks',
      OLYMPUS_WORKER_SCHEDULER_TICK_SECONDS: '7',
      OLYMPUS_WORKER_SCHEDULER_SYNC_INTERVAL_SECONDS: '90',
      OLYMPUS_WORKER_SCHEDULER_FRESHNESS_THRESHOLD_HOURS: '5',
      OLYMPUS_WORKER_SCHEDULER_ERROR_BACKOFF_SECONDS: '11',
      OLYMPUS_WORKER_SCHEDULER_MAX_TRANSIENT_RETRIES: '2',
      OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER: 'true',
      OLYMPUS_NATIVE_WHATSAPP_CAPTURE_OWNER: 'false',
      OLYMPUS_SOVEREIGNTY_CONFIG_PATH: '/opt/olympus/sovereignty.json',
    });
  });

  test('refuses an inline sovereignty policy instead of starting with different trust rules', async () => {
    const fixture = fakeWorkerFixture();
    const pluginConfig = fixture.pluginConfig(true);
    pluginConfig.sovereignty = { policy: { schemaVersion: 1 } };
    const events: string[] = [];
    const service = track(createNativeWorkerService({
      initialPluginConfig: pluginConfig,
      moduleUrl: import.meta.url,
      startupTimeoutMs: 1_000,
      workerEnvPath: fixture.envFilePath,
    }));

    await expect(service.start({ serviceHealth: healthRecorder(events) }))
      .rejects.toThrow('do not support an inline sovereignty policy');
    expect(existsSync(fixture.countPath)).toBe(false);
    expect(events).toEqual([
      'failure:Gateway-managed Olympus workers do not support an inline sovereignty policy; configure sovereignty.configPath.',
    ]);
  });

  test('refuses explicit source scope that the native child cannot transport', async () => {
    const fixture = fakeWorkerFixture();
    const pluginConfig = fixture.pluginConfig(true);
    pluginConfig.sourceIndex = {
      enabled: true,
      ingestionExclusionsPath: '/opt/olympus/source-exclusions.json',
    };
    const service = track(createNativeWorkerService({
      initialPluginConfig: pluginConfig,
      moduleUrl: import.meta.url,
      startupTimeoutMs: 1_000,
      workerEnvPath: fixture.envFilePath,
    }));

    await expect(service.start({}))
      .rejects.toThrow('do not support explicit sourceIndex.ingestionExclusionsPath plugin config');
    expect(existsSync(fixture.countPath)).toBe(false);
  });

  test('restarts an exited child with bounded backoff and clears health after readiness', async () => {
    const fixture = fakeWorkerFixture();
    const events: string[] = [];
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig(true),
      moduleUrl: import.meta.url,
      startupTimeoutMs: 20_000,
      readinessPollMs: 20,
      stopGraceMs: 100,
      restartDelaysMs: [20, 40],
      workerEnvPath: fixture.envFilePath,
    }));
    await service.start({ serviceHealth: healthRecorder(events) });
    const firstPid = Number(readFileSync(fixture.pidPath, 'utf8'));

    process.kill(firstPid, 'SIGKILL');
    await waitUntil(() => (
      readCount(fixture.countPath) >= 2
      && Number(readFileSync(fixture.pidPath, 'utf8')) !== firstPid
      && events.at(-1) === 'clear'
    ));

    expect(events).toEqual(['failure:Olympus worker is starting.', 'clear', 'failure:Olympus worker exited unexpectedly.', 'failure:Olympus worker is starting.', 'clear']);
  });

  test('cleans a crashed worker process group before starting its replacement', async () => {
    const fixture = fakeWorkerFixture({ spawnDescendant: true });
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig(true),
      moduleUrl: import.meta.url,
      startupTimeoutMs: 20_000,
      readinessPollMs: 20,
      stopGraceMs: 100,
      restartDelaysMs: [20],
      workerEnvPath: fixture.envFilePath,
    }));
    await service.start({});
    const crashedPid = Number(readFileSync(fixture.pidPath, 'utf8'));
    const orphanCandidatePid = Number(readFileSync(fixture.descendantPidPath!, 'utf8'));

    process.kill(crashedPid, 'SIGKILL');
    await waitUntil(() => readCount(fixture.countPath) >= 2);

    expect(processExists(orphanCandidatePid)).toBe(false);
    expect(Number(readFileSync(fixture.pidPath, 'utf8'))).not.toBe(crashedPid);
  });

  test('stop waits for an in-flight crash cleanup before resolving', async () => {
    const fixture = fakeWorkerFixture({ spawnDescendant: true });
    let stopAfterCrash: Promise<void> | undefined;
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig(true),
      moduleUrl: import.meta.url,
      startupTimeoutMs: 20_000,
      readinessPollMs: 20,
      stopGraceMs: 100,
      restartDelaysMs: [20],
      workerEnvPath: fixture.envFilePath,
    }));
    await service.start({
      serviceHealth: {
        reportFailure(error) {
          if (error.message === 'Olympus worker exited unexpectedly.') stopAfterCrash = service.stop();
        },
        clearFailure() {},
      },
    });
    const crashedPid = Number(readFileSync(fixture.pidPath, 'utf8'));
    const descendantPid = Number(readFileSync(fixture.descendantPidPath!, 'utf8'));

    process.kill(crashedPid, 'SIGKILL');
    await waitUntil(() => stopAfterCrash !== undefined);
    await stopAfterCrash;

    expect(processExists(descendantPid)).toBe(false);
    expect(readCount(fixture.countPath)).toBe(1);
  });

  test('stop terminates the detached process group including descendants and cancels restart', async () => {
    const fixture = fakeWorkerFixture({ spawnDescendant: true });
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig(true),
      moduleUrl: import.meta.url,
      startupTimeoutMs: 20_000,
      readinessPollMs: 20,
      stopGraceMs: 100,
      restartDelaysMs: [20],
      workerEnvPath: fixture.envFilePath,
    }));
    await service.start({});
    const childPid = Number(readFileSync(fixture.pidPath, 'utf8'));
    const descendantPid = Number(readFileSync(fixture.descendantPidPath!, 'utf8'));

    await service.stop();
    await waitUntil(() => !processExists(childPid) && !processExists(descendantPid));
    await Bun.sleep(80);

    expect(readCount(fixture.countPath)).toBe(1);
  });

  test('rejects startup when another process owns the port even if it accepts the configured token', async () => {
    const fixture = fakeWorkerFixture();
    const existing = Bun.serve({
      hostname: '127.0.0.1',
      port: fixture.port,
      fetch(request) {
        if (
          new URL(request.url).pathname === '/v1/service/readiness'
          && request.headers.get('authorization') === `Bearer ${fixture.token}`
        ) return new Response('not configured', { status: 501 });
        return new Response('unauthorized', { status: 401 });
      },
    });
    const events: string[] = [];
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig(true),
      moduleUrl: import.meta.url,
      startupTimeoutMs: 1_000,
      readinessPollMs: 20,
      stopGraceMs: 100,
      workerEnvPath: fixture.envFilePath,
    }));
    try {
      await expect(service.start({ serviceHealth: healthRecorder(events) }))
        .rejects.toThrow('Olympus worker failed to become ready.');
      expect(events).toEqual(['failure:Olympus worker failed to become ready.']);
      expect(readCount(fixture.countPath)).toBe(0);
    } finally {
      existing.stop(true);
    }
  });

  test('fails startup when the spawned child exits before readiness', async () => {
    const fixture = fakeWorkerFixture({ exitBeforeServe: true });
    const events: string[] = [];
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig(true),
      moduleUrl: import.meta.url,
      startupTimeoutMs: 10_000,
      readinessPollMs: 20,
      stopGraceMs: 100,
      restartDelaysMs: [20],
      workerEnvPath: fixture.envFilePath,
    }));

    await expect(service.start({ serviceHealth: healthRecorder(events) }))
      .rejects.toThrow('Olympus worker failed to become ready.');
    await Bun.sleep(80);

    expect(readCount(fixture.countPath)).toBe(1);
    expect(events).toEqual(['failure:Olympus worker is starting.', 'failure:Olympus worker failed to become ready.']);
  });

  test('reconstructs child resources across repeated start and stop calls', async () => {
    const fixture = fakeWorkerFixture();
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig(true),
      moduleUrl: import.meta.url,
      startupTimeoutMs: 20_000,
      readinessPollMs: 20,
      stopGraceMs: 100,
      workerEnvPath: fixture.envFilePath,
    }));

    await service.start({});
    const firstPid = Number(readFileSync(fixture.pidPath, 'utf8'));
    await service.stop();
    await service.stop();
    await service.start({});
    const secondPid = Number(readFileSync(fixture.pidPath, 'utf8'));

    expect(secondPid).not.toBe(firstPid);
    expect(readCount(fixture.countPath)).toBe(2);
  });
});

function fakeWorkerFixture(options: { spawnDescendant?: boolean; exitBeforeServe?: boolean } = {}): {
  root: string;
  port: number;
  token: string;
  countPath: string;
  pidPath: string;
  envFilePath: string;
  gatewaySecretPath: string;
  configEnvPath: string;
  descendantPidPath?: string;
  pluginConfig(enabled: boolean): Record<string, unknown>;
} {
  const root = mkdtempSync(join(tmpdir(), 'olympus-native-worker-service-'));
  roots.push(root);
  const scriptPath = join(root, 'fake-worker.mjs');
  const envFilePath = join(root, 'worker.env');
  const countPath = join(root, 'starts.txt');
  const pidPath = join(root, 'worker.pid');
  const descendantPidPath = options.spawnDescendant ? join(root, 'descendant.pid') : undefined;
  const gatewaySecretPath = join(root, 'gateway-secrets.json');
  const configEnvPath = join(root, 'config-env.json');
  const port = reservePort();
  const token = 'native-worker-test-token';
  writeFileSync(scriptPath, fakeWorkerSource(), { mode: 0o700 });
  writeFileSync(envFilePath, [
    `OLYMPUS_EMAIL_SOURCE_PORT=${port}`,
    `OLYMPUS_WORKER_AUTH_TOKEN=${token}`,
    `FAKE_WORKER_COUNT_PATH=${countPath}`,
    `FAKE_WORKER_PID_PATH=${pidPath}`,
    `FAKE_WORKER_GATEWAY_SECRET_PATH=${gatewaySecretPath}`,
    `FAKE_WORKER_CONFIG_ENV_PATH=${configEnvPath}`,
    'OLYMPUS_WORKER_SCHEDULER_ENABLED=false',
    'OLYMPUS_WORKER_SCHEDULER_SOURCE_IDS=telegram.messages',
    'OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER=false',
    'OLYMPUS_NATIVE_WHATSAPP_CAPTURE_OWNER=true',
    ...(options.exitBeforeServe ? ['FAKE_WORKER_EXIT_BEFORE_SERVE=true'] : []),
    ...(descendantPidPath ? [`FAKE_WORKER_DESCENDANT_PID_PATH=${descendantPidPath}`] : []),
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(envFilePath, 0o600);
  return {
    root,
    port,
    token,
    countPath,
    pidPath,
    envFilePath,
    gatewaySecretPath,
    configEnvPath,
    ...(descendantPidPath ? { descendantPidPath } : {}),
    pluginConfig(enabled) {
      return {
        worker: {
          authToken: token,
          service: {
            enabled,
            runtimePath: process.execPath,
            executablePath: scriptPath,
          },
        },
        email: { baseUrl: `http://127.0.0.1:${port}/v1` },
      };
    },
  };
}

function fakeWorkerSource(): string {
  return `
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

appendFileSync(process.env.FAKE_WORKER_COUNT_PATH, 'start\\n');
writeFileSync(process.env.FAKE_WORKER_PID_PATH, String(process.pid));
writeFileSync(process.env.FAKE_WORKER_GATEWAY_SECRET_PATH, JSON.stringify(Object.fromEntries(
  ['OP_CONNECT_TOKEN', 'OP_SESSION_personal', 'OPENCLAW_GATEWAY_TOKEN']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
)));
writeFileSync(process.env.FAKE_WORKER_CONFIG_ENV_PATH, JSON.stringify(Object.fromEntries(
  [
    'OLYMPUS_EMAIL_SOURCE_HOST',
    'OLYMPUS_EMAIL_SOURCE_PORT',
    'OLYMPUS_SOURCE_INDEX_ENABLED',
    'OLYMPUS_WORKER_SCHEDULER_ENABLED',
    'OLYMPUS_WORKER_SCHEDULER_SOURCE_IDS',
    'OLYMPUS_WORKER_SCHEDULER_TICK_SECONDS',
    'OLYMPUS_WORKER_SCHEDULER_SYNC_INTERVAL_SECONDS',
    'OLYMPUS_WORKER_SCHEDULER_FRESHNESS_THRESHOLD_HOURS',
    'OLYMPUS_WORKER_SCHEDULER_ERROR_BACKOFF_SECONDS',
    'OLYMPUS_WORKER_SCHEDULER_MAX_TRANSIENT_RETRIES',
    'OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER',
    'OLYMPUS_NATIVE_WHATSAPP_CAPTURE_OWNER',
    'OLYMPUS_SOVEREIGNTY_CONFIG_PATH',
    'OLYMPUS_CREDENTIAL_SYNTHETIC',
  ].map((key) => [key, process.env[key]]),
)));
if (process.env.FAKE_WORKER_EXIT_BEFORE_SERVE === 'true') process.exit(23);
const descendantPath = process.env.FAKE_WORKER_DESCENDANT_PID_PATH;
if (descendantPath) {
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    stdio: 'ignore',
  });
  writeFileSync(descendantPath, String(descendant.pid));
}
const token = process.env.OLYMPUS_WORKER_AUTH_TOKEN;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.OLYMPUS_EMAIL_SOURCE_PORT),
  fetch(request) {
    const authenticated = request.headers.get('authorization') === \`Bearer \${token}\`;
    if (!authenticated) return new Response('unauthorized', { status: 401 });
    if (new URL(request.url).pathname === '/v1/service/readiness') {
      return Response.json({ instance_id: process.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID });
    }
    return new Response('not found', { status: 404 });
  },
});
process.once('SIGTERM', () => {
  server.stop(true);
  process.exit(0);
});
setInterval(() => {}, 1000);
`;
}

function reservePort(): number {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = server.port!;
    server.stop(true);
    if (usedPorts.has(port)) continue;
    usedPorts.add(port);
    return port;
  }
  throw new Error('Could not reserve a unique fake-worker port.');
}

function healthRecorder(events: string[]): NativeWorkerServiceHealth {
  return {
    reportFailure(error) {
      events.push(`failure:${error.message}`);
    },
    clearFailure() {
      events.push('clear');
    },
  };
}

function readCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {
      // The child may be between replacing its pid and counter files.
    }
    await Bun.sleep(20);
  }
  throw new Error('Timed out waiting for fake worker lifecycle state.');
}

function track<T extends NativeWorkerServiceDefinition>(service: T): T {
  services.push(service);
  return service;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
