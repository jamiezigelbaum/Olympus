import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromPluginConfig } from '../src/core/config.ts';
import { createNativeTelegramService } from '../src/core/native-telegram-service.ts';

const roots: string[] = [];
const services: Array<ReturnType<typeof createNativeTelegramService>> = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native Telegram capture service', () => {
  test('defaults disabled and validates only the two resolved credential names and absolute paths', () => {
    expect(configFromPluginConfig({}).worker.telegramCapture).toEqual({
      enabled: false,
      credentials: {},
    });
    expect(configFromPluginConfig({
      worker: {
        telegramCapture: {
          enabled: true,
          pythonPath: '/opt/olympus/bin/python',
          credentials: {
            OLYMPUS_TELEGRAM_API_ID: '12345',
            OLYMPUS_TELEGRAM_API_HASH: 'hash-value',
          },
        },
      },
    }).worker.telegramCapture.credentials).toEqual({
      OLYMPUS_TELEGRAM_API_ID: '12345',
      OLYMPUS_TELEGRAM_API_HASH: 'hash-value',
    });
    expect(() => configFromPluginConfig({
      worker: { telegramCapture: { pythonPath: 'venv/bin/python' } },
    })).toThrow('worker.telegramCapture.pythonPath must be an absolute path');
    expect(() => configFromPluginConfig({
      worker: { telegramCapture: { credentials: { GEMINI_API_KEY: 'not-for-this-child' } } },
    })).toThrow('does not allow environment name GEMINI_API_KEY');

    const opaque = { source: 'env', provider: 'default', id: 'TELEGRAM_API_ID' };
    expect(configFromPluginConfig({
      worker: {
        telegramCapture: {
          enabled: true,
          credentials: { OLYMPUS_TELEGRAM_API_ID: opaque, OLYMPUS_TELEGRAM_API_HASH: opaque },
        },
      },
    }, { requireResolvedWorkerSecrets: false }).worker.telegramCapture.credentials).toEqual({});
  });

  test('matches Python readiness for duplicate and whitespace-padded approved scopes', async () => {
    const fixture = telegramFixture();
    writeFileSync(fixture.workerEnvPath, readFileSync(fixture.workerEnvPath, 'utf8').replace(
      'APPROVED_CHAT_SCOPES=telegram.personal:chat:42',
      'APPROVED_CHAT_SCOPES= telegram.personal:chat:42, ,telegram.personal:chat:42 ',
    ));
    const service = track(createNativeTelegramService({
      initialPluginConfig: fixture.pluginConfig,
      moduleUrl: new URL('../src/native-plugin.ts', import.meta.url).href,
      workerEnvPath: fixture.workerEnvPath,
      startupTimeoutMs: 2_000,
      readinessPollMs: 10,
      stopGraceMs: 100,
    }));
    await service.start({});
    expect(readStarts(fixture.startsPath)).toHaveLength(1);
  });

  test('uses fresh scoped environment and instance-bound receipt across stop and restart', async () => {
    const fixture = telegramFixture();
    const service = track(createNativeTelegramService({
      initialPluginConfig: fixture.pluginConfig,
      moduleUrl: new URL('../src/native-plugin.ts', import.meta.url).href,
      workerEnvPath: fixture.workerEnvPath,
      startupTimeoutMs: 10_000,
      readinessPollMs: 10,
      stopGraceMs: 100,
    }));

    await service.start({});
    const first = readStarts(fixture.startsPath)[0]!;
    expect(first.argv.slice(-2)).toEqual([
      expect.stringContaining('/scripts/telegram-telethon-reader.py'),
      '--gateway',
    ]);
    expect(first.env).toMatchObject({
      OLYMPUS_TELEGRAM_API_ID: '22222',
      OLYMPUS_TELEGRAM_API_HASH: 'native-hash',
      OLYMPUS_TELEGRAM_SESSION_PATH: fixture.sessionPath,
      OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: fixture.stateDir,
      OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: fixture.spoolDir,
      OLYMPUS_TELEGRAM_GATEWAY_REPORT_PATH: fixture.reportPath,
      OLYMPUS_SOURCE_INDEX_TELEGRAM_ACCOUNT: 'telegram.personal',
      OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES: 'telegram.personal:chat:42',
      OLYMPUS_TELEGRAM_GATEWAY_INTERVAL_SECONDS: '23',
    });
    expect(first.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    for (const name of [
      'GEMINI_API_KEY',
      'OLYMPUS_SOURCE_INDEX_TELEGRAM_API_KEY',
      'OLYMPUS_WORKER_AUTH_TOKEN',
      'OP_CONNECT_TOKEN',
      'OP_SESSION_personal',
      'NODE_OPTIONS',
      'UNRELATED_VALUE',
    ]) {
      expect(first.env[name]).toBeUndefined();
    }

    await service.stop();
    await service.start({});
    const starts = readStarts(fixture.startsPath);
    expect(starts).toHaveLength(2);
    expect(starts[1]!.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID)
      .not.toBe(first.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID);
    expect(starts[1]!.pid).not.toBe(first.pid);
  });

  test('refuses stale readiness and reports only the categorical startup failure', async () => {
    const fixture = telegramFixture({ publishReadiness: false });
    mkdirSync(fixture.stateDir, { recursive: true });
    writeFileSync(join(fixture.stateDir, 'native-service-readiness.json'), JSON.stringify({
      kind: 'telegram_capture_service_readiness',
      instance_id: '019f6ff4-2fb0-70a3-91dd-3ef3ada9354f',
      pid: process.pid,
      authenticated: true,
      approved_chats: 1,
    }));
    const failures: string[] = [];
    const service = track(createNativeTelegramService({
      initialPluginConfig: fixture.pluginConfig,
      moduleUrl: new URL('../src/native-plugin.ts', import.meta.url).href,
      workerEnvPath: fixture.workerEnvPath,
      startupTimeoutMs: 100,
      readinessPollMs: 10,
      stopGraceMs: 50,
    }));

    await expect(service.start({
      serviceHealth: {
        reportFailure(error) { failures.push(error.message); },
        clearFailure() {},
      },
    })).rejects.toThrow('Olympus Telegram capture service failed to become ready.');
    expect(failures).toEqual(['Olympus Telegram capture service failed to become ready.']);
  });

  test('fails before spawn for missing credentials, session, or approved scopes', async () => {
    const cases = [
      {
        mutate(config: Record<string, any>) {
          config.worker.telegramCapture.credentials = {};
        },
        message: 'requires resolved OLYMPUS_TELEGRAM_API_ID credentials',
      },
      {
        mutate(config: Record<string, any>) {
          config.worker.telegramCapture.sessionPath = join(tmpdir(), 'missing-telegram.session');
        },
        message: 'Telegram .session file is missing',
      },
      {
        mutate(_config: Record<string, any>, envLines: string[]) {
          const index = envLines.findIndex((line) => line.startsWith('OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES='));
          envLines.splice(index, 1);
        },
        message: 'requires at least one approved chat scope',
      },
    ];

    for (const entry of cases) {
      const fixture = telegramFixture();
      const config = structuredClone(fixture.pluginConfig) as Record<string, any>;
      const envLines = readFileSync(fixture.workerEnvPath, 'utf8').trimEnd().split('\n');
      entry.mutate(config, envLines);
      writeFileSync(fixture.workerEnvPath, `${envLines.join('\n')}\n`, { mode: 0o600 });
      const service = track(createNativeTelegramService({
        initialPluginConfig: config,
        moduleUrl: new URL('../src/native-plugin.ts', import.meta.url).href,
        workerEnvPath: fixture.workerEnvPath,
        startupTimeoutMs: 200,
        readinessPollMs: 10,
        stopGraceMs: 50,
      }));
      await expect(service.start({})).rejects.toThrow(entry.message);
      expect(readStarts(fixture.startsPath)).toEqual([]);
    }
  });

  test('fresh runtime removal disables a service registered from enabled initial config', async () => {
    const fixture = telegramFixture();
    const service = track(createNativeTelegramService({
      initialPluginConfig: fixture.pluginConfig,
      moduleUrl: new URL('../src/native-plugin.ts', import.meta.url).href,
      workerEnvPath: fixture.workerEnvPath,
      startupTimeoutMs: 200,
    }));
    await service.start({ config: { plugins: { entries: {} } } });
    expect(readStarts(fixture.startsPath)).toEqual([]);
  });
});

function track(service: ReturnType<typeof createNativeTelegramService>) {
  services.push(service);
  return service;
}

function telegramFixture(options: { publishReadiness?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'olympus-native-telegram-'));
  roots.push(root);
  const pythonPath = join(root, 'fixture-python');
  const startsPath = join(root, 'starts.jsonl');
  const workerEnvPath = join(root, 'worker.env');
  const sessionPath = join(root, 'telegram.personal.session');
  const staleSessionPath = join(root, 'stale.session');
  const stateDir = join(root, 'state');
  const staleStateDir = join(root, 'stale-state');
  const spoolDir = join(root, 'spool');
  const reportPath = join(root, 'report.json');
  writeFileSync(sessionPath, 'fixture-session');
  writeFileSync(staleSessionPath, 'stale-session');
  writeFileSync(pythonPath, fakeInterpreterSource(startsPath, options.publishReadiness !== false), { mode: 0o700 });
  chmodSync(pythonPath, 0o700);
  writeFileSync(workerEnvPath, [
    'OLYMPUS_SOURCE_INDEX_TELEGRAM_ACCOUNT=telegram.personal',
    'OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES=telegram.personal:chat:42',
    'OLYMPUS_TELEGRAM_GATEWAY_INTERVAL_SECONDS=23',
    `OLYMPUS_TELEGRAM_SESSION_PATH=${staleSessionPath}`,
    `OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR=${staleStateDir}`,
    'OLYMPUS_TELEGRAM_API_ID=11111',
    'OLYMPUS_TELEGRAM_API_HASH=worker-env-hash',
    'GEMINI_API_KEY=must-not-pass',
    'OLYMPUS_SOURCE_INDEX_TELEGRAM_API_KEY=must-not-pass',
    'OLYMPUS_WORKER_AUTH_TOKEN=must-not-pass',
    'OP_CONNECT_TOKEN=must-not-pass',
    'OP_SESSION_personal=must-not-pass',
    'NODE_OPTIONS=--inspect',
    'UNRELATED_VALUE=must-not-pass',
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(workerEnvPath, 0o600);
  const pluginConfig = {
    worker: {
      telegramCapture: {
        enabled: true,
        pythonPath,
        sessionPath,
        stateDir,
        spoolDir,
        reportPath,
        credentials: {
          OLYMPUS_TELEGRAM_API_ID: '22222',
          OLYMPUS_TELEGRAM_API_HASH: 'native-hash',
        },
      },
    },
  };
  return {
    pluginConfig,
    pythonPath,
    startsPath,
    workerEnvPath,
    sessionPath,
    stateDir,
    spoolDir,
    reportPath,
  };
}

function fakeInterpreterSource(startsPath: string, publishReadiness: boolean): string {
  const names = fixtureEnvNames();
  const format = Array(names.length + 3).fill('%s').join('\t');
  const values = names.map((name) => `"$${name}"`).join(' ');
  return `#!/bin/sh
printf '${format}\\n' "$$" "$1" "$2" ${values} >> ${shellQuote(startsPath)}
mkdir -p "$OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR"
${publishReadiness ? `printf '{"kind":"telegram_capture_service_readiness","instance_id":"%s","pid":%s,"authenticated":true,"approved_chats":1}\\n' "$OLYMPUS_NATIVE_SERVICE_INSTANCE_ID" "$$" > "$OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR/native-service-readiness.json"` : ''}
trap 'exit 0' TERM INT
while :; do sleep 1; done
`;
}

function readStarts(path: string): Array<{ pid: number; argv: string[]; env: Record<string, string> }> {
  try {
    const names = fixtureEnvNames();
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [pid, firstArg, secondArg, ...values] = line.split('\t');
      return {
        pid: Number(pid),
        argv: [firstArg!, secondArg!],
        env: Object.fromEntries(names.flatMap((name, index) => values[index] ? [[name, values[index]!]] : [])),
      };
    });
  } catch {
    return [];
  }
}

function fixtureEnvNames(): string[] {
  return [
    'OLYMPUS_TELEGRAM_API_ID',
    'OLYMPUS_TELEGRAM_API_HASH',
    'OLYMPUS_TELEGRAM_SESSION_PATH',
    'OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR',
    'OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR',
    'OLYMPUS_TELEGRAM_GATEWAY_REPORT_PATH',
    'OLYMPUS_SOURCE_INDEX_TELEGRAM_ACCOUNT',
    'OLYMPUS_SOURCE_INDEX_TELEGRAM_APPROVED_CHAT_SCOPES',
    'OLYMPUS_TELEGRAM_GATEWAY_INTERVAL_SECONDS',
    'OLYMPUS_NATIVE_SERVICE_INSTANCE_ID',
    'GEMINI_API_KEY',
    'OLYMPUS_SOURCE_INDEX_TELEGRAM_API_KEY',
    'OLYMPUS_WORKER_AUTH_TOKEN',
    'OP_CONNECT_TOKEN',
    'OP_SESSION_personal',
    'NODE_OPTIONS',
    'UNRELATED_VALUE',
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
