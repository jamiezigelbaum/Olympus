import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
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
    classify() {
      return buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'internal' });
    },
  };
}
