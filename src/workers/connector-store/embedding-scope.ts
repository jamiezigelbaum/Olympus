import { SourceScopeApprovalRequiredError } from '../../core/operation-error.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import { scopeBoundEmbeddingProvider, type FileSourceScopeAuthority, type SourceScopePolicyRef } from '../source-scope-runtime.ts';
import type { StoreEmbeddingScope } from './embedding-plan.ts';
import { normalizeConnectorStoreSearchFilters, type ConnectorStoreSearchFilters, type ConnectorStoreStatusScope, type LocalConnectorStore } from './local-index.ts';

interface ScopeInput {
  store: LocalConnectorStore;
  provider?: SourceEmbeddingProvider | undefined;
  scopeRef: SourceScopePolicyRef | undefined;
  authority: FileSourceScopeAuthority | undefined;
}

export type SourceEmbeddingScopePolicy = (input: ScopeInput) => StoreEmbeddingScope;
export type EmbeddingPolicy = 'open' | 'approval' | SourceEmbeddingScopePolicy;

export type EmbeddingReadScope = (store: LocalConnectorStore) => { allowed: false } | {
  allowed: true;
  contentAllowed?: boolean;
  accountScope?: string;
  filters?: ConnectorStoreSearchFilters;
  contentFilters?: ConnectorStoreSearchFilters;
};

function approvedContentScope(store: LocalConnectorStore, readScope: EmbeddingReadScope) {
  const current = readScope(store);
  if (!current.allowed || !current.contentAllowed) return undefined;
  const accountScope = current.accountScope?.trim();
  const filters = normalizeConnectorStoreSearchFilters(current.contentFilters);
  return accountScope && filters ? { accountScope, filters } : undefined;
}

// All embedding entries use the policy published for the owner of this store.
export function storeEmbeddingScope(input: ScopeInput & {
  policy: EmbeddingPolicy;
  readScope: EmbeddingReadScope;
}): StoreEmbeddingScope {
  const { policy, store, authority, scopeRef, readScope } = input;
  if (policy === 'open') return { allowed: true };
  if (typeof policy === 'function') {
    const scope = policy(input);
    // A published denial covers queued rows as well as the store-wide pass.
    return scope.allowed ? scope : { allowed: false, skipQueue: true };
  }
  if (!scopeRef || !authority) return { allowed: false, skipQueue: true };
  const content = approvedContentScope(store, readScope);
  if (!content) return { allowed: false, skipQueue: true };
  const signature = JSON.stringify(content);
  return {
    allowed: true,
    ...content,
    bind: (provider) => scopeBoundEmbeddingProvider(provider, authority, scopeRef),
    assertAuthorized() {
      if (JSON.stringify(approvedContentScope(store, readScope)) !== signature) {
        throw new SourceScopeApprovalRequiredError('The approved content scope changed before embedding.');
      }
    },
  };
}

// Only serializable population predicates belong in status snapshot keys.
export function embeddingCountScope(
  store: LocalConnectorStore, provider: SourceEmbeddingProvider | undefined, scope: StoreEmbeddingScope,
): NonNullable<ConnectorStoreStatusScope['embedding']> {
  if (!scope.allowed) return { contentAllowed: false };
  return {
    ...(scope.accountScope ? { accountScope: scope.accountScope } : {}),
    ...(scope.filters ? { contentFilters: scope.filters } : {}),
    ...(!scope.excludeAllEmbeddingHolds && store.canEmbedHeld(provider) ? { includeHeldForJudgment: true } : {}),
  };
}
