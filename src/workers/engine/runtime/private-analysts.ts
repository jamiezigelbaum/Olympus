import { reportLocalAnalystPromptOverride, resolveLocalAnalystWindow, setLocalAnalystWindow } from '../../source-index/local-analyst-window.ts';
import {
  type SecureLocalAnalystRouteStatus,
  type SovereigntyAnalystRoutePlan,
  type SovereigntyAnalystRouteStep,
} from '../../source-index/analyst-answer.ts';
import { createAnalyst } from '../../../core/analyst.ts';
import {
  withBuiltInFallback,
  type BuiltInAnalystModel,
} from '../../../core/analyst-built-in.ts';
import { createDelphiAnalystModel } from '../../../core/analyst-delphi.ts';
import { createAnthropicAnalystModel } from '../../../core/analyst-anthropic.ts';
import { createOpenClawInferAnalystModel } from '../../../core/analyst-openclaw-infer.ts';
import {
  approvedVeniceAnalystBaseUrl,
  createVeniceAnalystModel,
} from '../../../core/analyst-venice.ts';
import {
  createVenicePrivacyCategoryResolver,
  type VeniceModelCatalogOptions,
} from '../../../core/venice-model-catalog.ts';
import {
  assertVeniceAnalystModelAllowed,
} from '../../../core/venice-models.ts';
import { createOpenAICompatibleAnalystModel } from '../../../core/analyst-openai.ts';
import { loadConfig } from '../../../core/config.ts';
import { DelphiClient } from '../../../core/delphi.ts';
import {
  isStandaloneEngineProcess,
  type SovereigntyEngine,
  type SovereigntyModelProfile,
  type SovereigntyResolvedProfile,
} from '../../../core/sovereignty.ts';
import { OperationError } from '../../../core/operation-error.ts';
import {
  isSecureSensitivity,
  type SecureSensitivityInput,
  type SourceTrustDomain,
} from '../../../core/source-index/types.ts';
import {
  WorkerBootSecretResolver,
} from '../../credential-degradation.ts';
import type { Analyst } from '../../../core/contracts.ts';
import type { AnalystBackend } from '../../source-index/answer-types.ts';
import { localModelResourceKey, type LocalModelActivity } from '../../answer-activity.ts';
import { resolveSecretRefSync, bootSecretOptions } from './environment.ts';

export function trustedAnalystAssistTimeoutMs(input: {
  explicitTrustedAnalystTimeoutMs: number | undefined;
  veniceAnalystTimeoutMs: number | undefined;
}): number | undefined {
  if (input.explicitTrustedAnalystTimeoutMs !== undefined) return input.explicitTrustedAnalystTimeoutMs;
  if (input.veniceAnalystTimeoutMs === undefined) return undefined;
  return Math.min(input.veniceAnalystTimeoutMs + 5_000, 20_000);
}

export async function createSovereigntyAnalystMap(input: {
  engine: SovereigntyEngine;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  defaultLocal: Analyst;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
  bootSecretResolver?: WorkerBootSecretResolver;
  builtInAnalyst?: Analyst;
  localModelActivity?: LocalModelActivity;
}): Promise<Map<string, {
  profile: SovereigntyResolvedProfile;
  backend: AnalystBackend;
  analyst: Analyst;
}>> {
  const map = new Map<string, {
    profile: SovereigntyResolvedProfile;
    backend: AnalystBackend;
    analyst: Analyst;
  }>();
  const securePoolMemberIds = (() => {
    try {
      return new Set(
        input.engine.resolveAnalystPool({ trustDomain: 'secure_local' })
          .members.map((member) => member.id),
      );
    } catch {
      return new Set<string>();
    }
  })();
  for (const [id, profile] of Object.entries(input.engine.config.modelProfiles)) {
    const resolved = { id, profile };
    if (profile.purpose && profile.purpose !== 'analyst') continue;
    const backend = analystBackendForSovereigntyProfile(profile);
    if (!backend) continue;
    if (profile.provider === 'venice' && securePoolMemberIds.has(id)) {
      const apiKey = resolveSecretRefSync(
        profile.secretRef,
        input.env,
        'Sovereignty Venice analyst profile',
        bootSecretOptions(input.bootSecretResolver, [id], ['analyst'], resolved),
      );
      if (!apiKey) continue;
      await validateSecureVeniceAnalystProfileAtConstruction({ profile, apiKey });
    }
    const analyst = input.engine.source === 'env_bridge' && id === 'local-source-answer'
      ? input.defaultLocal
      : createAnalystForSovereigntyProfile({
          profile,
          profileId: id,
          ...(input.localModelActivity ? { localModelActivity: input.localModelActivity } : {}),
          olympusConfig: input.olympusConfig,
          env: input.env,
          veniceAnalystTimeoutMs: input.veniceAnalystTimeoutMs,
          veniceReasoningHeadroomTokens: input.veniceReasoningHeadroomTokens,
          ...(input.bootSecretResolver ? { bootSecretResolver: input.bootSecretResolver } : {}),
        });
    if (!analyst) continue;
    if (backend === 'local' && !(input.engine.source === 'env_bridge' && id === 'local-source-answer')) {
      const report = { analyst: id, model: profile.model ?? '' };
      if (input.env.OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES === undefined) {
        setLocalAnalystWindow(analyst, await resolveLocalAnalystWindow({
          model: profile.model ?? '',
          ...(profile.provider === 'local-openai-compatible' && !profile.secretRef ? { baseUrl: profile.baseUrl } : {}),
        }), report);
      } else reportLocalAnalystPromptOverride(report);
    }
    map.set(id, { profile: resolved, backend, analyst });
  }
  applyBuiltInPrivateAnalyst(map, securePoolMemberIds, input.builtInAnalyst);
  return map;
}

/**
 * Each local Private-pool member falls back to the built-in model when its
 * configured service is not running, including when Venice is available.
 * A configured, running local service is used first.
 * Returns whether the built-in model was wired in.
 */
export function applyBuiltInPrivateAnalyst(
  map: Map<string, { profile: SovereigntyResolvedProfile; backend: AnalystBackend; analyst: Analyst }>,
  securePoolMemberIds: ReadonlySet<string>,
  builtInAnalyst: Analyst | undefined,
): boolean {
  if (!builtInAnalyst) return false;
  const members = [...securePoolMemberIds].flatMap((id) => {
    const entry = map.get(id);
    return entry ? [[id, entry] as const] : [];
  });
  let wired = false;
  for (const [id, entry] of members) {
    if (entry.backend !== 'local') continue;
    map.set(id, { ...entry, analyst: withBuiltInFallback(entry.analyst, builtInAnalyst) });
    wired = true;
  }
  return wired;
}

/**
 * Whether the built-in model answers for this Private-pool analyst when its
 * server is down, as applyBuiltInPrivateAnalyst wires it: a local member of a
 * pool. Judged by install state, not by "prepared in this
 * process": boot re-verifies the model while the first readiness check runs,
 * and that check locked every source (#591).
 */
export function builtInBacksPrivateAnalyst(
  id: string,
  state: ReturnType<BuiltInAnalystModel['status']>['state'] | undefined,
  members: readonly { id: string; profile: SovereigntyModelProfile }[],
  _availableIds?: ReadonlySet<string>,
): boolean {
  if (!state || state === 'failed') return false;
  return members.some((member) => member.id === id && member.profile.provider === 'local-openai-compatible');
}

/** Whether this computer's configured local answer model answers /models within a few seconds. */
export async function probeLocalAnalystService(olympusConfig: ReturnType<typeof loadConfig>): Promise<boolean> {
  try {
    await new DelphiClient(olympusConfig).listModelsForProfile('source_answer', AbortSignal.timeout(3_000));
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn one resolved sovereignty pool into the route plan the answer path
 * dispatches over.
 *
 * A pool member whose secret does not resolve is deliberately absent from the
 * analyst map — `WorkerBootSecretResolver` records `worker_credential_degraded`
 * and keeps the worker serving, so one dead credential must not take the pool's
 * healthy members with it. Only a pool with nothing constructible refuses, and
 * it refuses as the typed `config_error` the answer path converts into a
 * metadata-only gap rather than a 500.
 */
export function sovereigntyAnalystRoutePlan(input: {
  trustDomain: SourceTrustDomain;
  pool: {
    members: readonly SovereigntyResolvedProfile[];
    explicitOrder?: readonly SovereigntyResolvedProfile[];
  };
  analysts: ReadonlyMap<string, SovereigntyAnalystRouteStep>;
}): SovereigntyAnalystRoutePlan {
  const profiles = input.pool.explicitOrder ?? input.pool.members;
  const steps = profiles.flatMap((profile) => {
    const entry = input.analysts.get(profile.id);
    return entry ? [entry] : [];
  });
  if (steps.length === 0) {
    throw new OperationError(
      'config_error',
      `Sovereignty analyst route for ${input.trustDomain} is disabled: no configured analyst profile is constructible by this worker (${profiles.map((profile) => profile.id).join(', ')}).`,
      'Restore the analyst credential for one of these profiles and restart the Olympus worker.',
    );
  }
  return {
    poolId: input.trustDomain,
    trustDomain: input.trustDomain,
    selection: input.pool.explicitOrder ? 'explicit_order' : 'health_latency',
    steps,
  };
}

/**
 * Standalone engines cannot run the presets' OpenClaw Personal analyst.
 * Resolve that legacy host lane through the owner's Private answer choice,
 * retaining its order and provider constraints. A keyword-only Private policy
 * still permits Personal answers on this computer's default local analyst.
 */
export function workerSovereigntyAnalystRoutePlan(input: {
  engine: SovereigntyEngine;
  env: Record<string, string | undefined>;
  trustDomain: SourceTrustDomain;
  requestedProvider: 'default' | 'local' | 'cloud' | 'venice';
  analysts: ReadonlyMap<string, SovereigntyAnalystRouteStep>;
  defaultLocal: Analyst;
}): SovereigntyAnalystRoutePlan {
  const { engine, trustDomain, requestedProvider } = input;
  const configured = engine.resolveAnalystPool({ trustDomain });
  if (trustDomain !== 'secure_local' && isStandaloneEngineProcess(input.env)
    && configured.members.some(member => member.profile.provider === 'openclaw-infer')) {
    // A provider-specific request keeps the eligible, constructible
    // non-OpenClaw members of the configured Personal route; only the
    // unavailable OpenClaw lane is substituted. A default request follows the
    // owner's Private answer choice, keeping its fallback order.
    let requested: ReturnType<SovereigntyEngine['resolveAnalystPool']> | undefined;
    if (requestedProvider !== 'default') {
      try { requested = engine.resolveAnalystPool({ trustDomain, requestedProvider }); } catch { requested = undefined; }
    }
    const keep = (profile: SovereigntyResolvedProfile) => profile.profile.provider !== 'openclaw-infer' && input.analysts.has(profile.id);
    if (requested && requested.members.some(keep)) {
      return sovereigntyAnalystRoutePlan({ trustDomain, analysts: input.analysts, pool: {
        members: requested.members.filter(keep),
        ...(requested.explicitOrder ? { explicitOrder: requested.explicitOrder.filter(keep) } : {}),
      } });
    }
    if (engine.config.routes.secure_local?.mode !== 'disabled') {
      return sovereigntyAnalystRoutePlan({
        trustDomain,
        pool: engine.resolveAnalystPool({ trustDomain: 'secure_local', requestedProvider }),
        analysts: input.analysts,
      });
    }
    // Do not turn a provider-specific request into an unrequested local run.
    if (requestedProvider === 'venice') throw new OperationError('config_error', 'No standalone Venice analyst route is configured.');
    const profile: SovereigntyResolvedProfile = {
      id: 'standalone-source-answer',
      profile: { provider: 'built-in', trust: 'local', model: 'default', purpose: 'analyst' },
    };
    return { poolId: trustDomain, trustDomain, selection: 'explicit_order',
      steps: [{ profile, backend: 'local', analyst: input.defaultLocal }] };
  }
  return sovereigntyAnalystRoutePlan({ trustDomain,
    pool: engine.resolveAnalystPool({ trustDomain, requestedProvider }), analysts: input.analysts });
}

/**
 * Whether secure_local evidence has an approved, constructible private analyst
 * under the active sovereignty policy — the same resolution the answer path
 * dispatches through, asked before retrieval so the handler can decide whether
 * secure_local is searched by default. A disabled route (no-sensitive), a
 * metadata-only secure handling policy, a pool with no member matching the
 * requested provider, or a pool whose every credential failed to resolve all
 * answer "not approved"; any other failure is a real error.
 */
export function secureLocalAnalystRouteStatus(input: {
  engine: Pick<SovereigntyEngine, 'config' | 'resolveAnalystPool'>;
  analysts: ReadonlyMap<string, SovereigntyAnalystRouteStep>;
  requestedProvider: 'default' | 'local' | 'cloud' | 'venice';
}): SecureLocalAnalystRouteStatus {
  if (input.engine.config.retrieval.trustDomains.secure_local?.secureHandling === 'metadata_only_gap') {
    return { approved: false, reason: 'secure_local_metadata_only_policy' };
  }
  try {
    sovereigntyAnalystRoutePlan({
      trustDomain: 'secure_local',
      pool: input.engine.resolveAnalystPool({
        trustDomain: 'secure_local',
        requestedProvider: input.requestedProvider,
      }),
      analysts: input.analysts,
    });
    return { approved: true };
  } catch (error) {
    if (error instanceof OperationError && error.code === 'config_error') {
      return { approved: false, reason: 'no_approved_private_analyst' };
    }
    throw error;
  }
}

export async function validateSecureVeniceAnalystProfileAtConstruction(input: {
  profile: SovereigntyModelProfile;
  apiKey: string;
  catalog?: VeniceModelCatalogOptions;
}): Promise<void> {
  const baseUrl = approvedVeniceAnalystBaseUrl(
    input.profile.baseUrl ?? 'https://api.venice.ai/api/v1',
  );
  await assertVeniceAnalystModelAllowed(
    input.profile.model ?? '',
    true,
    createVenicePrivacyCategoryResolver({
      apiKey: input.apiKey,
      baseUrl,
      ...(input.catalog ? { catalog: input.catalog } : {}),
    }),
  );
}

function analystBackendForSovereigntyProfile(profile: SovereigntyModelProfile): AnalystBackend | undefined {
  if (profile.provider === 'venice') return 'venice';
  if (profile.trust === 'local') return 'local';
  if (profile.trust === 'standard_cloud') return 'cloud';
  if (profile.provider === 'openai-compatible') return 'cloud';
  return undefined;
}

export function createAnalystForSovereigntyProfile(input: {
  profile: SovereigntyModelProfile;
  profileId?: string;
  localModelActivity?: LocalModelActivity;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
}): Analyst;

export function createAnalystForSovereigntyProfile(input: {
  profile: SovereigntyModelProfile;
  profileId?: string;
  localModelActivity?: LocalModelActivity;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
  bootSecretResolver: WorkerBootSecretResolver;
}): Analyst | undefined;

export function createAnalystForSovereigntyProfile(input: {
  profile: SovereigntyModelProfile;
  profileId?: string;
  localModelActivity?: LocalModelActivity;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
  bootSecretResolver?: WorkerBootSecretResolver;
}): Analyst | undefined {
  const { profile } = input;
  const profileId = input.profileId ?? profile.model ?? profile.provider;
  if (profile.provider === 'local-openai-compatible') {
    if (!profile.baseUrl?.trim()) {
      throw new Error('Local sovereignty analyst profiles require baseUrl.');
    }
    const apiKey = profile.secretRef
      ? resolveSecretRefSync(
        profile.secretRef,
        input.env,
        'Sovereignty local analyst profile',
        bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst'], { id: profileId, profile }),
      )
      : undefined;
    if (profile.secretRef && !apiKey) return undefined;
    const config = structuredClone(input.olympusConfig);
    config.argus.modelProfiles.source_answer = {
      ...config.argus.modelProfiles.source_answer,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.secretRef ? { secretRef: profile.secretRef } : {}),
      purpose: 'text_reasoning',
    };
    const model = createDelphiAnalystModel(new DelphiClient(config, undefined, {
      resolveSecretRef: () => apiKey,
    }), { profile: 'source_answer', preflightTimeoutMs: 0 });
    return createAnalyst(input.localModelActivity
      ? input.localModelActivity.track(localModelResourceKey(profile), model, { serialize: false }) : model,
    { auditSuspiciousDrafts: true, evidenceFormat: 'compact' });
  }
  if (profile.provider === 'openclaw-infer') {
    return createAnalyst(createOpenClawInferAnalystModel({
      model: profile.model,
      ...(input.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_THINKING?.trim()
        ? { thinking: input.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_THINKING.trim() }
        : { thinking: 'low' }),
      ...(input.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND?.trim()
        ? { command: input.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND.trim() }
        : {}),
    }));
  }
  if (profile.provider === 'venice') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      input.env,
      'Sovereignty Venice analyst profile',
      bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst'], { id: profileId, profile }),
    );
    if (!apiKey) return undefined;
    // Construct the catalog-gated adapter once with the pool member. Every
    // dispatch validates its configured model against the authoritative
    // catalog before chat fetch, using the dispatch AbortSignal.
    return createAnalyst(createVeniceAnalystModel({
      apiKey,
      model: profile.model,
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      ...(input.veniceAnalystTimeoutMs !== undefined ? { timeoutMs: input.veniceAnalystTimeoutMs } : {}),
      ...(input.veniceReasoningHeadroomTokens !== undefined
        ? { reasoningHeadroomTokens: input.veniceReasoningHeadroomTokens }
        : {}),
    }));
  }
  if (profile.provider === 'openai-compatible') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      input.env,
      'Sovereignty OpenAI-compatible analyst profile',
      bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst'], { id: profileId, profile }),
    );
    if (!apiKey) return undefined;
    return {
      async analyze(pack, options) {
        return createAnalyst(createOpenAICompatibleAnalystModel({
          apiKey,
          model: profile.model,
          ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
          providerLabel: 'Sovereignty cloud analyst',
        })).analyze(pack, options);
      },
    };
  }
  if (profile.provider === 'anthropic') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      input.env,
      'Sovereignty Anthropic analyst profile',
      bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst'], { id: profileId, profile }),
    );
    if (!apiKey) return undefined;
    return {
      async analyze(pack, options) {
        return createAnalyst(createAnthropicAnalystModel({
          apiKey,
          model: profile.model,
          ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
        })).analyze(pack, options);
      },
    };
  }
  throw new Error(`Sovereignty analyst provider ${profile.provider} is not supported by this worker.`);
}

export function analystRouteTrustDomain(pack: { candidates: readonly SecureSensitivityInput[] }, localOnly: boolean): SourceTrustDomain {
  // Secure by domain or by tier selects the secure pool.
  if (localOnly || pack.candidates.some((candidate) => isSecureSensitivity(candidate))) {
    return 'secure_local';
  }
  // Public only when a Public candidate is actually in the pack. An empty pack
  // (nothing matched, or every match was Private on a policy with no Private
  // answer route) takes the Personal route: the Analyst answers it without a
  // model call, and a policy with no Public tier (every shipped preset) has no
  // public_safe route to resolve.
  if (pack.candidates.some((candidate) => candidate.trustDomain === 'public_safe')
    && !pack.candidates.some((candidate) => candidate.trustDomain === 'internal')) {
    return 'public_safe';
  }
  return 'internal';
}
