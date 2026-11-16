import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildEvidencePack, conversationWindowPerSide, CONVERSATION_WINDOW_ENV } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';

// Chats (frozen 1.5 item 9): an answer often spans several messages, and one
// found message reads out of context. A conversation hit brings the messages
// either side of it, each its own candidate.

const ACCOUNT = 'personal';
const CORPUS = 'secure_local.fake.chat';

function message(id: string, conversationId: string, minute: number, text: string): RawItem {
  return {
    identity: { family: 'chat', provider: 'whatsapp', accountScope: ACCOUNT, providerItemId: id, providerConversationId: conversationId, localItemId: `${ACCOUNT}:${id}`, sourceVersion: '1' },
    mimeType: 'text/plain',
    content: { kind: 'text', text },
    metadata: Object.freeze({ chat: conversationId, sender: 'Sam', sentAt: `2026-07-09T09:${String(minute).padStart(2, '0')}:00.000Z` }),
    fetchedAt: '2026-07-09T10:00:00Z',
  };
}

function connector(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'fake-chat', family: 'chat',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* () { yield { items, done: true }; })();
    },
    async fetchItem(localItemId: string) { return items.find((item) => item.identity.localItemId === localItemId)!; },
    classificationSignals() { return {}; },
  };
}

async function chatStore() {
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS, family: 'chat', trustDomain: 'secure_local' });
  await store.syncFromConnector(connector([
    message('m1', 'room', 1, 'Morning all.'),
    message('m2', 'room', 2, 'Did the consulate write back?'),
    message('m3', 'room', 3, 'Yes, the passport renewal appointment is booked.'),
    message('m4', 'room', 4, 'It is on Thursday at 10:30.'),
    message('m5', 'room', 5, 'Great, thanks.'),
    message('x1', 'other', 3, 'Unrelated chatter in another room.'),
  ]), { fetchContent: true });
  return store;
}

const saved = process.env[CONVERSATION_WINDOW_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[CONVERSATION_WINDOW_ENV]; else process.env[CONVERSATION_WINDOW_ENV] = saved;
});

describe('conversationNeighbours', () => {
  test('nearest first, alternating sides, same conversation only', async () => {
    const store = await chatStore();
    expect(store.conversationNeighbours(`${ACCOUNT}:m3`, 2).map((row) => row.sourceItem.providerItemId)).toEqual(['m2', 'm4', 'm1', 'm5']);
    expect(store.conversationNeighbours(`${ACCOUNT}:m1`, 1).map((row) => row.sourceItem.providerItemId)).toEqual(['m2']);
    expect(store.conversationNeighbours(`${ACCOUNT}:x1`, 2)).toEqual([]);
    expect(store.conversationNeighbours(`${ACCOUNT}:m3`, 0)).toEqual([]);
    store.close();
  });
});

describe('a pack with conversation windows', () => {
  async function pack() {
    const store = await chatStore();
    const result = await buildEvidencePack({
      question: 'When is the passport renewal appointment?',
      searchQuery: 'passport renewal',
      maxResults: 1,
      searchContext: { allowedTrustDomains: ['secure_local'] },
      registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId: CORPUS, family: 'chat', trustDomain: 'secure_local' })]),
      adapters: { [CORPUS]: createConnectorStoreCorpusAdapter({ store }) },
      contentProviders: { [CORPUS]: createConnectorStoreContentProvider({ store }) },
    });
    store.close();
    return result.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId);
  }

  test('the hit brings its neighbours right after it, the answer\'s second half included', async () => {
    process.env[CONVERSATION_WINDOW_ENV] = '1';
    const ids = await pack();
    const at = ids.indexOf('m3');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(ids.slice(at + 1, at + 3).sort()).toEqual(['m2', 'm4']);
    expect(ids).not.toContain('x1');
  });

  test('off by default', async () => {
    delete process.env[CONVERSATION_WINDOW_ENV];
    expect(await pack()).not.toContain('m4');
  });

  test('the switch reads whole numbers 0 to 10 only', () => {
    expect(conversationWindowPerSide({})).toBe(0);
    expect(conversationWindowPerSide({ [CONVERSATION_WINDOW_ENV]: '2' })).toBe(2);
    expect(conversationWindowPerSide({ [CONVERSATION_WINDOW_ENV]: '11' })).toBe(0);
  });
});

describe('a window never raises the answer\'s tier', () => {
  test('a neighbour more restricted than its hit, or in another trust domain, stays out', async () => {
    process.env[CONVERSATION_WINDOW_ENV] = '2';
    const { buildSourceSensitivity } = await import('../src/core/source-index/types.ts');
    const corpus = 'internal.fake.chat';
    const item = (id: string) => ({ family: 'chat' as const, provider: 'fixture', accountScope: ACCOUNT, providerItemId: id, providerConversationId: 'room', localItemId: id });
    const hit = (id: string) => ({ sourceItem: item(id), provenance: { sourceItem: item(id), citation: { title: id } }, rawExposed: false as const });
    const tiers: Record<string, 'S2' | 'S3' | 'S4'> = { anchor: 'S3', lower: 'S2', higher: 'S4' };
    const result = await buildEvidencePack({
      question: 'What was agreed?',
      maxResults: 1,
      searchContext: { allowedTrustDomains: ['internal'] },
      registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId: corpus, family: 'chat', trustDomain: 'internal' })]),
      adapters: { [corpus]: () => ({ hits: [hit('anchor')], latencyMs: 1, rawExposed: false as const }) },
      contentProviders: { [corpus]: {
        conversationNeighbours: () => [hit('higher'), hit('lower')],
        async fetchLocalContent(request) {
          const id = request.provenance.sourceItem.providerItemId;
          return { sensitivity: buildSourceSensitivity({ trustTier: tiers[id]!, trustDomain: 'internal' }), chunks: [`text of ${id}`] };
        },
      } },
    });
    expect(result.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId)).toEqual(['anchor', 'lower']);
  });
});
