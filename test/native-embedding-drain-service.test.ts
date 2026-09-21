import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createNativeEmbeddingDrainService } from '../src/core/native-embedding-drain-service.ts';
import { configFromPluginConfig, configWithEnvironmentOverrides } from '../src/core/config.ts';

const services: Array<ReturnType<typeof createNativeEmbeddingDrainService>> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native source embedding drain service', () => {
  test('defaults disabled and exposes only the two retained Gemini credential names', () => {
    expect(configFromPluginConfig({}).worker.embeddingDrain).toEqual({
      enabled: false,
      credentials: {},
    });
    expect(() => configFromPluginConfig({
      worker: {
        embeddingDrain: {
          credentials: { OLYMPUS_SOURCE_INDEX_VENICE_API_KEY: 'wrong-provider' },
        },
      },
    })).toThrow('does not allow environment name OLYMPUS_SOURCE_INDEX_VENICE_API_KEY');
  });

  test('starts the packaged drain with only managed settings and resolved embedding credentials', async () => {
    const fixture = embeddingFixture();
    const service = track(createNativeEmbeddingDrainService({
      initialPluginConfig: fixture.pluginConfig,
      moduleUrl: fixture.moduleUrl,
      workerEnvPath: fixture.workerEnvPath,
      startupTimeoutMs: 5_000,
      readinessPollMs: 10,
    }));

    await service.start({ config: { plugins: { entries: { olympus: { config: fixture.pluginConfig } } } } });
    const starts = readStarts(fixture.startsPath);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.args).toEqual([
      '--no-env-file',
      fixture.entryPath,
      '--report',
      fixture.reportPath,
    ]);
    expect(starts[0]?.env).toMatchObject({
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_ENABLED: 'true',
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_MODE: 'direct',
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_INTERNAL_TELEGRAM_ENABLED: 'true',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL: 'fixture-model',
      OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY: 'native-gemini-key',
    });
    expect(starts[0]?.env.GEMINI_API_KEY).toBe('native-gemini-key');
    expect(starts[0]?.env.OLYMPUS_WORKER_AUTH_TOKEN).toBeUndefined();
    expect(starts[0]?.env.OP_CONNECT_TOKEN).toBeUndefined();
    expect(starts[0]?.env.UNRELATED_VALUE).toBeUndefined();
    expect(starts[0]?.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID).toBeUndefined();
    const baseline = configFromPluginConfig({ sovereignty: { policy: { schemaVersion: 1 } } });
    const env: Record<string, string | undefined> = { ...starts[0]!.env, OLYMPUS_SOVEREIGNTY_CONFIG_PATH: '/private/tmp/unused-conflicting-policy.json' };
    const standaloneEnv = { ...env };
    delete standaloneEnv.OLYMPUS_SOURCE_EMBEDDING_DRAIN_INSTANCE_ID;
    expect(configWithEnvironmentOverrides(baseline, env).sovereignty)
      .toEqual(configWithEnvironmentOverrides(baseline, standaloneEnv).sovereignty);
    expect(configWithEnvironmentOverrides(baseline, env).sovereignty?.policy).toBeDefined();
    expect(starts[0]?.env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_INSTANCE_ID)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('never accepts a stale readiness receipt with the wrong nonce and pid', async () => {
    const fixture = embeddingFixture({ publishReadiness: false });
    mkdirSync(join(fixture.root, 'reports'), { recursive: true });
    writeFileSync(fixture.readinessPath, JSON.stringify({
      kind: 'source_embedding_drain_service_readiness',
      schema_version: 1,
      instance_id: '00000000-0000-4000-8000-000000000000',
      pid: process.pid,
      options_validated: true,
      content_free: true,
    }));
    const service = track(createNativeEmbeddingDrainService({
      initialPluginConfig: fixture.pluginConfig,
      moduleUrl: fixture.moduleUrl,
      workerEnvPath: fixture.workerEnvPath,
      startupTimeoutMs: 80,
      readinessPollMs: 10,
      restartDelaysMs: [10_000],
    }));

    await expect(service.start({
      config: { plugins: { entries: { olympus: { config: fixture.pluginConfig } } } },
    })).rejects.toThrow('failed to become ready');
  });

  test('fresh removal or disablement wins over the enabled registration snapshot', async () => {
    const fixture = embeddingFixture();
    const removed = track(createNativeEmbeddingDrainService({
      initialPluginConfig: fixture.pluginConfig,
      moduleUrl: fixture.moduleUrl,
      workerEnvPath: fixture.workerEnvPath,
    }));
    await removed.start({ config: { plugins: { entries: {} } } });

    const disabled = track(createNativeEmbeddingDrainService({
      initialPluginConfig: fixture.pluginConfig,
      moduleUrl: fixture.moduleUrl,
      workerEnvPath: fixture.workerEnvPath,
    }));
    await disabled.start({
      config: {
        plugins: {
          entries: {
            olympus: { config: { worker: { embeddingDrain: { enabled: false } } } },
          },
        },
      },
    });

    expect(readStarts(fixture.startsPath)).toEqual([]);
  });

  test('local-only configuration preserves custom paths without a cloud credential', async () => {
    const fixture = embeddingFixture();
    writeFileSync(fixture.workerEnvPath, [
      'OLYMPUS_CONFIG=/custom/policy.json',
      'OLYMPUS_SOURCE_EMBEDDING_DRAIN_INTERNAL_TELEGRAM_ENABLED=false',
      'OLYMPUS_SOURCE_EMBEDDING_DRAIN_PROTECTED_TELEGRAM_ENABLED=true',
      'OLYMPUS_SOURCE_EMBEDDING_DRAIN_PROTECTED_TELEGRAM_DB_PATH=/custom/protected.db',
      'GEMINI_API_KEY=ambient-must-not-pass',
    ].join('\n'));
    const config = { worker: { embeddingDrain: { ...fixture.pluginConfig.worker.embeddingDrain, environmentPath: fixture.workerEnvPath, credentials: {} } } };
    const service = track(createNativeEmbeddingDrainService({
      initialPluginConfig: config, moduleUrl: fixture.moduleUrl, workerEnvPath: '/unused/default-worker.env',
    }));
    await service.start({});
    const env = readStarts(fixture.startsPath)[0]!.env;
    expect(env.OLYMPUS_CONFIG).toBe('/custom/policy.json');
    expect(env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_PROTECTED_TELEGRAM_DB_PATH).toBe('/custom/protected.db');
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY).toBeUndefined();
  });

  test('an explicitly unavailable runtime never falls back to ambient Bun', async () => {
    const fixture = embeddingFixture();
    const config = { worker: { embeddingDrain: { ...fixture.pluginConfig.worker.embeddingDrain, runtimePath: '/unavailable/runtime' } } };
    const service = track(createNativeEmbeddingDrainService({
      initialPluginConfig: config, moduleUrl: fixture.moduleUrl, workerEnvPath: fixture.workerEnvPath,
    }));
    await expect(service.start({})).rejects.toThrow('Bun runtime file is missing');
    expect(readStarts(fixture.startsPath)).toHaveLength(0);
  });

  test('configured embedding references must resolve before startup', async () => {
    const fixture = embeddingFixture();
    const config = { worker: { embeddingDrain: { enabled: true, runtimePath: fixture.runtimePath, credentials: { GEMINI_API_KEY: { source: 'env', provider: 'default', id: 'GEMINI_KEY' } } } } };
    const service = track(createNativeEmbeddingDrainService({
      initialPluginConfig: config,
      moduleUrl: fixture.moduleUrl,
      workerEnvPath: fixture.workerEnvPath,
    }));
    await expect(service.start({
      config: { plugins: { entries: { olympus: { config } } } },
    })).rejects.toThrow('configuration is invalid or contains unresolved credentials');
  });
});

function track(service: ReturnType<typeof createNativeEmbeddingDrainService>) {
  services.push(service);
  return service;
}

function embeddingFixture(options: { publishReadiness?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'olympus-native-embedding-'));
  roots.push(root);
  const runtimePath = join(root, 'bun');
  const entryPath = join(root, 'embedding-drain.js');
  const startsPath = join(root, 'starts.tsv');
  const workerEnvPath = join(root, 'worker.env');
  const reportPath = join(root, 'reports', 'source-embedding-drain-current.json');
  const readinessPath = join(root, 'reports', 'source-embedding-drain-native-readiness.json');
  writeFileSync(entryPath, '// fixture entry\n');
  writeFileSync(runtimePath, fakeBunSource(startsPath, options.publishReadiness !== false), { mode: 0o700 });
  chmodSync(runtimePath, 0o700);
  writeFileSync(workerEnvPath, [
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_ENABLED=true',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_MODE=direct',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_INTERNAL_TELEGRAM_ENABLED=true',
    'OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL=fixture-model',
    'GEMINI_API_KEY=worker-env-key-must-not-pass',
    'OLYMPUS_WORKER_AUTH_TOKEN=must-not-pass',
    'OP_CONNECT_TOKEN=must-not-pass',
    'UNRELATED_VALUE=must-not-pass',
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(workerEnvPath, 0o600);
  const pluginConfig = {
    worker: {
      embeddingDrain: {
        enabled: true,
        runtimePath,
        reportPath,
        credentials: {
          OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY: 'native-gemini-key',
        },
      },
    },
  };
  return {
    root,
    runtimePath,
    entryPath,
    startsPath,
    workerEnvPath,
    reportPath,
    readinessPath,
    moduleUrl: pathToFileURL(join(root, 'index.js')).href,
    pluginConfig,
  };
}

function fakeBunSource(startsPath: string, publishReadiness: boolean): string {
  const names = fixtureEnvNames();
  const format = Array(names.length + 5).fill('%s').join('\t');
  const values = names.map((name) => `"$${name}"`).join(' ');
  return `#!/bin/sh
printf '${format}\\n' "$$" "$1" "$2" "$3" "$4" ${values} >> ${shellQuote(startsPath)}
mkdir -p "$(dirname "$OLYMPUS_SOURCE_EMBEDDING_DRAIN_READINESS_PATH")"
${publishReadiness ? `printf '{"kind":"source_embedding_drain_service_readiness","schema_version":1,"instance_id":"%s","pid":%s,"options_validated":true,"content_free":true}\\n' "$OLYMPUS_SOURCE_EMBEDDING_DRAIN_INSTANCE_ID" "$$" > "$OLYMPUS_SOURCE_EMBEDDING_DRAIN_READINESS_PATH"` : ''}
trap 'exit 0' TERM INT
while :; do sleep 1; done
`;
}

function readStarts(path: string): Array<{ pid: number; args: string[]; env: Record<string, string> }> {
  try {
    const names = fixtureEnvNames();
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [pid, ...values] = line.split('\t');
      return {
        pid: Number(pid),
        args: values.slice(0, 4),
        env: Object.fromEntries(names.flatMap((name, index) => {
          const value = values[index + 4];
          return value ? [[name, value]] : [];
        })),
      };
    });
  } catch {
    return [];
  }
}

function fixtureEnvNames(): string[] {
  return [
    'OLYMPUS_CONFIG',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_PROTECTED_TELEGRAM_DB_PATH',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_ENABLED',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_MODE',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_INTERNAL_TELEGRAM_ENABLED',
    'OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL',
    'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY',
    'GEMINI_API_KEY',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_INSTANCE_ID',
    'OLYMPUS_WORKER_AUTH_TOKEN',
    'OP_CONNECT_TOKEN',
    'UNRELATED_VALUE',
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
