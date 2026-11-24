import { createTinfoilAnalystModel } from '../../../core/analyst-tinfoil.ts';
import { initializeLocalAnalystWindow, reportLocalAnalystPromptOverride } from '../../source-index/local-analyst-window.ts';
import {
  type SecureLocalAnalystRouteStatus,
  type SovereigntyAnalystRoutePlan,
  type SovereigntyAnalystRouteStep,
} from '../../source-index/analyst-answer.ts';
import { createAnalyst, type AnalystModel } from '../../../core/analyst.ts';
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
import { loadConfig, type ArgusLane, type ArgusModelProfile } from '../../../core/config.ts';
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

interface SovereigntyAnalystEntry {
  profile: SovereigntyResolvedProfile;
  backend: AnalystBackend;
  analyst: Analyst;
  local?: { model: AnalystModel; delphi: DelphiClient; analyst: Analyst };
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
  discoverLocalWindows?: boolean;
}): Promise<Map<string, SovereigntyAnalystEntry>> {
  const map = new Map<string, SovereigntyAnalystEntry>();
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
    if (input.engine.source === 'env_bridge' && id === 'local-source-answer') {
      map.set(id, { profile: resolved, backend, analyst: input.defaultLocal });
    } else if (profile.provider === 'local-openai-compatible') {
      const route = createLocalSovereigntyAnalystRoute({ ...input, profile, profileId: id });
      if (!route) continue;
      const analyst = createAnalyst(route.model, { auditSuspiciousDrafts: true, evidenceFormat: 'compact' });
      const report = { analyst: id, model: profile.model };
      if (input.env.OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES?.trim()) {
        reportLocalAnalystPromptOverride(report);
      } else if (input.discoverLocalWindows !== false) {
        await initializeLocalAnalystWindow(analyst, {
          model: profile.model,
          baseUrl: profile.baseUrl,
          contextTokens: profile.contextTokens,
          secretRef: profile.secretRef,
          authorize: init => route.delphi.withAuth(init, profile.secretRef),
        }, report);
      }
      map.set(id, { profile: resolved, backend, analyst, local: { ...route, analyst } });
    } else {
      const analyst = createRemoteAnalystForSovereigntyProfile({ ...input, profile, profileId: id }, id);
      if (analyst) map.set(id, { profile: resolved, backend, analyst });
    }
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

/** Whether this computer's configured local answer model (or the client given) answers /models within a few seconds. */
export async function probeLocalAnalystService(
  olympusConfig: ReturnType<typeof loadConfig>,
  client = new DelphiClient(olympusConfig),
  route: { lane: ArgusLane } | { profile: ArgusModelProfile } = { profile: 'source_answer' },
): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(3_000);
    if ('lane' in route) await client.listModels(route.lane, signal);
    else await client.listModelsForProfile(route.profile, signal);
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
  requestedProvider: 'default' | 'local' | 'cloud' | 'venice' | 'tinfoil';
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
    if (requestedProvider === 'venice' || requestedProvider === 'tinfoil') throw new OperationError('config_error', 'No standalone Venice analyst route is configured.');
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
  requestedProvider: 'default' | 'local' | 'cloud' | 'venice' | 'tinfoil';
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
  if (profile.provider === 'venice' || profile.provider === 'tinfoil') return profile.provider;
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
    const route = createLocalSovereigntyAnalystRoute(input);
    return route ? createAnalyst(route.model, { auditSuspiciousDrafts: true, evidenceFormat: 'compact' }) : undefined;
  }
  return createRemoteAnalystForSovereigntyProfile(input, profileId);
}

/** A local model and its authenticated client, shared by answers and probes. */
function createLocalSovereigntyAnalystRoute(input: {
  profile: SovereigntyModelProfile;
  profileId?: string;
  localModelActivity?: LocalModelActivity;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  bootSecretResolver?: WorkerBootSecretResolver;
}): { model: AnalystModel; delphi: DelphiClient } | undefined {
  const { profile } = input;
  const profileId = input.profileId ?? profile.model ?? profile.provider;
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
    baseUrl: profile.baseUrl,
    model: profile.model as string,
    ...(profile.secretRef ? { secretRef: profile.secretRef } : {}),
    purpose: 'text_reasoning',
  };
  const delphi = new DelphiClient(config, undefined, { resolveSecretRef: () => apiKey });
  const model = createDelphiAnalystModel(delphi, { profile: 'source_answer', preflightTimeoutMs: 0 });
  return {
    delphi,
    model: input.localModelActivity
      ? input.localModelActivity.track(localModelResourceKey(profile), model, { serialize: false }) : model,
  };
}

export function createLocalSovereigntyAnalystModel(input: Parameters<typeof createLocalSovereigntyAnalystRoute>[0]): AnalystModel | undefined {
  return createLocalSovereigntyAnalystRoute(input)?.model;
}

function createRemoteAnalystForSovereigntyProfile(input: {
  profile: SovereigntyModelProfile;
  profileId?: string;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
  bootSecretResolver?: WorkerBootSecretResolver;
}, profileId: string): Analyst | undefined {
  const { profile } = input;
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
  if (profile.provider === 'tinfoil') {
    const apiKey = resolveSecretRefSync(profile.secretRef ?? 'store:tinfoil.api_key', input.env, 'Tinfoil analyst', bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst'], { id: profileId, profile }));
    if (!apiKey) return undefined;
    return createAnalyst(createTinfoilAnalystModel({ apiKey, model: profile.model, env: input.env }));
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

/** The panel's view of the owner's Private route: its model, served id and window. */
export interface LocalPrivateRoute {
  model: AnalystModel;
  modelId: string;
  windowTokens: number;
}

const PRIVATE_ROUTE_REACHABLE_TTL_MS = 30_000;

/**
 * The one chooser for the private panels' model (owner ruling, 2026-11-16:
 * the biggest private model the owner has, never the built-in one when there
 * is something better). The first member of the secure_local pool when it is
 * a local model: the same model Ask's Private answers use. When it is set up
 * but not answering, `unavailable` (the answer says so; no silent drop to the
 * built-in model), unless the built-in model is what stands in for that
 * member (`builtInStandsIn`: a computer whose only local model is the
 * built-in one) and the member has not answered since this process started. Undefined when the first member is not local: the panel
 * never takes a cloud route of its own. Reachability is asked at most every
 * 30 s.
 */
export function createLocalPrivateRoute(input: {
  firstMember: () => SovereigntyResolvedProfile | undefined;
  model: (member: SovereigntyResolvedProfile) => { model: AnalystModel; modelId: string; baseUrl?: string } | undefined;
  reachable: (member: SovereigntyResolvedProfile) => Promise<boolean>;
  window: (modelId: string, baseUrl: string | undefined, member: SovereigntyResolvedProfile) => Promise<{ windowTokens: number } | undefined>;
  /** Whether the built-in model is this member's stand-in (the owner set up no other local model). */
  builtInStandsIn?: (member: SovereigntyResolvedProfile) => boolean;
  /**
   * The owner's policy has no Private answer route (secure_local disabled).
   * That is a choice, not a failure: there is no private model to choose.
   */
  privateRouteDisabled?: () => boolean;
  now?: () => number;
  /** Where a failed step is said (default: stderr). Ids and reasons only. */
  log?: (line: string) => void;
}): () => Promise<LocalPrivateRoute | { unavailable: true; modelId: string } | undefined> {
  const now = input.now ?? Date.now;
  const log = input.log ?? ((line: string) => { console.warn(line); });
  const models = new Map<string, ReturnType<typeof input.model>>();
  let checked: { id: string; atMs: number; up: boolean } | undefined;
  // A member that has answered is the owner's real model: once seen up, the
  // built-in model never stands in for it, however long it is down.
  const seenUp = new Set<string>();
  return async () => {
    let member: SovereigntyResolvedProfile | undefined;
    if (input.privateRouteDisabled?.() === true) return undefined;
    try { member = input.firstMember(); } catch (error) {
      // The Private pool cannot be read: fail closed, never the built-in model.
      log(`[private-model] pool unreadable reason=${error instanceof Error ? error.name : 'unknown'}`);
      return { unavailable: true, modelId: 'the Private answer model' };
    }
    if (!member || member.profile.provider !== 'local-openai-compatible') return undefined;
    if (!models.has(member.id)) {
      try { models.set(member.id, input.model(member)); } catch { models.set(member.id, undefined); }
    }
    const entry = models.get(member.id);
    if (!entry) return undefined;
    if (!checked || checked.id !== member.id || now() - checked.atMs >= PRIVATE_ROUTE_REACHABLE_TTL_MS) {
      let up = false;
      try { up = await input.reachable(member); } catch { up = false; }
      checked = { id: member.id, atMs: now(), up };
      if (up) seenUp.add(member.id);
    }
    if (!checked.up) {
      let standsIn = false;
      try { standsIn = !seenUp.has(member.id) && input.builtInStandsIn?.(member) === true; } catch { standsIn = false; }
      return standsIn ? undefined : { unavailable: true, modelId: entry.modelId };
    }
    const window = await input.window(entry.modelId, entry.baseUrl, member).catch((error: unknown) => {
      log(`[private-model] window unknown model=${entry.modelId} reason=${error instanceof Error ? error.name : 'unknown'}; reading within the default budget`);
      return undefined;
    });
    // An unknown window reads within the default local budget.
    return { model: entry.model, modelId: entry.modelId, windowTokens: window?.windowTokens ?? 0 };
  };
}

/** Whether a local sovereignty profile's server lists its models within a few seconds. */
export async function probeLocalSovereigntyProfile(
  olympusConfig: ReturnType<typeof loadConfig>,
  profile: SovereigntyModelProfile,
  apiKey?: string,
): Promise<boolean> {
  const config = structuredClone(olympusConfig);
  config.argus.modelProfiles.source_answer = {
    baseUrl: profile.baseUrl as string,
    model: profile.model as string,
    ...(profile.secretRef ? { secretRef: profile.secretRef } : {}),
    purpose: 'text_reasoning',
  };
  return probeLocalAnalystService(config, new DelphiClient(config, undefined, { resolveSecretRef: () => apiKey }));
}
