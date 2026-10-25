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

import type { ReleaseCheck, ReleaseInputVerdict } from '../../core/release-manifest.ts';
import type { SourceIndexRoutedSearchHit, SourceIndexVisibilityGate } from '../../core/source-index/router.ts';
import { tierLedgerIdentityKey, type TierLedger, type TierLedgerIdentity } from '../classification/tier-ledger.ts';

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
        if (!hit.sourceItem.accountScope || !hit.sourceItem.provider || !hit.sourceItem.providerItemId) {
          hidden.add(hit);
          continue;
        }
        const key = tierLedgerIdentityKey(hit.sourceItem);
        const itemCopies = copies.get(key);
        if (!itemCopies || itemCopies.length === 0) {
          if (routedWithoutCopies.has(key)) hidden.add(hit);
          continue;
        }
        const currentHere = itemCopies.some((copy) => copy.corpusId === hit.corpusId && copy.state === 'current'
          && (!hit.servingLayer || copy.layers === 'both' || copy.layers === hit.servingLayer));
        if (!currentHere) hidden.add(hit);
      }
    }
    return hidden.size === 0 ? hits : hits.filter((hit) => !hidden.has(hit));
  };
}

/**
 * The current tiers of the items an answer was written from (its release
 * manifest, core/release-manifest.ts), read when a remote agent collects the
 * answer: a delayed answer may have been written before an item it read was
 * reclassified.
 *
 * Each input is read by its exact identity, account included, from the ledger
 * that governs its corpus: one batched read per ledger, so every input is
 * judged against one snapshot. A row at Secrets (or moving there) is
 * `secret`; at Private (or moving there) `private`; anything else classified
 * is `public_or_personal`; a routed item with no current copy left is also
 * `gone`. An item
 * no ledger governs, or one its ledger never classified (ledger rows are never
 * deleted, so no row means never classified), is `legacy`: its tier is still
 * its corpus's. An input in a governed corpus without an account cannot be
 * read and is `unknown`. A ledger that cannot be read throws; the caller
 * withholds.
 */
export function createReleaseTierCheck(
  scopes: () => readonly TierVisibilityScope[],
  secureDerivativeDefault: () => 'allow' | 'approval',
): ReleaseCheck {
  return {
    secureDerivativeDefault,
    inputs: (inputs) => {
      const verdicts: ReleaseInputVerdict[] = inputs.map(() => ({ tier: 'legacy', gone: false }));
      if (inputs.length === 0) return verdicts;
      for (const scope of scopes()) {
        const governed: Array<{ index: number; identity: TierLedgerIdentity }> = [];
        inputs.forEach((input, index) => {
          if (!scope.corpusIds.has(input.corpusId)) return;
          if (!input.accountScope || !input.provider || !input.providerItemId) {
            verdicts[index] = { tier: 'unknown', gone: false };
            return;
          }
          governed.push({
            index,
            identity: {
              provider: input.provider,
              accountScope: input.accountScope,
              providerItemId: input.providerItemId,
              ...(input.providerConversationId ? { providerConversationId: input.providerConversationId } : {}),
            },
          });
        });
        if (governed.length === 0) continue;
        const states = scope.ledger.itemStatesForMany(governed.map(({ identity }) => identity));
        for (const { index, identity } of governed) {
          const state = states.get(tierLedgerIdentityKey(identity));
          if (!state) continue;
          const { record, copies } = state;
          // An input of the names layer (a child citation's parent label) is
          // judged on the item's names alone: its content tier never limits an
          // answer that carries only its names.
          const namesOnly = inputs[index]!.layer === 'names';
          const tiers = namesOnly
            ? [record.metadataTier, record.targetMetadataTier]
            : [record.metadataTier, record.contentTier, record.targetMetadataTier, record.targetContentTier];
          verdicts[index] = {
            tier: tiers.includes('secrets') ? 'secret' : tiers.includes('secure') ? 'private' : 'public_or_personal',
            gone: record.routed && !copies.some((copy) => copy.state === 'current'
              && (!namesOnly || copy.layers === 'both' || copy.layers === 'metadata')),
          };
        }
      }
      return verdicts;
    },
  };
}
