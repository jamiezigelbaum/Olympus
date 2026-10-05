// Tiered store sets by set-ledger path, for the sniffer's automatic moves: a
// Personal verdict on a held item queues a move, and the sniffer service runs
// it at once when every embedding involved is the built-in local model
// (classification/sniffer-service.ts). Each set registers itself when it is
// built. Type-only import: nothing is loaded through this lookup.

import type { TieredStoreSet } from './tiered-store-set.ts';

let tierSets: Map<string, TieredStoreSet> | undefined;

export function registerTierSetForLedger(ledgerPath: string, set: TieredStoreSet): void {
  (tierSets ??= new Map()).set(ledgerPath, set);
}

export function tierSetForLedger(ledgerPath: string): TieredStoreSet | undefined {
  return tierSets?.get(ledgerPath);
}
