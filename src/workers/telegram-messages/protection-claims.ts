// The protected lane's claim on a Telegram message, applied fail-closed.
//
// A chat whose capture moved to the protected (secure-local) lane claims every
// message of it: the claim is the item's, whatever the version of the record
// that brought it. Before either lane writes, each claimed message the
// ordinary (internal) lane still holds is taken out of it, in this order:
//
//   1. Hide and move. When the spool still has the item's newest version, the
//      ordinary copy is given up and that version is carried into the
//      protected lane. When it does not, the stored copy moves through the tier
//      move, which supersedes the lower copy first (hidden from every read at
//      once) and copies the stored content up. A copy that cannot move (one
//      written before tier routing) is given up instead.
//   2. Keep the claim, in the set's ledger, so a later ordinary record of the
//      item is never admitted to the ordinary lane.
//
// Any step that fails throws: the pull stops before either lane's cursor
// moves, so the claim's own record is read again by the next pull and the
// steps run again. Nothing is counted as done that is not.
//
// The protected lane then always takes a claimed record that is newer than
// what IT holds: its intake is judged against the protected store alone, so a
// hidden ordinary copy, or one a failed write left behind, never keeps a
// claimed record out of the lane.

import type { StoredItemLookup, StoredItemState } from '../../core/contracts.ts';
import type { SourceItemIdentity } from '../../core/source-index/types.ts';
import { moveTieredItem } from '../connector-store/tier-move.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import {
  TELEGRAM_CAPTURE_CONNECTOR_IDS,
  TELEGRAM_TRUST_EVICTION_CONNECTOR_ID,
  readTelegramCaptureSpoolNewest,
  type TelegramCaptureSpoolRecord,
} from './capture-spool-connector.ts';
import { compareTelegramVersions } from './record-builder.ts';

const CLAIM_META_PREFIX = 'telegram:secure_claim:';

/** Whether the protected lane's claim on an item was kept from a record already read past. */
export function telegramClaimKept(set: TieredStoreSet, localItemId: string): boolean {
  return set.ledger.readMeta(`${CLAIM_META_PREFIX}${localItemId}`) === '1';
}

export interface TelegramProtectionClaimsResult {
  /** The newest version of each claimed item the spool holds, to list in the protected lane ahead of its own records. */
  carried: TelegramCaptureSpoolRecord[];
  /** Ordinary copies whose stored content the tier move took into the protected lane. */
  moved: number;
  /** Ordinary copies given up (their newest version is carried, or they could not move). */
  relinquished: string[];
}

/**
 * Takes every claimed item out of the ordinary lane and keeps the claims.
 * `newestKnown` is, per claimed item, the newest version known to exist (an
 * ordinary copy's, or a looser record's), when it is newer than the claim's.
 */
export async function applyTelegramProtectionClaims(args: {
  set: TieredStoreSet;
  internal: LocalConnectorStore;
  spoolDir: string;
  claims: readonly SourceItemIdentity[];
  newestKnown: ReadonlyMap<string, string | undefined>;
  /** Test seam: the tier move. */
  move?: typeof moveTieredItem;
}): Promise<TelegramProtectionClaimsResult> {
  const result: TelegramProtectionClaimsResult = { carried: [], moved: 0, relinquished: [] };
  const readable = (identity: SourceItemIdentity): boolean => readableInOrdinaryLane(args.set, args.internal, identity);
  const held = args.claims.filter(readable);
  const ids = new Set([...args.newestKnown.keys(), ...held.map((identity) => identity.localItemId)]);
  const newest = ids.size > 0
    ? readTelegramCaptureSpoolNewest({ spoolDir: args.spoolDir, localItemIds: ids, compareVersions: compareTelegramVersions, asTrust: 'secure_local' })
    : new Map<string, TelegramCaptureSpoolRecord>();
  const giveUp: SourceItemIdentity[] = [];
  for (const identity of args.claims) {
    const known = args.newestKnown.get(identity.localItemId)
      ?? args.internal.storedItemState(identity)?.version;
    const found = newest.get(identity.localItemId);
    const foundVersion = found?.capturedItem.item.identity.sourceVersion;
    const spoolHasNewest = found !== undefined && (known === undefined || foundVersion === undefined || compareTelegramVersions(foundVersion, known) >= 0);
    if (spoolHasNewest) result.carried.push(found!);
    if (!held.includes(identity)) continue;
    if (spoolHasNewest) {
      giveUp.push(identity);
      continue;
    }
    // The spool no longer has the newest version: the stored copy moves, hidden first.
    try {
      await (args.move ?? moveTieredItem)({ set: args.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
      result.moved += 1;
    } catch {
      giveUp.push(identity);
    }
  }
  if (giveUp.length > 0) {
    const eviction = args.internal.relinquishItems({
      identities: giveUp,
      syncConnectorId: TELEGRAM_TRUST_EVICTION_CONNECTOR_ID,
      ownerConnectorId: TELEGRAM_CAPTURE_CONNECTOR_IDS.internal,
      ownershipKind: 'observed',
      // The removed row records the reading that won, not the lane it sat in.
      trustTier: 'S4',
    });
    result.relinquished.push(...eviction.relinquishedLocalItemIds);
    // A copy the store still serves after giving it up is a failure, never a silent pass.
    const still = giveUp.filter(readable);
    if (still.length > 0) throw new Error('Telegram could not take a protected message out of the ordinary lane.');
  }
  // The claim is kept once its item is out of the ordinary lane.
  for (const identity of args.claims) {
    if (!telegramClaimKept(args.set, identity.localItemId)) args.set.ledger.writeMeta(`${CLAIM_META_PREFIX}${identity.localItemId}`, '1');
  }
  return result;
}

/**
 * Whether a read of the ordinary lane would serve the item: its row is active
 * and, for a routed item, the ledger names its copy there as current (a copy
 * the tier move superseded is hidden from every read already).
 */
function readableInOrdinaryLane(set: TieredStoreSet, internal: LocalConnectorStore, identity: SourceItemIdentity): boolean {
  if (!internal.itemPresence(identity).active) return false;
  const copies = set.ledger.copies(identity);
  if (copies.length === 0) return true;
  return copies.some((copy) => copy.corpusId === internal.corpusId && copy.state === 'current');
}

/**
 * The intake lookup of the protected lane: what the protected store alone
 * holds of a claimed item (every other item is looked up across the set).
 */
export function telegramProtectedLaneLookup(
  set: TieredStoreSet,
  claimed: ReadonlySet<string>,
): StoredItemLookup {
  return (identity, compareVersions) => {
    const localItemId = `${identity.accountScope}:${identity.providerConversationId ?? ''}:${identity.providerItemId}`;
    if (!claimed.has(localItemId)) return set.storedItem(identity, compareVersions);
    const state = set.store('secure_local')?.storedItemState(identity);
    if (!state) return undefined;
    const stored: StoredItemState = {
      ...(state.version !== undefined ? { version: state.version } : {}),
      hasContent: state.chunkCount > 0,
      ...(state.tombstoned ? { tombstoned: true as const } : {}),
    };
    return stored;
  };
}
