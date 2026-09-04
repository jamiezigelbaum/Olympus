import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OperationError } from './operation-error.ts';
import {
  defaultSourceCorpusRegistryConfig,
  parsePublicSourceCorpusRegistryConfig,
  parseSourceCorpusRegistryConfig,
  type SourceCorpusRegistryConfig,
} from './source-corpus-registry.ts';
import {
  parseSourceIngestionPolicy,
  type SourceIngestionPolicy,
} from './source-ingestion-policy.ts';
import {
  parseSourceIngestionExclusions,
  SOURCE_INGESTION_EXCLUSIONS_PATH_ENV,
  type SourceIngestionExclusions,
} from './source-ingestion-exclusions.ts';
import { normalizeSecretRef } from './secret-store.ts';
import type { SovereigntyConfig } from './sovereignty.ts';
import { V0_4_PUBLIC_SOURCE_IDS } from './public-surface.ts';

/**
 * Keys still understood by the repository while their private owners are
 * retired. They are deliberately absent from the install-time plugin schema.
 */
export const REPOSITORY_ONLY_PLUGIN_CONFIG_KEYS = [
  'argus_deep_base_url',
  'argus_deep_model',
  'argus_default_lane',
  'argus_fast_base_url',
  'argus_fast_model',
  'castorWorkspace',
  'domainExpert',
  'fileDelivery',
] as const;

export type ArgusLane = 'fast' | 'deep';
export type ArgusModelProfile =
  | 'default_chat'
  | 'source_answer'
  | 'classification_fast'
  | 'embedding_secure_local'
  | 'vlm_document'
  | 'vlm_fast'
  | 'vlm_qwen36_27b'
  | 'vlm_qwen36_35b';
export type ArgusTransport = 'direct';

export interface ArgusLaneConfig {
  baseUrl: string;
  model: string;
  secretRef?: string;
}

export interface ArgusModelProfileConfig {
  baseUrl: string;
  model: string;
  secretRef?: string;
  purpose: 'chat' | 'text_reasoning' | 'classification' | 'embedding' | 'vision';
}

const ARGUS_MODEL_PROFILE_PURPOSES = ['chat', 'text_reasoning', 'classification', 'embedding', 'vision'] as const;

export interface OlympusConfig {
  sovereignty?: {
    configPath?: string;
    policy?: SovereigntyConfig;
  };
  worker: {
    authToken?: string;
    scheduler: {
      enabled: boolean;
      sourceIds: string[];
      tickSeconds: number;
      syncIntervalSeconds: number;
      freshnessThresholdHours: number;
      errorBackoffSeconds: number;
      maxTransientRetries: number;
    };
  };
  identity: {
    ownerName: string;
    assistantName: string;
  };
  argus: {
    defaultLane: ArgusLane;
    defaultProfile: ArgusModelProfile;
    transport: ArgusTransport;
    requestTimeoutSeconds: number;
    lanes: Record<ArgusLane, ArgusLaneConfig>;
    modelProfiles: Record<ArgusModelProfile, ArgusModelProfileConfig>;
  };
  email: {
    enabled: boolean;
    baseUrl: string;
    requestTimeoutSeconds: number;
    localPacketsDevEnabled: boolean;
    indexAdminDevEnabled: boolean;
    requireLocalActiveModelForPrivateTools: boolean;
  };
  sourceIndex: {
    enabled: boolean;
    answerDevEnabled: boolean;
    corpusRegistry: SourceCorpusRegistryConfig;
    ingestionPolicies: {
      dropboxPersonal?: {
        policyPath?: string;
        policy?: SourceIngestionPolicy;
      };
    };
    /**
     * Folders the user has marked as not-for-ingestion. Source-neutral and
     * top-level under sourceIndex rather than nested inside a per-source
     * policy, because setup writes it once for every connector the user has.
     */
    ingestionExclusions?: SourceIngestionExclusions;
    ingestionExclusionsPath?: string;
  };
  // Stripped together with their DEFAULT_CONFIG entries, env overrides, and
  // merges so the public runtime's config TYPE is as honest as its value: the
  // packaged build genuinely has no private-lane sections, and the stripped
  // source still type-checks (test/public-runtime-config-defaults.test.ts).
  // A new private-lane section must be marked here AND in DEFAULT_CONFIG, or
  // in neither.
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  fileDelivery: {
    enabled: boolean;
    baseUrl: string;
    requestTimeoutSeconds: number;
  };
  castorWorkspace: {
    enabled: boolean;
    baseUrl: string;
    requestTimeoutSeconds: number;
  };
  domainExpert: {
    enabled: boolean;
    liveToolsEnabled: boolean;
    baseUrl: string;
    requestTimeoutSeconds: number;
    authToken?: string;
    /**
     * Domain id injected into domain-expert requests that omit one. The legacy
     * worker defaulted omissions to `governance` inside normalizeDomainId; the
     * Expert-Agents worker is tenant-neutral and refuses its own default
     * domain, so after the 3A cutover the tenant default belongs here — the
     * layer this deployment owns.
     */
    defaultDomainId?: string;
  };
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
}

const DEFAULT_CONFIG: OlympusConfig = {
  worker: {
    scheduler: {
      enabled: false,
      sourceIds: [],
      tickSeconds: 60,
      syncIntervalSeconds: 1_800,
      freshnessThresholdHours: 26,
      errorBackoffSeconds: 60,
      maxTransientRetries: 3,
    },
  },
  identity: {
    ownerName: 'the owner',
    assistantName: 'the calling assistant',
  },
  argus: {
    defaultLane: 'fast',
    defaultProfile: 'default_chat',
    transport: 'direct',
    requestTimeoutSeconds: 180,
    // The Delphi consumer contract (docs/reference/delphi-consumer-contract.md)
    // has one rule: name a profile, never a model. Backing models rotate
    // without notice — a hardcoded id here is how the 2026-08-19 stale-model
    // bug happened. Every text/vision default targets the ROUTER through the
    // private-host tunnel (28090 -> delphi :8090) with a stable delphi/* profile id.
    lanes: {
      fast: {
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'delphi/default-chat',
      },
      deep: {
        // Legacy alias: the product now uses one healthy Delphi model pool.
        // Keep "deep" accepted for old callers, but do not require a second
        // endpoint to be alive.
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'delphi/default-chat',
      },
    },
    modelProfiles: {
      default_chat: {
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'delphi/default-chat',
        purpose: 'chat',
      },
      source_answer: {
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'delphi/source-answer',
        purpose: 'text_reasoning',
      },
      classification_fast: {
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'delphi/default-chat',
        purpose: 'classification',
      },
      embedding_secure_local: {
        // DELIBERATE exception to the profile rule for the MODEL ID only:
        // this id is pinned inside OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH, so
        // switching it to the router's delphi/embedding profile would change
        // epoch identity. The base URL carries no epoch weight and rides the
        // router like every other lane — the router serves the bare model id
        // with byte-identical vectors (proven 2026-08-20; the 28011 tunnel
        // forward is retired).
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'secure-local-qwen3-embed',
        purpose: 'embedding',
      },
      vlm_document: {
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'delphi/vision-quality',
        purpose: 'vision',
      },
      vlm_fast: {
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'delphi/vision-fast',
        purpose: 'vision',
      },
      vlm_qwen36_27b: {
        // Key name is a fossil from the model it once pinned; kept because it
        // is an enum value old callers send. It now means the OCR escalation
        // tier.
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'delphi/vision-deep',
        purpose: 'vision',
      },
      vlm_qwen36_35b: {
        // Fossil key, kept for old callers; normal-quality OCR tier.
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'delphi/vision-quality',
        purpose: 'vision',
      },
    },
  },
  email: {
    enabled: false,
    baseUrl: 'http://127.0.0.1:8010/v1',
    requestTimeoutSeconds: 180,
    localPacketsDevEnabled: false,
    indexAdminDevEnabled: false,
    requireLocalActiveModelForPrivateTools: false,
  },
  sourceIndex: {
    enabled: true,
    answerDevEnabled: false,
    corpusRegistry: defaultSourceCorpusRegistryConfig(),
    ingestionPolicies: {},
  },
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  fileDelivery: {
    enabled: false,
    baseUrl: 'http://127.0.0.1:8020/v1',
    requestTimeoutSeconds: 30,
  },
  castorWorkspace: {
    enabled: false,
    baseUrl: 'http://127.0.0.1:8030/v1',
    requestTimeoutSeconds: 300,
  },
  domainExpert: {
    enabled: false,
    liveToolsEnabled: false,
    baseUrl: 'http://127.0.0.1:8040/v1',
    requestTimeoutSeconds: 600,
  },
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
};

export function defaultConfig(): OlympusConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): OlympusConfig {
  const config = defaultConfig();
  const configPath = env.OLYMPUS_CONFIG ?? join(homedir(), '.olympus', 'config.json');

  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<OlympusConfig>;
    mergeConfig(config, raw);
  }

  if (env.OLYMPUS_ARGUS_DEFAULT_LANE) {
    config.argus.defaultLane = parseLane(env.OLYMPUS_ARGUS_DEFAULT_LANE);
  }
  if (env.OLYMPUS_WORKER_AUTH_TOKEN?.trim()) {
    config.worker.authToken = env.OLYMPUS_WORKER_AUTH_TOKEN.trim();
  }
  if (env.OLYMPUS_WORKER_SCHEDULER_ENABLED !== undefined) {
    config.worker.scheduler.enabled = parseBoolean(
      env.OLYMPUS_WORKER_SCHEDULER_ENABLED,
      'OLYMPUS_WORKER_SCHEDULER_ENABLED',
    );
  }
  if (env.OLYMPUS_WORKER_SCHEDULER_SOURCE_IDS !== undefined) {
    config.worker.scheduler.sourceIds = parseSchedulerSourceIds(env.OLYMPUS_WORKER_SCHEDULER_SOURCE_IDS);
  }
  if (env.OLYMPUS_WORKER_SCHEDULER_TICK_SECONDS) {
    config.worker.scheduler.tickSeconds = parsePositiveNumber(
      env.OLYMPUS_WORKER_SCHEDULER_TICK_SECONDS,
      'OLYMPUS_WORKER_SCHEDULER_TICK_SECONDS',
    );
  }
  if (env.OLYMPUS_WORKER_SCHEDULER_SYNC_INTERVAL_SECONDS) {
    config.worker.scheduler.syncIntervalSeconds = parsePositiveNumber(
      env.OLYMPUS_WORKER_SCHEDULER_SYNC_INTERVAL_SECONDS,
      'OLYMPUS_WORKER_SCHEDULER_SYNC_INTERVAL_SECONDS',
    );
  }
  if (env.OLYMPUS_WORKER_SCHEDULER_FRESHNESS_THRESHOLD_HOURS) {
    config.worker.scheduler.freshnessThresholdHours = parsePositiveNumber(
      env.OLYMPUS_WORKER_SCHEDULER_FRESHNESS_THRESHOLD_HOURS,
      'OLYMPUS_WORKER_SCHEDULER_FRESHNESS_THRESHOLD_HOURS',
    );
  }
  if (env.OLYMPUS_WORKER_SCHEDULER_ERROR_BACKOFF_SECONDS) {
    config.worker.scheduler.errorBackoffSeconds = parsePositiveNumber(
      env.OLYMPUS_WORKER_SCHEDULER_ERROR_BACKOFF_SECONDS,
      'OLYMPUS_WORKER_SCHEDULER_ERROR_BACKOFF_SECONDS',
    );
  }
  if (env.OLYMPUS_WORKER_SCHEDULER_MAX_TRANSIENT_RETRIES) {
    config.worker.scheduler.maxTransientRetries = parsePositiveNumber(
      env.OLYMPUS_WORKER_SCHEDULER_MAX_TRANSIENT_RETRIES,
      'OLYMPUS_WORKER_SCHEDULER_MAX_TRANSIENT_RETRIES',
    );
  }
  if (env.OLYMPUS_SOVEREIGNTY_CONFIG?.trim()) {
    config.sovereignty = {
      ...(config.sovereignty ?? {}),
      configPath: env.OLYMPUS_SOVEREIGNTY_CONFIG.trim(),
    };
  }
  if (env.OLYMPUS_SOVEREIGNTY_CONFIG_PATH?.trim()) {
    config.sovereignty = {
      ...(config.sovereignty ?? {}),
      configPath: env.OLYMPUS_SOVEREIGNTY_CONFIG_PATH.trim(),
    };
  }
  if (env.OLYMPUS_ARGUS_DEFAULT_PROFILE) {
    config.argus.defaultProfile = parseModelProfile(env.OLYMPUS_ARGUS_DEFAULT_PROFILE);
  }
  if (env.OLYMPUS_ARGUS_TRANSPORT) {
    config.argus.transport = parseTransport(env.OLYMPUS_ARGUS_TRANSPORT);
  }
  let fastLaneEnvChanged = false;
  if (env.OLYMPUS_ARGUS_FAST_BASE_URL) {
    config.argus.lanes.fast.baseUrl = trimTrailingSlash(env.OLYMPUS_ARGUS_FAST_BASE_URL);
    fastLaneEnvChanged = true;
  }
  if (env.OLYMPUS_ARGUS_DEEP_BASE_URL) {
    config.argus.lanes.deep.baseUrl = trimTrailingSlash(env.OLYMPUS_ARGUS_DEEP_BASE_URL);
  }
  if (env.OLYMPUS_ARGUS_FAST_MODEL) {
    config.argus.lanes.fast.model = env.OLYMPUS_ARGUS_FAST_MODEL;
    fastLaneEnvChanged = true;
  }
  if (env.OLYMPUS_ARGUS_DEEP_MODEL) {
    config.argus.lanes.deep.model = env.OLYMPUS_ARGUS_DEEP_MODEL;
  }
  if (fastLaneEnvChanged) {
    mirrorFastLaneToProfiles(config, ['default_chat', 'source_answer']);
  }
  applyModelProfileEnv(config, 'default_chat', env, 'OLYMPUS_ARGUS_DEFAULT_CHAT');
  applyModelProfileEnv(config, 'source_answer', env, 'OLYMPUS_ARGUS_SOURCE_ANSWER');
  applyModelProfileEnv(config, 'classification_fast', env, 'OLYMPUS_ARGUS_CLASSIFICATION_FAST');
  applyModelProfileEnv(config, 'embedding_secure_local', env, 'OLYMPUS_ARGUS_EMBEDDING_SECURE_LOCAL');
  applyModelProfileEnv(config, 'vlm_document', env, 'OLYMPUS_ARGUS_VLM_DOCUMENT');
  applyModelProfileEnv(config, 'vlm_fast', env, 'OLYMPUS_ARGUS_VLM_FAST');
  applyModelProfileEnv(config, 'vlm_qwen36_27b', env, 'OLYMPUS_ARGUS_VLM_QWEN36_27B');
  applyModelProfileEnv(config, 'vlm_qwen36_35b', env, 'OLYMPUS_ARGUS_VLM_QWEN36_35B');
  if (env.OLYMPUS_ARGUS_REQUEST_TIMEOUT_SECONDS) {
    config.argus.requestTimeoutSeconds = parsePositiveNumber(
      env.OLYMPUS_ARGUS_REQUEST_TIMEOUT_SECONDS,
      'OLYMPUS_ARGUS_REQUEST_TIMEOUT_SECONDS',
    );
  }
  if (env.OLYMPUS_EMAIL_ENABLED) {
    config.email.enabled = parseBoolean(env.OLYMPUS_EMAIL_ENABLED, 'OLYMPUS_EMAIL_ENABLED');
  }
  if (env.OLYMPUS_EMAIL_BASE_URL) {
    config.email.baseUrl = normalizeSourceWorkerBaseUrl(env.OLYMPUS_EMAIL_BASE_URL);
  }
  if (env.OLYMPUS_EMAIL_REQUEST_TIMEOUT_SECONDS) {
    config.email.requestTimeoutSeconds = parsePositiveNumber(
      env.OLYMPUS_EMAIL_REQUEST_TIMEOUT_SECONDS,
      'OLYMPUS_EMAIL_REQUEST_TIMEOUT_SECONDS',
    );
  }
  if (env.OLYMPUS_ENABLE_UNGUARDED_LOCAL_EMAIL_PACKETS_FOR_DEV) {
    config.email.localPacketsDevEnabled = parseBoolean(
      env.OLYMPUS_ENABLE_UNGUARDED_LOCAL_EMAIL_PACKETS_FOR_DEV,
      'OLYMPUS_ENABLE_UNGUARDED_LOCAL_EMAIL_PACKETS_FOR_DEV',
    );
  }
  if (env.OLYMPUS_ENABLE_EMAIL_INDEX_ADMIN_FOR_DEV) {
    config.email.indexAdminDevEnabled = parseBoolean(
      env.OLYMPUS_ENABLE_EMAIL_INDEX_ADMIN_FOR_DEV,
      'OLYMPUS_ENABLE_EMAIL_INDEX_ADMIN_FOR_DEV',
    );
  }
  if (env.OLYMPUS_REQUIRE_LOCAL_ACTIVE_MODEL_FOR_PRIVATE_EMAIL_TOOLS) {
    config.email.requireLocalActiveModelForPrivateTools = parseBoolean(
      env.OLYMPUS_REQUIRE_LOCAL_ACTIVE_MODEL_FOR_PRIVATE_EMAIL_TOOLS,
      'OLYMPUS_REQUIRE_LOCAL_ACTIVE_MODEL_FOR_PRIVATE_EMAIL_TOOLS',
    );
  }
  if (env.OLYMPUS_SOURCE_INDEX_ENABLED) {
    config.sourceIndex.enabled = parseBoolean(
      env.OLYMPUS_SOURCE_INDEX_ENABLED,
      'OLYMPUS_SOURCE_INDEX_ENABLED',
    );
  }
  if (env.OLYMPUS_SOURCE_INDEX_ANSWER_DEV_ENABLED) {
    config.sourceIndex.answerDevEnabled = parseBoolean(
      env.OLYMPUS_SOURCE_INDEX_ANSWER_DEV_ENABLED,
      'OLYMPUS_SOURCE_INDEX_ANSWER_DEV_ENABLED',
    );
  }
  if (env.OLYMPUS_SOURCE_INDEX_CORPUS_REGISTRY_PATH?.trim()) {
    config.sourceIndex.corpusRegistry = parseSourceCorpusRegistryConfig(
      JSON.parse(readFileSync(env.OLYMPUS_SOURCE_INDEX_CORPUS_REGISTRY_PATH.trim(), 'utf8')) as unknown,
    );
  }
  if (env[SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]?.trim()) {
    config.sourceIndex.ingestionExclusionsPath = env[SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]!.trim();
  }
  if (env.OLYMPUS_DROPBOX_INGESTION_POLICY_PATH?.trim()) {
    config.sourceIndex.ingestionPolicies.dropboxPersonal = {
      ...(config.sourceIndex.ingestionPolicies.dropboxPersonal ?? {}),
      policyPath: env.OLYMPUS_DROPBOX_INGESTION_POLICY_PATH.trim(),
    };
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  if (env.OLYMPUS_FILE_DELIVERY_ENABLED) {
    config.fileDelivery.enabled = parseBoolean(
      env.OLYMPUS_FILE_DELIVERY_ENABLED,
      'OLYMPUS_FILE_DELIVERY_ENABLED',
    );
  }
  if (env.OLYMPUS_FILE_DELIVERY_BASE_URL) {
    config.fileDelivery.baseUrl = trimTrailingSlash(env.OLYMPUS_FILE_DELIVERY_BASE_URL);
  }
  if (env.OLYMPUS_FILE_DELIVERY_REQUEST_TIMEOUT_SECONDS) {
    config.fileDelivery.requestTimeoutSeconds = parsePositiveNumber(
      env.OLYMPUS_FILE_DELIVERY_REQUEST_TIMEOUT_SECONDS,
      'OLYMPUS_FILE_DELIVERY_REQUEST_TIMEOUT_SECONDS',
    );
  }
  if (env.OLYMPUS_CASTOR_WORKSPACE_ENABLED) {
    config.castorWorkspace.enabled = parseBoolean(
      env.OLYMPUS_CASTOR_WORKSPACE_ENABLED,
      'OLYMPUS_CASTOR_WORKSPACE_ENABLED',
    );
  }
  if (env.OLYMPUS_CASTOR_WORKSPACE_BASE_URL) {
    config.castorWorkspace.baseUrl = trimTrailingSlash(env.OLYMPUS_CASTOR_WORKSPACE_BASE_URL);
  }
  if (env.OLYMPUS_CASTOR_WORKSPACE_REQUEST_TIMEOUT_SECONDS) {
    config.castorWorkspace.requestTimeoutSeconds = parsePositiveNumber(
      env.OLYMPUS_CASTOR_WORKSPACE_REQUEST_TIMEOUT_SECONDS,
      'OLYMPUS_CASTOR_WORKSPACE_REQUEST_TIMEOUT_SECONDS',
    );
  }
  if (env.OLYMPUS_DOMAIN_EXPERT_ENABLED) {
    config.domainExpert.enabled = parseBoolean(
      env.OLYMPUS_DOMAIN_EXPERT_ENABLED,
      'OLYMPUS_DOMAIN_EXPERT_ENABLED',
    );
  }
  if (env.OLYMPUS_DOMAIN_EXPERT_LIVE_TOOLS_ENABLED) {
    config.domainExpert.liveToolsEnabled = parseBoolean(
      env.OLYMPUS_DOMAIN_EXPERT_LIVE_TOOLS_ENABLED,
      'OLYMPUS_DOMAIN_EXPERT_LIVE_TOOLS_ENABLED',
    );
  }
  if (env.OLYMPUS_DOMAIN_EXPERT_BASE_URL) {
    config.domainExpert.baseUrl = trimTrailingSlash(env.OLYMPUS_DOMAIN_EXPERT_BASE_URL);
  }
  if (env.OLYMPUS_DOMAIN_EXPERT_REQUEST_TIMEOUT_SECONDS) {
    config.domainExpert.requestTimeoutSeconds = parsePositiveNumber(
      env.OLYMPUS_DOMAIN_EXPERT_REQUEST_TIMEOUT_SECONDS,
      'OLYMPUS_DOMAIN_EXPERT_REQUEST_TIMEOUT_SECONDS',
    );
  }
  if (env.OLYMPUS_DOMAIN_EXPERT_AUTH_TOKEN) {
    config.domainExpert.authToken = env.OLYMPUS_DOMAIN_EXPERT_AUTH_TOKEN.trim();
  }
  if (env.OLYMPUS_DOMAIN_EXPERT_DEFAULT_DOMAIN_ID) {
    config.domainExpert.defaultDomainId = env.OLYMPUS_DOMAIN_EXPERT_DEFAULT_DOMAIN_ID.trim();
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

  validateConfig(config);
  return config;
}

export function configFromPluginConfig(pluginConfig: unknown): OlympusConfig {
  const config = defaultConfig();
  const root = asRecord(pluginConfig);
  const sovereignty = asRecord(root?.sovereignty);
  const worker = asRecord(root?.worker);
  const identity = asRecord(root?.identity);
  const argus = asRecord(root?.argus);
  const email = asRecord(root?.email);
  const sourceIndex = asRecord(root?.sourceIndex);
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  const fileDelivery = asRecord(root?.fileDelivery);
  const castorWorkspace = asRecord(root?.castorWorkspace);
  const domainExpert = asRecord(root?.domainExpert);
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

  if (sovereignty) {
    config.sovereignty = {};
    if (typeof sovereignty.configPath === 'string' && sovereignty.configPath.trim()) {
      config.sovereignty.configPath = sovereignty.configPath.trim();
    }
    if (sovereignty.schemaVersion === 1) {
      config.sovereignty.policy = sovereignty as unknown as SovereigntyConfig;
    } else if (asRecord(sovereignty.policy)) {
      config.sovereignty.policy = sovereignty.policy as unknown as SovereigntyConfig;
    }
  }

  if (typeof worker?.authToken === 'string' && worker.authToken.trim()) {
    config.worker.authToken = worker.authToken.trim();
  }
  const scheduler = asRecord(worker?.scheduler);
  if (scheduler) {
    if (typeof scheduler.enabled === 'boolean') {
      config.worker.scheduler.enabled = scheduler.enabled;
    }
    if (Array.isArray(scheduler.sourceIds)) {
      config.worker.scheduler.sourceIds = parseSchedulerSourceIds(scheduler.sourceIds);
    }
    if (typeof scheduler.tickSeconds === 'number') {
      config.worker.scheduler.tickSeconds = scheduler.tickSeconds;
    }
    if (typeof scheduler.syncIntervalSeconds === 'number') {
      config.worker.scheduler.syncIntervalSeconds = scheduler.syncIntervalSeconds;
    }
    if (typeof scheduler.freshnessThresholdHours === 'number') {
      config.worker.scheduler.freshnessThresholdHours = scheduler.freshnessThresholdHours;
    }
    if (typeof scheduler.errorBackoffSeconds === 'number') {
      config.worker.scheduler.errorBackoffSeconds = scheduler.errorBackoffSeconds;
    }
    if (typeof scheduler.maxTransientRetries === 'number') {
      config.worker.scheduler.maxTransientRetries = scheduler.maxTransientRetries;
    }
  }
  if (typeof identity?.ownerName === 'string' && identity.ownerName.trim()) {
    config.identity.ownerName = identity.ownerName.trim();
  }
  if (typeof identity?.assistantName === 'string' && identity.assistantName.trim()) {
    config.identity.assistantName = identity.assistantName.trim();
  }

  if (typeof argus?.defaultLane === 'string') {
    config.argus.defaultLane = parseLane(argus.defaultLane);
  }
  if (typeof argus?.defaultProfile === 'string') {
    config.argus.defaultProfile = parseModelProfile(argus.defaultProfile);
  }
  if (typeof argus?.transport === 'string') {
    config.argus.transport = parseTransport(argus.transport);
  }
  if (typeof argus?.requestTimeoutSeconds === 'number') {
    config.argus.requestTimeoutSeconds = argus.requestTimeoutSeconds;
  }

  const lanes = asRecord(argus?.lanes);
  applyLaneConfig(config, 'fast', asRecord(lanes?.fast));
  applyLaneConfig(config, 'deep', asRecord(lanes?.deep));
  if (asRecord(lanes?.fast)) {
    mirrorFastLaneToProfiles(config, ['default_chat', 'source_answer']);
  }
  const modelProfiles = asRecord(argus?.modelProfiles);
  for (const profile of ARGUS_MODEL_PROFILES) {
    applyModelProfileConfig(config, profile, asRecord(modelProfiles?.[profile]));
  }

  // Compatibility with the first v0.1 local install shape. New installs should
  // prefer plugins.entries.olympus.config.argus.
  if (typeof root?.argus_default_lane === 'string') {
    config.argus.defaultLane = parseLane(root.argus_default_lane);
  }
  let flatFastLaneChanged = false;
  if (typeof root?.argus_fast_base_url === 'string') {
    config.argus.lanes.fast.baseUrl = trimTrailingSlash(root.argus_fast_base_url);
    flatFastLaneChanged = true;
  }
  if (typeof root?.argus_deep_base_url === 'string') {
    config.argus.lanes.deep.baseUrl = trimTrailingSlash(root.argus_deep_base_url);
  }
  if (typeof root?.argus_fast_model === 'string') {
    config.argus.lanes.fast.model = root.argus_fast_model;
    flatFastLaneChanged = true;
  }
  if (typeof root?.argus_deep_model === 'string') {
    config.argus.lanes.deep.model = root.argus_deep_model;
  }
  if (flatFastLaneChanged) {
    const targets: ArgusModelProfile[] = [];
    if (!asRecord(modelProfiles?.default_chat)) targets.push('default_chat');
    if (!asRecord(modelProfiles?.source_answer)) targets.push('source_answer');
    mirrorFastLaneToProfiles(config, targets);
  }

  if (typeof email?.enabled === 'boolean') {
    config.email.enabled = email.enabled;
  }
  if (typeof email?.baseUrl === 'string' && email.baseUrl.trim()) {
    config.email.baseUrl = normalizeSourceWorkerBaseUrl(email.baseUrl);
  }
  if (typeof email?.requestTimeoutSeconds === 'number') {
    config.email.requestTimeoutSeconds = email.requestTimeoutSeconds;
  }
  if (typeof email?.localPacketsDevEnabled === 'boolean') {
    config.email.localPacketsDevEnabled = email.localPacketsDevEnabled;
  }
  if (typeof email?.indexAdminDevEnabled === 'boolean') {
    config.email.indexAdminDevEnabled = email.indexAdminDevEnabled;
  }
  if (typeof email?.requireLocalActiveModelForPrivateTools === 'boolean') {
    config.email.requireLocalActiveModelForPrivateTools = email.requireLocalActiveModelForPrivateTools;
  }
  if (typeof sourceIndex?.answerDevEnabled === 'boolean') {
    config.sourceIndex.answerDevEnabled = sourceIndex.answerDevEnabled;
  }
  if (typeof sourceIndex?.enabled === 'boolean') {
    config.sourceIndex.enabled = sourceIndex.enabled;
  }
  const corpusRegistry = asRecord(sourceIndex?.corpusRegistry);
  if (corpusRegistry) {
    config.sourceIndex.corpusRegistry = parsePublicSourceCorpusRegistryConfig(corpusRegistry);
  }
  const corpora = sourceIndex?.corpora;
  if (Array.isArray(corpora)) {
    config.sourceIndex.corpusRegistry = parsePublicSourceCorpusRegistryConfig({
      schemaVersion: 1,
      corpora,
    });
  }
  const ingestionExclusions = asRecord(sourceIndex?.ingestionExclusions);
  if (ingestionExclusions) {
    config.sourceIndex.ingestionExclusions = parseSourceIngestionExclusions(
      ingestionExclusions,
      'sourceIndex.ingestionExclusions',
    );
  }
  if (typeof sourceIndex?.ingestionExclusionsPath === 'string' && sourceIndex.ingestionExclusionsPath.trim()) {
    config.sourceIndex.ingestionExclusionsPath = sourceIndex.ingestionExclusionsPath.trim();
  }
  const ingestionPolicies = asRecord(sourceIndex?.ingestionPolicies);
  const dropboxPersonal = asRecord(ingestionPolicies?.dropboxPersonal);
  if (dropboxPersonal) {
    config.sourceIndex.ingestionPolicies.dropboxPersonal = {};
    if (typeof dropboxPersonal.policyPath === 'string' && dropboxPersonal.policyPath.trim()) {
      config.sourceIndex.ingestionPolicies.dropboxPersonal.policyPath = dropboxPersonal.policyPath.trim();
    }
    if (asRecord(dropboxPersonal.policy)) {
      config.sourceIndex.ingestionPolicies.dropboxPersonal.policy = parseSourceIngestionPolicy(
        dropboxPersonal.policy,
        'sourceIndex.ingestionPolicies.dropboxPersonal.policy',
      );
    } else if (dropboxPersonal.schemaVersion === 1) {
      config.sourceIndex.ingestionPolicies.dropboxPersonal.policy = parseSourceIngestionPolicy(
        dropboxPersonal,
        'sourceIndex.ingestionPolicies.dropboxPersonal',
      );
    }
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  if (typeof fileDelivery?.enabled === 'boolean') {
    config.fileDelivery.enabled = fileDelivery.enabled;
  }
  if (typeof fileDelivery?.baseUrl === 'string' && fileDelivery.baseUrl.trim()) {
    config.fileDelivery.baseUrl = trimTrailingSlash(fileDelivery.baseUrl.trim());
  }
  if (typeof fileDelivery?.requestTimeoutSeconds === 'number') {
    config.fileDelivery.requestTimeoutSeconds = fileDelivery.requestTimeoutSeconds;
  }
  if (typeof castorWorkspace?.enabled === 'boolean') {
    config.castorWorkspace.enabled = castorWorkspace.enabled;
  }
  if (typeof castorWorkspace?.baseUrl === 'string' && castorWorkspace.baseUrl.trim()) {
    config.castorWorkspace.baseUrl = trimTrailingSlash(castorWorkspace.baseUrl.trim());
  }
  if (typeof castorWorkspace?.requestTimeoutSeconds === 'number') {
    config.castorWorkspace.requestTimeoutSeconds = castorWorkspace.requestTimeoutSeconds;
  }
  if (typeof domainExpert?.enabled === 'boolean') {
    config.domainExpert.enabled = domainExpert.enabled;
  }
  if (typeof domainExpert?.liveToolsEnabled === 'boolean') {
    config.domainExpert.liveToolsEnabled = domainExpert.liveToolsEnabled;
  }
  if (typeof domainExpert?.baseUrl === 'string' && domainExpert.baseUrl.trim()) {
    config.domainExpert.baseUrl = trimTrailingSlash(domainExpert.baseUrl.trim());
  }
  if (typeof domainExpert?.requestTimeoutSeconds === 'number') {
    config.domainExpert.requestTimeoutSeconds = domainExpert.requestTimeoutSeconds;
  }
  if (typeof domainExpert?.authToken === 'string' && domainExpert.authToken.trim()) {
    config.domainExpert.authToken = domainExpert.authToken.trim();
  }
  if (typeof domainExpert?.defaultDomainId === 'string' && domainExpert.defaultDomainId.trim()) {
    config.domainExpert.defaultDomainId = domainExpert.defaultDomainId.trim();
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

  validateConfig(config);
  return config;
}

export function resolveLane(config: OlympusConfig, lane?: unknown): ArgusLane {
  return lane === undefined || lane === null || lane === ''
    ? config.argus.defaultLane
    : parseLane(String(lane));
}

export function isSourceIndexReadSurfaceEnabled(config: OlympusConfig): boolean {
  return config.sourceIndex.enabled || config.sourceIndex.answerDevEnabled;
}

export function resolveModelProfile(
  config: OlympusConfig,
  profile?: unknown,
): ArgusModelProfile {
  return profile === undefined || profile === null || profile === ''
    ? config.argus.defaultProfile
    : parseModelProfile(String(profile));
}

const ARGUS_MODEL_PROFILES = [
  'default_chat',
  'source_answer',
  'classification_fast',
  'embedding_secure_local',
  'vlm_document',
  'vlm_fast',
  'vlm_qwen36_27b',
  'vlm_qwen36_35b',
] as const;

export function parseModelProfile(value: string): ArgusModelProfile {
  if ((ARGUS_MODEL_PROFILES as readonly string[]).includes(value)) {
    return value as ArgusModelProfile;
  }
  throw new OperationError(
    'invalid_params',
    `Unsupported Argus model profile: ${value}`,
    `Use one of: ${ARGUS_MODEL_PROFILES.join(', ')}.`,
  );
}

export function parseLane(value: string): ArgusLane {
  if (value === 'fast' || value === 'deep') return value;
  throw new OperationError(
    'invalid_params',
    `Unsupported Argus lane: ${value}`,
    'Use lane "fast" for interactive work or "deep" for slower sensitive/document work.',
  );
}

export function parseTransport(value: string): ArgusTransport {
  if (value === 'direct') return value;
  throw new OperationError(
    'invalid_params',
    `Unsupported Argus transport: ${value}`,
    'Use transport "direct" with a local or runtime-managed Argus endpoint.',
  );
}

function mergeConfig(target: OlympusConfig, source: Partial<OlympusConfig>): void {
  if (source.sovereignty) {
    target.sovereignty = { ...(target.sovereignty ?? {}), ...source.sovereignty };
  }
  if (source.worker) {
    target.worker = {
      ...target.worker,
      ...source.worker,
      scheduler: {
        ...target.worker.scheduler,
        ...(source.worker.scheduler ?? {}),
      },
    };
  }
  if (source.identity) {
    target.identity = { ...target.identity, ...source.identity };
  }
  if (source.argus) {
    if (source.argus.defaultLane) target.argus.defaultLane = source.argus.defaultLane;
    if (source.argus.defaultProfile) target.argus.defaultProfile = source.argus.defaultProfile;
    if (source.argus.transport) target.argus.transport = source.argus.transport;
    if (source.argus.requestTimeoutSeconds) {
      target.argus.requestTimeoutSeconds = source.argus.requestTimeoutSeconds;
    }
    if (source.argus.lanes?.fast) {
      target.argus.lanes.fast = { ...target.argus.lanes.fast, ...source.argus.lanes.fast };
      mirrorFastLaneToProfiles(target, ['default_chat', 'source_answer']);
    }
    if (source.argus.lanes?.deep) {
      target.argus.lanes.deep = { ...target.argus.lanes.deep, ...source.argus.lanes.deep };
    }
    if (source.argus.modelProfiles) {
      for (const profile of ARGUS_MODEL_PROFILES) {
        const sourceProfile = source.argus.modelProfiles[profile];
        if (sourceProfile) {
          target.argus.modelProfiles[profile] = {
            ...target.argus.modelProfiles[profile],
            ...sourceProfile,
          };
        }
      }
    }
  }
  if (source.email) {
    target.email = { ...target.email, ...source.email };
    if (typeof target.email.baseUrl === 'string') {
      target.email.baseUrl = normalizeSourceWorkerBaseUrl(target.email.baseUrl);
    }
  }
  if (source.sourceIndex) {
    target.sourceIndex = {
      ...target.sourceIndex,
      ...source.sourceIndex,
      corpusRegistry: source.sourceIndex.corpusRegistry ?? target.sourceIndex.corpusRegistry,
      // Exclusions merge by replacement, not union: a user editing their list
      // to REMOVE a folder must actually remove it, and a union would make an
      // exclusion impossible to retract from a lower-precedence layer.
      ...(source.sourceIndex.ingestionExclusions
        ? { ingestionExclusions: source.sourceIndex.ingestionExclusions }
        : {}),
      ...(source.sourceIndex.ingestionExclusionsPath
        ? { ingestionExclusionsPath: source.sourceIndex.ingestionExclusionsPath }
        : {}),
      ingestionPolicies: {
        ...target.sourceIndex.ingestionPolicies,
        ...(source.sourceIndex.ingestionPolicies ?? {}),
      },
    };
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  if (source.fileDelivery) {
    target.fileDelivery = { ...target.fileDelivery, ...source.fileDelivery };
  }
  if (source.castorWorkspace) {
    target.castorWorkspace = { ...target.castorWorkspace, ...source.castorWorkspace };
  }
  if (source.domainExpert) {
    target.domainExpert = { ...target.domainExpert, ...source.domainExpert };
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
}

function mirrorFastLaneToProfiles(config: OlympusConfig, profiles: ArgusModelProfile[]): void {
  for (const profile of profiles) {
    config.argus.modelProfiles[profile] = {
      ...config.argus.modelProfiles[profile],
      baseUrl: config.argus.lanes.fast.baseUrl,
      model: config.argus.lanes.fast.model,
    };
  }
}

function applyLaneConfig(
  config: OlympusConfig,
  lane: ArgusLane,
  laneConfig: Record<string, unknown> | undefined,
): void {
  if (!laneConfig) return;
  if (typeof laneConfig.baseUrl === 'string' && laneConfig.baseUrl.trim()) {
    config.argus.lanes[lane].baseUrl = trimTrailingSlash(laneConfig.baseUrl.trim());
  }
  if (typeof laneConfig.model === 'string' && laneConfig.model.trim()) {
    config.argus.lanes[lane].model = laneConfig.model.trim();
  }
  if (typeof laneConfig.secretRef === 'string' && laneConfig.secretRef.trim()) {
    config.argus.lanes[lane].secretRef = laneConfig.secretRef.trim();
  }
}

function applyModelProfileConfig(
  config: OlympusConfig,
  profile: ArgusModelProfile,
  profileConfig: Record<string, unknown> | undefined,
): void {
  if (!profileConfig) return;
  if (typeof profileConfig.baseUrl === 'string' && profileConfig.baseUrl.trim()) {
    config.argus.modelProfiles[profile].baseUrl = trimTrailingSlash(profileConfig.baseUrl.trim());
  }
  if (typeof profileConfig.model === 'string' && profileConfig.model.trim()) {
    config.argus.modelProfiles[profile].model = profileConfig.model.trim();
  }
  if (typeof profileConfig.secretRef === 'string' && profileConfig.secretRef.trim()) {
    config.argus.modelProfiles[profile].secretRef = profileConfig.secretRef.trim();
  }
  if (
    typeof profileConfig.purpose === 'string'
    && ARGUS_MODEL_PROFILE_PURPOSES.includes(profileConfig.purpose as ArgusModelProfileConfig['purpose'])
  ) {
    config.argus.modelProfiles[profile].purpose = profileConfig.purpose as ArgusModelProfileConfig['purpose'];
  }
}

function applyModelProfileEnv(
  config: OlympusConfig,
  profile: ArgusModelProfile,
  env: Record<string, string | undefined>,
  prefix: string,
): void {
  const baseUrl = env[`${prefix}_BASE_URL`];
  const model = env[`${prefix}_MODEL`];
  const secretRef = env[`${prefix}_SECRET_REF`];
  if (baseUrl) config.argus.modelProfiles[profile].baseUrl = trimTrailingSlash(baseUrl);
  if (model) config.argus.modelProfiles[profile].model = model;
  if (secretRef?.trim()) config.argus.modelProfiles[profile].secretRef = secretRef.trim();
}

function validateConfig(config: OlympusConfig): void {
  if (config.sovereignty?.configPath !== undefined) {
    if (typeof config.sovereignty.configPath !== 'string' || !config.sovereignty.configPath.trim()) {
      throw new OperationError('config_error', 'sovereignty.configPath must be a non-empty string.');
    }
    config.sovereignty.configPath = config.sovereignty.configPath.trim();
  }
  if (config.worker.authToken !== undefined) {
    if (typeof config.worker.authToken !== 'string') {
      throw new OperationError('config_error', 'worker.authToken must be a string.');
    }
    const trimmed = config.worker.authToken.trim();
    if (trimmed) {
      config.worker.authToken = trimmed;
    } else {
      delete config.worker.authToken;
    }
  }
  assertBoolean(config.worker.scheduler.enabled, 'worker.scheduler.enabled');
  // An enabled scheduler with an empty allowlist is valid and idle. `olympus
  // setup` installs the worker BEFORE any source is connected, so demanding a
  // non-empty allowlist at that point made every fresh install fail to boot:
  // the only honest allowlist on a machine with no connected sources is the
  // empty one. Empty means "no operator restriction" — the worker constructs a
  // lane only for a source that actually has a connected handle, and the
  // dashboard connect flow rebuilds the scheduler's sources at runtime.
  config.worker.scheduler.sourceIds = parseSchedulerSourceIds(config.worker.scheduler.sourceIds);
  assertPositiveNumber(config.worker.scheduler.tickSeconds, 'worker.scheduler.tickSeconds');
  assertPositiveNumber(config.worker.scheduler.syncIntervalSeconds, 'worker.scheduler.syncIntervalSeconds');
  assertPositiveNumber(config.worker.scheduler.freshnessThresholdHours, 'worker.scheduler.freshnessThresholdHours');
  assertPositiveNumber(config.worker.scheduler.errorBackoffSeconds, 'worker.scheduler.errorBackoffSeconds');
  assertPositiveInteger(config.worker.scheduler.maxTransientRetries, 'worker.scheduler.maxTransientRetries');
  if (typeof config.identity.ownerName !== 'string' || !config.identity.ownerName.trim()) {
    throw new OperationError('config_error', 'identity.ownerName must be a non-empty string.');
  }
  config.identity.ownerName = config.identity.ownerName.trim();
  if (typeof config.identity.assistantName !== 'string' || !config.identity.assistantName.trim()) {
    throw new OperationError('config_error', 'identity.assistantName must be a non-empty string.');
  }
  config.identity.assistantName = config.identity.assistantName.trim();
  parseLane(config.argus.defaultLane);
  parseModelProfile(config.argus.defaultProfile);
  parseTransport(config.argus.transport);
  if (
    typeof config.argus.requestTimeoutSeconds !== 'number'
    || !Number.isFinite(config.argus.requestTimeoutSeconds)
    || config.argus.requestTimeoutSeconds <= 0
  ) {
    throw new OperationError('config_error', 'argus.requestTimeoutSeconds must be greater than zero.');
  }
  for (const lane of ['fast', 'deep'] as const) {
    const laneConfig = config.argus.lanes[lane];
    if (
      typeof laneConfig.baseUrl !== 'string'
      || (!laneConfig.baseUrl.startsWith('http://') && !laneConfig.baseUrl.startsWith('https://'))
    ) {
      throw new OperationError('config_error', `${lane} baseUrl must be an HTTP(S) URL.`);
    }
    laneConfig.baseUrl = trimTrailingSlash(laneConfig.baseUrl);
    if (typeof laneConfig.model !== 'string' || !laneConfig.model.trim()) {
      throw new OperationError('config_error', `${lane} model must be configured.`);
    }
    validateSecretRef(laneConfig.secretRef, `${lane} secretRef`);
  }
  for (const profile of ARGUS_MODEL_PROFILES) {
    const profileConfig = config.argus.modelProfiles[profile];
    if (
      typeof profileConfig.baseUrl !== 'string'
      || (!profileConfig.baseUrl.startsWith('http://') && !profileConfig.baseUrl.startsWith('https://'))
    ) {
      throw new OperationError('config_error', `${profile} baseUrl must be an HTTP(S) URL.`);
    }
    profileConfig.baseUrl = trimTrailingSlash(profileConfig.baseUrl);
    if (typeof profileConfig.model !== 'string' || !profileConfig.model.trim()) {
      throw new OperationError('config_error', `${profile} model must be configured.`);
    }
    validateSecretRef(profileConfig.secretRef, `${profile} secretRef`);
  }
  assertBoolean(config.email.enabled, 'email.enabled');
  assertBoolean(config.email.localPacketsDevEnabled, 'email.localPacketsDevEnabled');
  assertBoolean(config.email.indexAdminDevEnabled, 'email.indexAdminDevEnabled');
  assertBoolean(config.email.requireLocalActiveModelForPrivateTools, 'email.requireLocalActiveModelForPrivateTools');
  assertBoolean(config.sourceIndex.enabled, 'sourceIndex.enabled');
  assertBoolean(config.sourceIndex.answerDevEnabled, 'sourceIndex.answerDevEnabled');
  config.sourceIndex.corpusRegistry = parseSourceCorpusRegistryConfig(config.sourceIndex.corpusRegistry);
  if (config.sourceIndex.ingestionPolicies.dropboxPersonal?.policyPath !== undefined) {
    const policyPath = config.sourceIndex.ingestionPolicies.dropboxPersonal.policyPath.trim();
    if (!policyPath) {
      throw new OperationError('config_error', 'sourceIndex.ingestionPolicies.dropboxPersonal.policyPath must be a non-empty string.');
    }
    config.sourceIndex.ingestionPolicies.dropboxPersonal.policyPath = policyPath;
  }
  if (config.sourceIndex.ingestionPolicies.dropboxPersonal?.policy !== undefined) {
    config.sourceIndex.ingestionPolicies.dropboxPersonal.policy = parseSourceIngestionPolicy(
      config.sourceIndex.ingestionPolicies.dropboxPersonal.policy,
      'sourceIndex.ingestionPolicies.dropboxPersonal.policy',
    );
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  assertBoolean(config.fileDelivery.enabled, 'fileDelivery.enabled');
  assertBoolean(config.castorWorkspace.enabled, 'castorWorkspace.enabled');
  if (config.domainExpert.defaultDomainId !== undefined) {
    if (typeof config.domainExpert.defaultDomainId !== 'string') {
      throw new OperationError('config_error', 'domainExpert.defaultDomainId must be a string.');
    }
    const trimmed = config.domainExpert.defaultDomainId.trim();
    if (trimmed) {
      config.domainExpert.defaultDomainId = trimmed;
    } else {
      delete config.domainExpert.defaultDomainId;
    }
  }
  if (config.domainExpert.authToken !== undefined) {
    if (typeof config.domainExpert.authToken !== 'string') {
      throw new OperationError('config_error', 'domainExpert.authToken must be a string.');
    }
    const trimmed = config.domainExpert.authToken.trim();
    if (trimmed) {
      config.domainExpert.authToken = trimmed;
    } else {
      delete config.domainExpert.authToken;
    }
  }
  assertBoolean(config.domainExpert.enabled, 'domainExpert.enabled');
  assertBoolean(config.domainExpert.liveToolsEnabled, 'domainExpert.liveToolsEnabled');
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
  if (
    typeof config.email.baseUrl !== 'string'
    || (!config.email.baseUrl.startsWith('http://') && !config.email.baseUrl.startsWith('https://'))
  ) {
    throw new OperationError('config_error', 'email.baseUrl must be an HTTP(S) URL.');
  }
  config.email.baseUrl = normalizeSourceWorkerBaseUrl(config.email.baseUrl);
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  if (
    typeof config.fileDelivery.baseUrl !== 'string'
    || (!config.fileDelivery.baseUrl.startsWith('http://') && !config.fileDelivery.baseUrl.startsWith('https://'))
  ) {
    throw new OperationError('config_error', 'fileDelivery.baseUrl must be an HTTP(S) URL.');
  }
  config.fileDelivery.baseUrl = trimTrailingSlash(config.fileDelivery.baseUrl);
  if (
    typeof config.castorWorkspace.baseUrl !== 'string'
    || (!config.castorWorkspace.baseUrl.startsWith('http://') && !config.castorWorkspace.baseUrl.startsWith('https://'))
  ) {
    throw new OperationError('config_error', 'castorWorkspace.baseUrl must be an HTTP(S) URL.');
  }
  config.castorWorkspace.baseUrl = trimTrailingSlash(config.castorWorkspace.baseUrl);
  if (
    typeof config.domainExpert.baseUrl !== 'string'
    || (!config.domainExpert.baseUrl.startsWith('http://') && !config.domainExpert.baseUrl.startsWith('https://'))
  ) {
    throw new OperationError('config_error', 'domainExpert.baseUrl must be an HTTP(S) URL.');
  }
  config.domainExpert.baseUrl = trimTrailingSlash(config.domainExpert.baseUrl);
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
  if (
    typeof config.email.requestTimeoutSeconds !== 'number'
    || !Number.isFinite(config.email.requestTimeoutSeconds)
    || config.email.requestTimeoutSeconds <= 0
  ) {
    throw new OperationError('config_error', 'email.requestTimeoutSeconds must be greater than zero.');
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  if (
    typeof config.fileDelivery.requestTimeoutSeconds !== 'number'
    || !Number.isFinite(config.fileDelivery.requestTimeoutSeconds)
    || config.fileDelivery.requestTimeoutSeconds <= 0
  ) {
    throw new OperationError('config_error', 'fileDelivery.requestTimeoutSeconds must be greater than zero.');
  }
  if (
    typeof config.castorWorkspace.requestTimeoutSeconds !== 'number'
    || !Number.isFinite(config.castorWorkspace.requestTimeoutSeconds)
    || config.castorWorkspace.requestTimeoutSeconds <= 0
  ) {
    throw new OperationError('config_error', 'castorWorkspace.requestTimeoutSeconds must be greater than zero.');
  }
  if (
    typeof config.domainExpert.requestTimeoutSeconds !== 'number'
    || !Number.isFinite(config.domainExpert.requestTimeoutSeconds)
    || config.domainExpert.requestTimeoutSeconds <= 0
  ) {
    throw new OperationError('config_error', 'domainExpert.requestTimeoutSeconds must be greater than zero.');
  }
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
}

export function parseSchedulerSourceIds(value: string | readonly unknown[]): string[] {
  const values = typeof value === 'string' ? value.split(',') : value;
  const selected = values.map((entry) => typeof entry === 'string' ? entry.trim() : '');
  if (selected.some((entry) => !(V0_4_PUBLIC_SOURCE_IDS as readonly string[]).includes(entry))) {
    throw new OperationError(
      'config_error',
      `worker.scheduler.sourceIds entries must be one of: ${V0_4_PUBLIC_SOURCE_IDS.join(', ')}.`,
    );
  }
  return [...new Set(selected)];
}

function assertBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new OperationError('config_error', `${name} must be a boolean.`);
  }
}

function assertPositiveNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new OperationError('config_error', `${name} must be greater than zero.`);
  }
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new OperationError('config_error', `${name} must be a positive integer.`);
  }
}

function validateSecretRef(value: string | undefined, name: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim()) {
    throw new OperationError('config_error', `${name} must be a non-empty string.`);
  }
  if (!normalizeSecretRef(value)) {
    throw new OperationError('config_error', `${name} must use env:NAME or store:key.`);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function normalizeSourceWorkerBaseUrl(value: string): string {
  const trimmed = trimTrailingSlash(value.trim());
  try {
    const url = new URL(trimmed);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.pathname === '' || url.pathname === '/')) {
      url.pathname = '/v1';
      return trimTrailingSlash(url.toString());
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

function parsePositiveNumber(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new OperationError('invalid_params', `${name} must be greater than zero.`);
  }
  return number;
}

export function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new OperationError('invalid_params', `${name} must be true or false.`);
}

export function parseOptionalBooleanEnv(
  value: string | undefined,
  name: string,
  options: {
    defaultValue?: boolean;
    invalid?: 'throw' | 'warn-false';
    warn?: (message: string) => void;
  } = {},
): boolean {
  if (value === undefined || value.trim().length === 0) return options.defaultValue ?? false;
  try {
    return parseBoolean(value, name);
  } catch (error) {
    if (options.invalid === 'warn-false') {
      const warning = `${name} has invalid boolean value; treating it as disabled.`;
      if (options.warn) options.warn(warning);
      else console.warn(warning);
      return false;
    }
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
