import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  LocalXBookmarksApiUsageStore,
  XBookmarksArchiveImportError,
  X_BOOKMARKS_ARCHIVE_CONNECTOR_ID,
  X_BOOKMARKS_PROVIDER,
  createXBookmarksConnectorStoreSyncHandler,
  createXBookmarksSourceConnector,
  defaultXBookmarksLiveSyncConfig,
  readArchivedXBookmarks,
  type XBookmarkPost,
  type XBookmarksLiveSourceClient,
} from '../src/workers/x-bookmarks/index.ts';
import { xBookmarksTestTierSet } from './helpers/lane-tier-sets.ts';

const ACCOUNT = 'personal';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-x-archive-'));
  dirs.push(dir);
  return dir;
}

function post(id: string, text: string, authoredAt: string, authorUsername = 'archive_author'): XBookmarkPost {
  return { id, text, authorUsername, createdAt: authoredAt };
}

// An earlier install's store, written by the same connector-store code.
async function earlierInstallStore(posts: XBookmarkPost[]): Promise<string> {
  const path = join(tempDir(), 'x-bookmarks-connector-store.sqlite');
  const store = new LocalConnectorStore({
    dbPath: path, corpusId: 'internal.x.bookmarks', family: 'x', trustDomain: 'internal',
  });
  await store.syncFromConnector(createXBookmarksSourceConnector({ account: ACCOUNT, posts }), { fetchContent: true });
  store.close();
  return path;
}

function laneStore(): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: ':memory:', corpusId: 'internal.x.bookmarks', family: 'x', trustDomain: 'internal',
  });
}

function embeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'test', modelId: 'test-x-embed', dimension: 3, configHash: 'test-config',
    epochId: 'test-epoch', backend: 'cloud',
    async embed(inputs) { return inputs.map(() => [1, 0, 0]); },
  };
}

function handlerFor(store: LocalConnectorStore, sourceClient: XBookmarksLiveSourceClient) {
  const usage = new LocalXBookmarksApiUsageStore(':memory:');
  const embedding = embeddingProvider();
  const handler = createXBookmarksConnectorStoreSyncHandler({
    store,
    tierSet: xBookmarksTestTierSet(store, { embeddingProvider: embedding }),
    usageStore: usage,
    embeddingProvider: embedding,
    sourceClient,
    account: ACCOUNT,
    userId: 'provider-user-1',
    config: {
      ...defaultXBookmarksLiveSyncConfig({}),
      dailyApiRequestBudget: 10_000,
      dailyResourceReadBudget: 100_000,
      dailyEstimatedSpendMicrousd: 100_000_000,
      rateLimitLowWatermark: 0,
    },
    now: () => new Date('2026-11-12T12:00:00.000Z'),
  });
  return { handler, usage };
}

const NO_API: XBookmarksLiveSourceClient = {
  async fetchBookmarks() { throw new Error('the import must not call the X API'); },
  async fetchBookmarkFolders() { throw new Error('the import must not call the X API'); },
  async fetchBookmarksInFolder() { throw new Error('the import must not call the X API'); },
};

describe('importing the archived X bookmarks set', () => {
  test('reads an earlier store newest first, with text, author and post time', async () => {
    const path = await earlierInstallStore([
      post('201', 'older archived marker', '2019-03-01T00:00:00.000Z'),
      post('202', 'newest archived marker', '2026-09-22T08:00:00.000Z'),
      post('203', 'middle archived marker', '2024-01-01T00:00:00.000Z'),
    ]);
    const archived = readArchivedXBookmarks(path);
    expect(archived.posts.map((entry) => entry.id)).toEqual(['202', '203', '201']);
    expect(archived.posts[0]).toMatchObject({
      text: 'newest archived marker',
      authorUsername: 'archive_author',
      createdAt: '2026-09-22T08:00:00.000Z',
    });
    expect(archived).toMatchObject({ rowsRead: 3, rowsSkipped: 0, postsWithText: 3 });
    expect(archived.newestAuthoredAt).toBe('2026-09-22T08:00:00.000Z');
  });

  test('reads an older layout that kept the text and author on the item row', () => {
    const path = join(tempDir(), 'x-bookmarks-connector-store.sqlite');
    const db = new Database(path);
    db.exec(`CREATE TABLE items (
      provider TEXT, provider_item_id TEXT, search_text TEXT, sender_label TEXT,
      authored_at TEXT, fetched_at TEXT, tombstoned INTEGER DEFAULT 0)`);
    const insert = db.query('INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run(X_BOOKMARKS_PROVIDER, '301', 'row text marker', '@row_author', '2025-05-05T00:00:00Z', '2026-09-23T00:00:00Z', 0);
    insert.run(X_BOOKMARKS_PROVIDER, '302', 'removed marker', 'Display Name', '2025-06-06T00:00:00Z', '2026-09-23T00:00:00Z', 1);
    insert.run(X_BOOKMARKS_PROVIDER, '', 'no id', null, null, '2026-09-23T00:00:00Z', 0);
    db.close();

    const archived = readArchivedXBookmarks(path);
    expect(archived.posts).toEqual([{
      id: '301', text: 'row text marker', authorUsername: 'row_author', createdAt: '2025-05-05T00:00:00.000Z',
    }]);
    expect(archived).toMatchObject({ rowsRead: 3, rowsSkipped: 2, postsWithText: 1 });
  });

  test('refuses a relative path, a missing file and a store without X items', () => {
    expect(() => readArchivedXBookmarks('relative/store.sqlite')).toThrow(XBookmarksArchiveImportError);
    expect(() => readArchivedXBookmarks(join(tempDir(), 'absent.sqlite'))).toThrow(XBookmarksArchiveImportError);
    const path = join(tempDir(), 'other.sqlite');
    const db = new Database(path);
    db.exec('CREATE TABLE notes (id TEXT)');
    db.close();
    expect(() => readArchivedXBookmarks(path)).toThrow(XBookmarksArchiveImportError);
  });

  test('imports through the archive connector with no API call, once, and the head stops at it', async () => {
    const path = await earlierInstallStore([
      post('401', 'archived alpha marker', '2026-09-20T00:00:00.000Z'),
      post('402', 'archived beta marker', '2026-09-21T00:00:00.000Z'),
      post('403', 'archived gamma marker', '2026-09-22T00:00:00.000Z'),
    ]);
    const store = laneStore();
    const headCalls: Array<{ maxResults?: number; headOnly?: boolean; paginationToken?: string }> = [];
    let headPage: XBookmarkPost[] = [];
    const client: XBookmarksLiveSourceClient = {
      ...NO_API,
      async fetchBookmarks(request = {}) {
        headCalls.push(request);
        return { posts: headPage, nextToken: 'older-page' };
      },
    };
    const { handler, usage } = handlerFor(store, NO_API);
    const first = await handler.importArchive!({ archive_path: path });
    expect(first).toMatchObject({
      status: 'progress',
      counts: { api_requests: 0, archive_rows_read: 3, items_seen: 3, items_indexed: 3 },
    });
    expect(store.searchItems('archived beta', 5)[0]?.sourceItem.providerItemId).toBe('402');
    expect(store.itemOwnerPresent({
      family: 'x', provider: X_BOOKMARKS_PROVIDER, accountScope: ACCOUNT,
      providerItemId: '402', localItemId: `${ACCOUNT}:402`,
    }, X_BOOKMARKS_ARCHIVE_CONNECTOR_ID, 'preservation')).toBe(true);

    // Keyed by post id: a second import adds no item and no chunk.
    const itemsBefore = store.status().counts.items;
    const again = await handler.importArchive!({ archive_path: path });
    expect(again.counts).toMatchObject({ api_requests: 0, items_seen: 3, chunks_indexed: 0, chunks_embedded: 0 });
    expect(store.status().counts.items).toBe(itemsBefore);
    expect(itemsBefore).toBe(3);
    usage.close();

    // A later head pass over the same store pays only for the page it reads:
    // it indexes the new bookmark and stops at the first imported one.
    const live = handlerFor(store, client);
    headPage = [
      post('500', 'new bookmark marker', '2026-11-11T00:00:00.000Z'),
      post('403', 'archived gamma marker', '2026-09-22T00:00:00.000Z'),
      post('402', 'archived beta marker', '2026-09-21T00:00:00.000Z'),
      post('401', 'archived alpha marker', '2026-09-20T00:00:00.000Z'),
    ];
    const head = await live.handler.syncHead({ attempted_at: '2026-11-12T12:00:00.000Z' });
    expect(head.counts.items_indexed).toBe(1);
    expect(headCalls.some((request) => request.paginationToken === 'older-page')).toBe(false);
    expect(store.searchItems('new bookmark', 5)[0]?.sourceItem.providerItemId).toBe('500');
    live.usage.close();
    store.close();
  });
});
