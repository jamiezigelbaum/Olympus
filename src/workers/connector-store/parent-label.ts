// Finds a child item's parent and what its names are worth, for the label a
// citation carries (docs/design/child-items.md, "Citations"; the rules are in
// core/parent-label.ts).
//
// Only the parent's NAMES are read, from the one copy the tier ledger says
// serves them now, and never the parent's content. A parent gives no label
// when it is not there (removed, hidden, not found), is Secrets (judged,
// overridden or moving there), or its names are not final yet. Its names tier
// is the higher of the current and the in-flight one, so a raise in progress
// already withholds a Personal label. An item the ledger never placed keeps
// its corpus's tier (the release check's `legacy` rule).
//
// The stores and the ledgers are reached the way the visibility gate reaches
// them (a store set's scope: its ledger and the corpora it governs), so this
// module serves a composition root's stores and a tiered set's lane alike. It
// names no source and no format.

import {
  parentLabelText,
  type ParentLabelRequest,
  type ParentLabelResolver,
  type ParentNames,
  type ParentNamesTier,
} from '../../core/parent-label.ts';
import type { SourceClassificationTier } from '../../core/contracts.ts';
import { copyServingLayer, type TierLedgerIdentity } from '../classification/tier-ledger.ts';
import type { UnreadableParent } from '../file-extraction/unreadable-files.ts';
import type { LocalConnectorStore } from './local-index.ts';
import type { TierVisibilityScope } from './tier-visibility.ts';

export interface ParentLabelSources {
  /**
   * The stores a parent may be found in (read per call: a lane may open a store on first need).
   */
  stores: () => readonly LocalConnectorStore[];
  /**
   * The ledgers that govern them. A corpus no scope governs keeps its own corpus's tier.
   */
  scopes: () => readonly TierVisibilityScope[];
}

const LEDGER_TIER: Readonly<Record<Exclude<SourceClassificationTier, 'secrets'>, ParentNamesTier>> = {
  public: 'public',
  private: 'personal',
  secure: 'private',
};
const RANK: Readonly<Record<ParentNamesTier, number>> = { public: 0, personal: 1, private: 2 };

export function createParentLabelResolver(sources: ParentLabelSources): ParentLabelResolver {
  return (requests) => {
    const stores = sources.stores();
    const scopes = sources.scopes();
    return requests.map((request) => {
      try {
        return resolveOne(request, stores, scopes);
      } catch {
        return undefined;
      }
    });
  };
}

function resolveOne(
  request: ParentLabelRequest,
  stores: readonly LocalConnectorStore[],
  scopes: readonly TierVisibilityScope[],
): ParentNames | undefined {
  const scope = scopes.find((candidate) => candidate.corpusIds.has(request.corpusId));
  // The parent sits in the child's own lane: the stores its ledger governs, else the child's own store.
  const lane = stores.filter((store) => (scope ? scope.corpusIds.has(store.corpusId) : store.corpusId === request.corpusId));
  if (lane.length === 0) return undefined;

  const child = request.sourceItem;
  let parentLocalItemId: string | undefined;
  for (const store of lane) {
    parentLocalItemId = store.parentLocalItemIdOf(child);
    if (parentLocalItemId) break;
  }
  if (!parentLocalItemId) return undefined;

  let parent: TierLedgerIdentity | undefined;
  let row: ReturnType<LocalConnectorStore['activeLocalItemRow']>;
  let rowStore: LocalConnectorStore | undefined;
  for (const store of lane) {
    row = store.activeLocalItemRow(parentLocalItemId);
    if (row) {
      parent = row.identity;
      rowStore = store;
      break;
    }
  }
  if (!parent || !row || !rowStore) return undefined;
  // Secrets are never kept anywhere a label could be read from.
  if (row.trustTier === 'S5') return undefined;

  if (scope && scope.ledger.itemIsSecret(parent)) return undefined;
  const state = scope?.ledger.itemStatesForMany([parent]).values().next().value;

  // What the ledger has decided for the names, when it has decided anything.
  let decided: ParentNamesTier | undefined;
  if (state) {
    const { record } = state;
    if (record.metadataPending) return undefined;
    const keys = [record.metadataTier, record.targetMetadataTier];
    if (keys.includes('secrets')) return undefined;
    let highest: ParentNamesTier = 'public';
    for (const key of keys) {
      if (key === null || key === 'secrets') continue;
      if (RANK[LEDGER_TIER[key]] > RANK[highest]) highest = LEDGER_TIER[key];
    }
    decided = highest;
  }

  let tier: ParentNamesTier;
  let namesStore: LocalConnectorStore | undefined;
  if (state && state.record.routed) {
    tier = decided!;
    // The copy that serves the names now; none means the names are hidden or gone.
    const serving = copyServingLayer(state.copies.filter((copy) => copy.state === 'current'), 'metadata');
    if (!serving) return undefined;
    namesStore = lane.find((store) => store.corpusId === serving.corpusId);
  } else {
    // Not placed by the ledger yet: its corpus's tier is the least it can be.
    const corpusTier: ParentNamesTier = rowStore.trustDomain === 'secure_local' || row.trustTier === 'S4' || row.trustTier === 'S4+'
      ? 'private'
      : rowStore.trustDomain === 'public_safe' ? 'public' : 'personal';
    tier = decided && RANK[decided] > RANK[corpusTier] ? decided : corpusTier;
    namesStore = rowStore;
  }
  if (!namesStore) return undefined;

  const names = namesStore.itemNames(parent);
  if (!names) return undefined;
  return {
    tier,
    corpusId: namesStore.corpusId,
    identity: {
      provider: parent.provider,
      accountScope: parent.accountScope,
      providerItemId: parent.providerItemId,
      ...(parent.providerConversationId ? { providerConversationId: parent.providerConversationId } : {}),
    },
    ...(names.title ? { subject: names.title } : {}),
    ...(names.sender ? { sender: names.sender } : {}),
    ...(names.authoredAt ? { authoredAt: names.authoredAt } : {}),
  };
}

/**
 * The parent of a file that could not be read, for its entry in the unreadable
 * list: the label (the owner's own list, so any tier but Secrets) and where the
 * parent lives. Undefined for a file that is not a child.
 */
export function unreadableParentOf(
  resolve: ParentLabelResolver,
  request: ParentLabelRequest,
): UnreadableParent | undefined {
  const [names] = resolve([request]);
  if (!names) return undefined;
  const label = parentLabelText(names);
  return {
    ...(label ? { label } : {}),
    provider: names.identity.provider,
    accountScope: names.identity.accountScope,
  };
}
