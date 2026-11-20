// The worker and the offline embed command resolve store ownership before
// calling the shared plan. Folder and notebook approvals use one registry.
import { getFileScopeSource, type FileScopeSourceDefinition } from '../../../core/file-scope-sources.ts';
import { GMAIL_SOURCE_ID } from '../../google-connectors/index.ts';
import { gmailStoreEmbeddingScope } from '../../email-source/gmail-status-scope.ts';
import { storeEmbeddingScope, type EmbeddingPolicy, type EmbeddingReadScope } from '../../connector-store/embedding-scope.ts';
import type { LocalConnectorStore } from '../../connector-store/local-index.ts';
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

export function createStoreEmbeddingScopeFor(input: {
  authority: FileSourceScopeAuthority | undefined;
  sourceIdForStore: (store: LocalConnectorStore) => string;
  readScope: EmbeddingReadScope;
} & Parameters<typeof gmailStoreEmbeddingScope>[0]) {
  const policies = new Map<string, EmbeddingPolicy>([[GMAIL_SOURCE_ID, gmailStoreEmbeddingScope(input)]]);
  return (store: LocalConnectorStore, provider: SourceEmbeddingProvider | undefined) => {
    const sourceId = input.sourceIdForStore(store);
    // Use the same live registry as registeredStoreReadScope, including sources
    // registered after the worker constructed this resolver.
    const policy = policies.get(sourceId) ?? (getFileScopeSource(sourceId) ? 'approval' : 'open');
    const scopeRef = policy === 'approval' ? input.authority?.policyRef(sourceId)
      : sourceId === GMAIL_SOURCE_ID ? input.authority?.mailPolicyRef() : undefined;
    return storeEmbeddingScope({ store, provider, policy, scopeRef, authority: input.authority, readScope: input.readScope });
  };
}
