// The cross-store half of the tier-ledger visibility filter (design
// docs/design/per-item-four-tier-classification.md, section 3.3).
//
// Each store already drops hits whose copy is not current (the per-store
// filter in local-index.ts). That alone cannot promise "never searchable in
// two tiers at once": a fan-out reads each store at a different moment, so a
// move that flips between two reads could leave the source copy in one
// store's results and the destination copy in the other's. This gate judges
// every hit of one query against ONE read of each set ledger, after the
// fan-out. A flip is one ledger write, so one snapshot sees exactly one side.
//
// Legacy items (no copy rows) pass unchanged. A set whose ledger cannot be
// read fails closed for its own stores only.

import type { SourceIndexRoutedSearchHit, SourceIndexVisibilityGate } from '../../core/source-index/router.ts';
import { tierLedgerIdentityKey, type TierLedger } from '../classification/tier-ledger.ts';

export interface TierVisibilityScope {
  ledger: TierLedger;
  /** The corpora whose copies this ledger governs (one tiered store set). */
  corpusIds: ReadonlySet<string>;
}

export function createTierVisibilityGate(scopes: () => readonly TierVisibilityScope[]): SourceIndexVisibilityGate {
  return (hits) => {
    const current = scopes();
    if (current.length === 0 || hits.length === 0) return hits;
    const hidden = new Set<SourceIndexRoutedSearchHit>();
    for (const scope of current) {
      const governed = hits.filter((hit) => scope.corpusIds.has(hit.corpusId));
      if (governed.length === 0) continue;
      let copies;
      try {
        copies = scope.ledger.copiesForMany(governed.map((hit) => hit.sourceItem));
      } catch {
        for (const hit of governed) hidden.add(hit);
        continue;
      }
      for (const hit of governed) {
        const itemCopies = copies.get(tierLedgerIdentityKey(hit.sourceItem));
        if (!itemCopies || itemCopies.length === 0) continue;
        const currentHere = itemCopies.some((copy) => copy.corpusId === hit.corpusId && copy.state === 'current');
        if (!currentHere) hidden.add(hit);
      }
    }
    return hidden.size === 0 ? hits : hits.filter((hit) => !hidden.has(hit));
  };
}
