import { describe, expect, test } from 'bun:test';
import { createSovereigntyEngine, type SovereigntyConfig, type SovereigntyTrustDomainPolicy } from '../src/core/sovereignty.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  createSourceIndexEmbeddingProviderFromSovereignty,
} from '../src/workers/email-source/server.ts';
import { WorkerBootSecretResolver } from '../src/workers/credential-degradation.ts';

describe('worker boot secretRef degradation', () => {
  test('worker boots green with a deliberately unresolvable secretRef while the affected lane stays disabled and retries are bounded', async () => {
    let resolveCalls = 0;
    const scheduled: Array<() => void> = [];
    const resolver = new WorkerBootSecretResolver({
      maxAttempts: 3,
      retryDelaysMs: [1, 1],
      now: () => new Date('2026-07-09T12:00:00.000Z'),
      schedule: (run) => {
        scheduled.push(run);
      },
      resolveSecretRefValueSync: () => {
        resolveCalls += 1;
        return undefined;
      },
      warn: () => {},
    });

    const provider = createSourceIndexEmbeddingProviderFromSovereignty(
      createSovereigntyEngine(sovereigntyConfigWithMissingGeminiSecret()),
      'internal',
      {},
      resolver,
    );
    while (scheduled.length > 0) scheduled.shift()?.();

    expect(provider).toBeUndefined();
    expect(resolveCalls).toBeLessThanOrEqual(3);
    expect(resolver.status()).toMatchObject([{
      display_name: 'Sovereignty embedding profile "gemini-internal"',
      state: 'stopped',
      status_label: 'Credential unavailable - needs your attention',
      affected_profiles: ['gemini-internal'],
      affected_capabilities: ['embedding'],
      attempts: 3,
      max_attempts: 3,
    }]);

    const worker = createEmailSourceWorker({
      sourceIndexStatus: {
        async status() {
          return {
            kind: 'source_index_status',
            generated_at: '2026-07-09T12:00:00.000Z',
            corpora: [],
            policy: {
              read_only: true,
              raw_source_exposed: false,
              source_packets_exposed: false,
              source_text_returned: false,
              secure_local_item_metadata_exposed: false,
              castor_visible: true,
            },
          };
        },
      },
      credentialDegradations: () => resolver.status(),
    });

    const health = await worker.fetch(new Request('http://worker.test/v1/health'));
    const healthBody = await health.json();
    const deepHealth = await worker.fetch(new Request('http://worker.test/v1/health?deep=1'));
    const deepHealthBody = await deepHealth.json();
    const dependencyHealth = await worker.fetch(new Request('http://worker.test/v1/health/dependencies'));
    const dependencyHealthBody = await dependencyHealth.json();
    const status = await worker.fetch(new Request('http://worker.test/v1/source/index/status'));
    const statusBody = await status.json();
    const serialized = JSON.stringify({ healthBody, deepHealthBody, dependencyHealthBody, statusBody });

    expect(health.status).toBe(200);
    expect(healthBody).toMatchObject({
      reachable: true,
      status: 'degraded',
      degraded_credentials: [{
        display_name: 'Sovereignty embedding profile "gemini-internal"',
        status_label: 'Credential unavailable - needs your attention',
      }],
    });
    expect(deepHealth.status).toBe(200);
    expect(deepHealthBody).toMatchObject({
      reachable: true,
      status: 'degraded',
      degraded_credentials: [{
        display_name: 'Sovereignty embedding profile "gemini-internal"',
      }],
    });
    expect(dependencyHealth.status).toBe(200);
    expect(dependencyHealthBody).toMatchObject({
      reachable: true,
      status: 'degraded',
      degraded_credentials: [{
        display_name: 'Sovereignty embedding profile "gemini-internal"',
      }],
    });
    expect(status.status).toBe(200);
    expect(statusBody).toMatchObject({
      kind: 'source_index_status',
      embedding_lane: {
        state: 'embedding_lane_disabled',
        reason: 'embedding_provider_unavailable',
        affected_profiles: ['gemini-internal'],
      },
      degraded_credentials: [{
        display_name: 'Sovereignty embedding profile "gemini-internal"',
        hint: expect.stringContaining('re-check'),
      }],
    });
    expect(serialized).not.toContain('store:missing-gemini');
    expect(resolveCalls).toBe(3);
  });
});

function sovereigntyConfigWithMissingGeminiSecret(): SovereigntyConfig {
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
      'gemini-internal': {
        provider: 'google-gemini',
        trust: 'standard_cloud',
        model: 'gemini-embedding-2',
        secretRef: 'store:missing-gemini',
        purpose: 'embedding',
      },
    },
    routes: {
      secure_local: { analyst: ['local'] },
      internal: { analyst: ['local'] },
      public_safe: { analyst: ['local'] },
    },
    retrieval: {
      trustDomains: {
        secure_local: {
          minimumExecutionTrust: 'local',
          allowedEmbeddingTrust: ['local'],
          embeddingProfile: null,
          allowCloudQuery: false,
        },
        internal: internalPolicy('gemini-internal'),
        public_safe: internalPolicy('gemini-internal'),
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
