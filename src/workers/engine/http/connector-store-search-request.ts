import { X_BOOKMARKS_FOLDER_FILTER_CODEC } from '../../x-bookmarks/index.ts';
import { LOCAL_FILES_APPROVED_SCOPE_FILTER_CODEC } from '../../local-files/approved-scope-filter.ts';
import { LOCAL_FILES_LOCATOR_RESULT_PROJECTOR_CODEC } from '../../local-files/locator-result-projector.ts';
import {
  DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
  DROPBOX_LOCATOR_RESULT_PROJECTOR_CODEC,
} from '../../dropbox-files/index.ts';
import {
  connectorStoreFilterCapabilityRegistry,
  LocalConnectorStore,
  type ConnectorStoreSearchFilters,
  normalizeConnectorStoreSearchFilters,
  type ConnectorStoreFilterCapabilityRegistry,
  type ConnectorStoreResultProjector,
  undeclaredConnectorStoreSearchRequestFields,
  unsupportedConnectorStoreFilterFields,
} from '../../connector-store/index.ts';
import { CHAT_SCOPE_FILTER_CODEC } from '../../chat/chat-scope-filter.ts';
import type { EmailSourceWorkerOptions } from './worker-options.ts';
import { EmailSourceWorkerError } from './worker-responses.ts';
import { asOptionalString, asOptionalNumber, asOptionalBoolean } from './request-fields.ts';
import { asOptionalRetrievalMode } from './source-index-requests.ts';

export const CONNECTOR_STORE_FILTER_CAPABILITIES = connectorStoreFilterCapabilityRegistry([
  [{ family: 'chat' }, { chatScope: CHAT_SCOPE_FILTER_CODEC }],
  [{ family: 'x' }, { folder: X_BOOKMARKS_FOLDER_FILTER_CODEC }],
  [{ family: 'file', provider: 'dropbox' }, {
    approvedScope: DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
    resultProjector: DROPBOX_LOCATOR_RESULT_PROJECTOR_CODEC,
  }],
  [{ family: 'file', provider: 'local_files' }, {
    approvedScope: LOCAL_FILES_APPROVED_SCOPE_FILTER_CODEC,
    resultProjector: LOCAL_FILES_LOCATOR_RESULT_PROJECTOR_CODEC,
  }],
]);

export interface ConnectorStoreDeclaredPrincipal {
  provider: string;
  accountScope: string;
}

export type ConnectorStoreChatPrincipal = ConnectorStoreDeclaredPrincipal;

export function requireCurrentFileEmbeddingScope(
  store: LocalConnectorStore,
  resolver: EmailSourceWorkerOptions['connectorStoreReadScope'],
): {
  accountScope: string;
  filters: ConnectorStoreSearchFilters;
  signature: string;
} {
  const current = resolver?.(store);
  if (current?.allowed !== true || current.contentAllowed !== true) {
    throw new EmailSourceWorkerError(
      403,
      'source_index_policy_violation',
      'This file source has no currently approved full-content scope for embedding.',
    );
  }
  const accountScope = current.accountScope?.trim();
  const filters = normalizeConnectorStoreSearchFilters(current.contentFilters);
  if (!accountScope || !filters) {
    throw new EmailSourceWorkerError(
      403,
      'source_index_policy_violation',
      'This file source embedding lane is missing its current account-bound content scope.',
    );
  }
  return {
    accountScope,
    filters,
    signature: JSON.stringify({ accountScope, filters }),
  };
}

export function assertSourceIndexSearchQuery(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'query must be a non-empty string.');
  }
}

export function parseConnectorStoreIndexSearchRequestRecord(
  record: Record<string, unknown>,
  store: LocalConnectorStore,
  defaultAccountScope?: string,
  chatPrincipal?: ConnectorStoreChatPrincipal,
  declaredPrincipal?: ConnectorStoreDeclaredPrincipal,
  capabilityRegistry: ConnectorStoreFilterCapabilityRegistry = CONNECTOR_STORE_FILTER_CAPABILITIES,
): {
  query: string;
  maxResults: number;
  /** Absent when the caller did not pin a mode; the route picks the default. */
  retrievalMode?: 'keyword' | 'hybrid';
  accountScope?: string;
  explicitEmptyChatScope?: boolean;
  locatorsRequested?: true;
  resultProjector?: ConnectorStoreResultProjector;
  filters?: {
    provider?: string;
    conversationId?: string;
    senderId?: string;
    senderLabel?: string;
    authoredAfter?: string;
    authoredBefore?: string;
    locatorPathScope?: string;
    searchTextExactLines?: readonly string[];
  };
} {
  const corpusId = asOptionalString(record.corpus_id);
  if (corpusId !== store.corpusId) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `corpus_id must be ${store.corpusId}.`);
  }
  if (typeof record.query !== 'string' || record.query.trim().length === 0) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'query must be a non-empty string.');
  }
  const retrievalMode = asOptionalRetrievalMode(record.retrieval_mode);
  const maxResults = asOptionalNumber(record.max_results);
  const requestedAccountScope = asOptionalNarrowingString(record, 'account')
    ?? (defaultAccountScope?.trim() || undefined);
  const requestedAccountScopeExact = asOptionalExactNarrowingString(record, 'account');
  const conversationId = asOptionalNarrowingString(record, 'conversation_id');
  const senderId = asOptionalNarrowingString(record, 'sender_id');
  const senderLabel = asOptionalNarrowingString(record, 'sender_label');
  const authoredAfter = asOptionalNarrowingString(record, 'authored_after');
  const authoredBefore = asOptionalNarrowingString(record, 'authored_before');
  const after = asOptionalNarrowingString(record, 'after');
  const before = asOptionalNarrowingString(record, 'before');
  asOptionalTrustDomainConsistency(record, store.trustDomain);
  const undeclaredFields = undeclaredConnectorStoreSearchRequestFields(record);
  if (undeclaredFields.length > 0) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      `Connector-store search request contains undeclared ${undeclaredFields.length === 1 ? 'property' : 'properties'}: ${undeclaredFields.map((field) => `"${field}"`).join(', ')}. Remove ${undeclaredFields.length === 1 ? 'it' : 'them'} and retry.`,
    );
  }
  const familyCapabilities = capabilityRegistry.resolve({
    family: store.family,
    ...(declaredPrincipal ? { provider: declaredPrincipal.provider } : {}),
  });
  const unsupportedFields = unsupportedConnectorStoreFilterFields(record, familyCapabilities);
  const unsupportedFolderFields = unsupportedFields.filter(
    (field) => field === 'folder_id' || field === 'folder_name',
  );
  if (unsupportedFolderFields.length > 0 && unsupportedFolderFields.length === unsupportedFields.length) {
    throw new EmailSourceWorkerError(
      400,
      'unsupported_filter',
      `Folder filters are not supported for connector-store family "${store.family}".`,
    );
  }
  if (unsupportedFields.length > 0) {
    const namedUnsupportedFields = [...unsupportedFields].sort();
    throw new EmailSourceWorkerError(
      400,
      'unsupported_filter',
      `${namedUnsupportedFields.length === 1 ? 'Filter' : 'Filters'} ${namedUnsupportedFields.map((field) => `"${field}"`).join(', ')} ${namedUnsupportedFields.length === 1 ? 'is' : 'are'} not supported for connector-store search of family "${store.family}". Remove ${namedUnsupportedFields.length === 1 ? 'it' : 'them'} and retry.`,
    );
  }
  if (authoredAfter !== undefined && after !== undefined) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot specify both "after" and "authored_after". Remove one and retry.',
    );
  }
  if (authoredBefore !== undefined && before !== undefined) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot specify both "before" and "authored_before". Remove one and retry.',
    );
  }
  const folderCodec = familyCapabilities?.folder;
  const chatScopeCodec = familyCapabilities?.chatScope;
  const approvedScopeCodec = familyCapabilities?.approvedScope;
  const resultProjectorCodec = familyCapabilities?.resultProjector;
  const includeLocators = resultProjectorCodec
    ? asOptionalBoolean(record.include_locators)
    : undefined;
  const approvedScopeKey = approvedScopeCodec
    ? asOptionalExactNarrowingString(record, 'approved_scope_key')
    : undefined;
  const chatScope = chatScopeCodec
    ? asOptionalExactNarrowingString(record, 'chat_scope')
    : undefined;
  const folderId = asOptionalNarrowingString(record, 'folder_id');
  const folderName = asOptionalNarrowingString(record, 'folder_name');
  const resolvedAuthoredAfter = authoredAfter ?? after;
  const resolvedAuthoredBefore = authoredBefore ?? before;
  if (approvedScopeKey && !declaredPrincipal) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'The "approved_scope_key" capability is not configured with a declared connector-store principal.',
    );
  }
  if (includeLocators === true && !declaredPrincipal) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'The "include_locators" capability is not configured with a declared connector-store principal.',
    );
  }
  const approvedScopeResolution = approvedScopeKey && approvedScopeCodec && declaredPrincipal
    ? approvedScopeCodec.resolveLocatorPath(approvedScopeKey, declaredPrincipal)
    : undefined;
  if (approvedScopeResolution?.kind === 'invalid') {
    throw new EmailSourceWorkerError(400, 'invalid_request', approvedScopeResolution.message);
  }
  if (
    approvedScopeResolution?.kind === 'path'
    && requestedAccountScopeExact !== undefined
    && requestedAccountScopeExact !== approvedScopeResolution.accountScope
  ) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot combine "account" with an "approved_scope_key" for another account.',
    );
  }
  if (
    includeLocators === true
    && requestedAccountScopeExact !== undefined
    && requestedAccountScopeExact !== declaredPrincipal!.accountScope
  ) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store locator release cannot combine "account" with a different mounted corpus account.',
    );
  }
  if (chatScope && !chatPrincipal) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'The "chat_scope" capability is not configured for this connector-store corpus.',
    );
  }
  if (
    chatScope
    && requestedAccountScopeExact !== undefined
    && requestedAccountScopeExact !== chatPrincipal!.accountScope
  ) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot combine "account" with a "chat_scope" for another account.',
    );
  }
  const chatScopeResolution = chatScope && chatScopeCodec
    ? chatScopeCodec.resolveConversationId(
        chatScope,
        (lookupTerms) => store.conversationTitleCandidates(
          lookupTerms,
          chatPrincipal!.accountScope,
          chatPrincipal!.provider,
        ),
      )
    : undefined;
  if (chatScopeResolution?.kind === 'invalid') {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Structured "chat_scope" must use account-scope-prefix:chat:conversation with non-empty segments and no extra segments.',
    );
  }
  if (
    chatScopeResolution?.kind === 'structured'
    && requestedAccountScopeExact !== undefined
    && requestedAccountScopeExact !== chatScopeResolution.accountScope
  ) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot combine "account" with a "chat_scope" for another account.',
    );
  }
  if (chatScopeResolution?.kind === 'structured') {
    if (
      chatScopeResolution.provider !== undefined
      && chatScopeResolution.provider !== chatPrincipal!.provider
    ) {
      throw new EmailSourceWorkerError(
        400,
        'invalid_request',
        'Structured "chat_scope" provider does not match the selected connector-store corpus.',
      );
    }
    if (chatScopeResolution.accountScope !== chatPrincipal!.accountScope) {
      throw new EmailSourceWorkerError(
        400,
        'invalid_request',
        'Structured "chat_scope" account does not match the selected connector-store corpus account.',
      );
    }
  }
  const accountScope = chatScopeResolution?.kind === 'structured'
    ? chatScopeResolution.accountScope
    : approvedScopeResolution?.kind === 'path'
      ? approvedScopeResolution.accountScope
      : includeLocators === true
        ? declaredPrincipal!.accountScope
      : chatScope
        ? chatPrincipal!.accountScope
        : requestedAccountScope;
  if (
    conversationId
    && chatScopeResolution
    && (!chatScopeResolution.resolved || chatScopeResolution.conversationId !== conversationId)
  ) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot combine "chat_scope" with a contradictory or unresolved "conversation_id". Remove one and retry.',
    );
  }
  const resolvedConversationId = chatScopeResolution?.conversationId ?? conversationId;
  let filters: ReturnType<typeof normalizeConnectorStoreSearchFilters>;
  try {
    const searchTextExactLines = [
      ...(folderId && folderCodec ? [folderCodec.folderIdExactLine(folderId)] : []),
      ...(folderName && folderCodec ? [folderCodec.folderNameExactLine(folderName)] : []),
    ];
    filters = normalizeConnectorStoreSearchFilters({
      ...(approvedScopeResolution?.kind === 'path'
        ? {
            provider: declaredPrincipal!.provider,
            locatorPathScope: approvedScopeResolution.locatorPath,
          }
        : includeLocators === true
          ? { provider: declaredPrincipal!.provider }
        : chatScope
          ? { provider: chatPrincipal!.provider }
          : {}),
      ...(resolvedConversationId ? { conversationId: resolvedConversationId } : {}),
      ...(senderId ? { senderId } : {}),
      ...(senderLabel ? { senderLabel } : {}),
      ...(resolvedAuthoredAfter ? { authoredAfter: resolvedAuthoredAfter } : {}),
      ...(resolvedAuthoredBefore ? { authoredBefore: resolvedAuthoredBefore } : {}),
      ...(searchTextExactLines.length > 0 ? { searchTextExactLines } : {}),
    });
  } catch (error) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      error instanceof Error ? error.message : 'Connector-store metadata filters are invalid.',
    );
  }
  return {
    query: record.query,
    maxResults: maxResults ?? 10,
    ...(retrievalMode !== undefined ? { retrievalMode } : {}),
    ...(accountScope ? { accountScope } : {}),
    ...(chatScopeResolution?.kind === 'title' && !chatScopeResolution.resolved
      ? { explicitEmptyChatScope: true }
      : {}),
    ...(includeLocators === true
      ? {
          locatorsRequested: true as const,
          resultProjector: resultProjectorCodec!.create({
            principal: declaredPrincipal!,
            ...(approvedScopeKey !== undefined ? { approvedScopeKey } : {}),
          }),
        }
      : {}),
    ...(filters ? { filters } : {}),
  };
}

function asOptionalNarrowingString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      `${key} must be a non-empty string when provided.`,
    );
  }
  return value.trim();
}

function asOptionalTrustDomainConsistency(
  record: Readonly<Record<string, unknown>>,
  expectedTrustDomain: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'trust_domain')) return undefined;
  const value = record.trust_domain;
  if (typeof value !== 'string' || value !== expectedTrustDomain) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'trust_domain does not exactly match the selected corpus trust domain.',
    );
  }
  return value;
}

function asOptionalExactNarrowingString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      `${key} must be a non-empty string when provided.`,
    );
  }
  return value;
}
