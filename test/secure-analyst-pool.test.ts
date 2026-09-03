import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createAnalyst } from '../src/core/analyst.ts';
import { createVeniceAnalystModel } from '../src/core/analyst-venice.ts';
import type { Analyst } from '../src/core/contracts.ts';
import type { LocalContentProviderMap } from '../src/core/evidence-pack.ts';
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
  DEFAULT_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS,
  MAX_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS,
  MIN_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS,
  SecureAnalystPoolState,
  deriveSecureAnalystPoolLegBudgets,
  parseSecureAnalystPoolLastLegTimeoutMs,
} from '../src/workers/source-index/analyst-pool.ts';
import {
  createAnalystSourceIndexAnswerHandler,
  type SovereigntyAnalystRoutePlan,
  type SovereigntyAnalystRouteStep,
} from '../src/workers/source-index/analyst-answer.ts';
import {
  createSourceAnswerTrace,
  runWithSourceAnswerTrace,
  snapshotSourceAnswerTrace,
} from '../src/workers/source-index/answer-latency-trace.ts';
import { validateSecureVeniceAnalystProfileAtConstruction } from '../src/workers/email-source/server.ts';

const SECURE_CORPUS = 'secure_local.test.pool';

describe('secure analyst pool', () => {
  test('health/latency selection is independent of config list position', () => {
    const state = new SecureAnalystPoolState();
    const members = [
      { id: 'venice-private', backend: 'venice' as const },
      { id: 'local-source-answer', backend: 'local' as const },
    ];

    const first = state.plan('secure_local', members, 'health_latency');
    expect(first.dispatch.map((member) => member.id)).toEqual([
      'local-source-answer',
      'venice-private',
    ]);

    state.recordSuccess('secure_local', 'local-source-answer', 50);
    const exploration = state.plan('secure_local', members, 'health_latency');
    expect(exploration.dispatch[0]?.id).toBe('venice-private');

    state.recordSuccess('secure_local', 'venice-private', 10);
    const fastest = state.plan('secure_local', members, 'health_latency');
    expect(fastest.dispatch[0]?.id).toBe('venice-private');
  });

  test('breaker opens on consecutive failures and closes after cooldown', () => {
    let nowMs = 1_000;
    const state = new SecureAnalystPoolState({
      failureThreshold: 2,
      cooldownMs: 500,
      now: () => nowMs,
    });
    const member = [{ id: 'venice-private', backend: 'venice' as const }];

    state.recordFailure('secure_local', 'venice-private');
    expect(state.plan('secure_local', member, 'health_latency').dispatch).toHaveLength(1);
    state.recordFailure('secure_local', 'venice-private');
    expect(state.plan('secure_local', member, 'health_latency')).toMatchObject({
      dispatch: [],
      breakerSkipped: [{ id: 'venice-private' }],
    });

    nowMs += 500;
    expect(state.plan('secure_local', member, 'health_latency')).toMatchObject({
      dispatch: [{ id: 'venice-private' }],
      breakerSkipped: [],
    });
  });

  test('derived serial leg budgets remain strictly below the answer SLO', () => {
    const budgets = deriveSecureAnalystPoolLegBudgets([
      { id: 'local-a', backend: 'local' },
      { id: 'venice-a', backend: 'venice' },
      { id: 'venice-b', backend: 'venice' },
    ], {
      sloMs: 60_000,
      reserveMs: 1_000,
      trustedAnalystTimeoutMs: 20_000,
      localAnalystTimeoutMs: 240_000,
    });

    expect([...budgets.values()].every((budget) => budget > 0)).toBe(true);
    expect([...budgets.values()].reduce((sum, budget) => sum + budget, 0)).toBeLessThan(60_000);
    expect(budgets.get('venice-a')).toBeLessThanOrEqual(20_000);
  }, 1_000);

  test('last-leg timeout env uses the completion default and rejects values outside its bounds', () => {
    expect(parseSecureAnalystPoolLastLegTimeoutMs(undefined))
      .toBe(DEFAULT_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS);
    expect(parseSecureAnalystPoolLastLegTimeoutMs(''))
      .toBe(DEFAULT_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS);
    expect(parseSecureAnalystPoolLastLegTimeoutMs(String(MIN_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS)))
      .toBe(MIN_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS);
    expect(parseSecureAnalystPoolLastLegTimeoutMs(String(MAX_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS)))
      .toBe(MAX_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS);
    for (const invalid of [
      String(MIN_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS - 1),
      String(MAX_SECURE_ANALYST_POOL_LAST_LEG_TIMEOUT_MS + 1),
      '180000.5',
      'not-a-timeout',
    ]) {
      expect(() => parseSecureAnalystPoolLastLegTimeoutMs(invalid)).toThrow(
        'OLYMPUS_SOURCE_ANSWER_LAST_LEG_TIMEOUT_MS must be an integer from 30000 through 240000 milliseconds.',
      );
    }
  }, 1_000);

  test('single-member secure pools treat their only member as the last available leg', async () => {
    const local = successfulLocalAnalyst();
    const handler = createAnalystSourceIndexAnswerHandler({
      analyst: local,
      lanes: secureLanes,
      localAnalystTimeoutMs: 1_000,
      secureAnalystPool: {
        sloMs: 100,
        reserveMs: 20,
        lastLegTimeoutMs: 180,
      },
      sovereigntyAnalystRoute: () => secureRoute([
        routeStep('local-source-answer', 'local', 'local-model', local),
      ]),
    });
    const trace = createSourceAnswerTrace();

    const result = await runWithSourceAnswerTrace(
      trace,
      () => handler.answer({ question: 'Summarize the secure evidence.', include_secure_local: true }),
    );

    expect(result.answer).toContain('bounded local answer');
    expect(snapshotSourceAnswerTrace(trace).analystLegs).toEqual([
      expect.objectContaining({
        profile_id: 'local-source-answer',
        budget_ms: 180,
        outcome: 'success',
      }),
    ]);
  }, 1_000);

  test('worker construction validates the configured secure Venice model against the live catalog', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-secure-pool-construction-'));
    let catalogCalls = 0;
    try {
      await validateSecureVeniceAnalystProfileAtConstruction({
        profile: {
          provider: 'venice',
          trust: 'encrypted_cloud',
          model: 'zai-org-glm-5-2',
          purpose: 'analyst',
        },
        apiKey: 'test-only-key',
        catalog: {
          cachePath: join(dir, 'private-catalog.json'),
          refreshMinIntervalMs: 0,
          fetchImpl: async () => {
            catalogCalls += 1;
            return new Response(JSON.stringify({
              data: [{
                id: 'zai-org-glm-5-2',
                model_spec: { privacy: 'private' },
              }],
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        },
      });

      expect(catalogCalls).toBe(1);

      await expect(validateSecureVeniceAnalystProfileAtConstruction({
        profile: {
          provider: 'venice',
          trust: 'encrypted_cloud',
          model: 'zai-org-glm-5-2',
          purpose: 'analyst',
        },
        apiKey: 'test-only-key',
        catalog: {
          cachePath: join(dir, 'anonymized-catalog.json'),
          refreshMinIntervalMs: 0,
          fetchImpl: async () => new Response(JSON.stringify({
            data: [{
              id: 'zai-org-glm-5-2',
              model_spec: { privacy: 'anonymized' },
            }],
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        },
      })).rejects.toMatchObject({
        name: 'VeniceModelPolicyDeniedError',
        code: 'source_index_policy_violation',
        modelId: 'zai-org-glm-5-2',
        privacyCategory: 'anonymized',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 3_000);

  test('timeout abort reaches Venice chat fetch after catalog approval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-secure-pool-chat-cancel-'));
    let chatSignalAborted = false;
    try {
      const venice = createAnalyst(createVeniceAnalystModel({
        apiKey: 'test-only-key',
        model: 'zai-org-glm-5-2',
        fetchImpl: async (_url, init) => {
          return await new Promise<Response>((_resolve, reject) => {
            const rejectAbort = () => {
              chatSignalAborted = true;
              const error = new Error('chat fetch cancelled');
              error.name = 'AbortError';
              reject(error);
            };
            if (init.signal?.aborted) rejectAbort();
            else init.signal?.addEventListener('abort', rejectAbort, { once: true });
          });
        },
        catalog: {
          cachePath: join(dir, 'catalog.json'),
          refreshMinIntervalMs: 0,
          fetchImpl: async () => new Response(JSON.stringify({
            data: [{
              id: 'zai-org-glm-5-2',
              model_spec: { privacy: 'private' },
            }],
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        },
      }));
      const local = successfulLocalAnalyst();
      const handler = createAnalystSourceIndexAnswerHandler({
        analyst: local,
        lanes: secureLanes,
        trustedAnalystTimeoutMs: 40,
        localAnalystTimeoutMs: 1_000,
        secureAnalystPool: { sloMs: 100, reserveMs: 20, lastLegTimeoutMs: 180 },
        sovereigntyAnalystRoute: () => secureRoute([
          routeStep('venice-private', 'venice', 'zai-org-glm-5-2', venice),
          routeStep('local-source-answer', 'local', 'local-model', local),
        ]),
      });
      const trace = createSourceAnswerTrace();

      await runWithSourceAnswerTrace(
        trace,
        () => handler.answer({ question: 'Summarize the secure evidence.', include_secure_local: true }),
      );

      expect(chatSignalAborted).toBe(true);
      expect(snapshotSourceAnswerTrace(trace).residualAnalystOrphanCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 3_000);

  test('timeout abort reaches Venice catalog fetch, leaves no happy-path orphan, and breaker skips are traced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-secure-pool-cancel-'));
    let catalogCalls = 0;
    let chatCalls = 0;
    let catalogSignalAborted = false;
    try {
      const venice = createAnalyst(createVeniceAnalystModel({
        apiKey: 'test-only-key',
        model: 'zai-org-glm-5-2',
        fetchImpl: async () => {
          chatCalls += 1;
          throw new Error('chat dispatch must not begin while catalog validation is pending');
        },
        catalog: {
          cachePath: join(dir, 'catalog.json'),
          refreshMinIntervalMs: 0,
          timeoutMs: 10_000,
          fetchImpl: async (_url, init) => {
            catalogCalls += 1;
            return await new Promise<Response>((_resolve, reject) => {
              const rejectAbort = () => {
                catalogSignalAborted = true;
                const error = new Error('catalog fetch cancelled');
                error.name = 'AbortError';
                reject(error);
              };
              if (init.signal?.aborted) rejectAbort();
              else init.signal?.addEventListener('abort', rejectAbort, { once: true });
            });
          },
        },
      }));
      // Longer than either former SLO-derived slice (40ms with both members,
      // 80ms after the breaker removes Venice), but within the 180ms
      // completion budget.
      const local = successfulLocalAnalyst(100);
      const route = secureRoute([
        routeStep('venice-private', 'venice', 'zai-org-glm-5-2', venice),
        routeStep('local-source-answer', 'local', 'local-model', local),
      ]);
      const handler = createAnalystSourceIndexAnswerHandler({
        analyst: local,
        lanes: secureLanes,
        trustedAnalystTimeoutMs: 40,
        localAnalystTimeoutMs: 1_000,
        secureAnalystPool: {
          sloMs: 100,
          reserveMs: 20,
          lastLegTimeoutMs: 180,
          failureThreshold: 1,
          cooldownMs: 10_000,
        },
        sovereigntyAnalystRoute: () => route,
      });

      const firstTrace = createSourceAnswerTrace();
      const first = await runWithSourceAnswerTrace(
        firstTrace,
        () => handler.answer({ question: 'Summarize the secure evidence.', include_secure_local: true }),
      );
      const firstSnapshot = snapshotSourceAnswerTrace(firstTrace);

      expect(first.answer).toContain('bounded local answer');
      expect(catalogCalls).toBe(1);
      expect(chatCalls).toBe(0);
      expect(catalogSignalAborted).toBe(true);
      expect(firstSnapshot.residualAnalystOrphanCount).toBe(0);
      expect(firstSnapshot.orderedRoute.map((step) => step.profile_id)).toEqual([
        'venice-private',
        'local-source-answer',
      ]);
      expect(firstSnapshot.analystLegs).toEqual([
        expect.objectContaining({
          profile_id: 'venice-private',
          budget_ms: 40,
          outcome: 'timeout',
          error_class: 'TrustedAnalystTimeoutError',
        }),
        expect.objectContaining({
          profile_id: 'local-source-answer',
          budget_ms: 180,
          outcome: 'success',
        }),
      ]);

      const secondTrace = createSourceAnswerTrace();
      await runWithSourceAnswerTrace(
        secondTrace,
        () => handler.answer({ question: 'Summarize the secure evidence.', include_secure_local: true }),
      );
      const secondSnapshot = snapshotSourceAnswerTrace(secondTrace);
      expect(catalogCalls).toBe(1);
      expect(secondSnapshot.orderedRoute.map((step) => step.profile_id)).toEqual([
        'local-source-answer',
        'venice-private',
      ]);
      expect(secondSnapshot.analystLegs).toEqual([
        expect.objectContaining({
          profile_id: 'venice-private',
          outcome: 'breaker_skipped',
          error_class: 'AnalystCircuitOpen',
        }),
        expect.objectContaining({
          profile_id: 'local-source-answer',
          budget_ms: 180,
          outcome: 'success',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 3_000);
});

function secureRoute(steps: SovereigntyAnalystRouteStep[]): SovereigntyAnalystRoutePlan {
  return {
    poolId: 'secure_local',
    trustDomain: 'secure_local',
    selection: 'explicit_order',
    steps,
  };
}

function routeStep(
  id: string,
  backend: 'local' | 'venice',
  model: string,
  analyst: Analyst,
): SovereigntyAnalystRouteStep {
  return {
    profile: {
      id,
      profile: {
        provider: backend === 'venice' ? 'venice' : 'local-openai-compatible',
        trust: backend === 'venice' ? 'encrypted_cloud' : 'local',
        model,
        purpose: 'analyst',
      },
    },
    backend,
    analyst,
  };
}

function successfulLocalAnalyst(delayMs = 0): Analyst {
  return {
    async analyze(pack) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        answer: 'A bounded local answer.',
        citations: [{
          provenance: pack.candidates[0]!.provenance,
          claim: 'bounded local answer',
        }],
        unanswered: [],
      };
    },
  };
}

function secureLanes() {
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({
      corpusId: SECURE_CORPUS,
      family: 'file',
      trustDomain: 'secure_local',
    }),
  ]);
  const adapter: SourceIndexCorpusSearchAdapter = () => ({
    hits: [{
      sourceItem: {
        family: 'file',
        provider: 'test',
        accountScope: 'personal',
        providerItemId: 'secure-item',
        localItemId: 'secure-item',
      },
      provenance: {
        sourceItem: {
          family: 'file',
          provider: 'test',
          accountScope: 'personal',
          providerItemId: 'secure-item',
          localItemId: 'secure-item',
        },
      },
      score: 1,
      rawExposed: false,
    }],
    latencyMs: 1,
    laneAudits: [],
    rawExposed: false,
  });
  return {
    registry,
    adapters: { [SECURE_CORPUS]: adapter } as SourceIndexRouterAdapterMap,
    contentProviders: {
      [SECURE_CORPUS]: {
        async fetchLocalContent() {
          return {
            sensitivity: buildSourceSensitivity({
              trustTier: 'S4',
              trustDomain: 'secure_local',
            }),
            chunks: ['secure test source text'],
          };
        },
      },
    } as LocalContentProviderMap,
  };
}
