// Chunk replacement and the FTS rebuild are one durable step.
//
// `indexItemText` used to commit the replaced chunks in its own transaction
// and leave the FTS rebuild to the caller's separate commit. A crash in
// between left `connector_store_fts` holding the PRE-edit text mapped to
// chunk_pks that no longer exist, and nothing repaired it: the next pass sees
// unchanged content, reports no FTS work, and never refreshes the item again.
//
// The failure is injected by making the FTS rebuild itself throw, which is the
// only observable difference between "two commits" and "one": with one commit
// the chunk write rolls back with it, so stored text and searchable text still
// describe the same body.

import { describe, expect, test } from 'bun:test';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

const ACCOUNT = 'personal';
const ITEM_ID = 'id:retro';
const LOCAL_ITEM_ID = `${ACCOUNT}:${ITEM_ID}`;
const FIRST_BODY = 'the retro chose alphauniquetoken for the index';
const SECOND_BODY = 'the retro chose bravouniquetoken for the index';

function rawItem(text: string): RawItem {
  return {
    identity: {
      family: 'file',
      provider: 'fake',
      accountScope: ACCOUNT,
      providerItemId: ITEM_ID,
      localItemId: LOCAL_ITEM_ID,
      sourceVersion: 'rev-1',
    },
    mimeType: 'text/markdown',
    content: { kind: 'text', text },
    metadata: Object.freeze({ name: 'retro.md' }),
    fetchedAt: '2026-07-20T00:00:00.000Z',
  };
}

function connector(text: string): SourceConnector {
  return {
    id: 'fake',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: [rawItem(text)], done: true };
      })();
    },
    async fetchItem(): Promise<RawItem> {
      return rawItem(text);
    },
    classify(): ReturnType<SourceConnector['classify']> {
      return buildSourceSensitivity({ trustDomain: 'secure_local', trustTier: 'S4' });
    },
  };
}

describe('chunk replacement and FTS refresh', () => {
  test('roll back together when the rebuild fails mid-sync', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.fake.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
    await store.syncFromConnector(connector(FIRST_BODY), { fetchContent: true });
    expect(store.searchItems('alphauniquetoken', 10)).toHaveLength(1);

    const patchable = store as unknown as { refreshFtsForItem: (itemPk: number) => number };
    const original = patchable.refreshFtsForItem;
    patchable.refreshFtsForItem = (): number => {
      throw new Error('injected crash before the FTS rebuild commits');
    };
    try {
      await expect(store.syncFromConnector(connector(SECOND_BODY), { fetchContent: true }))
        .rejects.toThrow('injected crash');
    } finally {
      patchable.refreshFtsForItem = original;
    }

    // Stored chunks and searchable text still describe the same body.
    expect(store.localContent(LOCAL_ITEM_ID)?.chunks.join(' ')).toContain('alphauniquetoken');
    expect(store.searchItems('alphauniquetoken', 10)).toHaveLength(1);
    expect(store.searchItems('bravouniquetoken', 10)).toHaveLength(0);
    // No FTS row left pointing at a deleted chunk.
    expect(store.verifyCorpusIntegrity({ embeddingModelId: 'unused-model' }).counts.itemsWithFtsDeficiency)
      .toBe(0);

    // And the store is not stuck: replaying the new body indexes it normally.
    await store.syncFromConnector(connector(SECOND_BODY), { fetchContent: true });
    expect(store.searchItems('bravouniquetoken', 10)).toHaveLength(1);
    expect(store.searchItems('alphauniquetoken', 10)).toHaveLength(0);
    store.close();
  });
});
