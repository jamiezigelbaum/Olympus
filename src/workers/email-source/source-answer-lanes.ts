// The answer lanes one request searches: a scoped adapter and a content
// provider per mounted connector store, the registry, the tier visibility
// gate and the Secret locations beside the answer. server.ts builds them for
// every answer through this one factory, and so do the tests that prove what
// an answer on this computer reaches.
//
// `built_in_only` builds the same lanes for answers on this
// computer alone (source-index/local-answer.ts): the vector lanes and passage
// ranking keep only the built-in embedding model, and only as a model this
// process already holds (`localEmbedding`), so nothing can install, download
// or start a model; otherwise they fall back to keyword search.
// `private_search` keeps the configured meaning lane and enables the bounded
// keyword retry only for Private stores. Neither mode changes a model or epoch.

import type { ClassificationCoverageNote, SecretLocationNote } from '../../core/evidence-pack.ts';
import type { SourceIndexAnswerRequest } from '../source-index/answer-types.ts';
import type { SourceIndexCorpusRegistry } from '../../core/source-index/corpus.ts';
import type { SourceIndexCorpusSearchAdapter, SourceIndexVisibilityGate } from '../../core/source-index/router.ts';
import type { AnalystAnswerLanes } from '../source-index/analyst-answer.ts';
import {
  builtInEmbeddingOnly,
  isApprovedSecureSourceEmbeddingProvider,
  memoizeQueryEmbeddings,
  type SourceEmbeddingProvider,
} from '../source-index/embeddings.ts';
import {
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  type ConnectorStoreSearchFilters,
  type LocalConnectorStore,
} from '../connector-store/index.ts';

export type SourceAnswerLaneMode = 'built_in_only' | 'private_search';

/** The owner's read scope for a store, as server.ts decides it. */
export type SourceAnswerReadScope =
  | { allowed: false }
  | {
    allowed: true;
    accountScope?: string;
    filters?: ConnectorStoreSearchFilters;
    contentAllowed: boolean;
    contentFilters?: ConnectorStoreSearchFilters;
  };

/** This request's scope for a store (server.ts connectorStoreAnswerScope). */
export type SourceAnswerRequestScope =
  | Readonly<{ kind: 'search'; accountScope?: string; filters?: ConnectorStoreSearchFilters }>
  | Readonly<{ kind: 'skip'; reason: string }>;

export interface SourceAnswerLaneDependencies {
  /** The mounted stores, read at each request (a tier leg may join later). */
  stores: () => readonly LocalConnectorStore[];
  /** The answer-capable corpora registered now. */
  registry: () => SourceIndexCorpusRegistry;
  /** The store's configured embedding provider, if any. */
  embeddingProvider: (store: LocalConnectorStore) => SourceEmbeddingProvider | undefined;
  /**
   * For `built_in_only`: the configured provider as the built-in model this
   * process already holds, or undefined (keyword search).
   */
  localEmbedding: (provider: SourceEmbeddingProvider) => SourceEmbeddingProvider | undefined;
  readScope: (store: LocalConnectorStore) => SourceAnswerReadScope;
  answerScope: (store: LocalConnectorStore, request: SourceIndexAnswerRequest) => SourceAnswerRequestScope;
  /** The store's default account scope, when the request names none. */
  accountScope: (store: LocalConnectorStore) => string | undefined;
  /** An adapter's own semantic relevance bar, for a corpus that has one. */
  semanticRelevanceBar?: (store: LocalConnectorStore) => number | undefined;
  visibilityGate?: SourceIndexVisibilityGate;
  /** The Secrets located within the scopes this request searched. */
  secretLocations?: (
    query: string,
    searched: ReadonlyArray<{ corpusId: string; accountScope?: string; filters?: ConnectorStoreSearchFilters }>,
  ) => readonly SecretLocationNote[];
  /** Items still waiting for their tier in a corpus (0 when none or unknown). */
  heldItems?: (corpusId: string) => number;
}

/** Trusted modes: local answers narrow embeddings; private search enables the keyword retry. */
export function createSourceAnswerLanes(
  deps: SourceAnswerLaneDependencies,
): (request: SourceIndexAnswerRequest, mode?: SourceAnswerLaneMode) => AnalystAnswerLanes {
  return (request, mode) => {
    // The scope each corpus is searched under in THIS request, so the
    // Secret locations released beside the answer are confined to it.
    const searchScopes = new Map<string, { accountScope?: string; filters?: ConnectorStoreSearchFilters }>();
    // Each store's embedding provider for THIS request, memoized so the
    // vector lane and passage ranking embed the query once between them.
    const requestEmbeddings = new Map<string, SourceEmbeddingProvider | undefined>();
    const requestEmbedding = (store: LocalConnectorStore): SourceEmbeddingProvider | undefined => {
      if (!requestEmbeddings.has(store.corpusId)) {
        const configured = deps.embeddingProvider(store);
        const provider = mode === 'built_in_only'
          ? builtInEmbeddingOnly(configured, deps.localEmbedding)
          : configured;
        requestEmbeddings.set(
          store.corpusId,
          provider && (store.trustDomain !== 'secure_local' || isApprovedSecureSourceEmbeddingProvider(provider))
            ? memoizeQueryEmbeddings(provider)
            : undefined,
        );
      }
      return requestEmbeddings.get(store.corpusId);
    };
    // Stores left without an adapter on purpose (the owner's read scope
    // is off, or this request's scope excludes them), as distinct from a
    // registered corpus nothing could search.
    const excludedCorpusIds = new Set<string>();
    const connectorStoreAdapter = (store: LocalConnectorStore): SourceIndexCorpusSearchAdapter | undefined => {
      const mandatoryScope = deps.readScope(store);
      if (!mandatoryScope.allowed) {
        excludedCorpusIds.add(store.corpusId);
        return undefined;
      }
      const scope = deps.answerScope(store, request);
      if (scope.kind === 'skip') {
        excludedCorpusIds.add(store.corpusId);
        return undefined;
      }
      const connectorStoreEmbedding = requestEmbedding(store);
      const connectorStoreAccount = scope.accountScope
        ?? mandatoryScope.accountScope
        ?? (request.account?.trim() || deps.accountScope(store));
      const filters = scope.filters || mandatoryScope.filters
        ? { ...scope.filters, ...mandatoryScope.filters }
        : undefined;
      searchScopes.set(store.corpusId, {
        ...(connectorStoreAccount ? { accountScope: connectorStoreAccount } : {}),
        ...(filters ? { filters } : {}),
      });
      const semanticRelevanceBar = deps.semanticRelevanceBar?.(store);
      return createConnectorStoreCorpusAdapter({
        store,
        retrievalMode: request.retrieval_mode ?? 'keyword',
        // Trusted local/private consumers only; never a tool/HTTP request field.
        localKeywordFallback: mode === 'built_in_only' ? true : (mode === 'private_search' && store.trustDomain === 'secure_local' ? 'private_search' : false),
        ...(semanticRelevanceBar !== undefined ? { semanticRelevanceBar } : {}),
        ...(connectorStoreAccount ? { accountScope: connectorStoreAccount } : {}),
        ...(filters ? { filters } : {}),
        ...(connectorStoreEmbedding ? { embeddingProvider: connectorStoreEmbedding } : {}),
      });
    };
    const stores = deps.stores();
    return {
      registry: deps.registry(),
      ...(deps.visibilityGate ? { visibilityGate: deps.visibilityGate } : {}),
      ...(deps.secretLocations
        ? {
          secretLocations: (query: string, searchedCorpora: readonly string[]) => deps.secretLocations!(
            query,
            searchedCorpora.flatMap((corpusId) => {
              const scope = searchScopes.get(corpusId);
              return scope ? [{ corpusId, ...scope }] : [];
            }),
          ),
        }
        : {}),
      ...(deps.heldItems
        ? {
          classificationCoverage: (searchedCorpora: readonly string[]): ClassificationCoverageNote[] => searchedCorpora.flatMap((corpusId) => {
            try {
              const held = deps.heldItems!(corpusId);
              return held > 0 ? [{ corpusId, pendingClassificationItems: held }] : [];
            } catch {
              return [];
            }
          }),
        }
        : {}),
      adapters: Object.fromEntries(stores.flatMap((store) => {
        const adapter = connectorStoreAdapter(store);
        return adapter ? [[store.corpusId, adapter] as const] : [];
      })),
      excludedCorpusIds,
      contentProviders: Object.fromEntries(stores.flatMap((store) => {
        const mandatoryScope = deps.readScope(store);
        // Built whenever names are searchable, even with no content scope at
        // all: an item in a Names-only folder then reports as kept unread by
        // choice, not unreadable. Passage ranking by embedding rides only a
        // hybrid request, where the vector lane already embedded the query
        // (memoized), so it costs no second forward pass.
        const passageEmbedding = request.retrieval_mode === 'hybrid' ? requestEmbedding(store) : undefined;
        return mandatoryScope.allowed
          ? [[store.corpusId, createConnectorStoreContentProvider({
            store,
            ...(passageEmbedding ? { embeddingProvider: passageEmbedding } : {}),
            ...(mandatoryScope.accountScope ? { accountScope: mandatoryScope.accountScope } : {}),
            ...(mandatoryScope.contentFilters ? { filters: mandatoryScope.contentFilters } : {}),
            ...(mandatoryScope.filters ? { metadataFilters: mandatoryScope.filters } : {}),
            contentAllowed: mandatoryScope.contentAllowed !== false,
          })] as const]
          : [];
      })),
    };
  };
}
