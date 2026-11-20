// What each Gmail store's status counts, given the approved mail scope.
//
// Mail older than the approved window is kept as names only on purpose (the
// connector reads its subject, sender and date and never its body), so such a
// row is not owed reading. Both Gmail stores can hold one: the Personal store
// by default, the Private store when the owner's always-Private senders or a
// sensitive subject route it there. Each store's status therefore carries the
// window, and the source-neutral status machinery does the rest.
import type { ConnectorStoreStatusScope } from '../connector-store/local-index.ts';
import { readConnectedHandleRegistry, type ConnectedCredentialHandle } from '../credential-broker/connected-handles.ts';
import { gmailCursorConnectorIds } from '../google-connectors/index.ts';
import { GMAIL_IMPORTED_FILTERS, GMAIL_IMPORT_CONNECTOR_PREFIX } from '../google-connectors/gmail-archive-target.ts';
import { readSourceAccountBindings, sourceAccountBindingsPath, type SourceAccountBinding } from '../../core/source-account-binding.ts';
import { compareProviderAccounts, namesAccountByAddressOnly } from '../../core/provider-account-identity.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import { embedsOnThisComputer } from '../local-pacing.ts';
import type { FileSourceScopeAuthority, MailSourceScopePolicyRef } from '../source-scope-runtime.ts';

/** `{ contentNotBefore }` when the approval names a window, else nothing ("everything" has none). */
function contentWindow(contentAfter: string | undefined): Pick<ConnectorStoreStatusScope, 'contentNotBefore'> {
  return contentAfter ? { contentNotBefore: contentAfter } : {};
}

/**
 * The Personal (internal) Gmail store counts every row it holds, so its scope
 * carries only the window. No approved mail scope, no window: undefined, and
 * the store is counted exactly as before.
 */
export function gmailInternalStoreStatusScope(
  authority: Pick<FileSourceScopeAuthority, 'mailSnapshot'> | undefined,
): ConnectorStoreStatusScope | undefined {
  const approval = authority?.mailSnapshot();
  if (approval?.status !== 'approved') return undefined;
  const window = contentWindow(approval.mailScope?.contentAfter);
  return window.contentNotBefore ? window : undefined;
}

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
export function gmailEmbeddingPopulation(input: {
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

/** Count the same retained population the selected Private processor may index. */
export function gmailPrivateStoreStatusScope(input: {
  authority: Pick<FileSourceScopeAuthority, 'mailPolicyRef' | 'assertCurrentMail'> | undefined;
  handle: Pick<ConnectedCredentialHandle, 'accountRole'> | undefined;
  provider?: SourceEmbeddingProvider | undefined;
  gmailRetainedAccountScope: () => string | undefined;
}): ConnectorStoreStatusScope {
  const accountScope = input.gmailRetainedAccountScope();
  if (!accountScope) return { itemsAllowed: false, contentAllowed: false };
  const ref = input.handle ? input.authority?.mailPolicyRef() : undefined;
  const approval = ref ? input.authority!.assertCurrentMail(ref) : undefined;
  const population = gmailEmbeddingPopulation({ ...input, accountScope, ref, privateStore: true });
  const { filters } = population;
  return {
    accountScope, contentAllowed: true,
    ...(filters ? { itemFilters: filters, contentFilters: filters } : {}),
    ...(ref ? { scopeRevision: ref.revision } : {}),
    ...contentWindow(approval?.mailScope.contentAfter),
  };
}
