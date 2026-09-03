import { createHash } from 'node:crypto';
import type {
  ConnectorStoreChatScopeFilterCodec,
  ConnectorStoreChatScopeResolution,
  ConnectorStoreConversationTitleCandidates,
} from '../connector-store/filter-capabilities.ts';
import {
  isCanonicalConnectorStoreAccountScope,
} from '../connector-store/principal.ts';

const STRUCTURED_CHAT_SCOPE_MARKER = ':chat:';
const UNRESOLVED_CHAT_TITLE_CONVERSATION_ID_PREFIX = '__chat_title_unresolved__:';
/**
 * Chat-family syntax and title interpretation for connector-store search.
 *
 * The structured/title distinction deliberately matches the grandfathered
 * Telegram lane. The shared connector-store request parser sees only the
 * resulting generic conversation id and stays source-neutral.
 */
export const CHAT_SCOPE_FILTER_CODEC: ConnectorStoreChatScopeFilterCodec = Object.freeze({
  resolveConversationId(
    value: string,
    readTitleCandidates: (lookupTerms: readonly string[]) => ConnectorStoreConversationTitleCandidates,
  ): ConnectorStoreChatScopeResolution {
    const structured = parseStructuredChatScope(value);
    if (structured) {
      return {
        kind: 'structured',
        conversationId: structured.conversationId,
        ...(structured.provider ? { provider: structured.provider } : {}),
        accountScope: structured.accountScope,
        resolved: true,
      };
    }
    if (looksLikeStructuredChatScope(value)) {
      return {
        kind: 'invalid',
        conversationId: '',
        resolved: false,
      };
    }

    const chatScope = value.trim();
    const terms = conversationTitleTerms(chatScope);
    if (terms.length === 0) return unresolvedChatTitleResolution(chatScope);
    const lookupTerms = terms.flatMap((term) => term === '4th' ? ['4th', 'fourth'] : [term]);
    const lookup = readTitleCandidates(lookupTerms);
    if (lookup.truncated) return unresolvedChatTitleResolution(chatScope);
    const rankedByConversation = new Map<string, { conversationId: string; exact: boolean; score: number }>();
    for (const candidate of lookup.candidates) {
      const score = conversationTitleMatchScore(candidate.title, terms);
      const exact = conversationTitleExactMatch(candidate.title, terms);
      if (!exact && (terms.length < 2 || score < Math.min(3, terms.length))) continue;
      const prior = rankedByConversation.get(candidate.conversationId);
      if (!prior || Number(exact) > Number(prior.exact) || (exact === prior.exact && score > prior.score)) {
        rankedByConversation.set(candidate.conversationId, {
          conversationId: candidate.conversationId,
          exact,
          score,
        });
      }
    }
    const ranked = [...rankedByConversation.values()].sort((left, right) => {
      if (left.exact !== right.exact) return left.exact ? -1 : 1;
      return right.score - left.score;
    });
    const best = ranked[0];
    if (!best || (ranked[1] && ranked[1].score === best.score)) {
      return unresolvedChatTitleResolution(chatScope);
    }
    return { kind: 'title', conversationId: best.conversationId, resolved: true };
  },
});

function parseStructuredChatScope(value: string): {
  provider?: string;
  accountScope: string;
  conversationId: string;
} | undefined {
  const parts = value.split(':');
  if (parts.length !== 3 || parts[1] !== 'chat') return undefined;
  const accountScope = parts[0]!.trim();
  const conversationId = parts[2]!.trim();
  if (
    parts[0] !== accountScope
    || parts[2] !== conversationId
    || !isCanonicalConnectorStoreAccountScope(accountScope)
    || !conversationId
  ) {
    return undefined;
  }
  const provider = accountScope.includes('.') ? accountScope.split('.', 1)[0] : undefined;
  return {
    ...(provider ? { provider } : {}),
    accountScope,
    conversationId,
  };
}

function looksLikeStructuredChatScope(value: string): boolean {
  return value.includes(STRUCTURED_CHAT_SCOPE_MARKER);
}

function unresolvedChatTitleResolution(value: string): ConnectorStoreChatScopeResolution {
  return {
    kind: 'title',
    conversationId: `${UNRESOLVED_CHAT_TITLE_CONVERSATION_ID_PREFIX}${safeDigest(value).slice(0, 24)}`,
    resolved: false,
  };
}

function safeDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function conversationTitleTerms(value: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of value.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (CHAT_TITLE_STOPWORDS.has(token) || token.length < 3) continue;
    const normalized = token === 'fourth' ? '4th' : token;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push(normalized);
  }
  return terms;
}

function conversationTitleMatchScore(title: string, terms: readonly string[]): number {
  const titleTerms = new Set(
    (title.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .map((token) => token === 'fourth' ? '4th' : token),
  );
  return terms.reduce((score, term) => score + Number(titleTerms.has(term)), 0);
}

function conversationTitleExactMatch(title: string, terms: readonly string[]): boolean {
  const titleTerms = conversationTitleTerms(title);
  return titleTerms.length === terms.length
    && titleTerms.every((term, index) => term === terms[index]);
}

const CHAT_TITLE_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'group',
  'chat',
  'named',
  'conversation',
  'telegram',
]);
