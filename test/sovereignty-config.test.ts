import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { OperationError } from '../src/core/operation-error.ts';
import type { Analyst, AnalystOptions, AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import type { LocalContentProviderMap } from '../src/core/evidence-pack.ts';
import {
  SOVEREIGNTY_PRESETS,
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
  loadSovereigntyEngine,
  loadSovereigntyPreset,
  sovereigntyRoutingSnapshot,
  writeSovereigntyConfigFile,
  type SovereigntyConfig,
  type SovereigntyTrustDomainPolicy,
} from '../src/core/sovereignty.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import type {
  SourceIndexCorpusSearchAdapter,
  SourceIndexRouterAdapterMap,
} from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  createAnalystSourceIndexAnswerHandler,
  type SovereigntyAnalystRouteStep,
} from '../src/workers/source-index/analyst-answer.ts';
import { createAnalystForSovereigntyProfile } from '../src/workers/email-source/server.ts';
import { setupPreflight } from '../src/core/setup-preflight.ts';
import { inspectSovereigntyConfigDrift } from '../scripts/sovereignty-drift-check.ts';

const INTERNAL = 'internal.test.notes';
const SECURE = 'secure_local.test.files';

describe('sovereignty config engine', () => {
  test('an explicitly requested missing policy file fails closed before the env bridge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-sovereignty-missing-policy-'));
    try {
      expect(() => loadSovereigntyEngine({
        configPath: join(dir, 'missing-sovereignty.json'),
        env: {
          OLYMPUS_SOURCE_INDEX_VENICE_API_KEY: 'fixture-key',
          OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_MODEL: 'kimi-k3',
        },
      })).toThrow(expect.objectContaining({
        code: 'config_error',
        message: expect.stringContaining('does not exist'),
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preset registry exposes the four posture choices in presentation order', () => {
    expect(SOVEREIGNTY_PRESETS).toEqual([
      'local-first',
      'local-only',
      'private-cloud-only',
      'no-sensitive',
    ]);
  });

  test('invariant: config cannot route secure_local to cloud analyst profiles', () => {
    const config = baseConfig({
      modelProfiles: {
        venice_private: {
          provider: 'venice',
          trust: 'encrypted_cloud',
          model: 'zai-org-glm-5-2',
          secretRef: 'env:VENICE_API_KEY',
          purpose: 'analyst',
        },
      },
      routes: {
        secure_local: { analyst: ['cloud'] },
        internal: { analyst: ['cloud'] },
        public_safe: { analyst: ['cloud'] },
      },
    });

    expect(() => createSovereigntyEngine(config)).toThrow('secure_local cannot route to standard_cloud');

    // OWNER DECISION (2026-07-02): encrypted_cloud (Venice) is an approved
    // secure_local analyst lane; only standard_cloud is banned.
    expect(() => createSovereigntyEngine({
      ...config,
      routes: {
        secure_local: { analyst: ['venice_private'] },
        internal: { analyst: ['cloud'] },
        public_safe: { analyst: ['cloud'] },
      },
    })).not.toThrow();
  });

  test('invariant: config cannot cloud-embed secure_local, including encrypted_cloud embedding', () => {
    const standardCloud = baseConfig({
      retrieval: {
        trustDomains: {
          secure_local: {
            minimumExecutionTrust: 'local',
            allowedEmbeddingTrust: ['local', 'standard_cloud'],
            embeddingProfile: 'cloud-embedding',
            allowCloudQuery: false,
          },
          internal: internalPolicy('cloud-embedding'),
          public_safe: internalPolicy('cloud-embedding'),
        },
      },
    });
    expect(() => createSovereigntyEngine(standardCloud)).toThrow('secure_local embeddings may only use local trust');

    const encryptedCloud = baseConfig({
      modelProfiles: {
        encrypted_embedding: {
          provider: 'venice',
          trust: 'encrypted_cloud',
          model: 'private-embedding',
          secretRef: 'env:VENICE_API_KEY',
          purpose: 'embedding',
        },
      },
      retrieval: {
        trustDomains: {
          secure_local: {
            minimumExecutionTrust: 'local',
            allowedEmbeddingTrust: ['local', 'encrypted_cloud'],
            embeddingProfile: 'encrypted_embedding',
            allowCloudQuery: false,
          },
          internal: internalPolicy('cloud-embedding'),
          public_safe: internalPolicy('cloud-embedding'),
        },
      },
    });
    expect(() => createSovereigntyEngine(encryptedCloud)).toThrow('secure_local embeddings may only use local trust');
  });

  test('invariant: S5 remains hard-denied regardless of config', () => {
    const engine = createSovereigntyEngine(baseConfig());

    expect(() => engine.assertTrustTierAllowed('S5')).toThrow('S5 source material is hard-denied');
  });

  test('schema rejects inline secrets in model profiles', () => {
    const config = baseConfig({
      modelProfiles: {
        bad_secret_profile: {
          provider: 'venice',
          trust: 'encrypted_cloud',
          model: 'e2ee-glm-5-2-p',
          apiKey: 'raw-secret',
          purpose: 'analyst',
        } as never,
      },
    });

    expect(() => createSovereigntyEngine(config)).toThrow('must not contain inline secrets');
  });

  test('schema rejects remote profiles that claim local trust', () => {
    expect(() => createSovereigntyEngine(baseConfig({
      modelProfiles: {
        spoofed_local: {
          provider: 'anthropic',
          trust: 'local',
          model: 'claude-remote',
          secretRef: 'env:ANTHROPIC_API_KEY',
          purpose: 'analyst',
        },
      },
      routes: {
        secure_local: { analyst: ['spoofed_local'] },
        internal: { analyst: ['cloud', 'local'] },
        public_safe: { analyst: ['cloud', 'local'] },
      },
    }))).toThrow('cannot claim local trust with provider "anthropic"');

    expect(() => createSovereigntyEngine(baseConfig({
      modelProfiles: {
        remote_local: {
          provider: 'local-openai-compatible',
          trust: 'local',
          baseUrl: 'https://api.example.test/v1',
          model: 'remote-local-looking-model',
          purpose: 'analyst',
        },
      },
      routes: {
        secure_local: { analyst: ['remote_local'] },
        internal: { analyst: ['cloud', 'local'] },
        public_safe: { analyst: ['cloud', 'local'] },
      },
    }))).toThrow('baseUrl must stay on loopback');
  });

  test('schema accepts store-backed secretRef values', () => {
    const config = baseConfig({
      modelProfiles: {
        venice_private: {
          provider: 'venice',
          trust: 'encrypted_cloud',
          model: 'e2ee-glm-5-2-p',
          secretRef: 'store:venice.api_key',
          purpose: 'analyst',
        },
      },
      routes: {
        secure_local: { analyst: ['local'] },
        internal: { analyst: ['venice_private', 'cloud'] },
        public_safe: { analyst: ['cloud'] },
      },
    });

    const engine = createSovereigntyEngine(config);

    expect(engine.config.modelProfiles.venice_private?.secretRef).toBe('store:venice.api_key');
  });

  test('invariant: empty fallback chain is rejected unless explicitly disabled', () => {
    const config = baseConfig({
      routes: {
        secure_local: { analyst: ['local'] },
        internal: { analyst: [] },
        public_safe: { analyst: ['cloud'] },
      },
    });

    expect(() => createSovereigntyEngine(config)).toThrow('sovereignty.routes.internal.pool.members must not be empty');
  });

  test('secure pool distinguishes equal members from explicit order and preserves legacy lists', () => {
    const equal = createSovereigntyEngine(baseConfig({
      modelProfiles: {
        venice_private: {
          provider: 'venice',
          trust: 'encrypted_cloud',
          model: 'zai-org-glm-5-2',
          secretRef: 'env:VENICE_API_KEY',
          purpose: 'analyst',
        },
      },
      routes: {
        secure_local: {
          pool: { members: ['venice_private', 'local'] },
        },
        internal: { analyst: ['cloud', 'local'] },
        public_safe: { analyst: ['cloud', 'local'] },
      },
    }));
    const ordered = createSovereigntyEngine(baseConfig({
      modelProfiles: {
        venice_private: {
          provider: 'venice',
          trust: 'encrypted_cloud',
          model: 'zai-org-glm-5-2',
          secretRef: 'env:VENICE_API_KEY',
          purpose: 'analyst',
        },
      },
      routes: {
        secure_local: {
          pool: {
            members: ['local', 'venice_private'],
            order: ['venice_private', 'local'],
          },
        },
        internal: { analyst: ['cloud', 'local'] },
        public_safe: { analyst: ['cloud', 'local'] },
      },
    }));
    const legacy = createSovereigntyEngine(baseConfig({
      modelProfiles: {
        venice_private: {
          provider: 'venice',
          trust: 'encrypted_cloud',
          model: 'zai-org-glm-5-2',
          secretRef: 'env:VENICE_API_KEY',
          purpose: 'analyst',
        },
      },
      routes: {
        secure_local: { analyst: ['venice_private', 'local'] },
        internal: { analyst: ['cloud', 'local'] },
        public_safe: { analyst: ['cloud', 'local'] },
      },
    }));

    expect(equal.resolveAnalystPool({ trustDomain: 'secure_local' })).toMatchObject({
      members: [{ id: 'venice_private' }, { id: 'local' }],
    });
    expect(equal.resolveAnalystPool({ trustDomain: 'secure_local' }).explicitOrder).toBeUndefined();
    expect(ordered.resolveAnalystPool({ trustDomain: 'secure_local' }).explicitOrder?.map((entry) => entry.id)).toEqual([
      'venice_private',
      'local',
    ]);
    expect(legacy.resolveAnalystPool({ trustDomain: 'secure_local' }).explicitOrder?.map((entry) => entry.id)).toEqual([
      'venice_private',
      'local',
    ]);
  });

  test('secure pool rejects E2EE ids and unapproved encrypted-cloud providers with typed policy errors', () => {
    try {
      createSovereigntyEngine(baseConfig({
        modelProfiles: {
          venice_e2ee: {
            provider: 'venice',
            trust: 'encrypted_cloud',
            model: 'e2ee-glm-5-2-p',
            secretRef: 'env:VENICE_API_KEY',
            purpose: 'analyst',
          },
        },
        routes: {
          secure_local: { pool: { members: ['venice_e2ee'] } },
          internal: { analyst: ['cloud'] },
          public_safe: { analyst: ['cloud'] },
        },
      }));
      throw new Error('expected E2EE secure-pool refusal');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'SecureAnalystPoolE2EEGateError',
        code: 'source_index_policy_violation',
        profileId: 'venice_e2ee',
        modelId: 'e2ee-glm-5-2-p',
      });
    }

    expect(() => createSovereigntyEngine(baseConfig({
      modelProfiles: {
        unapproved_encrypted: {
          provider: 'anthropic',
          trust: 'encrypted_cloud',
          model: 'remote-model',
          secretRef: 'env:ANTHROPIC_API_KEY',
          purpose: 'analyst',
        },
      },
      routes: {
        secure_local: { pool: { members: ['unapproved_encrypted'] } },
        internal: { analyst: ['cloud'] },
        public_safe: { analyst: ['cloud'] },
      },
    }))).toThrow('secure_local cannot route to encrypted_cloud');
  });

  test('no-sensitive secure route validates as explicit metadata-only disabled and fails closed at use time', () => {
    const engine = createSovereigntyEngine(loadSovereigntyPreset('no-sensitive'));

    expect(() => engine.resolveAnalystRoute({ trustDomain: 'secure_local' })).toThrow('route for secure_local is disabled');
  });

  test('preset routing: local-first uses local secure lane with Venice second and cloud ordinary lanes', () => {
    const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));

    expect(engine.resolveAnalystRoute({ trustDomain: 'secure_local' }).map((entry) => entry.id)).toEqual([
      'local-source-answer',
      'venice-private',
    ]);
    expect(engine.config.modelProfiles['venice-private']?.secretRef).toBe('store:venice.api_key');
    expect(engine.resolveAnalystRoute({ trustDomain: 'internal' }).map((entry) => entry.id)).toEqual([
      'cloud-openclaw-infer',
      'local-source-answer',
    ]);
    expect(engine.resolveEmbeddingProfile('secure_local')?.id).toBe('local-source-embedding');
    expect(engine.resolveEmbeddingProfile('internal')?.id).toBe('gemini-source-embedding');
  });

  test('preset routing: local-only serves secure_local through the local lane only', () => {
    const engine = createSovereigntyEngine(loadSovereigntyPreset('local-only'));

    expect(engine.config.modelProfiles['venice-private']).toBeUndefined();
    expect(engine.resolveAnalystRoute({ trustDomain: 'secure_local' }).map((entry) => entry.id)).toEqual([
      'local-source-answer',
    ]);
    expect(engine.resolveEmbeddingProfile('secure_local')?.id).toBe('local-source-embedding');
    expect(engine.resolveEmbeddingProfile('internal')?.id).toBe('gemini-source-embedding');
  });

  test('preset routing: private-cloud-only serves secure_local through Venice only', () => {
    const engine = createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only'));

    expect(engine.config.modelProfiles['venice-private']?.trust).toBe('encrypted_cloud');
    expect(engine.config.modelProfiles['venice-private']?.secretRef).toBe('store:venice.api_key');
    expect(engine.config.modelProfiles['local-source-answer']).toBeUndefined();
    expect(engine.resolveAnalystRoute({ trustDomain: 'secure_local' }).map((entry) => ({
      id: entry.id,
      provider: entry.profile.provider,
      trust: entry.profile.trust,
    }))).toEqual([
      { id: 'venice-private', provider: 'venice', trust: 'encrypted_cloud' },
    ]);
    expect(engine.resolveAnalystRoute({ trustDomain: 'internal' }).map((entry) => entry.id)).toEqual([
      'cloud-openclaw-infer',
    ]);
    expect(engine.resolveEmbeddingProfile('secure_local')).toBeUndefined();
  });

  test('preset preflight: private-cloud-only produces no local model server prerequisite', async () => {
    const engine = createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only'));
    const unmet = await setupPreflight({
      config: engine.config,
      env: {},
      secretStore: { getSync: () => undefined, get: async () => undefined },
    });

    expect(unmet.map((item) => item.id)).toEqual([
      'store:venice.api_key',
      'env:GEMINI_API_KEY',
    ]);
    expect(unmet.map((item) => item.kind)).not.toContain('local_model_server');
  });

  test('private-cloud-only source_answer dispatches explicit Venice requests over secure_local packs', async () => {
    const engine = createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only'));
    const local = scriptedAnalyst('LOCAL secure answer.', 'local claim');
    const venice = scriptedAnalyst('VENICE raw answer.', 'venice claim');
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      lanes: () => lanesFixture({ secure: ['secure-1'] }),
      sovereigntyAnalystRoute: ({ localOnly, requestedProvider }) => {
        return engine.resolveAnalystRoute({
          trustDomain: localOnly ? 'secure_local' : 'internal',
          requestedProvider,
        }).map((profile): SovereigntyAnalystRouteStep => ({
          profile,
          backend: profile.profile.provider === 'venice' ? 'venice' : 'local',
          analyst: profile.profile.provider === 'venice' ? venice.analyst : local.analyst,
        }));
      },
    });

    const result = await handler.answer({
      question: 'Use Venice to summarize my secure-local file.',
      analyst_provider: 'venice',
      include_secure_local: true,
    });

    // OWNER DECISION (2026-07-06): this preset has no local fallback, so the
    // sovereignty-approved Venice step dispatches.
    expect(venice.calls).toHaveLength(1);
    expect(venice.calls[0]!.options.localOnly).toBe(true);
    expect(local.calls).toHaveLength(0);
    expect(result.answer).toContain('VENICE raw answer');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('venice');
    expect(result.audit.answer_synthesis.analyst_fallback).toBeUndefined();
  });

  test('sovereignty routes propagate Venice category refusal without walking a local fallback', async () => {
    const local = scriptedAnalyst('LOCAL must not run.', 'local claim');
    let veniceCalls = 0;
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      lanes: () => lanesFixture({ secure: ['secure-1'] }),
      sovereigntyAnalystRoute: () => [
        {
          profile: {
            id: 'venice-anonymized',
            profile: {
              provider: 'venice',
              trust: 'encrypted_cloud',
              model: 'claude-opus-4-7-fast',
              purpose: 'analyst',
            },
          },
          backend: 'venice',
          analyst: {
            async analyze() {
              veniceCalls += 1;
              throw new OperationError(
                'source_index_policy_violation',
                'Venice model category is below the secure-local floor.',
              );
            },
          },
        },
        {
          profile: {
            id: 'local',
            profile: {
              provider: 'local-openai-compatible',
              trust: 'local',
              model: 'local-model',
              purpose: 'analyst',
            },
          },
          backend: 'local',
          analyst: local.analyst,
        },
      ],
    });

    await expect(handler.answer({
      question: 'Summarize my secure-local file.',
      analyst_provider: 'venice',
      include_secure_local: true,
    })).rejects.toMatchObject({ code: 'source_index_policy_violation' });

    expect(veniceCalls).toBe(1);
    expect(local.calls).toHaveLength(0);
  });

  test('sovereignty executor skips standard-cloud secure-local steps before dispatch', async () => {
    const local = scriptedAnalyst('LOCAL stale route answer.', 'local claim');
    const cloud = scriptedAnalyst('CLOUD must not run.', 'cloud claim');
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      lanes: () => lanesFixture({ secure: ['secure-1'] }),
      sovereigntyAnalystRoute: () => [
        {
          profile: {
            id: 'stale-cloud',
            profile: {
              provider: 'openclaw-infer',
              trust: 'standard_cloud',
              model: 'gpt-5.5',
              purpose: 'analyst',
            },
          },
          backend: 'cloud',
          analyst: cloud.analyst,
        },
        {
          profile: {
            id: 'local',
            profile: {
              provider: 'local-openai-compatible',
              trust: 'local',
              model: 'local-model',
              purpose: 'analyst',
            },
          },
          backend: 'local',
          analyst: local.analyst,
        },
      ],
    });

    const result = await handler.answer({
      question: 'Summarize my secure-local file.',
      include_secure_local: true,
    });

    expect(cloud.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(1);
    expect(result.answer).toContain('LOCAL stale route answer');
    expect(result.audit.answer_synthesis.analyst_fallback).toMatchObject({
      from: 'cloud',
      to: 'local',
      reason: 'cloud_local_only',
    });
  });

  test('sovereignty executor ignores spoofed local step analysts for secure-local packs', async () => {
    const local = scriptedAnalyst('LOCAL protected answer.', 'local claim');
    const spoofedRemote = scriptedAnalyst('REMOTE must not run.', 'remote claim');
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      lanes: () => lanesFixture({ secure: ['secure-1'] }),
      sovereigntyAnalystRoute: () => [
        {
          profile: {
            id: 'spoofed-local',
            profile: {
              provider: 'anthropic',
              trust: 'local',
              model: 'claude-remote',
              purpose: 'analyst',
            },
          },
          backend: 'local',
          analyst: spoofedRemote.analyst,
        },
      ],
    });

    await expect(handler.answer({
      question: 'Summarize my secure-local file.',
      include_secure_local: true,
    })).rejects.toThrow('Sovereignty analyst fallback chain exhausted');

    expect(spoofedRemote.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(0);
  });

  test('sovereignty executor exhausts standard-cloud-only secure-local routes without dispatch', async () => {
    const local = scriptedAnalyst('LOCAL must not be used.', 'local claim');
    const cloud = scriptedAnalyst('CLOUD must not run.', 'cloud claim');
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      lanes: () => lanesFixture({ secure: ['secure-1'] }),
      sovereigntyAnalystRoute: () => [
        {
          profile: {
            id: 'stale-cloud',
            profile: {
              provider: 'openclaw-infer',
              trust: 'standard_cloud',
              model: 'gpt-5.5',
              purpose: 'analyst',
            },
          },
          backend: 'cloud',
          analyst: cloud.analyst,
        },
      ],
    });

    await expect(handler.answer({
      question: 'Summarize my secure-local file.',
      include_secure_local: true,
    })).rejects.toThrow('Sovereignty analyst fallback chain exhausted');

    expect(cloud.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(0);
  });

  test('preset routing: no-sensitive has no secure analyst or embedding lane', () => {
    const engine = createSovereigntyEngine(loadSovereigntyPreset('no-sensitive'));

    expect(() => engine.resolveAnalystRoute({ trustDomain: 'secure_local' })).toThrow('route for secure_local is disabled');
    expect(engine.resolveEmbeddingProfile('secure_local')).toBeUndefined();
    expect(engine.config.retrieval.trustDomains.secure_local?.secureHandling).toBe('metadata_only_gap');
  });

  test('golden env bridge: private-host-shaped env and generated config produce identical routing decisions', () => {
    const env = {
      OLYMPUS_ARGUS_FAST_BASE_URL: 'http://127.0.0.1:8000/v1',
      OLYMPUS_ARGUS_FAST_MODEL: 'mlx-community/Qwen3.6-35B-A3B-4bit-DWQ',
      OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
      OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
      OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER: 'google-gemini',
      OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY: 'gemini-key',
      OLYMPUS_SOURCE_INDEX_VENICE_API_KEY: 'venice-key',
      OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_MODEL: 'zai-org-glm-5-2',
    };
    const envEngine = loadSovereigntyEngine({ env });
    const generatedConfigEngine = createSovereigntyEngine(buildEnvBridgeSovereigntyConfig(env));

    expect(JSON.stringify(sovereigntyRoutingSnapshot(generatedConfigEngine))).toBe(
      JSON.stringify(sovereigntyRoutingSnapshot(envEngine)),
    );
  });

  test('env bridge cloud analyst gate fails closed on invalid boolean input', () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const config = buildEnvBridgeSovereigntyConfig({
        OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'definitely',
        OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
      });

      expect(config.modelProfiles['cloud-openclaw-infer']).toBeUndefined();
      expect(warnings.join('\n')).toContain('OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED has invalid boolean value');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('analyst routing is driven by config fallback order', async () => {
    const config = baseConfig({
      routes: {
        secure_local: { analyst: ['local'] },
        internal: { analyst: ['cloud', 'local'] },
        public_safe: { analyst: ['cloud', 'local'] },
      },
    });
    const engine = createSovereigntyEngine(config);
    const local = scriptedAnalyst('LOCAL configured fallback.', 'local claim');
    const cloud = throwingAnalyst();
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
      sovereigntyAnalystRoute: ({ localOnly, requestedProvider }) => {
        return engine.resolveAnalystRoute({
          trustDomain: localOnly ? 'secure_local' : 'internal',
          requestedProvider,
        }).map((profile): SovereigntyAnalystRouteStep => ({
          profile,
          backend: profile.id === 'cloud' ? 'cloud' : 'local',
          analyst: profile.id === 'cloud' ? cloud.analyst : local.analyst,
        }));
      },
    });

    const result = await handler.answer({ question: 'What do my notes say?' });

    expect(cloud.calls).toHaveLength(1);
    expect(local.calls).toHaveLength(1);
    expect(result.answer).toContain('LOCAL configured fallback');
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
  });

  test('analyst routing fails closed when configured fallback chain is exhausted', async () => {
    const config = baseConfig({
      routes: {
        secure_local: { analyst: ['local'] },
        internal: { analyst: ['cloud'] },
        public_safe: { analyst: ['cloud'] },
      },
    });
    const engine = createSovereigntyEngine(config);
    const local = scriptedAnalyst('LOCAL must not be used.', 'local claim');
    const cloud = throwingAnalyst();
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      lanes: () => lanesFixture({ internal: ['doc-1'] }),
      sovereigntyAnalystRoute: ({ localOnly, requestedProvider }) => {
        return engine.resolveAnalystRoute({
          trustDomain: localOnly ? 'secure_local' : 'internal',
          requestedProvider,
        }).map((profile): SovereigntyAnalystRouteStep => ({
          profile,
          backend: 'cloud',
          analyst: cloud.analyst,
        }));
      },
    });

    await expect(handler.answer({ question: 'What do my notes say?' })).rejects.toThrow(
      'Sovereignty analyst fallback chain exhausted',
    );
    expect(local.calls).toHaveLength(0);
  });

  test('no-sensitive returns an honest secure metadata-only gap without embedding or answering', async () => {
    const engine = createSovereigntyEngine(loadSovereigntyPreset('no-sensitive'));
    const local = scriptedAnalyst('LOCAL must not answer no-sensitive secure metadata.', 'local claim');
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local.analyst,
      lanes: () => lanesFixture({
        secure: ['secure-metadata-only'],
        secureChunks: [],
        secureCoverageGaps: ['secure item held as metadata-only by no-sensitive'],
      }),
      sovereigntyAnalystRoute: ({ localOnly, requestedProvider }) => {
        return engine.resolveAnalystRoute({
          trustDomain: localOnly ? 'secure_local' : 'internal',
          requestedProvider,
        }).map((profile): SovereigntyAnalystRouteStep => ({
          profile,
          backend: 'cloud',
          analyst: local.analyst,
        }));
      },
    });

    const result = await handler.answer({
      question: 'What does secure local metadata say?',
      include_secure_local: true,
    });

    expect(local.calls).toHaveLength(0);
    expect(result.answer).toContain('could not extract a cited bounded answer');
    expect(result.answer).toContain('Coverage notes');
    expect(result.audit.searched_corpora).toContain(SECURE);
    expect(result.audit.answer_synthesis.secure_local_items_consulted).toBe(1);
    expect(result.audit.answer_synthesis.analyst_backend).toBe('local');
    expect(result.policy.secure_local_content_exposed).toBe(false);
    expect(result.opsec.release_decision.decision).toBe('allow');
    // The released text is byte-identical to a genuine OCR miss on purpose, so
    // the CAUSE has to be machine-distinguishable somewhere: an operator
    // looking at this answer must be able to tell a configuration refusal from
    // an item nobody could read.
    expect(result.opsec.release_decision.reasons).toContain('secure_local_metadata_only_gap');
    expect(result.opsec.release_decision.reasons)
      .not.toContain('unsupported_answer_released_without_source_content');
  });

  test('preset files validate against the schema', () => {
    for (const preset of SOVEREIGNTY_PRESETS) {
      expect(() => loadSovereigntyPreset(preset)).not.toThrow();
    }
  });

  test('subscription-first presets put openclaw-infer first for ordinary cloud routes', () => {
    for (const preset of SOVEREIGNTY_PRESETS) {
      const engine = createSovereigntyEngine(loadSovereigntyPreset(preset));
      for (const domain of ['internal', 'public_safe'] as const) {
        const route = engine.resolveAnalystRoute({ trustDomain: domain });
        expect(route[0]).toMatchObject({
          id: 'cloud-openclaw-infer',
          profile: { provider: 'openclaw-infer', trust: 'standard_cloud' },
        });
      }
    }
  });

  test('anthropic sovereignty profile constructs an analyst from env secretRef', async () => {
    const originalFetch = globalThis.fetch;
    const captured: Array<{
      url: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      captured.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: init?.headers as Record<string, string>,
      });
      const content = JSON.stringify({
        answer: 'Anthropic profile answered.',
        citations: [{ evidence: 1, claim: 'Anthropic profile claim' }],
        unanswered: [],
        sufficient: true,
      });
      return new Response(
        JSON.stringify({ model: 'claude-test', content: [{ type: 'text', text: content }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const analyst = createAnalystForSovereigntyProfile({
        profile: {
          provider: 'anthropic',
          trust: 'standard_cloud',
          model: 'claude-test',
          baseUrl: 'https://anthropic.test',
          secretRef: 'env:ANTHROPIC_API_KEY',
          purpose: 'analyst',
        },
        olympusConfig: defaultConfig(),
        env: { ANTHROPIC_API_KEY: 'anthropic-secret' },
        veniceAnalystTimeoutMs: undefined,
        veniceReasoningHeadroomTokens: undefined,
      });

      const result = await analyst.analyze(evidencePackFixture('internal'), { localOnly: false });

      expect(result.answer).toContain('Anthropic profile answered');
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        url: 'https://anthropic.test/v1/messages',
        headers: { 'x-api-key': 'anthropic-secret' },
      });
      expect(captured[0]!.headers.Authorization).toBeUndefined();
      expect(captured[0]!.body.model).toBe('claude-test');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('writes a preset sovereignty config file with private permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-sovereignty-test-'));
    try {
      const path = join(dir, 'sovereignty.json');
      const written = writeSovereigntyConfigFile({
        config: loadSovereigntyPreset('local-first'),
        path,
      });

      expect(written).toBe(path);
      expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports content-free drift against the nearest preset without modifying the live file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-sovereignty-drift-'));
    const path = join(dir, 'sovereignty.json');
    try {
      const config = structuredClone(loadSovereigntyPreset('local-first'));
      config.modelProfiles['host-extra-profile'] = {
        provider: 'local-openai-compatible',
        trust: 'local',
        baseUrl: 'http://127.0.0.1:9000/v1',
        model: 'host-model',
        purpose: 'analyst',
      };
      config.retrieval.trustDomains.internal!.activationMode = 'lexical_only';
      config.routes.secure_local!.pool = {
        members: ['host-extra-profile', 'local-source-answer'],
        order: ['host-extra-profile', 'local-source-answer'],
      };
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
      const before = readFileSync(path, 'utf8');

      const report = inspectSovereigntyConfigDrift(path);

      expect(report).toMatchObject({
        kind: 'sovereignty_config_drift',
        config_source: 'file',
        drift: true,
        preset: 'local-first',
        profile_names: {
          present_only_in_live: ['host-extra-profile'],
          absent_from_live: [],
        },
        trust_domains: {
          secure_local: {
            analyst_pool_membership: {
              live: ['host-extra-profile', 'local-source-answer'],
              preset: ['local-source-answer', 'venice-private'],
            },
            analyst_pool_order: {
              live: ['host-extra-profile', 'local-source-answer'],
              preset: ['local-source-answer', 'venice-private'],
            },
          },
          internal: {
            activationMode: { live: 'lexical_only', preset: 'hybrid_shadow' },
          },
        },
      });
      expect(JSON.stringify(report)).not.toContain('secretRef');
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects an invalid live sovereignty file without modifying it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-sovereignty-drift-invalid-'));
    const path = join(dir, 'sovereignty.json');
    try {
      writeFileSync(path, '{"schemaVersion":1,"modelProfiles":');
      const before = readFileSync(path, 'utf8');
      expect(() => inspectSovereigntyConfigDrift(path)).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function baseConfig(overrides: Partial<SovereigntyConfig> = {}): SovereigntyConfig {
  return {
    schemaVersion: 1,
    modelProfiles: {
      local: {
        provider: 'local-openai-compatible',
        trust: 'local',
        baseUrl: 'http://127.0.0.1:8000/v1',
        model: 'local-model',
        purpose: 'analyst',
      },
      cloud: {
        provider: 'openclaw-infer',
        trust: 'standard_cloud',
        model: 'openai/gpt-5.5',
        purpose: 'analyst',
      },
      'cloud-embedding': {
        provider: 'google-gemini',
        trust: 'standard_cloud',
        model: 'gemini-embedding-2',
        secretRef: 'env:GEMINI_API_KEY',
        purpose: 'embedding',
      },
      ...(overrides.modelProfiles ?? {}),
    },
    routes: overrides.routes ?? {
      secure_local: { analyst: ['local'] },
      internal: { analyst: ['cloud', 'local'] },
      public_safe: { analyst: ['cloud', 'local'] },
    },
    retrieval: overrides.retrieval ?? {
      trustDomains: {
        secure_local: {
          minimumExecutionTrust: 'local',
          allowedEmbeddingTrust: ['local'],
          embeddingProfile: null,
          allowCloudQuery: false,
        },
        internal: internalPolicy('cloud-embedding'),
        public_safe: internalPolicy('cloud-embedding'),
      },
    },
  };
}

function internalPolicy(embeddingProfile: string): SovereigntyTrustDomainPolicy {
  return {
    minimumExecutionTrust: 'standard_cloud',
    allowedEmbeddingTrust: ['local', 'standard_cloud'],
    embeddingProfile,
    allowCloudQuery: true,
  };
}

function adapterReturning(ids: string[]): SourceIndexCorpusSearchAdapter {
  return () => ({
    hits: ids.map((id, index) => ({
      sourceItem: { family: 'file' as const, provider: 'test', accountScope: 'personal', providerItemId: id, localItemId: id },
      provenance: {
        sourceItem: { family: 'file' as const, provider: 'test', accountScope: 'personal', providerItemId: id, localItemId: id },
      },
      score: 1 - index * 0.1,
      rawExposed: false as const,
    })),
    latencyMs: 1,
    laneAudits: [],
    rawExposed: false as const,
  });
}

function lanesFixture(input: {
  internal?: string[];
  secure?: string[];
  secureChunks?: string[];
  secureCoverageGaps?: string[];
}) {
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId: INTERNAL, family: 'file', trustDomain: 'internal' }),
    defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
  ]);
  const adapters: Record<string, SourceIndexCorpusSearchAdapter> = {};
  if (input.internal) adapters[INTERNAL] = adapterReturning(input.internal);
  if (input.secure) adapters[SECURE] = adapterReturning(input.secure);
  return {
    registry,
    adapters: adapters as SourceIndexRouterAdapterMap,
    contentProviders: {
      [INTERNAL]: {
        async fetchLocalContent() {
          return {
            sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
            chunks: ['internal test source text'],
          };
        },
      },
      [SECURE]: {
        async fetchLocalContent() {
          return {
            sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
            chunks: input.secureChunks ?? ['secure test source text'],
            ...(input.secureCoverageGaps ? { coverageGaps: input.secureCoverageGaps } : {}),
          };
        },
      },
    } as LocalContentProviderMap,
  };
}

function evidencePackFixture(trustDomain: 'internal' | 'secure_local'): EvidencePack {
  return {
    question: 'What does the source say?',
    candidates: [{
      provenance: {
        sourceItem: {
          family: 'file',
          provider: 'test',
          accountScope: 'personal',
          providerItemId: 'doc-1',
          localItemId: 'doc-1',
        },
      },
      trustDomain,
      trustTier: trustDomain === 'secure_local' ? 'S4' : 'S2',
      chunks: ['source text for the analyst'],
    }],
    coverage: {
      searchedCorpora: [trustDomain === 'secure_local' ? SECURE : INTERNAL],
      skippedCorpora: [],
      extractionGaps: [],
    },
    builtAt: '2026-07-02T00:00:00.000Z',
  };
}

interface ScriptedCall {
  pack: EvidencePack;
  options: AnalystOptions;
}

function scriptedAnalyst(answer: string, claim: string): { analyst: Analyst; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  return {
    calls,
    analyst: {
      async analyze(pack, options): Promise<AnalystResult> {
        calls.push({ pack, options });
        return {
          answer,
          citations: pack.candidates.length > 0
            ? [{ provenance: pack.candidates[0]!.provenance, claim }]
            : [],
          unanswered: [],
        };
      },
    },
  };
}

function throwingAnalyst(): { analyst: Analyst; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  return {
    calls,
    analyst: {
      async analyze(pack, options): Promise<AnalystResult> {
        calls.push({ pack, options });
        throw new Error('configured profile failed');
      },
    },
  };
}
