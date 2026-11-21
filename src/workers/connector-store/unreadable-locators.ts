/**
 * Where an item extraction gave up on is found, for the unreadable-files list
 * and its verdict: the item's locator (to open it) and, for a child, its
 * parent (docs/design/child-items.md, "Citations").
 *
 * A job is filed under its corpus, which for an item read later is the lane's
 * Private home. The item's own row may sit in another store of the same lane:
 * a child whose text has not landed has only its names, and those are in the
 * metadata tier's store. So the lookup asks the job's own corpus first and then
 * every other store the lane's ledger governs, never the job's corpus alone
 * (which would call a child that failed before its text landed "gone" and
 * leave it out of the list). Source-neutral: lanes and stores are the
 * composition root's.
 */

import type { TierLedger } from '../classification/tier-ledger.ts';
import type { ParentLabelResolver } from '../../core/parent-label.ts';
import type { UnreadableFileLocation, UnreadableParent } from '../file-extraction/unreadable-files.ts';
import { unreadableParentOf } from './parent-label.ts';
import type { LocalConnectorStore, SearchAncestorPlanFor } from './local-index.ts';

export interface UnreadableLocatorsInput {
  stores(): Iterable<LocalConnectorStore>;
  /**
   * The tier lanes: the corpora one ledger governs together.
   */
  lanes(): Iterable<{ corpusIds: ReadonlySet<string>; ledger: TierLedger }>;
  parentLabels: ParentLabelResolver;
  planFor: SearchAncestorPlanFor;
}

export function createUnreadableLocators(input: UnreadableLocatorsInput): {
  locate(ref: { corpusId: string; localItemId: string }): UnreadableFileLocation | undefined;
  parentOf(ref: { corpusId: string; localItemId: string }): UnreadableParent | undefined;
} {
  /**
   * The stores that can hold this job's item: its corpus's own, then its lane's others.
   */
  const storesFor = (corpusId: string): LocalConnectorStore[] => {
    const governed = [...input.lanes()].find((lane) => lane.corpusIds.has(corpusId))?.corpusIds;
    const all = [...input.stores()];
    return [
      ...all.filter((store) => store.corpusId === corpusId),
      ...all.filter((store) => store.corpusId !== corpusId && governed?.has(store.corpusId) === true),
    ].filter(store => input.planFor(store.corpusId)?.store === store);
  };
  return {
    locate(ref) {
      const stores = storesFor(ref.corpusId);
      for (const store of stores) {
        const scope = input.planFor(store.corpusId)?.ancestorScope;
        if (!scope || !store.itemMatchesSearchFilters(ref.localItemId, scope.accountScope, scope.filters)) continue;
        const found = store.localContent(ref.localItemId, 0, undefined, { withoutContent: true });
        if (found) {
          const child = store.activeLocalItemRow(ref.localItemId)?.identity;
          const withheld = !child || store.childrenWithWithheldSearchIdentifiers([child], true, input.planFor, {
            stores: () => stores, ledger: () => [...input.lanes()].find(lane => lane.corpusIds.has(store.corpusId))?.ledger,
          }).has(child);
          return {
            ...(found.locatorUri && !withheld ? { locatorUri: found.locatorUri } : {}),
            ...(found.providerConversationId ? { providerConversationId: found.providerConversationId } : {}),
          };
        }
      }
      return undefined;
    },
    parentOf(ref) {
      for (const store of storesFor(ref.corpusId)) {
        const identity = store.activeLocalItemRow(ref.localItemId)?.identity;
        if (identity) return unreadableParentOf(input.parentLabels, { corpusId: ref.corpusId, sourceItem: identity });
      }
      return undefined;
    },
  };
}
