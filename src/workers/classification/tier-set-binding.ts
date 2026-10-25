// How a store bound to a tiered store set finds the set's ledger.
//
// A store's binding (`LocalConnectorStore.tierSetBinding`) holds the ledger's
// IDENTITY and the absolute path the ledger had when the store was bound. The
// identity is what binds: a ledger is the right one only when its id is the
// recorded one, so a store never takes another set's tiers. The path is only a
// hint to where to look first, because a store and its ledger move together
// (the migration into account folders renames them, and the data folder itself
// can be moved or restored elsewhere) and the row, which is never rewritten for
// that, keeps naming the old place.
//
// Candidates, best first. Each is checked by its id before it is opened.
// 1. The recorded path, while it still leads to the ledger.
// 2. For a store in an account folder, the set ledger beside the folder's
//    secure_local store, where the layout puts it
//    (`stores/secure_local.tier-ledger.sqlite`). This is how the stores of a
//    set renamed from their legacy files are found: their file names changed.
// 3. The recorded file name in the store's own folder, which finds a set whose
//    folder was moved as a whole.
// A candidate that leads nowhere, or to another ledger, is passed over; when
// none is left the store is refused, as it always was.

import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { accountSiblingStorePath } from '../../core/olympus-layout.ts';
import { TierLedger } from './tier-ledger.ts';
import { tierLedgerPathForStore } from './tier-ledger-path.ts';

export interface TierSetBindingRecord {
  ledgerId: string;
  /** Where the ledger was when the store was bound: a hint, never the identity. */
  ledgerPath: string;
}

/** Where a store's set ledger may be, best first. Reads no file. */
export function tierSetLedgerCandidates(storeDbPath: string, recordedLedgerPath: string): string[] {
  const candidates = [recordedLedgerPath];
  if (storeDbPath !== ':memory:' && recordedLedgerPath !== ':memory:') {
    const secure = accountSiblingStorePath(storeDbPath, 'secure_local');
    if (secure) candidates.push(tierLedgerPathForStore(secure));
    candidates.push(join(dirname(storeDbPath), basename(recordedLedgerPath)));
  }
  return [...new Set(candidates)];
}

/**
 * The path of the ledger a store is bound to, or undefined when none of the
 * candidates holds a ledger with the bound identity. Opens nothing but the
 * candidates' identity rows, read-only, and creates nothing.
 */
export function findTierSetLedger(storeDbPath: string, binding: TierSetBindingRecord): string | undefined {
  for (const candidate of tierSetLedgerCandidates(storeDbPath, binding.ledgerPath)) {
    if (candidate === ':memory:' || !existsSync(candidate)) continue;
    if (TierLedger.readLedgerId(candidate) === binding.ledgerId) return candidate;
  }
  return undefined;
}
