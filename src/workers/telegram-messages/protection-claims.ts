// The protected lane's claim on a Telegram message, applied fail-closed.
//
// A chat whose capture moved to the protected (secure-local) lane claims every
// message of it: the claim is the item's, whatever the version of the record
// that brought it. Before either lane writes, each claimed message the
// ordinary (internal) lane still holds is taken out of it, in this order:
//
//   1. Move. The ordinary copy moves into the protected lane with one tier
//      move: the lower copy is superseded first (hidden from every read at
//      once), its stored content is copied up, and it is purged only once the
//      protected copy is verified. A copy written before tier routing has its
//      placement adopted first (no store is touched). When the spool still has
//      a newer version than the copy, that version is then listed in the
//      protected lane, ahead of its own records, and replaces the moved copy.
//   2. Keep the claim, in the set's ledger, so a later ordinary record of the
//      item is never admitted to the ordinary lane.
//
// Nothing is deleted on the way: no copy is given up in favour of one that is
// not yet stored. Any step that fails throws, with the copy hidden or
// untouched and its content still there; the pull stops before either lane's
// cursor moves, so the claim's own record is read again by the next pull and
// the steps run again. (A persisted write intent for multi-store writes is on
// its way in the spine, #540; this move goes through the tiered set's own move
// API so it can take that over.)
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
  /** The items whose ordinary copy this moved out of the ordinary lane (the receipt counts them as evictions). */
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
  // A claimed item still served by the ordinary lane, or one whose move an earlier pull began and did not finish (hidden,
  // its content still in the ordinary store): both are moved now.
  const unfinished = (identity: SourceItemIdentity): boolean => args.set.ledger.getCurrent(identity)?.state === 'moving';
  const held = args.claims.filter((identity) => readable(identity) || unfinished(identity));
  const ids = new Set([...args.newestKnown.keys(), ...held.map((identity) => identity.localItemId)]);
  const newest = ids.size > 0
    ? readTelegramCaptureSpoolNewest({ spoolDir: args.spoolDir, localItemIds: ids, compareVersions: compareTelegramVersions, asTrust: 'secure_local' })
    : new Map<string, TelegramCaptureSpoolRecord>();
  for (const identity of args.claims) {
    const known = args.newestKnown.get(identity.localItemId)
      ?? args.internal.storedItemState(identity)?.version;
    const found = newest.get(identity.localItemId);
    const foundVersion = found?.capturedItem.item.identity.sourceVersion;
    // The spool's newest version goes into the protected lane after the move, and replaces the moved copy there if it is newer.
    if (found !== undefined && (known === undefined || foundVersion === undefined || compareTelegramVersions(foundVersion, known) >= 0)) {
      result.carried.push(found);
    }
    if (!held.includes(identity)) continue;
    // One tier move per copy: the ordinary copy is superseded first (hidden from every read), its content is copied up,
    // and it is purged only once the protected copy is verified. Nothing is deleted on the way, and a move that fails
    // throws with the copy hidden or untouched, never removed: the next pull runs it again.
    adoptIfLegacy(args.set, args.internal, identity);
    await (args.move ?? moveTieredItem)({ set: args.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
    result.moved += 1;
    result.relinquished.push(identity.localItemId);
    if (readable(identity) || unfinished(identity)) throw new Error('Telegram could not take a protected message out of the ordinary lane.');
  }
  // The claim is kept once its item is out of the ordinary lane.
  for (const identity of args.claims) {
    if (!telegramClaimKept(args.set, identity.localItemId)) args.set.ledger.writeMeta(`${CLAIM_META_PREFIX}${identity.localItemId}`, '1');
  }
  return result;
}

/**
 * A copy written before the ledger routed it has no copy rows for the tier
 * move to work on: its placement is recorded as it stands first (the same
 * adoption the Private-row re-home makes), touching no store.
 */
function adoptIfLegacy(set: TieredStoreSet, internal: LocalConnectorStore, identity: SourceItemIdentity): void {
  const record = set.ledger.getCurrent(identity);
  if (record?.routed) return;
  internal.bindTierSet(set.ledger);
  set.ledger.adoptLegacyPlacement(
    identity,
    [{ corpusId: internal.corpusId, trustDomain: 'internal', layers: 'both' }],
    { whenMissing: { family: identity.family, metadataTier: 'private', contentTier: 'private' } },
  );
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
