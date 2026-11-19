import { createDashboardHeldRead } from '../dashboard/held-read.ts';
import type { StoreTotals } from '../connector-store/store-totals.ts';
import type { SovereigntyTrustDomainPolicy } from '../../core/sovereignty.ts';
import { offThreadReadsSupported, readInBackground } from '../connector-store/off-thread-reads.ts';
import { buildSourceIndexCorpusRegistry, type SourceIndexCorpusDefinition } from '../../core/source-index/corpus.ts';
import { embeddingModelEstimate, estimatedEmbeddingCostUsd } from '../../core/embedding-cost-estimates.ts';
import { canonicalSourceCorpusId } from '../../core/source-corpus-registry.ts';
import {
  ITEMS_WITH_TEXT_COUNT_KEY,
  UNREADABLE_ITEMS_COUNT_KEY,
  UNSUPPORTED_KIND_COUNT_KEY,
  PICTURES_NOT_READ_HERE_COUNT_KEY,
  METADATA_ONLY_EXPECTED_COUNT_KEY,
  OUT_OF_CONTENT_SCOPE_COUNT_KEY,
} from '../dashboard/answer-ready-coverage.ts';
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
import type {
  CONNECTOR_STORE_PRIVATE_TIER_EMBEDDING_WITHHELD_REASON,
  ConnectorStoreStatusScope,
} from '../connector-store/local-index.ts';
import type { SourceEmbeddingBackend } from './embeddings.ts';
import {
  defineGmailSecureLocalCorpus,
  defineGoogleDriveDocsCorpus,
  defineInternalEmailCorpus,
} from '../google-connectors/corpora.ts';
import { defineReadwiseLibraryCorpus } from '../readwise/index.ts';
import { defineXBookmarksCorpus } from '../x-bookmarks/index.ts';
import { defineDropboxFilesCorpus } from '../dropbox-files/index.ts';
import { defineLocalFilesCorpus } from '../local-files/store.ts';
import {
  defineInternalTelegramMessagesCorpus,
  defineProtectedTelegramMessagesCorpus,
} from '../telegram-messages/index.ts';
import type { WorkerCredentialDegradation } from '../credential-degradation.ts';
import type { ContentExtractionThroughputSignal } from '../../core/ingestion-throughput.ts';
import { OperationError } from '../../core/operation-error.ts';
import { PEOPLE_AUTHORED_FAMILIES } from '../../core/people-index.ts';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { ingestionTurn } from '../control-path-headroom.ts';
import { SecretLocationsIndex, secretLocationsPathForStore } from '../classification/secret-locations.ts';

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
  /**
   * For a snapshot caller (the dashboard, the scheduler's publish): how old
   * the counts served are. They come from the last complete status, while
   * the next one is read behind the request.
   */
  snapshot_age_ms?: number;
  /** Age of the oldest kept front totals while a refresh is due. */
  live_totals_age_ms?: number;
  /** The split's front before the background's first count: no numbers yet. */
  counting?: boolean;
  corpora: SourceIndexStatusCorpus[];
  degraded_credentials?: WorkerCredentialDegradation[];
  embedding_lane?: SourceIndexEmbeddingLaneState;
  ingestion_ledger?: unknown;
  sender_aggregation?: ConnectorStoreSenderAggregation;
  /** Four-tier classification backlog: "checking N items, about X remaining", counts only. */
  tier_classification?: SourceIndexTierClassificationStatus;
  answer_latency_ledger?: {
    write_failure_count: number;
    last_failure_class?: string;
  };
  /**
   * The owner's tier migration (design section 4.6), content-free: plan and
   * batch states, the approval's ledger entry id, and the stores it touches.
   * Absent when no migration was ever planned.
   */
  tier_migration?: SourceIndexTierMigrationStatus;
  policy: {
    read_only: true;
    raw_source_exposed: false;
    source_packets_exposed: false;
    source_text_returned: false;
    secure_local_item_metadata_exposed: false;
    castor_visible: true;
  };
}

export interface SourceIndexTierMigrationStatus {
  plan_id: string;
  state: 'planned' | 'approved' | 'running' | 'stopped' | 'done' | 'superseded';
  /** True while an approved plan is moving items or has work left: parity lag in its stores is expected. */
  in_progress: boolean;
  approval_entry_id?: string;
  proposed: number;
  batches: Array<{ batch_id: string; state: string; moved: number; secrets: number; skipped: number }>;
  corpora: string[];
  chunks_to_embed: number;
  /** The stores the plan hands chunks to embed, and how many: the only lag the doctor excuses, capped at these counts. */
  destinations: Array<{ corpus_id: string; chunks_to_embed: number }>;
  names_only_kept_chunks: number;
  purged: boolean;
  /** When a stopped plan stopped: the doctor excuses its lag only for a bounded time after. */
  stopped_at?: string;
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
    servable_mode: 'keyword' | 'hybrid' | 'metadata_only';
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
    /**
     * For a store served hybrid: an ESTIMATE of embedding what is still
     * missing on the serving model (characters / 4 tokens, priced from the
     * install's estimates or the unverified defaults). Never a billing fact.
     */
    backlog_estimate?: {
      model_id: string;
      missing_chunks: number;
      estimated_tokens: number;
      estimated_cost_usd: number;
      price_source: 'config' | 'default_unverified';
    };
    /**
     * Chunks the serving embedder may not receive because their row is
     * Private by its own tier and the embedder is not approved for Private
     * content (a local embedder or the approved Venice lane). They stay
     * unembedded on purpose: counted in missing_chunks, never in the backlog
     * estimate, and never a reason for refresh_needed. Counts only.
     */
    private_tier_withheld?: {
      chunks: number;
      reason: typeof CONNECTOR_STORE_PRIVATE_TIER_EMBEDDING_WITHHELD_REASON;
    };
  };
  content_extraction_throughput?: ContentExtractionThroughputSignal;
  /**
   * Chat and email stores only (#1076): how many active items carry no
   * author (no sender id and no sender label), in all and per provider.
   * Counts only. A release check reads it to catch a connector that stops
   * publishing who sent each message.
   */
  author_coverage?: SourceIndexAuthorCoverage;
  /**
   * PDFs catalogued with no extracted text yet, and an ESTIMATE of what
   * embedding them would cost once extracted: their count times the average
   * text of this store's already-extracted PDFs (characters / 4 tokens).
   * `olympus source extract-pdfs --run` extracts them.
   */
  pdf_extraction?: {
    pending_pdfs: number;
    extracted_pdfs: number;
    estimate_after_extraction?: {
      model_id: string;
      estimated_tokens: number;
      estimated_cost_usd: number;
      price_source: 'config' | 'default_unverified';
    };
  };
}

export interface SourceIndexAuthorCoverage {
  items: number;
  items_without_author: number;
  by_provider: Array<{ provider: string; items: number; items_without_author: number }>;
}

function authorCoverageStatus(
  store: LocalConnectorStore,
  reused: (read: () => ReturnType<LocalConnectorStore['authorCoverage']>) => ReturnType<LocalConnectorStore['authorCoverage']> = (read) => read(),
): SourceIndexAuthorCoverage | undefined {
  try {
    const rows = reused(() => store.authorCoverage());
    return {
      items: rows.reduce((total, row) => total + row.items, 0),
      items_without_author: rows.reduce((total, row) => total + row.itemsWithoutAuthor, 0),
      by_provider: rows.map((row) => ({ provider: row.provider, items: row.items, items_without_author: row.itemsWithoutAuthor })),
    };
  } catch {
    return undefined;
  }
}

/**
 * The store's plain totals as its writes left them (store-totals.ts), read at
 * every status, so never old even when `counts` come from a kept snapshot.
 * Whole store: no scope or tier adjustment (those are `counts`).
 */
export interface SourceIndexStoreTotals {
  items: number;
  tombstoned_items: number;
  chunks: number;
  sync_runs: number;
  vectors_by_model: Record<string, number>;
  /** When an exact count last confirmed them. */
  reconciled_at: string;
}

export interface SourceIndexConnectorStoreStatus extends SourceIndexCorpusStatusBase {
  configured: true;
  /** Live plain totals; absent until the background's first reconcile of this store. */
  totals?: SourceIndexStoreTotals;
  /**
   * The totals as of the counts below (same snapshot). Each read brings the
   * counts an import moves (items, chunks, vectors on the serving model, and
   * the embedding parity built from them) forward by what the totals moved
   * since, so finished work shows at once; the scope- and tier-adjusted
   * counts stay as counted until the next recount.
   */
  totals_at_count?: Omit<SourceIndexStoreTotals, 'reconciled_at'>;
  /** Present when the counts above were brought forward by the live totals. */
  counts_brought_forward?: { items: number; chunks: number; embedded_chunks: number };
  /** Opaque approval revision binding these counts to one file-source scope. */
  scope_revision?: string;
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
  /**
   * `snapshot.countsMaxAgeMs`: for a caller that shows or records a snapshot
   * (the dashboard, the after-tick ingestion record), how old each store's
   * hidden-copy set behind the counts may be. Left out, every count is current.
   */
  status(request?: SourceIndexStatusRequest, snapshot?: { countsMaxAgeMs?: number }): Promise<SourceIndexStatusResult>;
  /** Resolves once every status refresh running behind a snapshot caller has finished. */
  settled?(): Promise<void>;
  /**
   * The split's background only (`snapshotRole: 'writer'`): recount the status
   * a snapshot caller with this request gets, and keep it for the front. The
   * background's paced recount calls it; no request does.
   */
  refreshSnapshot?(request: SourceIndexStatusRequest, snapshot: { countsMaxAgeMs: number }): Promise<SourceIndexStatusResult>;
}

export interface SourceIndexStatusHandlerOptions {
  /**
   * Where the last status for each snapshot caller is kept (counts only), so
   * a restarted engine answers its first dashboard read at once from it.
   */
  snapshotPath?: string;
  /**
   * The engine split. 'writer' (the background): snapshot reads are served
   * from what it kept and never start a recount; only `refreshSnapshot` (its
   * paced recount) counts, and writes `snapshotPath`. 'reader' (the front):
   * snapshot reads are served from the background's `snapshotPath`, never
   * counted here; a request the background has not counted yet (a first
   * start) is counted once in memory. Left out: one engine serves and
   * refreshes behind each read.
   */
  snapshotRole?: 'writer' | 'reader';
  /** Live, deduplicated unreadable population when the problem list is wired. */
  // Undefined: no recount yet, so the ledger's own count stands.
  unreadableCount?: (corpusId: string) => number | undefined;
  /**
   * The corpora status reports. A function is read on every request, so a
   * per-tier store a tier set creates at runtime (design
   * per-item-four-tier-classification.md, section 3.2) is reported from the
   * moment it exists, with no restart.
   */
  corpusDefinitions?: SourceIndexCorpusDefinition[] | (() => SourceIndexCorpusDefinition[]);
  /**
   * Read on every request too: a runtime appends a store its tier set opened
   * to this same array.
   */
  connectorStores?: LocalConnectorStore[];
  retrievalAvailability?: Readonly<Record<string, SourceIndexStatusRetrievalAvailability | undefined>>;
  /** Live policy intent, independent of provider availability; read before cache lookup. */
  retrievalPolicy?: (domain: SourceIndexCorpusDefinition['trustDomain']) => Pick<SovereigntyTrustDomainPolicy, 'embeddingProfile' | 'activationMode'> | undefined;
  readinessLedger?: SourceIndexReadinessLedger;
  /** Dynamic trusted scope for store counts; absent preserves whole-store status. */
  connectorStoreStatusScope?: (store: LocalConnectorStore) => ConnectorStoreStatusScope | undefined;
  /** The four-tier classification backlog (counts only, never a time estimate). */
  tierClassification?: () => SourceIndexTierClassificationStatus | undefined;
  /** The owner's tier migration state, read per request (content-free). */
  tierMigration?: () => SourceIndexTierMigrationStatus | undefined;
  nowMs?: () => number;
}

export interface SourceIndexTierClassificationStatus {
  checking_items: number;
  remaining_questions: number;
  /** Items an agent outside this computer cannot find yet: pending a verdict, or judged lower with the move still queued. */
  pending_items?: number;
  summary: string;
  awaiting_owner_approval: boolean;
  /** Why the sniffer asked nothing while questions wait (content-free code, label, since). */
  waiting_reason?: string;
  waiting_label?: string;
  waiting_since?: string;
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
  /**
   * `read.maxAgeMs`: the staleness this caller accepts. A ledger may answer
   * its last snapshot within it (or older, while it takes a new one off the
   * request path), and undefined before it has taken one.
   */
  snapshotForCorpus(corpusId: string, read?: { maxAgeMs?: number }): SourceIndexReadinessSnapshot | undefined;
}

export type SourceIndexStatusRetrievalAvailability =
  | SourceIndexHybridAvailability
  | ((request: SourceIndexStatusRequest, snapshot?: { countsMaxAgeMs?: number }) => SourceIndexHybridAvailability);

/**
 * Kept as the dashboard polling contract: how stale a readiness ledger that
 * caller would accept.
 *
 * The dashboard supplies this allowance on every poll. The handler memoizes the
 * complete per-corpus snapshot for at most this window, avoiding repeated
 * whole-corpus counts while preserving live reads for callers that omit it.
 */
export const DASHBOARD_READINESS_LEDGER_MAX_AGE_MS = 120_000;

/**
 * The two status reads a snapshot caller makes, so the split's background
 * counts exactly what its front will ask for: the plain one (the scheduler's
 * ingestion record, `olympus status`) and the dashboard's.
 */
export const PLAIN_STATUS_REQUEST: Readonly<SourceIndexStatusRequest> = Object.freeze({ include_items: false });
export const DASHBOARD_STATUS_REQUEST: Readonly<SourceIndexStatusRequest> = Object.freeze({
  include_items: false,
  include_readiness_ledger: true,
  readiness_ledger_max_age_ms: DASHBOARD_READINESS_LEDGER_MAX_AGE_MS,
});
/**
 * How long a snapshot caller reuses a store's counts (never longer than its
 * own `countsMaxAgeMs`). Five minutes, the snapshot allowance itself: at one
 * read a minute the counts were still a third of Sparta's freeze time
 * (2026-11-05, 2065a89), because each read is a pass over the whole store.
 */
export const STORE_STATUS_REUSE_MS = 5 * 60_000;
/**
 * How old a snapshot caller's last status may be before a refresh starts
 * behind it. Zero: every read starts one unless one is already running, so a
 * dashboard polling every few seconds sees each change one poll later.
 */
export const STATUS_SNAPSHOT_REFRESH_MS = 0;
/** How long a store nothing has written to keeps its last counts (status.ts unchangedMarker). */
export const STORE_UNCHANGED_REUSE_MS = 60 * 60_000;
/** A corpus whose recount takes this long is named in the log, with its phases. */
const STATUS_RECOUNT_CORPUS_LOG_MS = 2_000;
/**
 * How long counts are reused once the store's visibility has moved since they
 * were read (an item added, held, judged or released). Five minutes of such
 * counts kept a freshly read folder at "3 waiting, 0 indexed" for the release
 * check's whole wait (run 43157415118). Bookkeeping writes such as embeddings
 * do not move the marker, so a busy store keeps the long window.
 */
export const STORE_STATUS_CHANGED_REUSE_MS = 30_000;

/** A live names-only policy is a status fact, not a content retrieval mode. */
type StatusCorpusDefinition = Omit<SourceIndexCorpusDefinition, 'activationMode'> & {
  activationMode: SourceIndexCorpusDefinition['activationMode'] | 'metadata_only';
};

/** The request a status snapshot key was kept for, without its allowance, store list and scopes. */
function requestOf(key: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(key) as unknown;
    return Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object' ? parsed[0] as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Each store's scope a status snapshot key was kept under, by corpus id. */
function scopesOf(key: string): Map<string, string> {
  try {
    const parsed = JSON.parse(key) as unknown;
    const stores = Array.isArray(parsed) && Array.isArray(parsed[2]) ? parsed[2] as unknown[] : [];
    return new Map(stores.filter((entry): entry is [string, unknown] => Array.isArray(entry) && typeof entry[0] === 'string')
      .map(([id, scope]) => [id, JSON.stringify(scope ?? null)]));
  } catch {
    return new Map();
  }
}

export function createSourceIndexStatusHandler(
  options: SourceIndexStatusHandlerOptions = {},
): SourceIndexStatusHandler {
  const staticRegistry = typeof options.corpusDefinitions === 'function'
    ? undefined
    : buildSourceIndexCorpusRegistry(options.corpusDefinitions ?? defaultCorpusDefinitions());
  const currentRegistry = () => staticRegistry
    ?? buildSourceIndexCorpusRegistry((options.corpusDefinitions as () => SourceIndexCorpusDefinition[])());
  const cache = new Map<string, { recordedAtMs: number; counted: ConnectorStoreStatus | undefined; status: SourceIndexStatusCorpus }>();
  // A store's own counts, shared by every snapshot caller (the dashboard and
  // the scheduler's status publish) for up to STORE_STATUS_REUSE_MS: each read is a
  // synchronous pass over the whole store, and the two callers' separate
  // reads were most of the worker's freezes (Sparta CPU samples, 2026-11-05).
  const servedStaleAfterPoolFailure = new Set<string>();
  const storeStatusCache = new Map<string, { recordedAtMs: number; marker: string | undefined; unchanged?: string | undefined; status: ConnectorStoreStatus }>();
  // A store nothing has written to (and whose copies' visibility has not
  // moved) since its last count is not counted again, up to
  // STORE_UNCHANGED_REUSE_MS, for what its counts read from outside it (the
  // extraction queue's verdicts). Sparta rc.18, 15 Nov 2026: recounting every
  // store took the background's paced recount 7 minutes.
  const unchangedMarker = (store: LocalConnectorStore): string | undefined => {
    try {
      // The store's write sequence, not its connection's change count: a
      // status pass writes visibility bookkeeping itself, which would read as
      // a change every time. A store without one is always counted.
      const writes = store.writeSequence?.();
      return writes === undefined ? undefined : `${visibilityMarker(store) ?? ''}|${writes}`;
    } catch {
      return undefined;
    }
  };
  const nowMs = options.nowMs ?? Date.now;
  const storeStatusKey = (store: LocalConnectorStore, statusScope: ConnectorStoreStatusScope | undefined) => JSON.stringify([store.corpusId, statusScope ?? null]);
  // Test doubles and older stores may lack the marker: they keep the plain window.
  const visibilityMarker = (store: LocalConnectorStore): string | undefined => {
    try {
      return store.visibilityMarker?.();
    } catch {
      return undefined;
    }
  };
  const storeStatusFresh = (store: LocalConnectorStore, statusScope: ConnectorStoreStatusScope | undefined, countsMaxAgeMs: number): boolean => {
    const reuseMs = Math.min(countsMaxAgeMs, STORE_STATUS_REUSE_MS);
    const cached = reuseMs > 0 ? storeStatusCache.get(storeStatusKey(store, statusScope)) : undefined;
    if (!cached) return false;
    const age = nowMs() - cached.recordedAtMs;
    if (cached.unchanged !== undefined && age <= STORE_UNCHANGED_REUSE_MS && cached.unchanged === unchangedMarker(store)) return true;
    if (age > reuseMs) return false;
    return age <= Math.min(reuseMs, STORE_STATUS_CHANGED_REUSE_MS) || cached.marker === visibilityMarker(store);
  };
  const storeStatus = (store: LocalConnectorStore, statusScope: ConnectorStoreStatusScope | undefined, countsMaxAgeMs: number): ConnectorStoreStatus => {
    const reuseMs = Math.min(countsMaxAgeMs, STORE_STATUS_REUSE_MS);
    if (reuseMs <= 0) return store.status(statusScope, { countsMaxAgeMs: 0 });
    const key = storeStatusKey(store, statusScope);
    const cached = storeStatusCache.get(key);
    if (cached && storeStatusFresh(store, statusScope, countsMaxAgeMs)) return cached.status;
    if (cached && servedStaleAfterPoolFailure.delete(key)) return cached.status;
    const marker = visibilityMarker(store);
    const unchanged = unchangedMarker(store);
    const status = store.status(statusScope, { countsMaxAgeMs });
    storeStatusCache.set(key, { recordedAtMs: nowMs(), marker, unchanged, status });
    return status;
  };
  // One off-thread refresh per store and scope at a time: a dashboard poll and
  // the scheduler's publish that both find the counts expired share one pass.
  const storeStatusRefreshing = new Map<string, Promise<void>>();
  const refreshStoreStatusOffThread = (
    store: LocalConnectorStore,
    statusScope: ConnectorStoreStatusScope | undefined,
    countsMaxAgeMs: number,
  ): Promise<void> => {
    const key = storeStatusKey(store, statusScope);
    const running = storeStatusRefreshing.get(key);
    if (running) return running;
    const refresh = (async () => {
      try {
        const marker = visibilityMarker(store);
        const unchanged = unchangedMarker(store);
        const status = await store.statusOffThread(statusScope, { countsMaxAgeMs });
        storeStatusCache.set(key, { recordedAtMs: nowMs(), marker, unchanged, status });
      } catch {
        // A pool that cannot take it: the last counts serve, and the next
        // recount tries the pool again. Only a store never counted is counted
        // on this thread by statusFor.
        if (storeStatusCache.has(key)) servedStaleAfterPoolFailure.add(key);
      } finally {
        storeStatusRefreshing.delete(key);
      }
    })();
    storeStatusRefreshing.set(key, refresh);
    return refresh;
  };
  // The backlog estimates beside a store's counts (embedding backlog, Private
  // chunks withheld, unread PDFs) are whole-store passes too, and were read on
  // every dashboard status outside that reuse: 15-20% of Sparta's sampled
  // freezes on 14b9be8 (2026-11-05). Reused for the same window.
  const storeReadCache = new Map<string, { recordedAtMs: number; value: unknown; unchanged?: string | undefined }>();
  // A read that has an off-thread form is never run on this thread for a
  // snapshot caller: the older value serves while the read thread recounts,
  // and a first one is waited for by the status count (`pending`), which
  // then builds that corpus again. Sparta rc.17, 15 Nov 2026: the embedding
  // backlog count alone held the background's loop for 3-4 s per status.
  const storeReadRefreshing = new Map<string, Promise<void>>();
  const reusedStoreRead = <T>(
    countsMaxAgeMs: number,
    key: unknown[],
    read: () => T,
    offThread?: { read: () => Promise<T>; empty: T },
    pending?: Promise<void>[],
    store?: LocalConnectorStore,
  ): T => {
    const reuseMs = Math.min(countsMaxAgeMs, STORE_STATUS_REUSE_MS);
    if (reuseMs <= 0) return read();
    const cacheKey = JSON.stringify(key);
    const cached = storeReadCache.get(cacheKey);
    const unchanged = store ? unchangedMarker(store) : undefined;
    if (cached && nowMs() - cached.recordedAtMs <= reuseMs) return cached.value as T;
    // As the counts: a store nothing has written to is not read again.
    if (cached && unchanged !== undefined && cached.unchanged === unchanged && nowMs() - cached.recordedAtMs <= STORE_UNCHANGED_REUSE_MS) return cached.value as T;
    if (offThread && pending) {
      let running = storeReadRefreshing.get(cacheKey);
      if (!running) {
        const remember = (value: T) => {
          if (storeReadCache.size > 256) storeReadCache.clear();
          storeReadCache.set(cacheKey, { recordedAtMs: nowMs(), value, unchanged });
        };
        // A read thread that cannot take it (a closed or busy pool) is tried
        // again by the next status; its last value serves meanwhile. Never
        // read on this thread instead: it is the loop (step-back, 15 Nov 2026).
        running = offThread.read().then(remember, () => undefined)
          .finally(() => storeReadRefreshing.delete(cacheKey));
        storeReadRefreshing.set(cacheKey, running);
      }
      if (cached) return cached.value as T;
      pending.push(running);
      return offThread.empty;
    }
    const value = read();
    if (storeReadCache.size > 256) storeReadCache.clear();
    storeReadCache.set(cacheKey, { recordedAtMs: nowMs(), value, unchanged });
    return value;
  };

  // A snapshot caller never waits on store reads: it gets the last complete
  // status for its request at once, with its age, and a refresh runs behind
  // it once that status is STATUS_SNAPSHOT_REFRESH_MS old. Only the first
  // call for a request waits. Sparta rc.17, 15 Nov 2026: with imports, the
  // judge and a backup running, every dashboard poll recounted each store
  // whose counts had expired, inline and one after another (30-69 s).
  type KeptStatus = { atMs: number; result: SourceIndexStatusResult };
  const role = options.snapshotRole;
  const snapshots = new Map<string, KeptStatus>(role === 'reader' ? [] : readStatusSnapshots(options.snapshotPath));
  // The front re-reads the background's file only when it changed.
  // Each write is atomic (a new file renamed in), so a new inode is a new write.
  let published: { version: string; entries: Map<string, KeptStatus> } | undefined;
  const snapshotPath = options.snapshotPath;
  let readingPublished: Promise<void> | undefined;
  const refreshPublished = (): Promise<void> | undefined => {
    if (role !== 'reader' || !snapshotPath) return;
    if (readingPublished) return readingPublished;
    const read = async () => {
      try {
        const file = await stat(snapshotPath);
        const version = `${file.ino}:${file.mtimeMs}:${file.size}`;
        if (published?.version === version) return;
        const entries = parseStatusSnapshots(await readFile(snapshotPath, 'utf8'));
        if (entries) published = { version, entries: new Map(entries) };
      } catch {
        // Keep the last usable snapshot when the file disappears or cannot be read.
      }
    };
    readingPublished = read().finally(() => { readingPublished = undefined; });
    return readingPublished;
  };
  void refreshPublished();
  // The split's front never counts a store, whatever the reason the
  // background has no entry for this exact read: a store the front mounted
  // first, a scope that moved, a front started before the background's first
  // count, a background that is down (rc.20 leg, 16 Nov: the front counting
  // a store an import had just made held its loop 10 to 15 s and failed the
  // Sources page with SQLITE_BUSY). It serves, in order: this read's entry;
  // the newest for the same request at any allowance; the newest whole-store
  // count of any request, narrowed to the corpus asked for; else "counting"
  // with no numbers.
  const servedOnFront = (request: SourceIndexStatusRequest, countsMaxAgeMs: number): SourceIndexStatusResult => {
    const key = snapshotKey(request, countsMaxAgeMs);
    const exact = published?.entries.get(key);
    const entries = [...(published?.entries ?? new Map<string, KeptStatus>())];
    const newest = (match: (other: Record<string, unknown>) => boolean): KeptStatus | undefined => {
      let found: KeptStatus | undefined;
      for (const [other, kept] of entries) {
        const asked = requestOf(other);
        if (asked && match(asked) && (!found || kept.atMs > found.atMs)) found = kept;
      }
      return found;
    };
    const asked = requestOf(key) ?? {};
    const sameRequest = JSON.stringify(asked);
    const { corpus_id: corpusId, ...wholeStore } = asked;
    const kept = exact
      ?? newest((other) => JSON.stringify(other) === sameRequest)
      ?? newest((other) => other.corpus_id === undefined && JSON.stringify({ ...other }) === JSON.stringify({ ...wholeStore }))
      ?? newest((other) => other.corpus_id === undefined);
    if (!kept) {
      return {
        kind: 'source_index_status', generated_at: new Date().toISOString(), corpora: [], counting: true,
        policy: { read_only: true, raw_source_exposed: false, source_packets_exposed: false, source_text_returned: false, secure_local_item_metadata_exposed: false, castor_visible: true },
      };
    }
    const canonical = typeof corpusId === 'string' ? canonicalSourceCorpusId(corpusId) : undefined;
    // A store whose scope has moved since that count is left out until the
    // background counts it under the new scope: rows the owner just took out
    // of scope are never shown from an older count.
    const keptKey = [...(published?.entries ?? [])].find(([, entry]) => entry === kept)?.[0];
    const now = scopesOf(key);
    const then = keptKey ? scopesOf(keptKey) : new Map<string, string>();
    const moved = (id: string): boolean => now.has(id) && then.has(id) && now.get(id) !== then.get(id);
    const corpora = kept.result.corpora.filter((corpus) => (canonical === undefined || corpus.corpus_id === canonical) && !moved(corpus.corpus_id));
    return { ...kept.result, corpora, snapshot_age_ms: Math.max(0, nowMs() - kept.atMs) };
  };
  const persistSnapshots = (): void => {
    if (!options.snapshotPath || role === 'reader') return;
    try {
      writePrivateFileAtomicSync(options.snapshotPath, `${JSON.stringify({ schema: STATUS_SNAPSHOT_SCHEMA, entries: [...snapshots] })}\n`);
    } catch { /* the in-memory snapshot still serves; the next refresh writes again */ }
  };
  const snapshotRefreshes = new Map<string, Promise<SourceIndexStatusResult>>();
  // Overlay maintained totals on the last scoped count. On the front each
  // store has one pending read, shared across dashboard and status callers.
  const newTotalsRead = () => createDashboardHeldRead<StoreTotals | undefined>(5_000, () => {
    console.warn('[engine-split] dashboard store totals unavailable; will retry.');
  }, nowMs);
  const frontTotals = new WeakMap<LocalConnectorStore, ReturnType<typeof newTotalsRead>>();
  const withLiveTotals = (result: SourceIndexStatusResult): SourceIndexStatusResult => {
    const totalsStores = new Map((options.connectorStores ?? []).map((store) => [store.corpusId, store]));
    if (totalsStores.size === 0) return result;
    let changed = false;
    let oldest: number | undefined;
    const noteAge = (ageMs: number | undefined) => {
      if (ageMs !== undefined) oldest = Math.max(oldest ?? 0, ageMs);
    };
    const corpora = result.corpora.map((corpus) => {
      if (corpus.configured !== true) return corpus;
      const store = totalsStores.get(corpus.corpus_id);
      if (!store) return corpus;
      let totals: StoreTotals | undefined;
      if (role === 'reader') {
        let refresh = frontTotals.get(store);
        if (!refresh) {
          refresh = newTotalsRead();
          frontTotals.set(store, refresh);
        }
        const held = refresh(() => store.totalsInBackground());
        const snapshotAge = result.snapshot_age_ms;
        // The scoped count can be newer than the front's overlay.
        if (!held.value || (snapshotAge !== undefined && (held.at ?? 0) < nowMs() - snapshotAge)) {
          noteAge(snapshotAge);
          return corpus;
        }
        totals = held.value;
        noteAge(held.ageMs);
      } else {
        totals = store.totals?.();
      }
      if (!totals) return corpus;
      changed = true;
      const live: SourceIndexStoreTotals = {
        items: totals.items, tombstoned_items: totals.tombstonedItems, chunks: totals.chunks, sync_runs: totals.syncRuns,
        vectors_by_model: totals.vectorsByModel, reconciled_at: totals.reconciledAt,
      };
      return { ...bringCountsForward(corpus, live), totals: live };
    });
    return changed || oldest !== undefined
      ? { ...result, corpora, ...(oldest !== undefined ? { live_totals_age_ms: oldest } : {}) }
      : result;
  };
  // Keyed by each store's scope too: a status counted under folders the owner
  // has since taken out is never served (they leave the counts at once).
  // include_items left out is false: `olympus status` with no options is the plain request the background counts.
  const snapshotKey = (request: SourceIndexStatusRequest, countsMaxAgeMs: number): string => JSON.stringify([
    { include_items: false, ...request }, countsMaxAgeMs,
    (options.connectorStores ?? []).map((store) => [store.corpusId, options.connectorStoreStatusScope?.(store) ?? null]),
  ]);
  const refreshKept = (key: string, compute: () => Promise<SourceIndexStatusResult>): Promise<SourceIndexStatusResult> => {
    const running = snapshotRefreshes.get(key);
    if (running) return running;
    const started = compute().then((result) => {
      if (snapshots.size > 64) snapshots.clear();
      snapshots.set(key, { atMs: nowMs(), result });
      persistSnapshots();
      return result;
    }).finally(() => snapshotRefreshes.delete(key));
    snapshotRefreshes.set(key, started);
    return started;
  };
  const snapshotStatus = (
    compute: () => Promise<SourceIndexStatusResult>,
    request: SourceIndexStatusRequest,
    countsMaxAgeMs: number,
  ): Promise<SourceIndexStatusResult> => {
    const key = snapshotKey(request, countsMaxAgeMs);
    const last = snapshots.get(key);
    if (!last) return refreshKept(key, compute);
    const age = Math.max(0, nowMs() - last.atMs);
    // The split's background recounts on its own pace. In a single engine,
    // a request with a reusable count refreshes behind the read.
    if (role === undefined && age >= STATUS_SNAPSHOT_REFRESH_MS) void refreshKept(key, compute).catch(() => undefined);
    return Promise.resolve({ ...last.result, snapshot_age_ms: age });
  };

  const computeStatus = async (request: SourceIndexStatusRequest, snapshot: { countsMaxAgeMs?: number }): Promise<SourceIndexStatusResult> => {
      assertSupportedStatusRequest(request);
      const requestedCorpusId = request.corpus_id
        ? canonicalSourceCorpusId(request.corpus_id)
        : undefined;
      const storesByCorpusId = new Map((options.connectorStores ?? []).map((store) => [store.corpusId, store]));
      const corpora = currentRegistry()
        .list()
        .filter((corpus) => requestedCorpusId === undefined || corpus.corpusId === requestedCorpusId);
      // Off-thread reads a corpus started and has no value for yet (reusedStoreRead).
      const pending: Promise<void>[] = [];
      // Every reused read's key names its corpus second, so the store it reads is known.
      const reusedRead = <T>(countsMaxAgeMs: number, key: unknown[], read: () => T, offThread?: { read: () => Promise<T>; empty: T }): T =>
        reusedStoreRead(countsMaxAgeMs, key, read, offThread, pending, typeof key[1] === 'string' ? storesByCorpusId.get(key[1]) : undefined);
      const statusFor = (declaredCorpus: (typeof corpora)[number]): SourceIndexStatusCorpus => {
        const pendingBefore = pending.length;
        const policy = options.retrievalPolicy?.(declaredCorpus.trustDomain);
        const embeddingDisabled = policy !== undefined
          && (!policy.embeddingProfile || policy.activationMode === 'metadata_only' || policy.activationMode === 'lexical_only');
        const corpus: StatusCorpusDefinition = embeddingDisabled
          ? { ...declaredCorpus, embeddingPolicy: 'disabled', activationMode: policy?.activationMode === 'metadata_only' ? 'metadata_only' : 'lexical_only' }
          : declaredCorpus;
        const store = storesByCorpusId.get(corpus.corpusId);
        const statusScope = store ? options.connectorStoreStatusScope?.(store) : undefined;
        const maxAgeMs = normalizedStatusCacheMaxAge(request.readiness_ledger_max_age_ms);
        // Availability is resolved BEFORE the cache is consulted and is part of
        // the key: the embedded counts are a claim about the serving model, so
        // a status cached under model A must not be served after a switch to
        // model B for the rest of the cache window.
        const availability = resolveStatusRetrievalAvailability(
          options.retrievalAvailability?.[corpus.corpusId],
          request,
          snapshot,
        );
        // Encoded structurally: model ids and epochs are free-form strings, so
        // a delimiter-joined key could collide ("m:a"+"b" vs "m"+"a:b").
        const cacheKey = JSON.stringify([
          corpus.corpusId,
          corpus.embeddingPolicy, corpus.activationMode,
          request.include_readiness_ledger === true ? 'full' : 'cheap',
          availability === undefined ? null : [
            availability.servable,
            availability.modelId ?? null,
            availability.embeddingEpoch ?? null,
            availability.reason ?? null,
            availability.backend ?? null,
            availability.provider ?? null,
          ],
          statusScope ?? null,
        ]);
        // The readiness cache and the store recount have separate lifetimes.
        // A newer store count must reach the dashboard even while its
        // readiness data is still within its reuse window.
        const countsMaxAgeMs = snapshot.countsMaxAgeMs ?? 0;
        const counted = store && countsMaxAgeMs > 0 ? storeStatus(store, statusScope, countsMaxAgeMs) : undefined;
        const cached = maxAgeMs > 0 ? cache.get(cacheKey) : undefined;
        if (cached && cached.counted === counted && nowMs() - cached.recordedAtMs <= maxAgeMs) return cached.status;
        // Gated because a readiness ledger is the expensive half of this
        // payload: the public status operation documents the flag and defaults
        // it off for cheap polling, while the dashboard — whose one headline
        // percentage is computed from exactly these counts — always asks.
        const readiness = store && request.include_readiness_ledger === true
          ? options.readinessLedger?.snapshotForCorpus(corpus.corpusId, maxAgeMs > 0 ? { maxAgeMs } : {})
          : undefined;
        const status = store
          ? connectorStoreStatus(
            corpus,
            counted ?? storeStatus(store, statusScope, countsMaxAgeMs),
            readiness?.counts,
            readiness?.contentExtractionThroughput,
            availability?.modelId,
            secretLocationCount(store, (read, offThread) => reusedRead(snapshot.countsMaxAgeMs ?? 0, ['secrets', store.corpusId], read, offThread)),
          )
          : configuredCorpusStatus(corpus);
        if (status.configured && readiness?.counts[UNSUPPORTED_KIND_COUNT_KEY] !== undefined) {
          status.counts[UNSUPPORTED_KIND_COUNT_KEY] = readiness.counts[UNSUPPORTED_KIND_COUNT_KEY]!;
        }
        if (status.configured && readiness?.counts[PICTURES_NOT_READ_HERE_COUNT_KEY] !== undefined) {
          status.counts[PICTURES_NOT_READ_HERE_COUNT_KEY] = readiness.counts[PICTURES_NOT_READ_HERE_COUNT_KEY]!;
        }
        if (status.configured && request.include_readiness_ledger === true && options.unreadableCount) {
          const unreadable = options.unreadableCount(corpus.corpusId);
          if (unreadable !== undefined) status.counts[UNREADABLE_ITEMS_COUNT_KEY] = unreadable;
        }
        if (status.configured && store && PEOPLE_AUTHORED_FAMILIES.has(corpus.family)) {
          const coverage = authorCoverageStatus(store, (read) => reusedRead(snapshot.countsMaxAgeMs ?? 0, ['authors', store.corpusId], read,
            typeof store.authorCoverageOffThread === 'function' ? { read: () => store.authorCoverageOffThread(), empty: [] } : undefined));
          if (coverage) status.author_coverage = coverage;
        }
        const enforced = withRetrievalEnforcementStatus(corpus, status, availability);
        const withBacklog = store && availability?.modelId
          ? withEmbeddingBacklogEstimate(enforced, store, availability.modelId, availability, statusScope, snapshot.countsMaxAgeMs ?? 0, reusedRead)
          : enforced;
        const resolved = store && corpus.family === 'file'
          ? withPdfExtractionBacklog(withBacklog, store, withBacklog.embedding_parity?.required === true
            ? availability?.modelId
            : undefined, (read) => reusedRead(snapshot.countsMaxAgeMs ?? 0, ['pdf', store.corpusId], read,
              typeof store.pdfExtractionBacklogOffThread === 'function'
                ? { read: () => store.pdfExtractionBacklogOffThread(), empty: { pendingPdfs: 0, extractedPdfs: 0, extractedChars: 0 } } : undefined))
          : withBacklog;
        // Not kept while an off-thread read it shows a stand-in for is still running.
        if (maxAgeMs > 0 && pending.length === pendingBefore) cache.set(cacheKey, { recordedAtMs: nowMs(), counted, status: resolved });
        return resolved;
      };
      // Each corpus's counts are synchronous SQLite reads over its whole store;
      // read in one go they held the worker's thread for seconds on a large
      // library (Sparta, 2026-11-03: 5–10 s freezes, about half the thread's
      // time). A turn between corpora lets requests answer in between.
      const statuses: SourceIndexStatusCorpus[] = [];
      for (const declaredCorpus of corpora) {
        const corpusStartedMs = nowMs();
        const phaseMs = { prepare: 0, counts: 0, estimates: 0 };
        await ingestionTurn();
        // A snapshot builds the store's reused sets in turns first, so its
        // count below does not build them in one go.
        const store = storesByCorpusId.get(declaredCorpus.corpusId);
        const countsMaxAgeMs = snapshot.countsMaxAgeMs ?? 0;
        if (store && countsMaxAgeMs > 0) {
          const statusScope = options.connectorStoreStatusScope?.(store);
          if (!storeStatusFresh(store, statusScope, countsMaxAgeMs)) {
            let at = nowMs();
            await store.prepareStatusCounts?.(statusScope);
            phaseMs.prepare = nowMs() - at;
            at = nowMs();
            // The counts themselves are read on the second thread where the
            // store allows it (#870), and statusFor below finds them fresh.
            // Test doubles and older stores may lack it.
            if (typeof store.statusOffThread === 'function') await refreshStoreStatusOffThread(store, statusScope, countsMaxAgeMs);
            phaseMs.counts = nowMs() - at;
          }
        }
        let at = nowMs();
        let shown = statusFor(declaredCorpus);
        if (pending.length > 0) {
          // A first off-thread count for this corpus: wait for it on the read thread, then build the corpus with it.
          await Promise.allSettled(pending.splice(0));
          shown = statusFor(declaredCorpus);
          pending.splice(0);
        }
        phaseMs.estimates = nowMs() - at;
        statuses.push(shown);
        // The background's paced recount names each slow corpus, so a long recount says what it was made of.
        at = nowMs() - corpusStartedMs;
        if (options.snapshotRole === 'writer' && at >= STATUS_RECOUNT_CORPUS_LOG_MS) {
          console.warn(`[olympus] status recount: ${declaredCorpus.corpusId} took ${at} ms (prepare ${phaseMs.prepare}, counts ${phaseMs.counts}, estimates ${phaseMs.estimates})`);
        }
      }
      const tierClassification = options.tierClassification?.();
      let tierMigration: SourceIndexTierMigrationStatus | undefined;
      try {
        tierMigration = options.tierMigration?.();
      } catch {
        tierMigration = undefined;
      }
      const result: SourceIndexStatusResult = {
        kind: 'source_index_status',
        generated_at: new Date().toISOString(),
        corpora: statuses,
        ...(tierClassification ? { tier_classification: tierClassification } : {}),
        ...(tierMigration ? { tier_migration: tierMigration } : {}),
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
  };

  return {
    async status(request: SourceIndexStatusRequest = {}, snapshot: { countsMaxAgeMs?: number } = {}): Promise<SourceIndexStatusResult> {
      const countsMaxAgeMs = snapshot.countsMaxAgeMs ?? 0;
      // The split's front: every status read is the background's count (an
      // owner's question about one chat's senders is not a count, and is read).
      if (role === 'reader' && !request.include_sender_aggregation) {
        assertSupportedStatusRequest(request);
        void refreshPublished();
        return withLiveTotals(servedOnFront(request, countsMaxAgeMs));
      }
      // A live read (no allowance), or one that asks for a conversation's
      // senders, is read now as before.
      if (countsMaxAgeMs <= 0 || request.include_sender_aggregation) return withLiveTotals(await computeStatus(request, snapshot));
      assertSupportedStatusRequest(request);
      return withLiveTotals(await snapshotStatus(() => computeStatus(request, snapshot), request, countsMaxAgeMs));
    },
    async settled() {
      if (readingPublished) await readingPublished;
      while (snapshotRefreshes.size > 0) await Promise.allSettled([...snapshotRefreshes.values()]);
    },
    ...(role === 'writer' ? {
      refreshSnapshot(request: SourceIndexStatusRequest, snapshot: { countsMaxAgeMs: number }) {
        assertSupportedStatusRequest(request);
        return refreshKept(snapshotKey(request, snapshot.countsMaxAgeMs), () => computeStatus(request, snapshot));
      },
    } : {}),
  };
}

const STATUS_SNAPSHOT_SCHEMA = 'olympus.source-status-snapshot.v1';

/** The snapshots a previous run kept, or none when the file is missing or unreadable. Never throws. */
function readStatusSnapshots(path: string | undefined): Array<[string, { atMs: number; result: SourceIndexStatusResult }]> {
  if (!path) return [];
  try {
    return parseStatusSnapshots(readFileSync(path, 'utf8')) ?? [];
  } catch {
    return [];
  }
}

function parseStatusSnapshots(text: string): Array<[string, { atMs: number; result: SourceIndexStatusResult }]> | undefined {
  const parsed = JSON.parse(text) as { schema?: string; entries?: unknown };
  if (parsed?.schema !== STATUS_SNAPSHOT_SCHEMA || !Array.isArray(parsed.entries)) return undefined;
  return parsed.entries.filter((entry): entry is [string, { atMs: number; result: SourceIndexStatusResult }] =>
    Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1]?.atMs === 'number' && entry[1]?.result?.kind === 'source_index_status');
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
  snapshot: { countsMaxAgeMs?: number } = {},
): SourceIndexHybridAvailability | undefined {
  if (typeof availability !== 'function') return availability;
  try {
    return availability(request, snapshot);
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
    defineLocalFilesCorpus(),
    defineInternalTelegramMessagesCorpus(),
    defineProtectedTelegramMessagesCorpus(),
  ];
}

/**
 * How many Secrets a lane has located (design section 2.3): counted from the
 * secret-locations index beside a Private store, read-only, never created.
 * Location only, and only the count leaves here.
 */
function secretLocationCount(
  store: LocalConnectorStore,
  reused: (read: () => number | undefined, offThread?: { read: () => Promise<number | undefined>; empty: number | undefined }) => number | undefined,
): number | undefined {
  if (store.trustDomain !== 'secure_local' || store.dbPath === ':memory:') return undefined;
  const path = secretLocationsPathForStore(store.dbPath);
  if (!existsSync(path)) return undefined;
  const read = (): number | undefined => {
    let index: SecretLocationsIndex | undefined;
    try {
      index = new SecretLocationsIndex({ dbPath: path, readOnly: true });
      return index.count();
    } catch {
      return undefined;
    } finally {
      index?.close();
    }
  };
  // The count scans the index: on the loop it runs on the read worker
  // (loop-stall step-back, family 4), and a snapshot caller gets the last one.
  if (!offThreadReadsSupported(path)) return reused(read);
  return reused(read, {
    read: async () => {
      const row = await readInBackground(path, { sql: 'SELECT COUNT(*) AS n FROM secret_locations', params: [], mode: 'get' }) as { n: number } | null;
      return row?.n;
    },
    empty: undefined,
  });
}

function connectorStoreStatus(
  corpus: StatusCorpusDefinition,
  status: ConnectorStoreStatus,
  readinessCounts?: Record<string, number>,
  extractionThroughput?: ContentExtractionThroughputSignal,
  servingModelId?: string,
  secretLocations?: number,
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
    ...(status.scopeRevision ? { scope_revision: status.scopeRevision } : {}),
    counts: {
      // The ledger's vocabulary first, so the read authority's own facts below
      // always win a collision. What the store holds is never the ledger's
      // answer to give.
      ...readinessCounts,
      indexed_items: status.counts.files ?? status.counts.items,
      ...(status.counts.folders === undefined ? {} : { folders: status.counts.folders }),
      tombstoned_items: status.counts.tombstonedItems,
      ...(status.counts.storedItems === undefined ? {} : { stored_items: status.counts.storedItems }),
      chunks: status.counts.chunks,
      embedded_chunks: forModel?.embeddedChunks ?? status.counts.embeddedChunks,
      sync_runs: status.counts.syncRuns,
      // Published unconditionally, ledger or not. It is one indexed probe per
      // item and it is the count every answer-ready ratio divides by; leaving
      // it to the gated ledger is what let an ungated status answer with no
      // per-item readiness at all.
      [ITEMS_WITH_TEXT_COUNT_KEY]: status.counts.itemsWithText,
      ...((status.counts.contentElsewhereItems ?? 0) > 0 ? { content_elsewhere_items: status.counts.contentElsewhereItems! } : {}),
      ...((status.counts.settledUnreadableItems ?? 0) > 0 ? {
        settled_unreadable_items: status.counts.settledUnreadableItems!,
        [UNREADABLE_ITEMS_COUNT_KEY]: (readinessCounts?.[UNREADABLE_ITEMS_COUNT_KEY] ?? 0)
          + status.counts.settledUnreadableItems!,
      } : {}),
      ...(status.counts.fullIngestionFiles === undefined
        ? {}
        : { scope_full_ingestion_files: status.counts.fullIngestionFiles }),
      ...(status.counts.scopeMetadataOnlyFiles === undefined
        ? {}
        : { scope_metadata_only_files: status.counts.scopeMetadataOnlyFiles }),
      ...(status.counts.policyDeferredItems === undefined
        ? {}
        : { scope_policy_deferred_files: status.counts.policyDeferredItems }),
      ...(status.counts.contentEligibleItems === undefined
        ? {}
        : { qa_eligible_items: status.counts.contentEligibleItems }),
      ...(status.counts.scopeMetadataOnlyFiles === undefined
        || status.counts.policyDeferredItems === undefined
        ? {}
        : {
            [METADATA_ONLY_EXPECTED_COUNT_KEY]:
              status.counts.scopeMetadataOnlyFiles + status.counts.policyDeferredItems,
          }),
      // Material the scope's window keeps as names only (older mail): the
      // policy exit every source shares, so it leaves the owed-reading
      // population instead of showing as work that can never finish.
      ...((status.counts.outsideContentWindowItems ?? 0) > 0
        ? { [OUT_OF_CONTENT_SCOPE_COUNT_KEY]: status.counts.outsideContentWindowItems! }
        : {}),
      // The per-item parity gauge the dashboard's embedding bar divides in
      // files: published only against a known serving model.
      ...(forModel === undefined ? {} : { [ITEMS_EMBEDDED_COUNT_KEY]: forModel.itemsEmbedded }),
      // Four-tier classification (design section 4.3). Published only when the
      // store holds routed copies in these states; `chunks` and
      // `embedded_chunks` above already leave superseded and pending chunks
      // out of the parity denominator.
      ...(status.tier
        ? {
            pending_classification_items: status.tier.pendingClassificationItems,
            ...(status.tier.pendingClassificationItemsOnce !== undefined
              ? { pending_classification_items_once: status.tier.pendingClassificationItemsOnce } : {}),
            superseded_chunks: status.tier.supersededChunks,
            tier_move_in_progress: status.tier.tierMoveInProgress,
            ...(status.tier.namesOnlyKeptChunks ? { names_only_kept_chunks: status.tier.namesOnlyKeptChunks } : {}),
          }
        : {}),
      // Secrets are stored nowhere: this is how many locations the lane keeps.
      ...(secretLocations !== undefined && secretLocations > 0 ? { secret_locations: secretLocations } : {}),
    },
    ...(status.lastSyncRun
      ? { last_refresh: lastRefreshFromConnectorStoreSync(status.lastSyncRun) }
      : {}),
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
    ...(extractionThroughput ? { content_extraction_throughput: extractionThroughput } : {}),
    ...(status.countedTotals ? { totals_at_count: {
      items: status.countedTotals.items, tombstoned_items: status.countedTotals.tombstonedItems, chunks: status.countedTotals.chunks,
      sync_runs: status.countedTotals.syncRuns, vectors_by_model: status.countedTotals.vectorsByModel,
    } } : {}),
  };
}

/**
 * Brings a corpus's import-moved counts forward from the totals at its count
 * to the live totals (store-totals.ts): live items, chunks and vectors on the
 * serving model, and the embedding parity built from them. A reused count
 * otherwise showed finished embedding as still waiting for up to its reuse
 * window (lane 6 run 43777041779: "embedded 1, missing 2" minutes after both
 * chunks were embedded). Deltas only: the scope and tier filtering of the
 * count stays, and the next recount replaces the estimate with a count.
 */
export function bringCountsForward(corpus: SourceIndexConnectorStoreStatus, live: SourceIndexStoreTotals): SourceIndexConnectorStoreStatus {
  const at = corpus.totals_at_count;
  if (!at) return corpus;
  const model = corpus.retrieval?.model_id;
  const items = (live.items - live.tombstoned_items) - (at.items - at.tombstoned_items);
  const chunks = live.chunks - at.chunks;
  const vectors = model === undefined ? 0 : (live.vectors_by_model[model] ?? 0) - (at.vectors_by_model[model] ?? 0);
  if (items === 0 && chunks === 0 && vectors === 0 && live.tombstoned_items === at.tombstoned_items) return corpus;
  const floor = (n: number) => Math.max(0, n);
  const counts = {
    ...corpus.counts,
    indexed_items: floor(corpus.counts.indexed_items + items),
    tombstoned_items: floor(corpus.counts.tombstoned_items + live.tombstoned_items - at.tombstoned_items),
    chunks: floor(corpus.counts.chunks + chunks),
    embedded_chunks: floor(corpus.counts.embedded_chunks + vectors),
  };
  const parity = corpus.embedding_parity;
  const embedding_parity = parity === undefined ? undefined : (() => {
    const total = floor(parity.chunks + chunks);
    const embedded = Math.min(total, floor(parity.embedded_chunks + vectors));
    const missing = parity.required ? floor(parity.missing_chunks + chunks - vectors) : 0;
    const withheld = parity.private_tier_withheld?.chunks ?? 0;
    return {
      ...parity,
      chunks: total,
      embedded_chunks: embedded,
      missing_chunks: missing,
      refresh_needed: parity.required && missing > withheld,
      ...(parity.backlog_estimate ? { backlog_estimate: { ...parity.backlog_estimate,
        missing_chunks: Math.min(missing, floor(parity.backlog_estimate.missing_chunks + chunks - vectors)) } } : {}),
    };
  })();
  return {
    ...corpus,
    counts,
    ...(embedding_parity ? { embedding_parity } : {}),
    counts_brought_forward: { items, chunks, embedded_chunks: vectors },
  };
}

function configuredCorpusStatus(
  corpus: StatusCorpusDefinition,
): SourceIndexConfiguredCorpusStatus {
  return {
    ...baseStatus(corpus),
    configured: false,
    skipped_item_metadata_reason: 'source_index_not_configured',
  };
}

function baseStatus(corpus: StatusCorpusDefinition): SourceIndexCorpusStatusBase {
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
  corpus: StatusCorpusDefinition,
  status: T,
  hybridAvailability: SourceIndexHybridAvailability | undefined,
): T {
  // Names-only policy has no content retrieval, even when old vectors remain
  // or a local embedding provider is available. Exemption is not keyword readiness.
  const assessed = corpus.activationMode === 'metadata_only'
    ? {
      declaredMode: 'metadata_only' as const,
      servableMode: 'metadata_only' as const,
      health: 'ready' as const,
      reason: undefined, modelId: undefined, embeddingEpoch: undefined, backend: undefined,
    }
    : assessSourceIndexRetrievalState({
      declaredMode: corpus.activationMode,
      ...(hybridAvailability ? { hybridAvailability } : {}),
    });
  const counts = status.configured ? status.counts : undefined;
  const chunks = counts?.chunks ?? 0;
  // A store with no text chunks yet (an empty store, or a file whose text is
  // still being read) has nothing a vector could find: its search is not
  // degraded, it simply has nothing to search. Reporting it degraded failed
  // a fresh install's Dropbox check in the half minute between the first
  // file landing and its text being read (ops#222, run 43573805556).
  const retrieval = counts !== undefined && chunks === 0 && assessed.reason === 'no_current_embedding_artifacts'
    ? { ...assessed, servableMode: 'hybrid' as const, health: 'ready' as const, reason: undefined }
    : assessed;
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
  const embeddingRequired = corpus.embeddingPolicy !== 'disabled'
    && corpus.activationMode !== 'lexical_only';
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
      missing_chunks: embeddingRequired ? Math.max(0, chunks - embeddedChunks) : 0,
      refresh_needed: embeddingRequired && embeddedChunks < chunks,
    },
  };
}

/**
 * Count and price the embedding backlog of a store answers are served from
 * with embeddings. Only such a store owes one: a keyword-only store's missing
 * vectors keep nothing from an answer, and pricing them would read as a bill.
 */
function withEmbeddingBacklogEstimate<T extends SourceIndexStatusCorpus>(
  status: T,
  store: LocalConnectorStore,
  modelId: string,
  availability: SourceIndexHybridAvailability,
  scope: ConnectorStoreStatusScope | undefined,
  countsMaxAgeMs: number,
  reused: <R>(countsMaxAgeMs: number, key: unknown[], read: () => R, offThread?: { read: () => Promise<R>; empty: R }) => R = (_age, _key, read) => read(),
): T {
  const parity = status.embedding_parity;
  if (!parity?.required) return status;
  // With the serving embedder known, rows it may not receive (Private by
  // their own tier) are reported as withheld, not as a backlog it owes.
  const embedder = availability.backend !== undefined && availability.provider !== undefined
    ? { modelId, provider: availability.provider, backend: availability.backend as SourceEmbeddingBackend }
    : undefined;
  // The same scoped population as the parity counts above (store.status(scope)).
  const backlog = reused(countsMaxAgeMs, ['embedding-backlog', store.corpusId, modelId, embedder ?? null, scope ?? null],
    () => store.embeddingBacklogEstimate(modelId, embedder, scope, { countsMaxAgeMs }),
    typeof store.embeddingBacklogEstimateOffThread === 'function'
      ? { read: () => store.embeddingBacklogEstimateOffThread(modelId, embedder, scope, { countsMaxAgeMs }), empty: { missingChunks: 0, estimatedTokens: 0 } }
      : undefined);
  const withheld = embedder
    ? reused(countsMaxAgeMs, ['private-withheld', store.corpusId, embedder, scope ?? null],
      () => store.privateTierEmbeddingWithheld(embedder, scope, { countsMaxAgeMs }))
    : undefined;
  const { source } = embeddingModelEstimate(modelId);
  return {
    ...status,
    embedding_parity: {
      ...parity,
      ...(withheld && withheld.chunks > 0
        ? {
            refresh_needed: parity.refresh_needed && parity.missing_chunks > withheld.chunks,
            private_tier_withheld: { chunks: withheld.chunks, reason: withheld.reason },
          }
        : {}),
      backlog_estimate: {
        model_id: modelId,
        missing_chunks: backlog.missingChunks,
        estimated_tokens: backlog.estimatedTokens,
        estimated_cost_usd: estimatedEmbeddingCostUsd(backlog.estimatedTokens, modelId),
        price_source: source,
      },
    },
  };
}

/**
 * When nothing has been extracted yet there is no observed average; this is
 * the owner's extracted Dropbox PDFs' average, rounded (about 52k characters).
 */
const FALLBACK_PDF_EXTRACTED_CHARS = 50_000;

function withPdfExtractionBacklog<T extends SourceIndexStatusCorpus>(
  status: T,
  store: LocalConnectorStore,
  modelId: string | undefined,
  reused: (read: () => ReturnType<LocalConnectorStore['pdfExtractionBacklog']>) => ReturnType<LocalConnectorStore['pdfExtractionBacklog']> = (read) => read(),
): T {
  const backlog = reused(() => store.pdfExtractionBacklog());
  if (backlog.pendingPdfs === 0 && backlog.extractedPdfs === 0) return status;
  const averageChars = backlog.extractedPdfs > 0
    ? backlog.extractedChars / backlog.extractedPdfs
    : FALLBACK_PDF_EXTRACTED_CHARS;
  const estimatedTokens = Math.ceil((backlog.pendingPdfs * averageChars) / 4);
  return {
    ...status,
    pdf_extraction: {
      pending_pdfs: backlog.pendingPdfs,
      extracted_pdfs: backlog.extractedPdfs,
      ...(modelId
        ? {
            estimate_after_extraction: {
              model_id: modelId,
              estimated_tokens: estimatedTokens,
              estimated_cost_usd: estimatedEmbeddingCostUsd(estimatedTokens, modelId),
              price_source: embeddingModelEstimate(modelId).source,
            },
          }
        : {}),
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
    // `*.local.files` is the Files on this computer source, whose provider id is local_files (remote-result.ts).
    if (parts[1] === 'local' && parts[2] === 'files') return 'local_files';
    return parts[1] ?? 'unknown';
  }
  return parts[0] || 'unknown';
}
