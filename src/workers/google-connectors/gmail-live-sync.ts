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
import { readSourceAccountBindings, sourceAccountBindingsPath } from '../../core/source-account-binding.ts';
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
import { GMAIL_IMPORT_CONNECTOR_PREFIX } from './gmail-archive-target.ts';
import { GMAIL_OWN_ID_PREFIX, gmailMailItems } from './gmail-mail-record.ts';
import {
  GMAIL_PROVIDER,
  GMAIL_PUBLIC_CONNECTOR_CORPUS_ID,
  GmailPageTokenRejectedError,
  GoogleGmailSourceConnector,
  gmailConnectorStoreClassification,
  gmailCursorHasBacklog,
  gmailCursorIsMidTraversal,
  gmailLabelledMessageSource,
  isGmailConnectorCursor,
  gmailMailRecordFromMessage,
  gmailMessageInScope,
  type GmailSourceConnectorTraversalStatus,
  type GmailConnectorScope,
  type GoogleGmailSourceConnectorOptions,
} from './gmail.ts';
import {
  defaultGmailLiveSyncConfig,
  type GmailLiveSyncConfig,
} from './gmail-live-control.ts';
import { GoogleRequestBudgetError, type GoogleDailyRequestBudget, type GoogleRequestBudgetStatus } from './request-budget.ts';

export const GMAIL_STORE_PULL_RECEIPT_KIND = 'gmail_connector_store_pull_receipt';
export const GMAIL_STORE_RECONCILE_RECEIPT_KIND = 'gmail_connector_store_reconcile_receipt';
export const GMAIL_RESUME_REJECTED_WARNING = 'gmail_store_resume_cursor_rejected';
export const GMAIL_ATTACHMENTS_NOT_INGESTED_WARNING = 'gmail_attachments_not_ingested';
export const GMAIL_INGEST_FILTERED_WARNING = 'gmail_ingest_filtered_items';
/** An always-Private label has not yet been applied to every message already stored; the next run retries. */
export const GMAIL_LABEL_RULES_PENDING_WARNING = 'gmail_label_rules_pending';
export const GMAIL_CONFIRMATION_RESERVE_REASON = 'gmail_confirmation_live_request_reserve';

// Leave room for two ordinary 200-message live pulls, list pages and retries.
// A smaller daily limit keeps 10% for live work instead of parking all backlog.
function gmailConfirmationReserve(dailyLimit: number): number {
  return Math.min(500, Math.ceil(dailyLimit / 10));
}

const CHECKPOINT_PREFIX = 'gmp1:';
const MAX_CHECKPOINT_CHARS = 16_384;
// Both earlier walks could accept a message without checking its body.
const CONFIRMATION_SCOPE_PREFIX = 'private-confirmation-v3:';
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
  /**
   * The pull stopped partway through a traversal, so more is ready now. A
   * widened window walks the whole mailbox again; at one bounded pull per
   * interval that took days before any older mail arrived.
   */
  backlog?: boolean;
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
  confirmPrivateScope?(request?: GmailConfirmationRequest): Promise<GmailConfirmationResult>;
  /**
   * Once, for mail stored before attachments were children: lists the
   * attachments of messages whose stored text names one and that no child row
   * points to, a bounded number per pass, resumable, under the day budget and
   * the current mail scope. Done once the stores hold no such message.
   */
  backfillChildren?(request?: { max_items?: number; provenance?: SourceInvocationProvenance }): Promise<{ listed: number; examined: number; done: boolean }>;
}

export type GmailConfirmationYieldCheck = (boundary: 'start' | 'page') => GmailConfirmationYieldReason | undefined;
export type GmailConfirmationYieldReason = 'owner_ask' | 'live_pull_due';

interface GmailConfirmationRequest {
  max_items?: number;
  checkpoint?: string;
  yieldReason?: GmailConfirmationYieldCheck;
}

interface GmailConfirmationResult {
  confirmed: number;
  confirmedTotal: number;
  done: boolean;
  checkpoint: string | null;
  waitReason?: GmailConfirmationYieldReason;
  hold?: { error: GoogleRequestBudgetError; remaining: number };
  cursorRejected?: true;
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
  requestBudget?: GoogleDailyRequestBudget;
  /** Registry path used by the scheduler's source account guard. */
  confirmationRegistryPath?: string;
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

/** The children backfill's resume point lives under one fixed key, whatever the scope revision. */
const GMAIL_CHILDREN_BACKFILL_SET = 'gmail.email';
const GMAIL_CHILDREN_BACKFILL_CONNECTOR = 'gmail.children-backfill.v1';
/** Messages one backfill pass asks Gmail for (one request each). */
export const GMAIL_CHILDREN_BACKFILL_PER_PASS = 20;
/** What a stored message's search text says of each attachment it has (gmail-mail-record.ts, `attachments`). */
const GMAIL_ATTACHMENT_LINE = 'Attachment: ';

function readChildrenBackfill(cursor: string | null | undefined): { internal: number; secure: number; done?: boolean } {
  try {
    const parsed = cursor ? JSON.parse(cursor) as { internal?: unknown; secure?: unknown; done?: unknown } : {};
    const pk = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
    return { internal: pk(parsed.internal), secure: pk(parsed.secure), ...(parsed.done === true ? { done: true } : {}) };
  } catch {
    return { internal: 0, secure: 0 };
  }
}

/** Gmail's attachment children are listed by name; their bytes are read later (child items, 2.1.0). */
export const gmailContentArrivesLater = (item: RawItem): boolean => item.deferredBytes !== undefined;

export function createGmailConnectorStoreSyncHandler(
  options: GmailConnectorStoreSyncOptions,
): GmailConnectorStoreSyncHandler {
  const env = options.env ?? process.env;
  const config = options.config ?? defaultGmailLiveSyncConfig(env);
  const account = options.account?.trim() || accountFromGoogleHandle(options.credentialHandle);
  const { connectorId, setId, legacyIds, scopeTag } = gmailScopeKeys(account, options.scopeApproval);
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
  // Keep stored bodies as they are. A metadata confirmation can add the
  // current approval's owner to retained content in either tier. Confirming
  // Personal mail lets that owner travel with the body if the judge raises it.
  const stores = [options.internalStore, options.secureStore];
  // The walk checks the immutable Gmail message, including the retained body.
  // Its MIME parts may live in a different tier. Only parts actually observed
  // by this same live approval need their old proof renewed.
  const confirmLegacyParts = (parent: RawItem['identity']) => {
    for (const store of stores) {
      for (const child of store.activeChildrenOf({ provider: parent.provider, accountScope: account, parentLocalItemId: parent.localItemId })) {
        if (!legacyIds.some(id => store.itemOwnerPresent(child, id, 'observed'))) continue;
        options.assertScopeCurrent?.();
        store.observeStoredItemOwner(child, connectorId);
      }
    }
  };
  const storedItem = (providerItemId: string, confirming = false) => {
    const identity = { family: 'email' as const, provider: GMAIL_PROVIDER, accountScope: account, providerItemId, localItemId: `${account}:${providerItemId}` };
    const copies = stores.flatMap(store => {
      const content = store.itemStoredContent(identity);
      return content ? [{ store, content }] : [];
    });
    if (copies.length === 0) return undefined;
    return {
      hasContent: copies.some(({ content }) => content.chunkCount > 0),
      ...(confirming
        && copies.some(({ store, content }) => content.chunkCount > 0 && !store.itemOwnerPresent(identity, connectorId, 'observed'))
        ? { needsScopeObservation: true } : {}),
    };
  };
  const scope = options.scope ? { ...options.scope, storedItem } : undefined;
  const buildConnector = (overrides: {
    maxMessages?: number;
    query?: string;
    provenance?: SourceInvocationProvenance;
    scope?: GmailConnectorScope;
    requestBudget?: GoogleGmailSourceConnectorOptions['requestBudget'];
  } = {}) =>
    new GoogleGmailSourceConnector({
      ...options,
      ...(options.confirmationRegistryPath ? {
        confirmationAccountId: () => {
          const read = readSourceAccountBindings(sourceAccountBindingsPath(options.confirmationRegistryPath!));
          const binding = read.kind === 'ok' ? read.bindings.sources['gmail.email'] : undefined;
          return binding && !binding.purge_required && !binding.reconnected_at ? binding.provider_account_id : undefined;
        },
      } : {}),
      ...(overrides.scope ? { scope: overrides.scope } : scope ? { scope } : {}),
      ...(overrides.requestBudget ? { requestBudget: overrides.requestBudget } : {}),
      ...(options.assertScopeCurrent ? {
        beforeEachRequest: () => {
          options.assertScopeCurrent?.();
          options.beforeEachRequest?.();
        },
      } : {}),
      ...(overrides.maxMessages !== undefined ? { maxMessages: overrides.maxMessages } : {}),
      ...(overrides.query ? { query: overrides.query } : {}),
      // Stated last and unconditionally, so it is a property of THIS run and
      // nothing else. Handler options are spread above and share the connector
      // option type; without this line a handler constructed once with an
      // operator provenance would exempt every later scheduled run it served.
      provenance: sourceInvocationProvenance(overrides.provenance),
    });

  const tierSet = options.tierSet ?? createLaneTieredStoreSet({
    setId,
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
    // An attachment child's text lands later, read by the extraction factory: its names are placed now.
    contentArrivesLaterFor: gmailContentArrivesLater,
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
    if (legacyIds.length > 0 && !tierSet.ledger.listingCaughtUp(connectorId) && legacyIds.some(id => tierSet.ledger.listingCaughtUp(id))) {
      tierSet.ledger.markListingCaughtUp(connectorId);
    }
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
    ...(options.scopeApproval && scope ? {
      confirmPrivateScope: async (request: GmailConfirmationRequest = {}): Promise<GmailConfirmationResult> => {
        const confirmationScope = `${CONFIRMATION_SCOPE_PREFIX}${connectorId}`;
        const complete = `${confirmationScope}:done`;
        const saved = decodeCheckpoint(request.checkpoint, confirmationScope);
        const confirmedBefore = saved.confirmed ?? 0;
        if (request.checkpoint === complete || saved.head === complete) {
          return { confirmed: 0, confirmedTotal: confirmedBefore, done: true, checkpoint: request.checkpoint! };
        }
        let head = saved.head;
        options.assertScopeCurrent?.();
        let waitReason = request.yieldReason?.('start');
        if (waitReason) {
          return { confirmed: 0, confirmedTotal: confirmedBefore, done: false, waitReason, checkpoint: request.checkpoint ?? null };
        }
        let confirmed = 0;
        const maxItems = boundedMaxItems(request.max_items, config.storePullMaxItems);
        const budget = options.requestBudget;
        const connector = buildConnector({
          maxMessages: maxItems,
          ...(budget ? { requestBudget: {
            reserve: () => budget.reserve('scheduled', gmailConfirmationReserve),
            status: () => budget.status(),
          } } : {}),
          scope: {
            ...scope,
            storedItem: id => storedItem(id, true),
            confirmStoredItem: (item, passesIngestFilter) => {
              let observed = false;
              // A tier move may have changed which copy holds the text while the GET was in flight.
              for (const store of stores) {
                if (store.itemOwnerPresent(item.identity, connectorId, 'observed')) continue;
                const text = store.releaseItemChunks(item.identity)?.chunks.map(chunk => chunk.text).join('');
                if (!text?.trim() || !passesIngestFilter(text)) continue;
                // Renew the parts first so an interrupted page still owes the parent.
                if (!observed && options.build?.children) confirmLegacyParts(item.identity);
                options.assertScopeCurrent?.();
                store.observeStoredItemOwner(item.identity, connectorId);
                if (store.itemOwnerPresent(item.identity, connectorId, 'observed')) observed = true;
              }
              if (observed) confirmed++;
            },
          },
        });
        let done = false;
        let refusal: GoogleRequestBudgetError | undefined;
        let cursorRejected: true | undefined;
        try {
          for await (const page of connector.listItems({ limit: maxItems, ...(head ? { cursor: head } : {}) })) {
            done = page.done;
            head = done ? complete : page.nextCursor ?? head;
            if (!done) {
              waitReason = request.yieldReason?.('page');
              if (waitReason) break;
            }
          }
        } catch (error) {
          if (error instanceof GoogleRequestBudgetError) {
            refusal = error;
            head = connector.interruptedConfirmationCursor() ?? head;
          }
          else if (head && isRejectedCursorError(error)) {
            // Replay skips durable confirmations. Keep the cumulative count.
            head = undefined;
            cursorRejected = true;
          } else throw error;
        }
        const remaining = refusal
          ? (await Promise.all(stores.map(store => store.unobservedContentCount(GMAIL_PROVIDER, account, connectorId, GMAIL_IMPORT_CONNECTOR_PREFIX))))
            .reduce((sum, count) => sum + count, 0)
          : undefined;
        options.assertScopeCurrent?.();
        const confirmedTotal = confirmedBefore + confirmed;
        const checkpoint = encodeCheckpoint({ ...(head ? { head } : {}), scope: confirmationScope, confirmed: confirmedTotal });
        return { confirmed, confirmedTotal, done, checkpoint,
          ...(waitReason ? { waitReason } : {}),
          ...(refusal && remaining !== undefined ? { hold: { error: refusal, remaining } } : {}),
          ...(cursorRejected ? { cursorRejected } : {}),
        };
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
      // Upgrading the ownership proof preserves the ordinary traversal's watermark.
      const firstCursor = (read: (id: string) => string | null | undefined) => {
        for (const id of [connectorId, ...legacyIds]) {
          const cursor = read(id);
          if (cursor) return cursor;
        }
        return undefined;
      };
      const headStoreCursor = firstCursor(id => tierSet.committedCursor(id)?.cursor)
        ?? firstCursor(id => options.secureStore.lastCompletedSyncRun(id)?.cursor);
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

      const outcome = taskOutcome({
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
      return gmailCursorHasBacklog(headCheckpoint) ? { ...outcome, backlog: true } : outcome;
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

    ...(options.build?.children === true ? {
      backfillChildren: async (request: { max_items?: number; provenance?: SourceInvocationProvenance } = {}) => {
        const saved = readChildrenBackfill(tierSet.ledger.setCursor(GMAIL_CHILDREN_BACKFILL_SET, GMAIL_CHILDREN_BACKFILL_CONNECTOR)?.cursor);
        if (saved.done) return { listed: 0, examined: 0, done: true };
        const max = Math.max(1, Math.min(request.max_items ?? GMAIL_CHILDREN_BACKFILL_PER_PASS, GMAIL_CHILDREN_BACKFILL_PER_PASS));
        options.assertScopeCurrent?.();
        const connector = buildConnector({ maxMessages: max, provenance: sourceInvocationProvenance(request.provenance) });
        const client = await connector.apiClientForTooling();
        const children: RawItem[] = [];
        let examined = 0;
        let exhausted = 0;
        let stopped: unknown;
        const stores = [['internal', options.internalStore, options.secureStore], ['secure', options.secureStore, options.internalStore]] as const;
        for (const [name, store, other] of stores) {
          let storeDone = false;
          while (examined < max && stopped === undefined) {
            const rows = store.parentsAwaitingChildren(GMAIL_PROVIDER, GMAIL_ATTACHMENT_LINE, saved[name], max - examined);
            if (rows.length === 0) {
              storeDone = true;
              break;
            }
            for (const row of rows) {
              if (examined >= max || stopped !== undefined) break;
              // Only this account's Gmail messages; a copy whose other store already holds its children is done.
              if (row.accountScope === account && !row.providerItemId.startsWith(GMAIL_OWN_ID_PREFIX) && !other.hasChildRowsOf(row.localItemId)) {
                examined += 1;
                let message;
                try {
                  options.assertScopeCurrent?.();
                  message = await client.getMessage(row.providerItemId);
                  options.assertScopeCurrent?.();
                } catch (error) {
                  // Gone from Gmail: nothing to list. A spent budget, a changed scope or anything else stops the
                  // pass before this message, keeping what it listed so far; the next pass resumes here.
                  if (!(error instanceof Error && /Gmail API request failed \(404\)/.test(error.message))) {
                    stopped = error;
                    break;
                  }
                  saved[name] = row.itemPk;
                  continue;
                }
                if (!options.scope || gmailMessageInScope(message, options.scope)) {
                  const [, ...kids] = gmailMailItems(gmailMailRecordFromMessage(message, { children: true }), account, { children: true });
                  children.push(...kids);
                }
              }
              saved[name] = row.itemPk;
            }
          }
          if (storeDone) exhausted += 1;
          if (stopped !== undefined) break;
        }
        if (children.length > 0) {
          // Stored as the live lane stores them (its own observation, so its approved scope counts them).
          const byId = new Map(children.map((item) => [item.identity.localItemId, item] as const));
          const listing: SourceConnector = {
            id: connectorId,
            family: 'email',
            authenticate: async () => {},
            async *listItems() { yield { items: children, done: true }; },
            fetchItem: async (localItemId) => byId.get(localItemId) ?? Promise.reject(new Error('not listed')),
            classificationSignals: (item) => connector.classificationSignals(item),
          };
          await tierSet.sync(listing, { fetchContent: true, classification, tierClassification }, { commitCursor: false });
        }
        const done = stopped === undefined && exhausted === stores.length;
        tierSet.ledger.commitSetCursor(GMAIL_CHILDREN_BACKFILL_SET, GMAIL_CHILDREN_BACKFILL_CONNECTOR, JSON.stringify({ ...saved, ...(done ? { done: true } : {}) }));
        if (stopped !== undefined) throw stopped;
        return { listed: children.length, examined, done };
      },
    } : {}),
    lastStoreRunCompletedAt: () => latestCompletedAt([
      options.internalStore.lastSyncRun()?.completedAt,
      options.secureStore.lastSyncRun()?.completedAt,
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
  /** Cumulative new observations made by the confirmation walk. */
  confirmed?: number;
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
  return gmailScopeKeys(account, scope).connectorId;
}

function gmailScopeKeys(account: string, scope: { generation: string; revision: string } | undefined) {
  if (!scope) return { connectorId: GMAIL_PROVIDER, setId: GMAIL_PROVIDER, legacyIds: [] as string[], scopeTag: undefined };
  const scopeTag = createHash('sha256')
    .update(`${account}\u0000${scope.generation}\u0000${scope.revision}`)
    .digest('hex')
    .slice(0, 24);
  const setId = GMAIL_SCOPED_CONNECTOR_PREFIX + scopeTag;
  // Both earlier keys could come from an ordinary GET with weaker scope
  // checks. Reuse their progress, but only new observations authorize content.
  return { connectorId: `verified-observation.v2:${setId}`, setId, legacyIds: [`verified-observation.v1:${setId}`, setId], scopeTag };
}

interface DecodedGmailCheckpoint extends GmailCheckpointEnvelope {
  headRejected?: boolean;
}

export function encodeGmailStoreCheckpoint(envelope: GmailCheckpointEnvelope): string | null {
  return encodeCheckpoint(envelope);
}

function encodeCheckpoint(envelope: GmailCheckpointEnvelope): string | null {
  if (!envelope.head && envelope.confirmed === undefined) return null;
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
  let parsed: { head?: unknown; scope?: unknown; confirmed?: unknown };
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
  const confirmation = scopeTag?.startsWith(CONFIRMATION_SCOPE_PREFIX) === true;
  const validHead = head !== undefined && (isGmailConnectorCursor(head) || (confirmation && head === `${scopeTag}:done`));
  return {
    ...(validHead ? { head } : {}),
    ...(head !== undefined && !validHead ? { headRejected: true } : {}),
    ...(confirmation && typeof parsed.confirmed === 'number' && Number.isSafeInteger(parsed.confirmed) && parsed.confirmed >= 0
      ? { confirmed: parsed.confirmed } : {}),
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
  return error instanceof GmailPageTokenRejectedError;
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
