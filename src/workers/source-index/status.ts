import { buildSourceIndexCorpusRegistry, type SourceIndexCorpusDefinition } from '../../core/source-index/corpus.ts';
import { canonicalSourceCorpusId } from '../../core/source-corpus-registry.ts';
import { ITEMS_WITH_TEXT_COUNT_KEY } from '../dashboard/answer-ready-coverage.ts';
import {
  assessSourceIndexRetrievalState,
  type SourceIndexHybridAvailability,
} from '../../core/source-index/retrieval.ts';
import {
  LocalConnectorStore,
  type ConnectorStoreSenderAggregation,
  type ConnectorStoreStatus,
  type ConnectorStoreSyncRun,
} from '../connector-store/index.ts';
import {
  defineGmailSecureLocalCorpus,
  defineGoogleDriveDocsCorpus,
  defineInternalEmailCorpus,
} from '../google-connectors/corpora.ts';
import { defineReadwiseLibraryCorpus } from '../readwise/index.ts';
import { defineXBookmarksCorpus } from '../x-bookmarks/index.ts';
import { defineDropboxFilesCorpus } from '../dropbox-files/index.ts';
import {
  defineInternalTelegramMessagesCorpus,
  defineProtectedTelegramMessagesCorpus,
} from '../telegram-messages/index.ts';
import type { WorkerCredentialDegradation } from '../credential-degradation.ts';
import type { ContentExtractionThroughputSignal } from '../../core/ingestion-throughput.ts';
import { OperationError } from '../../core/operation-error.ts';

/**
 * Per-ITEM embedding parity: files whose every chunk carries a current vector.
 * This is the numerator the dashboard's embedding bar divides in FILES rather
 * than chunks, so one long part-embedded PDF can no longer read as ready.
 */
export const ITEMS_EMBEDDED_COUNT_KEY = 'items_embedded';

export interface SourceIndexStatusRequest {
  account?: string;
  corpus_id?: string;
  approved_scope_key?: string;
  chat_scope?: string;
  conversation_id?: string;
  include_sender_aggregation?: boolean;
  max_senders?: number;
  include_path_prefixes?: string[];
  exclude_path_prefixes?: string[];
  extractor_kind?: string;
  extractor_version?: string;
  mime_types?: string[];
  mime_type_prefixes?: string[];
  file_extensions?: string[];
  required_artifact_kind?: string;
  required_artifact_warning?: string;
  qa_verdicts?: string[];
  source_extractor_kinds?: string[];
  source_job_statuses?: string[];
  include_readiness_ledger?: boolean;
  readiness_ledger_max_age_ms?: number;
  include_ingestion_ledger?: boolean;
  include_items?: boolean;
  max_items?: number;
  query?: string;
}

export interface SourceIndexStatusResult {
  kind: 'source_index_status';
  generated_at: string;
  corpora: SourceIndexStatusCorpus[];
  degraded_credentials?: WorkerCredentialDegradation[];
  embedding_lane?: SourceIndexEmbeddingLaneState;
  ingestion_ledger?: unknown;
  sender_aggregation?: ConnectorStoreSenderAggregation;
  answer_latency_ledger?: {
    write_failure_count: number;
    last_failure_class?: string;
  };
  policy: {
    read_only: true;
    raw_source_exposed: false;
    source_packets_exposed: false;
    source_text_returned: false;
    secure_local_item_metadata_exposed: false;
    castor_visible: true;
  };
}

export interface SourceIndexEmbeddingLaneState {
  state: 'enabled' | 'embedding_lane_disabled';
  reason?: 'embedding_provider_unavailable';
  affected_credentials?: string[];
  affected_profiles?: string[];
  affected_capabilities?: string[];
  hint?: string;
}

export interface SourceIndexCorpusStatusBase {
  corpus_id: string;
  family: string;
  trust_domain: string;
  activation_mode: string;
  embedding_policy: string;
  embedding_lane?: SourceIndexEmbeddingLaneState;
  configured: boolean;
  item_metadata_returned: false;
  read_authority: 'connector_store';
  provider: string;
  last_refresh?: SourceIndexLastRefresh;
  retrieval?: {
    declared_mode: string;
    servable_mode: 'keyword' | 'hybrid';
    state: 'ready' | 'degraded';
    reason?: string;
    model_id?: string;
    embedding_epoch?: string;
    backend?: string;
  };
  embedding_parity?: {
    required: boolean;
    chunks: number;
    embedded_chunks: number;
    missing_chunks: number;
    refresh_needed: boolean;
  };
  content_extraction_throughput?: ContentExtractionThroughputSignal;
}

export interface SourceIndexConnectorStoreStatus extends SourceIndexCorpusStatusBase {
  configured: true;
  counts: {
    indexed_items: number;
    tombstoned_items: number;
    chunks: number;
    embedded_chunks: number;
    sync_runs: number;
    [readinessCount: string]: number;
  };
  skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor';
}

export interface SourceIndexConfiguredCorpusStatus extends SourceIndexCorpusStatusBase {
  configured: false;
  skipped_item_metadata_reason: 'source_index_not_configured';
}

export type SourceIndexStatusCorpus =
  | SourceIndexConnectorStoreStatus
  | SourceIndexConfiguredCorpusStatus;

export interface SourceIndexLastRefresh {
  sync_run_id: string;
  status: string;
  completed_at?: string;
  started_at?: string;
  items_seen: number;
  items_indexed: number;
  source_scope?: string;
}

export interface SourceIndexStatusHandler {
  status(request?: SourceIndexStatusRequest): Promise<SourceIndexStatusResult>;
}

export interface SourceIndexStatusHandlerOptions {
  corpusDefinitions?: SourceIndexCorpusDefinition[];
  connectorStores?: LocalConnectorStore[];
  retrievalAvailability?: Readonly<Record<string, SourceIndexStatusRetrievalAvailability | undefined>>;
  readinessLedger?: SourceIndexReadinessLedger;
  nowMs?: () => number;
}

/**
 * Where the readiness and policy counts beyond the store's own five come from,
 * asked per corpus and answered by whoever owns that evidence.
 *
 * One interface rather than a per-family option, and no source named on either
 * side of it: the ledger is handed a corpus id and returns counts, so a source
 * that grows extraction evidence is served by being enumerated. The counts it
 * returns are merged UNDER the store's own facts (see `connectorStoreStatus`),
 * so a ledger can add vocabulary but can never overwrite the read authority's
 * answer about how much it holds.
 */
export interface SourceIndexReadinessSnapshot {
  counts: Record<string, number>;
  contentExtractionThroughput?: ContentExtractionThroughputSignal;
}

export interface SourceIndexReadinessLedger {
  snapshotForCorpus(corpusId: string): SourceIndexReadinessSnapshot | undefined;
}

export type SourceIndexStatusRetrievalAvailability =
  | SourceIndexHybridAvailability
  | ((request: SourceIndexStatusRequest) => SourceIndexHybridAvailability);

/**
 * Kept as the dashboard polling contract: how stale a readiness ledger that
 * caller would accept.
 *
 * The dashboard supplies this allowance on every poll. The handler memoizes the
 * complete per-corpus snapshot for at most this window, avoiding repeated
 * whole-corpus counts while preserving live reads for callers that omit it.
 */
export const DASHBOARD_READINESS_LEDGER_MAX_AGE_MS = 120_000;

export function createSourceIndexStatusHandler(
  options: SourceIndexStatusHandlerOptions = {},
): SourceIndexStatusHandler {
  const storesByCorpusId = new Map((options.connectorStores ?? []).map((store) => [store.corpusId, store]));
  const definitions = options.corpusDefinitions ?? defaultCorpusDefinitions();
  const registry = buildSourceIndexCorpusRegistry(definitions);
  const cache = new Map<string, { recordedAtMs: number; status: SourceIndexStatusCorpus }>();
  const nowMs = options.nowMs ?? Date.now;

  return {
    async status(request: SourceIndexStatusRequest = {}): Promise<SourceIndexStatusResult> {
      assertSupportedStatusRequest(request);
      const requestedCorpusId = request.corpus_id
        ? canonicalSourceCorpusId(request.corpus_id)
        : undefined;
      const corpora = registry
        .list()
        .filter((corpus) => requestedCorpusId === undefined || corpus.corpusId === requestedCorpusId);
      const statuses = corpora.map((corpus) => {
        const store = storesByCorpusId.get(corpus.corpusId);
        const maxAgeMs = normalizedStatusCacheMaxAge(request.readiness_ledger_max_age_ms);
        // Availability is resolved BEFORE the cache is consulted and is part of
        // the key: the embedded counts are a claim about the serving model, so
        // a status cached under model A must not be served after a switch to
        // model B for the rest of the cache window.
        const availability = resolveStatusRetrievalAvailability(
          options.retrievalAvailability?.[corpus.corpusId],
          request,
        );
        // Encoded structurally: model ids and epochs are free-form strings, so
        // a delimiter-joined key could collide ("m:a"+"b" vs "m"+"a:b").
        const cacheKey = JSON.stringify([
          corpus.corpusId,
          request.include_readiness_ledger === true ? 'full' : 'cheap',
          availability === undefined ? null : [
            availability.servable,
            availability.modelId ?? null,
            availability.embeddingEpoch ?? null,
            availability.reason ?? null,
            availability.backend ?? null,
          ],
        ]);
        const cached = maxAgeMs > 0 ? cache.get(cacheKey) : undefined;
        if (cached && nowMs() - cached.recordedAtMs <= maxAgeMs) return cached.status;
        // Gated because a readiness ledger is the expensive half of this
        // payload: the public status operation documents the flag and defaults
        // it off for cheap polling, while the dashboard — whose one headline
        // percentage is computed from exactly these counts — always asks.
        const readiness = store && request.include_readiness_ledger === true
          ? options.readinessLedger?.snapshotForCorpus(corpus.corpusId)
          : undefined;
        const status = store
          ? connectorStoreStatus(
            corpus,
            store.status(),
            readiness?.counts,
            readiness?.contentExtractionThroughput,
            availability?.modelId,
          )
          : configuredCorpusStatus(corpus);
        const resolved = withRetrievalEnforcementStatus(corpus, status, availability);
        if (maxAgeMs > 0) cache.set(cacheKey, { recordedAtMs: nowMs(), status: resolved });
        return resolved;
      });
      const result: SourceIndexStatusResult = {
        kind: 'source_index_status',
        generated_at: new Date().toISOString(),
        corpora: statuses,
        policy: {
          read_only: true,
          raw_source_exposed: false,
          source_packets_exposed: false,
          source_text_returned: false,
          secure_local_item_metadata_exposed: false,
          castor_visible: true,
        },
      };

      if (request.include_sender_aggregation) {
        if (!requestedCorpusId || !request.account?.trim() || !request.conversation_id?.trim()) {
          throw new Error('Sender aggregation requires corpus_id, account, and conversation_id.');
        }
        const corpus = corpora.find((candidate) => candidate.corpusId === requestedCorpusId);
        const store = storesByCorpusId.get(requestedCorpusId);
        if (!corpus || corpus.family !== 'chat' || corpus.trustDomain === 'secure_local' || !store) {
          throw new Error('Sender aggregation requires a configured non-secure-local chat connector store.');
        }
        result.sender_aggregation = store.senderAggregation({
          accountScope: request.account.trim(),
          conversationId: request.conversation_id.trim(),
          provider: providerFromCorpusId(requestedCorpusId),
          ...(request.max_senders !== undefined ? { maxSenders: request.max_senders } : {}),
        });
      }

      if (request.include_ingestion_ledger) {
        const { buildSourceIngestionLedgerSnapshot } = await import('../source-ingestion-ledger.ts');
        result.ingestion_ledger = buildSourceIngestionLedgerSnapshot(result, { safeForCastor: true });
      }
      return result;
    },
  };
}

function normalizedStatusCacheMaxAge(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), DASHBOARD_READINESS_LEDGER_MAX_AGE_MS);
}

function assertSupportedStatusRequest(request: SourceIndexStatusRequest): void {
  const unsupported = [
    'approved_scope_key', 'chat_scope', 'include_path_prefixes', 'exclude_path_prefixes',
    'extractor_kind', 'extractor_version', 'mime_types', 'mime_type_prefixes', 'file_extensions',
    'required_artifact_kind', 'required_artifact_warning', 'qa_verdicts', 'source_extractor_kinds',
    'source_job_statuses', 'max_items', 'query',
  ].filter((key) => request[key as keyof SourceIndexStatusRequest] !== undefined);
  if (request.include_items === true) unsupported.push('include_items');
  if (request.account !== undefined && request.include_sender_aggregation !== true) unsupported.push('account');
  if (request.conversation_id !== undefined && request.include_sender_aggregation !== true) unsupported.push('conversation_id');
  if (unsupported.length > 0) {
    throw new OperationError(
      'invalid_params',
      `source_index_status does not support these filters on the connector-store status surface: ${[...new Set(unsupported)].sort().join(', ')}.`,
      'Use source_index_search for item filtering, or request unfiltered corpus status.',
    );
  }
}

export function resolveStatusRetrievalAvailability(
  availability: SourceIndexStatusRetrievalAvailability | undefined,
  request: SourceIndexStatusRequest,
): SourceIndexHybridAvailability | undefined {
  if (typeof availability !== 'function') return availability;
  try {
    return availability(request);
  } catch {
    return { servable: false, reason: 'hybrid_capability_unreported' };
  }
}

function defaultCorpusDefinitions(): SourceIndexCorpusDefinition[] {
  return [
    defineGmailSecureLocalCorpus(),
    defineInternalEmailCorpus(),
    defineGoogleDriveDocsCorpus(),
    defineReadwiseLibraryCorpus(),
    defineXBookmarksCorpus(),
    defineDropboxFilesCorpus(),
    defineInternalTelegramMessagesCorpus(),
    defineProtectedTelegramMessagesCorpus(),
  ];
}

function connectorStoreStatus(
  corpus: SourceIndexCorpusDefinition,
  status: ConnectorStoreStatus,
  readinessCounts?: Record<string, number>,
  extractionThroughput?: ContentExtractionThroughputSignal,
  servingModelId?: string,
): SourceIndexConnectorStoreStatus {
  // Parity is a claim about the SERVING model. With the model known, both
  // embedded counts come from its row (zero when it holds nothing here);
  // without one, the chunk count falls back to the store's model-agnostic
  // figure and the per-item count is not published at all — the dashboard
  // then says "not measured" rather than counting a retired model's vectors.
  const forModel = servingModelId === undefined
    ? undefined
    : status.embeddingByModel.find((entry) => entry.modelId === servingModelId)
      ?? { modelId: servingModelId, embeddedChunks: 0, itemsEmbedded: 0 };
  return {
    ...baseStatus(corpus),
    configured: true,
    counts: {
      // The ledger's vocabulary first, so the read authority's own facts below
      // always win a collision. What the store holds is never the ledger's
      // answer to give.
      ...readinessCounts,
      indexed_items: status.counts.items,
      tombstoned_items: status.counts.tombstonedItems,
      chunks: status.counts.chunks,
      embedded_chunks: forModel?.embeddedChunks ?? status.counts.embeddedChunks,
      sync_runs: status.counts.syncRuns,
      // Published unconditionally, ledger or not. It is one indexed probe per
      // item and it is the count every answer-ready ratio divides by; leaving
      // it to the gated ledger is what let an ungated status answer with no
      // per-item readiness at all.
      [ITEMS_WITH_TEXT_COUNT_KEY]: status.counts.itemsWithText,
      // The per-item parity gauge the dashboard's embedding bar divides in
      // files: published only against a known serving model.
      ...(forModel === undefined ? {} : { [ITEMS_EMBEDDED_COUNT_KEY]: forModel.itemsEmbedded }),
    },
    ...(status.lastSyncRun
      ? { last_refresh: lastRefreshFromConnectorStoreSync(status.lastSyncRun) }
      : {}),
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
    ...(extractionThroughput ? { content_extraction_throughput: extractionThroughput } : {}),
  };
}

function configuredCorpusStatus(
  corpus: SourceIndexCorpusDefinition,
): SourceIndexConfiguredCorpusStatus {
  return {
    ...baseStatus(corpus),
    configured: false,
    skipped_item_metadata_reason: 'source_index_not_configured',
  };
}

function baseStatus(corpus: SourceIndexCorpusDefinition): SourceIndexCorpusStatusBase {
  return {
    corpus_id: corpus.corpusId,
    family: corpus.family,
    trust_domain: corpus.trustDomain,
    activation_mode: corpus.activationMode,
    embedding_policy: corpus.embeddingPolicy,
    configured: false,
    item_metadata_returned: false,
    read_authority: 'connector_store',
    provider: providerFromCorpusId(corpus.corpusId),
  };
}

function withRetrievalEnforcementStatus<T extends SourceIndexStatusCorpus>(
  corpus: SourceIndexCorpusDefinition,
  status: T,
  hybridAvailability: SourceIndexHybridAvailability | undefined,
): T {
  const retrieval = assessSourceIndexRetrievalState({
    declaredMode: corpus.activationMode,
    ...(hybridAvailability ? { hybridAvailability } : {}),
  });
  const counts = status.configured ? status.counts : undefined;
  const chunks = counts?.chunks ?? 0;
  const noCurrentArtifacts = retrieval.reason === 'no_current_embedding_artifacts';
  const embeddedChunks = noCurrentArtifacts
    ? 0
    : counts?.embedded_chunks ?? 0;
  // The per-item count the dashboard divides in files follows the same rule
  // as the chunk count: with no artifacts on the serving model, nothing is
  // embedded for answering purposes, whatever hash parity the store holds.
  const currentCounts = counts !== undefined && noCurrentArtifacts && ITEMS_EMBEDDED_COUNT_KEY in counts
    ? { counts: { ...counts, [ITEMS_EMBEDDED_COUNT_KEY]: 0 } }
    : {};
  const embeddingRequired = corpus.embeddingPolicy !== 'disabled';
  return {
    ...status,
    ...currentCounts,
    retrieval: {
      declared_mode: retrieval.declaredMode,
      servable_mode: retrieval.servableMode,
      state: retrieval.health,
      ...(retrieval.reason ? { reason: retrieval.reason } : {}),
      ...(retrieval.modelId ? { model_id: retrieval.modelId } : {}),
      ...(retrieval.embeddingEpoch ? { embedding_epoch: retrieval.embeddingEpoch } : {}),
      ...(retrieval.backend ? { backend: retrieval.backend } : {}),
    },
    embedding_parity: {
      required: embeddingRequired,
      chunks,
      embedded_chunks: embeddedChunks,
      missing_chunks: Math.max(0, chunks - embeddedChunks),
      refresh_needed: embeddingRequired && embeddedChunks < chunks,
    },
  };
}

function lastRefreshFromConnectorStoreSync(sync: ConnectorStoreSyncRun): SourceIndexLastRefresh {
  return {
    sync_run_id: sync.syncRunId,
    status: sync.status,
    ...(sync.completedAt ? { completed_at: sync.completedAt } : {}),
    started_at: sync.startedAt,
    items_seen: sync.itemsSeen,
    items_indexed: sync.itemsIndexed,
    source_scope: sync.connectorId,
  };
}

function providerFromCorpusId(corpusId: string): string {
  const parts = corpusId.split('.');
  if (parts[0] === 'secure_local' || parts[0] === 'public_safe' || parts[0] === 'internal') {
    if (parts[1] === 'email') return 'gmail';
    if (parts[1] === 'drive') return 'google_drive';
    return parts[1] ?? 'unknown';
  }
  return parts[0] || 'unknown';
}
