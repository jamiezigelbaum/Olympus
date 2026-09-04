import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { OperationError } from './operation-error.ts';
import { parseOptionalBooleanEnv } from './config.ts';
import { normalizeSecretRef } from './secret-store.ts';
import { assertModelTrustTierAllowed } from './source-model-policy.ts';
import { normalizeVeniceAnalystModelId } from './venice-models.ts';
import type { SourceTrustDomain, SourceTrustTier } from './source-index/types.ts';

export {
  assertEvidenceCandidateModelEligible,
  assertEvidencePackModelEligible,
  assertModelTrustTierAllowed,
  SourceModelPolicyDeniedError,
  type SourceModelPolicyDenialReason,
} from './source-model-policy.ts';

export const SOVEREIGNTY_SCHEMA_VERSION = 1;
export const SOVEREIGNTY_PRESETS = ['local-first', 'local-only', 'private-cloud-only', 'no-sensitive'] as const;

export type SovereigntyPresetName = (typeof SOVEREIGNTY_PRESETS)[number];
export type SovereigntyProfileTrust = 'local' | 'encrypted_cloud' | 'standard_cloud';
export type SovereigntyProfileProvider =
  | 'local-openai-compatible'
  | 'openclaw-infer'
  | 'google-gemini'
  | 'venice'
  | 'anthropic'
  | 'openai-compatible';

export interface SovereigntyModelProfile {
  provider: SovereigntyProfileProvider;
  trust: SovereigntyProfileTrust;
  model: string;
  baseUrl?: string;
  secretRef?: string;
  purpose?: 'analyst' | 'embedding' | 'vision' | 'classification';
}

export interface SovereigntyAnalystRoute {
  // v1 compatibility input. Parsing converts an existing analyst list into a
  // pool with the same explicit order, so deployed policies keep their exact
  // behavior until an operator deliberately removes the order.
  analyst?: string[];
  pool?: SovereigntyAnalystPool;
  mode?: 'enabled' | 'disabled';
  disabledReason?: string;
}

export interface SovereigntyAnalystPool {
  members: string[];
  // Absent means equal members: dispatch order is chosen from recent
  // health/latency. Present means the operator explicitly owns the order.
  order?: string[];
}

export interface SovereigntyTrustDomainPolicy {
  minimumExecutionTrust: SovereigntyProfileTrust;
  allowedEmbeddingTrust: SovereigntyProfileTrust[];
  embeddingProfile?: string | null;
  allowCloudQuery: boolean;
  activationMode?: 'lexical_only' | 'hybrid_shadow' | 'hybrid_primary' | 'metadata_only';
  secureHandling?: 'answerable' | 'metadata_only_gap';
}

export interface SovereigntyConfig {
  schemaVersion: 1;
  modelProfiles: Record<string, SovereigntyModelProfile>;
  routes: Partial<Record<Extract<SourceTrustDomain, 'public_safe' | 'internal' | 'secure_local'>, SovereigntyAnalystRoute>>;
  retrieval: {
    trustDomains: Partial<Record<Extract<SourceTrustDomain, 'public_safe' | 'internal' | 'secure_local'>, SovereigntyTrustDomainPolicy>>;
  };
}

export type SovereigntyPolicySource = 'inline_config' | 'file' | 'env_bridge';

export interface SovereigntyEngine {
  readonly config: SovereigntyConfig;
  readonly source: SovereigntyPolicySource;
  readonly path?: string;
  resolveAnalystRoute(input: {
    trustDomain: SourceTrustDomain;
    requestedProvider?: 'default' | 'local' | 'cloud' | 'venice';
  }): SovereigntyResolvedProfile[];
  resolveAnalystPool(input: {
    trustDomain: SourceTrustDomain;
    requestedProvider?: 'default' | 'local' | 'cloud' | 'venice';
  }): SovereigntyResolvedAnalystPool;
  resolveEmbeddingProfile(trustDomain: SourceTrustDomain): SovereigntyResolvedProfile | undefined;
  assertTrustTierAllowed(trustTier: SourceTrustTier): void;
}

export interface SovereigntyResolvedProfile {
  id: string;
  profile: SovereigntyModelProfile;
}

export interface SovereigntyResolvedAnalystPool {
  members: SovereigntyResolvedProfile[];
  explicitOrder?: SovereigntyResolvedProfile[];
}

export class SecureAnalystPoolE2EEGateError extends OperationError {
  readonly profileId: string;
  readonly modelId: string;

  constructor(profileId: string, modelId: string) {
    super(
      'source_index_policy_violation',
      `Secure analyst pool profile "${profileId}" uses gated E2EE model "${modelId}".`,
      'E2EE secure-pool dispatch remains unavailable until Olympus has local key handling; use a catalog-approved non-E2EE Venice Private/TEE model.',
    );
    this.name = 'SecureAnalystPoolE2EEGateError';
    this.profileId = profileId;
    this.modelId = modelId;
  }
}

export interface LoadSovereigntyOptions {
  env?: Record<string, string | undefined>;
  inlineConfig?: unknown;
  configPath?: string;
}

const BUILTIN_DOMAINS = ['public_safe', 'internal', 'secure_local'] as const;
const TRUST_ORDER: Record<SovereigntyProfileTrust, number> = {
  local: 3,
  encrypted_cloud: 2,
  standard_cloud: 1,
};

export function defaultSovereigntyConfigPath(): string {
  return join(homedir(), '.olympus', 'sovereignty.json');
}

export function loadSovereigntyEngine(options: LoadSovereigntyOptions = {}): SovereigntyEngine {
  const env = options.env ?? process.env;
  if (options.inlineConfig !== undefined) {
    return createSovereigntyEngine(parseSovereigntyConfig(options.inlineConfig, 'inline sovereignty config'), {
      source: 'inline_config',
    });
  }

  const requestedConfigPath = options.configPath?.trim()
    || env.OLYMPUS_SOVEREIGNTY_CONFIG?.trim()
    || env.OLYMPUS_SOVEREIGNTY_CONFIG_PATH?.trim();
  const configPath = requestedConfigPath || defaultSovereigntyConfigPath();
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    return createSovereigntyEngine(parseSovereigntyConfig(parsed, configPath), {
      source: 'file',
      path: configPath,
    });
  }
  if (requestedConfigPath) {
    throw new OperationError(
      'config_error',
      'The explicitly configured sovereignty policy file does not exist.',
      'Restore the configured policy file or remove the explicit path to use the environment bridge.',
    );
  }

  return createSovereigntyEngine(buildEnvBridgeSovereigntyConfig(env), { source: 'env_bridge' });
}

export function createSovereigntyEngine(
  rawConfig: SovereigntyConfig,
  metadata: { source: SovereigntyPolicySource; path?: string } = { source: 'inline_config' },
): SovereigntyEngine {
  const config = validateSovereigntyConfig(rawConfig);
  const resolveAnalystPool = (input: {
    trustDomain: SourceTrustDomain;
    requestedProvider?: 'default' | 'local' | 'cloud' | 'venice';
  }): SovereigntyResolvedAnalystPool => {
    const trustDomain = builtinTrustDomain(input.trustDomain);
    const requestedProvider = input.requestedProvider ?? 'default';
    const route = config.routes[trustDomain];
    if (!route) {
      throw new OperationError(
        'config_error',
        `No sovereignty analyst route is configured for ${trustDomain}.`,
        'Add a route in sovereignty.json or choose a preset with an approved lane for this trust domain.',
      );
    }
    if (route.mode === 'disabled') {
      throw new OperationError(
        'config_error',
        `Sovereignty analyst route for ${trustDomain} is disabled.`,
        route.disabledReason ?? 'Configure an approved analyst profile before asking this trust domain.',
      );
    }
    const routePool = requiredAnalystPool(route, trustDomain);
    const approved = routePool.members
      .map((id) => resolveProfile(config, id, `analyst pool for ${trustDomain}`))
      .filter((profile) => profileAllowedForDomain(profile.profile, trustDomain));
    const requested = requestedProvider === 'default'
      ? approved
      : approved.filter((profile) => analystProfileMatchesRequest(profile.profile, requestedProvider));
    // The requested provider is an owner preference, not policy. When the
    // domain approves no such lane, keep the approved members that are at
    // least as trusted as the request asked for; substituting a WEAKER lane is
    // the silent fall-through the error below exists to prevent, so a pool
    // with nothing that trusted still fails closed.
    const members = requested.length > 0
      ? requested
      : approved.filter((profile) => (
        TRUST_ORDER[profile.profile.trust] >= requestedProviderTrust(requestedProvider)
      ));
    if (members.length === 0) {
      throw new OperationError(
        'config_error',
        `Sovereignty analyst route for ${trustDomain} has no approved ${requestedProvider} profile.`,
        `${trustDomain} may not silently fall through to a less trusted model lane.`,
      );
    }
    const memberSet = new Set(members.map((member) => member.id));
    const explicitOrder = routePool.order
      ?.filter((id) => memberSet.has(id))
      .map((id) => resolveProfile(config, id, `analyst pool order for ${trustDomain}`));
    return {
      members,
      ...(explicitOrder ? { explicitOrder } : {}),
    };
  };
  return {
    config,
    source: metadata.source,
    ...(metadata.path ? { path: metadata.path } : {}),
    resolveAnalystRoute(input) {
      const pool = resolveAnalystPool(input);
      return pool.explicitOrder ?? pool.members;
    },
    resolveAnalystPool,
    resolveEmbeddingProfile(trustDomain) {
      const domain = builtinTrustDomain(trustDomain);
      const policy = config.retrieval.trustDomains[domain];
      if (!policy?.embeddingProfile) return undefined;
      return resolveProfile(config, policy.embeddingProfile, `embedding policy for ${domain}`);
    },
    assertTrustTierAllowed(trustTier) {
      assertModelTrustTierAllowed(trustTier);
    },
  };
}

export function validateSovereigntyConfig(rawConfig: SovereigntyConfig): SovereigntyConfig {
  const config = parseSovereigntyConfig(rawConfig, 'sovereignty config');
  for (const [id, profile] of Object.entries(config.modelProfiles)) {
    validateProfile(id, profile);
  }
  for (const domain of BUILTIN_DOMAINS) {
    const route = config.routes[domain];
    if (!route) {
      throw new OperationError('config_error', `sovereignty.routes.${domain} is required.`);
    }
    const pool = requiredAnalystPool(route, domain);
    if (route.mode === 'disabled') {
      if (pool.members.length > 0) {
        throw new OperationError('config_error', `Disabled sovereignty route ${domain} must not include analyst profiles.`);
      }
    } else if (pool.members.length === 0) {
      throw new OperationError(
        'config_error',
        `sovereignty.routes.${domain}.pool.members must not be empty.`,
        'Use mode:"disabled" with an explicit reason only when the trust domain is intentionally metadata-only.',
      );
    }
    validateAnalystPoolShape(pool, domain);
    for (const profileId of pool.members) {
      const resolved = resolveProfile(config, profileId, `route ${domain}`);
      if (!profileAllowedForDomain(resolved.profile, domain)) {
        throw new OperationError(
          'config_error',
          `${domain} cannot route to ${resolved.profile.trust} profile "${profileId}".`,
          hardInvariantSuggestion(domain),
        );
      }
      if (domain === 'secure_local') {
        assertSecureAnalystPoolProfileAllowed(resolved);
      }
    }
    const retrieval = config.retrieval.trustDomains[domain];
    if (!retrieval) {
      throw new OperationError('config_error', `sovereignty.retrieval.trustDomains.${domain} is required.`);
    }
    validateRetrievalPolicy(config, domain, retrieval);
  }
  return config;
}

export function buildEnvBridgeSovereigntyConfig(env: Record<string, string | undefined> = process.env): SovereigntyConfig {
  const localProfile: SovereigntyModelProfile = {
    provider: 'local-openai-compatible',
    trust: 'local',
    baseUrl: firstNonEmpty(env, [
      'OLYMPUS_ARGUS_SOURCE_ANSWER_BASE_URL',
      'OLYMPUS_ARGUS_FAST_BASE_URL',
    ]) ?? 'http://127.0.0.1:28090/v1',
    model: firstNonEmpty(env, [
      'OLYMPUS_ARGUS_SOURCE_ANSWER_MODEL',
      'OLYMPUS_ARGUS_FAST_MODEL',
    // A delphi/* profile, never a backing model id: the Delphi consumer
    // contract routes profiles and rotates models without notice.
    ]) ?? 'delphi/source-answer',
    purpose: 'analyst',
  };
  const profiles: Record<string, SovereigntyModelProfile> = {
    'local-source-answer': localProfile,
  };
  const cloudEnabled = parseOptionalBooleanEnv(
    env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED,
    'OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED',
    { invalid: 'warn-false' },
  );
  if (cloudEnabled) {
    profiles['cloud-openclaw-infer'] = {
      provider: 'openclaw-infer',
      trust: 'standard_cloud',
      model: env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL?.trim() || 'openai/gpt-5.5',
      purpose: 'analyst',
    };
  }
  if (hasAnyEnv(env, [
    'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
    'VENICE_API_KEY',
    'API_KEY_VENICE',
    'Venice-API-Key',
    'OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_MODEL',
    'OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_BASE_URL',
  ])) {
    profiles['venice-private'] = {
      provider: 'venice',
      trust: 'encrypted_cloud',
      model: env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_MODEL?.trim() || 'kimi-k3',
      baseUrl: env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_BASE_URL?.trim() || 'https://api.venice.ai/api/v1',
      secretRef: firstExistingSecretRef(env, [
        'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
        'VENICE_API_KEY',
        'API_KEY_VENICE',
        'Venice-API-Key',
      ]) ?? 'env:OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
      purpose: 'analyst',
    };
  }

  const embeddingProvider = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER?.trim();
  if (embeddingProvider === 'local-openai-compatible') {
    profiles['local-source-embedding'] = {
      provider: 'local-openai-compatible',
      trust: 'local',
      baseUrl: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL?.trim() || 'http://127.0.0.1:28090/v1',
      model: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL?.trim() || 'secure-local-qwen3-embed',
      purpose: 'embedding',
    };
  } else if (embeddingProvider === 'google-gemini') {
    profiles['gemini-source-embedding'] = {
      provider: 'google-gemini',
      trust: 'standard_cloud',
      baseUrl: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta',
      model: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL?.trim() || 'gemini-embedding-2',
      secretRef: firstExistingSecretRef(env, ['OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY', 'GEMINI_API_KEY'])
        ?? 'env:OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY',
      purpose: 'embedding',
    };
  }

  const defaultRoute = cloudEnabled ? ['cloud-openclaw-infer', 'local-source-answer'] : ['local-source-answer'];
  const internalEmbeddingProfile = embeddingProvider === 'google-gemini'
    ? 'gemini-source-embedding'
    : embeddingProvider === 'local-openai-compatible'
      ? 'local-source-embedding'
      : null;
  const secureEmbeddingProfile = embeddingProvider === 'local-openai-compatible'
    ? 'local-source-embedding'
    : null;
  const secureAnalystMembers = profiles['venice-private']
    ? ['local-source-answer', 'venice-private']
    : ['local-source-answer'];
  return {
    schemaVersion: SOVEREIGNTY_SCHEMA_VERSION,
    modelProfiles: profiles,
    routes: {
      secure_local: { pool: { members: secureAnalystMembers } },
      internal: { analyst: defaultRoute },
      public_safe: { analyst: defaultRoute },
    },
    retrieval: {
      trustDomains: {
        secure_local: {
          minimumExecutionTrust: 'local',
          allowedEmbeddingTrust: ['local'],
          embeddingProfile: secureEmbeddingProfile,
          allowCloudQuery: false,
          activationMode: secureEmbeddingProfile ? 'hybrid_shadow' : 'lexical_only',
          secureHandling: 'answerable',
        },
        internal: {
          minimumExecutionTrust: cloudEnabled ? 'standard_cloud' : 'local',
          allowedEmbeddingTrust: ['local', 'standard_cloud'],
          embeddingProfile: internalEmbeddingProfile,
          allowCloudQuery: true,
          activationMode: internalEmbeddingProfile ? 'hybrid_shadow' : 'lexical_only',
        },
        public_safe: {
          minimumExecutionTrust: 'standard_cloud',
          allowedEmbeddingTrust: ['local', 'standard_cloud'],
          embeddingProfile: internalEmbeddingProfile,
          allowCloudQuery: true,
          activationMode: internalEmbeddingProfile ? 'hybrid_shadow' : 'lexical_only',
        },
      },
    },
  };
}

export function sovereigntyRoutingSnapshot(engine: SovereigntyEngine): Record<string, unknown> {
  const routes: Record<string, unknown> = {};
  for (const domain of BUILTIN_DOMAINS) {
    try {
      routes[domain] = engine.resolveAnalystRoute({ trustDomain: domain })
        .map((entry) => ({ id: entry.id, provider: entry.profile.provider, trust: entry.profile.trust }));
    } catch (error) {
      routes[domain] = error instanceof Error ? error.message : String(error);
    }
  }
  return routes;
}

export function describeSovereigntyPolicy(engine: SovereigntyEngine): string {
  const routeSummary = BUILTIN_DOMAINS.map((domain) => {
    const route = engine.config.routes[domain];
    const pool = route ? analystPoolFromRoute(route) : undefined;
    const value = route?.mode === 'disabled'
      ? 'disabled'
      : pool
        ? pool.order
          ? `ordered(${pool.order.join('>')})`
          : `pool(${[...pool.members].sort().join('|')})`
        : 'missing';
    return `${domain}:${value}`;
  }).join(',');
  const source = engine.source === 'file' && engine.path ? `file:${engine.path}` : engine.source;
  return `sovereignty_policy source=${source} routes=${routeSummary}`;
}

export function writeSovereigntyConfigFile(input: {
  config: SovereigntyConfig;
  path?: string;
  force?: boolean;
}): string {
  const path = input.path?.trim() || defaultSovereigntyConfigPath();
  if (existsSync(path) && input.force !== true) {
    throw new OperationError(
      'invalid_params',
      `Sovereignty config already exists at ${path}.`,
      'Pass --force to overwrite it.',
    );
  }
  const config = validateSovereigntyConfig(input.config);
  // ~/.olympus is the owner's private policy directory: sovereignty.json and
  // the sensitivity map the install guide has an agent write next to it. It
  // must exist after setup, and at 0700 -- created with the process umask it
  // was world-readable, which is the wrong custody for the directory that
  // holds a sensitivity map.
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // The mode argument applies at CREATION only, so a --force overwrite left an
  // existing world-readable policy file exactly as world-readable as it found
  // it. This file records how sensitive data is handled; it is owner-only every
  // time it is written, not only the first time.
  chmodSync(path, 0o600);
  return path;
}

export function loadSovereigntyPreset(name: SovereigntyPresetName): SovereigntyConfig {
  const sourceLayoutPath = join(import.meta.dir, '..', '..', 'config', 'sovereignty', 'presets', `${name}.json`);
  const bundledLayoutPath = join(import.meta.dir, '..', 'config', 'sovereignty', 'presets', `${name}.json`);
  const path = existsSync(sourceLayoutPath) ? sourceLayoutPath : bundledLayoutPath;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return validateSovereigntyConfig(parsed as SovereigntyConfig);
}

function parseSovereigntyConfig(value: unknown, label: string): SovereigntyConfig {
  const root = unwrapSovereignty(value);
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new OperationError('config_error', `${label} must be an object.`);
  }
  const record = root as Record<string, unknown>;
  if (record.schemaVersion !== SOVEREIGNTY_SCHEMA_VERSION) {
    throw new OperationError('config_error', `${label} schemaVersion must be ${SOVEREIGNTY_SCHEMA_VERSION}.`);
  }
  const modelProfiles = parseProfiles(record.modelProfiles, label);
  const routes = parseRoutes(record.routes, label);
  const retrievalRecord = asRecord(record.retrieval);
  const trustDomainsRecord = asRecord(retrievalRecord?.trustDomains);
  const trustDomains: SovereigntyConfig['retrieval']['trustDomains'] = {};
  for (const domain of BUILTIN_DOMAINS) {
    const policy = asRecord(trustDomainsRecord?.[domain]);
    if (policy) trustDomains[domain] = parseTrustDomainPolicy(policy, `${label}.retrieval.trustDomains.${domain}`);
  }
  return {
    schemaVersion: SOVEREIGNTY_SCHEMA_VERSION,
    modelProfiles,
    routes,
    retrieval: { trustDomains },
  };
}

function unwrapSovereignty(value: unknown): unknown {
  const record = asRecord(value);
  if (record?.sovereignty && asRecord(record.sovereignty)?.schemaVersion === SOVEREIGNTY_SCHEMA_VERSION) {
    return record.sovereignty;
  }
  return value;
}

function parseProfiles(value: unknown, label: string): Record<string, SovereigntyModelProfile> {
  const record = asRecord(value);
  if (!record) throw new OperationError('config_error', `${label}.modelProfiles must be an object.`);
  const profiles: Record<string, SovereigntyModelProfile> = {};
  for (const [id, item] of Object.entries(record)) {
    const profile = asRecord(item);
    if (!profile) throw new OperationError('config_error', `${label}.modelProfiles.${id} must be an object.`);
    if (profile.apiKey !== undefined || profile.secret !== undefined) {
      throw new OperationError(
        'config_error',
        `${label}.modelProfiles.${id} must not contain inline secrets.`,
        'Use secretRef such as env:VENICE_API_KEY or store:venice.api_key instead.',
      );
    }
    const provider = stringField(profile, 'provider', `${label}.modelProfiles.${id}`) as SovereigntyProfileProvider;
    const trust = stringField(profile, 'trust', `${label}.modelProfiles.${id}`) as SovereigntyProfileTrust;
    const parsedProfile: SovereigntyModelProfile = {
      provider,
      trust,
      model: stringField(profile, 'model', `${label}.modelProfiles.${id}`),
      ...optionalString(profile, 'baseUrl'),
      ...optionalString(profile, 'secretRef'),
    };
    if (typeof profile.purpose === 'string') {
      parsedProfile.purpose = profile.purpose as NonNullable<SovereigntyModelProfile['purpose']>;
    }
    profiles[id] = parsedProfile;
  }
  return profiles;
}

function parseRoutes(value: unknown, label: string): SovereigntyConfig['routes'] {
  const record = asRecord(value);
  if (!record) throw new OperationError('config_error', `${label}.routes must be an object.`);
  const routes: SovereigntyConfig['routes'] = {};
  for (const domain of BUILTIN_DOMAINS) {
    const route = asRecord(record[domain]);
    if (!route) continue;
    const legacyAnalyst = route.analyst;
    const poolRecord = asRecord(route.pool);
    if (legacyAnalyst !== undefined && poolRecord) {
      throw new OperationError(
        'config_error',
        `${label}.routes.${domain} must use either legacy analyst or pool, not both.`,
      );
    }
    let pool: SovereigntyAnalystPool;
    if (legacyAnalyst !== undefined) {
      const analyst = stringArrayField(legacyAnalyst, `${label}.routes.${domain}.analyst`);
      // Compatibility contract: an existing list was ordered. Preserve that
      // order explicitly instead of silently converting it to equal members.
      pool = { members: analyst, order: [...analyst] };
    } else if (poolRecord) {
      const members = stringArrayField(
        poolRecord.members,
        `${label}.routes.${domain}.pool.members`,
      );
      const order = poolRecord.order === undefined
        ? undefined
        : stringArrayField(poolRecord.order, `${label}.routes.${domain}.pool.order`);
      pool = {
        members,
        ...(order ? { order } : {}),
      };
    } else {
      throw new OperationError(
        'config_error',
        `${label}.routes.${domain} requires pool (or legacy analyst).`,
      );
    }
    routes[domain] = {
      pool,
      ...(route.mode === 'disabled' ? { mode: 'disabled' as const } : {}),
      ...optionalString(route, 'disabledReason'),
    };
  }
  return routes;
}

function parseTrustDomainPolicy(record: Record<string, unknown>, label: string): SovereigntyTrustDomainPolicy {
  const minimumExecutionTrust = stringField(record, 'minimumExecutionTrust', label) as SovereigntyProfileTrust;
  const allowedEmbeddingTrust = record.allowedEmbeddingTrust;
  if (!Array.isArray(allowedEmbeddingTrust) || !allowedEmbeddingTrust.every((item) => typeof item === 'string')) {
    throw new OperationError('config_error', `${label}.allowedEmbeddingTrust must be a string array.`);
  }
  const policy: SovereigntyTrustDomainPolicy = {
    minimumExecutionTrust,
    allowedEmbeddingTrust: allowedEmbeddingTrust as SovereigntyProfileTrust[],
    allowCloudQuery: booleanField(record, 'allowCloudQuery', label),
  };
  if (typeof record.embeddingProfile === 'string') {
    policy.embeddingProfile = record.embeddingProfile.trim();
  } else if (record.embeddingProfile === null) {
    policy.embeddingProfile = null;
  }
  if (typeof record.activationMode === 'string') {
    policy.activationMode = record.activationMode as NonNullable<SovereigntyTrustDomainPolicy['activationMode']>;
  }
  if (typeof record.secureHandling === 'string') {
    policy.secureHandling = record.secureHandling as NonNullable<SovereigntyTrustDomainPolicy['secureHandling']>;
  }
  return policy;
}

function validateProfile(id: string, profile: SovereigntyModelProfile): void {
  if (!id.trim()) throw new OperationError('config_error', 'Sovereignty model profile ids must not be empty.');
  if (!['local-openai-compatible', 'openclaw-infer', 'google-gemini', 'venice', 'anthropic', 'openai-compatible'].includes(profile.provider)) {
    throw new OperationError('config_error', `Sovereignty profile "${id}" has unsupported provider "${profile.provider}".`);
  }
  if (!['local', 'encrypted_cloud', 'standard_cloud'].includes(profile.trust)) {
    throw new OperationError('config_error', `Sovereignty profile "${id}" has unsupported trust "${profile.trust}".`);
  }
  if (profile.trust === 'local' && profile.provider !== 'local-openai-compatible') {
    throw new OperationError(
      'config_error',
      `Sovereignty profile "${id}" cannot claim local trust with provider "${profile.provider}".`,
      'Use provider "local-openai-compatible" for local analyst profiles.',
    );
  }
  if (!profile.model.trim()) throw new OperationError('config_error', `Sovereignty profile "${id}" requires a model.`);
  if (profile.baseUrl !== undefined && !/^https?:\/\//.test(profile.baseUrl)) {
    throw new OperationError('config_error', `Sovereignty profile "${id}" baseUrl must be an HTTP(S) URL.`);
  }
  if (profile.trust === 'local' || profile.provider === 'local-openai-compatible') {
    assertLocalProfileBaseUrl(id, profile.baseUrl);
  }
  const rawProfile = profile as unknown as Record<string, unknown>;
  if (rawProfile.apiKey !== undefined || rawProfile.secret !== undefined) {
    throw new OperationError(
      'config_error',
      `Sovereignty profile "${id}" must not contain inline secrets.`,
      'Use secretRef such as env:VENICE_API_KEY or store:venice.api_key instead.',
    );
  }
  if (profile.secretRef !== undefined && !normalizeSecretRef(profile.secretRef)) {
    throw new OperationError('config_error', `Sovereignty profile "${id}" secretRef must use env:NAME or store:key.`);
  }
}

function assertLocalProfileBaseUrl(id: string, baseUrl: string | undefined): void {
  // Construction hard-requires the field, so accepting a local profile without
  // one blesses a config the worker cannot boot from.
  if (!baseUrl) {
    throw new OperationError(
      'config_error',
      `Sovereignty local profile "${id}" requires a loopback baseUrl.`,
      'Use 127.0.0.1, ::1, or localhost for local analyst profiles.',
    );
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new OperationError('config_error', `Sovereignty local profile "${id}" baseUrl must be a loopback HTTP(S) URL.`);
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new OperationError(
      'config_error',
      `Sovereignty local profile "${id}" baseUrl must stay on loopback.`,
      'Use 127.0.0.1, ::1, or localhost for local analyst profiles.',
    );
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1';
}

function validateRetrievalPolicy(
  config: SovereigntyConfig,
  domain: (typeof BUILTIN_DOMAINS)[number],
  policy: SovereigntyTrustDomainPolicy,
): void {
  for (const trust of [policy.minimumExecutionTrust, ...policy.allowedEmbeddingTrust]) {
    if (!['local', 'encrypted_cloud', 'standard_cloud'].includes(trust)) {
      throw new OperationError('config_error', `sovereignty ${domain} retrieval policy has unsupported trust "${trust}".`);
    }
  }
  if (domain === 'secure_local') {
    if (policy.allowCloudQuery) {
      throw new OperationError('config_error', 'secure_local retrieval cannot allow cloud query.');
    }
    if (policy.allowedEmbeddingTrust.some((trust) => trust !== 'local')) {
      throw new OperationError(
        'config_error',
        'secure_local embeddings may only use local trust in v1.',
        'encrypted_cloud embedding remains disallowed until a provider-specific approval exists.',
      );
    }
  }
  if (policy.embeddingProfile) {
    const resolved = resolveProfile(config, policy.embeddingProfile, `retrieval policy ${domain}`);
    if (!policy.allowedEmbeddingTrust.includes(resolved.profile.trust)) {
      throw new OperationError('config_error', `${domain} embedding profile "${policy.embeddingProfile}" is outside allowedEmbeddingTrust.`);
    }
    if (domain === 'secure_local' && resolved.profile.trust !== 'local') {
      throw new OperationError(
        'config_error',
        'secure_local is never cloud-embedded.',
        'Use a local embedding profile or leave secure_local lexical/metadata-only.',
      );
    }
  }
}

function resolveProfile(config: SovereigntyConfig, id: string, context: string): SovereigntyResolvedProfile {
  const profile = config.modelProfiles[id];
  if (!profile) {
    throw new OperationError('config_error', `Unknown sovereignty profile "${id}" in ${context}.`);
  }
  return { id, profile };
}

function profileAllowedForDomain(
  profile: SovereigntyModelProfile,
  domain: (typeof BUILTIN_DOMAINS)[number],
): boolean {
  // The secure pool is an approved set, not a generic encrypted-cloud class:
  // this deployment permits loopback local analysts and Venice at its
  // separately enforced Private+ catalog floor. Other providers and ordinary
  // cloud never become eligible by self-declaring a stronger trust label.
  if (domain === 'secure_local') {
    return (
      profile.trust === 'local'
      && profile.provider === 'local-openai-compatible'
    ) || (
      profile.trust === 'encrypted_cloud'
      && profile.provider === 'venice'
    );
  }
  const policyTrust = domain === 'public_safe' ? 'standard_cloud' : 'encrypted_cloud';
  return TRUST_ORDER[profile.trust] >= TRUST_ORDER[policyTrust] || profile.trust === 'standard_cloud';
}

function requestedProviderTrust(
  requestedProvider: 'default' | 'local' | 'cloud' | 'venice',
): number {
  if (requestedProvider === 'local') return TRUST_ORDER.local;
  if (requestedProvider === 'venice') return TRUST_ORDER.encrypted_cloud;
  return TRUST_ORDER.standard_cloud;
}

function analystProfileMatchesRequest(
  profile: SovereigntyModelProfile,
  requestedProvider: 'default' | 'local' | 'cloud' | 'venice',
): boolean {
  if (requestedProvider === 'local') return profile.trust === 'local';
  if (requestedProvider === 'venice') return profile.provider === 'venice';
  if (requestedProvider === 'cloud') return profile.trust === 'standard_cloud';
  return true;
}

function builtinTrustDomain(value: SourceTrustDomain): (typeof BUILTIN_DOMAINS)[number] {
  if (value === 'public_safe' || value === 'internal' || value === 'secure_local') return value;
  throw new OperationError('config_error', `Sovereignty config does not define extension trust domain "${value}" yet.`);
}

function hardInvariantSuggestion(domain: string): string {
  return domain === 'secure_local'
    ? 'secure_local may use loopback local analysts or catalog-approved Venice Private/TEE analysts, never E2EE while its key gate stands, anonymized Venice, another provider, or standard cloud.'
    : 'Choose a route whose profile trust is approved for that trust domain.';
}

function analystPoolFromRoute(route: SovereigntyAnalystRoute): SovereigntyAnalystPool | undefined {
  if (route.pool) return route.pool;
  if (route.analyst) return { members: route.analyst, order: [...route.analyst] };
  return undefined;
}

function requiredAnalystPool(
  route: SovereigntyAnalystRoute,
  domain: string,
): SovereigntyAnalystPool {
  const pool = analystPoolFromRoute(route);
  if (!pool) {
    throw new OperationError(
      'config_error',
      `sovereignty.routes.${domain} requires an analyst pool.`,
    );
  }
  return pool;
}

function validateAnalystPoolShape(pool: SovereigntyAnalystPool, domain: string): void {
  const members = new Set(pool.members);
  if (members.size !== pool.members.length) {
    throw new OperationError(
      'config_error',
      `sovereignty.routes.${domain}.pool.members must not contain duplicates.`,
    );
  }
  if (!pool.order) return;
  const order = new Set(pool.order);
  if (
    order.size !== pool.order.length
    || order.size !== members.size
    || pool.order.some((id) => !members.has(id))
  ) {
    throw new OperationError(
      'config_error',
      `sovereignty.routes.${domain}.pool.order must contain every pool member exactly once.`,
    );
  }
}

function assertSecureAnalystPoolProfileAllowed(profile: SovereigntyResolvedProfile): void {
  if (profile.profile.provider !== 'venice') return;
  assertSecureAnalystPoolModelIdAllowed(profile.id, profile.profile.model);
}

export function assertSecureAnalystPoolModelIdAllowed(
  profileId: string,
  rawModelId: string,
): void {
  const modelId = normalizeVeniceAnalystModelId(rawModelId);
  if (modelId.toLowerCase().startsWith('e2ee-')) {
    throw new SecureAnalystPoolE2EEGateError(profileId, modelId);
  }
}

function firstNonEmpty(env: Record<string, string | undefined>, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function firstExistingSecretRef(env: Record<string, string | undefined>, names: string[]): string | undefined {
  const name = names.find((candidate) => env[candidate]?.trim());
  return name ? `env:${name}` : undefined;
}

function hasAnyEnv(env: Record<string, string | undefined>, names: string[]): boolean {
  return names.some((name) => Boolean(env[name]?.trim()));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new OperationError('config_error', `${label}.${field} must be a non-empty string.`);
  }
  return value.trim();
}

function booleanField(record: Record<string, unknown>, field: string, label: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') {
    throw new OperationError('config_error', `${label}.${field} must be a boolean.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): Record<string, string> {
  const value = record[field];
  return typeof value === 'string' && value.trim() ? { [field]: value.trim() } : {};
}

function stringArrayField(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new OperationError('config_error', `${label} must be a string array.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}
