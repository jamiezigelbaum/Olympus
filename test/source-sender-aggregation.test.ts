import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { buildSourceSensitivity, type SourceTrustTier } from '../src/core/source-index/types.ts';
import { LocalConnectorStore, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';

const CORPUS_ID = 'internal.telegram.messages';
const ACCOUNT = 'telegram.personal';
const CONVERSATION = '-1001688680296';

describe('chat sender aggregation source surface', () => {
  test('returns ranked sender counts and coverage without returning message content', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'chat',
      trustDomain: 'internal',
    });
    try {
      await store.syncFromConnector(connector([
        item('1', 'sender-ada', 'Ada', '2026-08-20T10:00:00.000Z', 'PRIVATE FIRST BODY'),
        item('2', 'sender-ada', 'Ada Lovelace', '2026-08-21T10:00:00.000Z', 'PRIVATE SECOND BODY'),
        item('3', 'sender-grace', 'Grace', '2026-08-22T10:00:00.000Z', 'PRIVATE THIRD BODY'),
      ]), { fetchContent: true });
      const status = createSourceIndexStatusHandler({
        corpusDefinitions: [defineConnectorCorpus({
          corpusId: CORPUS_ID,
          family: 'chat',
          trustDomain: 'internal',
        })],
        connectorStores: [store],
      });
      const worker = createEmailSourceWorker({ sourceIndexStatus: status });
      const response = await worker.fetch(new Request('http://localhost/v1/source/index/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          corpus_id: CORPUS_ID,
          account: ACCOUNT,
          conversation_id: CONVERSATION,
          include_sender_aggregation: true,
          max_senders: 10,
        }),
      }));

      expect(response.status).toBe(200);
      const result = await response.json() as Record<string, unknown>;
      expect(result.sender_aggregation).toMatchObject({
        population: 'indexed_active_items',
        ranking: 'exact',
        senders: [
          { senderId: 'sender-ada', displayLabel: 'Ada Lovelace', messageCount: 2 },
          { senderId: 'sender-grace', displayLabel: 'Grace', messageCount: 1 },
        ],
        coverage: {
          providerTraversal: 'not_asserted',
          senderAttribution: 'complete',
          dateCoverage: 'complete',
          indexedItems: 3,
          unattributedItems: 0,
        },
        policy: { readOnly: true, rawSourceExposed: false, sourceTextReturned: false },
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    } finally {
      store.close();
    }
  });

  // A Personal chat store can hold a row that is Private by its own tier (a
  // lane's placement, a corpus default, misplacement). The aggregate is
  // returned for a non-Private scope, so such a row contributes no sender, no
  // label, no count and no date.
  test('rows Private by their own tier never enter the aggregate', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'chat',
      trustDomain: 'internal',
      tierLedger: null,
    });
    try {
      const privateIds = new Set([`${ACCOUNT}:${CONVERSATION}:3`, `${ACCOUNT}:${CONVERSATION}:4`]);
      await store.syncFromConnector(connector([
        item('1', 'sender-ada', 'Ada', '2026-08-20T10:00:00.000Z', 'FIRST BODY'),
        item('2', 'sender-ada', 'Ada Lovelace', '2026-08-21T10:00:00.000Z', 'SECOND BODY'),
        item('3', 'sender-orchid', 'Orchid Keeper', '2026-08-25T10:00:00.000Z', 'PRIVATE THIRD BODY'),
        item('4', 'sender-ada', 'Ada Private Alias', '2026-08-26T10:00:00.000Z', 'PRIVATE FOURTH BODY'),
      ]), {
        fetchContent: true,
        placement: (raw: RawItem) => buildSourceSensitivity({
          trustTier: privateIds.has(raw.identity.localItemId) ? 'S4' : 'S3',
          trustDomain: 'internal',
        }),
      });
      const status = createSourceIndexStatusHandler({
        corpusDefinitions: [defineConnectorCorpus({ corpusId: CORPUS_ID, family: 'chat', trustDomain: 'internal' })],
        connectorStores: [store],
      });
      const result = await status.status({
        corpus_id: CORPUS_ID,
        account: ACCOUNT,
        conversation_id: CONVERSATION,
        include_sender_aggregation: true,
      });
      const aggregation = result.sender_aggregation!;
      expect(aggregation.senders).toEqual([
        {
          senderId: 'sender-ada',
          displayLabel: 'Ada Lovelace',
          messageCount: 2,
          authoredAtFirst: '2026-08-20T10:00:00.000Z',
          authoredAtLast: '2026-08-21T10:00:00.000Z',
        },
      ]);
      expect(aggregation.coverage).toMatchObject({
        indexedItems: 2,
        attributedItems: 2,
        distinctSenders: 1,
        omittedSenders: 0,
        authoredAtLast: '2026-08-21T10:00:00.000Z',
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('orchid');
      expect(serialized).not.toContain('Orchid');
      expect(serialized).not.toContain('Private Alias');
      expect(serialized).not.toContain('2026-08-25');
      expect(serialized).not.toContain('2026-08-26');
    } finally {
      store.close();
    }
  });

  test('a row with an unknown stored tier is left out of the aggregate', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'chat',
      trustDomain: 'internal',
      tierLedger: null,
    });
    try {
      await store.syncFromConnector(connector([
        item('1', 'sender-ada', 'Ada', '2026-08-20T10:00:00.000Z', 'FIRST BODY'),
        item('2', 'sender-quartz', 'Quartz', '2026-08-22T10:00:00.000Z', 'UNKNOWN BODY'),
      ]), {
        fetchContent: true,
        placement: (raw: RawItem) => ({
          ...buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }),
          ...(raw.identity.providerItemId === '2' ? { trustTier: 'S9' as SourceTrustTier } : {}),
        }),
      });
      const aggregation = store.senderAggregation({ accountScope: ACCOUNT, conversationId: CONVERSATION });
      expect(aggregation.senders.map((sender) => sender.senderId)).toEqual(['sender-ada']);
      expect(aggregation.coverage.indexedItems).toBe(1);
    } finally {
      store.close();
    }
  });

  test('rejects an unscoped aggregation before querying a store', async () => {
    const worker = createEmailSourceWorker({
      sourceIndexStatus: createSourceIndexStatusHandler(),
    });
    const response = await worker.fetch(new Request('http://localhost/v1/source/index/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_sender_aggregation: true }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_request' },
    });
  });
});

function item(
  id: string,
  senderId: string,
  senderLabel: string,
  authoredAt: string,
  text: string,
): RawItem {
  return {
    identity: {
      family: 'chat',
      provider: 'telegram',
      accountScope: ACCOUNT,
      providerItemId: id,
      providerConversationId: CONVERSATION,
      localItemId: `${ACCOUNT}:${CONVERSATION}:${id}`,
      sourceVersion: authoredAt,
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text },
    metadata: {
      title: 'Builders',
      senderId,
      senderLabel,
      authoredAt,
    },
    fetchedAt: authoredAt,
  };
}

function connector(items: RawItem[]): SourceConnector {
  return {
    id: 'telegram-test',
    family: 'chat',
    async authenticate() {},
    listItems() {
      return (async function* () {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string) {
      const found = items.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!found) throw new Error(`missing item ${localItemId}`);
      return found;
    },
    classificationSignals() {
      return {};
    },
  };
}
