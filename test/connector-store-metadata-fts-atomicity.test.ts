// Item metadata and its keyword index are one durable step.
//
// The chunk-side half of this rule was already fixed (see
// connector-store-chunk-fts-atomicity.test.ts). The metadata-only half was
// not: `upsertItemWithOwner` committed the new title and search text in its
// own transaction and left the FTS refresh to the caller's separate call. A
// crash in between is unrepairable, and silently so — on replay the stored
// metadata already equals the incoming metadata, so `ftsMetadataChanged` is
// false, and unchanged body chunks mean the content path refreshes nothing
// either. The old title stays searchable for ever.
//
// The failure is injected by making the FTS refresh throw, which is the only
// observable difference between "two commits" and "one".

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
const BODY = 'the retro body text never changes in this file';
const FIRST_NAME = 'alphatitletoken.md';
const SECOND_NAME = 'bravotitletoken.md';

function rawItem(name: string): RawItem {
  return {
    identity: {
      family: 'file',
      provider: 'fake',
      accountScope: ACCOUNT,
      providerItemId: ITEM_ID,
      localItemId: `${ACCOUNT}:${ITEM_ID}`,
      sourceVersion: 'rev-1',
    },
    mimeType: 'text/markdown',
    content: { kind: 'text', text: BODY },
    metadata: Object.freeze({ name }),
    fetchedAt: '2026-07-20T00:00:00.000Z',
  };
}

function connector(name: string): SourceConnector {
  return {
    id: 'fake',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: [rawItem(name)], done: true };
      })();
    },
    async fetchItem(): Promise<RawItem> {
      return rawItem(name);
    },
    classify(): ReturnType<SourceConnector['classify']> {
      return buildSourceSensitivity({ trustDomain: 'secure_local', trustTier: 'S4' });
    },
  };
}

describe('item metadata and FTS refresh', () => {
  test('roll back together, so a replay still repairs the keyword index', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.fake.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
    await store.syncFromConnector(connector(FIRST_NAME), { fetchContent: true });
    expect(store.searchItems('alphatitletoken', 10)).toHaveLength(1);

    const patchable = store as unknown as { refreshFtsForItem: (itemPk: number) => number };
    const original = patchable.refreshFtsForItem;
    patchable.refreshFtsForItem = (): number => {
      throw new Error('injected crash before the FTS refresh commits');
    };
    try {
      // A metadata-only move: the body is byte-identical, only the name (and
      // therefore the title and search text) changed.
      await expect(store.syncFromConnector(connector(SECOND_NAME), { fetchContent: true }))
        .rejects.toThrow('injected crash');
    } finally {
      patchable.refreshFtsForItem = original;
    }

    // Stored metadata and searchable metadata still describe the same item.
    expect(store.searchItems('alphatitletoken', 10)).toHaveLength(1);
    expect(store.searchItems('bravotitletoken', 10)).toHaveLength(0);

    // And the store is not stuck: the replay indexes the new metadata, which
    // is precisely what a committed-metadata-without-FTS state made impossible.
    await store.syncFromConnector(connector(SECOND_NAME), { fetchContent: true });
    expect(store.searchItems('bravotitletoken', 10)).toHaveLength(1);
    expect(store.searchItems('alphatitletoken', 10)).toHaveLength(0);
    store.close();
  });
});
