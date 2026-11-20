import { describe, expect, test } from 'bun:test';
import {
  connectorStoreAnswerScope,
  type ConnectorStoreAnswerScopeStore,
} from '../src/workers/engine/runtime/answer-scope.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { answerOnThisComputer } from '../src/workers/source-index/local-answer.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';
import { createSourceAnswerLanes } from '../src/workers/engine/runtime/source-answer-lanes.ts';
import { fixtureConnector, fixtureItem } from './helpers/tier-fixtures.ts';
import { defineConnectorCorpus, LocalConnectorStore, type ConnectorStoreConversationTitleCandidates } from '../src/workers/connector-store/index.ts';

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

  test('chat scope leaves a file corpus unchanged, but an unsupported folder scope skips it', () => {
    expect(connectorStoreAnswerScope({
      store: fileStore(),
      request: { question: 'q', chat_scope: 'ClawRyderz' },
      principal: { provider: 'dropbox', accountScope: 'personal' },
    })).toEqual({ kind: 'search' });
    expect(connectorStoreAnswerScope({
      store: fileStore('note'),
      request: { question: 'q', approved_scope_key: 'reflect.personal:/Notes' },
    })).toEqual({ kind: 'skip', reason: 'approved_scope_key_unsupported' });
  });

  test('a folder-scoped answer gets matches only from stores that enforce the folder', async () => {
    const stores = ['dropbox', 'other'].map(provider => new LocalConnectorStore({
      dbPath: ':memory:', corpusId: `internal.${provider}.files`, family: 'file', trustDomain: 'internal',
    }));
    try {
      for (const [index, store] of stores.entries()) {
        const items = ['Approved', 'Elsewhere'].map(folder => {
          const item = fixtureItem({ id: `${folder}-${index}`, name: 'orchard.txt', text: 'The orchard is open.' });
          item.identity.provider = index === 0 ? 'dropbox' : 'other';
          item.metadata = { ...item.metadata, locatorUri: `/${folder}/orchard.txt` };
          return item;
        });
        await store.syncFromConnector({
          ...fixtureConnector(() => []),
          async *listItems() { yield { items, done: true }; },
        }, { fetchContent: true });
      }
      const definitions = stores.map(store => defineConnectorCorpus(store));
      const registry = buildSourceIndexCorpusRegistry(definitions);
      const makeLanes = createSourceAnswerLanes({
        stores: () => stores, registry: () => registry,
        embeddingProvider: () => undefined, localEmbedding: () => undefined, accountScope: () => undefined,
        readScope: () => ({ allowed: true, contentAllowed: true }),
        answerScope: (store, request) => connectorStoreAnswerScope({ store, request, principal: {
          provider: store === stores[0] ? 'dropbox' : 'other', accountScope: 'personal',
        } }),
      });
      const folder = 'dropbox.personal:/Approved';
      const lanes = makeLanes({ question: 'orchard', approved_scope_key: folder });
      const matches: string[] = [];
      for (const corpus of definitions) {
        const adapter = lanes.adapters[corpus.corpusId];
        if (!adapter) continue;
        const result = await adapter({ corpus, query: 'orchard', maxResults: 10, context: { allowedTrustDomains: ['internal'] } });
        matches.push(...result.hits.map(hit => hit.sourceItem.providerItemId));
      }
      expect(matches).toEqual(['Approved-0']);
      expect(lanes.excludedCorpusIds?.has(stores[1]!.corpusId)).toBe(true);
      expect(lanes.contentProviders[stores[1]!.corpusId]).toBeUndefined();
      const approvedItem = fixtureItem({ id: 'Approved-0', name: 'orchard.txt' });
      expect(lanes.adapters[stores[0]!.corpusId]!.selectedItemServable?.({ ...approvedItem.identity, provider: 'dropbox' })).toBe(true);

      // Explicitly selecting matches from outside the folder must not bypass the adapters,
      // or fall back to the in-folder match when none of the selections qualify.
      const selected = ['Elsewhere-0', 'Approved-1'].map((id, index) => ({
        corpus_id: stores[index]!.corpusId, provider: index === 0 ? 'dropbox' : 'other',
        family: 'file', account_scope: 'personal', provider_item_id: id, local_item_id: `personal:${id}`,
      }));
      const local = await answerOnThisComputer({
        question: 'orchard', selectors: { approved_scope_key: folder, selected_items: selected },
      }, {
        lanes: makeLanes, eligible: async items => items.map(() => true),
        model: { status: () => ({ state: 'ready' }), answerPrivately: async () => { throw new Error('nothing in scope'); } },
      });
      expect(local.status).toBe('not_found');
    } finally {
      for (const store of stores) store.close();
    }
  });

  test('requests the first read only for a selected Names-only file inside the requested folder', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:', corpusId: 'internal.dropbox.files', family: 'file', trustDomain: 'internal',
    });
    try {
      const items = ['Approved', 'Elsewhere'].map(folder => {
        const item = fixtureItem({ id: folder, name: 'orchard.txt' });
        item.identity.provider = 'dropbox';
        item.metadata = { ...item.metadata, locatorUri: `/${folder}/orchard.txt` };
        return item;
      });
      await store.syncFromConnector({
        ...fixtureConnector(() => []),
        async *listItems() { yield { items, done: true }; },
      });
      const registry = buildSourceIndexCorpusRegistry([defineConnectorCorpus(store)]);
      const requested: string[] = [];
      const handler = createAnalystSourceIndexAnswerHandler({
        lanes: createSourceAnswerLanes({
          stores: () => [store], registry: () => registry,
          embeddingProvider: () => undefined, localEmbedding: () => undefined, accountScope: () => undefined,
          readScope: () => ({ allowed: true, contentAllowed: false, filters: { provider: 'dropbox' } }),
          answerScope: (store, request) => connectorStoreAnswerScope({
            store, request, principal: { provider: 'dropbox', accountScope: 'personal' },
          }),
        }),
        analyst: { analyze: async () => ({ answer: '', citations: [], unanswered: [] }) },
        requestOnDemandRead: async request => {
          requested.push(request.itemRef.providerItemId);
          return { state: 'queued', etaSeconds: 60 };
        },
        onDemandReadWaitMs: 0,
      });
      await handler.answer({
        question: 'What is in the selected files?', include_internal: true, approved_scope_key: 'dropbox.personal:/Approved',
        selected_items: items.map(({ identity }) => ({
          corpus_id: store.corpusId, family: identity.family, provider: identity.provider,
          account_scope: identity.accountScope, provider_item_id: identity.providerItemId, local_item_id: identity.localItemId,
        })),
      });
      expect(requested).toEqual(['Approved']);
    } finally {
      store.close();
    }
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
