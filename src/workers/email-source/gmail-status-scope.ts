import type { ConnectorStoreStatusScope } from '../connector-store/local-index.ts';
import { readConnectedHandleRegistry, type ConnectedCredentialHandle } from '../credential-broker/connected-handles.ts';
import { gmailCursorConnectorIds } from '../google-connectors/index.ts';
import { GMAIL_IMPORTED_FILTERS, GMAIL_IMPORT_CONNECTOR_PREFIX } from '../google-connectors/gmail-archive-target.ts';
import { readSourceAccountBindings, sourceAccountBindingsPath, type SourceAccountBinding } from '../../core/source-account-binding.ts';
import { compareProviderAccounts, namesAccountByAddressOnly } from '../../core/provider-account-identity.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import { embedsOnThisComputer } from '../local-pacing.ts';
import type { SourceEmbeddingScopePolicy } from '../connector-store/embedding-scope.ts';
import { SourceScopeApprovalRequiredError } from '../../core/operation-error.ts';
import { checkedEmbeddingProvider, isMailSourceScopePolicyRef, type FileSourceScopeAuthority, type MailSourceScopePolicyRef } from '../source-scope-runtime.ts';

/** Indexing reads the local account record. Connecting a role never proves who owns its history. */
export function gmailRetainedAccountMatches(input: {
  handle: Pick<ConnectedCredentialHandle, 'providerAccountId' | 'connectedAt'> | undefined;
  currentGrantVerified?: (() => boolean) | undefined;
  binding: SourceAccountBinding | undefined;
  historyAccountId: string | undefined;
}): boolean {
  const { handle, binding, historyAccountId } = input;
  if (!handle) return true;
  if (binding?.purge_required || binding?.reconnected_at) return false;
  const observed = handle.providerAccountId;
  const owners = [binding?.provider_account_id, historyAccountId].filter((id): id is string => Boolean(id));
  if (!owners.length) return false;
  if (observed && owners.every((id) => compareProviderAccounts(id, observed) === 'same')) return true;
  // An address-only grant can predate a verified rename of its bound account.
  return (!observed || namesAccountByAddressOnly(observed)) && binding?.bound_grant === handle.connectedAt
    && input.currentGrantVerified?.() === true;
}

/** Verify a selected mailbox without opening a token session or contacting Google. */
export function readGmailRetainedAccountScope(input: {
  registryPath: string;
  historyAccountId: () => string | undefined;
  currentGrantVerified?: () => boolean;
  itemScope: (handle: ConnectedCredentialHandle | undefined) => string;
}): string | undefined {
  try {
    const registry = readConnectedHandleRegistry(input.registryPath);
    const handles = registry.handles.filter((handle) => handle.provider === 'gmail');
    if (registry.dropped?.length || handles.length > 1) return undefined;
    const handle = handles[0];
    const record = readSourceAccountBindings(sourceAccountBindingsPath(input.registryPath));
    if (record.kind !== 'ok' || !gmailRetainedAccountMatches({
      handle, currentGrantVerified: input.currentGrantVerified, binding: record.bindings.sources['gmail.email'], historyAccountId: input.historyAccountId(),
    })) return undefined;
    return input.itemScope(handle);
  } catch {
    console.warn('[olympus:gmail] retained indexing paused: mailbox account record unavailable');
    return undefined;
  }
}

/** HTTP "local" and the built-in model with a remote helper both leave this device. */
function gmailEmbeddingPopulation(input: {
  provider?: SourceEmbeddingProvider | undefined;
  accountScope: string;
  ref: MailSourceScopePolicyRef | undefined;
  privateStore: boolean;
}) {
  const { provider, accountScope, ref } = input;
  if (provider?.provider === 'built-in' && provider.backend === 'local' && embedsOnThisComputer(provider)) {
    return { accountScope, filters: { provider: 'gmail' }, excludeAllEmbeddingHolds: true as const };
  }
  if (!ref) return { accountScope, filters: GMAIL_IMPORTED_FILTERS };
  if (!input.privateStore) return { accountScope };
  const ids = gmailCursorConnectorIds(accountScope, { generation: ref.accountGeneration, revision: ref.revision });
  return { accountScope, filters: {
    provider: 'gmail',
    observedConnectorId: ids.connectorId,
    previousObservedConnectorId: ids.previousId,
    observedConnectorIdPrefix: GMAIL_IMPORT_CONNECTOR_PREFIX,
  } };
}

/** Item visibility and the names-only window apply to reading and extraction as well as status. */
export function gmailReadCountScope(
  domain: string, population: NonNullable<ConnectorStoreStatusScope['embedding']>, ref: MailSourceScopePolicyRef | undefined,
  authority: FileSourceScopeAuthority | undefined,
): ConnectorStoreStatusScope {
  if (domain === 'public_safe') return {};
  const contentAfter = ref && authority?.assertCurrentMail(ref).mailScope.contentAfter;
  const window = contentAfter ? { contentNotBefore: contentAfter } : {};
  if (domain !== 'secure_local') return window;
  if (population.contentAllowed === false) return { itemsAllowed: false, contentAllowed: false };
  return {
    ...window, contentAllowed: true,
    ...(population.accountScope ? { accountScope: population.accountScope } : {}),
    ...(population.contentFilters ? { itemFilters: population.contentFilters, contentFilters: population.contentFilters } : {}),
    ...(ref ? { scopeRevision: ref.revision } : {}),
  };
}

/** Select the retained population and recheck its account at each dispatch and write. */
export function gmailStoreEmbeddingScope(deps: {
  gmailRetainedAccountScope?: () => string | undefined;
  gmailLiveProcessorVerified?: () => boolean;
}): SourceEmbeddingScopePolicy {
  return (input) => {
    const { store, scopeRef: ref, authority } = input;
    const account = deps.gmailRetainedAccountScope;
    const accountScope = account?.();
    if (!account || !accountScope) return { allowed: false, skipQueue: true };
    if (ref && (!isMailSourceScopePolicyRef(ref) || !authority)) return { allowed: false, skipQueue: true };
    const population = gmailEmbeddingPopulation({
      provider: input.provider, accountScope, ref, privateStore: store.trustDomain === 'secure_local',
    });
    return {
      ...population, allowed: true,
      bind(provider) {
        if (provider !== input.provider) throw new SourceScopeApprovalRequiredError('The selected mail processor changed before embedding.');
        return checkedEmbeddingProvider(provider, () => {
          if (account() !== accountScope) throw new SourceScopeApprovalRequiredError('The retained mail belongs to another or unverified account.');
          if (!ref || population.excludeAllEmbeddingHolds) return;
          authority!.assertCurrentMail(ref);
          if (!deps.gmailLiveProcessorVerified?.()) throw new SourceScopeApprovalRequiredError('The connected Gmail credential is awaiting account verification.');
        });
      },
    };
  };
}
