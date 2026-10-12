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
// Legacy items (never routed, no copy rows) pass unchanged. A ROUTED item
// with no copy rows left (a Secret whose copies were settled while a search
// held one of its hits) is hidden, never mistaken for legacy. A set whose
// ledger cannot be read fails closed for its own stores only.

import type { CitedItemCheck, CitedItemVerdict } from '../../core/remote-result.ts';
import type { SourceIndexRoutedSearchHit, SourceIndexVisibilityGate } from '../../core/source-index/router.ts';
import { tierLedgerIdentityKey, tierLedgerItemKeyAcrossAccounts, type TierLedger } from '../classification/tier-ledger.ts';

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
      let routedWithoutCopies: Set<string>;
      try {
        copies = scope.ledger.copiesForMany(governed.map((hit) => hit.sourceItem));
        const copyless = governed.filter((hit) => (copies!.get(tierLedgerIdentityKey(hit.sourceItem))?.length ?? 0) === 0);
        routedWithoutCopies = scope.ledger.routedWithoutCopies(copyless.map((hit) => hit.sourceItem));
      } catch {
        for (const hit of governed) hidden.add(hit);
        continue;
      }
      for (const hit of governed) {
        const key = tierLedgerIdentityKey(hit.sourceItem);
        const itemCopies = copies.get(key);
        if (!itemCopies || itemCopies.length === 0) {
          if (routedWithoutCopies.has(key)) hidden.add(hit);
          continue;
        }
        const currentHere = itemCopies.some((copy) => copy.corpusId === hit.corpusId && copy.state === 'current');
        if (!currentHere) hidden.add(hit);
      }
    }
    return hidden.size === 0 ? hits : hits.filter((hit) => !hidden.has(hit));
  };
}

/**
 * The current-tier check for items an answer already cited, run when a
 * remote agent collects the answer (core/remote-result.ts): a delayed answer
 * may have been written before an item it cites was reclassified.
 *
 * A citation names its corpus, provider, conversation and item, never its
 * account, so each item is read across every account the governing ledger
 * holds for that provider (`TierLedger.itemsAcrossAccounts`), in one read per
 * ledger. Any account's row at Secrets (or moving to Secrets) makes the item
 * `secret`: two accounts with the same item id fail closed. A routed item
 * with no current copy anywhere is `gone` (removed, or settled as a Secret
 * whose row was cleared). A corpus no tiered set governs, or an item the
 * ledger never placed (legacy), is `unknown`: there is no per-item tier to
 * recheck. A ledger that cannot be read throws, and the caller withholds.
 */
export function createCitedItemTierCheck(scopes: () => readonly TierVisibilityScope[]): CitedItemCheck {
  return (items) => {
    const verdicts: CitedItemVerdict[] = items.map(() => 'unknown');
    if (items.length === 0) return verdicts;
    const current = scopes();
    for (const scope of current) {
      const governed = items.flatMap((item, index) => (scope.corpusIds.has(item.corpusId) ? [index] : []));
      if (governed.length === 0) continue;
      const rows = scope.ledger.itemsAcrossAccounts(governed.map((index) => {
        const item = items[index]!;
        return {
          provider: item.provider,
          providerItemId: item.providerItemId,
          ...(item.providerConversationId ? { providerConversationId: item.providerConversationId } : {}),
        };
      }));
      for (const index of governed) {
        const item = items[index]!;
        const found = rows.get(tierLedgerItemKeyAcrossAccounts({
          provider: item.provider,
          providerItemId: item.providerItemId,
          ...(item.providerConversationId ? { providerConversationId: item.providerConversationId } : {}),
        }));
        if (!found || found.length === 0) continue;
        const secret = found.some(({ record }) => record.metadataTier === 'secrets'
          || record.contentTier === 'secrets'
          || record.targetMetadataTier === 'secrets'
          || record.targetContentTier === 'secrets');
        if (secret) {
          verdicts[index] = 'secret';
          continue;
        }
        const routed = found.filter(({ record }) => record.routed);
        if (routed.length === 0) {
          verdicts[index] = 'current';
          continue;
        }
        verdicts[index] = routed.some(({ copies }) => copies.some((copy) => copy.state === 'current')) ? 'current' : 'gone';
      }
    }
    return verdicts;
  };
}
