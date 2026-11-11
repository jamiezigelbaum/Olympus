import { type PeopleSenderIdentity } from '../../../core/people-index.ts';
import {
  type ConnectorStoreDeclaredPrincipal,
} from '../index.ts';
import type { SourceIndexAnswerRequest } from '../../source-index/answer-types.ts';
import {
  DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
} from '../../dropbox-files/index.ts';
import {
  LOCAL_FILES_PROVIDER,
} from '../../local-files/scope.ts';
import { LOCAL_FILES_APPROVED_SCOPE_FILTER_CODEC } from '../../local-files/approved-scope-filter.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
} from '../../telegram-messages/index.ts';
import {
  connectorStoreFilterCapabilityRegistry,
  type ConnectorStoreConversationTitleCandidates,
  type ConnectorStoreFilterCapabilityRegistry,
  type ConnectorStoreSearchFilters,
} from '../../connector-store/index.ts';
import { CHAT_SCOPE_FILTER_CODEC } from '../../chat/chat-scope-filter.ts';
import {
  type SourceFamily,
} from '../../../core/source-index/types.ts';

export function sourceAnswerAccountForCorpus(
  request: { account?: string; corpus_id?: string },
  defaults: { sourceIndexAccount?: string | undefined; telegramMessagesAccount?: string | undefined },
  corpusId?: string,
): string | undefined {
  const requested = request.account?.trim();
  if (requested) return requested;
  const effectiveCorpusId = corpusId ?? request.corpus_id;
  if (effectiveCorpusId === INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID) {
    return defaults.telegramMessagesAccount;
  }
  return defaults.sourceIndexAccount;
}

// The narrowing filters a connector-store corpus can honour on the answer
// lane, resolved through the same codecs `/source/index/search` resolves them
// with. Only the two `source_answer` wire fields are listed: folder filters and
// locator release are search-only surfaces.
const CONNECTOR_STORE_ANSWER_FILTER_CAPABILITIES = connectorStoreFilterCapabilityRegistry([
  [{ family: 'chat' }, { chatScope: CHAT_SCOPE_FILTER_CODEC }],
  [{ family: 'file', provider: 'dropbox' }, { approvedScope: DROPBOX_APPROVED_SCOPE_FILTER_CODEC }],
  [{ family: 'file', provider: LOCAL_FILES_PROVIDER }, { approvedScope: LOCAL_FILES_APPROVED_SCOPE_FILTER_CODEC }],
]);

export interface ConnectorStoreAnswerScopeStore {
  corpusId: string;
  family: SourceFamily;
  conversationTitleCandidates(
    lookupTerms: readonly string[],
    accountScope?: string,
    provider?: string,
  ): ConnectorStoreConversationTitleCandidates;
}

export type ConnectorStoreAnswerScope =
  | Readonly<{ kind: 'search'; accountScope?: string; filters?: ConnectorStoreSearchFilters }>
  | Readonly<{ kind: 'skip'; reason: string }>;

/**
 * Resolve one connector-store corpus's share of a `source_answer` request into
 * the account scope and filters its adapter must carry.
 *
 * `chat_scope` and `approved_scope_key` are narrowing filters that
 * `/source/index/search` resolves through the capability codecs and refuses
 * (400 `unsupported_filter` / `invalid_request`) when it cannot honour them.
 * The answer lane fans out instead of refusing, so the same unhonourable state
 * skips the corpus — audited `no_adapter` — rather than searching it whole. A
 * corpus whose family has no codec for a filter is not scoped BY that filter
 * (chat scope does not narrow Dropbox), which is what the legacy per-source
 * adapters did and what the wire contract describes.
 */
export function connectorStoreAnswerScope(input: {
  store: ConnectorStoreAnswerScopeStore;
  request: SourceIndexAnswerRequest;
  principal?: ConnectorStoreDeclaredPrincipal;
  capabilities?: ConnectorStoreFilterCapabilityRegistry;
  /**
   * The shared people index (#1076): a sender label that names a person also
   * matches every sender linked to that person, on every source.
   */
  people?: { senderIdentitiesFor(query: string): PeopleSenderIdentity[] };
}): ConnectorStoreAnswerScope {
  const { store, principal, request } = input;
  const capabilities = (input.capabilities ?? CONNECTOR_STORE_ANSWER_FILTER_CAPABILITIES).resolve({
    family: store.family,
    ...(principal ? { provider: principal.provider } : {}),
  });
  const requestedAccount = request.account?.trim() || undefined;
  const approvedScopeKey = request.approved_scope_key?.trim() || undefined;
  const chatScope = request.chat_scope?.trim() || undefined;
  const conversationId = request.conversation_id?.trim() || undefined;

  let accountScope: string | undefined;
  let provider: string | undefined;
  let locatorPathScope: string | undefined;
  let scopedConversationId = conversationId;

  if (approvedScopeKey && capabilities?.approvedScope) {
    if (!principal) return { kind: 'skip', reason: 'approved_scope_key_no_principal' };
    const resolution = capabilities.approvedScope.resolveLocatorPath(approvedScopeKey, principal);
    if (resolution.kind !== 'path') return { kind: 'skip', reason: 'approved_scope_key_invalid' };
    if (requestedAccount !== undefined && requestedAccount !== resolution.accountScope) {
      return { kind: 'skip', reason: 'approved_scope_key_account_mismatch' };
    }
    accountScope = resolution.accountScope;
    provider = principal.provider;
    locatorPathScope = resolution.locatorPath;
  }

  if (chatScope && capabilities?.chatScope) {
    if (!principal) return { kind: 'skip', reason: 'chat_scope_no_principal' };
    if (requestedAccount !== undefined && requestedAccount !== principal.accountScope) {
      return { kind: 'skip', reason: 'chat_scope_account_mismatch' };
    }
    const resolution = capabilities.chatScope.resolveConversationId(
      chatScope,
      (lookupTerms) => store.conversationTitleCandidates(
        lookupTerms,
        principal.accountScope,
        principal.provider,
      ),
    );
    if (resolution.kind === 'invalid') return { kind: 'skip', reason: 'chat_scope_invalid' };
    if (resolution.kind === 'structured') {
      if (resolution.provider !== undefined && resolution.provider !== principal.provider) {
        return { kind: 'skip', reason: 'chat_scope_provider_mismatch' };
      }
      if (resolution.accountScope !== principal.accountScope) {
        return { kind: 'skip', reason: 'chat_scope_account_mismatch' };
      }
    }
    if (conversationId && (!resolution.resolved || resolution.conversationId !== conversationId)) {
      return { kind: 'skip', reason: 'chat_scope_conversation_id_conflict' };
    }
    accountScope = principal.accountScope;
    provider = principal.provider;
    // An unresolved title keeps the codec's sentinel conversation id, which
    // matches no row: an unresolvable scope narrows to nothing, never to all.
    scopedConversationId = resolution.conversationId;
  }

  const senderId = request.sender_id?.trim() || undefined;
  const senderLabel = request.sender_label?.trim() || undefined;
  const authoredAfter = request.authored_after?.trim() || undefined;
  const authoredBefore = request.authored_before?.trim() || undefined;
  let senderIdentities: PeopleSenderIdentity[] = [];
  if (senderLabel && !senderId && input.people) {
    try {
      senderIdentities = input.people.senderIdentitiesFor(senderLabel);
    } catch {
      senderIdentities = [];
    }
  }
  const filters: ConnectorStoreSearchFilters = {
    ...(provider ? { provider } : {}),
    ...(locatorPathScope ? { locatorPathScope } : {}),
    ...(scopedConversationId ? { conversationId: scopedConversationId } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderLabel ? { senderLabel } : {}),
    ...(senderIdentities.length > 0 ? { senderIdentities } : {}),
    ...(authoredAfter ? { authoredAfter } : {}),
    ...(authoredBefore ? { authoredBefore } : {}),
  };
  return {
    kind: 'search',
    ...(accountScope ? { accountScope } : {}),
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  };
}

/** A Google Drive file's own page: https on drive.google.com or docs.google.com, nothing else. */
export function googleFilePage(locator: string): boolean {
  try {
    const url = new URL(locator);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === 'drive.google.com' || url.hostname === 'docs.google.com');
  } catch {
    return false;
  }
}
