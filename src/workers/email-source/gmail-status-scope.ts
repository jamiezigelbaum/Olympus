// What each Gmail store's status counts, given the approved mail scope.
//
// Mail older than the approved window is kept as names only on purpose (the
// connector reads its subject, sender and date and never its body), so such a
// row is not owed reading. Both Gmail stores can hold one: the Personal store
// by default, the Private store when the owner's always-Private senders or a
// sensitive subject route it there. Each store's status therefore carries the
// window, and the source-neutral status machinery does the rest.
import type { ConnectorStoreStatusScope } from '../connector-store/local-index.ts';
import type { ConnectedCredentialHandle } from '../credential-broker/connected-handles.ts';
import { gmailCursorConnectorId } from '../google-connectors/index.ts';
import { GMAIL_IMPORT_CONNECTOR_PREFIX } from '../google-connectors/gmail-archive-target.ts';
import type { FileSourceScopeAuthority } from '../source-scope-runtime.ts';

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

/**
 * The Private Gmail store counts the same approved observations the backfill
 * may embed; retained mail outside that scope is not owed work. Rows the
 * window kept as names only leave the owed population too.
 */
export function gmailPrivateStoreStatusScope(input: {
  authority: Pick<FileSourceScopeAuthority, 'mailPolicyRef' | 'assertCurrentMail'> | undefined;
  handle: Pick<ConnectedCredentialHandle, 'accountRole'> | undefined;
}): ConnectorStoreStatusScope {
  const { authority, handle } = input;
  const ref = authority?.mailPolicyRef();
  if (!ref || !handle || !authority) return { itemsAllowed: false, contentAllowed: false };
  const approval = authority.assertCurrentMail(ref);
  const accountScope = handle.accountRole?.trim() || 'personal';
  const itemFilters = {
    provider: 'gmail',
    observedConnectorId: gmailCursorConnectorId(accountScope, { generation: ref.accountGeneration, revision: ref.revision }),
    // Mail an import brought into the account counts too: the owner approved each import on its own.
    observedConnectorIdPrefix: GMAIL_IMPORT_CONNECTOR_PREFIX,
  };
  return {
    accountScope, scopeRevision: ref.revision, itemFilters, contentAllowed: true,
    contentFilters: itemFilters,
    ...contentWindow(approval.mailScope.contentAfter),
  };
}
