import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromPluginConfig } from '../src/core/config.ts';
import { createNativeWhatsAppService } from '../src/core/native-whatsapp-service.ts';
import { accountFolder } from '../src/core/olympus-layout.ts';
import { sourceRegistryPath } from '../src/core/source-registry.ts';

const roots: string[] = [];
const services: Array<ReturnType<typeof createNativeWhatsAppService>> = [];
const savedEnv = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A data folder whose registry lists WhatsApp with the given layout, the service's own environment pointed at it. */
function registryWith(root: string, layout: 'folder' | 'legacy'): { folder: string } {
  process.env.HOME = join(root, 'home');
  process.env.XDG_DATA_HOME = join(root, 'data');
  const env = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  mkdirSync(join(sourceRegistryPath(env), '..'), { recursive: true });
  writeFileSync(sourceRegistryPath(env), `${JSON.stringify({
    schema: layout === 'folder' ? 2 : 1,
    accounts: [{ source_id: 'whatsapp.personal.messages', slot: '1', state: 'active', layout, corpus_ids: [], created_at: '2026-10-01T00:00:00.000Z' }],
  })}\n`);
  return { folder: accountFolder({ source_id: 'whatsapp.personal.messages', slot: '1' }, env) };
}

describe('native WhatsApp capture service', () => {
  test('refuses capture without native worker ownership and when worker supervision is disabled', async () => {
    const fixture = whatsappFixture();
    for (const enabled of [true, false]) {
      const service = track(createNativeWhatsAppService({
        initialPluginConfig: { ...fixture.pluginConfig, worker: { ...fixture.pluginConfig.worker, service: { enabled } } },
        workerIsReady: () => false,
        workerReadinessTimeoutMs: 0,
      }));
      await expect(service.start({})).rejects.toThrow(enabled ? 'does not own its endpoint' : 'requires worker.service.enabled');
      expect(existsSync(fixture.startsPath)).toBe(false);
      expect(service.reload.configPrefixes).toContain('plugins.entries.olympus.config.worker');
    }
  });

  test('defaults disabled and requires absolute binary and state paths when configured', () => {
    expect(configFromPluginConfig({}).worker.whatsappCapture).toEqual({ enabled: false });
    expect(() => configFromPluginConfig({
      worker: { whatsappCapture: { enabled: true } },
    })).toThrow('binaryPath is required when worker.whatsappCapture.enabled is true');
    expect(() => configFromPluginConfig({
      worker: { whatsappCapture: { enabled: true, binaryPath: 'bin/whatsapp-bridge' } },
    })).toThrow('worker.whatsappCapture.binaryPath must be an absolute path');
    expect(() => configFromPluginConfig({
      worker: {
        whatsappCapture: {
          enabled: true,
          binaryPath: '/opt/olympus/bin/whatsapp-bridge',
          stateDir: 'state/whatsapp',
        },
      },
    })).toThrow('worker.whatsappCapture.stateDir must be an absolute path');
  });

  test('keeps a connecting bridge pending beyond the host callback deadline and remains stoppable', async () => {
    const fixture = whatsappFixture({ receipt: {} });
    const service = track(createNativeWhatsAppService({
      workerIsReady: () => true,
      initialPluginConfig: fixture.pluginConfig, readinessPollMs: 20, stopGraceMs: 100,
    }));
    let settled = false;
    const health: string[] = [];
    const startup = service.start({ serviceHealth: {
      reportFailure(error) { health.push(error.message); }, clearFailure() { health.push('ready'); },
    } }).then(() => { settled = true; }, () => { settled = true; });
    try {
      await Bun.sleep(5_100);
      expect(settled).toBe(false);
      expect(health).toEqual(['Olympus WhatsApp capture service is starting.']);
    } finally { await service.stop(); await startup; }
  }, 15_000);

  test('starts with only the minimal system environment and instance-bound native settings, then stops', async () => {
    const fixture = whatsappFixture();
    const service = track(createNativeWhatsAppService({
      workerIsReady: () => true,
      initialPluginConfig: fixture.pluginConfig,
      startupTimeoutMs: 2_000,
      readinessPollMs: 10,
      // stop() returns at the child's exit; the grace only bounds a child that
      // ignores SIGTERM, so a slow runner must not turn its trap into a SIGKILL.
      stopGraceMs: 10_000,
    }));

    await service.start({});
    const [start] = readStarts(fixture.startsPath);
    expect(start).toBeDefined();
    expect(start!.argv).toEqual([]);
    expect(start!.env).toMatchObject({
      OLYMPUS_WHATSAPP_STATE_DIR: fixture.stateDir,
      OLYMPUS_WHATSAPP_QR_STDOUT: 'false',
      OLYMPUS_WHATSAPP_NATIVE_CAPTURE: 'true',
    });
    expect(start!.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    for (const name of [
      'GEMINI_API_KEY',
      'OLYMPUS_WORKER_AUTH_TOKEN',
      'OP_CONNECT_TOKEN',
      'OP_SESSION_personal',
      'OPENCLAW_GATEWAY_TOKEN',
      'NODE_OPTIONS',
    ]) {
      expect(start!.env[name]).toBeUndefined();
    }

    await service.stop();
    expect(readFileSync(fixture.stopPath, 'utf8')).toBe('stopped\n');
  });

  test('an account the registry keeps in a folder runs in the folder', async () => {
    const fixture = whatsappFixture();
    const { folder } = registryWith(fixture.root, 'folder');
    const stateDir = join(folder, 'raw', 'whatsapp');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'session.db'), 'paired-fixture');
    const config = structuredClone(fixture.pluginConfig) as Record<string, any>;
    delete config.worker.whatsappCapture.stateDir;
    const service = track(createNativeWhatsAppService({
      workerIsReady: () => true,
      initialPluginConfig: config,
      startupTimeoutMs: 2_000,
      readinessPollMs: 10,
      stopGraceMs: 10_000,
    }));
    await service.start({});
    expect(readStarts(fixture.startsPath)[0]!.env.OLYMPUS_WHATSAPP_STATE_DIR).toBe(stateDir);
  });

  /** A registry in the data folder of `dataHome`, listing WhatsApp as a folder with a paired session in it. */
  function pairedFolderIn(root: string, dataHome: string): string {
    const home = join(root, 'home');
    const env = { HOME: home, XDG_DATA_HOME: dataHome };
    mkdirSync(join(sourceRegistryPath(env), '..'), { recursive: true });
    writeFileSync(sourceRegistryPath(env), `${JSON.stringify({
      schema: 2,
      accounts: [{ source_id: 'whatsapp.personal.messages', slot: '1', state: 'active', layout: 'folder', corpus_ids: [], created_at: '2026-10-01T00:00:00.000Z' }],
    })}\n`);
    const stateDir = join(accountFolder({ source_id: 'whatsapp.personal.messages', slot: '1' }, env), 'raw', 'whatsapp');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'session.db'), 'paired-fixture');
    return stateDir;
  }
  function workerEnvFile(root: string, lines: string[]): string {
    const path = join(root, 'worker.env');
    writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }
  async function startedStateDir(fixture: ReturnType<typeof whatsappFixture>, workerEnvPath: string): Promise<string | undefined> {
    const config = structuredClone(fixture.pluginConfig) as Record<string, any>;
    delete config.worker.whatsappCapture.stateDir;
    const service = track(createNativeWhatsAppService({
      workerIsReady: () => true,
      initialPluginConfig: config,
      workerEnvPath,
      startupTimeoutMs: 2_000,
      readinessPollMs: 10,
      stopGraceMs: 10_000,
    }));
    await service.start({});
    return readStarts(fixture.startsPath)[0]!.env.OLYMPUS_WHATSAPP_STATE_DIR;
  }

  test('an XDG_DATA_HOME that only worker.env sets places the account where the worker finds it', async () => {
    const fixture = whatsappFixture();
    process.env.HOME = join(fixture.root, 'home');
    delete process.env.XDG_DATA_HOME;
    const stateDir = pairedFolderIn(fixture.root, join(fixture.root, 'data'));
    const workerEnvPath = workerEnvFile(fixture.root, [`XDG_DATA_HOME=${join(fixture.root, 'data')}`]);
    expect(await startedStateDir(fixture, workerEnvPath)).toBe(stateDir);
  });

  test('an XDG_DATA_HOME in the Gateway\'s environment wins over worker.env, as it does for the worker', async () => {
    const fixture = whatsappFixture();
    process.env.HOME = join(fixture.root, 'home');
    process.env.XDG_DATA_HOME = join(fixture.root, 'ambient');
    const stateDir = pairedFolderIn(fixture.root, join(fixture.root, 'ambient'));
    const workerEnvPath = workerEnvFile(fixture.root, [`XDG_DATA_HOME=${join(fixture.root, 'other')}`]);
    expect(await startedStateDir(fixture, workerEnvPath)).toBe(stateDir);
  });

  test('a configured state folder that is not the account folder contradicts the registry and is refused', async () => {
    const fixture = whatsappFixture();
    registryWith(fixture.root, 'folder');
    const service = track(createNativeWhatsAppService({
      workerIsReady: () => true,
      initialPluginConfig: fixture.pluginConfig,
      startupTimeoutMs: 200,
      readinessPollMs: 10,
      stopGraceMs: 50,
    }));
    await expect(service.start({})).rejects.toThrow('keeps its files in its account folder');
    expect(readStarts(fixture.startsPath)).toEqual([]);
  });

  test('an account the registry keeps at the legacy paths keeps the configured folder', async () => {
    const fixture = whatsappFixture();
    registryWith(fixture.root, 'legacy');
    const service = track(createNativeWhatsAppService({
      workerIsReady: () => true,
      initialPluginConfig: fixture.pluginConfig,
      startupTimeoutMs: 2_000,
      readinessPollMs: 10,
      stopGraceMs: 10_000,
    }));
    await service.start({});
    expect(readStarts(fixture.startsPath)[0]!.env.OLYMPUS_WHATSAPP_STATE_DIR).toBe(fixture.stateDir);
  });

  test('refuses a stale receipt and requires the full matching readiness contract', async () => {
    for (const receipt of [
      {
        kind: 'whatsapp_capture_service_readiness',
        instance_id: '019f6ff4-2fb0-70a3-91dd-3ef3ada9354f',
        pid: process.pid,
        paired: true,
        connected: true,
      },
      {
        kind: 'whatsapp_capture_service_readiness',
        instance_id: '$INSTANCE_ID',
        pid: '$PID',
        paired: true,
      },
    ] as const) {
      const fixture = whatsappFixture({ receipt });
      const failures: string[] = [];
      const service = track(createNativeWhatsAppService({
      workerIsReady: () => true,
      initialPluginConfig: fixture.pluginConfig,
        startupTimeoutMs: 100,
        readinessPollMs: 10,
        stopGraceMs: 50,
      }));
      await expect(service.start({
        serviceHealth: {
          reportFailure(error) { failures.push(error.message); },
          clearFailure() {},
        },
      })).rejects.toThrow('Olympus WhatsApp capture service failed to become ready.');
      expect(failures).toEqual([
        'Olympus WhatsApp capture service is starting.',
        'Olympus WhatsApp capture service failed to become ready.',
      ]);
    }
  });

  test('fails before spawn when the paired session database is missing', async () => {
    const fixture = whatsappFixture();
    rmSync(join(fixture.stateDir, 'session.db'));
    const service = track(createNativeWhatsAppService({
      workerIsReady: () => true,
      initialPluginConfig: fixture.pluginConfig,
      startupTimeoutMs: 100,
    }));
    await expect(service.start({})).rejects.toThrow('requires an existing session.db; pair it manually first');
    expect(readStarts(fixture.startsPath)).toEqual([]);
  });

  test('fresh runtime removal disables a service registered from enabled initial config', async () => {
    const fixture = whatsappFixture();
    const service = track(createNativeWhatsAppService({
      workerIsReady: () => true,
      initialPluginConfig: fixture.pluginConfig,
      startupTimeoutMs: 100,
    }));
    await service.start({ config: { plugins: { entries: {} } } });
    expect(readStarts(fixture.startsPath)).toEqual([]);
  });
});

function track(service: ReturnType<typeof createNativeWhatsAppService>) {
  services.push(service);
  return service;
}

function whatsappFixture(options: {
  receipt?: Record<string, unknown>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'olympus-native-whatsapp-'));
  roots.push(root);
  const binaryPath = join(root, 'whatsapp-bridge');
  const startsPath = join(root, 'starts.jsonl');
  const stopPath = join(root, 'stopped.txt');
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, 'session.db'), 'paired-fixture');
  writeFileSync(binaryPath, fakeBinarySource(startsPath, stopPath, options.receipt), { mode: 0o700 });
  chmodSync(binaryPath, 0o700);
  return {
    root,
    pluginConfig: {
      worker: { service: { enabled: true }, whatsappCapture: { enabled: true, binaryPath, stateDir } },
    },
    binaryPath,
    startsPath,
    stopPath,
    stateDir,
  };
}

function fakeBinarySource(
  startsPath: string,
  stopPath: string,
  receipt: Record<string, unknown> | undefined,
): string {
  const names = fixtureEnvNames();
  const format = Array(names.length + 1).fill('%s').join('\t');
  const values = names.map((name) => `"$${name}"`).join(' ');
  const configuredReceipt = receipt ?? {
    kind: 'whatsapp_capture_service_readiness',
    instance_id: '$INSTANCE_ID',
    pid: '$PID',
    paired: true,
    connected: true,
  };
  const receiptJson = JSON.stringify(configuredReceipt)
    .replace('"$INSTANCE_ID"', '"%s"')
    .replace('"$PID"', '%s');
  // The TERM trap is set before the readiness receipt is written: start()
  // resolves on the receipt, and a stop() that lands before the trap would
  // kill the shell without writing its stop file.
  return `#!/bin/sh
trap 'printf "stopped\\n" > ${shellQuote(stopPath)}; exit 0' TERM INT
printf '${format}\\n' "$$" ${values} >> ${shellQuote(startsPath)}
printf '${receiptJson}\\n' "$OLYMPUS_NATIVE_SERVICE_INSTANCE_ID" "$$" > "$OLYMPUS_WHATSAPP_STATE_DIR/native-service-readiness.json"
while :; do sleep 1; done
`;
}

function readStarts(path: string): Array<{ pid: number; argv: string[]; env: Record<string, string> }> {
  try {
    const names = fixtureEnvNames();
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [pid, ...values] = line.split('\t');
      return {
        pid: Number(pid),
        argv: [],
        env: Object.fromEntries(names.flatMap((name, index) => values[index] ? [[name, values[index]!]] : [])),
      };
    });
  } catch {
    return [];
  }
}

function fixtureEnvNames(): string[] {
  return [
    'HOME',
    'PATH',
    'TMPDIR',
    'LANG',
    'OLYMPUS_WHATSAPP_STATE_DIR',
    'OLYMPUS_WHATSAPP_QR_STDOUT',
    'OLYMPUS_WHATSAPP_NATIVE_CAPTURE',
    'OLYMPUS_NATIVE_SERVICE_INSTANCE_ID',
    'GEMINI_API_KEY',
    'OLYMPUS_WORKER_AUTH_TOKEN',
    'OP_CONNECT_TOKEN',
    'OP_SESSION_personal',
    'OPENCLAW_GATEWAY_TOKEN',
    'NODE_OPTIONS',
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
