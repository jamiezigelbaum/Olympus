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
  type ConnectorStoreEmbedSummary,
  type ConnectorStoreSyncOptions,
  type ConnectorStoreSyncSummary,
  type LocalConnectorStore,
} from '../connector-store/index.ts';
import {
  createLaneTieredStoreSet,
  tieredLaneReceiptCounts,
  type TieredLaneReceiptCounts,
  type TieredStoreRoutingCounts,
  type TieredStoreSet,
  type TieredStoreSetRun,
} from '../connector-store/tiered-store-set.ts';
import type { OwnerTierRule } from '../classification/tier-classifier.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import { LabelPageRejectedError, sweepLabelRuleRaises } from '../connector-store/tier-rules-sweep.ts';
import {
  isApprovedSecureSourceEmbeddingProvider,
  type SourceEmbeddingProvider,
} from '../source-index/embeddings.ts';
import { accountFromGoogleHandle } from './classification.ts';
import {
  GMAIL_PROVIDER,
  GMAIL_PUBLIC_CONNECTOR_CORPUS_ID,
  GmailPageTokenRejectedError,
  GMAIL_PRIVATE_SCOPE_CONFIRMATION_MAX_ITEMS,
  GoogleGmailSourceConnector,
  gmailConnectorStoreClassification,
  gmailCursorIsMidTraversal,
  gmailLabelledMessageSource,
  isGmailConnectorCursor,
  type GmailSourceConnectorTraversalStatus,
  type GmailConnectorScope,
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
/** An always-Private label has not yet been applied to every message already stored; the next run retries. */
export const GMAIL_LABEL_RULES_PENDING_WARNING = 'gmail_label_rules_pending';

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
  } & TieredLaneReceiptCounts;
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
  confirmPrivateScope?(request?: { max_items?: number; checkpoint?: string }): Promise<{ confirmed: number; done: boolean; checkpoint: string | null }>;
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
  /**
   * The mail scope approval this lane's cursor is bound to, the same way the
   * Drive lane binds to its folder scope: the store cursor and the scheduler
   * checkpoint are keyed to it, so a new revision (or a reconnected account)
   * starts a fresh traversal under the new query instead of resuming the old
   * one's watermark. The compiled query itself rides `scope`.
   */
  scopeApproval?: { generation: string; revision: string };
  /** Confirm current scope membership of immutable Private bodies needed by local meaning backfill. */
  confirmStoredPrivateScope?: boolean;
  /**
   * Re-check that approval against the live registry. Called after every
   * provider answer and before it reaches a store, as the Dropbox and Drive
   * lanes do per item: the task-entry check alone let a reconnect that landed
   * mid-task list the new account's mailbox into the old account's stores
   * (independent review round 4 on the account-binding change). Throws when
   * the approval is no longer current.
   */
  assertScopeCurrent?: () => void;
  /**
   * The lane's per-tier stores (tiered-store-set.ts). Omitted: a set over the
   * internal and secure stores, with the Public store below when given.
   */
  tierSet?: TieredStoreSet;
  publicStore?: { open: () => LocalConnectorStore; exists: () => boolean };
  secretLocations?: SecretLocationsIndex;
  onTierLegOpened?: (store: LocalConnectorStore) => void;
}

/**
 * The Gmail lane's own sync options under the owner's rules: what every input
 * of the lane is stored with, a live pull and an imported mbox alike
 * (gmail-archive-target.ts).
 */
export function gmailLaneSyncOptions(ownerRules: readonly OwnerTierRule[] = []): ConnectorStoreSyncOptions {
  return {
    fetchContent: true,
    classification: gmailConnectorStoreClassification(ownerRules),
    tierClassification: { ...(ownerRules.length > 0 ? { rules: [...ownerRules] } : {}) },
  };
}

export function createGmailConnectorStoreSyncHandler(
  options: GmailConnectorStoreSyncOptions,
): GmailConnectorStoreSyncHandler {
  const env = options.env ?? process.env;
  const config = options.config ?? defaultGmailLiveSyncConfig(env);
  const account = options.account?.trim() || accountFromGoogleHandle(options.credentialHandle);
  const connectorId = gmailCursorConnectorId(account, options.scopeApproval);
  const scopeTag = options.scopeApproval ? connectorId.slice(GMAIL_SCOPED_CONNECTOR_PREFIX.length) : undefined;
  if (options.secureEmbeddingProvider && !isApprovedSecureSourceEmbeddingProvider(options.secureEmbeddingProvider)) {
    throw new Error('Gmail secure_local embeddings require a local/private or approved Venice embedding provider.');
  }
  const ownerRules = options.scope?.ownerTierRules ?? [];
  const classification = gmailConnectorStoreClassification(ownerRules);
  // The recorded four-tier decision sees the same owner rules, so the ledger
  // names the rule (metadata:owner_rule:sender:<id>:force) as the reason.
  const tierClassification = {
    ...(ownerRules.length > 0 ? { rules: ownerRules } : {}),
  };
  // Under a scope, mail either store already holds is never re-observed: a
  // re-read could only swap a stored body for a metadata-only row or re-tier
  // an item whose vectors exist, and both would discard existing chunks and
  // embeddings (owner rule: nothing throws away existing embeddings).
  const storedItem = (providerItemId: string) => {
    const identity = { family: 'email' as const, provider: GMAIL_PROVIDER, accountScope: account, providerItemId, localItemId: `${account}:${providerItemId}` };
    const copies = [options.internalStore.itemStoredContent(identity), options.secureStore.itemStoredContent(identity)]
      .filter((copy): copy is NonNullable<typeof copy> => copy !== undefined);
    if (copies.length === 0) return undefined;
    return {
      hasContent: copies.some(copy => copy.chunkCount > 0),
      ...(options.confirmStoredPrivateScope && options.scopeApproval
        && options.secureStore.itemStoredContent(identity)?.chunkCount
        && !options.secureStore.itemOwnerPresent(identity, connectorId, 'observed')
        ? { needsScopeObservation: true } : {}),
    };
  };
  const scope = options.scope ? {
    ...options.scope, storedItem,
    ...(options.confirmStoredPrivateScope && options.scopeApproval ? {
      storedItemObserved: (item: RawItem) => {
        options.assertScopeCurrent?.();
        options.secureStore.observeStoredItemOwner(item.identity, connectorId);
      },
    } : {}),
  } : undefined;
  const buildConnector = (overrides: {
    maxMessages?: number;
    query?: string;
    provenance?: SourceInvocationProvenance;
    scope?: GmailConnectorScope;
  } = {}) =>
    new GoogleGmailSourceConnector({
      ...options,
      ...(overrides.scope ? { scope: overrides.scope } : scope ? { scope } : {}),
      ...(overrides.maxMessages !== undefined ? { maxMessages: overrides.maxMessages } : {}),
      ...(overrides.query ? { query: overrides.query } : {}),
      // Stated last and unconditionally, so it is a property of THIS run and
      // nothing else. Handler options are spread above and share the connector
      // option type; without this line a handler constructed once with an
      // operator provenance would exempt every later scheduled run it served.
      provenance: sourceInvocationProvenance(overrides.provenance),
    });

  const tierSet = options.tierSet ?? createLaneTieredStoreSet({
    setId: connectorId,
    internalStore: options.internalStore,
    secureStore: options.secureStore,
    ...(options.publicStore
      ? { publicLeg: { corpusId: GMAIL_PUBLIC_CONNECTOR_CORPUS_ID, ...options.publicStore } }
      : {}),
    ...(options.internalEmbeddingProvider ? { internalEmbeddingProvider: options.internalEmbeddingProvider } : {}),
    ...(options.secureEmbeddingProvider ? { secureEmbeddingProvider: options.secureEmbeddingProvider } : {}),
    tierClassification,
    ...(options.secretLocations ? { secretLocations: options.secretLocations } : {}),
    ...(options.onTierLegOpened ? { onLegOpened: (store) => options.onTierLegOpened!(store) } : {}),
  });

  // An owner's "always Private" (or Secrets) label saved after mail was stored:
  // Gmail never lists a held message again, so its labels are asked of Gmail by
  // label and the stored messages carrying it are raised (hidden first). The
  // rule counts as applied only once Gmail has answered every page; any failure
  // leaves it pending and the next run retries. `recheck` also re-walks the
  // rules already applied (a label can be put on stored mail later). Never
  // throws; returns the warning a run carries while a rule is still pending.
  const sweepLabelRules = async (connector: GoogleGmailSourceConnector, recheck = false): Promise<string[]> => {
    try {
      const labelled = gmailLabelledMessageSource(() => connector.apiClientForTooling());
      const report = await sweepLabelRuleRaises({
        set: tierSet,
        provider: GMAIL_PROVIDER,
        accountScope: account,
        ...(recheck ? { recheck: true } : {}),
        source: {
          async listLabelled(label, page) {
            let answer: Awaited<ReturnType<typeof labelled.listLabelled>>;
            try {
              answer = await labelled.listLabelled(label, page);
            } catch (error) {
              throw error instanceof GmailPageTokenRejectedError ? new LabelPageRejectedError() : error;
            }
            // A reconnect that landed mid-sweep must not apply another
            // mailbox's labels to this account's stored mail.
            options.assertScopeCurrent?.();
            return answer;
          },
        },
      });
      return report.pending > 0 ? [GMAIL_LABEL_RULES_PENDING_WARNING] : [];
    } catch {
      return [GMAIL_LABEL_RULES_PENDING_WARNING];
    }
  };

  const runBothStores = async (input: {
    connector: SourceConnector;
    maxItems?: number;
    cursor?: string;
    reconcile?: boolean;
  }): Promise<GmailStoreRun> => {
    // One provider traversal feeds every tier store: the set records it on
    // its first pass and replays it to the other legs, routes each NEW message
    // by its recorded tiers, and leaves every existing message on the lane's
    // own placement. Its resume point commits only after every leg did.
    const traversal = scopedTraversal(input.connector, connectorId, options.assertScopeCurrent);
    const sync = {
      fetchContent: true,
      classification,
      tierClassification,
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
    const run = await tierSet.sync(traversal, sync, { commitCursor: input.reconcile !== true });
    return {
      internal: gmailLegOf(run, 'internal'),
      secure: gmailLegOf(run, 'secure_local'),
      ...(run.byDomain.public_safe ? { public: gmailLegOf(run, 'public_safe') } : {}),
      routing: run.routing,
    };
  };

  return {
    ...(options.confirmStoredPrivateScope && options.scopeApproval && scope ? {
      confirmPrivateScope: async (request: { max_items?: number; checkpoint?: string } = {}) => {
        const confirmationScope = `private-confirmation-v1:${connectorId}`;
        const complete = `${confirmationScope}:done`;
        if (request.checkpoint === complete) return { confirmed: 0, done: true, checkpoint: complete };
        const resume = decodeCheckpoint(request.checkpoint, confirmationScope).head;
        options.assertScopeCurrent?.();
        let confirmed = 0;
        const maxItems = Math.min(request.max_items ?? config.storePullMaxItems, GMAIL_PRIVATE_SCOPE_CONFIRMATION_MAX_ITEMS);
        const connector = buildConnector({
          maxMessages: maxItems,
          scope: { ...scope, confirmationOnly: true, storedItemObserved: item => {
            scope.storedItemObserved?.(item);
            if (options.secureStore.itemOwnerPresent(item.identity, connectorId, 'observed')) confirmed++;
          } },
        });
        let done = false;
        let checkpoint: string | null = resume ? encodeCheckpoint({ head: resume, scope: confirmationScope }) : null;
        try {
          for await (const page of connector.listItems({ limit: maxItems, ...(resume ? { cursor: resume } : {}) })) {
            done = page.done;
            checkpoint = done ? complete : page.nextCursor ? encodeCheckpoint({ head: page.nextCursor, scope: confirmationScope }) : checkpoint;
          }
        } catch (error) {
          if (!resume || !isRejectedCursorError(error)) throw error;
          // Provider continuation tokens can expire. Replay starts fresh;
          // confirmed ownership is durable, so metadata is not fetched twice.
          checkpoint = null;
        }
        options.assertScopeCurrent?.();
        return { confirmed, done, checkpoint };
      },
    } : {}),
    async sync(request: GmailConnectorStoreSyncRequest = {}): Promise<GmailConnectorStoreSyncResult> {
      const maxMessages = request.max_messages ?? options.maxMessages;
      const connector = buildConnector({
        ...(maxMessages !== undefined ? { maxMessages } : {}),
        ...(request.query ? { query: request.query } : {}),
      });
      await sweepLabelRules(connector);
      const run = await runBothStores({
        connector,
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
      const resume = decodeCheckpoint(request.checkpoint, scopeTag);
      // The tier set's committed resume point, written only after every leg of
      // a run committed. Before a set has committed one, fall back to the LAST
      // leg's own completed run: legs ran in order, so it is never ahead of a
      // window an earlier leg missed (the first leg's row can be).
      const headStoreCursor = tierSet.committedCursor(connectorId)?.cursor
        ?? options.secureStore.lastCompletedSyncRun(connectorId)?.cursor;
      let headResume = resume.head ?? (isGmailConnectorCursor(headStoreCursor) ? headStoreCursor : undefined);
      if (resume.headRejected) warnings.push(GMAIL_RESUME_REJECTED_WARNING);
      const provenance = sourceInvocationProvenance(request.provenance);
      let connector = buildConnector({ maxMessages: maxItems, provenance });
      warnings.push(...await sweepLabelRules(connector));
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
        checkpoint: encodeCheckpoint({
          ...(headCheckpoint ? { head: headCheckpoint } : {}),
          ...(scopeTag ? { scope: scopeTag } : {}),
        }),
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
      const warnings = await sweepLabelRules(connector, true);
      const head = await runBothStores({ connector, reconcile: true });
      return taskOutcome({
        kind: GMAIL_STORE_RECONCILE_RECEIPT_KIND,
        head,
        traversal: connector.traversalStatus(),
        usage: connector.requestBudgetStatus(),
        resumed: false,
        checkpoint: null,
        warnings,
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
  /** Present once the lane's Public store exists and ran. */
  public?: GmailStoreRunLeg;
  routing: TieredStoreRoutingCounts;
}

function gmailLegOf(run: TieredStoreSetRun, domain: 'public_safe' | 'internal' | 'secure_local'): GmailStoreRunLeg {
  const leg = run.byDomain[domain];
  if (!leg) throw new Error(`The Gmail ${domain} store did not run.`);
  return { sync: leg.sync, embed: leg.embed };
}

/** The connector under this lane's (scope-bound) cursor id. */
function scopedTraversal(
  connector: SourceConnector,
  connectorId: string,
  assertScopeCurrent: (() => void) | undefined,
): SourceConnector {
  if (!assertScopeCurrent) {
    return {
      id: connectorId,
      family: connector.family,
      authenticate: () => connector.authenticate(),
      fetchItem: (localItemId: string): Promise<RawItem> => connector.fetchItem(localItemId),
      classificationSignals: (item: RawItem) => connector.classificationSignals(item),
      listItems: (options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> => connector.listItems(options),
    };
  }
  return {
    id: connectorId,
    family: connector.family,
    authenticate: async () => {
      await connector.authenticate();
      assertScopeCurrent();
    },
    fetchItem: async (localItemId: string): Promise<RawItem> => {
      const item = await connector.fetchItem(localItemId);
      assertScopeCurrent();
      return item;
    },
    classificationSignals: (item: RawItem) => connector.classificationSignals(item),
    listItems: (options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> => ({
      async *[Symbol.asyncIterator]() {
        for await (const page of connector.listItems(options)) {
          assertScopeCurrent();
          yield page;
        }
      },
    }),
  };
}

interface GmailCheckpointEnvelope {
  head?: string;
  /** Digest of the mail scope approval the head cursor was walked under. */
  scope?: string;
}

const GMAIL_SCOPED_CONNECTOR_PREFIX = `${GMAIL_PROVIDER}.scope.`;

/**
 * The store's sync-run key. Unscoped lanes keep the provider id; a scoped lane
 * keys its cursor to the approval, exactly as the Drive lane does, so the
 * store row a new revision falls back to is its own and never the previous
 * scope's watermark.
 */
export function gmailCursorConnectorId(
  account: string,
  scope: { generation: string; revision: string } | undefined,
): string {
  if (!scope) return GMAIL_PROVIDER;
  const digest = createHash('sha256')
    .update(`${account}\u0000${scope.generation}\u0000${scope.revision}`)
    .digest('hex')
    .slice(0, 24);
  return `${GMAIL_SCOPED_CONNECTOR_PREFIX}${digest}`;
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
function decodeCheckpoint(value: string | undefined, scopeTag?: string): DecodedGmailCheckpoint {
  const trimmed = value?.trim();
  if (!trimmed) return {};
  if (trimmed.length > MAX_CHECKPOINT_CHARS || !trimmed.startsWith(CHECKPOINT_PREFIX)) {
    // A bare provider cursor from before the envelope existed remains valid,
    // but only for an unscoped lane: it was walked under no approval.
    if (isGmailConnectorCursor(trimmed)) return scopeTag ? {} : { head: trimmed };
    return { headRejected: true };
  }
  let parsed: { head?: unknown; scope?: unknown };
  try {
    parsed = JSON.parse(
      Buffer.from(trimmed.slice(CHECKPOINT_PREFIX.length), 'base64url').toString('utf8'),
    ) as { head?: unknown; scope?: unknown };
  } catch {
    return { headRejected: true };
  }
  // A checkpoint walked under another scope revision (or none) is not this
  // traversal's resume point. Not a rejection: a changed scope starts over by
  // design, so it carries no warning.
  const checkpointScope = typeof parsed.scope === 'string' ? parsed.scope : undefined;
  if (checkpointScope !== scopeTag) return {};
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
    || secureEmbedded > 0
    || (input.head.public?.sync.itemsIndexed ?? 0) > 0
    || (input.head.public?.embed?.chunksEmbedded ?? 0) > 0;
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
      ...tieredLaneReceiptCounts(input.head),
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
