import {
  type SourceIndexStatusRetrievalAvailability,
} from '../../source-index/status.ts';
import {
  approvedVeniceAnalystBaseUrl,
} from '../../../core/analyst-venice.ts';
import {
  createVenicePrivacyCategoryResolver,
} from '../../../core/venice-model-catalog.ts';
import {
  assertVeniceEmbeddingModelAllowed,
} from '../../../core/venice-models.ts';
import { loadConfig } from '../../../core/config.ts';
import {
  loadSovereigntyEngine,
  type SovereigntyEngine,
  type LoadSovereigntyOptions,
} from '../../../core/sovereignty.ts';
import { createSourceCorpusRegistry } from '../../../core/source-corpus-registry.ts';
import { OperationError } from '../../../core/operation-error.ts';
import {
  gmailCursorConnectorId,
} from '../../google-connectors/index.ts';
import {
  type LocalConnectorStore,
  type ConnectorStoreSearchFilters,
} from '../../connector-store/index.ts';
import {
  type SourceTrustDomain,
} from '../../../core/source-index/types.ts';
import {
  WorkerBootSecretResolver,
} from '../../credential-degradation.ts';
import {
  DEFAULT_VENICE_SOURCE_EMBEDDING_BASE_URL,
  DEFAULT_VENICE_SOURCE_EMBEDDING_DIMENSION,
  DEFAULT_VENICE_SOURCE_EMBEDDING_MODEL,
  VENICE_SOURCE_EMBEDDING_QUERY_INSTRUCTION,
  GeminiSourceEmbeddingProvider,
  isApprovedSecureSourceEmbeddingProvider,
  OpenAICompatibleSourceEmbeddingProvider,
  type SourceEmbeddingProvider,
} from '../../source-index/embeddings.ts';
import { canonicalEmbeddingDimension } from '../../source-index/embedding-identity.ts';
import {
  sharedBuiltInSourceEmbeddingProvider,
} from '../../source-index/built-in-embedding/provider.ts';
import { BUILT_IN_EMBEDDING_ENV_DEFAULT_MODEL } from '../../source-index/built-in-embedding/manifest.ts';
import {
  SCHEDULER_SOURCE_IDS,
} from '../../source-scheduler.ts';
import {
  FileSourceScopeAuthority,
  isMailSourceScopePolicyRef,
  scopeBoundEmbeddingProvider,
  type SourceScopePolicyRef,
} from '../../source-scope-runtime.ts';
import {
  GMAIL_IMPORT_CONNECTOR_PREFIX,
  GMAIL_IMPORTED_FILTERS,
} from '../../google-connectors/gmail-archive-target.ts';
import { type StoreEmbeddingScope } from '../../connector-store/embedding-plan.ts';
import { parseOptionalTimeoutSeconds, firstNonEmptyEnv, resolveSecretRefSync, bootSecretOptions } from './environment.ts';

export function registerConnectorStoreEmbeddingLane(options: {
  store: LocalConnectorStore;
  provider: SourceEmbeddingProvider;
  /** Current Personal embedder: required before a Private store may embed pending judgments. */
  personalProvider?: SourceEmbeddingProvider | undefined;
  providers: Map<string, SourceEmbeddingProvider>;
  retrievalAvailability: Record<string, SourceIndexStatusRetrievalAvailability>;
}): void {
  if (options.store.trustDomain === 'secure_local' && !isApprovedSecureSourceEmbeddingProvider(options.provider)) {
    throw new Error('Connector store secure_local embeddings require a local/private or approved Venice embedding provider.');
  }
  options.store.usePersonalEmbeddingProvider(() => options.personalProvider);
  options.providers.set(options.store.corpusId, options.provider);
  options.retrievalAvailability[options.store.corpusId] = (_request, snapshot) => {
    // A status snapshot may judge "is there a visible vector" against a
    // hidden-copy set up to its counts age old; rebuilding that set on every
    // dashboard poll held the worker 2-3 s per refresh on Sparta (2026-11-09).
    // Search decides servability on its own path and never passes an age.
    const servable = options.store.hasEmbeddings(options.provider.modelId, { countsMaxAgeMs: snapshot?.countsMaxAgeMs ?? 0 });
    return {
      servable,
      ...(!servable ? { reason: 'no_current_embedding_artifacts' as const } : {}),
      modelId: options.provider.modelId,
      embeddingEpoch: options.provider.epochId,
      backend: options.provider.backend,
      provider: options.provider.provider,
    };
  };
}

function requireSourceEmbeddingDimension(options: {
  env: Record<string, string | undefined>;
  envKeys: readonly string[];
  lane: string;
  model: string;
}): number {
  const configuredKey = options.envKeys.find((key) => Boolean(options.env[key]?.trim()));
  // Shipped models already have authoritative dimensions in the identity
  // registry. Use those only when unset; an explicit invalid value must refuse.
  if (options.envKeys.every((key) => options.env[key] === undefined)) {
    const canonicalDimension = canonicalEmbeddingDimension(options.model);
    if (canonicalDimension !== undefined) return canonicalDimension;
  }
  const envKey = configuredKey ?? options.envKeys[options.envKeys.length - 1]!;
  const raw = options.env[envKey]?.trim();
  const dimension = raw === undefined || raw.length === 0 ? Number.NaN : Number(raw);
  if (Number.isSafeInteger(dimension) && dimension >= 1) return dimension;
  throw new OperationError(
    'config_error',
    `Source embedding ${options.lane} model ${options.model} requires a positive safe-integer dimension from ${envKey}.`,
    `Set ${envKey} to the model's authoritative output dimension before starting this lane.`,
  );
}

function createVeniceSourceEmbeddingProvider(options: {
  apiKey: string;
  model: string;
  baseUrl: string;
  dimension?: number;
  timeoutMs?: number;
  epochId?: string;
}): SourceEmbeddingProvider {
  const baseUrl = approvedVeniceAnalystBaseUrl(options.baseUrl);
  const resolvePrivacyCategory = createVenicePrivacyCategoryResolver({
    apiKey: options.apiKey,
    baseUrl,
    catalog: { type: 'embedding' },
  });
  return new OpenAICompatibleSourceEmbeddingProvider({
    provider: 'venice',
    backend: 'cloud',
    baseUrl,
    model: options.model,
    apiKeyProvider: () => options.apiKey,
    dimension: options.dimension ?? DEFAULT_VENICE_SOURCE_EMBEDDING_DIMENSION,
    queryInstructionPrefix: VENICE_SOURCE_EMBEDDING_QUERY_INSTRUCTION,
    sendDimensions: true,
    requireIndexedResponses: true,
    requireDimension: true,
    preflight: (signal) => assertVeniceEmbeddingModelAllowed(
      options.model,
      resolvePrivacyCategory,
      signal,
    ),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.epochId ? { epochId: options.epochId } : {}),
  });
}

export function createSourceIndexEmbeddingProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): SourceEmbeddingProvider | undefined {
  const provider = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER;
  if (provider === undefined || provider.trim().length === 0) return undefined;
  if (provider !== 'google-gemini' && provider !== 'local-openai-compatible' && provider !== 'venice' && provider !== 'built-in') {
    throw new Error('OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER must be google-gemini, local-openai-compatible, venice, or built-in.');
  }
  if (provider === 'built-in') {
    return sharedBuiltInSourceEmbeddingProvider({
      modelId: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL?.trim() || BUILT_IN_EMBEDDING_ENV_DEFAULT_MODEL.modelId,
      env,
    });
  }
  const timeoutMs = parseOptionalTimeoutSeconds(
    env.OLYMPUS_SOURCE_INDEX_EMBEDDING_TIMEOUT_SECONDS,
    'OLYMPUS_SOURCE_INDEX_EMBEDDING_TIMEOUT_SECONDS',
  );
  const mediaFetchTimeoutMs = parseOptionalTimeoutSeconds(
    env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MEDIA_TIMEOUT_SECONDS,
    'OLYMPUS_SOURCE_INDEX_EMBEDDING_MEDIA_TIMEOUT_SECONDS',
  );
  if (provider === 'local-openai-compatible') {
    const baseUrl = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL?.trim();
    const model = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL?.trim();
    if (!baseUrl || !model) {
      throw new Error('OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL and OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL are required for local-openai-compatible source embeddings.');
    }
    const outputDimensionality = requireSourceEmbeddingDimension({
      env,
      envKeys: ['OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY'],
      lane: 'source-index env lane',
      model,
    });
    return new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl,
      model,
      dimension: outputDimensionality,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(env.OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH
        ? { epochId: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH }
        : {}),
    });
  }
  if (provider === 'venice') {
    const apiKey = firstNonEmptyEnv(env, [
      'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
      'VENICE_API_KEY',
      'API_KEY_VENICE',
      'Venice-API-Key',
    ]);
    if (!apiKey) {
      throw new Error('OLYMPUS_SOURCE_INDEX_VENICE_API_KEY or VENICE_API_KEY is required for Venice source-index embeddings.');
    }
    const model = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL?.trim() || DEFAULT_VENICE_SOURCE_EMBEDDING_MODEL;
    const outputDimensionality = requireSourceEmbeddingDimension({
      env,
      envKeys: ['OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY'],
      lane: 'Venice source-index env lane',
      model,
    });
    return createVeniceSourceEmbeddingProvider({
      apiKey,
      model,
      baseUrl: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL?.trim() || DEFAULT_VENICE_SOURCE_EMBEDDING_BASE_URL,
      dimension: outputDimensionality,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH
        ? { epochId: env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH }
        : {}),
    });
  }
  const apiKey = firstNonEmptyEnv(env, ['OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY', 'GEMINI_API_KEY']);
  if (!apiKey) {
    throw new Error('OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY or GEMINI_API_KEY is required for Gemini source-index embeddings.');
  }
  const model = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL?.trim() || 'gemini-embedding-2';
  const outputDimensionality = requireSourceEmbeddingDimension({
    env,
    envKeys: ['OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY'],
    lane: 'source-index env lane',
    model,
  });
  return new GeminiSourceEmbeddingProvider({
    apiKey,
    model,
    ...(env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL
      ? { baseUrl: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL }
      : {}),
    outputDimensionality,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(mediaFetchTimeoutMs !== undefined ? { mediaFetchTimeoutMs } : {}),
    // Cloud override only — the shared epoch var belongs to the local lane
    // (see the sovereignty gemini branch below for the incident this guards).
    ...(env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH
      ? { epochId: env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH }
      : {}),
  });
}

/**
 * Whether a store is indexed for meaning at all: its corpus is served hybrid
 * with embedding not disabled (the full definition and the registry's both),
 * and its tier's retrieval policy does not keep it to keywords.
 */
export function storeServedByMeaning(input: {
  store: Pick<LocalConnectorStore, 'corpusId' | 'trustDomain'>;
  sovereigntyEngine: SovereigntyEngine;
  sourceCorpusRegistry: ReturnType<typeof createSourceCorpusRegistry>;
  fullCorpusDefinitions: readonly import('../../../core/source-index/corpus.ts').SourceIndexCorpusDefinition[];
}): boolean {
  const { store, sourceCorpusRegistry } = input;
  // A tier store opened after boot has no full definition yet; the
  // registry's declaration of the same corpus stands in for it.
  const registered = sourceCorpusRegistry.definitions().find((entry) => entry.corpusId === store.corpusId);
  const definition = input.fullCorpusDefinitions.find((entry) => entry.corpusId === store.corpusId) ?? registered;
  const served = (entry: typeof definition) => entry === undefined
    || (entry.activationMode !== 'lexical_only' && entry.embeddingPolicy !== 'disabled');
  if (!definition || !served(definition) || !served(registered)) return false;
  const domain = store.trustDomain === 'public_safe' || store.trustDomain === 'internal' || store.trustDomain === 'secure_local'
    ? input.sovereigntyEngine.config.retrieval.trustDomains[store.trustDomain]?.activationMode
    : undefined;
  return domain !== 'lexical_only' && domain !== 'metadata_only';
}

/**
 * Whether any of these corpora would be indexed for meaning once its store
 * opens: served by meaning, with an identity for its tier. Shared with
 * startup-wiring tests.
 */
export function sourceStoresCouldEmbed(input: Omit<Parameters<typeof storeServedByMeaning>[0], 'store'> & {
  corpusIds: ReadonlySet<string>;
  providerFor: (trustDomain: string) => SourceEmbeddingProvider | undefined;
}): boolean {
  return input.sourceCorpusRegistry.list().some((corpus) => input.corpusIds.has(corpus.corpusId)
    && input.providerFor(corpus.trustDomain) !== undefined
    && storeServedByMeaning({ ...input, store: corpus }));
}

/** Sources whose stores are read only under the owner's current scope approval. */
const SCOPE_APPROVED_SOURCE_IDS: ReadonlySet<string> = new Set([
  SCHEDULER_SOURCE_IDS.gmail, SCHEDULER_SOURCE_IDS.googleDrive, SCHEDULER_SOURCE_IDS.dropbox, SCHEDULER_SOURCE_IDS.localFiles,
]);

/**
 * What a store's embedding may read now, from the scope authority: the same
 * population the store's status counts as owed. Shared with startup-wiring tests.
 *   - Gmail with no current mail approval: only what its imports brought,
 *     which the owner approved one by one. Live approval governs live reads.
 *   - Gmail's Private store under an approval: the approval's observations
 *     and the imports'.
 *   - A file source's store: the approved folders' content scope.
 * Every scoped store's provider is bound to the approval, so a pass stops
 * the moment it changes. Other stores carry no scope.
 */
export function storeEmbeddingScope(input: {
  store: LocalConnectorStore;
  sourceId: string;
  scopeRef: SourceScopePolicyRef | undefined;
  authority: FileSourceScopeAuthority | undefined;
  readScope: (store: LocalConnectorStore) => { allowed: false } | {
    allowed: true; contentAllowed: boolean; accountScope?: string; contentFilters?: ConnectorStoreSearchFilters;
  };
  gmailAccountScope?: string | undefined;
  /** The account scope Gmail's imported mail is kept under. */
  gmailImportAccountScope?: string | undefined;
}): StoreEmbeddingScope {
  const { store, sourceId, scopeRef: ref, authority } = input;
  if (!SCOPE_APPROVED_SOURCE_IDS.has(sourceId)) return { allowed: true };
  if (sourceId === SCHEDULER_SOURCE_IDS.gmail && (!ref || !authority)) {
    if (!input.gmailImportAccountScope) return { allowed: false };
    return { allowed: true, accountScope: input.gmailImportAccountScope, filters: GMAIL_IMPORTED_FILTERS };
  }
  if (!ref || !authority) return { allowed: false };
  const bind = (provider: SourceEmbeddingProvider) => scopeBoundEmbeddingProvider(provider, authority, ref);
  if (isMailSourceScopePolicyRef(ref)) {
    // A superseded approval leaves only the queue; the next build carries the new one.
    try {
      authority.assertCurrentMail(ref);
    } catch {
      return { allowed: false };
    }
    if (store.trustDomain !== 'secure_local') return { allowed: true, bind };
    const accountScope = input.gmailAccountScope?.trim() || 'personal';
    return {
      allowed: true,
      bind,
      accountScope,
      filters: {
        provider: 'gmail',
        observedConnectorId: gmailCursorConnectorId(accountScope, { generation: ref.accountGeneration, revision: ref.revision }),
        observedConnectorIdPrefix: GMAIL_IMPORT_CONNECTOR_PREFIX,
      },
    };
  }
  const scope = input.readScope(store);
  if (!scope.allowed || !scope.contentAllowed) return { allowed: false };
  return {
    allowed: true,
    bind,
    ...(scope.accountScope ? { accountScope: scope.accountScope } : {}),
    ...(scope.contentFilters ? { filters: scope.contentFilters } : {}),
  };
}

/** Worker startup policy loading; hosted paths stay read-only. */
export function loadSourceWorkerSovereignty(
  config: Pick<ReturnType<typeof loadConfig>, 'sovereignty'>,
  env: Record<string, string | undefined>,
): SovereigntyEngine {
  const options: LoadSovereigntyOptions = {
    env, migratePrivateMeaning: true,
    ...(config.sovereignty?.policy ? { inlineConfig: config.sovereignty.policy } : {}),
    ...(config.sovereignty?.configPath ? { configPath: config.sovereignty.configPath } : {}),
  };
  return loadSovereigntyEngine(options);
}

export function createSourceIndexEmbeddingProviderFromSovereignty(
  engine: SovereigntyEngine,
  trustDomain: Extract<SourceTrustDomain, 'public_safe' | 'internal' | 'secure_local'>,
  env: Record<string, string | undefined> = process.env,
  bootSecretResolver?: WorkerBootSecretResolver,
): SourceEmbeddingProvider | undefined {
  const resolved = engine.resolveEmbeddingProfile(trustDomain);
  if (!resolved) return undefined;
  const profile = resolved.profile;
  if (profile.provider === 'built-in') {
    // In-process: no endpoint, no credential, no timeout knob, and no epoch
    // override (the shared epoch variables belong to the HTTP lanes).
    return sharedBuiltInSourceEmbeddingProvider({ modelId: profile.model, env });
  }
  const timeoutMs = parseOptionalTimeoutSeconds(
    env.OLYMPUS_SOURCE_INDEX_EMBEDDING_TIMEOUT_SECONDS,
    'OLYMPUS_SOURCE_INDEX_EMBEDDING_TIMEOUT_SECONDS',
  );
  if (profile.provider === 'local-openai-compatible') {
    if (!profile.baseUrl?.trim()) {
      throw new Error(`Sovereignty embedding profile "${resolved.id}" requires baseUrl.`);
    }
    const apiKey = profile.secretRef
      ? resolveSecretRefSync(
        profile.secretRef,
        env,
        `Sovereignty embedding profile "${resolved.id}"`,
        bootSecretOptions(bootSecretResolver, [resolved.id], ['embedding'], resolved),
      )
      : undefined;
    if (profile.secretRef && !apiKey) return undefined;
    const outputDimensionality = requireSourceEmbeddingDimension({
      env,
      envKeys: ['OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY'],
      lane: `sovereignty ${trustDomain} lane`,
      model: profile.model,
    });
    return new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(apiKey ? { apiKeyProvider: () => apiKey } : {}),
      dimension: outputDimensionality,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(env.OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH
        ? { epochId: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH }
        : {}),
    });
  }
  if (profile.provider === 'venice') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      env,
      `Sovereignty embedding profile "${resolved.id}"`,
      bootSecretOptions(bootSecretResolver, [resolved.id], ['embedding']),
    );
    if (!apiKey) return undefined;
    const outputDimensionality = requireSourceEmbeddingDimension({
      env,
      envKeys: ['OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY'],
      lane: `sovereignty ${trustDomain} Venice lane`,
      model: profile.model,
    });
    return createVeniceSourceEmbeddingProvider({
      apiKey,
      model: profile.model,
      baseUrl: profile.baseUrl ?? DEFAULT_VENICE_SOURCE_EMBEDDING_BASE_URL,
      dimension: outputDimensionality,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH
        ? { epochId: env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH }
        : {}),
    });
  }
  if (profile.provider === 'google-gemini') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      env,
      `Sovereignty embedding profile "${resolved.id}"`,
      bootSecretOptions(bootSecretResolver, [resolved.id], ['embedding'], resolved),
    );
    if (!apiKey) return undefined;
    const outputDimensionality = requireSourceEmbeddingDimension({
      env,
      envKeys: ['OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY'],
      lane: `sovereignty ${trustDomain} lane`,
      model: profile.model,
    });
    return new GeminiSourceEmbeddingProvider({
      apiKey,
      model: profile.model,
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      outputDimensionality,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      // The CLOUD lane's override only. Threading the shared
      // OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH here is what stamped the local
      // qwen3 epoch onto five gemini write authorities (the private host, found
      // 2026-08-24); the identity module now refuses it at construction, which
      // took the worker down at boot on the first deploy of the gate. With no
      // override the canonical gemini epoch is derived.
      ...(env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH
        ? { epochId: env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH }
        : {}),
    });
  }
  throw new Error(`Sovereignty embedding profile "${resolved.id}" provider ${profile.provider} is not an embedding provider.`);
}

export function createCloudSourceIndexEmbeddingProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
  envPrefix?: string,
): SourceEmbeddingProvider | undefined {
  const apiKey = firstNonEmptyEnv(env, [
    ...(envPrefix ? [`${envPrefix}_GEMINI_API_KEY`] : []),
    'OLYMPUS_SOURCE_INDEX_CLOUD_GEMINI_API_KEY',
    'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY',
    'GEMINI_API_KEY',
  ]);
  if (!apiKey) return undefined;

  const model = firstNonEmptyEnv(env, [
    ...(envPrefix ? [`${envPrefix}_EMBEDDING_MODEL`] : []),
    'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_MODEL',
  ]) ?? 'gemini-embedding-2';
  const outputDimensionality = requireSourceEmbeddingDimension({
    env,
    envKeys: [
      ...(envPrefix ? [`${envPrefix}_EMBEDDING_OUTPUT_DIMENSIONALITY`] : []),
      'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY',
    ],
    lane: envPrefix ? `per-lane cloud ${envPrefix}` : 'default cloud source-index lane',
    model,
  });
  const timeoutMs = parseOptionalTimeoutSeconds(
    firstNonEmptyEnv(env, [
      ...(envPrefix ? [`${envPrefix}_EMBEDDING_TIMEOUT_SECONDS`] : []),
      'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_TIMEOUT_SECONDS',
    ]),
    envPrefix ? `${envPrefix}_EMBEDDING_TIMEOUT_SECONDS` : 'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_TIMEOUT_SECONDS',
  );
  const mediaFetchTimeoutMs = parseOptionalTimeoutSeconds(
    firstNonEmptyEnv(env, [
      ...(envPrefix ? [`${envPrefix}_EMBEDDING_MEDIA_TIMEOUT_SECONDS`] : []),
      'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_MEDIA_TIMEOUT_SECONDS',
    ]),
    envPrefix ? `${envPrefix}_EMBEDDING_MEDIA_TIMEOUT_SECONDS` : 'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_MEDIA_TIMEOUT_SECONDS',
  );
  const baseUrl = firstNonEmptyEnv(env, [
    ...(envPrefix ? [`${envPrefix}_EMBEDDING_BASE_URL`] : []),
    'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_BASE_URL',
  ]);
  const epochId = firstNonEmptyEnv(env, [
    ...(envPrefix ? [`${envPrefix}_EMBEDDING_EPOCH`] : []),
    'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH',
  ]);

  return new GeminiSourceEmbeddingProvider({
    apiKey,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    outputDimensionality,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(mediaFetchTimeoutMs !== undefined ? { mediaFetchTimeoutMs } : {}),
    ...(epochId ? { epochId } : {}),
  });
}
