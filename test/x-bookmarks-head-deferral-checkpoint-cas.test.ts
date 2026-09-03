// Head and reconcile run under different concurrency keys, so a head run that
// started at checkpoint A can finish after a reconcile has already recorded
// checkpoint B and spent the standing deferral. Writing the deferral
// unconditionally then leaves state that says "the traversal ending at B was
// already read and refused" about a traversal that only ever read A: every
// later head run reads one cheap page, cannot find B, and defers again — the
// lane starves past page one until the next reconcile repairs it.

import { expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import {
  LocalXBookmarksApiUsageStore,
  createXBookmarksConnectorStoreSyncHandler,
  defaultXBookmarksLiveSyncConfig,
  type XBookmarkPost,
  type XBookmarksLiveSyncConfig,
} from '../src/workers/x-bookmarks/index.ts';

const ACCOUNT = 'personal';
const NOW = new Date('2026-08-18T15:00:00.000Z');

test('a head deferral is dropped when a concurrent reconcile already moved the checkpoint', async () => {
  const store = xStore();
  const usage = new LocalXBookmarksApiUsageStore(':memory:');
  const pageSizes: number[] = [];
  usage.recordHeadCheckpoint(ACCOUNT, 'stored', new Date(NOW.getTime() - 60_000));

  // The reconcile lands while the head run is awaiting its provider page, i.e.
  // after the head run has already read `stored` as its checkpoint.
  const reconciling = truncatingProvider(pageSizes, () => {
    usage.recordHeadCheckpoint(ACCOUNT, 'reconciled', NOW);
  });
  const first = await handlerFor(store, usage, reconciling).syncHead({ attempted_at: NOW.toISOString() });

  expect(first.counts.head_truncation_deferrals).toBe(1);
  expect(usage.headCheckpoint(ACCOUNT)).toBe('reconciled');
  expect(usage.headTruncationDeferredAt(ACCOUNT)).toBeUndefined();

  // The next head run is therefore free to climb the ladder for the newer
  // checkpoint instead of repeating one cheap page it can never match.
  const secondPages: number[] = [];
  await handlerFor(store, usage, truncatingProvider(secondPages)).syncHead({ attempted_at: NOW.toISOString() });
  expect(secondPages).toEqual([10, 15, 20]);

  usage.close();
  store.close();
});

test('a head deferral still stands when the checkpoint it belongs to is current', async () => {
  const store = xStore();
  const usage = new LocalXBookmarksApiUsageStore(':memory:');
  const pageSizes: number[] = [];
  usage.recordHeadCheckpoint(ACCOUNT, 'stored', new Date(NOW.getTime() - 60_000));

  const first = await handlerFor(store, usage, truncatingProvider(pageSizes))
    .syncHead({ attempted_at: NOW.toISOString() });

  expect(first.counts.head_truncation_deferrals).toBe(1);
  expect(usage.headCheckpoint(ACCOUNT)).toBe('stored');
  expect(usage.headTruncationDeferredAt(ACCOUNT)).toBe(NOW.toISOString());

  usage.close();
  store.close();
});

function xStore(): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'internal.x.bookmarks',
    family: 'x',
    trustDomain: 'internal',
    now: () => NOW,
  });
}

function fakeEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'test',
    modelId: 'x-head-deferral-cas-test',
    dimension: 3,
    configHash: 'x-head-deferral-cas-config',
    epochId: 'x-head-deferral-cas-epoch',
    backend: 'cloud',
    async embed(inputs: SourceEmbeddingInput[]) {
      return inputs.map(() => [1, 0, 0]);
    },
  };
}

function testConfig(): XBookmarksLiveSyncConfig {
  return {
    ...defaultXBookmarksLiveSyncConfig({}),
    headPageSizeLadder: [10, 15, 20],
    maxCatchupPages: 3,
  };
}

function bookmark(id: string): XBookmarkPost {
  return {
    id,
    text: `marker-${id}`,
    createdAt: '2026-08-18T09:00:00.000Z',
    url: `https://x.com/i/web/status/${id}`,
  };
}

/** Climbs the whole ladder and trips the truncation signature on the last rung. */
function truncatingProvider(pageSizes: number[], onFirstPage?: () => void) {
  let page = 0;
  return {
    async fetchBookmarks(request: { maxResults?: number } = {}) {
      const requested = request.maxResults ?? 0;
      pageSizes.push(requested);
      page += 1;
      if (page === 1) onFirstPage?.();
      return {
        posts: Array.from(
          { length: requested },
          (_unused, index) => bookmark(`suspect-${page}-${index}`),
        ),
        ...(page >= 3 ? {} : { nextToken: `page-${page + 1}` }),
      };
    },
    async fetchBookmarkFolders() { return { folders: [] }; },
    async fetchBookmarksInFolder() { return { posts: [] }; },
  };
}

function handlerFor(
  store: LocalConnectorStore,
  usage: LocalXBookmarksApiUsageStore,
  client: ReturnType<typeof truncatingProvider>,
) {
  return createXBookmarksConnectorStoreSyncHandler({
    store,
    usageStore: usage,
    embeddingProvider: fakeEmbeddingProvider(),
    account: ACCOUNT,
    now: () => NOW,
    config: testConfig(),
    sourceClient: client,
  });
}
