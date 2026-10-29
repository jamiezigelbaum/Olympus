// How every store in the spine gets its vectors: one rule, whatever source
// filled the store. A store's items arrive by a sync, by per-item routing from
// another tier, by an import, or as text read later (extraction); none of
// those paths decides whether an item is indexed. This plan does, per store,
// from facts about the store alone: is its corpus served by meaning, what
// identity embeds it under its tier, and what the store's current scope is.
//
// The scheduler runs the plan through one sweep (withEmbeddingSweep).
// Sources declare no embed tasks of their own (test/embedding-path-guard.test.ts).

import { isApprovedSecureSourceEmbeddingProvider, type SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import type { ConnectorStoreEmbeddingTarget, ConnectorStoreSearchFilters, LocalConnectorStore } from './local-index.ts';

/**
 * Owner cost decisions: stores whose metered embedding (any provider but the
 * built-in local model) takes only what a sync hands over, so a backlog, text
 * read later and items a restart dropped from the in-memory queue stay
 * keyword-only. Every other store catches up store-wide. Keyed by corpus id,
 * with the decision it records. Empty by owner decision 2026-10-28: every
 * store catches up (docs/V0_4_RELEASE.md, "One indexing pass for every store").
 */
export const QUEUE_ONLY_METERED_EMBEDDING: Readonly<Record<string, string>> = {};

/** Whether a store embeds every chunk still missing a vector, not only what a sync queued. */
export function storeEmbeddingCatchesUp(corpusId: string, provider: Pick<SourceEmbeddingProvider, 'provider' | 'backend'>): boolean {
  // The built-in model costs nothing per item, so no cost decision applies to it.
  if (provider.provider === 'built-in' && provider.backend === 'local') return true;
  return QUEUE_ONLY_METERED_EMBEDDING[corpusId] === undefined;
}

/**
 * The store's current scope, as the host's scope authority has it: what the
 * store-wide pass may read. `allowed: false` (no current approval) leaves only
 * the queue, whose groups each carry the scope binding they were queued under.
 */
export type StoreEmbeddingScope =
  | { allowed: false }
  | {
    allowed: true;
    accountScope?: string;
    filters?: ConnectorStoreSearchFilters;
    /** Binds the store's provider to the current approval, so a pass stops when it changes. */
    bind?: (provider: SourceEmbeddingProvider) => SourceEmbeddingProvider;
  };

export interface StoreEmbeddingFacts {
  store: LocalConnectorStore;
  /** The identity registered for the store's tier; none means keyword-only. */
  provider: SourceEmbeddingProvider | undefined;
  /** Corpus served hybrid, embedding policy not disabled, tier retrieval not lexical-only. */
  servedByMeaning: boolean;
  scope: StoreEmbeddingScope;
}

/** The sweep target for one store, or undefined when the store is not indexed for meaning. */
export function planStoreEmbedding(facts: StoreEmbeddingFacts): ConnectorStoreEmbeddingTarget | undefined {
  const { store, provider, scope } = facts;
  if (!provider || !facts.servedByMeaning) return undefined;
  // The store refuses such a provider too; planning none keeps it out of the sweep's counts.
  if (store.trustDomain === 'secure_local' && !isApprovedSecureSourceEmbeddingProvider(provider)) return undefined;
  if (!scope.allowed) return { store, provider };
  return {
    store,
    provider: scope.bind ? scope.bind(provider) : provider,
    wholeStore: storeEmbeddingCatchesUp(store.corpusId, provider),
    ...(scope.accountScope ? { accountScope: scope.accountScope } : {}),
    ...(scope.filters ? { filters: scope.filters } : {}),
  };
}
