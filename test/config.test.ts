import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  configFromPluginConfig,
  configWithEnvironmentOverrides,
  defaultConfig,
  loadConfig,
  parseBoolean,
  parseLane,
  parseModelProfile,
} from '../src/core/config.ts';
import { workerAuthTokenFromConfig } from '../src/core/worker-auth.ts';

describe('config', () => {
  test('opaque explicit worker refs never inherit ambient credentials in inspection mode', () => {
    const config = configFromPluginConfig({ worker: { authToken: { source: 'file', provider: 'fixture', id: '/worker' }, service: { enabled: true } } }, { requireResolvedWorkerSecrets: false });
    expect(config.worker.authTokenSecretRefUnresolved).toBe(true);
    expect(workerAuthTokenFromConfig(config, { env: { OLYMPUS_WORKER_AUTH_TOKEN: 'ambient' } })).toBeUndefined();
  });
  test('parses canonical boolean env vocabulary with trim and case normalization', () => {
    expect(parseBoolean(' true ', 'TEST_FLAG')).toBe(true);
    expect(parseBoolean('True', 'TEST_FLAG')).toBe(true);
    expect(parseBoolean('1', 'TEST_FLAG')).toBe(true);
    expect(parseBoolean(' false ', 'TEST_FLAG')).toBe(false);
    expect(parseBoolean('No', 'TEST_FLAG')).toBe(false);
    expect(() => parseBoolean('garbage', 'TEST_FLAG')).toThrow('TEST_FLAG must be true or false');
  });

  test('accepts an enabled worker scheduler with no selected sources and still rejects invalid ids', () => {
    // olympus setup installs the worker BEFORE the first source is connected,
    // so an enabled scheduler with an empty allowlist is the normal state of a
    // fresh install. Refusing it here made every fresh install fail to boot.
    const fresh = loadConfig({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_WORKER_SCHEDULER_ENABLED: 'true',
    });
    expect(fresh.worker.scheduler.enabled).toBe(true);
    expect(fresh.worker.scheduler.sourceIds).toEqual([]);
    expect(configFromPluginConfig({
      worker: { scheduler: { enabled: true, sourceIds: [] } },
    }).worker.scheduler.sourceIds).toEqual([]);
    expect(() => loadConfig({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_WORKER_SCHEDULER_ENABLED: 'true',
      OLYMPUS_WORKER_SCHEDULER_SOURCE_IDS: 'x.bookmarks,not allowed!',
    })).toThrow('sourceIds entries must be one of');
    expect(() => configFromPluginConfig({
      worker: {
        scheduler: {
          enabled: true,
          sourceIds: ['not allowed!'],
        },
      },
    })).toThrow('sourceIds entries must be one of');
    expect(() => configFromPluginConfig({
      worker: {
        scheduler: {
          enabled: true,
          sourceIds: ['unknown.source_id'],
        },
      },
    })).toThrow('sourceIds entries must be one of');
    expect(loadConfig({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_WORKER_SCHEDULER_SOURCE_IDS: '',
    }).worker.scheduler.sourceIds).toEqual([]);
  });

  test('defaults to one Delphi model pool with legacy lane aliases', () => {
    const config = defaultConfig();

    expect(config.argus.defaultLane).toBe('fast');
    expect(config.identity).toEqual({
      ownerName: 'the owner',
      assistantName: 'the calling assistant',
    });
    expect(config.argus.defaultProfile).toBe('default_chat');
    expect(config.argus.transport).toBe('direct');
    // The Delphi consumer contract: profiles at the router, never backing
    // model ids (docs/reference/delphi-consumer-contract.md). The stale-model
    // bug of 2026-08-19 was these defaults naming retired models.
    expect(config.argus.lanes.fast.baseUrl).toBe('http://127.0.0.1:28090/v1');
    expect(config.argus.lanes.deep.baseUrl).toBe('http://127.0.0.1:28090/v1');
    expect(config.argus.lanes.fast.model).toBe('delphi/default-chat');
    expect(config.argus.lanes.deep.model).toBe('delphi/default-chat');
    expect(config.argus.modelProfiles.default_chat.model).toBe('delphi/default-chat');
    expect(config.argus.modelProfiles.source_answer.model).toBe('delphi/source-answer');
    expect(config.argus.modelProfiles.classification_fast).toMatchObject({
      baseUrl: 'http://127.0.0.1:28090/v1',
      model: 'delphi/default-chat',
      purpose: 'classification',
    });
    // Deliberate exception for the MODEL ID only: it is pinned inside the
    // epoch string. The base URL rides the router like every other lane
    // (28011 tunnel forward retired 2026-08-20, vector parity proven).
    expect(config.argus.modelProfiles.embedding_secure_local).toMatchObject({
      baseUrl: 'http://127.0.0.1:28090/v1',
      model: 'secure-local-qwen3-embed',
      purpose: 'embedding',
    });
    expect(config.argus.modelProfiles.vlm_document).toMatchObject({
      baseUrl: 'http://127.0.0.1:28090/v1',
      model: 'delphi/vision-quality',
      purpose: 'vision',
    });
    expect(config.argus.modelProfiles.vlm_qwen36_27b).toMatchObject({
      baseUrl: 'http://127.0.0.1:28090/v1',
      model: 'delphi/vision-deep',
      purpose: 'vision',
    });
    expect(config.argus.modelProfiles.vlm_qwen36_35b).toMatchObject({
      baseUrl: 'http://127.0.0.1:28090/v1',
      model: 'delphi/vision-quality',
      purpose: 'vision',
    });
    expect(config.argus.modelProfiles.vlm_fast).toMatchObject({
      baseUrl: 'http://127.0.0.1:28090/v1',
      model: 'delphi/vision-fast',
      purpose: 'vision',
    });
    // The worker is installed by every preset, so the honest default is on:
    // a fresh install must fail with "worker not reachable", never with
    // "private source worker is disabled" and no command to fix it.
    expect(config.email.enabled).toBe(true);
    expect(config.email.baseUrl).toBe('http://127.0.0.1:8010/v1');
    expect(config.worker.authToken).toBeUndefined();
    expect(config.worker.service).toEqual({ enabled: false, startupTimeoutSeconds: 180, credentials: {} });
    expect(config.sourceIndex.enabled).toBe(true);
    expect(config.worker.scheduler).toMatchObject({
      enabled: false,
      sourceIds: [],
      maxTransientRetries: 3,
      freshnessThresholdHours: 26,
    });
  });

  test('environment overrides lane config', () => {
    const config = loadConfig({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_ARGUS_DEFAULT_LANE: 'deep',
      OLYMPUS_ARGUS_DEFAULT_PROFILE: 'source_answer',
      OLYMPUS_ARGUS_TRANSPORT: 'direct',
      OLYMPUS_ARGUS_FAST_BASE_URL: 'http://example.test/v1/',
      OLYMPUS_ARGUS_FAST_MODEL: 'local-test-model',
      OLYMPUS_ARGUS_SOURCE_ANSWER_BASE_URL: 'http://model-pool.test/v1/',
      OLYMPUS_ARGUS_SOURCE_ANSWER_MODEL: 'source-answer-model',
      OLYMPUS_ARGUS_VLM_QWEN36_27B_BASE_URL: 'http://qwen27-vlm.test/v1/',
      OLYMPUS_ARGUS_VLM_QWEN36_27B_MODEL: 'qwen27-vlm-model',
      OLYMPUS_EMAIL_ENABLED: 'true',
      OLYMPUS_EMAIL_BASE_URL: 'http://email.test/v1/',
      OLYMPUS_SOURCE_INDEX_ENABLED: 'false',
      OLYMPUS_WORKER_AUTH_TOKEN: ' shared-worker-secret ',
      OLYMPUS_WORKER_SCHEDULER_ENABLED: 'true',
      OLYMPUS_WORKER_SCHEDULER_SOURCE_IDS: 'x.bookmarks',
      OLYMPUS_WORKER_SCHEDULER_SYNC_INTERVAL_SECONDS: '120',
      OLYMPUS_WORKER_SCHEDULER_FRESHNESS_THRESHOLD_HOURS: '4',
    });

    expect(config.worker.authToken).toBe('shared-worker-secret');
    expect(config.worker.scheduler.enabled).toBe(true);
    expect(config.worker.scheduler.sourceIds).toEqual(['x.bookmarks']);
    expect(config.worker.scheduler.syncIntervalSeconds).toBe(120);
    expect(config.worker.scheduler.freshnessThresholdHours).toBe(4);
    expect(config.argus.defaultLane).toBe('deep');
    expect(config.argus.defaultProfile).toBe('source_answer');
    expect(config.argus.transport).toBe('direct');
    expect(config.argus.lanes.fast.baseUrl).toBe('http://example.test/v1');
    expect(config.argus.lanes.fast.model).toBe('local-test-model');
    expect(config.argus.modelProfiles.source_answer.baseUrl).toBe('http://model-pool.test/v1');
    expect(config.argus.modelProfiles.source_answer.model).toBe('source-answer-model');
    expect(config.argus.modelProfiles.vlm_qwen36_27b.baseUrl).toBe('http://qwen27-vlm.test/v1');
    expect(config.argus.modelProfiles.vlm_qwen36_27b.model).toBe('qwen27-vlm-model');
    expect(config.email.enabled).toBe(true);
    expect(config.email.baseUrl).toBe('http://email.test/v1');
    expect(config.sourceIndex.enabled).toBe(false);
  });

  test('normalizes source-worker base URLs at file and env ingest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-source-worker-config-test-'));
    const path = join(dir, 'config.json');
    try {
      writeFileSync(path, JSON.stringify({
        email: {
          baseUrl: 'http://file-worker.test/',
        },
      }));

      expect(loadConfig({ OLYMPUS_CONFIG: path }).email.baseUrl).toBe('http://file-worker.test/v1');
      expect(loadConfig({
        OLYMPUS_CONFIG: path,
        OLYMPUS_EMAIL_BASE_URL: 'http://env-worker.test',
      }).email.baseUrl).toBe('http://env-worker.test/v1');
      expect(loadConfig({
        OLYMPUS_CONFIG: path,
        OLYMPUS_EMAIL_BASE_URL: 'http://env-worker.test/custom/',
      }).email.baseUrl).toBe('http://env-worker.test/custom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects unsupported lanes', () => {
    expect(() => parseLane('medium')).toThrow('Unsupported Argus lane');
  });

  test('rejects unsupported model profiles', () => {
    expect(() => parseModelProfile('deep')).toThrow('Unsupported Argus model profile');
  });

  test('loads nested plugin email config', () => {
    const config = configFromPluginConfig({
      identity: {
        ownerName: 'Alex',
        assistantName: 'Athena',
      },
      argus: {
        lanes: {
          fast: {
            secretRef: 'env:ARGUS_FAST_API_KEY',
          },
        },
        modelProfiles: {
          source_answer: {
            secretRef: 'store:argus.source_answer.api_key',
          },
          vlm_document: {
            baseUrl: 'http://qwen27-vlm.plugin.test/v1/',
            model: 'plugin-qwen27-vlm',
            purpose: 'vision',
          },
        },
      },
      email: {
        enabled: true,
        baseUrl: 'http://email-lane.test/v1/',
        requestTimeoutSeconds: 60,
      },
      sourceIndex: {
        enabled: false,
      },
      worker: {
        authToken: 'plugin-worker-secret',
        service: {
          enabled: true,
          startupTimeoutSeconds: 240,
          credentials: {
            OLYMPUS_CREDENTIAL_FIXTURE: 'synthetic-credential',
          },
          runtimePath: '/opt/bun/bin/bun',
          executablePath: '/opt/openclaw/plugins/olympus/dist/cli.js',
        },
        scheduler: {
          enabled: true,
          sourceIds: ['x.bookmarks'],
          tickSeconds: 5,
          syncIntervalSeconds: 300,
          freshnessThresholdHours: 8,
          errorBackoffSeconds: 10,
          maxTransientRetries: 2,
        },
      },
    });

    expect(config.worker.authToken).toBe('plugin-worker-secret');
    expect(config.worker.service).toEqual({
      enabled: true,
      startupTimeoutSeconds: 240,
      credentials: {
        OLYMPUS_CREDENTIAL_FIXTURE: 'synthetic-credential',
      },
      runtimePath: '/opt/bun/bin/bun',
      executablePath: '/opt/openclaw/plugins/olympus/dist/cli.js',
    });
    expect(config.worker.scheduler).toMatchObject({
      enabled: true,
      sourceIds: ['x.bookmarks'],
      tickSeconds: 5,
      syncIntervalSeconds: 300,
      freshnessThresholdHours: 8,
      errorBackoffSeconds: 10,
      maxTransientRetries: 2,
    });
    expect(config.identity).toEqual({
      ownerName: 'Alex',
      assistantName: 'Athena',
    });
    expect(config.argus.modelProfiles.vlm_document).toMatchObject({
      baseUrl: 'http://qwen27-vlm.plugin.test/v1',
      model: 'plugin-qwen27-vlm',
      purpose: 'vision',
    });
    expect(config.argus.lanes.fast.secretRef).toBe('env:ARGUS_FAST_API_KEY');
    expect(config.argus.modelProfiles.source_answer.secretRef).toBe('store:argus.source_answer.api_key');
    expect(config.email).toEqual({
      enabled: true,
      baseUrl: 'http://email-lane.test/v1',
      requestTimeoutSeconds: 60,
    });
    expect(config.sourceIndex.enabled).toBe(false);
  });

  test('rejects a private-lane timeout above the 600s Gateway ceiling', () => {
    expect(configFromPluginConfig({ email: { requestTimeoutSeconds: 600 } }).email.requestTimeoutSeconds).toBe(600);
    expect(() => configFromPluginConfig({ email: { requestTimeoutSeconds: 900 } }))
      .toThrow('email.requestTimeoutSeconds must be at most 600.');
    expect(() => configFromPluginConfig({ email: { requestTimeoutSeconds: 601 } }))
      .toThrow('email.requestTimeoutSeconds must be at most 600.');
  });

  test('normalizes source-worker base URLs from plugin config', () => {
    expect(configFromPluginConfig({
      email: { baseUrl: 'http://source-worker.test' },
    }).email.baseUrl).toBe('http://source-worker.test/v1');

    expect(configFromPluginConfig({
      email: { baseUrl: 'http://source-worker.test/v1' },
    }).email.baseUrl).toBe('http://source-worker.test/v1');

    expect(configFromPluginConfig({
      email: { baseUrl: 'http://source-worker.test/custom/' },
    }).email.baseUrl).toBe('http://source-worker.test/custom');
  });

  test('rejects a non-boolean JSON toggle instead of treating string false as enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-config-test-'));
    const path = join(dir, 'config.json');
    try {
      writeFileSync(path, JSON.stringify({
        email: {
          enabled: 'false',
        },
      }));

      expect(() => loadConfig({ OLYMPUS_CONFIG: path }))
        .toThrow('email.enabled must be a boolean');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects relative native worker service paths', () => {
    expect(() => configFromPluginConfig({
      worker: { service: { enabled: true, runtimePath: 'bin/bun' } },
    })).toThrow('worker.service.runtimePath must be an absolute path.');
    expect(() => configFromPluginConfig({
      worker: { service: { enabled: true, executablePath: 'dist/cli.js' } },
    })).toThrow('worker.service.executablePath must be an absolute path.');
  });

  test('bounds the native worker startup readiness deadline', () => {
    expect(configFromPluginConfig({
      worker: { service: { startupTimeoutSeconds: 600 } },
    }).worker.service.startupTimeoutSeconds).toBe(600);
    expect(() => configFromPluginConfig({
      worker: { service: { startupTimeoutSeconds: 601 } },
    })).toThrow('worker.service.startupTimeoutSeconds must be at most 600.');
    expect(() => configFromPluginConfig({
      worker: { service: { startupTimeoutSeconds: 0 } },
    })).toThrow('worker.service.startupTimeoutSeconds must be greater than zero.');
  });

  test('accepts only approved resolved native worker credential environment names', () => {
    expect(configFromPluginConfig({
      worker: {
        service: {
          enabled: true,
          credentials: {
            OLYMPUS_CREDENTIAL_CUSTOM_PROVIDER: 'custom-secret',
            OLYMPUS_SOURCE_INDEX_READWISE_TOKEN: 'readwise-secret',
            GEMINI_API_KEY: 'gemini-secret',
          },
        },
      },
    }).worker.service.credentials).toEqual({
      OLYMPUS_CREDENTIAL_CUSTOM_PROVIDER: 'custom-secret',
      OLYMPUS_SOURCE_INDEX_READWISE_TOKEN: 'readwise-secret',
      GEMINI_API_KEY: 'gemini-secret',
    });

    for (const name of ['OP_CONNECT_TOKEN', 'LD_PRELOAD']) {
      expect(() => configFromPluginConfig({
        worker: { service: { credentials: { [name]: 'forbidden' } } },
      })).toThrow(`worker.service.credentials does not allow environment name ${name}.`);
    }
  });

  test('fails closed when Gateway leaves a native worker credential unresolved', () => {
    expect(() => configFromPluginConfig({
      worker: {
        service: {
          enabled: true,
          credentials: {
            OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY: {
              source: 'env',
              provider: 'default',
              id: 'GEMINI_API_KEY',
            },
          },
        },
      },
    })).toThrow(
      'worker.service.credentials.OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY must be resolved to a string',
    );
    expect(() => configFromPluginConfig({
      worker: {
        authToken: { source: 'env', provider: 'default', id: 'OLYMPUS_WORKER_AUTH_TOKEN' },
        service: { enabled: true },
      },
    })).toThrow('worker.authToken must be resolved to a string');
  });

  test('native explicit sovereignty path overrides stale inline file policy only for managed children', () => {
    const configured = configFromPluginConfig({
      sovereignty: { policy: { schemaVersion: 1 } },
    });
    const standalone = configWithEnvironmentOverrides(configured, {
      OLYMPUS_SOVEREIGNTY_CONFIG_PATH: '/private/tmp/nonexistent-policy.json',
    });
    expect(standalone.sovereignty?.policy).toBeDefined();

    const native = configWithEnvironmentOverrides(configured, {
      OLYMPUS_NATIVE_SERVICE_INSTANCE_ID: '019f6ff4-2fb0-70a3-91dd-3ef3ada9354f',
      OLYMPUS_SOVEREIGNTY_CONFIG_PATH: '/private/tmp/nonexistent-policy.json',
    });
    expect(native.sovereignty).toEqual({
      configPath: '/private/tmp/nonexistent-policy.json',
    });
  });
});
