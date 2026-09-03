import { describe, expect, test } from 'bun:test';
import {
  connectorStoreAnswerScope,
  type ConnectorStoreAnswerScopeStore,
} from '../src/workers/email-source/server.ts';
import type { ConnectorStoreConversationTitleCandidates } from '../src/workers/connector-store/index.ts';

const CONVERSATIONS = [
  { conversationId: 'convo-clawryderz', title: 'ClawRyderz' },
  { conversationId: 'convo-deposit-desk', title: 'Deposit Desk' },
];

function chatStore(): ConnectorStoreAnswerScopeStore {
  return {
    corpusId: 'secure_local.fixture.whatsapp',
    family: 'chat',
    conversationTitleCandidates(lookupTerms): ConnectorStoreConversationTitleCandidates {
      return {
        candidates: CONVERSATIONS.filter((conversation) => lookupTerms.some(
          (term) => conversation.title.toLowerCase().includes(term),
        )),
        truncated: false,
      };
    },
  };
}

function fileStore(family: ConnectorStoreAnswerScopeStore['family'] = 'file'): ConnectorStoreAnswerScopeStore {
  return {
    corpusId: 'secure_local.dropbox.files',
    family,
    conversationTitleCandidates() {
      throw new Error('A file corpus must never resolve chat titles.');
    },
  };
}

// `/source/index/search` resolves chat_scope and approved_scope_key through the
// capability codecs and 400s when it cannot honour them. The answer lane fans
// out instead of refusing, so the same request must narrow the corpora that
// understand the filter and skip the ones that cannot honour it — never search
// a whole secure corpus the caller explicitly scoped down.
describe('connector-store answer lane scope', () => {
  test('narrows a chat corpus to the conversation the title resolves to', () => {
    const scope = connectorStoreAnswerScope({
      store: chatStore(),
      request: { question: 'what did we agree about the deposit', chat_scope: 'ClawRyderz' },
      principal: { provider: 'whatsapp', accountScope: 'personal' },
    });

    expect(scope).toEqual({
      kind: 'search',
      accountScope: 'personal',
      filters: { provider: 'whatsapp', conversationId: 'convo-clawryderz' },
    });
  });

  test('narrows an unresolvable chat title to nothing rather than to the whole store', () => {
    const scope = connectorStoreAnswerScope({
      store: chatStore(),
      request: { question: 'what did we agree', chat_scope: 'Some Group Nobody Has' },
      principal: { provider: 'whatsapp', accountScope: 'personal' },
    });

    expect(scope.kind).toBe('search');
    const conversationId = scope.kind === 'search' ? scope.filters?.conversationId : undefined;
    expect(conversationId).toStartWith('__chat_title_unresolved__:');
  });

  test('accepts a structured chat scope for the declared principal', () => {
    const scope = connectorStoreAnswerScope({
      store: chatStore(),
      request: { question: 'q', chat_scope: 'telegram.personal:chat:4242' },
      principal: { provider: 'telegram', accountScope: 'telegram.personal' },
    });

    expect(scope).toEqual({
      kind: 'search',
      accountScope: 'telegram.personal',
      filters: { provider: 'telegram', conversationId: '4242' },
    });
  });

  test.each([
    [
      'a chat mount with no declared principal',
      { store: chatStore(), principal: undefined, chatScope: 'ClawRyderz' },
    ],
    [
      'a structured chat scope naming another account',
      {
        store: chatStore(),
        principal: { provider: 'telegram', accountScope: 'telegram.personal' },
        chatScope: 'telegram.work:chat:4242',
      },
    ],
    [
      'a malformed structured chat scope',
      {
        store: chatStore(),
        principal: { provider: 'whatsapp', accountScope: 'personal' },
        chatScope: 'personal:chat:',
      },
    ],
  ] as const)('skips the lane for %s instead of searching it unscoped', (_label, input) => {
    const scope = connectorStoreAnswerScope({
      store: input.store,
      request: { question: 'q', chat_scope: input.chatScope },
      ...(input.principal ? { principal: input.principal } : {}),
    });

    expect(scope.kind).toBe('skip');
  });

  test('narrows a Dropbox corpus to the approved scope locator path', () => {
    const scope = connectorStoreAnswerScope({
      store: fileStore(),
      request: {
        question: 'summarize the signed agreements',
        approved_scope_key: 'dropbox.personal:/2 Areas/Legal',
      },
      principal: { provider: 'dropbox', accountScope: 'personal' },
    });

    expect(scope).toEqual({
      kind: 'search',
      accountScope: 'personal',
      filters: { provider: 'dropbox', locatorPathScope: '/2 Areas/Legal' },
    });
  });

  test.each([
    ['another account', 'dropbox.work:/2 Areas/Legal'],
    ['a folder-id form the store cannot serve', 'dropbox.personal:folder_id:abc'],
    ['a relative path', 'dropbox.personal:2 Areas/Legal'],
  ] as const)('skips the Dropbox lane for an approved_scope_key naming %s', (_label, approvedScopeKey) => {
    const scope = connectorStoreAnswerScope({
      store: fileStore(),
      request: { question: 'q', approved_scope_key: approvedScopeKey },
      principal: { provider: 'dropbox', accountScope: 'personal' },
    });

    expect(scope.kind).toBe('skip');
  });

  test('leaves a corpus whose family has no codec for the filter unnarrowed by it', () => {
    // chat_scope does not narrow Dropbox and approved_scope_key does not narrow
    // a note corpus: an inapplicable filter is not an unhonoured one, which is
    // exactly what the legacy per-source adapters did.
    expect(connectorStoreAnswerScope({
      store: fileStore(),
      request: { question: 'q', chat_scope: 'ClawRyderz' },
      principal: { provider: 'dropbox', accountScope: 'personal' },
    })).toEqual({ kind: 'search' });
    expect(connectorStoreAnswerScope({
      store: fileStore('note'),
      request: { question: 'q', approved_scope_key: 'reflect.personal:/Notes' },
    })).toEqual({ kind: 'search' });
  });

  test('still passes the plain metadata filters through untouched', () => {
    const scope = connectorStoreAnswerScope({
      store: chatStore(),
      request: {
        question: 'q',
        conversation_id: 'convo-deposit-desk',
        sender_id: 'sender-7',
        authored_after: '2026-01-01T00:00:00.000Z',
        authored_before: '2026-02-01T00:00:00.000Z',
      },
    });

    expect(scope).toEqual({
      kind: 'search',
      filters: {
        conversationId: 'convo-deposit-desk',
        senderId: 'sender-7',
        authoredAfter: '2026-01-01T00:00:00.000Z',
        authoredBefore: '2026-02-01T00:00:00.000Z',
      },
    });
  });

  test('skips a chat lane whose chat_scope contradicts an explicit conversation_id', () => {
    const scope = connectorStoreAnswerScope({
      store: chatStore(),
      request: { question: 'q', chat_scope: 'ClawRyderz', conversation_id: 'convo-deposit-desk' },
      principal: { provider: 'whatsapp', accountScope: 'personal' },
    });

    expect(scope.kind).toBe('skip');
  });
});
