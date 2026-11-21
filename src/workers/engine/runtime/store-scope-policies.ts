// The worker and the offline embed command resolve store ownership before
// calling the shared plan. Folder and notebook approvals use one registry.
import { getFileScopeSource, type FileScopeSourceDefinition } from '../../../core/file-scope-sources.ts';
import { GMAIL_SOURCE_ID } from '../../google-connectors/index.ts';
import { gmailReadCountScope, gmailStoreEmbeddingScope } from '../../email-source/gmail-status-scope.ts';
import { embeddingCountScope, storeEmbeddingScope, type EmbeddingPolicy, type EmbeddingReadScope } from '../../connector-store/embedding-scope.ts';
import type { ConnectorStoreStatusScope, LocalConnectorStore } from '../../connector-store/local-index.ts';
import type { ConnectedCredentialHandle } from '../../credential-broker/connected-handles.ts';
import { fileSourceScopeContentFilters, fileSourceScopeMetadataFilters, type FileSourceScopeAuthority } from '../../source-scope-runtime.ts';
import type { SourceEmbeddingProvider } from '../../source-index/embeddings.ts';
import { readActiveConnectedHandles, selectedSourceCredentialHandle } from './source-lanes.ts';

export function fileScopeCredentialHandle(definition: FileScopeSourceDefinition): ConnectedCredentialHandle | undefined {
  return definition.account === 'this_computer' ? undefined : selectedSourceCredentialHandle({
    env: process.env,
    pinEnvName: definition.pinEnvName ?? '',
    provider: definition.provider as ConnectedCredentialHandle['provider'],
    capability: definition.credentialCapability!,
    handles: readActiveConnectedHandles(process.env),
  });
}

export function registeredStoreReadScope(sourceId: string, authority: FileSourceScopeAuthority | undefined) {
  const definition = getFileScopeSource(sourceId);
  if (!definition) return { allowed: true, contentAllowed: true } as const;
  const approval = authority?.snapshot(sourceId);
  if (approval?.status !== 'approved') return { allowed: false } as const;
  const metadata = fileSourceScopeMetadataFilters(approval);
  if (!metadata.allowed) return { allowed: false } as const;
  const handle = fileScopeCredentialHandle(definition);
  const accountScope = definition.account === 'this_computer' ? 'this_computer'
    : handle ? handle.accountRole?.trim() || 'personal' : undefined;
  if (!accountScope) return { allowed: false } as const;
  const content = fileSourceScopeContentFilters(approval);
  return {
    allowed: true as const, accountScope, filters: metadata.filters, contentAllowed: content.allowed,
    ...(content.allowed && content.filters ? { contentFilters: content.filters } : {}),
  };
}

export function createStoreScopes(input: {
  authority: FileSourceScopeAuthority | undefined;
  sourceIdForStore: (store: LocalConnectorStore) => string;
  readScope: EmbeddingReadScope;
} & Parameters<typeof gmailStoreEmbeddingScope>[0]) {
  const policies = new Map([[GMAIL_SOURCE_ID, {
    embedding: gmailStoreEmbeddingScope(input),
    ref: () => input.authority?.mailPolicyRef(),
    readCounts: gmailReadCountScope,
  }]]);
  function resolve(store: LocalConnectorStore, provider: SourceEmbeddingProvider | undefined, readScope: EmbeddingReadScope) {
    const sourceId = input.sourceIdForStore(store);
    const published = policies.get(sourceId);
    const ref = published?.ref();
    // Consult the live registry so later registrations use their approval.
    const policy: EmbeddingPolicy = published?.embedding ?? (getFileScopeSource(sourceId) ? 'approval' : 'open');
    const scopeRef = policy === 'approval' ? input.authority?.policyRef(sourceId) : ref;
    const scope = storeEmbeddingScope({ store, provider, policy, scopeRef, authority: input.authority, readScope });
    return { scope, published, ref };
  }
  return {
    embeddingScopeFor: (store: LocalConnectorStore, provider: SourceEmbeddingProvider | undefined) =>
      resolve(store, provider, input.readScope).scope,
    statusScopeFor(store: LocalConnectorStore, provider: SourceEmbeddingProvider | undefined): ConnectorStoreStatusScope {
      const read = input.readScope(store);
      const { scope, published, ref } = resolve(store, provider, () => read);
      const embedding = embeddingCountScope(store, provider, scope);
      const counts = published ? published.readCounts(embedding, ref, input.authority) : readCountScope(read);
      return { ...counts, embedding };
    },
  };
}

// The offline command only needs the embedding resolver.
export function createStoreEmbeddingScopeFor(input: Parameters<typeof createStoreScopes>[0]) {
  return createStoreScopes(input).embeddingScopeFor;
}

function readCountScope(read: ReturnType<EmbeddingReadScope>): ConnectorStoreStatusScope {
  if (!read.allowed) return { itemsAllowed: false, contentAllowed: false };
  if (read.contentAllowed && !read.filters && !read.contentFilters) return {};
  return {
    ...(read.filters?.sourceScopeRevision ? { scopeRevision: read.filters.sourceScopeRevision } : {}),
    ...(read.accountScope ? { accountScope: read.accountScope } : {}),
    ...(read.filters ? { itemFilters: read.filters } : {}),
    ...(read.contentAllowed !== undefined ? { contentAllowed: read.contentAllowed } : {}),
    ...(read.contentFilters ? { contentFilters: read.contentFilters } : {}),
  };
}
