// Source-specific control plane around the Gmail lanes. Provider I/O stays
// inside Contract 1; shared ingest and embedding stay in the generic
// connector-store runner. Everything that leaves this module is counts-only:
// resume state is handed to the scheduler as an opaque checkpoint and never
// appears in a receipt, warning, or log line.
//
// One provider traversal feeds the internal and secure-local stores under an
// incremental `after:` watermark, a durable day budget, and Retry-After
// handling. Existing history lives in those canonical stores; normal runtime
// has no migration source or fallback index.

import { createHash } from 'node:crypto';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  sourceInvocationProvenance,
  type SourceInvocationProvenance,
} from '../../core/invocation-provenance.ts';
import {
  syncAndEmbedFromConnector,
  type ConnectorStoreEmbedSummary,
  type ConnectorStoreSyncSummary,
  type LocalConnectorStore,
} from '../connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import { accountFromGoogleHandle, loadGoogleSensitivityMap } from './classification.ts';
import {
  GMAIL_PROVIDER,
  GoogleGmailSourceConnector,
  gmailConnectorStoreClassification,
  gmailCursorIsMidTraversal,
  isGmailConnectorCursor,
  type GmailSourceConnectorTraversalStatus,
  type GoogleGmailSourceConnectorOptions,
} from './gmail.ts';
import {
  defaultGmailLiveSyncConfig,
  type GmailLiveSyncConfig,
} from './gmail-live-control.ts';
import type { GoogleDailyRequestBudget, GoogleRequestBudgetStatus } from './request-budget.ts';

export const GMAIL_STORE_PULL_RECEIPT_KIND = 'gmail_connector_store_pull_receipt';
export const GMAIL_STORE_RECONCILE_RECEIPT_KIND = 'gmail_connector_store_reconcile_receipt';
export const GMAIL_RESUME_REJECTED_WARNING = 'gmail_store_resume_cursor_rejected';
export const GMAIL_ATTACHMENTS_NOT_INGESTED_WARNING = 'gmail_attachments_not_ingested';
export const GMAIL_INGEST_FILTERED_WARNING = 'gmail_ingest_filtered_items';

const CHECKPOINT_PREFIX = 'gmp1:';
const MAX_CHECKPOINT_CHARS = 16_384;
/**
 * The connector's own hard ceiling. The reconcile task passes no maxItems to
 * the spine — that is what makes the traversal a snapshot candidate — but the
 * connector still needs a listing bound, and its ceiling is the widest honest
 * one available.
 */
const MAX_RECONCILE_MESSAGES = 1_000;

export interface GmailConnectorStoreSyncRequest {
  max_messages?: number;
  query?: string;
}

export interface GmailConnectorStoreSyncResult {
  provider: typeof GMAIL_PROVIDER;
  account: string;
  internal: ConnectorStoreSyncSummary;
  secure: ConnectorStoreSyncSummary;
}

export interface GmailConnectorStoreReceipt {
  kind: typeof GMAIL_STORE_PULL_RECEIPT_KIND | typeof GMAIL_STORE_RECONCILE_RECEIPT_KIND;
  status: 'progress' | 'idle';
  counts: {
    api_requests: number;
    daily_api_request_budget: number;
    /**
     * Gmail traversals this run spent. Always 1: the internal and secure
     * stores share one listing pass. Two connectors used to traverse
     * independently, doubling every Gmail request for identical pages.
     */
    provider_traversals: number;
    items_seen: number;
    /** Messages served from the in-run cache instead of a second messages.get. */
    fetch_item_cache_hits: number;
    attachments_declared: number;
    attachment_bytes_declared: number;
    attachments_not_ingested: number;
    items_skipped_otp: number;
    items_skipped_category: number;
    internal_items_indexed: number;
    internal_items_tombstoned: number;
    internal_items_rejected: number;
    internal_chunks_indexed: number;
    internal_chunks_embedded: number;
    secure_items_indexed: number;
    secure_items_tombstoned: number;
    secure_items_rejected: number;
    secure_chunks_indexed: number;
    secure_chunks_embedded: number;
    /** 1 when the run continued a durable checkpoint instead of starting over. */
    resumed_from_checkpoint: number;
    /**
     * 1 when a resume point was present but unusable and the run traversed
     * fresh. Carried as a count because the shared scheduler collapses unknown
     * warning tokens, and this signal must stay legible in scheduler status.
     */
    resume_cursor_rejected: number;
    /** 1 when the Gmail traversal reached its final page in this run. */
    traversal_complete: number;
    /** Always 0: neither lane's absence is evidence of deletion. */
    absence_authoritative: number;
  };
  api_usage: {
    utc_day: string;
  };
  warnings?: string[];
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    provider_cursor_exposed: false;
    absence_authority: 'partial_window';
    tombstones_applied: false;
  };
  receipt_sha256: string;
}

export interface GmailConnectorStoreTaskOutcome {
  receipt: GmailConnectorStoreReceipt;
  /** Scheduler-private durable provider resume point. */
  checkpoint: string | null;
}

export interface GmailStorePullRequest {
  attempted_at?: string;
  /** Durable scheduler checkpoint; never returned from this surface. */
  checkpoint?: string;
  max_items?: number;
  /**
   * Who initiated this run. An operator run is never refused by the Gmail
   * daily request budget (owner ruling 2026-08-19); anything but the exact
   * literal 'operator' fails closed to 'scheduled', and the provider's own
   * refusals bind either way.
   */
  provenance?: SourceInvocationProvenance;
}

export interface GmailStoreReconcileRequest {
  attempted_at?: string;
  /** Same contract as GmailStorePullRequest.provenance. */
  provenance?: SourceInvocationProvenance;
}

export interface GmailConnectorStoreSyncHandler {
  sync(request?: GmailConnectorStoreSyncRequest): Promise<GmailConnectorStoreSyncResult>;
  pull(request?: GmailStorePullRequest): Promise<GmailConnectorStoreTaskOutcome>;
  reconcile(request?: GmailStoreReconcileRequest): Promise<GmailConnectorStoreTaskOutcome>;
  lastStoreRunCompletedAt(): string | undefined;
  requestBudgetStatus(): GoogleRequestBudgetStatus | undefined;
}

export interface GmailConnectorStoreSyncOptions extends GoogleGmailSourceConnectorOptions {
  internalStore: LocalConnectorStore;
  secureStore: LocalConnectorStore;
  /**
   * In-run embedding providers. Without them a dark pull fills both stores with
   * chunks and zero embeddings, so hasEmbeddings() stays false and the corpus
   * can never become servable — the defect that made the whole lane inert.
   */
  internalEmbeddingProvider?: SourceEmbeddingProvider;
  secureEmbeddingProvider?: SourceEmbeddingProvider;
  config?: GmailLiveSyncConfig;
}

export function createGmailConnectorStoreSyncHandler(
  options: GmailConnectorStoreSyncOptions,
): GmailConnectorStoreSyncHandler {
  const env = options.env ?? process.env;
  const config = options.config ?? defaultGmailLiveSyncConfig(env);
  const account = options.account?.trim() || accountFromGoogleHandle(options.credentialHandle);
  if (options.secureEmbeddingProvider && options.secureEmbeddingProvider.backend !== 'local') {
    throw new Error('Gmail secure_local embeddings require a local/private embedding provider.');
  }
  const classification = gmailConnectorStoreClassification(
    options.sensitivityMap ?? loadGoogleSensitivityMap(env),
  );
  const buildConnector = (overrides: {
    maxMessages?: number;
    query?: string;
    provenance?: SourceInvocationProvenance;
  } = {}) =>
    new GoogleGmailSourceConnector({
      ...options,
      ...(overrides.maxMessages !== undefined ? { maxMessages: overrides.maxMessages } : {}),
      ...(overrides.query ? { query: overrides.query } : {}),
      // Stated last and unconditionally, so it is a property of THIS run and
      // nothing else. Handler options are spread above and share the connector
      // option type; without this line a handler constructed once with an
      // operator provenance would exempt every later scheduled run it served.
      provenance: sourceInvocationProvenance(overrides.provenance),
    });

  const runBothStores = async (input: {
    connector: SourceConnector;
    maxItems?: number;
    cursor?: string;
    reconcile?: boolean;
  }): Promise<GmailStoreRun> => {
    // One provider traversal, shared with the second store. The two stores
    // differ only in the trust domain the spine accepts, so the second listing
    // pass was pure duplicate provider cost.
    const traversal = sharedTraversal(input.connector);
    const sync = {
      fetchContent: true,
      classification,
      ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.reconcile
        ? {
          reconcileFullSnapshot: true,
          reconcileFullSnapshotScope: { provider: GMAIL_PROVIDER, accountScope: account },
          // Weakest honest authority. Gmail deletion semantics are unproven on
          // this path, so absence is never evidence of removal and nothing is
          // tombstoned. Upgrading this is a later tranche with its own proof.
          reconcileAbsenceAuthority: 'partial_window' as const,
        }
        : {}),
    };
    const internal = await runStore({
      store: options.internalStore,
      connector: traversal,
      sync,
      ...(options.internalEmbeddingProvider
        ? { embeddingProvider: options.internalEmbeddingProvider }
        : {}),
    });
    const secure = await runStore({
      store: options.secureStore,
      connector: traversal,
      sync,
      ...(options.secureEmbeddingProvider
        ? { embeddingProvider: options.secureEmbeddingProvider }
        : {}),
    });
    return { internal, secure };
  };

  return {
    async sync(request: GmailConnectorStoreSyncRequest = {}): Promise<GmailConnectorStoreSyncResult> {
      const maxMessages = request.max_messages ?? options.maxMessages;
      const run = await runBothStores({
        connector: buildConnector({
          ...(maxMessages !== undefined ? { maxMessages } : {}),
          ...(request.query ? { query: request.query } : {}),
        }),
        ...(maxMessages !== undefined ? { maxItems: maxMessages } : {}),
      });
      return {
        provider: GMAIL_PROVIDER,
        account,
        internal: run.internal.sync,
        secure: run.secure.sync,
      };
    },

    async pull(request: GmailStorePullRequest = {}): Promise<GmailConnectorStoreTaskOutcome> {
      const maxItems = boundedMaxItems(request.max_items, config.storePullMaxItems);
      const warnings: string[] = [];
      const resume = decodeCheckpoint(request.checkpoint);
      const headStoreCursor = options.internalStore
        .lastCompletedSyncRun(GMAIL_PROVIDER)?.cursor;
      let headResume = resume.head ?? (isGmailConnectorCursor(headStoreCursor) ? headStoreCursor : undefined);
      if (resume.headRejected) warnings.push(GMAIL_RESUME_REJECTED_WARNING);
      const provenance = sourceInvocationProvenance(request.provenance);
      let connector = buildConnector({ maxMessages: maxItems, provenance });
      let head: GmailStoreRun;
      try {
        head = await runBothStores({
          connector,
          maxItems,
          ...(headResume ? { cursor: headResume } : {}),
        });
      } catch (error) {
        // A page token is provider state with an unpublished lifetime. A
        // provider that rejects the resume point must not park the lane: drop
        // the checkpoint and traverse fresh, with a counts-only warning.
        //
        // Only a mid-traversal cursor can be rejected, and that is what bounds
        // this arm: the page token is the cursor's sole provider-held half, so
        // under a watermark-only resume point a 4xx is something else — a
        // listed message that 404s on its get, say — and traversing fresh would
        // discard a watermark accumulated over months for a mailbox-wide walk.
        if (!gmailCursorIsMidTraversal(headResume) || !isRejectedCursorError(error)) throw error;
        warnings.push(GMAIL_RESUME_REJECTED_WARNING);
        headResume = undefined;
        connector = buildConnector({ maxMessages: maxItems, provenance });
        head = await runBothStores({ connector, maxItems });
      }
      const headCheckpoint = head.internal.sync.cursor;

      return taskOutcome({
        kind: GMAIL_STORE_PULL_RECEIPT_KIND,
        head,
        traversal: connector.traversalStatus(),
        usage: connector.requestBudgetStatus(),
        resumed: headResume !== undefined,
        checkpoint: encodeCheckpoint({ ...(headCheckpoint ? { head: headCheckpoint } : {}) }),
        warnings,
      });
    },

    async reconcile(
      request: GmailStoreReconcileRequest = {},
    ): Promise<GmailConnectorStoreTaskOutcome> {
      // Deliberately un-cursored and un-bounded: the shared
      // spine only treats a traversal as a full snapshot when neither a cursor
      // nor a maxItems bound was supplied and it reached a done page.
      const connector = buildConnector({
        maxMessages: MAX_RECONCILE_MESSAGES,
        provenance: sourceInvocationProvenance(request.provenance),
      });
      const head = await runBothStores({ connector, reconcile: true });
      return taskOutcome({
        kind: GMAIL_STORE_RECONCILE_RECEIPT_KIND,
        head,
        traversal: connector.traversalStatus(),
        usage: connector.requestBudgetStatus(),
        resumed: false,
        checkpoint: null,
        warnings: [],
      });
    },

    lastStoreRunCompletedAt: () => latestCompletedAt([
      options.internalStore.status().lastSyncRun?.completedAt,
      options.secureStore.status().lastSyncRun?.completedAt,
    ]),
    requestBudgetStatus: () => options.requestBudget?.status(),
  };
}

interface GmailStoreRunLeg {
  sync: ConnectorStoreSyncSummary;
  embed: ConnectorStoreEmbedSummary | undefined;
}

interface GmailStoreRun {
  internal: GmailStoreRunLeg;
  secure: GmailStoreRunLeg;
}

async function runStore(input: {
  store: LocalConnectorStore;
  connector: SourceConnector;
  sync: Parameters<LocalConnectorStore['syncFromConnector']>[1];
  embeddingProvider?: SourceEmbeddingProvider;
}): Promise<GmailStoreRunLeg> {
  if (!input.embeddingProvider) {
    // Honest degradation rather than a silent one: the store still fills, and
    // the receipt's chunks_embedded of 0 says the lane cannot become servable
    // until an embedding provider is configured.
    return { sync: await input.store.syncFromConnector(input.connector, input.sync), embed: undefined };
  }
  const run = await syncAndEmbedFromConnector({
    store: input.store,
    connector: input.connector,
    embeddingProvider: input.embeddingProvider,
    ...(input.sync ? { sync: input.sync } : {}),
  });
  return { sync: run.sync, embed: run.embed };
}

/**
 * Records the provider traversal on first use and shares it afterwards. The
 * recording is faithful even when the store stops early on its own maxItems
 * bound, because the second store applies the same bound to the same pages.
 */
function sharedTraversal(connector: SourceConnector): SourceConnector {
  const pages: SourceConnectorListPage[] = [];
  let recorded = false;
  let failed = false;
  return {
    id: connector.id,
    family: connector.family,
    authenticate: () => connector.authenticate(),
    fetchItem: (localItemId: string): Promise<RawItem> => connector.fetchItem(localItemId),
    classify: (item: RawItem) => connector.classify(item),
    listItems(options: SourceConnectorListOptions = {}): AsyncIterable<SourceConnectorListPage> {
      if (recorded) {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          for (const page of pages) yield page;
        })();
      }
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        try {
          for await (const page of connector.listItems(options)) {
            pages.push(page);
            yield page;
          }
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          // Reached on normal completion and on the store breaking out early.
          // A thrown traversal is never shareable: its recording is partial
          // and the caller is aborting the whole run anyway.
          if (!failed) recorded = true;
        }
      })();
    },
  };
}

interface GmailCheckpointEnvelope {
  head?: string;
}

interface DecodedGmailCheckpoint extends GmailCheckpointEnvelope {
  headRejected?: boolean;
}

export function encodeGmailStoreCheckpoint(envelope: GmailCheckpointEnvelope): string | null {
  return encodeCheckpoint(envelope);
}

function encodeCheckpoint(envelope: GmailCheckpointEnvelope): string | null {
  if (!envelope.head) return null;
  return `${CHECKPOINT_PREFIX}${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`;
}

/**
 * Validate the provider cursor while accepting the previous two-field envelope
 * long enough to preserve its `head` member across the repository cutover.
 */
function decodeCheckpoint(value: string | undefined): DecodedGmailCheckpoint {
  const trimmed = value?.trim();
  if (!trimmed) return {};
  if (trimmed.length > MAX_CHECKPOINT_CHARS || !trimmed.startsWith(CHECKPOINT_PREFIX)) {
    // A bare provider cursor from before the envelope existed remains valid.
    if (isGmailConnectorCursor(trimmed)) return { head: trimmed };
    return { headRejected: true };
  }
  let parsed: { head?: unknown };
  try {
    parsed = JSON.parse(
      Buffer.from(trimmed.slice(CHECKPOINT_PREFIX.length), 'base64url').toString('utf8'),
    ) as { head?: unknown };
  } catch {
    return { headRejected: true };
  }
  const head = typeof parsed.head === 'string' ? parsed.head : undefined;
  return {
    ...(head !== undefined && isGmailConnectorCursor(head) ? { head } : {}),
    ...(head !== undefined && !isGmailConnectorCursor(head) ? { headRejected: true } : {}),
  };
}

function taskOutcome(input: {
  kind: GmailConnectorStoreReceipt['kind'];
  head: GmailStoreRun;
  traversal: GmailSourceConnectorTraversalStatus;
  usage: GoogleRequestBudgetStatus | undefined;
  resumed: boolean;
  checkpoint: string | null;
  warnings: string[];
}): GmailConnectorStoreTaskOutcome {
  const internalIndexed = input.head.internal.sync.itemsIndexed;
  const secureIndexed = input.head.secure.sync.itemsIndexed;
  const internalTombstoned = input.head.internal.sync.itemsTombstoned;
  const secureTombstoned = input.head.secure.sync.itemsTombstoned;
  const internalEmbedded = input.head.internal.embed?.chunksEmbedded ?? 0;
  const secureEmbedded = input.head.secure.embed?.chunksEmbedded ?? 0;
  const changed = internalIndexed > 0
    || secureIndexed > 0
    || internalTombstoned > 0
    || secureTombstoned > 0
    || internalEmbedded > 0
    || secureEmbedded > 0;
  const warnings = [...new Set(input.warnings)];
  if (input.traversal.attachmentsNotIngested > 0) {
    warnings.push(GMAIL_ATTACHMENTS_NOT_INGESTED_WARNING);
  }
  if (input.traversal.itemsSkippedOtp + input.traversal.itemsSkippedCategory > 0) {
    warnings.push(GMAIL_INGEST_FILTERED_WARNING);
  }
  const receipt: Omit<GmailConnectorStoreReceipt, 'receipt_sha256'> = {
    kind: input.kind,
    status: changed ? 'progress' : 'idle',
    counts: {
      api_requests: input.usage?.requests ?? 0,
      daily_api_request_budget: input.usage?.dailyRequestBudget ?? 0,
      provider_traversals: 1,
      items_seen: input.head.internal.sync.itemsSeen,
      fetch_item_cache_hits: input.traversal.fetchItemCacheHits,
      attachments_declared: input.traversal.attachmentsDeclared,
      attachment_bytes_declared: input.traversal.attachmentBytesDeclared,
      attachments_not_ingested: input.traversal.attachmentsNotIngested,
      items_skipped_otp: input.traversal.itemsSkippedOtp,
      items_skipped_category: input.traversal.itemsSkippedCategory,
      internal_items_indexed: internalIndexed,
      internal_items_tombstoned: internalTombstoned,
      internal_items_rejected: input.head.internal.sync.itemsRejected,
      internal_chunks_indexed: input.head.internal.sync.chunksIndexed,
      internal_chunks_embedded: internalEmbedded,
      secure_items_indexed: secureIndexed,
      secure_items_tombstoned: secureTombstoned,
      secure_items_rejected: input.head.secure.sync.itemsRejected,
      secure_chunks_indexed: input.head.secure.sync.chunksIndexed,
      secure_chunks_embedded: secureEmbedded,
      resumed_from_checkpoint: Number(input.resumed),
      resume_cursor_rejected: Number(warnings.includes(GMAIL_RESUME_REJECTED_WARNING)),
      // The spine's own record of whether the listing ran out, never an
      // inference from the checkpoint. The reconcile lane clears its checkpoint
      // by policy, so a cursor-derived reading called every reconcile complete
      // — including one the connector's 1,000-message ceiling cut off after
      // ~1.4% of a large mailbox.
      traversal_complete: Number(input.head.internal.sync.traversalComplete),
      absence_authoritative: 0,
    },
    api_usage: {
      utc_day: input.usage?.utcDay ?? '',
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      provider_cursor_exposed: false,
      absence_authority: 'partial_window',
      tombstones_applied: false,
    },
  };
  return {
    receipt: { ...receipt, receipt_sha256: gmailReceiptDigest(receipt) },
    checkpoint: input.checkpoint,
  };
}

/**
 * Self-digest over every field the receipt carries except the digest itself.
 * A verifier recomputes it from the receipt alone; nothing private is needed.
 */
export function gmailReceiptDigest(
  receipt: Omit<GmailConnectorStoreReceipt, 'receipt_sha256'>,
): string {
  return createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
}

function isRejectedCursorError(error: unknown): boolean {
  if (error instanceof TypeError) return /cursor is invalid/i.test(error.message);
  if (!(error instanceof Error)) return false;
  // A stale Gmail page token comes back as a 400/404 on messages.list. 401/403
  // are credential problems and 429 is the rate limiter; neither is the
  // cursor's fault and neither may be papered over by traversing from scratch.
  const match = /Gmail API request failed \((\d{3})\)/.exec(error.message);
  const status = match?.[1] ? Number(match[1]) : undefined;
  return status !== undefined && status >= 400 && status < 500
    && status !== 401 && status !== 403 && status !== 429;
}

function boundedMaxItems(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Gmail store pull max_items must be a positive integer.');
  }
  return Math.min(value, fallback);
}

function latestCompletedAt(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}
