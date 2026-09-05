import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  createFileExtractionRuntime,
  fileExtractionCorporaRoster,
  parseFileExtractionCorporaEnv,
} from './file-extraction-runtime.ts';
import { createExtractionReadinessLedger } from '../file-extraction/readiness-ledger.ts';
import { VeniceVlmClient } from '../file-extraction/extractors/venice-client.ts';
import { OpenAICompatibleVlmClient } from '../file-extraction/extractors/openai-compatible-client.ts';
import {
  createEmailSourceWorker,
  dashboardSourceSyncNotSupportedError,
  defineGmailSecureLocalCorpus,
  defineInternalEmailCorpus,
  GMAIL_SECURE_LOCAL_CORPUS_ID,
  INTERNAL_EMAIL_CORPUS_ID,
  GogcliEmailConnector,
  type EmailSourceConnector,
  type ConnectorStoreChatPrincipal,
  type ConnectorStoreDeclaredPrincipal,
  type GmailEmailCorpusId,
} from './index.ts';
import {
  createAnalystSourceIndexAnswerHandler,
  type AnalystAnswerLanes,
  type SovereigntyAnalystRoutePlan,
  type SovereigntyAnalystRouteStep,
} from '../source-index/analyst-answer.ts';
import { parseSecureAnalystPoolLastLegTimeoutMs } from '../source-index/analyst-pool.ts';
import {
  createFileSourceAnswerLatencyLog,
  resolveSourceAnswerLatencyLogPath,
} from '../source-index/answer-latency-log.ts';
import type { EvidencePackBuildDetail } from '../../core/evidence-pack.ts';
import type { SourceIndexAnswerRequest } from '../source-index/answer-types.ts';
import {
  createSourceIndexStatusHandler,
  resolveStatusRetrievalAvailability,
  type SourceIndexStatusRetrievalAvailability,
} from '../source-index/status.ts';
import {
  resolveWorkerBindHost,
  warnIfWorkerAuthDisabled,
  withWorkerBearerAuth,
  workerAuthTokenFromEnv,
} from '../http.ts';
import { createAnalyst } from '../../core/analyst.ts';
import { createDelphiAnalystModel } from '../../core/analyst-delphi.ts';
import { createAnthropicAnalystModel } from '../../core/analyst-anthropic.ts';
import { createOpenClawInferAnalystModel } from '../../core/analyst-openclaw-infer.ts';
import {
  approvedVeniceAnalystBaseUrl,
  createVeniceAnalystModel,
  type VeniceThinkingMode,
} from '../../core/analyst-venice.ts';
import {
  createVenicePrivacyCategoryResolver,
  type VeniceModelCatalogOptions,
} from '../../core/venice-model-catalog.ts';
import { assertVeniceAnalystModelAllowed } from '../../core/venice-models.ts';
import { createOpenAICompatibleAnalystModel, type OpenAIReasoningEffort } from '../../core/analyst-openai.ts';
import { createAnalystQueryPlanner } from '../../core/query-planner.ts';
import { defaultConfig, loadConfig, parseLane, parseModelProfile, parseOptionalBooleanEnv } from '../../core/config.ts';
import { DelphiClient } from '../../core/delphi.ts';
import {
  describeSovereigntyPolicy,
  loadSovereigntyEngine,
  type SovereigntyEngine,
  type SovereigntyModelProfile,
  type SovereigntyResolvedProfile,
} from '../../core/sovereignty.ts';
import { createSourceCorpusRegistry } from '../../core/source-corpus-registry.ts';
import {
  dropboxPolicyFullExtractionScopeKeys,
  loadDropboxIngestionPolicy,
} from '../../core/source-ingestion-policy.ts';
import { OperationError } from '../../core/operation-error.ts';
import {
  buildSourceIndexCorpusRegistry,
} from '../../core/source-index/corpus.ts';
import {
  GOOGLE_DRIVE_DOCS_CORPUS_ID,
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_ENFORCEABLE_EXCLUSION_CRITERIA,
  GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  GoogleDailyRequestBudget,
  createGmailConnectorStoreSyncHandler,
  createGmailDailyRequestBudget,
  createGoogleDriveConnectorStoreSyncHandler,
  createGoogleDriveDailyRequestBudget,
  defaultGmailConnectorStoreDbPath,
  defaultGmailSecureConnectorStoreDbPath,
  defaultGoogleDriveConnectorStoreDbPath,
  googleDriveIngestionExclusionMatcher,
  defineGoogleDriveDocsCorpus,
  defaultGoogleDriveSecureConnectorStoreDbPath,
  type GoogleDriveConnectorStoreSyncHandler,
} from '../google-connectors/index.ts';
import {
  READWISE_LIBRARY_CORPUS_ID,
  ReadwiseDailyRequestBudget,
  createReadwiseConnectorStore,
  createReadwiseConnectorStoreSyncHandler,
  createReadwiseDailyRequestBudget,
  defineReadwiseLibraryCorpus,
  defaultReadwiseConnectorStoreDbPath,
  type ReadwiseConnectorStoreSyncHandler,
} from '../readwise/index.ts';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  X_BOOKMARKS_CORPUS_ID,
  createXBookmarksConnectorStore,
  createXBookmarksConnectorStoreSyncHandler,
  createXBookmarksContentRecoveryHandler,
  defineXBookmarksCorpus,
  defaultXBookmarksConnectorStoreDbPath,
  defaultXBookmarksReconcileStateDbPath,
  type XBookmarksConnectorStoreSyncHandler,
  type XBookmarksContentRecoveryHandler,
} from '../x-bookmarks/index.ts';
import {
  DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
  DROPBOX_ENFORCEABLE_EXCLUSION_CRITERIA,
  DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
  DROPBOX_INGESTION_EXCLUSION_SOURCE,
  DROPBOX_FILES_CORPUS_ID,
  defaultDropboxConnectorStoreDbPath,
  createDropboxEvalShardExportHandler,
  createDropboxSourceExportHandler,
  defineDropboxFilesCorpus,
  createDropboxConnectorStore,
  dropboxIngestionExclusionMatcher,
} from '../dropbox-files/index.ts';
import { createDropboxProviderStoreSyncHandler } from '../dropbox-files/provider-store-sync.ts';
import {
  createSourceExclusionMatcherFromPrefixes,
  sourceExclusionDescendantPrefixes,
  type SourceExclusionCriterionKind,
  type SourceExclusionMatcher,
} from '../../core/source-ingestion-exclusions.ts';
import type { SourceDispositionsSource } from '../source-dispositions.ts';
import type { SourceDispositionItem } from '../../core/source-disposition-tree.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_PERSONAL_ACCOUNT_SCOPE,
  createTelegramConnectorStores,
  createTelegramConnectorStoreSyncHandler,
  defineInternalTelegramMessagesCorpus,
  defineProtectedTelegramMessagesCorpus,
  type TelegramConnectorStoreSyncHandler,
} from '../telegram-messages/index.ts';
import {
  DEFAULT_SEMANTIC_RELEVANCE_BAR,
  LocalConnectorStore,
  connectorStoreFilterCapabilityRegistry,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
  type ConnectorStoreConversationTitleCandidates,
  type ConnectorStoreFilterCapabilityRegistry,
  type ConnectorStoreSearchFilters,
} from '../connector-store/index.ts';
import { canonicalConnectorStoreChatPrincipal } from '../connector-store/principal.ts';
import { CHAT_SCOPE_FILTER_CODEC } from '../chat/chat-scope-filter.ts';
import { createEnvCredentialBroker } from '../credential-broker/index.ts';
import {
  withSourceIndexHybridAvailability,
  type SourceIndexCorpusSearchAdapter,
} from '../../core/source-index/router.ts';
import {
  SOURCE_FAMILIES,
  SOURCE_TRUST_DOMAINS,
  type SourceFamily,
  type SourceTrustDomain,
} from '../../core/source-index/types.ts';
import { resolveSecretRefValueSync } from '../../core/secret-store.ts';
import { WorkerBootSecretResolver } from '../credential-degradation.ts';
import {
  GeminiSourceEmbeddingProvider,
  OpenAICompatibleSourceEmbeddingProvider,
  type SourceEmbeddingProvider,
} from '../source-index/embeddings.ts';
import { canonicalEmbeddingDimension } from '../source-index/embedding-identity.ts';
import {
  createGmailConnectorStoreSchedulerSource,
  createGoogleDriveConnectorStoreSchedulerSource,
  createCanonicalDropboxSchedulerSource,
  createReadwiseSchedulerSource,
  createSourceSchedulerFromConfig,
  createTelegramSchedulerSource,
  createWhatsAppSchedulerSource,
  createXBookmarksSchedulerSource,
  attachSourceWatchSchedulerTask,
  sourceSchedulerConstructionLogLines,
  SCHEDULER_SOURCE_IDS,
  type SourceSchedulerConstructionDecision,
  type SourceSchedulerSource,
} from '../source-scheduler.ts';
import {
  createSourceWatchExecutorCapability,
  LocalSourceWatchStore,
} from '../../core/source-watch.ts';
import {
  createSourceWatchSearchFromAnalystLanes,
  OpenClawSourceWatchDeliveryTransport,
  runSourceWatchSchedulerPass,
} from '../source-watch-runtime.ts';
import {
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
  createWhatsAppConnectorStore,
  createWhatsAppConnectorStoreSyncHandler,
  type WhatsAppConnectorStoreSyncHandler,
} from '../whatsapp/index.ts';
import { SqliteSourceDashboardHistory } from '../source-dashboard.ts';
import {
  SqliteSourceIngestionLedgerStore,
  buildSourceIngestionLedgerSnapshot,
} from '../source-ingestion-ledger.ts';
import type { Analyst } from '../../core/contracts.ts';
import type { AnalystBackend } from '../source-index/answer-types.ts';
import {
  handleRegistryPathFromEnv,
  readConnectedHandleRegistry,
  type ConnectedCredentialHandle,
} from '../credential-broker/connected-handles.ts';
import { withoutUnpairedLaneHandles } from '../credential-broker/unpaired-sources.ts';

const DROPBOX_SOURCE_ANSWER_SELF_HEAL_RETRY_AFTER_MS = 5_000;
const DROPBOX_SOURCE_ANSWER_SELF_HEAL_PRIORITY = 1_000_000;

export function registerConnectorStoreEmbeddingLane(options: {
  store: LocalConnectorStore;
  provider: SourceEmbeddingProvider;
  providers: Map<string, SourceEmbeddingProvider>;
  retrievalAvailability: Record<string, SourceIndexStatusRetrievalAvailability>;
}): void {
  if (options.store.trustDomain === 'secure_local' && options.provider.backend !== 'local') {
    throw new Error('Connector store secure_local embeddings require a local/private embedding provider.');
  }
  options.providers.set(options.store.corpusId, options.provider);
  options.retrievalAvailability[options.store.corpusId] = () => {
    const servable = options.store.hasEmbeddings(options.provider.modelId);
    return {
      servable,
      ...(!servable ? { reason: 'no_current_embedding_artifacts' as const } : {}),
      modelId: options.provider.modelId,
      embeddingEpoch: options.provider.epochId,
      backend: options.provider.backend,
    };
  };
}

export function createEmailSourceConnectorFromEnv(env: Record<string, string | undefined> = process.env): EmailSourceConnector | undefined {
  return env.OLYMPUS_EMAIL_SOURCE_CONNECTOR === 'gogcli'
    ? new GogcliEmailConnector({
      ...(env.OLYMPUS_EMAIL_SOURCE_GOG_COMMAND
        ? { command: env.OLYMPUS_EMAIL_SOURCE_GOG_COMMAND }
        : {}),
      ...(env.OLYMPUS_EMAIL_SOURCE_ACCOUNT
        ? { account: env.OLYMPUS_EMAIL_SOURCE_ACCOUNT }
        : {}),
      // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
      ...(env.OLYMPUS_EMAIL_SOURCE_AUTH_MODE === 'service-account'
        ? { authMode: 'service-account' as const }
        : {}),
      // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
    })
    : undefined;
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

export function createSourceIndexEmbeddingProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): SourceEmbeddingProvider | undefined {
  const provider = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER;
  if (provider === undefined || provider.trim().length === 0) return undefined;
  if (provider !== 'google-gemini' && provider !== 'local-openai-compatible') {
    throw new Error('OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER must be google-gemini or local-openai-compatible.');
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

export function createSourceIndexEmbeddingProviderFromSovereignty(
  engine: SovereigntyEngine,
  trustDomain: Extract<SourceTrustDomain, 'public_safe' | 'internal' | 'secure_local'>,
  env: Record<string, string | undefined> = process.env,
  bootSecretResolver?: WorkerBootSecretResolver,
): SourceEmbeddingProvider | undefined {
  const resolved = engine.resolveEmbeddingProfile(trustDomain);
  if (!resolved) return undefined;
  const profile = resolved.profile;
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
        bootSecretOptions(bootSecretResolver, [resolved.id], ['embedding']),
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
  if (profile.provider === 'google-gemini') {
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

// Selects the Dropbox VLM transport. `openai` (default) keeps the historical
// OpenAI-compatible `/v1/chat/completions` path so non-Ollama installs are
// unchanged; `ollama` uses the native `/api/chat` client (native `images`
// field, base URL `/v1`-normalized) which is the maintained path on the
// inference appliance.

/**
 * The file-storage sources the folder-disposition picker offers, and the ONLY
 * place in that feature that names a provider.
 *
 * This is the bootstrap adapter's job by the architecture rule: the picker, the
 * tree engine and the gate are all source-neutral, and each source arrives here
 * carrying its own exclusion key, its own declared enforceable criteria, and
 * its own stores. A new file source becomes editable in the picker by adding a
 * row here — no change to the engine, the page, or the routes.
 *
 * A source may span several stores. Drive is two trust bands over one corpus
 * family, and folding both into one tree is what makes the counts on the page
 * equal what the purge would report.
 */
const INGESTION_DISPOSITION_SOURCES: ReadonlyArray<{
  sourceId: string;
  label: string;
  enforceable: readonly SourceExclusionCriterionKind[];
  matcher: (env: Record<string, string | undefined>) => SourceExclusionMatcher;
  stores: (env: Record<string, string | undefined>) => Array<{
    dbPath: string;
    corpusId: string;
    trustDomain: SourceTrustDomain;
  }>;
}> = [
  {
    sourceId: DROPBOX_INGESTION_EXCLUSION_SOURCE,
    label: 'Dropbox',
    enforceable: DROPBOX_ENFORCEABLE_EXCLUSION_CRITERIA,
    matcher: (env) => dropboxIngestionExclusionMatcher(env),
    stores: (env) => [{
      dbPath: defaultDropboxConnectorStoreDbPath(env),
      corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
      trustDomain: 'secure_local',
    }],
  },
  {
    sourceId: GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE,
    label: 'Google Drive',
    enforceable: GOOGLE_DRIVE_ENFORCEABLE_EXCLUSION_CRITERIA,
    matcher: (env) => googleDriveIngestionExclusionMatcher(env),
    stores: (env) => [
      {
        dbPath: defaultGoogleDriveConnectorStoreDbPath(env),
        corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
        trustDomain: 'internal',
      },
      {
        dbPath: defaultGoogleDriveSecureConnectorStoreDbPath(env),
        corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
        trustDomain: 'secure_local',
      },
    ],
  },
];

/**
 * Open the picker's inputs for one request, read-only, and hand back the way to
 * close them.
 *
 * Read-only opens throughout: this page must never be able to create a store
 * file as a side effect of being looked at, and it must never hold a writer's
 * lock. A store whose file does not exist is reported as absent rather than
 * created, exactly as the purge script does.
 *
 * A source whose gate REFUSES to compile is carried as an error rather than
 * thrown. That refusal means the owner has a rule naming a source that cannot
 * enforce it, and this page is the tool they would use to fix it.
 */
type StoredExclusionDebt = ReturnType<LocalConnectorStore['exclusionDebtPresent']>;

/**
 * Both debts across a source's stores, walked once however many of the two
 * numbers the caller ends up reading.
 *
 * The runtime hands the page two separate accessors, and the page calls both;
 * without the memo that is two full walks of every store per render, for one
 * decision per row that already answers both. The memo is scoped to a runtime
 * that is opened and closed inside a single request, so it can never serve a
 * count from an earlier render.
 */
function storedExclusionDebtReader(handles: readonly LocalConnectorStore[]): () => StoredExclusionDebt {
  let walked: StoredExclusionDebt | undefined;
  return () => {
    if (walked) return walked;
    const total: StoredExclusionDebt = {
      excluded: { items: 0, unevaluable: 0 },
      metadataOnlyContent: { items: 0, unevaluable: 0 },
    };
    for (const handle of handles) {
      const debt = handle.exclusionDebtPresent();
      total.excluded.items += debt.excluded.items;
      total.excluded.unevaluable += debt.excluded.unevaluable;
      total.metadataOnlyContent.items += debt.metadataOnlyContent.items;
      total.metadataOnlyContent.unevaluable += debt.metadataOnlyContent.unevaluable;
    }
    walked = total;
    return total;
  };
}

export function openIngestionDispositionsRuntime(
  env: Record<string, string | undefined> = process.env,
): { sources: SourceDispositionsSource[]; close: () => void } {
  const opened: LocalConnectorStore[] = [];
  const sources: SourceDispositionsSource[] = [];
  for (const definition of INGESTION_DISPOSITION_SOURCES) {
    let stores: ReturnType<typeof definition.stores> = [];
    const handles: LocalConnectorStore[] = [];
    const readDebt = storedExclusionDebtReader(handles);
    try {
      stores = definition.stores(env);
      const matcher = definition.matcher(env);
      for (const store of stores) {
        if (!existsSync(store.dbPath)) continue;
        const handle = new LocalConnectorStore({
          dbPath: store.dbPath,
          corpusId: store.corpusId,
          family: 'file',
          trustDomain: store.trustDomain,
          exclusions: matcher,
          readOnly: true,
        });
        handles.push(handle);
        opened.push(handle);
      }
      sources.push({
        source_id: definition.sourceId,
        label: definition.label,
        corpus_ids: stores.map((store) => store.corpusId),
        enforceable: definition.enforceable,
        matcher,
        store_present: handles.length > 0,
        ...(handles.length > 0
          ? {
            items: function* (): Generator<SourceDispositionItem> {
              for (const handle of handles) yield* handle.itemLocatorCensus();
            },
            excludedItemsPresent: () => readDebt().excluded,
            metadataOnlyContentPresent: () => readDebt().metadataOnlyContent,
          }
          : {}),
      });
    } catch (error) {
      // A store that refuses to open is carried as data like a gate that
      // refuses to compile — but the handles this source already opened would
      // otherwise be orphaned, because the caller's `finally` only ever sees a
      // runtime this function returned.
      for (const handle of handles) {
        const index = opened.indexOf(handle);
        if (index >= 0) opened.splice(index, 1);
        try {
          handle.close();
        } catch {
          // Closing a handle we are already discarding cannot change the entry.
        }
      }
      sources.push({
        source_id: definition.sourceId,
        label: definition.label,
        corpus_ids: stores.map((store) => store.corpusId),
        enforceable: definition.enforceable,
        matcher: createSourceExclusionMatcherFromPrefixes([]),
        store_present: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    sources,
    close: () => {
      for (const handle of opened.reverse()) {
        try {
          handle.close();
        } catch {
          // A close failure must not mask the response that already rendered.
        }
      }
    },
  };
}

export function parseOptionalTimeoutSeconds(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive number of seconds.`);
  }
  return Math.round(seconds * 1000);
}

export function parseOptionalTimeoutSecondsOrNone(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'unbounded' || normalized === 'disabled') return 0;
  return parseOptionalTimeoutSeconds(value, name);
}

export function trustedAnalystAssistTimeoutMs(input: {
  explicitTrustedAnalystTimeoutMs: number | undefined;
  veniceAnalystTimeoutMs: number | undefined;
}): number | undefined {
  if (input.explicitTrustedAnalystTimeoutMs !== undefined) return input.explicitTrustedAnalystTimeoutMs;
  if (input.veniceAnalystTimeoutMs === undefined) return undefined;
  return Math.min(input.veniceAnalystTimeoutMs + 5_000, 20_000);
}

async function createSovereigntyAnalystMap(input: {
  engine: SovereigntyEngine;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  defaultLocal: Analyst;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
  bootSecretResolver?: WorkerBootSecretResolver;
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
        bootSecretOptions(input.bootSecretResolver, [id], ['analyst']),
      );
      if (!apiKey) continue;
      await validateSecureVeniceAnalystProfileAtConstruction({ profile, apiKey });
    }
    const analyst = input.engine.source === 'env_bridge' && id === 'local-source-answer'
      ? input.defaultLocal
      : createAnalystForSovereigntyProfile({
          profile,
          profileId: id,
          olympusConfig: input.olympusConfig,
          env: input.env,
          veniceAnalystTimeoutMs: input.veniceAnalystTimeoutMs,
          veniceReasoningHeadroomTokens: input.veniceReasoningHeadroomTokens,
          ...(input.bootSecretResolver ? { bootSecretResolver: input.bootSecretResolver } : {}),
        });
    if (!analyst) continue;
    map.set(id, { profile: resolved, backend, analyst });
  }
  return map;
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

export async function validateSecureVeniceAnalystProfileAtConstruction(input: {
  profile: SovereigntyModelProfile;
  apiKey: string;
  catalog?: VeniceModelCatalogOptions;
}): Promise<void> {
  const baseUrl = approvedVeniceAnalystBaseUrl(
    input.profile.baseUrl ?? 'https://api.venice.ai/api/v1',
  );
  await assertVeniceAnalystModelAllowed(
    input.profile.model,
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
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
}): Analyst;
export function createAnalystForSovereigntyProfile(input: {
  profile: SovereigntyModelProfile;
  profileId?: string;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
  bootSecretResolver: WorkerBootSecretResolver;
}): Analyst | undefined;
export function createAnalystForSovereigntyProfile(input: {
  profile: SovereigntyModelProfile;
  profileId?: string;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
  bootSecretResolver?: WorkerBootSecretResolver;
}): Analyst | undefined {
  const { profile } = input;
  const profileId = input.profileId ?? profile.model;
  if (profile.provider === 'local-openai-compatible') {
    if (!profile.baseUrl?.trim()) {
      throw new Error('Local sovereignty analyst profiles require baseUrl.');
    }
    const apiKey = profile.secretRef
      ? resolveSecretRefSync(
        profile.secretRef,
        input.env,
        'Sovereignty local analyst profile',
        bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst']),
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
    return createAnalyst(
      createDelphiAnalystModel(new DelphiClient(config, undefined, {
        resolveSecretRef: () => apiKey,
      }), {
        profile: 'source_answer',
        preflightTimeoutMs: 0,
      }),
      { auditSuspiciousDrafts: true },
    );
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
      bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst']),
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
      bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst']),
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
      bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst']),
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

function analystRouteTrustDomain(pack: { candidates: readonly { trustDomain: SourceTrustDomain }[] }, localOnly: boolean): SourceTrustDomain {
  if (localOnly || pack.candidates.some((candidate) => candidate.trustDomain === 'secure_local')) {
    return 'secure_local';
  }
  if (pack.candidates.some((candidate) => candidate.trustDomain === 'internal')) {
    return 'internal';
  }
  return 'public_safe';
}


function parseRequiredTimeoutSeconds(value: string, name: string): number {
  return parseOptionalTimeoutSeconds(value, name) ?? (() => {
    throw new Error(`${name} must be a positive number of seconds.`);
  })();
}

function parseVeniceReasoningEffort(value: string): OpenAIReasoningEffort {
  const normalized = value.trim();
  if ([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ].includes(normalized)) {
    return normalized as OpenAIReasoningEffort;
  }
  throw new Error('OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_EFFORT must be one of none, minimal, low, medium, high, xhigh, max.');
}

function parseVeniceThinkingMode(value: string): VeniceThinkingMode {
  const normalized = value.trim();
  if (normalized === 'enabled' || normalized === 'on' || normalized === 'true') return 'enabled';
  if (normalized === 'disabled' || normalized === 'off' || normalized === 'false') return 'disabled';
  throw new Error('OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_THINKING must be enabled or disabled.');
}

function parseOptionalTokenCount(value: string | undefined, name: string): number | undefined {
  return parseOptionalPositiveInteger(value, name);
}

export function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parseOptionalNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

export function sourceIndexSemanticRelevanceBarFromEnv(
  env: Record<string, string | undefined>,
): number {
  const name = 'OLYMPUS_SOURCE_INDEX_SEMANTIC_RELEVANCE_BAR';
  const value = env[name];
  if (value === undefined) return DEFAULT_SEMANTIC_RELEVANCE_BAR;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new Error(`${name} must be a finite number greater than 0 and less than 1.`);
  }
  return parsed;
}

export function parseSecureDerivativeDefault(value: string | undefined): 'allow' | 'approval' | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'allow' || normalized === 'approval') return normalized;
  throw new Error('OLYMPUS_SECURE_DERIVATIVE_DEFAULT must be allow or approval.');
}

export function sourceIndexTelegramAccountFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return optionalEnv(env, 'OLYMPUS_SOURCE_INDEX_TELEGRAM_ACCOUNT');
}

export function sourceAnswerAccountForCorpus(
  request: { account?: string; corpus_id?: string },
  defaults: { sourceIndexAccount?: string | undefined; telegramMessagesAccount?: string | undefined },
  corpusId?: string,
): string | undefined {
  const requested = request.account?.trim();
  if (requested) return requested;
  const effectiveCorpusId = corpusId ?? request.corpus_id;
  if (effectiveCorpusId === INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID) {
    return defaults.telegramMessagesAccount;
  }
  return defaults.sourceIndexAccount;
}

// The narrowing filters a connector-store corpus can honour on the answer
// lane, resolved through the same codecs `/source/index/search` resolves them
// with. Only the two `source_answer` wire fields are listed: folder filters and
// locator release are search-only surfaces.
const CONNECTOR_STORE_ANSWER_FILTER_CAPABILITIES = connectorStoreFilterCapabilityRegistry([
  [{ family: 'chat' }, { chatScope: CHAT_SCOPE_FILTER_CODEC }],
  [{ family: 'file', provider: 'dropbox' }, { approvedScope: DROPBOX_APPROVED_SCOPE_FILTER_CODEC }],
]);

export interface ConnectorStoreAnswerScopeStore {
  corpusId: string;
  family: SourceFamily;
  conversationTitleCandidates(
    lookupTerms: readonly string[],
    accountScope?: string,
    provider?: string,
  ): ConnectorStoreConversationTitleCandidates;
}

export type ConnectorStoreAnswerScope =
  | Readonly<{ kind: 'search'; accountScope?: string; filters?: ConnectorStoreSearchFilters }>
  | Readonly<{ kind: 'skip'; reason: string }>;

/**
 * Resolve one connector-store corpus's share of a `source_answer` request into
 * the account scope and filters its adapter must carry.
 *
 * `chat_scope` and `approved_scope_key` are narrowing filters that
 * `/source/index/search` resolves through the capability codecs and refuses
 * (400 `unsupported_filter` / `invalid_request`) when it cannot honour them.
 * The answer lane fans out instead of refusing, so the same unhonourable state
 * skips the corpus — audited `no_adapter` — rather than searching it whole. A
 * corpus whose family has no codec for a filter is not scoped BY that filter
 * (chat scope does not narrow Dropbox), which is what the legacy per-source
 * adapters did and what the wire contract describes.
 */
export function connectorStoreAnswerScope(input: {
  store: ConnectorStoreAnswerScopeStore;
  request: SourceIndexAnswerRequest;
  principal?: ConnectorStoreDeclaredPrincipal;
  capabilities?: ConnectorStoreFilterCapabilityRegistry;
}): ConnectorStoreAnswerScope {
  const { store, principal, request } = input;
  const capabilities = (input.capabilities ?? CONNECTOR_STORE_ANSWER_FILTER_CAPABILITIES).resolve({
    family: store.family,
    ...(principal ? { provider: principal.provider } : {}),
  });
  const requestedAccount = request.account?.trim() || undefined;
  const approvedScopeKey = request.approved_scope_key?.trim() || undefined;
  const chatScope = request.chat_scope?.trim() || undefined;
  const conversationId = request.conversation_id?.trim() || undefined;

  let accountScope: string | undefined;
  let provider: string | undefined;
  let locatorPathScope: string | undefined;
  let scopedConversationId = conversationId;

  if (approvedScopeKey && capabilities?.approvedScope) {
    if (!principal) return { kind: 'skip', reason: 'approved_scope_key_no_principal' };
    const resolution = capabilities.approvedScope.resolveLocatorPath(approvedScopeKey, principal);
    if (resolution.kind !== 'path') return { kind: 'skip', reason: 'approved_scope_key_invalid' };
    if (requestedAccount !== undefined && requestedAccount !== resolution.accountScope) {
      return { kind: 'skip', reason: 'approved_scope_key_account_mismatch' };
    }
    accountScope = resolution.accountScope;
    provider = principal.provider;
    locatorPathScope = resolution.locatorPath;
  }

  if (chatScope && capabilities?.chatScope) {
    if (!principal) return { kind: 'skip', reason: 'chat_scope_no_principal' };
    if (requestedAccount !== undefined && requestedAccount !== principal.accountScope) {
      return { kind: 'skip', reason: 'chat_scope_account_mismatch' };
    }
    const resolution = capabilities.chatScope.resolveConversationId(
      chatScope,
      (lookupTerms) => store.conversationTitleCandidates(
        lookupTerms,
        principal.accountScope,
        principal.provider,
      ),
    );
    if (resolution.kind === 'invalid') return { kind: 'skip', reason: 'chat_scope_invalid' };
    if (resolution.kind === 'structured') {
      if (resolution.provider !== undefined && resolution.provider !== principal.provider) {
        return { kind: 'skip', reason: 'chat_scope_provider_mismatch' };
      }
      if (resolution.accountScope !== principal.accountScope) {
        return { kind: 'skip', reason: 'chat_scope_account_mismatch' };
      }
    }
    if (conversationId && (!resolution.resolved || resolution.conversationId !== conversationId)) {
      return { kind: 'skip', reason: 'chat_scope_conversation_id_conflict' };
    }
    accountScope = principal.accountScope;
    provider = principal.provider;
    // An unresolved title keeps the codec's sentinel conversation id, which
    // matches no row: an unresolvable scope narrows to nothing, never to all.
    scopedConversationId = resolution.conversationId;
  }

  const senderId = request.sender_id?.trim() || undefined;
  const senderLabel = request.sender_label?.trim() || undefined;
  const authoredAfter = request.authored_after?.trim() || undefined;
  const authoredBefore = request.authored_before?.trim() || undefined;
  const filters: ConnectorStoreSearchFilters = {
    ...(provider ? { provider } : {}),
    ...(locatorPathScope ? { locatorPathScope } : {}),
    ...(scopedConversationId ? { conversationId: scopedConversationId } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderLabel ? { senderLabel } : {}),
    ...(authoredAfter ? { authoredAfter } : {}),
    ...(authoredBefore ? { authoredBefore } : {}),
  };
  return {
    kind: 'search',
    ...(accountScope ? { accountScope } : {}),
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  };
}



/** The analyst's own test for a candidate it matched but could not read. */




export function accountFromDropboxCredentialHandle(value: string | undefined): string | undefined {
  const handle = value?.trim();
  if (!handle) return undefined;
  const match = /^dropbox\.([a-z0-9_-]+)(?:\.|$)/i.exec(handle);
  return match?.[1];
}


export async function main(): Promise<void> {
  const port = parsePort(process.env.OLYMPUS_EMAIL_SOURCE_PORT ?? '8010');
  const xBookmarksSemanticRelevanceBar = sourceIndexSemanticRelevanceBarFromEnv(process.env);
  const hostname = resolveEmailSourceBindHostFromEnv(process.env);
  const authToken = workerAuthTokenFromEnv(process.env);
  const olympusConfig = loadConfig();
  const sourceCorpusRegistry = createSourceCorpusRegistry(olympusConfig.sourceIndex.corpusRegistry);
  const dropboxIngestionPolicy = loadDropboxIngestionPolicy({
    inlinePolicy: olympusConfig.sourceIndex.ingestionPolicies.dropboxPersonal?.policy,
    policyPath: olympusConfig.sourceIndex.ingestionPolicies.dropboxPersonal?.policyPath,
    env: process.env,
  });
  const sovereigntyEngine = loadSovereigntyEngine({
    env: process.env,
    ...(olympusConfig.sovereignty?.policy ? { inlineConfig: olympusConfig.sovereignty.policy } : {}),
    ...(olympusConfig.sovereignty?.configPath ? { configPath: olympusConfig.sovereignty.configPath } : {}),
  });
  const bootSecretResolver = new WorkerBootSecretResolver({
    resolveSecretRefValueSync: (secretRef, env) => resolveSecretRefValueSync(secretRef, { env }),
  });
  const connector = createEmailSourceConnectorFromEnv();
  const sourceIndexAnswerEnabled = parseOptionalBooleanEnv(
    process.env.OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED,
    'OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED',
  );
  const sourceIndexReadEnabled = olympusConfig.sourceIndex.enabled || olympusConfig.sourceIndex.answerDevEnabled || sourceIndexAnswerEnabled;
  const sourceIndexAccount = process.env.OLYMPUS_SOURCE_INDEX_ACCOUNT
    ?? process.env.OLYMPUS_EMAIL_SOURCE_ACCOUNT;
  const dropboxFilesAccount =
    process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_ACCOUNT?.trim()
    || accountFromDropboxCredentialHandle(process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE);
  const connectedHandles = readActiveConnectedHandles(process.env);
  const dropboxHandle = selectedSourceCredentialHandle({
    env: process.env,
    pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
    provider: 'dropbox',
    capability: 'dropbox.files.sync',
    handles: connectedHandles,
  });
  const readwiseCredentialHandle = selectedSourceCredentialHandle({
    env: process.env,
    pinEnvName: 'OLYMPUS_SOURCE_INDEX_READWISE_CREDENTIAL_HANDLE',
    provider: 'readwise',
    capability: 'readwise.sync',
    handles: connectedHandles,
  });
  const readwiseHandle = sourceIndexLaneEnabled(
    process.env,
    'OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_ENABLED',
    readwiseCredentialHandle !== undefined,
  ) ? readwiseCredentialHandle : undefined;
  // Gmail and Drive deliberately have no boot-time handle binding: their lanes
  // select a handle per scheduler build. Readwise and X still bind their
  // connector runtimes at boot; dashboard hot-activation remains qualification
  // work and must not be confused with the removal of hidden enable flags here.
  const xBookmarksCredentialHandle = selectedSourceCredentialHandle({
    env: process.env,
    pinEnvName: 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CREDENTIAL_HANDLE',
    provider: 'x',
    capability: 'x.bookmarks.sync',
    handles: connectedHandles,
  });
  const xBookmarksHandle = sourceIndexLaneEnabled(
    process.env,
    'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_ENABLED',
    xBookmarksCredentialHandle !== undefined,
  ) ? xBookmarksCredentialHandle : undefined;
  const envPolicyFallback = sovereigntyEngine.source === 'env_bridge';
  const internalPolicyEmbeddingProvider = createSourceIndexEmbeddingProviderFromSovereignty(
    sovereigntyEngine,
    'internal',
    process.env,
    bootSecretResolver,
  );
  const secureLocalPolicyEmbeddingProvider = createSourceIndexEmbeddingProviderFromSovereignty(
    sovereigntyEngine,
    'secure_local',
    process.env,
    bootSecretResolver,
  );
  const sourceIndexEmbeddingProvider = internalPolicyEmbeddingProvider
    ?? (envPolicyFallback ? createSourceIndexEmbeddingProviderFromEnv() : undefined);
  const readwiseEmbeddingProvider = envPolicyFallback
    ? createCloudSourceIndexEmbeddingProviderFromEnv(
      process.env,
      'OLYMPUS_SOURCE_INDEX_READWISE',
    ) ?? sourceIndexEmbeddingProvider
    : sourceIndexEmbeddingProvider;
  const xBookmarksEmbeddingProvider = envPolicyFallback
    ? createCloudSourceIndexEmbeddingProviderFromEnv(
      process.env,
      'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS',
    ) ?? sourceIndexEmbeddingProvider
    : sourceIndexEmbeddingProvider;
  const dropboxFilesEmbeddingProvider = secureLocalPolicyEmbeddingProvider
    ?? (sourceIndexEmbeddingProvider?.backend === 'local'
      ? sourceIndexEmbeddingProvider
      : undefined);
  // Telegram chunks are local-only (internal + secure_local lanes): never hand
  // them to a cloud embedding backend.
  // Frontier-max doctrine: the telegram index gates per trust domain itself —
  // cloud providers are accepted and used ONLY for the internal corpus;
  // protected/secure_local lanes skip semantic until a local provider exists.
  // Prefer the cloud (Gemini) factory like readwise/x — the global source
  // provider on the runtime is the LOCAL lane (dropbox/email depend on it).
  const telegramMessagesEmbeddingProvider = envPolicyFallback
    ? createCloudSourceIndexEmbeddingProviderFromEnv(
      process.env,
      'OLYMPUS_SOURCE_INDEX_TELEGRAM',
    ) ?? sourceIndexEmbeddingProvider
    : sourceIndexEmbeddingProvider;
  // Drive/Docs is INTERNAL only (there is no secure drive corpus), so the
  // cloud (Gemini) source-index provider rides directly — NO local-only gate.
  const googleDriveDocsEmbeddingProvider = sourceIndexEmbeddingProvider;
  const fileExtractionPdfTextCommandEnv = process.env.OLYMPUS_FILE_EXTRACTION_PDF_TEXT_COMMAND?.trim();
  const fileExtractionPdfTextCommand = fileExtractionPdfTextCommandEnv === 'off'
    ? undefined
    : (fileExtractionPdfTextCommandEnv || 'pdftotext');
  const fileExtractionPdfTextTimeoutMs = parseOptionalTimeoutSecondsOrNone(
    process.env.OLYMPUS_FILE_EXTRACTION_PDF_TEXT_TIMEOUT_SECONDS,
    'OLYMPUS_FILE_EXTRACTION_PDF_TEXT_TIMEOUT_SECONDS',
  );
  const fileExtractionPdfRenderTimeoutMs = parseOptionalTimeoutSecondsOrNone(
    process.env.OLYMPUS_FILE_EXTRACTION_PDF_RENDER_TIMEOUT_SECONDS,
    'OLYMPUS_FILE_EXTRACTION_PDF_RENDER_TIMEOUT_SECONDS',
  );
  const fileExtractionOcrTimeoutMs = parseOptionalTimeoutSecondsOrNone(
    process.env.OLYMPUS_FILE_EXTRACTION_OCR_TIMEOUT_SECONDS,
    'OLYMPUS_FILE_EXTRACTION_OCR_TIMEOUT_SECONDS',
  );
  const fileExtractionMaxBoundedTextChars = parseOptionalPositiveInteger(
    process.env.OLYMPUS_FILE_EXTRACTION_MAX_BOUNDED_TEXT_CHARS,
    'OLYMPUS_FILE_EXTRACTION_MAX_BOUNDED_TEXT_CHARS',
  );
  const fileExtractionRemoteEnabled = parseOptionalBooleanEnv(
    process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_ENABLED,
    'OLYMPUS_FILE_EXTRACTION_REMOTE_ENABLED',
  );
  const fileExtractionRemoteConfigured = [
    'OLYMPUS_FILE_EXTRACTION_REMOTE_BASE_URL',
    'OLYMPUS_FILE_EXTRACTION_REMOTE_MODEL',
    'OLYMPUS_FILE_EXTRACTION_REMOTE_API_KEY',
    'OLYMPUS_FILE_EXTRACTION_REMOTE_TIMEOUT_SECONDS',
  ].some((name) => Boolean(process.env[name]?.trim()));
  if (fileExtractionRemoteConfigured && !fileExtractionRemoteEnabled) {
    throw new Error(
      'OLYMPUS_FILE_EXTRACTION_REMOTE_ENABLED=true is required when remote file-extraction settings are present.',
    );
  }
  const fileExtractionRemoteClient = fileExtractionRemoteEnabled
    ? new VeniceVlmClient({
        apiKey: requireFileExtractionVeniceApiKey(process.env),
        baseUrl: requiredFileExtractionEnv(
          process.env,
          'OLYMPUS_FILE_EXTRACTION_REMOTE_BASE_URL',
        ),
        ...(process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_MODEL?.trim()
          ? { model: process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_MODEL.trim() }
          : {}),
        ...(parseOptionalTimeoutSecondsOrNone(
          process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_TIMEOUT_SECONDS,
          'OLYMPUS_FILE_EXTRACTION_REMOTE_TIMEOUT_SECONDS',
        ) !== undefined
          ? {
              timeoutMs: parseOptionalTimeoutSecondsOrNone(
                process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_TIMEOUT_SECONDS,
                'OLYMPUS_FILE_EXTRACTION_REMOTE_TIMEOUT_SECONDS',
              )!,
            }
          : {}),
      })
    : undefined;
  const fileExtractionLocalVlmEnabled = parseOptionalBooleanEnv(
    process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_ENABLED,
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_ENABLED',
  );
  const fileExtractionLocalVlmConfigured = [
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_BASE_URL',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_MODEL',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_API_KEY',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_MAX_PAGES',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRIES',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRY_DELAY_MS',
  ].some((name) => Boolean(process.env[name]?.trim()));
  if (fileExtractionLocalVlmConfigured && !fileExtractionLocalVlmEnabled) {
    throw new Error(
      'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_ENABLED=true is required when local VLM settings are present.',
    );
  }
  const fileExtractionLocalVlmClient = fileExtractionLocalVlmEnabled
    ? new OpenAICompatibleVlmClient({
        baseUrl: requiredFileExtractionEnv(
          process.env,
          'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_BASE_URL',
        ),
        model: requiredFileExtractionEnv(
          process.env,
          'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_MODEL',
        ),
        ...(process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_API_KEY?.trim()
          ? { apiKey: process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_API_KEY.trim() }
          : {}),
        ...(parseOptionalTimeoutSecondsOrNone(
          process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS,
          'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS',
        ) !== undefined
          ? {
              timeoutMs: parseOptionalTimeoutSecondsOrNone(
                process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS,
                'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS',
              )!,
            }
          : {}),
      })
    : undefined;
  const telegramMessagesAccount = sourceIndexTelegramAccountFromEnv(process.env);
  const telegramConnectorAccountScope = telegramMessagesAccount ?? TELEGRAM_PERSONAL_ACCOUNT_SCOPE;
  const readwiseConnectorStoreRuntime = createReadwiseConnectorStoreRuntime({
    enabled: readwiseHandle !== undefined,
    ...(readwiseHandle ? { handle: readwiseHandle } : {}),
    ...(readwiseEmbeddingProvider ? { embeddingProvider: readwiseEmbeddingProvider } : {}),
    ...(sourceIndexAccount ? { account: sourceIndexAccount } : {}),
    env: process.env,
  });
  const readwiseConnectorStore = readwiseConnectorStoreRuntime?.store;
  const readwiseConnectorStoreSync = readwiseConnectorStoreRuntime?.sync;
  const xBookmarksConnectorStoreRuntime = createXBookmarksConnectorStoreRuntime({
    enabled: xBookmarksHandle !== undefined,
    ...(xBookmarksHandle ? { handle: xBookmarksHandle } : {}),
    ...(xBookmarksEmbeddingProvider ? { embeddingProvider: xBookmarksEmbeddingProvider } : {}),
    ...(sourceIndexAccount ? { account: sourceIndexAccount } : {}),
    env: process.env,
  });
  const xBookmarksConnectorStore = xBookmarksConnectorStoreRuntime?.store;
  const xBookmarksConnectorStoreSync = xBookmarksConnectorStoreRuntime?.sync;
  const xBookmarksContentRecovery = xBookmarksConnectorStoreRuntime?.contentRecovery;
  const gmailConnectorStoreLane = sourceIndexLaneStorageDecision(process.env, 'OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_ENABLED', sourceIndexReadEnabled);
  const googleDriveConnectorStoreLane = sourceIndexLaneStorageDecision(process.env, 'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CONNECTOR_STORE_ENABLED', sourceIndexReadEnabled);
  // Exactly one Gmail day counter per runtime, durable across restart.
  // Constructing it before the stores also keeps an invalid budget env from
  // creating the store files at all.
  const gmailRequestBudget = gmailConnectorStoreLane.enabled
    ? createGmailDailyRequestBudget({ env: process.env })
    : undefined;
  const gmailInternalConnectorStore = gmailConnectorStoreLane.enabled
    ? new LocalConnectorStore({
      dbPath: defaultGmailConnectorStoreDbPath(process.env),
      corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
      family: 'email',
      trustDomain: 'internal',
    })
    : undefined;
  const gmailSecureConnectorStore = gmailInternalConnectorStore
    ? new LocalConnectorStore({
      dbPath: defaultGmailSecureConnectorStoreDbPath(process.env),
      corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID,
      family: 'email',
      trustDomain: 'secure_local',
    })
    : undefined;
  // Exactly one Drive day counter per runtime, durable across restart.
  // Constructing it before the stores also keeps an invalid budget env from
  // creating the store files at all.
  const googleDriveRequestBudget = googleDriveConnectorStoreLane.enabled
    ? createGoogleDriveDailyRequestBudget({ env: process.env })
    : undefined;
  // Both Drive stores carry the owner's folder-exclusion gate. Omitting it was
  // the defect: the stores were constructed bare, so even a rule that named
  // Drive had nothing to enforce it, and the corpus filled unconditionally.
  // Built once and shared, so the two trust bands can never drift onto
  // different rules.
  const googleDriveExclusions = googleDriveConnectorStoreLane.enabled
    ? googleDriveIngestionExclusionMatcher(process.env)
    : undefined;
  const googleDriveInternalConnectorStore = googleDriveConnectorStoreLane.enabled
    ? new LocalConnectorStore({
      dbPath: defaultGoogleDriveConnectorStoreDbPath(process.env),
      corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      family: 'file',
      trustDomain: 'internal',
      ...(googleDriveExclusions ? { exclusions: googleDriveExclusions } : {}),
    })
    : undefined;
  const googleDriveSecureConnectorStore = googleDriveInternalConnectorStore
    ? new LocalConnectorStore({
      dbPath: defaultGoogleDriveSecureConnectorStoreDbPath(process.env),
      corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
      ...(googleDriveExclusions ? { exclusions: googleDriveExclusions } : {}),
    })
    : undefined;
  // Dropbox product state. One corpus, secure_local only: Dropbox has never
  // had an internal band. Provider sync, generic extraction, local embeddings,
  // and reads all use this store.
  const dropboxConnectorStoreLane = sourceIndexLaneStorageDecision(process.env, 'OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_ENABLED', sourceIndexReadEnabled);
  const dropboxConnectorStore = dropboxConnectorStoreLane.enabled
    ? createDropboxConnectorStore(process.env, { policy: dropboxIngestionPolicy })
    : undefined;
  const dropboxProviderAccount = dropboxHandle?.accountRole?.trim()
    || dropboxFilesAccount
    || 'personal';
  const dropboxProviderStoreSync = dropboxConnectorStore && dropboxHandle
    ? createDropboxProviderStoreSyncHandler({
        store: dropboxConnectorStore,
        account: dropboxProviderAccount,
        credentialHandle: dropboxHandle.handle,
        ...(dropboxFilesEmbeddingProvider?.backend === 'local'
          ? { embeddingProvider: dropboxFilesEmbeddingProvider }
          : {}),
      })
    : undefined;
  // WhatsApp's store is product state, not a private deployment mount. Opening
  // the long-standing default path preserves captured history; the scheduler
  // below advances its connector cursor without replaying or replacing it.
  const whatsappConnectorStoreLane = sourceIndexLaneStorageDecision(
    process.env,
    'OLYMPUS_SOURCE_INDEX_WHATSAPP_CONNECTOR_STORE_ENABLED',
    sourceIndexReadEnabled,
  );
  const whatsappConnectorStore = whatsappConnectorStoreLane.enabled
    ? createWhatsAppConnectorStore(process.env)
    : undefined;
  const whatsappConnectorStoreSync: WhatsAppConnectorStoreSyncHandler | undefined = whatsappConnectorStore
    ? createWhatsAppConnectorStoreSyncHandler({
        store: whatsappConnectorStore,
        account: WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
        env: process.env,
      })
    : undefined;
  const whatsappLiveMaxItems = parseOptionalPositiveInteger(
    process.env.OLYMPUS_WHATSAPP_LIVE_DRAIN_MAX_ITEMS,
    'OLYMPUS_WHATSAPP_LIVE_DRAIN_MAX_ITEMS',
  );
  // Product-owned canonical Telegram stores at the paths already populated by
  // convergence. The scheduler advances their existing connector cursors; it
  // never replaces the databases or requires a private mount declaration.
  const telegramConnectorStoreLane = sourceIndexLaneStorageDecision(
    process.env,
    'OLYMPUS_SOURCE_INDEX_TELEGRAM_CONNECTOR_STORES_ENABLED',
    sourceIndexReadEnabled,
  );
  const telegramConnectorStores = telegramConnectorStoreLane.enabled
    ? createTelegramConnectorStores(process.env)
    : undefined;
  const telegramConnectorStoreSync: TelegramConnectorStoreSyncHandler | undefined = telegramConnectorStores
    ? createTelegramConnectorStoreSyncHandler({
        stores: telegramConnectorStores,
        env: process.env,
      })
    : undefined;
  const telegramCaptureMaxItems = parseOptionalPositiveInteger(
    process.env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_MAX_ITEMS,
    'OLYMPUS_TELEGRAM_SPOOL_DRAIN_MAX_ITEMS',
  );
  const laneConnectorStores = [
    ...(dropboxConnectorStore ? [dropboxConnectorStore] : []),
    ...(gmailInternalConnectorStore ? [gmailInternalConnectorStore] : []),
    ...(gmailSecureConnectorStore ? [gmailSecureConnectorStore] : []),
    ...(googleDriveInternalConnectorStore ? [googleDriveInternalConnectorStore] : []),
    ...(googleDriveSecureConnectorStore ? [googleDriveSecureConnectorStore] : []),
    ...(readwiseConnectorStore ? [readwiseConnectorStore] : []),
    ...(xBookmarksConnectorStore ? [xBookmarksConnectorStore] : []),
    ...(telegramConnectorStores
      ? [telegramConnectorStores.internal, telegramConnectorStores.secureLocal]
      : []),
    ...(whatsappConnectorStore ? [whatsappConnectorStore] : []),
  ];
  // Connector-store declarations (Reflect, WhatsApp, Roam, ...) arrive via one
  // JSON env. A declaration may name a corpus whose lane already constructed a
  // richer handle with ingestion exclusions or budgets. Reconcile those
  // identities before opening any declared store so the declaration can add a
  // principal without replacing the lane handle or opening the SQLite file a
  // second time.
  const configuredConnectorStoreMounts = parseConnectorStoreMountsFromEnv(
    process.env.OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON,
    { collidingStores: laneConnectorStores },
  );
  const configuredConnectorStores = configuredConnectorStoreMounts.map((mount) => mount.store);
  const connectorStores = mergeConnectorStores([
    ...configuredConnectorStores,
    ...laneConnectorStores,
  ]);
  const readConnectorStores = connectorStores;

  // The source-neutral extraction factory. Off unless its roster names a corpus
  // whose connector store is also configured here, so it cannot half-exist: a
  // lane that accepts requests and has nowhere to put text is worse than a lane
  // that says it is not served. The extractor knobs are the same values the
  // family-scoped lane already reads, renamed off the family.
  const configuredFileExtractionCorpora = parseFileExtractionCorporaEnv(
    process.env.OLYMPUS_FILE_EXTRACTION_CORPORA_JSON,
  );
  const dropboxExtractionScopes = dropboxPolicyFullExtractionScopeKeys(dropboxIngestionPolicy);
  // The roster follows the stores and the policy, never the credentials that
  // happen to be connected at boot. `refreshSchedulerSources` rebuilds the
  // Dropbox lane the moment the owner connects an account, and it hands that
  // lane THIS runtime — so a roster frozen around a missing boot handle meant
  // the lane emitted no extract task until the process restarted.
  const fileExtractionCorpora = fileExtractionCorporaRoster({
    configured: configuredFileExtractionCorpora,
    ...(dropboxConnectorStore
      ? {
          dropbox: {
            extractionScopes: dropboxExtractionScopes,
            resolveCredentialHandle: () => selectedSourceCredentialHandle({
              env: process.env,
              pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
              provider: 'dropbox',
              capability: 'dropbox.files.sync',
              handles: readActiveConnectedHandles(process.env),
            })?.handle,
          },
        }
      : {}),
    ...(whatsappConnectorStore ? { whatsapp: true } : {}),
  });
  if (dropboxConnectorStore && dropboxExtractionScopes.length > 0 && !dropboxHandle) {
    console.warn(
      `[file-extraction] corpus=${DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID} provider=dropbox deferred `
      + 'reason=no_credential_handle — extraction starts on the next scheduler pass after Dropbox is '
      + 'connected, with no restart.',
    );
  }
  const fileExtractionRuntime = createFileExtractionRuntime({
    env: process.env,
    enabled: fileExtractionCorpora.length > 0,
    connectorStores,
    corpora: fileExtractionCorpora,
    extractors: {
      ...(process.env.OLYMPUS_TRANSCRIBE_COMMAND?.trim()
        ? { transcription: { command: process.env.OLYMPUS_TRANSCRIBE_COMMAND.trim() } }
        : {}),
      ...(fileExtractionPdfTextCommand !== undefined || fileExtractionPdfTextTimeoutMs !== undefined
        || fileExtractionMaxBoundedTextChars !== undefined
        ? {
            text: {
              ...(fileExtractionPdfTextCommand ? { pdfTextCommand: fileExtractionPdfTextCommand } : {}),
              ...(fileExtractionPdfTextTimeoutMs !== undefined
                ? { pdfTextTimeoutMs: fileExtractionPdfTextTimeoutMs }
                : {}),
              ...(fileExtractionMaxBoundedTextChars !== undefined
                ? { maxBoundedTextChars: fileExtractionMaxBoundedTextChars }
                : {}),
            },
          }
        : {}),
      ...(fileExtractionOcrTimeoutMs !== undefined || fileExtractionPdfRenderTimeoutMs !== undefined
        ? {
            ocr: {
              ...(fileExtractionOcrTimeoutMs !== undefined ? { ocrTimeoutMs: fileExtractionOcrTimeoutMs } : {}),
              ...(fileExtractionPdfRenderTimeoutMs !== undefined
                ? { pdfRenderTimeoutMs: fileExtractionPdfRenderTimeoutMs }
                : {}),
            },
          }
        : {}),
      ...(fileExtractionRemoteClient
        ? {
            remote: {
              client: fileExtractionRemoteClient,
              ...(process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_MODEL?.trim()
                ? { model: process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_MODEL.trim() }
                : {}),
            },
          }
        : {}),
      ...(fileExtractionLocalVlmClient
        ? {
            vlm: { client: fileExtractionLocalVlmClient },
            vlmPdf: {
              client: fileExtractionLocalVlmClient,
              ...(parseOptionalPositiveInteger(
                process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_MAX_PAGES,
                'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_MAX_PAGES',
              ) !== undefined
                ? {
                    maxPages: parseOptionalPositiveInteger(
                      process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_MAX_PAGES,
                      'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_MAX_PAGES',
                    )!,
                  }
                : {}),
              ...(parseOptionalNonNegativeInteger(
                process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRIES,
                'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRIES',
              ) !== undefined
                ? {
                    pageRetries: parseOptionalNonNegativeInteger(
                      process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRIES,
                      'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRIES',
                    )!,
                  }
                : {}),
              ...(parseOptionalNonNegativeInteger(
                process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRY_DELAY_MS,
                'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRY_DELAY_MS',
              ) !== undefined
                ? {
                    pageRetryDelayMs: parseOptionalNonNegativeInteger(
                      process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRY_DELAY_MS,
                      'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRY_DELAY_MS',
                    )!,
                  }
                : {}),
            },
          }
        : {}),
    },
  });
  const connectorStoreEmbeddingProviders = new Map<string, SourceEmbeddingProvider>();
  const connectorStoreAccountScopes = new Map<string, string>();
  const connectorStorePrincipals = new Map<string, ConnectorStoreDeclaredPrincipal>();
  if (dropboxConnectorStore) {
    connectorStoreAccountScopes.set(
      DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
      dropboxProviderAccount,
    );
    connectorStorePrincipals.set(DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID, {
      provider: 'dropbox',
      accountScope: dropboxProviderAccount,
    });
  }
  if (whatsappConnectorStore) {
    connectorStoreAccountScopes.set(WHATSAPP_LIVE_CORPUS_ID, WHATSAPP_PERSONAL_ACCOUNT_SCOPE);
    connectorStorePrincipals.set(
      WHATSAPP_LIVE_CORPUS_ID,
      canonicalConnectorStoreChatPrincipal('whatsapp', WHATSAPP_PERSONAL_ACCOUNT_SCOPE),
    );
  }
  if (telegramConnectorStores) {
    for (const corpusId of [
      INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
      PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    ]) {
      connectorStoreAccountScopes.set(corpusId, telegramConnectorAccountScope);
      connectorStorePrincipals.set(
        corpusId,
        canonicalConnectorStoreChatPrincipal('telegram', telegramConnectorAccountScope),
      );
    }
  }
  for (const mount of configuredConnectorStoreMounts) {
    if (mount.principal && !connectorStorePrincipals.has(mount.store.corpusId)) {
      connectorStorePrincipals.set(mount.store.corpusId, mount.principal);
    }
    if (mount.store.family !== 'chat' || !mount.chatPrincipal) continue;
    if (!connectorStoreAccountScopes.has(mount.store.corpusId)) {
      connectorStoreAccountScopes.set(mount.store.corpusId, mount.chatPrincipal.accountScope);
    }
  }
  const fullCorpusDefinitions = [
    defineGmailSecureLocalCorpus(),
    defineInternalEmailCorpus(),
    defineGoogleDriveDocsCorpus(),
    defineReadwiseLibraryCorpus(),
    defineXBookmarksCorpus(),
    defineDropboxFilesCorpus(),
    defineInternalTelegramMessagesCorpus(),
    defineProtectedTelegramMessagesCorpus(),
  ];
  const registeredCorpusDefinitions = new Map(
    sourceCorpusRegistry.definitions().map((definition) => [definition.corpusId, definition]),
  );
  const fullyDefinedCorpusIds = new Set(fullCorpusDefinitions.map((definition) => definition.corpusId));
  for (const store of connectorStores) {
    if (fullyDefinedCorpusIds.has(store.corpusId)) continue;
    const registeredDefinition = registeredCorpusDefinitions.get(store.corpusId);
    fullCorpusDefinitions.push(defineConnectorCorpus({
      corpusId: store.corpusId,
      family: store.family,
      trustDomain: store.trustDomain,
      ...(registeredDefinition ? { activationMode: registeredDefinition.activationMode } : {}),
    }));
    fullyDefinedCorpusIds.add(store.corpusId);
  }
  const retrievalAvailability: Record<string, SourceIndexStatusRetrievalAvailability> = {};
  // Every constructed canonical store gets its embedding and retrieval lane.
  if (xBookmarksConnectorStore && xBookmarksEmbeddingProvider) {
    registerConnectorStoreEmbeddingLane({
      store: xBookmarksConnectorStore,
      provider: xBookmarksEmbeddingProvider,
      providers: connectorStoreEmbeddingProviders,
      retrievalAvailability,
    });
  }
  if (readwiseConnectorStore && readwiseEmbeddingProvider) {
    registerConnectorStoreEmbeddingLane({
      store: readwiseConnectorStore,
      provider: readwiseEmbeddingProvider,
      providers: connectorStoreEmbeddingProviders,
      retrievalAvailability,
    });
  }
  for (const store of connectorStores) {
    if (connectorStoreEmbeddingProviders.has(store.corpusId)) continue;
    const provider = store.trustDomain === 'secure_local'
      ? secureLocalPolicyEmbeddingProvider
      : sourceIndexEmbeddingProvider;
    if (!provider || (store.trustDomain === 'secure_local' && provider.backend !== 'local')) continue;
    registerConnectorStoreEmbeddingLane({
      store,
      provider,
      providers: connectorStoreEmbeddingProviders,
      retrievalAvailability,
    });
  }
  if (xBookmarksConnectorStore) {
    const principalXAccount = sourceIndexAccount?.trim() || xBookmarksHandle?.accountRole?.trim();
    if (principalXAccount) connectorStoreAccountScopes.set(xBookmarksConnectorStore.corpusId, principalXAccount);
  }
  if (readwiseConnectorStore) {
    const principalReadwiseAccount =
      sourceIndexAccount?.trim() || readwiseHandle?.accountRole?.trim() || 'personal';
    connectorStoreAccountScopes.set(
      readwiseConnectorStore.corpusId,
      principalReadwiseAccount,
    );
  }
  // No handle, no handler. The stores and the budget exist at boot whatever the
  // registry says, so without this guard an enabled lane would build a sync
  // handler that falls back to the connector's default credential handle and
  // reads a mailbox nobody selected.
  const createGmailConnectorStoreSyncForHandle = (
    handle: ConnectedCredentialHandle | undefined,
  ) => handle && gmailInternalConnectorStore && gmailSecureConnectorStore && gmailRequestBudget
    ? createGmailConnectorStoreSyncHandler({
      internalStore: gmailInternalConnectorStore,
      secureStore: gmailSecureConnectorStore,
      requestBudget: gmailRequestBudget,
      // A fresh provider traversal is a bounded, resumable history walk.
      // Legacy replay is explicit one-time convergence tooling and is never
      // auto-wired into the product server.
      // In-run embedding, the same provider choice the Drive lane makes.
      // Without it the pull fills both stores with chunks and no embeddings,
      // and the corpus can never become servable.
      ...(sourceIndexEmbeddingProvider
        ? { internalEmbeddingProvider: sourceIndexEmbeddingProvider }
        : {}),
      ...(secureLocalPolicyEmbeddingProvider?.backend === 'local'
        ? { secureEmbeddingProvider: secureLocalPolicyEmbeddingProvider }
        : {}),
      ...(handle?.handle ? { credentialHandle: handle.handle } : {}),
      ...(handle?.accountRole ? { account: handle.accountRole } : {}),
    })
    : undefined;
  const createGoogleDriveConnectorStoreSyncForHandle = (
    handle: ConnectedCredentialHandle | undefined,
  ): GoogleDriveConnectorStoreSyncHandler | undefined =>
    handle && googleDriveInternalConnectorStore && googleDriveSecureConnectorStore && googleDriveRequestBudget
      ? createGoogleDriveConnectorStoreSyncHandler({
        internalStore: googleDriveInternalConnectorStore,
        secureStore: googleDriveSecureConnectorStore,
        requestBudget: googleDriveRequestBudget,
        // The same gate the stores hold, handed to the traversal so an excluded
        // file is refused before its content is downloaded rather than after.
        ...(googleDriveExclusions ? { exclusions: googleDriveExclusions } : {}),
        // A fresh runtime traverses provider history directly. Legacy replay
        // is an explicit one-time convergence tool and is never auto-wired
        // into the product server.
        // In-run embedding, the same provider choice the generic connector-store
        // lane makes. Without it the pull fills both stores with chunks and no
        // embeddings, and the corpus can never become servable.
        ...(googleDriveDocsEmbeddingProvider
          ? { internalEmbeddingProvider: googleDriveDocsEmbeddingProvider }
          : {}),
        ...(secureLocalPolicyEmbeddingProvider?.backend === 'local'
          ? { secureEmbeddingProvider: secureLocalPolicyEmbeddingProvider }
          : {}),
        ...(handle?.handle ? { credentialHandle: handle.handle } : {}),
        ...(handle?.accountRole ? { account: handle.accountRole } : {}),
      })
      : undefined;
  // The analyst-backed contracts path is THE source answer path (the template
  // handler was deleted at the Lane F deletion milestone, 2026-06-10).
  const sourceIndexAnswerMaxResults = parseOptionalPositiveInteger(
    process.env.OLYMPUS_SOURCE_INDEX_ANSWER_MAX_RESULTS,
    'OLYMPUS_SOURCE_INDEX_ANSWER_MAX_RESULTS',
  );
  const sourceIndexAnswerMaxCharsPerCandidate = parseOptionalPositiveInteger(
    process.env.OLYMPUS_SOURCE_INDEX_ANSWER_MAX_CHARS_PER_CANDIDATE,
    'OLYMPUS_SOURCE_INDEX_ANSWER_MAX_CHARS_PER_CANDIDATE',
  );
  const sourceIndexTrustedAnalystTimeoutMs = parseOptionalPositiveInteger(
    process.env.OLYMPUS_SOURCE_INDEX_TRUSTED_ANALYST_TIMEOUT_MS,
    'OLYMPUS_SOURCE_INDEX_TRUSTED_ANALYST_TIMEOUT_MS',
  );
  // Local Argus analyst ceiling — decoupled from the OpenClaw tool watchdog
  // budget (request.timeout_ms) and from the trusted-cloud bound. Generous by
  // design; unset falls back to the handler default (DEFAULT_LOCAL_ANALYST_TIMEOUT_MS).
  const sourceAnswerLocalAnalystTimeoutMs = parseOptionalPositiveInteger(
    process.env.OLYMPUS_SOURCE_ANSWER_ANALYST_TIMEOUT_MS,
    'OLYMPUS_SOURCE_ANSWER_ANALYST_TIMEOUT_MS',
  );
  const sourceAnswerLastLegTimeoutMs = parseSecureAnalystPoolLastLegTimeoutMs(
    process.env.OLYMPUS_SOURCE_ANSWER_LAST_LEG_TIMEOUT_MS,
  );
  const veniceAnalystTimeoutMs = process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_TIMEOUT_SECONDS?.trim()
    ? parseRequiredTimeoutSeconds(
      process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_TIMEOUT_SECONDS,
      'OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_TIMEOUT_SECONDS',
    )
    : undefined;
  const veniceReasoningHeadroomTokens = parseOptionalTokenCount(
    process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_HEADROOM_TOKENS,
    'OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_HEADROOM_TOKENS',
  );
  const effectiveTrustedAnalystTimeoutMs = trustedAnalystAssistTimeoutMs({
    explicitTrustedAnalystTimeoutMs: sourceIndexTrustedAnalystTimeoutMs,
    veniceAnalystTimeoutMs,
  });
  const sourceIndexAnalystPreflightTimeoutMs = parseOptionalTimeoutSecondsOrNone(
    process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PREFLIGHT_TIMEOUT_SECONDS,
    'OLYMPUS_SOURCE_INDEX_ANALYST_PREFLIGHT_TIMEOUT_SECONDS',
  ) ?? 0;
  const secureDerivativeDefault = parseSecureDerivativeDefault(
    process.env.OLYMPUS_SECURE_DERIVATIVE_DEFAULT,
  );
  let sourceAnswerLanes: ((request: SourceIndexAnswerRequest) => AnalystAnswerLanes) | undefined;
  const analystSourceAnswer = sourceIndexAnswerEnabled
    ? await (async () => {
      const analystLane = process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE
        ? parseLane(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE)
        : olympusConfig.argus.defaultLane;
      const analystProfile = process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE
        ? parseModelProfile(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE)
        : 'source_answer';
      // Frontier cloud analyst for INTERNAL/PUBLIC packs. secure_local never
      // reaches this standard-cloud lane; its configured secure pool contains
      // only loopback local and approved Venice members.
      // OpenClaw-native cloud analyst: reaches GPT-5.5 through `openclaw infer`
      // (the host's OAuth provider — the user's subscription, no metered API
      // key). secure_local packs never reach it (the membrane in the handler).
      const cloudAnalystEnabled = parseOptionalBooleanEnv(
        process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED,
        'OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED',
        { invalid: 'warn-false' },
      );
      const cloudAnalyst = cloudAnalystEnabled
        ? createAnalyst(
          createOpenClawInferAnalystModel({
            ...(process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL?.trim()
              ? { model: process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL.trim() }
              : {}),
            ...(process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_THINKING?.trim()
              ? { thinking: process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_THINKING.trim() }
              : { thinking: 'low' }),
            ...(process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND?.trim()
              ? { command: process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND.trim() }
              : {}),
          }),
        )
        : undefined;
      const secureLocalAnalystProvider =
        process.env.OLYMPUS_SOURCE_INDEX_SECURE_ANALYST_PROVIDER?.trim() || 'local';
      if (secureLocalAnalystProvider !== 'local') {
        throw new Error(
          'OLYMPUS_SOURCE_INDEX_SECURE_ANALYST_PROVIDER is retired; configure routes.secure_local.pool in sovereignty.json.',
        );
      }
      const veniceModelOptionsFromRequest = (request: { analyst_model?: string }) => ({
        apiKey: requireVeniceApiKey(process.env),
        ...(request.analyst_model?.trim()
          ? { model: request.analyst_model.trim() }
          : process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_MODEL?.trim()
            ? { model: process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_MODEL.trim() }
            : {}),
        ...(process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_BASE_URL?.trim()
          ? { baseUrl: process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_BASE_URL.trim() }
          : {}),
        ...(process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_EFFORT?.trim()
          ? { reasoningEffort: parseVeniceReasoningEffort(process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_EFFORT) }
          : {}),
        ...(process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_THINKING?.trim()
          ? { thinking: parseVeniceThinkingMode(process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_THINKING) }
          : {}),
        ...(veniceReasoningHeadroomTokens !== undefined
          ? { reasoningHeadroomTokens: veniceReasoningHeadroomTokens }
          : {}),
        ...(veniceAnalystTimeoutMs !== undefined
          ? { timeoutMs: veniceAnalystTimeoutMs }
          : {}),
      });
      const localSourceAnswerModel = createDelphiAnalystModel(
        new DelphiClient(olympusConfig),
        process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE
          ? { lane: analystLane, preflightTimeoutMs: sourceIndexAnalystPreflightTimeoutMs }
          : { profile: analystProfile, preflightTimeoutMs: sourceIndexAnalystPreflightTimeoutMs },
      );
      const sovereigntyAnalysts = await createSovereigntyAnalystMap({
        engine: sovereigntyEngine,
        olympusConfig,
        env: process.env,
        defaultLocal: createAnalyst(localSourceAnswerModel, { auditSuspiciousDrafts: true }),
        veniceAnalystTimeoutMs,
        veniceReasoningHeadroomTokens,
        bootSecretResolver,
      });
      const defaultLocalAnalyst = sovereigntyAnalysts.get('local-source-answer')?.analyst
        ?? createAnalyst(localSourceAnswerModel, { auditSuspiciousDrafts: true });
      return createAnalystSourceIndexAnswerHandler({
        analyst: defaultLocalAnalyst,
        queryPlanner: createAnalystQueryPlanner(localSourceAnswerModel),
        ...(cloudAnalyst ? { cloudAnalyst } : {}),
        veniceAnalyst: (request) => {
          const requestedProvider = request.analyst_provider ?? (request.analyst_model ? 'venice' : 'default');
          if (requestedProvider !== 'venice') return undefined;
          return createAnalyst(createVeniceAnalystModel(veniceModelOptionsFromRequest(request)));
        },
        sovereigntyAnalystRoute: ({ pack, localOnly, requestedProvider }) => {
          const trustDomain = analystRouteTrustDomain(pack, localOnly);
          const pool = sovereigntyEngine.resolveAnalystPool({
            trustDomain,
            requestedProvider,
          });
          return sovereigntyAnalystRoutePlan({
            trustDomain,
            pool,
            analysts: sovereigntyAnalysts,
          });
        },
        ...(sourceIndexAnswerMaxResults !== undefined
          ? { defaultMaxResults: sourceIndexAnswerMaxResults }
          : {}),
        ...(sourceIndexAnswerMaxCharsPerCandidate !== undefined
          ? { maxCharsPerCandidate: sourceIndexAnswerMaxCharsPerCandidate }
          : {}),
        ...(effectiveTrustedAnalystTimeoutMs !== undefined
          ? { trustedAnalystTimeoutMs: effectiveTrustedAnalystTimeoutMs }
          : {}),
        ...(sourceAnswerLocalAnalystTimeoutMs !== undefined
          ? { localAnalystTimeoutMs: sourceAnswerLocalAnalystTimeoutMs }
          : {}),
        secureAnalystPool: {
          lastLegTimeoutMs: sourceAnswerLastLegTimeoutMs,
        },
        ...(secureDerivativeDefault !== undefined
          ? { secureDerivativeDefault }
          : {}),
        // Every configured corpus answers through the Analyst: the canonical
        // answer-capable corpus registry, the same adapters the previous
        // handler used, and a LocalContentProvider per mounted corpus feeding
        // real bounded content. A registered corpus without a mounted adapter
        // is audited as skipped/no_adapter instead of silently disappearing
        // from unified fan-out.
        lanes: sourceAnswerLanes = (request) => {
          const connectorStoreAdapter = (
            store: LocalConnectorStore,
          ): SourceIndexCorpusSearchAdapter | undefined => {
            const principal = connectorStorePrincipals.get(store.corpusId);
            const scope = connectorStoreAnswerScope({
              store,
              request,
              ...(principal ? { principal } : {}),
            });
            if (scope.kind === 'skip') return undefined;
            const connectorStoreEmbedding = connectorStoreEmbeddingProviders.get(store.corpusId)
              ?? sourceIndexEmbeddingProvider;
            const connectorStoreAccount = scope.accountScope
              ?? (request.account?.trim() || connectorStoreAccountScopes.get(store.corpusId));
            return createConnectorStoreCorpusAdapter({
              store,
              retrievalMode: request.retrieval_mode ?? 'keyword',
              ...(store.corpusId === X_BOOKMARKS_CORPUS_ID
                ? { semanticRelevanceBar: xBookmarksSemanticRelevanceBar }
                : {}),
              ...(connectorStoreAccount ? { accountScope: connectorStoreAccount } : {}),
              ...(scope.filters ? { filters: scope.filters } : {}),
              ...(connectorStoreEmbedding
                && (store.trustDomain !== 'secure_local' || connectorStoreEmbedding.backend === 'local')
                ? { embeddingProvider: connectorStoreEmbedding }
                : {}),
            });
          };
          return {
            registry: buildSourceIndexCorpusRegistry(
              sourceCorpusRegistry.definitions('answer', fullCorpusDefinitions),
            ),
            adapters: {
              ...Object.fromEntries(
                readConnectorStores
                  .flatMap((store) => {
                    const adapter = connectorStoreAdapter(store);
                    return adapter ? [[store.corpusId, adapter] as const] : [];
                  }),
              ),
            },
            contentProviders: {
              ...Object.fromEntries(
                readConnectorStores
                  .map((store) => [
                    store.corpusId,
                    createConnectorStoreContentProvider({ store }),
                  ]),
              ),
            },
          };
        },
      });
    })()
    : undefined;
  const sourceAnswer = analystSourceAnswer;
  const sourceWatchStore = new LocalSourceWatchStore();
  const sourceWatchExecutor = createSourceWatchExecutorCapability({ executorId: 'source-watch-scheduler' });
  const sourceWatchSearch = sourceAnswerLanes
    ? createSourceWatchSearchFromAnalystLanes(sourceAnswerLanes)
    : undefined;
  const sourceWatchDeliveryTransport = new OpenClawSourceWatchDeliveryTransport({
    ...(authToken ? { authToken } : {}),
  });
  const sourceWatchPass = sourceWatchSearch
    ? {
        run: () => runSourceWatchSchedulerPass({
            store: sourceWatchStore,
            search: sourceWatchSearch,
            transport: sourceWatchDeliveryTransport,
            executor: sourceWatchExecutor,
          }),
      }
    : undefined;
  const sourceIndexStatus = sourceIndexReadEnabled
    ? createSourceIndexStatusHandler({
      corpusDefinitions: sourceCorpusRegistry.definitions('status', fullCorpusDefinitions),
      connectorStores,
      retrievalAvailability,
      // The policy and queue half of the readiness counts, from the shared
      // extraction queue rather than from any source's own index. Absent when
      // the factory is switched off, which leaves the coverage math on the
      // store's own per-item count alone.
      ...(fileExtractionRuntime
        ? { readinessLedger: createExtractionReadinessLedger(fileExtractionRuntime.jobs) }
        : {}),
    })
    : undefined;
  const sourceDashboardHistory = sourceIndexReadEnabled
    ? new SqliteSourceDashboardHistory()
    : undefined;
  const sourceIngestionLedger = sourceIndexReadEnabled
    ? new SqliteSourceIngestionLedgerStore()
    : undefined;
  const schedulerSourcesForHandles = (handles: readonly ConnectedCredentialHandle[]): {
    sources: SourceSchedulerSource[];
    decisions: SourceSchedulerConstructionDecision[];
  } => {
    const decisions: SourceSchedulerConstructionDecision[] = [];
    // Every lane reports why it did or did not build. A constructed source is
    // recorded under its OWN sourceId rather than the id expected here, so an
    // id that cannot be selected is visible in the boot log instead of showing
    // up hours later as an absence on the status surface.
    const recordLane = (
      expectedSourceId: string,
      skipReason: SourceSchedulerConstructionDecision['reason'] | undefined,
      build: () => SourceSchedulerSource | undefined,
    ): SourceSchedulerSource | undefined => {
      if (skipReason) {
        decisions.push({ sourceId: expectedSourceId, outcome: 'skipped', reason: skipReason });
        return undefined;
      }
      const source = build();
      decisions.push(source
        ? { sourceId: source.sourceId, outcome: 'constructed', reason: 'lane_ready' }
        : { sourceId: expectedSourceId, outcome: 'skipped', reason: 'no_tasks' });
      return source;
    };
    // Gmail and Drive select explicitly rather than by first match: a second
    // handle registered tomorrow must not silently rebind the lane to another
    // mailbox. The gate folds the lane enable in, so no handle means no source.
    const currentGmailHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_GMAIL_CREDENTIAL_HANDLE',
      provider: 'gmail',
      capability: 'gmail.email.sync',
      handles,
    });
    const currentGoogleDriveHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CREDENTIAL_HANDLE',
      provider: 'google_drive',
      capability: 'google_drive.docs.sync',
      handles,
    });
    const currentDropboxHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
      provider: 'dropbox',
      capability: 'dropbox.files.sync',
      handles,
    });
    const currentReadwiseHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_READWISE_CREDENTIAL_HANDLE',
      provider: 'readwise',
      capability: 'readwise.sync',
      handles,
    });
    const currentXBookmarksHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CREDENTIAL_HANDLE',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      handles,
    });
    const currentWhatsAppHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_WHATSAPP_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_WHATSAPP_CREDENTIAL_HANDLE',
      provider: 'whatsapp_personal',
      capability: 'whatsapp.personal.messages.sync',
      handles,
    });
    const currentTelegramHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_TELEGRAM_CONNECTOR_STORES_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_TELEGRAM_CREDENTIAL_HANDLE',
      provider: 'telegram',
      capability: 'telegram.messages.sync',
      handles,
    });
    const currentGmailConnectorStoreSync = createGmailConnectorStoreSyncForHandle(currentGmailHandle);
    const currentGoogleDriveConnectorStoreSync = createGoogleDriveConnectorStoreSyncForHandle(currentGoogleDriveHandle);
    const currentDropboxProviderStoreSync = currentDropboxHandle && dropboxConnectorStore
      ? currentDropboxHandle.handle === dropboxHandle?.handle && dropboxProviderStoreSync
        ? dropboxProviderStoreSync
        : createDropboxProviderStoreSyncHandler({
            store: dropboxConnectorStore,
            account: currentDropboxHandle.accountRole?.trim() || dropboxFilesAccount || 'personal',
            credentialHandle: currentDropboxHandle.handle,
            ...(dropboxFilesEmbeddingProvider?.backend === 'local'
              ? { embeddingProvider: dropboxFilesEmbeddingProvider }
              : {}),
          })
      : undefined;
    // The canonical store lane rides the same source id and is bound to the
    // handle its runtime selected at boot.
    const readwiseStoreLaneEnabled = currentReadwiseHandle !== undefined
      && currentReadwiseHandle.handle === readwiseHandle?.handle
      && readwiseConnectorStoreSync !== undefined;
    // Order matters for the token's truth: a store that was never built reports
    // no_store_sync rather than handle_rebound, which would otherwise fire on
    // every boot that had no X handle to bind the store to in the first place.
    const xBookmarksSkipReason = !currentXBookmarksHandle
      ? 'no_handle' as const
      : !xBookmarksConnectorStoreSync
        ? 'no_store_sync' as const
        : currentXBookmarksHandle.handle !== xBookmarksHandle?.handle
          ? 'handle_rebound' as const
          : undefined;
    const sources = [
      recordLane(
        SCHEDULER_SOURCE_IDS.gmail,
        currentGmailHandle ? undefined : 'no_handle',
        () => createGmailConnectorStoreSchedulerSource({
          config: olympusConfig,
          ...(currentGmailConnectorStoreSync ? { sync: currentGmailConnectorStoreSync } : {}),
          ...(gmailInternalConnectorStore ? { internalStore: gmailInternalConnectorStore } : {}),
          ...(gmailSecureConnectorStore ? { secureStore: gmailSecureConnectorStore } : {}),
        }),
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.googleDrive,
        currentGoogleDriveHandle ? undefined : 'no_handle',
        () => createGoogleDriveConnectorStoreSchedulerSource({
          config: olympusConfig,
          ...(currentGoogleDriveConnectorStoreSync ? { liveSync: currentGoogleDriveConnectorStoreSync } : {}),
          ...(googleDriveInternalConnectorStore ? { internalStore: googleDriveInternalConnectorStore } : {}),
          ...(googleDriveSecureConnectorStore ? { secureStore: googleDriveSecureConnectorStore } : {}),
        }),
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.dropbox,
        !currentDropboxHandle
          ? 'no_handle'
          : !currentDropboxProviderStoreSync || !dropboxConnectorStore
            ? 'no_store_sync'
            : undefined,
        () => createCanonicalDropboxSchedulerSource({
          policy: dropboxIngestionPolicy,
          config: olympusConfig,
          ...(currentDropboxProviderStoreSync ? { providerSync: currentDropboxProviderStoreSync } : {}),
          ...(dropboxConnectorStore ? { store: dropboxConnectorStore } : {}),
          ...(fileExtractionRuntime ? { fileExtraction: fileExtractionRuntime.runner } : {}),
          ...(dropboxFilesEmbeddingProvider?.backend === 'local'
            ? { embeddingProvider: dropboxFilesEmbeddingProvider }
            : {}),
        }),
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.readwise,
        readwiseStoreLaneEnabled ? undefined : 'lane_disabled',
        () => createReadwiseSchedulerSource({
          config: olympusConfig,
          ...(readwiseStoreLaneEnabled && readwiseConnectorStoreSync ? { liveSync: readwiseConnectorStoreSync } : {}),
          ...(sourceIndexAccount ? { account: sourceIndexAccount } : currentReadwiseHandle?.accountRole ? { account: currentReadwiseHandle.accountRole } : {}),
        }),
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.xBookmarks,
        xBookmarksSkipReason,
        () => xBookmarksConnectorStoreSync
          ? createXBookmarksSchedulerSource({
            config: olympusConfig,
            liveSync: xBookmarksConnectorStoreSync,
          })
          : undefined,
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.telegram,
        !currentTelegramHandle
          ? 'no_handle'
          : !telegramConnectorStoreSync
            ? 'no_store_sync'
            : undefined,
        () => createTelegramSchedulerSource({
          config: olympusConfig,
          ...(telegramConnectorStoreSync ? { sync: telegramConnectorStoreSync } : {}),
          ...(telegramCaptureMaxItems !== undefined ? { maxItems: telegramCaptureMaxItems } : {}),
        }),
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.whatsapp,
        !currentWhatsAppHandle
          ? 'no_handle'
          : !whatsappConnectorStoreSync
            ? 'no_store_sync'
            : undefined,
        () => createWhatsAppSchedulerSource({
          config: olympusConfig,
          ...(whatsappConnectorStoreSync ? { sync: whatsappConnectorStoreSync } : {}),
          ...(fileExtractionRuntime ? { fileExtraction: fileExtractionRuntime.runner } : {}),
          ...(whatsappLiveMaxItems !== undefined ? { maxItems: whatsappLiveMaxItems } : {}),
        }),
      ),
    ].filter((source): source is SourceSchedulerSource => source !== undefined);
    return {
      decisions,
      sources: sourceWatchPass
        ? attachSourceWatchSchedulerTask({
            sources,
            selectedSourceIds: olympusConfig.worker.scheduler.sourceIds,
            intervalMs: olympusConfig.worker.scheduler.syncIntervalSeconds * 1_000,
            pass: sourceWatchPass,
          })
        : sources,
    };
  };
  const schedulerAssembly = schedulerSourcesForHandles(connectedHandles);
  const schedulerSources = schedulerAssembly.sources;
  const sourceScheduler = olympusConfig.worker.scheduler.enabled
    ? createSourceSchedulerFromConfig({
      config: olympusConfig,
      sources: schedulerSources,
      ...(sourceIndexStatus && sourceIngestionLedger
        ? {
            afterTick: async (schedulerStatus) => {
              const status = await sourceIndexStatus.status({ include_items: false });
              sourceIngestionLedger.record(buildSourceIngestionLedgerSnapshot(status, {
                schedulerStatus,
                sourceCorpusRegistry,
                safeForCastor: true,
              }));
            },
          }
        : {}),
    })
    : undefined;
  // Content-free latency ledger: on by default so the next "why was that answer
  // slow?" is answerable from the host. Only wired when the answer path exists.
  const sourceAnswerLatencyLogPath = sourceAnswer
    ? resolveSourceAnswerLatencyLogPath(process.env)
    : undefined;
  const sourceAnswerLatencyLog = sourceAnswerLatencyLogPath
    ? createFileSourceAnswerLatencyLog(sourceAnswerLatencyLogPath)
    : undefined;
  const worker = createEmailSourceWorker({
    ...(connector ? { connector } : {}),
    ...(sourceAnswer ? { sourceAnswer } : {}),
    ...(sourceAnswerLatencyLog ? { sourceAnswerLatencyLog } : {}),
    ...(sourceIndexStatus ? { sourceIndexStatus } : {}),
    ...(readwiseConnectorStoreSync ? { readwiseConnectorStoreSync } : {}),
    ...(xBookmarksConnectorStoreSync ? { xBookmarksConnectorStoreSync } : {}),
    ...(xBookmarksContentRecovery ? { xBookmarksContentRecovery } : {}),
    dropboxIngestionPolicy,
    ...(sourceIndexEmbeddingProvider ? { sourceIndexEmbeddingProvider } : {}),
    ...(fileExtractionRuntime ? { fileExtraction: fileExtractionRuntime.runner } : {}),
    ...(connectorStores.length > 0 ? { connectorStores } : {}),
    ...(connectorStoreEmbeddingProviders.size > 0 ? { connectorStoreEmbeddingProviders } : {}),
    ...(connectorStoreAccountScopes.size > 0 ? { connectorStoreAccountScopes } : {}),
    ...(connectorStorePrincipals.size > 0 ? { connectorStorePrincipals } : {}),
    ...(sourceScheduler ? { sourceScheduler } : {}),
    ...(sourceWatchPass
      ? {
          sourceWatch: {
            store: sourceWatchStore,
          },
        }
      : {}),
    ...(sourceIndexReadEnabled
      ? {
          sourceDashboard: {
            sovereigntyEngine,
            corpusRegistry: sourceCorpusRegistry,
            registryPath: handleRegistryPathFromEnv(process.env, true)!,
            ...(sourceDashboardHistory ? { history: sourceDashboardHistory } : {}),
            ingestionDispositions: () => openIngestionDispositionsRuntime(process.env),
            enforceConnectedSourceReads: true,
            // The filter applies to the override too. An override is a caller
            // saying which handles changed, never a claim that an unpaired
            // source may start reading again — and routing it around the check
            // is exactly how an outstanding obligation honoured at boot got
            // bypassed on the next unrelated registry change.
            refreshSchedulerSources: (connectedHandlesOverride) => schedulerSourcesForHandles(
              activeLaneHandles(connectedHandlesOverride ?? readActiveConnectedHandles(process.env), process.env),
            ).sources,
            // The hook below is the Dropbox lane and nothing else; every other
            // source reaches it only to be refused. Saying so keeps a Sync now
            // button off the cards it could only 501 for.
            triggerSourceSyncSources: ['dropbox'],
            triggerSourceSync: async (request) => {
              // This hook is the Dropbox lane only. Every other source reaches
              // it after its own dispatch paths declined, so the honest answer
              // is the typed 501 the route already speaks — not a bare Error
              // the generic handler would report as a 500 worker crash.
              if (request.source !== 'dropbox') {
                throw dashboardSourceSyncNotSupportedError(request.source);
              }
              const latestDropboxHandle = selectedSourceCredentialHandle({
                env: process.env,
                pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
                provider: 'dropbox',
                capability: 'dropbox.files.sync',
                handles: readActiveConnectedHandles(process.env),
              });
              const latestDropboxProviderStoreSync = latestDropboxHandle && dropboxConnectorStore
                ? createDropboxProviderStoreSyncHandler({
                    store: dropboxConnectorStore,
                    account: latestDropboxHandle.accountRole?.trim() || dropboxFilesAccount || 'personal',
                    credentialHandle: latestDropboxHandle.handle,
                    ...(dropboxFilesEmbeddingProvider?.backend === 'local'
                      ? { embeddingProvider: dropboxFilesEmbeddingProvider }
                      : {}),
                  })
                : undefined;
              const source = createCanonicalDropboxSchedulerSource({
                policy: dropboxIngestionPolicy,
                config: olympusConfig,
                ...(latestDropboxProviderStoreSync
                  ? { providerSync: latestDropboxProviderStoreSync }
                  : {}),
                ...(dropboxConnectorStore ? { store: dropboxConnectorStore } : {}),
                ...(fileExtractionRuntime ? { fileExtraction: fileExtractionRuntime.runner } : {}),
                ...(dropboxFilesEmbeddingProvider?.backend === 'local'
                  ? { embeddingProvider: dropboxFilesEmbeddingProvider }
                  : {}),
              });
              if (!source) throw new Error('Dropbox sync is not configured.');
              const tasks = [];
              for (const task of source.tasks) {
                tasks.push({ id: task.id, result: await task.run() });
              }
              return {
                kind: 'dashboard_source_sync',
                source: request.source,
                tasks,
                policy: {
                  raw_source_exposed: false,
                  source_text_returned: false,
                  counts_only: true,
                },
              };
            },
          },
        }
      : {}),
    credentialDegradations: () => bootSecretResolver.status(),
    recheckCredentials: () => bootSecretResolver.recheckNow(),
  });
  warnIfWorkerAuthDisabled('private email source worker', authToken, hostname);

  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 0,
    fetch: withWorkerBearerAuth(worker.fetch, { authToken }),
  });
  sourceScheduler?.start();

  // The worker owns a background tick that outlives any request, so the process
  // needs a way to put it down. Without this the only shutdown was the process
  // dying, which is not a shutdown so much as an interruption.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Olympus private email source worker shutting down on ${signal}.`);
    worker.close();
    sourceScheduler?.stop();
    void server.stop();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  console.log(`Olympus private email source worker listening on http://${hostname}:${port}/v1`);
  console.log(sourceIndexLaneStartupLog('Dropbox connector-store storage', dropboxConnectorStoreLane));
  console.log(sourceIndexLaneStartupLog('WhatsApp connector-store storage', whatsappConnectorStoreLane));
  console.log(sourceIndexLaneStartupLog('Telegram connector-store storage', telegramConnectorStoreLane));
  if (sourceScheduler) {
    // Constructed and selected are separate numbers and are printed as such.
    // The old single count read "enabled for 5 source(s)" while one of the five
    // carried an id no allowlist could select, so the number agreed with the
    // allowlist size and the lane was dead.
    for (const line of sourceSchedulerConstructionLogLines({
      decisions: schedulerAssembly.decisions,
      selectedSourceIds: olympusConfig.worker.scheduler.sourceIds,
    })) {
      console.log(line);
    }
    console.log(
      `In-process source scheduler enabled for ${schedulerSources.length} constructed source(s); `
      + `${olympusConfig.worker.scheduler.sourceIds.length} selected.`,
    );
    if (schedulerSources.length === 0) {
      // The state a fresh install boots into. Without this line the only
      // evidence was "constructed=0", which reads like a failure rather than
      // the correct idle state before the first source is connected.
      console.log(
        '[source-scheduler] idle: no source is connected yet; '
        + 'the scheduler is running and will adopt each source as you connect it in the dashboard.',
      );
    }
  }
  console.log(describeSovereigntyPolicy(sovereigntyEngine));
  console.log(
    connector
      ? `Connector: gogcli command adapter with Argus local/private reasoning${parseOptionalBooleanEnv(process.env.OLYMPUS_EMAIL_SOURCE_ENABLE_PLANNER, 'OLYMPUS_EMAIL_SOURCE_ENABLE_PLANNER') ? ' and retrieval planning' : ''}.`
      : 'Connector: gogcli stub, not configured. Set OLYMPUS_EMAIL_SOURCE_CONNECTOR=gogcli to use the command adapter.',
  );
}

export function resolveEmailSourceBindHostFromEnv(env: Record<string, string | undefined> = process.env): string {
  return resolveWorkerBindHost(env, ['OLYMPUS_EMAIL_SOURCE_HOST']);
}

export function sourceIndexLaneEnabled(
  env: Record<string, string | undefined>,
  envName: string,
  handlePresent: boolean,
): boolean {
  return sourceIndexLaneDecision(env, envName, handlePresent).enabled;
}

export function sourceIndexLaneStorageEnabled(
  env: Record<string, string | undefined>,
  envName: string,
  sourceIndexReadEnabled: boolean,
): boolean {
  return sourceIndexLaneStorageDecision(env, envName, sourceIndexReadEnabled).enabled;
}

/**
 * The X legacy bookmarks index is retired (2026-07-28): reads are served by the
 * connector store, its vectors were imported there, and the database is deleted
 * on the host. This lane alone must not inherit the source-index read-surface
 * fallback every other lane uses, because opening the index recreates the file
 * that was just deleted — an absent env would silently resurrect an empty
 * legacy database. The mount now requires an explicit opt-in.
 */

/**
 * Readwise now follows X onto the canonical connector store. The legacy index
 * remains available only for an explicit, one-time convergence operation; an
 * absent flag must not recreate or schedule it during normal product runtime.
 */


export interface SourceIndexLaneDecision {
  enabled: boolean;
  envName: string;
  decidedBy: string;
}

export function sourceIndexLaneDecision(
  env: Record<string, string | undefined>,
  envName: string,
  handlePresent: boolean,
): SourceIndexLaneDecision {
  if (env[envName]?.trim()) {
    return {
      enabled: parseOptionalBooleanEnv(env[envName], envName),
      envName,
      decidedBy: envName,
    };
  }
  return {
    enabled: handlePresent,
    envName,
    decidedBy: handlePresent ? 'connected handle fallback' : 'no connected handle',
  };
}

export function sourceIndexLaneStorageDecision(
  env: Record<string, string | undefined>,
  envName: string,
  sourceIndexReadEnabled: boolean,
): SourceIndexLaneDecision {
  if (env[envName]?.trim()) {
    return {
      enabled: parseOptionalBooleanEnv(env[envName], envName),
      envName,
      decidedBy: envName,
    };
  }
  return {
    enabled: sourceIndexReadEnabled,
    envName,
    decidedBy: 'source-index read surface fallback',
  };
}

export function sourceIndexLaneStartupLog(label: string, decision: SourceIndexLaneDecision): string {
  return `${label}: ${decision.enabled ? 'enabled' : 'disabled'} (decided by ${decision.decidedBy}).`;
}

export function activeCredentialHandle(
  handles: readonly ConnectedCredentialHandle[],
  match: {
    provider: ConnectedCredentialHandle['provider'];
    capability: string;
  },
): ConnectedCredentialHandle | undefined {
  return handles.find((handle) =>
    handle.provider === match.provider
    && handle.allowedCapabilities.includes(match.capability)
    && handle.backendState?.status !== 'reauth_required'
  );
}

export type CredentialHandleSelectionReason =
  | 'selected'
  | 'none'
  | 'ambiguous'
  | 'pinned_missing';

export interface CredentialHandleSelection {
  handle?: ConnectedCredentialHandle;
  reason: CredentialHandleSelectionReason;
  /** Eligible handle names, so an ambiguous refusal can name what it saw. */
  candidates: string[];
}

/**
 * Explicit, order-independent handle selection.
 *
 * `activeCredentialHandle` is a first-match `find`, and the registry is written
 * back sorted by handle name, so with two eligible handles the alphabetically
 * first one wins. That is how registering `gmail.business_ocu.delegated`
 * alongside `gmail.personal.delegated` silently rebound the Gmail lane from the
 * 73,212-message mailbox to the 25-message one: registration order, not
 * configuration, chose the mailbox.
 *
 * This selector never picks by order. Exactly one eligible handle is selected;
 * more than one is refused as ambiguous until an operator pins the one the lane
 * must read. A pin that names an unregistered handle is also refused rather
 * than falling back, because a silent fallback is the same defect wearing a
 * different hat.
 */
export function selectCredentialHandle(
  handles: readonly ConnectedCredentialHandle[],
  match: {
    provider: ConnectedCredentialHandle['provider'];
    capability: string;
    /** Operator pin naming the exact handle this lane must read. */
    pinnedHandle?: string;
  },
): CredentialHandleSelection {
  const eligible = handles.filter((handle) =>
    handle.provider === match.provider
    && handle.allowedCapabilities.includes(match.capability)
    && handle.backendState?.status !== 'reauth_required'
  );
  const candidates = eligible.map((handle) => handle.handle);
  const pinnedHandle = match.pinnedHandle?.trim();
  if (pinnedHandle) {
    const pinned = eligible.find((handle) => handle.handle === pinnedHandle);
    return pinned
      ? { handle: pinned, reason: 'selected', candidates }
      : { reason: 'pinned_missing', candidates };
  }
  if (eligible.length === 0) return { reason: 'none', candidates };
  if (eligible.length > 1) return { reason: 'ambiguous', candidates };
  return { handle: eligible[0]!, reason: 'selected', candidates };
}

/**
 * The single gate a connector-store lane passes before it may construct: the
 * lane enable must be on AND exactly one handle must be selected.
 *
 * Both halves matter. The lane enable alone is not enough, because the sync
 * handler is built from stores that exist at boot regardless of credentials —
 * so an enabled lane with no handle would construct a source that cannot run,
 * and the activation gate reads presence as readiness.
 */
export function connectorStoreLaneHandle(input: {
  env: Record<string, string | undefined>;
  laneEnvName: string;
  pinEnvName: string;
  provider: ConnectedCredentialHandle['provider'];
  capability: string;
  handles: readonly ConnectedCredentialHandle[];
  warn?: (message: string) => void;
}): ConnectedCredentialHandle | undefined {
  const handle = selectedSourceCredentialHandle(input);
  // Evaluated unconditionally so a malformed lane enable still fails the boot
  // even when no eligible credential handle exists.
  const laneEnabled = sourceIndexLaneEnabled(
    input.env,
    input.laneEnvName,
    handle !== undefined,
  );
  return handle && laneEnabled ? handle : undefined;
}

/** Select a source credential independently from any storage-lane enable. */
export function selectedSourceCredentialHandle(input: {
  env: Record<string, string | undefined>;
  pinEnvName: string;
  provider: ConnectedCredentialHandle['provider'];
  capability: string;
  handles: readonly ConnectedCredentialHandle[];
  warn?: (message: string) => void;
}): ConnectedCredentialHandle | undefined {
  const selection = selectCredentialHandle(input.handles, {
    provider: input.provider,
    capability: input.capability,
    ...(input.env[input.pinEnvName]?.trim()
      ? { pinnedHandle: input.env[input.pinEnvName]!.trim() }
      : {}),
  });
  const warn = input.warn ?? ((message: string) => console.warn(message));
  if (selection.reason === 'ambiguous') {
    warn(
      `${input.provider} lane refused to construct: ${selection.candidates.length} handles carry ${input.capability} `
      + `(${selection.candidates.join(', ')}). Set ${input.pinEnvName} to the handle this lane must read.`,
    );
  }
  if (selection.reason === 'pinned_missing') {
    warn(
      `${input.provider} lane refused to construct: ${input.pinEnvName} names a handle that is not registered with `
      + `${input.capability} (registered: ${selection.candidates.join(', ') || 'none'}).`,
    );
  }
  return selection.handle;
}

export interface XBookmarksConnectorStoreRuntime {
  store: LocalConnectorStore;
  sync: XBookmarksConnectorStoreSyncHandler;
  contentRecovery: XBookmarksContentRecoveryHandler;
}

export interface ReadwiseConnectorStoreRuntime {
  store: LocalConnectorStore;
  sync: ReadwiseConnectorStoreSyncHandler;
}

export function createReadwiseConnectorStoreRuntime(options: {
  enabled: boolean;
  handle?: ConnectedCredentialHandle;
  embeddingProvider?: SourceEmbeddingProvider;
  account?: string;
  dbPath?: string;
  /** Test/owner injection; the runtime otherwise derives one durable counter. */
  requestBudget?: ReadwiseDailyRequestBudget;
  requestBudgetStatePath?: string;
  env?: Record<string, string | undefined>;
}): ReadwiseConnectorStoreRuntime | undefined {
  if (!options.enabled || !options.embeddingProvider) return undefined;
  const handle = options.handle;
  if (
    handle
    && (
      handle.provider !== 'readwise'
      || !handle.allowedCapabilities.includes('readwise.sync')
      || handle.backendState?.status === 'reauth_required'
    )
  ) {
    return undefined;
  }
  const env = options.env ?? process.env;
  const account = options.account?.trim() || handle?.accountRole?.trim() || 'personal';
  // Exactly one day counter per runtime, durable across restart. Constructing
  // it here (before the store) also keeps an invalid budget env from creating
  // the store file at all.
  const requestBudget = options.requestBudget
    ?? createReadwiseDailyRequestBudget({
      env,
      ...(options.requestBudgetStatePath ? { statePath: options.requestBudgetStatePath } : {}),
    });
  const store = createReadwiseConnectorStore(
    options.dbPath ?? defaultReadwiseConnectorStoreDbPath(env),
  );
  const sync = createReadwiseConnectorStoreSyncHandler({
    store,
    embeddingProvider: options.embeddingProvider,
    account,
    requestBudget,
    ...(env.OLYMPUS_SOURCE_INDEX_READWISE_CREDENTIAL_HANDLE?.trim()
      ? { credentialHandle: env.OLYMPUS_SOURCE_INDEX_READWISE_CREDENTIAL_HANDLE.trim() }
      : handle?.handle
        ? { credentialHandle: handle.handle }
        : {}),
    ...(env.OLYMPUS_SOURCE_INDEX_READWISE_API_V2_BASE_URL?.trim()
      ? { apiV2BaseUrl: env.OLYMPUS_SOURCE_INDEX_READWISE_API_V2_BASE_URL.trim() }
      : {}),
    ...(env.OLYMPUS_SOURCE_INDEX_READWISE_READER_API_V3_BASE_URL?.trim()
      ? { readerApiV3BaseUrl: env.OLYMPUS_SOURCE_INDEX_READWISE_READER_API_V3_BASE_URL.trim() }
      : {}),
    env,
  });
  return { store, sync };
}

export function createXBookmarksConnectorStoreRuntime(options: {
  enabled: boolean;
  handle?: ConnectedCredentialHandle;
  embeddingProvider?: SourceEmbeddingProvider;
  account?: string;
  dbPath?: string;
  usageStore?: LocalXBookmarksApiUsageStore;
  env?: Record<string, string | undefined>;
}): XBookmarksConnectorStoreRuntime | undefined {
  const handle = options.handle;
  const env = options.env ?? process.env;
  const principalAccount = options.account?.trim() || handle?.accountRole?.trim() || 'personal';
  const providerUserId = env.OLYMPUS_SOURCE_INDEX_X_USER_ID?.trim()
    || handle?.providerAccountId?.trim();
  if (
    !options.enabled
    || !handle
    || handle.provider !== 'x'
    || !handle.allowedCapabilities.includes('x.bookmarks.sync')
    || handle.backendState?.status === 'reauth_required'
    || !options.embeddingProvider
    || !providerUserId
  ) {
    return undefined;
  }
  const store = createXBookmarksConnectorStore(
    options.dbPath ?? defaultXBookmarksConnectorStoreDbPath(env),
  );
  const usageStore = options.usageStore ?? new LocalXBookmarksApiUsageStore();
  const reconcileStateStore = new LocalXBookmarksReconcileStateStore(
    defaultXBookmarksReconcileStateDbPath(env, usageStore.dbPath),
  );
  // One broker instance owns both scheduled acquisition and operator recovery.
  // X rotates refresh tokens, so separate minters in separate processes can
  // revoke the worker's live session; keeping both paths inside this runtime
  // makes the single-minter rule structural.
  const credentialBroker = createEnvCredentialBroker({ env });
  const sync = createXBookmarksConnectorStoreSyncHandler({
    store,
    embeddingProvider: options.embeddingProvider,
    credentialHandle: handle.handle,
    account: principalAccount,
    userId: providerUserId,
    credentialBroker,
    ...(env.OLYMPUS_SOURCE_INDEX_X_API_BASE_URL?.trim()
      ? { apiBaseUrl: env.OLYMPUS_SOURCE_INDEX_X_API_BASE_URL.trim() }
      : {}),
    usageStore,
    reconcileStateStore,
    env,
  });
  const contentRecovery = createXBookmarksContentRecoveryHandler({
    store,
    usageStore,
    reconcileStateStore,
    embeddingProvider: options.embeddingProvider,
    credentialHandle: handle.handle,
    credentialBroker,
    account: principalAccount,
    userId: providerUserId,
    ...(env.OLYMPUS_SOURCE_INDEX_X_API_BASE_URL?.trim()
      ? { apiBaseUrl: env.OLYMPUS_SOURCE_INDEX_X_API_BASE_URL.trim() }
      : {}),
    env,
  });
  return { store, sync, contentRecovery };
}

/**
 * The single gate every lane-building path passes through.
 *
 * Boot, the adoption tick and the dashboard's refresh callback all end up here,
 * including when a caller supplies its own handle list: one choke point is what
 * makes "a source the owner unpaired does not get a lane" true of every path
 * rather than of the one that happened to remember.
 */
function activeLaneHandles(
  handles: readonly ConnectedCredentialHandle[],
  env: Record<string, string | undefined>,
): ConnectedCredentialHandle[] {
  const registryPath = handleRegistryPathFromEnv(env, true);
  if (!registryPath) return [...handles];
  try {
    return withoutUnpairedLaneHandles(handles, registryPath);
  } catch (error) {
    console.warn(`Could not read the Olympus unpaired-source record: ${error instanceof Error ? error.message : String(error)}`);
    return [...handles];
  }
}

function readActiveConnectedHandles(env: Record<string, string | undefined>): ConnectedCredentialHandle[] {
  const registryPath = handleRegistryPathFromEnv(env, true);
  if (!registryPath) return [];
  try {
    // The registry alone is not the whole answer. A handle an Unpair could not
    // remove is still in this file, and building its lane at boot would quietly
    // undo the teardown; the unpaired record is what says so.
    return activeLaneHandles(
      readConnectedHandleRegistry(registryPath).handles
        .filter((handle) => handle.backendState?.status !== 'reauth_required'),
      env,
    );
  } catch (error) {
    console.warn(`Could not read Olympus handle registry for source activation: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('OLYMPUS_EMAIL_SOURCE_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

function firstNonEmptyEnv(env: Record<string, string | undefined>, names: string[]): string | undefined {
  for (const name of names) {
    const value = optionalEnv(env, name);
    if (value) return value;
  }
  return undefined;
}

function requireVeniceApiKey(env: Record<string, string | undefined>): string {
  const apiKey = firstNonEmptyEnv(env, [
    'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
    'VENICE_API_KEY',
    'API_KEY_VENICE',
    'Venice-API-Key',
  ]);
  if (!apiKey) {
    throw new Error('Venice analyst requires OLYMPUS_SOURCE_INDEX_VENICE_API_KEY, VENICE_API_KEY, API_KEY_VENICE, or Venice-API-Key in the assistant runtime.');
  }
  return apiKey;
}

function requireFileExtractionVeniceApiKey(
  env: Record<string, string | undefined>,
): string {
  const apiKey = firstNonEmptyEnv(env, [
    'OLYMPUS_FILE_EXTRACTION_REMOTE_API_KEY',
    'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
    'VENICE_API_KEY',
    'API_KEY_VENICE',
    'Venice-API-Key',
  ]);
  if (!apiKey) {
    throw new Error(
      'Remote file extraction requires OLYMPUS_FILE_EXTRACTION_REMOTE_API_KEY or an approved shared Venice API-key environment reference.',
    );
  }
  return apiKey;
}

function requiredFileExtractionEnv(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when remote file extraction is enabled.`);
  return value;
}

async function resolveSecretRef(
  secretRef: string | undefined,
  env: Record<string, string | undefined>,
  label: string,
): Promise<string> {
  return resolveSecretRefSync(secretRef, env, label) ?? (() => {
    throw new Error(`${label} secretRef did not resolve.`);
  })();
}

function resolveSecretRefSync(
  secretRef: string | undefined,
  env: Record<string, string | undefined>,
  label: string,
  options: {
    bootSecretResolver?: WorkerBootSecretResolver;
    affectedProfiles?: string[];
    affectedCapabilities?: string[];
  } = {},
): string | undefined {
  const ref = secretRef?.trim();
  if (!ref) {
    if (options.bootSecretResolver) {
      return options.bootSecretResolver.resolveSync(undefined, env, {
        displayName: label,
        ...(options.affectedProfiles ? { affectedProfiles: options.affectedProfiles } : {}),
        ...(options.affectedCapabilities ? { affectedCapabilities: options.affectedCapabilities } : {}),
      });
    }
    throw new Error(`${label} requires a secretRef; inline secrets are not allowed in sovereignty.json.`);
  }
  if (options.bootSecretResolver) {
    return options.bootSecretResolver.resolveSync(ref, env, {
      displayName: label,
      ...(options.affectedProfiles ? { affectedProfiles: options.affectedProfiles } : {}),
      ...(options.affectedCapabilities ? { affectedCapabilities: options.affectedCapabilities } : {}),
    });
  }
  const value = resolveSecretRefValueSync(ref, { env });
  if (!value) {
    throw new Error(`${label} secretRef did not resolve.`);
  }
  return value;
}

function bootSecretOptions(
  bootSecretResolver: WorkerBootSecretResolver | undefined,
  affectedProfiles: string[],
  affectedCapabilities: string[],
): {
  bootSecretResolver?: WorkerBootSecretResolver;
  affectedProfiles: string[];
  affectedCapabilities: string[];
} {
  return {
    ...(bootSecretResolver ? { bootSecretResolver } : {}),
    affectedProfiles,
    affectedCapabilities,
  };
}


function optionalEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}




export function commaSeparatedEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(/,|\|\|/)
    .map((item) => item.trim())
    .filter(Boolean);
}

if (import.meta.main) {
  await main();
}

export interface ConnectorStoreMount {
  store: LocalConnectorStore;
  principal?: ConnectorStoreDeclaredPrincipal;
  chatPrincipal?: ConnectorStoreChatPrincipal;
}

export interface ConnectorStoreMountParsingOptions {
  reportFailure?: (message: string) => void;
  collidingStores?: readonly LocalConnectorStore[];
}

interface ValidatedConnectorStoreMountDeclaration {
  dbPath: string;
  corpusId: string;
  family: Parameters<typeof defineConnectorCorpus>[0]['family'];
  trustDomain: Parameters<typeof defineConnectorCorpus>[0]['trustDomain'];
  principal?: ConnectorStoreDeclaredPrincipal;
  chatPrincipal?: ConnectorStoreChatPrincipal;
}

export function parseConnectorStoreMountsFromEnv(
  raw: string | undefined,
  options: ConnectorStoreMountParsingOptions = {},
): ConnectorStoreMount[] {
  const value = raw?.trim();
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON must be valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON must be a JSON array.');
  }

  const reportFailure = options.reportFailure ?? ((message: string) => console.error(message));
  const collidingStoresByCorpusId = new Map(
    (options.collidingStores ?? []).map((store) => [store.corpusId, store]),
  );
  // The resource being fenced is the SQLite file, and corpusId is the field an
  // operator varies when adding a mount. Keyed on corpusId alone, a new id over
  // an existing dbPath skips the identity check entirely and opens a second
  // handle that relabels the same rows with a different family/trustDomain.
  const ownerCorpusIdByDbPath = new Map(
    (options.collidingStores ?? []).map((store) => [store.dbPath, store.corpusId]),
  );
  const declarations: ValidatedConnectorStoreMountDeclaration[] = [];
  // Validate every declaration before opening any SQLite store. A malformed
  // later entry therefore cannot strand a handle opened for an earlier one.
  for (const [index, entry] of parsed.entries()) {
    const declaredCorpusIdValue = entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>).corpusId
      : undefined;
    const declaredCorpusId = typeof declaredCorpusIdValue === 'string'
      ? declaredCorpusIdValue.trim()
      : '';
    try {
      declarations.push(validateConnectorStoreMountDeclaration(entry));
    } catch (error) {
      const label = declaredCorpusId || `entry #${index + 1}`;
      const detail = error instanceof Error ? error.message : String(error);
      reportFailure(`Connector-store mount ${label} skipped: ${detail}`);
    }
  }

  const mounts: ConnectorStoreMount[] = [];
  for (const declaration of declarations) {
    try {
      const collidingStore = collidingStoresByCorpusId.get(declaration.corpusId);
      if (collidingStore) assertConnectorStoreMountIdentity(declaration, collidingStore);
      const pathOwnerCorpusId = ownerCorpusIdByDbPath.get(declaration.dbPath);
      if (pathOwnerCorpusId !== undefined && pathOwnerCorpusId !== declaration.corpusId) {
        throw new Error(
          `dbPath ${JSON.stringify(declaration.dbPath)} is already mounted as corpus ${JSON.stringify(pathOwnerCorpusId)}.`,
        );
      }
      const store = collidingStore ?? new LocalConnectorStore({
        dbPath: declaration.dbPath,
        corpusId: declaration.corpusId,
        family: declaration.family,
        trustDomain: declaration.trustDomain,
      });
      ownerCorpusIdByDbPath.set(declaration.dbPath, declaration.corpusId);
      mounts.push({
        store,
        ...(declaration.principal ? { principal: declaration.principal } : {}),
        ...(declaration.chatPrincipal ? { chatPrincipal: declaration.chatPrincipal } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reportFailure(`Connector-store mount ${declaration.corpusId} skipped: ${detail}`);
    }
  }
  return mounts;
}

// Exact string equality on dbPath is deliberate (R49). Normalizing
// (realpath/resolve) could silently ACCEPT a declaration for a different
// file behind a symlink or `..` variant — the exact defect this reconcile
// exists to prevent. A lexically divergent path to the same file fails
// closed and loud: the declaration is skipped whole and its principal
// never registers.
function assertConnectorStoreMountIdentity(
  declaration: ValidatedConnectorStoreMountDeclaration,
  store: LocalConnectorStore,
): void {
  const mismatches = [
    ...(declaration.dbPath === store.dbPath
      ? []
      : [`dbPath ${JSON.stringify(declaration.dbPath)} does not match lane ${JSON.stringify(store.dbPath)}`]),
    ...(declaration.family === store.family
      ? []
      : [`family ${JSON.stringify(declaration.family)} does not match lane ${JSON.stringify(store.family)}`]),
    ...(declaration.trustDomain === store.trustDomain
      ? []
      : [`trustDomain ${JSON.stringify(declaration.trustDomain)} does not match lane ${JSON.stringify(store.trustDomain)}`]),
  ];
  if (mismatches.length > 0) {
    throw new Error(`declaration conflicts with the lane store: ${mismatches.join('; ')}.`);
  }
}

function validateConnectorStoreMountDeclaration(entry: unknown): ValidatedConnectorStoreMountDeclaration {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Each connector store entry must be an object.');
  }
  const record = entry as Record<string, unknown>;
  const dbPath = typeof record.dbPath === 'string' ? record.dbPath.trim() : '';
  const corpusId = typeof record.corpusId === 'string' ? record.corpusId.trim() : '';
  const family = typeof record.family === 'string' ? record.family.trim() : '';
  const trustDomain = typeof record.trustDomain === 'string' ? record.trustDomain.trim() : '';
  if (!dbPath || !corpusId || !family || !trustDomain) {
    throw new Error('Connector store entries require dbPath, corpusId, family, trustDomain.');
  }
  if (!isAbsolute(dbPath)) {
    throw new Error('Connector store dbPath must be absolute.');
  }
  // Both enums are checked before the casts below. Every secure gate in this
  // worker is exact equality against 'secure_local', so a typo'd domain does
  // not degrade the mount — it silently leaves the secure band entirely.
  if (!isDeclarableSourceFamily(family)) {
    throw new Error(
      `Connector store family must be one of: ${SOURCE_FAMILIES.join(', ')} (or an "x-" extension id).`,
    );
  }
  if (!isDeclarableSourceTrustDomain(trustDomain)) {
    throw new Error(
      `Connector store trustDomain must be one of: ${SOURCE_TRUST_DOMAINS.join(', ')} (or an "x-" extension id).`,
    );
  }
  const hasPrincipalProvider = Object.prototype.hasOwnProperty.call(record, 'principalProvider');
  const hasPrincipalAccountScope = Object.prototype.hasOwnProperty.call(record, 'principalAccountScope');
  if (hasPrincipalProvider !== hasPrincipalAccountScope) {
    throw new Error('Connector store principal identity requires both principalProvider and principalAccountScope.');
  }
  let chatPrincipal: ConnectorStoreChatPrincipal | undefined;
  let principal: ConnectorStoreDeclaredPrincipal | undefined;
  if (hasPrincipalProvider && hasPrincipalAccountScope) {
    principal = canonicalConnectorStoreChatPrincipal(
      record.principalProvider,
      record.principalAccountScope,
    );
    if (family === 'chat') chatPrincipal = principal;
  }
  return {
    dbPath,
    corpusId,
    family: family as Parameters<typeof defineConnectorCorpus>[0]['family'],
    trustDomain: trustDomain as Parameters<typeof defineConnectorCorpus>[0]['trustDomain'],
    ...(principal ? { principal } : {}),
    ...(chatPrincipal ? { chatPrincipal } : {}),
  };
}

function isSourceIndexExtensionId(value: string): boolean {
  return value.startsWith('x-') && value.length > 2;
}

function isDeclarableSourceFamily(value: string): boolean {
  return (SOURCE_FAMILIES as readonly string[]).includes(value) || isSourceIndexExtensionId(value);
}

function isDeclarableSourceTrustDomain(value: string): boolean {
  return (SOURCE_TRUST_DOMAINS as readonly string[]).includes(value) || isSourceIndexExtensionId(value);
}

function mergeConnectorStores(stores: readonly LocalConnectorStore[]): LocalConnectorStore[] {
  const byCorpusId = new Map<string, LocalConnectorStore>();
  for (const store of stores) {
    if (!byCorpusId.has(store.corpusId)) {
      byCorpusId.set(store.corpusId, store);
    }
  }
  return [...byCorpusId.values()];
}
