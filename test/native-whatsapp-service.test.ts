import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromPluginConfig } from '../src/core/config.ts';
import { createNativeWhatsAppService } from '../src/core/native-whatsapp-service.ts';

const roots: string[] = [];
const services: Array<ReturnType<typeof createNativeWhatsAppService>> = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
      stopGraceMs: 200,
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
  return `#!/bin/sh
printf '${format}\\n' "$$" ${values} >> ${shellQuote(startsPath)}
printf '${receiptJson}\\n' "$OLYMPUS_NATIVE_SERVICE_INSTANCE_ID" "$$" > "$OLYMPUS_WHATSAPP_STATE_DIR/native-service-readiness.json"
trap 'printf "stopped\\n" > ${shellQuote(stopPath)}; exit 0' TERM INT
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
