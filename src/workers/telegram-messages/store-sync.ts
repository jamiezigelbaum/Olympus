// Product-owned control plane for Telegram's append-only capture spool.
// Provider/session work remains in the thin Telethon helper; this module only
// advances two trust-separated stores through the shared connector spine.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceItemIdentity } from '../../core/source-index/types.ts';
import { sameSpoolFile, spoolFileIdentity } from '../connector-store/spool-file-identity.ts';
import { openConnectorStore } from '../../core/source-storage.ts';
import type {
  LocalConnectorStore,
  ConnectorStoreSyncSummary,
  ConnectorStoreTrustReconciliationSummary,
} from '../connector-store/index.ts';
import { createLaneTieredStoreSet, type TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import { compareTelegramVersions } from './record-builder.ts';
import { applyTelegramProtectionClaims, telegramClaimKept, telegramProtectedLaneLookup } from './protection-claims.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import type { TierLedger } from '../classification/tier-ledger.ts';
import {
  clearCaptureSpoolSecrets,
  type CaptureSpoolRedactionResult,
} from '../connector-store/capture-spool-secrets.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import {
  captureFreshness,
  captureFreshnessCounts,
  captureStaleThresholdSeconds,
  type CaptureFreshness,
  type CaptureFreshnessCounts,
} from '../connector-store/capture-freshness.ts';
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
  readTelegramCaptureSpoolNewestCapturedAt,
  readTelegramCaptureSpoolNewest,
  readTelegramCaptureHeartbeat,
  redactTelegramCaptureSpoolSecrets,
  telegramCaptureSpoolCursorState,
  type TelegramCaptureSpoolRecord,
} from './capture-spool-connector.ts';

export const TELEGRAM_MESSAGES_SOURCE_ID = 'telegram.messages';
export const TELEGRAM_PERSONAL_ACCOUNT_SCOPE = 'telegram.personal';
export const TELEGRAM_MALFORMED_SPOOL_WARNING = 'telegram_malformed_spool_records';
export const TELEGRAM_TRUST_CONFLICT_WARNING = 'telegram_trust_conflict_items';
export const TELEGRAM_SPOOL_REDACTION_FAILED_WARNING = 'telegram_spool_secret_redaction_failed';
// A lane's cursor no longer named a place in the spool (its file was removed
// while older ones stayed, or the file is shorter than the cursor says), so
// the lane reads the spool again from its start instead of stopping for good.
export const TELEGRAM_SPOOL_CURSOR_RESET_WARNING = 'telegram_spool_cursor_reset';
// The identity of the day file a lane cursor stands in, kept in the set's ledger.
const TELEGRAM_SPOOL_FILE_META_PREFIX = 'telegram:spool_file:';
// Where the full-spool Secrets pass stands, kept in the set's tier ledger.
export const TELEGRAM_SPOOL_REDACTION_STATE_KEY = 'capture_spool_secret_redaction:telegram';
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
    /**
     * Spool records whose item was judged Secrets and that this pull
     * rewrote without their text (blanked ones included).
     */
    spool_records_redacted: number;
    /**
     * Items a protected claim reached whose newest version the spool no longer
     * holds: the tier move took their stored copy into the protected lane.
     */
    trust_claims_moved: number;
    /** Lanes whose cursor named no place in the spool and were read again from its start. */
    spool_cursor_resets: number;
    /**
     * 1 when the capture helper is running (its last cycle is recent) but no
     * message arrived within the threshold: a quiet account, not a stopped
     * capture. The freshness verdict is then fresh.
     */
    capture_quiet: 0 | 1;
  } & CaptureFreshnessCounts;
  /**
   * Whether the live feed is running: a pull can succeed on schedule while
   * the helper has captured nothing for days. The age is from the newer of the
   * spool's newest `captured_at` and the helper's last finished cycle (its
   * heartbeat beside the spool), so a quiet account with a running helper
   * reads fresh and only a stopped capture reads stale. The time itself is
   * not returned.
   */
  capture: CaptureFreshness;
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
  const account = { sourceId: TELEGRAM_MESSAGES_SOURCE_ID };
  return {
    internal: openConnectorStore(account, {
      dbPath: defaultInternalTelegramConnectorStoreDbPath(env),
      corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'internal',
    }, env),
    secureLocal: openConnectorStore(account, {
      dbPath: defaultProtectedTelegramConnectorStoreDbPath(env),
      corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'secure_local',
    }, env),
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
  /** Test seam: the tier move that takes a claimed item's stored copy into the protected lane. */
  moveClaimed?: Parameters<typeof applyTelegramProtectionClaims>[0]['move'];
  /** Seconds of silence after which the feed reads stale. Defaults to the helper's own threshold. */
  spoolStaleThresholdSeconds?: number;
  now?: () => Date;
  /** The lanes' per-tier stores. Omitted: a set over the two stores, kept whole per message. */
  tierSet?: TieredStoreSet;
  secretLocations?: SecretLocationsIndex;
  /** The runtime's live Private embedder, told to the set so the Private-row re-home pass knows whether it is local. */
  privateEmbedder?: SourceEmbeddingProvider;
}): TelegramConnectorStoreSyncHandler {
  const env = options.env ?? process.env;
  const spoolDir = options.spoolDir?.trim() || defaultTelegramCaptureSpoolDir(env);
  const staleThresholdSeconds = captureStaleThresholdSeconds(
    options.spoolStaleThresholdSeconds,
    env.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_STALE_THRESHOLD_SECONDS,
    'Telegram',
  );
  const now = options.now ?? (() => new Date());
  const tierSet = options.tierSet ?? createLaneTieredStoreSet({
    setId: TELEGRAM_MESSAGES_SOURCE_ID,
    internalStore: options.stores.internal,
    secureStore: options.stores.secureLocal,
    splitLayers: false,
    ...(options.secretLocations ? { secretLocations: options.secretLocations } : {}),
  });
  // What the stores hold of an item, for the connector's intake: a record older than the stored version
  // (a cursor read again from the start, a queued record behind a later edit) is never applied.
  const storedItem = (identity: Parameters<TieredStoreSet['storedItem']>[0], compareVersions: (a: string, b: string) => number) =>
    tierSet.storedItem(identity, compareVersions);
  if (options.privateEmbedder) tierSet.declarePrivateEmbedder(options.privateEmbedder);

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

      // A cursor that names no place in the spool any more is dropped here,
      // so both the preflight and its lane read from the start instead of
      // every later pull failing on it. Reading again is safe: the lanes'
      // intake never applies a record older than the version stored.
      let cursorResets = 0;
      // A cursor is also bound to the identity its file had when the lane read it (spool-file-identity.ts):
      // a day file removed and written again under the same name is another file, read from its start.
      const placed = (cursor: string | undefined): string | undefined => {
        if (!cursor) return cursor;
        const file = cursor.slice(0, cursor.lastIndexOf(':'));
        const recorded = tierSet.ledger.readMeta(`${TELEGRAM_SPOOL_FILE_META_PREFIX}${file}`);
        const sameFile = recorded === undefined || !existsSync(join(spoolDir, file)) || sameSpoolFile(recorded, join(spoolDir, file));
        if (sameFile && telegramCaptureSpoolCursorState(spoolDir, cursor) === 'ok') return cursor;
        cursorResets += 1;
        return undefined;
      };
      const cursors = {
        internal: placed(sanitizeTelegramCaptureCursor(
          options.stores.internal.lastCompletedSyncRun(TELEGRAM_CAPTURE_CONNECTOR_IDS.internal)?.cursor,
        )),
        secureLocal: placed(sanitizeTelegramCaptureCursor(
          options.stores.secureLocal.lastCompletedSyncRun(TELEGRAM_CAPTURE_CONNECTOR_IDS.secure_local)?.cursor,
        )),
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
      const claims = resolveTelegramTrustClaims(preflight.records, preflight.trustConflicts, options.stores, tierSet);
      const resolved = claims.resolvedTrustByItemId.size > 0
        ? { resolvedTrustByItemId: claims.resolvedTrustByItemId }
        : {};

      // Before either lane writes, every claimed item leaves the ordinary
      // lane, fail-closed (protection-claims.ts): its newest version goes
      // into the protected lane (carried from the spool, or the stored copy
      // moved by the tier move, hidden first), and the claim is kept. A step
      // that fails throws, so neither lane's cursor passes the claim.
      const protection = await applyTelegramProtectionClaims({
        set: tierSet,
        internal: options.stores.internal,
        spoolDir,
        claims: claims.secureClaims,
        newestKnown: claims.moveWhole,
        ...(options.moveClaimed ? { move: options.moveClaimed } : {}),
      });
      const eviction = { relinquishedLocalItemIds: protection.relinquished, counts: { itemsRelinquished: protection.relinquished.length } };
      const conflictedItemIds = new Set(claims.resolvedTrustByItemId.keys());
      for (const localItemId of eviction.relinquishedLocalItemIds) conflictedItemIds.add(localItemId);
      // Sweep evictions are the same disagreement discovered later, so they
      // land in the same receipt counts as the window's own.
      for (const localItemId of reconciliation.relinquishedLocalItemIds) conflictedItemIds.add(localItemId);

      // Both lanes run through the shared tier set, each with its own spool
      // connector and cursor. A NEW message is routed by its recorded tiers
      // (kept whole: a chat message is not split); one whose content is more
      // private than its chat's lane is written to the secure lane inline,
      // before the listing lane's page commits. Every existing message keeps
      // the lane placement below.
      const run = await tierSet.syncLegs([
        {
          trustDomain: 'internal',
          connector: createTelegramCaptureSpoolConnector({
            spoolDir,
            trustDomain: 'internal',
            admitThroughCursor,
            storedItem,
            ...resolved,
          }),
          sync: {
            placement: { trustTier: 'S3', trustDomain: 'internal' },
            ...(cursors.internal ? { cursor: cursors.internal } : {}),
            maxItems,
            fetchContent: true,
            deferMetadataOnlyContent: true,
          },
        },
        {
          trustDomain: 'secure_local',
          connector: createTelegramCaptureSpoolConnector({
            spoolDir,
            trustDomain: 'secure_local',
            admitThroughCursor,
            // A claimed record is judged against what the protected lane holds, never kept out by an ordinary copy.
            storedItem: telegramProtectedLaneLookup(tierSet, new Set(claims.secureClaims.map((identity) => identity.localItemId))),
            ...(protection.carried.length > 0 ? { carried: protection.carried } : {}),
            ...resolved,
          }),
          sync: {
            placement: { trustTier: 'S4', trustDomain: 'secure_local' },
            ...(cursors.secureLocal ? { cursor: cursors.secureLocal } : {}),
            maxItems,
            fetchContent: true,
            deferMetadataOnlyContent: true,
          },
        },
      ]);
      const internal = run.byDomain.internal!.sync;
      const secureLocal = run.byDomain.secure_local!.sync;
      // The files the lanes' cursors stand in now, with the identity each has: what the next pull binds them to.
      for (const cursor of [lanesReadThrough(options.stores), sanitizeTelegramCaptureCursor(
        options.stores.internal.lastCompletedSyncRun(TELEGRAM_CAPTURE_CONNECTOR_IDS.internal)?.cursor,
      ), sanitizeTelegramCaptureCursor(
        options.stores.secureLocal.lastCompletedSyncRun(TELEGRAM_CAPTURE_CONNECTOR_IDS.secure_local)?.cursor,
      )]) {
        if (!cursor) continue;
        const file = cursor.slice(0, cursor.lastIndexOf(':'));
        const identity = spoolFileIdentity(join(spoolDir, file))?.identity;
        const key = `${TELEGRAM_SPOOL_FILE_META_PREFIX}${file}`;
        if (identity && tierSet.ledger.readMeta(key) !== identity) tierSet.ledger.writeMeta(key, identity);
      }

      // Every record both lanes have now read has been judged. Any whose
      // item is Secrets loses its text from the spool here, and a whole-spool
      // pass runs when the set of Secrets changed (an owner marking an old
      // message, a chat rule). The stores already hold none of it, so a
      // failure here costs ingestion nothing: it is reported and retried on
      // the next pull, where the same records are judged again.
      let redacted: CaptureSpoolRedactionResult | undefined;
      let redactionFailed = false;
      try {
        redacted = clearTelegramSpoolSecrets({
          spoolDir,
          ledger: tierSet.ledger,
          ...(preflightCursor ? { from: preflightCursor } : {}),
          through: lanesReadThrough(options.stores),
        });
      } catch (error) {
        redactionFailed = true;
        console.error(
          `[olympus:telegram] spool_secret_redaction_failed reason=${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
      return telegramSyncReceipt(
        internal,
        secureLocal,
        preflight.malformedRecords,
        conflictedItemIds.size,
        eviction.counts.itemsRelinquished + reconciliation.itemsRelinquished,
        redacted,
        redactionFailed,
        cursorResets,
        protection.moved,
        telegramCaptureLiveness(
          readTelegramCaptureSpoolNewestCapturedAt(spoolDir),
          readTelegramCaptureHeartbeat(spoolDir),
          now().getTime(),
          staleThresholdSeconds,
        ),
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

/**
 * Clear the Secrets out of the spool records both lanes have read
 * (connector-store/capture-spool-secrets.ts). An earlier version of an edited
 * message is judged on its own text.
 */
export function clearTelegramSpoolSecrets(options: {
  spoolDir: string;
  ledger: TierLedger;
  from?: string;
  through: string | undefined;
}): CaptureSpoolRedactionResult {
  return clearCaptureSpoolSecrets({
    ledger: options.ledger,
    stateKey: TELEGRAM_SPOOL_REDACTION_STATE_KEY,
    ...(options.from ? { from: options.from } : {}),
    through: options.through,
    redact: (window, judge) => redactTelegramCaptureSpoolSecrets({ spoolDir: options.spoolDir, ...window, judge }),
  });
}

/**
 * The spool position both lanes have read up to: every record before it was
 * listed by its own lane and judged.
 */
function lanesReadThrough(stores: TelegramConnectorStores): string | undefined {
  const internal = sanitizeTelegramCaptureCursor(
    stores.internal.lastCompletedSyncRun(TELEGRAM_CAPTURE_CONNECTOR_IDS.internal)?.cursor,
  );
  const secureLocal = sanitizeTelegramCaptureCursor(
    stores.secureLocal.lastCompletedSyncRun(TELEGRAM_CAPTURE_CONNECTOR_IDS.secure_local)?.cursor,
  );
  return internal && secureLocal ? earlierCursor(internal, secureLocal) : undefined;
}

/**
 * The live feed's verdict from its newest record and the helper's heartbeat:
 * the age is from the newer of the two, and the feed is quiet when the
 * heartbeat is fresh but no record is (or there is none). A heartbeat from
 * the future (a clock moved back) is not believed.
 */
export function telegramCaptureLiveness(
  newestRecordAt: string | undefined,
  heartbeatAt: string | undefined,
  nowMs: number,
  thresholdSeconds: number,
): CaptureFreshness & { quiet: boolean } {
  const heartbeatMs = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  const believable = Number.isFinite(heartbeatMs) && heartbeatMs <= nowMs + 60_000 ? heartbeatAt : undefined;
  const record = captureFreshness(newestRecordAt, nowMs, thresholdSeconds);
  const heartbeat = captureFreshness(believable, nowMs, thresholdSeconds);
  const newest = [record, heartbeat]
    .filter((verdict) => verdict.age_seconds !== undefined)
    .sort((a, b) => a.age_seconds! - b.age_seconds!)[0] ?? record;
  return { ...newest, quiet: heartbeat.status === 'fresh' && record.status !== 'fresh' };
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
  /**
   * Claimed items with a version newer than the claim's own record somewhere
   * (the internal copy, a looser record of this window): they move whole.
   */
  moveWhole: Map<string, string | undefined>;
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
  set: TieredStoreSet,
): TelegramTrustClaims {
  const resolvedTrustByItemId = new Map(spoolConflicts);
  // Deduplicated by identity: an edited message has several records in one
  // window and must not be probed, evicted or counted more than once.
  const secureClaims = new Map<string, SourceItemIdentity>();
  // localItemId -> the newest version known to exist, which the move must carry.
  const moveWhole = new Map<string, string | undefined>();
  const newer = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && b !== undefined && compareTelegramVersions(a, b) > 0;
  for (const record of records) {
    const identity = record.capturedItem.item.identity;
    // The spool read already collapsed each identity to its winning reading,
    // so a record still carrying `secure_local` here IS the secure lane's claim.
    if (record.capturedItem.trustDomain === 'secure_local') {
      secureClaims.set(identity.localItemId, identity);
      const internal = stores.internal.storedItemState(identity);
      // A looser record of this window was set aside by the read; the spool says which is newest.
      if (internal && !internal.tombstoned && newer(internal.version, identity.sourceVersion)) {
        moveWhole.set(identity.localItemId, internal.version);
      } else if (spoolConflicts.has(identity.localItemId)) {
        moveWhole.set(identity.localItemId, identity.sourceVersion);
      }
      continue;
    }
    // The secure lane's own row, or a claim kept from a record already read past: the item is protected.
    const claimed = telegramClaimKept(set, identity.localItemId);
    if (!claimed && !stores.secureLocal.itemPresence(identity).active) continue;
    resolvedTrustByItemId.set(identity.localItemId, 'secure_local');
    secureClaims.set(identity.localItemId, identity);
    // This looser record is newer than the claimed copy: it is the version that moves.
    if (newer(identity.sourceVersion, stores.secureLocal.storedItemState(identity)?.version)) moveWhole.set(identity.localItemId, identity.sourceVersion);
  }
  return { resolvedTrustByItemId, secureClaims: [...secureClaims.values()], moveWhole };
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
  redacted: CaptureSpoolRedactionResult | undefined,
  redactionFailed: boolean,
  cursorResets: number,
  trustClaimsMoved: number,
  liveness: CaptureFreshness & { quiet: boolean },
): TelegramConnectorStoreSyncReceipt {
  const { quiet, ...capture } = liveness;
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
    spool_records_redacted: (redacted?.recordsRedacted ?? 0) + (redacted?.recordsBlanked ?? 0),
    spool_cursor_resets: cursorResets,
    trust_claims_moved: trustClaimsMoved,
    capture_quiet: quiet ? 1 as const : 0 as const,
    ...captureFreshnessCounts(capture),
  };
  const warnings = [
    ...(malformedRecords > 0 ? [TELEGRAM_MALFORMED_SPOOL_WARNING] : []),
    ...(trustConflictItems > 0 ? [TELEGRAM_TRUST_CONFLICT_WARNING] : []),
    ...(redactionFailed ? [TELEGRAM_SPOOL_REDACTION_FAILED_WARNING] : []),
    ...(cursorResets > 0 ? [TELEGRAM_SPOOL_CURSOR_RESET_WARNING] : []),
  ];
  return {
    status: counts.items_changed > 0 || counts.items_tombstoned > 0 ? 'progress' : 'idle',
    counts,
    capture,
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
