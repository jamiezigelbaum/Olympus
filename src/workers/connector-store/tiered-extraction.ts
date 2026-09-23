// The extraction factory's view of a tiered store set whose text arrives after
// listing (design docs/design/per-item-four-tier-classification.md, sections
// 2 and 3.2; TieredStoreSetOptions.contentArrivesLater).
//
// A lane like that keeps its listing rows in several stores: every item stored
// before per-tier routing stays in the lane's own (legacy) store, and a new
// item's names sit in its metadata tier's store until its text is read. The
// factory still sees ONE corpus. This view answers its reads across the set:
//
// - candidates: the legacy store's own candidates exactly as before, then each
//   routed item's names copy, until its content has landed somewhere;
// - locator and scope checks: whichever store holds the item's row;
// - the item's trust tier for egress: never below Private for a routed item,
//   because its content tier is not known until the text is read (a new item
//   is no less protected on the way to an extractor than every item was
//   before per-tier routing).
//
// Everything here is source-neutral: nothing branches on which source a store
// belongs to.

import type { SourceItemIdentity, SourceTrustDomain, SourceTrustTier } from '../../core/source-index/types.ts';
import type { TierCopy } from '../classification/tier-ledger.ts';
import { tierLedgerIdentityKey } from '../classification/tier-ledger.ts';
import type {
  ConnectorStoreExtractionCandidate,
  ConnectorStoreExtractionCandidateOptions,
  ConnectorStoreExtractionCandidatePage,
  ConnectorStoreSearchFilters,
  LocalConnectorStore,
} from './local-index.ts';
import { TIER_DOMAIN_ORDER, type TieredStoreSet } from './tiered-store-set.ts';

/** A cursor into a store other than the legacy one: `tier:<domain>:<store cursor>`. */
const TIER_CURSOR_PREFIX = 'tier:';

const TRUST_TIER_RANK: Readonly<Record<SourceTrustTier, number>> = {
  S0: 0,
  S1: 1,
  S2: 2,
  S3: 3,
  S4: 4,
  'S4+': 5,
  S5: 6,
};

export interface TieredExtractionView {
  /** Same shape as LocalConnectorStore.extractionCandidates, across the set. */
  extractionCandidates(options: ConnectorStoreExtractionCandidateOptions): ConnectorStoreExtractionCandidatePage;
  /** The item's row wherever it lives: the locator, for a local-mount read. */
  localContent(localItemId: string, maxChars?: number): { locatorUri?: string; trustTier?: SourceTrustTier } | undefined;
  /** Scope check against whichever store holds the item's row. */
  itemMatchesSearchFilters(
    localItemId: string,
    accountScope: string | undefined,
    filters: ConnectorStoreSearchFilters | undefined,
  ): boolean;
  itemMatchesExtractionRef(
    ref: Parameters<LocalConnectorStore['itemMatchesExtractionRef']>[0],
    filters: ConnectorStoreSearchFilters | undefined,
  ): boolean;
  /** The tier egress decisions read: never below Private for a routed item. */
  itemTrustTier(localItemId: string): SourceTrustTier | undefined;
}

export function tieredExtractionView(set: TieredStoreSet): TieredExtractionView {
  const legacyDomains = (): SourceTrustDomain[] =>
    TIER_DOMAIN_ORDER.filter((domain) => set.legSpec(domain)?.legacy === true);
  const routedDomains = (): SourceTrustDomain[] =>
    TIER_DOMAIN_ORDER.filter((domain) => set.legSpec(domain) !== undefined && set.legSpec(domain)?.legacy !== true);
  // Legacy stores first, so a cursor with no prefix (every checkpoint written
  // before per-tier routing) resumes the legacy store exactly where it was.
  const order = (): SourceTrustDomain[] => [...legacyDomains(), ...routedDomains()];

  const storesHoldingRow = (localItemId: string): LocalConnectorStore[] =>
    order().flatMap((domain) => {
      const store = set.store(domain);
      return store && store.activeLocalItemRow(localItemId) ? [store] : [];
    });

  const keep = (
    domain: SourceTrustDomain,
    store: LocalConnectorStore,
    candidates: readonly ConnectorStoreExtractionCandidate[],
  ): ConnectorStoreExtractionCandidate[] => {
    const copies = set.ledger.copiesForMany(candidates.map((candidate) => candidate.identity));
    const legacyLeg = set.legSpec(domain)?.legacy === true;
    return candidates.filter((candidate) => {
      const itemCopies = copies.get(tierLedgerIdentityKey(candidate.identity)) ?? [];
      if (itemCopies.length === 0) return legacyLeg && !set.ledger.isRouted(candidate.identity);
      return routedCandidate(store.corpusId, itemCopies)
        && set.ledger.getCurrent(candidate.identity)?.state !== 'moving';
    });
  };

  return {
    extractionCandidates(options) {
      const domains = order();
      let index = 0;
      let cursor = options.cursor;
      if (cursor?.startsWith(TIER_CURSOR_PREFIX)) {
        const rest = cursor.slice(TIER_CURSOR_PREFIX.length);
        const separator = rest.indexOf(':');
        const domain = (separator < 0 ? rest : rest.slice(0, separator)) as SourceTrustDomain;
        const position = domains.indexOf(domain);
        if (position < 0) throw new Error('Extraction candidate cursor names a store this set does not have.');
        index = position;
        cursor = separator < 0 ? undefined : rest.slice(separator + 1) || undefined;
      } else if (cursor !== undefined && set.legSpec(domains[0]!)?.legacy !== true) {
        throw new Error('Extraction candidate cursor has no legacy store to resume.');
      }
      for (; index < domains.length; index += 1) {
        const domain = domains[index]!;
        const store = set.store(domain);
        if (!store) {
          cursor = undefined;
          continue;
        }
        const { cursor: _ignored, ...rest } = options;
        const page = store.extractionCandidates({ ...rest, ...(cursor !== undefined ? { cursor } : {}) });
        const candidates = keep(domain, store, page.candidates);
        const last = index === domains.length - 1;
        if (!page.done) {
          return {
            candidates,
            done: false,
            nextCursor: encodeCursor(set, domains, index, page.nextCursor),
            ...(page.skippedByDisposition ? { skippedByDisposition: page.skippedByDisposition } : {}),
          };
        }
        if (last || candidates.length > 0) {
          const next = nextOpenIndex(set, domains, index + 1);
          return {
            candidates,
            done: next === undefined,
            ...(next !== undefined ? { nextCursor: encodeCursor(set, domains, next, undefined) } : {}),
            ...(page.skippedByDisposition ? { skippedByDisposition: page.skippedByDisposition } : {}),
          };
        }
        cursor = undefined;
      }
      return { candidates: [], done: true };
    },

    localContent(localItemId) {
      for (const store of storesHoldingRow(localItemId)) {
        const row = store.activeLocalItemRow(localItemId);
        if (row) return { ...(row.locatorUri ? { locatorUri: row.locatorUri } : {}), trustTier: row.trustTier };
      }
      return undefined;
    },

    itemMatchesSearchFilters(localItemId, accountScope, filters) {
      return storesHoldingRow(localItemId).some((store) => store.itemMatchesSearchFilters(localItemId, accountScope, filters));
    },

    itemMatchesExtractionRef(ref, filters) {
      return storesHoldingRow(ref.localItemId).some((store) => store.itemMatchesExtractionRef(ref, filters));
    },

    itemTrustTier(localItemId) {
      let tier: SourceTrustTier | undefined;
      let routed = false;
      for (const store of storesHoldingRow(localItemId)) {
        const located = store.activeLocalItemRow(localItemId);
        if (!located) continue;
        if (set.ledger.isRouted(located.identity)) routed = true;
        if (tier === undefined || TRUST_TIER_RANK[located.trustTier] > TRUST_TIER_RANK[tier]) tier = located.trustTier;
      }
      if (!routed) return tier;
      return tier === undefined || TRUST_TIER_RANK[tier] < TRUST_TIER_RANK.S4 ? 'S4' : tier;
    },
  };
}

/**
 * A routed item's row in this store is a candidate while this store's current
 * copy serves its names (`metadata` or `both`) and no other current copy
 * already holds its content.
 */
function routedCandidate(corpusId: string, copies: readonly TierCopy[]): boolean {
  const current = copies.filter((copy) => copy.state === 'current');
  const mine = current.find((copy) => copy.corpusId === corpusId);
  if (!mine || mine.layers === 'content') return false;
  return !current.some((copy) => copy.corpusId !== corpusId && copy.layers === 'content');
}

function encodeCursor(
  set: TieredStoreSet,
  domains: readonly SourceTrustDomain[],
  index: number,
  storeCursor: string | undefined,
): string {
  const domain = domains[index]!;
  // The legacy store keeps its plain cursor: that is what every checkpoint
  // written before per-tier routing holds, so they resume where they were.
  if (index === 0 && set.legSpec(domain)?.legacy === true && storeCursor !== undefined) return storeCursor;
  return `${TIER_CURSOR_PREFIX}${domain}:${storeCursor ?? ''}`;
}

function nextOpenIndex(set: TieredStoreSet, domains: readonly SourceTrustDomain[], from: number): number | undefined {
  for (let index = from; index < domains.length; index += 1) {
    if (set.store(domains[index]!)) return index;
  }
  return undefined;
}

export type { SourceItemIdentity };
