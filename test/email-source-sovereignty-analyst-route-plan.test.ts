import { describe, expect, test } from 'bun:test';
import { sovereigntyAnalystRoutePlan } from '../src/workers/email-source/server.ts';
import type { SovereigntyResolvedProfile } from '../src/core/sovereignty.ts';
import type { SovereigntyAnalystRouteStep } from '../src/workers/source-index/analyst-answer.ts';
import { OperationError } from '../src/core/operation-error.ts';
import type { Analyst } from '../src/core/contracts.ts';

const STUB_ANALYST: Analyst = {
  analyze: async () => ({ answer: '', citations: [], unanswered: [] }),
};

function resolvedProfile(id: string, provider: 'venice' | 'delphi'): SovereigntyResolvedProfile {
  return {
    id,
    profile: {
      // The Delphi lane is served through a local OpenAI-compatible router;
      // 'delphi' is not itself a profile provider id.
      provider: provider === 'venice' ? 'venice' : 'local-openai-compatible',
      trust: provider === 'venice' ? 'encrypted_cloud' : 'local',
      model: provider === 'venice' ? 'kimi-k3' : 'qwen',
      ...(provider === 'delphi' ? { baseUrl: 'http://127.0.0.1:28011' } : {}),
    },
  };
}

function routeStep(id: string, provider: 'venice' | 'delphi'): SovereigntyAnalystRouteStep {
  return {
    profile: resolvedProfile(id, provider),
    backend: provider === 'venice' ? 'venice' : 'local',
    analyst: STUB_ANALYST,
  };
}

// A pool member whose secret does not resolve is deliberately left out of the
// analyst map: `WorkerBootSecretResolver` records `worker_credential_degraded`
// and keeps the worker serving. Refusing the whole route on that state turned a
// single degraded lane into a total secure-answer outage.
describe('sovereignty analyst route plan', () => {
  test('drops a member that is not constructible and keeps the healthy ones', () => {
    const plan = sovereigntyAnalystRoutePlan({
      trustDomain: 'secure_local',
      pool: {
        members: [resolvedProfile('local-source-answer', 'delphi'), resolvedProfile('venice-private', 'venice')],
      },
      analysts: new Map([['local-source-answer', routeStep('local-source-answer', 'delphi')]]),
    });

    expect(plan.steps.map((step) => step.profile.id)).toEqual(['local-source-answer']);
    expect(plan.poolId).toBe('secure_local');
    expect(plan.trustDomain).toBe('secure_local');
    expect(plan.selection).toBe('health_latency');
  });

  test('preserves the explicit order and reports it as the selection', () => {
    const plan = sovereigntyAnalystRoutePlan({
      trustDomain: 'secure_local',
      pool: {
        members: [resolvedProfile('local-source-answer', 'delphi'), resolvedProfile('venice-private', 'venice')],
        explicitOrder: [
          resolvedProfile('venice-private', 'venice'),
          resolvedProfile('local-source-answer', 'delphi'),
        ],
      },
      analysts: new Map([
        ['venice-private', routeStep('venice-private', 'venice')],
        ['local-source-answer', routeStep('local-source-answer', 'delphi')],
      ]),
    });

    expect(plan.steps.map((step) => step.profile.id)).toEqual(['venice-private', 'local-source-answer']);
    expect(plan.selection).toBe('explicit_order');
  });

  test('refuses an entirely unconstructible pool as the typed disabled-route error', () => {
    let thrown: unknown;
    try {
      sovereigntyAnalystRoutePlan({
        trustDomain: 'secure_local',
        pool: { members: [resolvedProfile('venice-private', 'venice')] },
        analysts: new Map(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OperationError);
    const error = thrown as OperationError;
    expect(error.code).toBe('config_error');
    // The predicate `secureMetadataOnlyGapResult` matches, so a fully degraded
    // secure pool answers with the metadata-only gap instead of a 500.
    expect(error.message).toMatch(/route for secure_local is disabled/i);
    expect(error.message).toContain('venice-private');
  });
});
