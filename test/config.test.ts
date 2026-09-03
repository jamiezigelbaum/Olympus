import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { configFromPluginConfig, defaultConfig, loadConfig, parseBoolean, parseLane, parseModelProfile } from '../src/core/config.ts';

describe('config', () => {
  test('parses canonical boolean env vocabulary with trim and case normalization', () => {
    expect(parseBoolean(' true ', 'TEST_FLAG')).toBe(true);
    expect(parseBoolean('True', 'TEST_FLAG')).toBe(true);
    expect(parseBoolean('1', 'TEST_FLAG')).toBe(true);
    expect(parseBoolean(' false ', 'TEST_FLAG')).toBe(false);
    expect(parseBoolean('No', 'TEST_FLAG')).toBe(false);
    expect(() => parseBoolean('garbage', 'TEST_FLAG')).toThrow('TEST_FLAG must be true or false');
  });

  test('requires a non-empty, valid source allowlist when the worker scheduler is enabled', () => {
    expect(() => loadConfig({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_WORKER_SCHEDULER_ENABLED: 'true',
    })).toThrow('worker.scheduler.sourceIds must contain at least one source');
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
          sourceIds: ['domain_library.agent_library'],
        },
      },
    })).toThrow('sourceIds entries must be one of');
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
    expect(config.email.enabled).toBe(false);
    expect(config.email.baseUrl).toBe('http://127.0.0.1:8010/v1');
    expect(config.email.requireLocalActiveModelForPrivateTools).toBe(false);
    expect(config.worker.authToken).toBeUndefined();
    expect(config.sourceIndex.enabled).toBe(true);
    expect(config.worker.scheduler).toMatchObject({
      enabled: false,
      sourceIds: [],
      maxTransientRetries: 3,
      freshnessThresholdHours: 26,
    });
    expect(config.sourceIndex.answerDevEnabled).toBe(false);
    expect(config.fileDelivery.enabled).toBe(false);
    expect(config.fileDelivery.baseUrl).toBe('http://127.0.0.1:8020/v1');
    expect(config.domainExpert.enabled).toBe(false);
    expect(config.domainExpert.liveToolsEnabled).toBe(false);
    expect(config.domainExpert.baseUrl).toBe('http://127.0.0.1:8040/v1');
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
      OLYMPUS_FILE_DELIVERY_ENABLED: 'true',
      OLYMPUS_FILE_DELIVERY_BASE_URL: 'http://xanthos-delivery.test/v1/',
      OLYMPUS_FILE_DELIVERY_REQUEST_TIMEOUT_SECONDS: '45',
      OLYMPUS_DOMAIN_EXPERT_ENABLED: 'true',
      OLYMPUS_DOMAIN_EXPERT_LIVE_TOOLS_ENABLED: 'true',
      OLYMPUS_DOMAIN_EXPERT_BASE_URL: 'http://domain-expert.test/v1/',
      OLYMPUS_DOMAIN_EXPERT_REQUEST_TIMEOUT_SECONDS: '90',
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
    expect(config.fileDelivery.enabled).toBe(true);
    expect(config.fileDelivery.baseUrl).toBe('http://xanthos-delivery.test/v1');
    expect(config.fileDelivery.requestTimeoutSeconds).toBe(45);
    expect(config.domainExpert.enabled).toBe(true);
    expect(config.domainExpert.liveToolsEnabled).toBe(true);
    expect(config.domainExpert.baseUrl).toBe('http://domain-expert.test/v1');
    expect(config.domainExpert.requestTimeoutSeconds).toBe(90);
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
        requireLocalActiveModelForPrivateTools: true,
      },
      sourceIndex: {
        enabled: false,
        answerDevEnabled: true,
      },
      fileDelivery: {
        enabled: true,
        baseUrl: 'http://xanthos-delivery.test/v1/',
        requestTimeoutSeconds: 45,
      },
      domainExpert: {
        enabled: true,
        liveToolsEnabled: true,
        baseUrl: 'http://domain-expert.test/v1/',
        requestTimeoutSeconds: 90,
      },
      worker: {
        authToken: 'plugin-worker-secret',
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
      localPacketsDevEnabled: false,
      indexAdminDevEnabled: false,
      requireLocalActiveModelForPrivateTools: true,
    });
    expect(config.sourceIndex.enabled).toBe(false);
    expect(config.sourceIndex.answerDevEnabled).toBe(true);
    expect(config.fileDelivery).toEqual({
      enabled: true,
      baseUrl: 'http://xanthos-delivery.test/v1',
      requestTimeoutSeconds: 45,
    });
    expect(config.domainExpert).toEqual({
      enabled: true,
      liveToolsEnabled: true,
      baseUrl: 'http://domain-expert.test/v1',
      requestTimeoutSeconds: 90,
    });
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

  test('treats the live domain-expert tool gate as inert when the worker is disabled', () => {
    const config = loadConfig({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_DOMAIN_EXPERT_LIVE_TOOLS_ENABLED: 'true',
    });

    expect(config.domainExpert.enabled).toBe(false);
    expect(config.domainExpert.liveToolsEnabled).toBe(true);
  });

  test('keeps local email source packets disabled unless explicitly gated', () => {
    const config = loadConfig({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_ENABLE_UNGUARDED_LOCAL_EMAIL_PACKETS_FOR_DEV: 'true',
    });

    expect(config.email.localPacketsDevEnabled).toBe(true);
  });

  test('loads the private native tool active-model guard from env', () => {
    const config = loadConfig({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_REQUIRE_LOCAL_ACTIVE_MODEL_FOR_PRIVATE_EMAIL_TOOLS: 'true',
    });

    expect(config.email.requireLocalActiveModelForPrivateTools).toBe(true);
  });

  test('loads source-index answer dev gate from env', () => {
    const config = loadConfig({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_SOURCE_INDEX_ANSWER_DEV_ENABLED: 'true',
    });

    expect(config.sourceIndex.answerDevEnabled).toBe(true);
  });

  test('rejects non-boolean JSON proof gates instead of treating string false as enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-config-test-'));
    const path = join(dir, 'config.json');
    try {
      writeFileSync(path, JSON.stringify({
        email: {
          localPacketsDevEnabled: 'false',
        },
      }));

      expect(() => loadConfig({ OLYMPUS_CONFIG: path })).toThrow('email.localPacketsDevEnabled must be a boolean');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
