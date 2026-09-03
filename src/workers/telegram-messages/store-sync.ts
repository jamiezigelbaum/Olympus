// Product-owned control plane for Telegram's append-only capture spool.
// Provider/session work remains in the thin Telethon helper; this module only
// advances two trust-separated stores through the shared connector spine.

import type { SourceItemIdentity } from '../../core/source-index/types.ts';
import {
  LocalConnectorStore,
  type ConnectorStoreSyncSummary,
  type ConnectorStoreTrustReconciliationSummary,
} from '../connector-store/index.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  type TelegramMessagesCorpusTrustDomain,
  defaultInternalTelegramConnectorStoreDbPath,
  defaultProtectedTelegramConnectorStoreDbPath,
} from './corpus-adapter.ts';
import {
  TELEGRAM_CAPTURE_CONNECTOR_IDS,
  TELEGRAM_TRUST_EVICTION_CONNECTOR_ID,
  TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID,
  createTelegramCaptureSpoolConnector,
  defaultTelegramCaptureSpoolDir,
  readTelegramCaptureSpool,
  type TelegramCaptureSpoolRecord,
} from './capture-spool-connector.ts';

export const TELEGRAM_MESSAGES_SOURCE_ID = 'telegram.messages';
export const TELEGRAM_PERSONAL_ACCOUNT_SCOPE = 'telegram.personal';
export const TELEGRAM_MALFORMED_SPOOL_WARNING = 'telegram_malformed_spool_records';
export const TELEGRAM_TRUST_CONFLICT_WARNING = 'telegram_trust_conflict_items';
export const DEFAULT_TELEGRAM_PULL_MAX_ITEMS = 500;
const MAX_TELEGRAM_PULL_MAX_ITEMS = 10_000;

export interface TelegramConnectorStores {
  internal: LocalConnectorStore;
  secureLocal: LocalConnectorStore;
}

export interface TelegramConnectorStoreSyncReceipt {
  status: 'progress' | 'idle';
  counts: {
    items_seen: number;
    items_indexed: number;
    items_changed: number;
    items_tombstoned: number;
    items_rejected: number;
    items_metadata_only: number;
    chunks_indexed: number;
    malformed_spool_records: number;
    /**
     * Identities whose trust readings disagreed and were resolved to the
     * restrictive lane. Counts disagreements found inside one scan window AND
     * disagreements only the stores can see, where the two readings are in
     * different windows.
     */
    trust_conflict_items: number;
    /**
     * Copies the internal lane had already indexed and gave up because the
     * secure-local lane claimed the same identity. A subset of
     * `trust_conflict_items`: the ones that had already become readable in the
     * looser lane before the disagreement surfaced.
     */
    trust_conflict_evictions: number;
  };
  warnings?: string[];
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    provider_cursor_exposed: false;
    local_only: true;
  };
}

export interface TelegramConnectorStoreSyncHandler {
  pull(request?: { max_items?: number }): Promise<TelegramConnectorStoreSyncReceipt>;
  lastStoreRunCompletedAt(): string | undefined;
}

export function createTelegramConnectorStores(
  env: Record<string, string | undefined> = process.env,
): TelegramConnectorStores {
  return {
    internal: new LocalConnectorStore({
      dbPath: defaultInternalTelegramConnectorStoreDbPath(env),
      corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'internal',
    }),
    secureLocal: new LocalConnectorStore({
      dbPath: defaultProtectedTelegramConnectorStoreDbPath(env),
      corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'secure_local',
    }),
  };
}

export function sanitizeTelegramCaptureCursor(cursor: string | undefined): string | undefined {
  return cursor && /^\d{4}-\d{2}-\d{2}\.jsonl:[0-9]+$/.test(cursor) ? cursor : undefined;
}

/**
 * One bounded advance of the one-time sweep over duplication that PREDATES the
 * trust invariant: every identity the secure-local store actively holds gives
 * up its internal-lane copy. The running invariant in `pull` already keeps new
 * disagreements out, but it deliberately consults the stores only for records
 * in the current window — a pre-existing duplicate has both records behind
 * both cursors and no window will ever mention it again. Once the sweep's
 * durable marker reads complete, a call costs one run lookup and writes
 * nothing, so `pull` runs it unconditionally and the operator script can
 * drain it ahead of the schedule.
 */
export function reconcileTelegramTrustStores(
  stores: TelegramConnectorStores,
  options: { maxItems?: number; maxWindows?: number } = {},
): ConnectorStoreTrustReconciliationSummary {
  return stores.internal.reconcileAgainstStricterStore({
    stricter: stores.secureLocal,
    reconcileConnectorId: TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID,
    evictionSyncConnectorId: TELEGRAM_TRUST_EVICTION_CONNECTOR_ID,
    ownerConnectorId: TELEGRAM_CAPTURE_CONNECTOR_IDS.internal,
    ownershipKind: 'observed',
    // Same reasoning as the inline eviction: the removed row records the
    // reading that won, not the lane it sat in.
    trustTier: 'S4',
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
    ...(options.maxWindows !== undefined ? { maxWindows: options.maxWindows } : {}),
  });
}

export function createTelegramConnectorStoreSyncHandler(options: {
  stores: TelegramConnectorStores;
  spoolDir?: string;
  maxItems?: number;
  env?: Record<string, string | undefined>;
  /** Per-pull window bounds for the one-time reconciliation sweep. */
  reconciliation?: { maxItems?: number; maxWindows?: number };
  /** Test seam for proving the preflight receives the same bounded window. */
  preflightRead?: typeof readTelegramCaptureSpool;
}): TelegramConnectorStoreSyncHandler {
  const env = options.env ?? process.env;
  const spoolDir = options.spoolDir?.trim() || defaultTelegramCaptureSpoolDir(env);

  return {
    async pull(request = {}): Promise<TelegramConnectorStoreSyncReceipt> {
      const maxItems = telegramPullMaxItems(request.max_items ?? options.maxItems);
      // Heal pre-invariant duplication first, bounded, so this pull's receipt
      // carries the evictions and the stores it hands the window resolution
      // are already one-lane wherever the sweep has reached.
      const reconciliation = reconcileTelegramTrustStores(
        options.stores,
        options.reconciliation ?? {},
      );

      const cursors = {
        internal: sanitizeTelegramCaptureCursor(
          options.stores.internal.lastCompletedSyncRun(TELEGRAM_CAPTURE_CONNECTOR_IDS.internal)?.cursor,
        ),
        secureLocal: sanitizeTelegramCaptureCursor(
          options.stores.secureLocal.lastCompletedSyncRun(TELEGRAM_CAPTURE_CONNECTOR_IDS.secure_local)?.cursor,
        ),
      };

      // Validate the next bounded unread window before either trust lane writes.
      // If one lane has no trustworthy cursor, scan from the beginning: local
      // upserts are idempotent, while importing an unrelated replay cursor
      // could permanently skip preserved capture history.
      const preflightCursor = cursors.internal && cursors.secureLocal
        ? earlierCursor(cursors.internal, cursors.secureLocal)
        : undefined;
      const preflight = (options.preflightRead ?? readTelegramCaptureSpool)({
        spoolDir,
        malformedPolicy: 'skip',
        limit: maxItems,
        ...(preflightCursor ? { cursor: preflightCursor } : {}),
      });

      // The preflight sees the same bounded window the lane pages may consume.
      // Handing both lanes the same resolution is what keeps a reclassified
      // message in exactly one store once that claim reaches the window.
      //
      // A window is still not enough on its own. Once the internal lane has
      // indexed a message, the reclassified record the helper appends later is
      // in a window that no longer contains the internal one, so widening the
      // scan can never prove the two readings disagree — the evidence is the
      // stored copy, not the spool. Resolve against the stores as well, and
      // the invariant becomes enforceable: an identity lives in exactly one
      // lane, the most restrictive one ever claimed for it.
      //
      // The spool is appended to while this pull runs, and each lane reads it
      // again after this resolution. What the resolution covered ends at the
      // preflight's own position, so that position is also the furthest either
      // lane may read: a record appended past it has been resolved against
      // nothing, and admitting it is how both lanes come to hold one identity
      // with no conflicting record left in any later window to say so.
      // Deferring costs one pull — the next preflight starts exactly here,
      // sees the record, and resolves it against both stores.
      const admitThroughCursor = preflight.resumeCursor ?? null;
      const claims = resolveTelegramTrustClaims(preflight.records, preflight.trustConflicts, options.stores);
      const resolved = claims.resolvedTrustByItemId.size > 0
        ? { resolvedTrustByItemId: claims.resolvedTrustByItemId }
        : {};

      // Before either lane writes: content may only move INTO the stricter
      // lane, so the looser copy goes first. The window's claims are given up
      // whole even when a max-items budget will not carry the secure lane
      // across all of them in this run. The residue of doing it in that order
      // is a message briefly in NO lane, which is the safe half of the trade;
      // the residue of the other order is a message readable in the looser
      // lane until some future run happens to complete. Either way the secure
      // lane's cursor has not passed its record, so a later pull indexes it.
      const eviction = options.stores.internal.relinquishItems({
        identities: claims.secureClaims,
        syncConnectorId: TELEGRAM_TRUST_EVICTION_CONNECTOR_ID,
        ownerConnectorId: TELEGRAM_CAPTURE_CONNECTOR_IDS.internal,
        ownershipKind: 'observed',
        // The removed row records the reading that won, not the lane it sat in.
        trustTier: 'S4',
      });
      const conflictedItemIds = new Set(claims.resolvedTrustByItemId.keys());
      for (const localItemId of eviction.relinquishedLocalItemIds) conflictedItemIds.add(localItemId);
      // Sweep evictions are the same disagreement discovered later, so they
      // land in the same receipt counts as the window's own.
      for (const localItemId of reconciliation.relinquishedLocalItemIds) conflictedItemIds.add(localItemId);

      const internal = await options.stores.internal.syncFromConnector(
        createTelegramCaptureSpoolConnector({
          spoolDir,
          trustDomain: 'internal',
          admitThroughCursor,
          ...resolved,
        }),
        {
          ...(cursors.internal ? { cursor: cursors.internal } : {}),
          maxItems,
          fetchContent: true,
          deferMetadataOnlyContent: true,
        },
      );
      const secureLocal = await options.stores.secureLocal.syncFromConnector(
        createTelegramCaptureSpoolConnector({
          spoolDir,
          trustDomain: 'secure_local',
          admitThroughCursor,
          ...resolved,
        }),
        {
          ...(cursors.secureLocal ? { cursor: cursors.secureLocal } : {}),
          maxItems,
          fetchContent: true,
          deferMetadataOnlyContent: true,
        },
      );
      return telegramSyncReceipt(
        internal,
        secureLocal,
        preflight.malformedRecords,
        conflictedItemIds.size,
        eviction.counts.itemsRelinquished + reconciliation.itemsRelinquished,
      );
    },

    lastStoreRunCompletedAt(): string | undefined {
      const internal = options.stores.internal.lastCompletedSyncRun(
        TELEGRAM_CAPTURE_CONNECTOR_IDS.internal,
      )?.completedAt;
      const secureLocal = options.stores.secureLocal.lastCompletedSyncRun(
        TELEGRAM_CAPTURE_CONNECTOR_IDS.secure_local,
      )?.completedAt;
      if (!internal || !secureLocal) return undefined;
      return internal < secureLocal ? internal : secureLocal;
    },
  };
}

export function telegramPullMaxItems(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TELEGRAM_PULL_MAX_ITEMS;
  return Math.max(1, Math.min(MAX_TELEGRAM_PULL_MAX_ITEMS, Math.trunc(value)));
}

interface TelegramTrustClaims {
  /**
   * localItemId -> the one lane a disagreement resolved to. Passed to both
   * lane connectors so neither writes a copy the other owns.
   */
  resolvedTrustByItemId: Map<string, TelegramMessagesCorpusTrustDomain>;
  /** Identities the secure-local lane claims, whatever the internal lane holds. */
  secureClaims: SourceItemIdentity[];
}

/**
 * Fold what this window says about trust together with what the stores already
 * hold. The window alone decides only the disagreements whose two records both
 * fall inside it; the stores decide the rest, in both directions:
 *
 * - a secure-local record here for an identity the internal lane already
 *   indexed — the reclassification case, resolved by evicting that copy;
 * - an internal record here for an identity the secure lane already holds —
 *   the mirror, resolved by refusing to admit the looser copy at all.
 *
 * One indexed lookup per record in the window, which in steady state is a
 * handful and on a first backfill is one cheap probe per message.
 */
function resolveTelegramTrustClaims(
  records: readonly TelegramCaptureSpoolRecord[],
  spoolConflicts: ReadonlyMap<string, TelegramMessagesCorpusTrustDomain>,
  stores: TelegramConnectorStores,
): TelegramTrustClaims {
  const resolvedTrustByItemId = new Map(spoolConflicts);
  // Deduplicated by identity: an edited message has several records in one
  // window and must not be probed, evicted or counted more than once.
  const secureClaims = new Map<string, SourceItemIdentity>();
  for (const record of records) {
    const identity = record.capturedItem.item.identity;
    // The spool read already collapsed each identity to its winning reading,
    // so a record still carrying `secure_local` here IS the secure lane's claim.
    if (record.capturedItem.trustDomain === 'secure_local') {
      secureClaims.set(identity.localItemId, identity);
      continue;
    }
    if (!stores.secureLocal.itemPresence(identity).active) continue;
    resolvedTrustByItemId.set(identity.localItemId, 'secure_local');
    secureClaims.set(identity.localItemId, identity);
  }
  return { resolvedTrustByItemId, secureClaims: [...secureClaims.values()] };
}

function earlierCursor(left: string, right: string): string {
  const [leftFile, leftLine] = cursorParts(left);
  const [rightFile, rightLine] = cursorParts(right);
  if (leftFile !== rightFile) return leftFile < rightFile ? left : right;
  return leftLine <= rightLine ? left : right;
}

function cursorParts(cursor: string): [string, number] {
  const separator = cursor.lastIndexOf(':');
  return [cursor.slice(0, separator), Number(cursor.slice(separator + 1))];
}

function telegramSyncReceipt(
  internal: ConnectorStoreSyncSummary,
  secureLocal: ConnectorStoreSyncSummary,
  malformedRecords: number,
  trustConflictItems: number,
  trustConflictEvictions: number,
): TelegramConnectorStoreSyncReceipt {
  const runs = [internal, secureLocal];
  const counts = {
    items_seen: sum(runs, 'itemsSeen'),
    items_indexed: sum(runs, 'itemsIndexed'),
    items_changed: sum(runs, 'itemsChanged'),
    // The eviction is a removal this pull performed, so it belongs in the
    // tombstone count an operator reads; the lane runs cannot report it
    // because neither lane's traversal is what removed the row.
    items_tombstoned: sum(runs, 'itemsTombstoned') + trustConflictEvictions,
    items_rejected: sum(runs, 'itemsRejected'),
    items_metadata_only: sum(runs, 'itemsMetadataOnly'),
    chunks_indexed: sum(runs, 'chunksIndexed'),
    malformed_spool_records: malformedRecords,
    trust_conflict_items: trustConflictItems,
    trust_conflict_evictions: trustConflictEvictions,
  };
  const warnings = [
    ...(malformedRecords > 0 ? [TELEGRAM_MALFORMED_SPOOL_WARNING] : []),
    ...(trustConflictItems > 0 ? [TELEGRAM_TRUST_CONFLICT_WARNING] : []),
  ];
  return {
    status: counts.items_changed > 0 || counts.items_tombstoned > 0 ? 'progress' : 'idle',
    counts,
    ...(warnings.length > 0 ? { warnings } : {}),
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      provider_cursor_exposed: false,
      local_only: true,
    },
  };
}

function sum(
  runs: readonly ConnectorStoreSyncSummary[],
  key: keyof ConnectorStoreSyncSummary,
): number {
  return runs.reduce((total, run) => total + Number(run[key]), 0);
}
