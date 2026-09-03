// S5 discovered only after the body is fetched.
//
// The sync loop tombstones an item classified S5 at listing time and records a
// `secrets_tier_excluded` gap. `indexItemContent` re-classifies the fetched
// body precisely because bytes reveal more than a listing does, so the same
// rule has to hold there: a secret found on fetch must never reach chunks, the
// FTS index, or the embedding input set.

import { describe, expect, test } from 'bun:test';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { buildSourceSensitivity, type SourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

const ACCOUNT = 'personal';
const SECRET_TEXT = 'AWS_SECRET_ACCESS_KEY=uniquesecrettoken';
const PLAIN_TEXT = 'ordinary notes about the quarterly uniqueplaintoken review';

interface FileSpec {
  id: string;
  body: string;
}

function newStore(): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'secure_local.fake.files',
    family: 'file',
    trustDomain: 'secure_local',
  });
}

function listedItem(spec: FileSpec): RawItem {
  return {
    identity: {
      family: 'file',
      provider: 'fake',
      accountScope: ACCOUNT,
      providerItemId: spec.id,
      localItemId: `${ACCOUNT}:${spec.id}`,
      sourceVersion: 'rev-1',
    },
    mimeType: 'text/plain',
    // Listing carries no body, which is why the store fetches and
    // re-classifies below.
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({ name: `${spec.id}.env` }),
    fetchedAt: '2026-07-20T00:00:00.000Z',
  };
}

function fetchedItem(spec: FileSpec): RawItem {
  return { ...listedItem(spec), content: { kind: 'text', text: spec.body } };
}

// Content-dependent classification, the same shape the Dropbox connectors use:
// a listing stub scans clean, the body decides the tier.
function connector(specs: readonly FileSpec[]): SourceConnector {
  return {
    id: 'fake',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: specs.map(listedItem), done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const spec = specs.find((entry) => `${ACCOUNT}:${entry.id}` === localItemId);
      if (!spec) throw new Error(`no such item ${localItemId}`);
      return fetchedItem(spec);
    },
    classify(item: RawItem): SourceSensitivity {
      const text = item.content.kind === 'text' ? item.content.text : '';
      return buildSourceSensitivity({
        trustDomain: 'secure_local',
        trustTier: text.includes('SECRET_ACCESS_KEY') ? 'S5' : 'S4',
      });
    },
  };
}

describe('S5 revealed by a fetched body', () => {
  test('is tombstoned and reported, never chunked or indexed', async () => {
    const store = newStore();
    const summary = await store.syncFromConnector(
      connector([{ id: 'id:keys', body: SECRET_TEXT }, { id: 'id:notes', body: PLAIN_TEXT }]),
      { fetchContent: true },
    );

    expect(summary.itemsTombstoned).toBe(1);
    expect(summary.itemsIndexed).toBe(1);
    expect(summary.chunksIndexed).toBe(1);
    expect(summary.gaps.some((gap) => gap.startsWith('secrets_tier_excluded:'))).toBe(true);
    // Castor-safe: the gap identifies the item by hash, never by name or text.
    expect(summary.gaps.join('\n')).not.toContain('uniquesecrettoken');

    expect(store.searchItems('uniquesecrettoken', 10)).toHaveLength(0);
    expect(store.localContent(`${ACCOUNT}:id:keys`)).toBeUndefined();
    expect(store.searchItems('uniqueplaintoken', 10)).toHaveLength(1);
    expect(store.status().counts.chunks).toBe(1);
    expect(store.status().counts.tombstonedItems).toBe(1);
    store.close();
  });

  test('replaces a previously indexed body when the fetch first reveals the secret', async () => {
    const store = newStore();
    await store.syncFromConnector(connector([{ id: 'id:keys', body: PLAIN_TEXT }]), {
      fetchContent: true,
    });
    expect(store.searchItems('uniqueplaintoken', 10)).toHaveLength(1);

    const summary = await store.syncFromConnector(
      connector([{ id: 'id:keys', body: SECRET_TEXT }]),
      { fetchContent: true },
    );

    expect(summary.itemsTombstoned).toBe(1);
    expect(store.searchItems('uniqueplaintoken', 10)).toHaveLength(0);
    expect(store.searchItems('uniquesecrettoken', 10)).toHaveLength(0);
    expect(store.localContent(`${ACCOUNT}:id:keys`)).toBeUndefined();
    expect(store.status().counts.chunks).toBe(0);
    store.close();
  });
});
