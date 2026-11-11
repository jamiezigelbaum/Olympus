import { describe, expect, test } from 'bun:test';
import { sovereigntyAnalystRoutePlan, workerSovereigntyAnalystRoutePlan } from '../src/workers/engine/runtime/private-analysts.ts';
import { createSovereigntyEngine, loadSovereigntyPreset, type SovereigntyResolvedProfile } from '../src/core/sovereignty.ts';
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

// #725: these are the worker's installed presets, whose Personal route names
// openclaw-infer even when only Olympus is installed. No CLI provider override.
test.each(['local-first', 'private-cloud-only', 'no-sensitive'] as const)('standalone %s answers use the configured route without OpenClaw', preset => {
  const engine = createSovereigntyEngine(loadSovereigntyPreset(preset));
  const analysts = new Map<string, SovereigntyAnalystRouteStep>([
    ['local-source-answer', routeStep('local-source-answer', 'delphi')],
    ['venice-private', routeStep('venice-private', 'venice')],
    ['cloud-openclaw-infer', { profile: { id: 'cloud-openclaw-infer', profile: { provider: 'openclaw-infer', trust: 'standard_cloud' } }, backend: 'cloud', analyst: { analyze: async () => { throw new Error('OpenClaw CLI not found on the worker PATH'); } } }],
  ]);
  const route = (env: Record<string, string>, requestedProvider: 'default' | 'local' | 'venice' = 'default') => workerSovereigntyAnalystRoutePlan({ engine, env, trustDomain: 'internal', requestedProvider, analysts, defaultLocal: STUB_ANALYST });
  expect(route({}).steps[0]!.profile.profile.provider).toBe('openclaw-infer');
  const standalone = route({ OLYMPUS_ENGINE_HOST: '1' });
  expect(standalone.steps.map(step => step.profile.id)).toEqual(preset === 'local-first'
    ? ['local-source-answer', 'venice-private'] : preset === 'private-cloud-only' ? ['venice-private'] : ['standalone-source-answer']);
  expect(standalone.steps.every(step => step.profile.profile.provider !== 'openclaw-infer')).toBe(true);
  if (preset === 'private-cloud-only') {
    expect(route({ OLYMPUS_ENGINE_HOST: '1' }, 'venice').steps.map(step => step.backend)).toEqual(['venice']);
    expect(() => route({ OLYMPUS_ENGINE_HOST: '1' }, 'local')).toThrow('no approved local');
  }
  if (preset === 'no-sensitive') expect(() => route({ OLYMPUS_ENGINE_HOST: '1' }, 'venice')).toThrow('Venice');
  // A gateway worker inheriting engine markers is still an OpenClaw host.
  expect(route({ OLYMPUS_ENGINE_HOST: '1', OLYMPUS_NATIVE_SERVICE_INSTANCE_ID: 'gateway', OLYMPUS_WORKER_SUPERVISOR: 'openclaw' }).steps[0]!.backend).toBe('cloud');
});


test('standalone keeps an explicit Personal provider and refuses a pending privacy choice', () => {
  const config = loadSovereigntyPreset('private-cloud-only');
  config.routes.internal = { analyst: ['venice-private'] };
  const analysts = new Map([['venice-private', routeStep('venice-private', 'venice')]]);
  const resolve = () => workerSovereigntyAnalystRoutePlan({ engine: createSovereigntyEngine(config), env: { OLYMPUS_ENGINE_HOST: '1' }, trustDomain: 'internal', requestedProvider: 'default', analysts, defaultLocal: STUB_ANALYST });
  expect(resolve().steps.map(step => step.backend)).toEqual(['venice']);
  config.privacyChoicePending = true;
  expect(resolve).toThrow('first-run privacy policy');
});

test('standalone keeps a mixed Personal pool\'s local member when the request selects local', () => {
  // local-first's Personal route is [cloud-openclaw-infer, local-source-answer].
  const config = loadSovereigntyPreset('local-first');
  config.routes.secure_local = { pool: { members: ['venice-private'] } };
  const analysts = new Map<string, SovereigntyAnalystRouteStep>([
    ['local-source-answer', routeStep('local-source-answer', 'delphi')],
    ['venice-private', routeStep('venice-private', 'venice')],
    ['cloud-openclaw-infer', { profile: { id: 'cloud-openclaw-infer', profile: { provider: 'openclaw-infer', trust: 'standard_cloud' } }, backend: 'cloud', analyst: STUB_ANALYST }],
  ]);
  const route = (requestedProvider: 'default' | 'local') => workerSovereigntyAnalystRoutePlan({ engine: createSovereigntyEngine(config), env: { OLYMPUS_ENGINE_HOST: '1' }, trustDomain: 'internal', requestedProvider, analysts, defaultLocal: STUB_ANALYST });
  expect(route('local').steps.map(step => step.profile.id)).toEqual(['local-source-answer']);
  // A default request follows the owner's Private answer choice.
  expect(route('default').steps.map(step => step.profile.id)).toEqual(['venice-private']);
});
