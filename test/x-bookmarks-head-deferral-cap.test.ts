// The head lane's truncation deferral, on the second run and after.
//
// A deferral preserves the checkpoint on purpose, so the NEXT run reads the
// same traversal. With nothing durable saying "this was already read and
// refused", every later run climbed the whole page-size ladder again at full
// API cost — spending the daily budget that the deferral's own escape, a
// completed traversal, needs. The cap is one cheap overlap page per repeat,
// and a provider that recovers still advances on that page.

import { describe, expect, test } from 'bun:test';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  LocalXBookmarksApiUsageStore,
  createXBookmarksConnectorStoreSyncHandler,
  defaultXBookmarksLiveSyncConfig,
  type XBookmarkPost,
  type XBookmarksLiveSyncConfig,
} from '../src/workers/x-bookmarks/index.ts';

const ACCOUNT = 'personal';
const NOW = new Date('2026-08-17T15:00:00.000Z');

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
    modelId: 'x-head-deferral-test',
    dimension: 3,
    configHash: 'x-head-deferral-config',
    epochId: 'x-head-deferral-epoch',
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

function bookmark(id: string, text = `marker-${id}`): XBookmarkPost {
  return {
    id,
    text,
    createdAt: '2026-08-17T09:00:00.000Z',
    url: `https://x.com/i/web/status/${id}`,
  };
}

/**
 * A provider that hides the overlap behind a ladder climb and only trips the
 * truncation signature on the LAST rung.
 *
 * That ordering is what makes the deferral expensive: the earlier pages carry
 * a next token, so nothing stops the climb, and only the terminal page looks
 * truncated. Every later run pays the same multi-page climb to reach the same
 * refusal — which is the defect, and why a fixture that trips the signature on
 * page one cannot show it.
 */
function stuckProvider(pageSizes: number[], overlapId?: string) {
  // Per-client, because each scheduler tick builds its own handler and the
  // provider's paging starts over: a counter shared across runs would make the
  // second run look terminal on its first page for the wrong reason.
  let page = 0;
  return {
    async fetchBookmarks(request: { maxResults?: number } = {}) {
      const requested = request.maxResults ?? 0;
      pageSizes.push(requested);
      page += 1;
      const posts = Array.from(
        { length: requested },
        (_unused, index) => bookmark(`suspect-${page}-${index}`),
      );
      // A recovered provider serves the overlap id inside the cheap page.
      if (overlapId) posts[posts.length - 1] = bookmark(overlapId);
      return {
        posts,
        // Terminal only on the third rung, so the ladder climbs first.
        ...(overlapId || page >= 3 ? {} : { nextToken: `page-${page + 1}` }),
      };
    },
    async fetchBookmarkFolders() { return { folders: [] }; },
    async fetchBookmarksInFolder() { return { posts: [] }; },
  };
}

function handlerFor(store: LocalConnectorStore, usage: LocalXBookmarksApiUsageStore, client: ReturnType<typeof stuckProvider>) {
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

describe('head truncation deferral is bounded across runs', () => {
  test('a repeat deferral costs one cheap page instead of the whole ladder', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const pageSizes: number[] = [];
    usage.recordHeadCheckpoint(ACCOUNT, 'stored', new Date(NOW.getTime() - 60_000));
    const first = await handlerFor(store, usage, stuckProvider(pageSizes))
      .syncHead({ attempted_at: NOW.toISOString() });
    expect(first.counts.head_truncation_deferrals).toBe(1);
    // The first run is allowed its full climb: nothing yet says the traversal
    // was already read and refused.
    expect(pageSizes).toEqual([10, 15, 20]);
    const firstPages = [...pageSizes];

    const second = await handlerFor(store, usage, stuckProvider(pageSizes))
      .syncHead({ attempted_at: NOW.toISOString() });

    expect(second.counts.head_truncation_deferrals).toBe(1);
    // The second run read exactly one page, at the cheapest rung.
    expect(pageSizes.slice(firstPages.length)).toEqual([10]);
    expect(second.counts.head_pages_read).toBe(1);
    // The checkpoint is still preserved, so the traversal is still owed.
    expect(usage.headCheckpoint(ACCOUNT)).toBe('stored');
    expect(usage.headTruncationDeferredAt(ACCOUNT)).toBe(NOW.toISOString());

    usage.close();
    store.close();
  });

  test('the escape hatch still fires: a recovered provider advances on that one page', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const pageSizes: number[] = [];
    usage.recordHeadCheckpoint(ACCOUNT, 'stored', new Date(NOW.getTime() - 60_000));
    await handlerFor(store, usage, stuckProvider(pageSizes)).syncHead({ attempted_at: NOW.toISOString() });
    expect(usage.headTruncationDeferredAt(ACCOUNT)).toBe(NOW.toISOString());

    const recoveredPages: number[] = [];
    const recovered = await handlerFor(store, usage, stuckProvider(recoveredPages, 'stored'))
      .syncHead({ attempted_at: NOW.toISOString() });

    expect(recovered.counts.head_truncation_deferrals).toBe(0);
    expect(recoveredPages).toEqual([10]);
    // The completed traversal advances the checkpoint and spends the deferral.
    expect(usage.headCheckpoint(ACCOUNT)).not.toBe('stored');
    expect(usage.headTruncationDeferredAt(ACCOUNT)).toBeUndefined();

    usage.close();
    store.close();
  });
});
