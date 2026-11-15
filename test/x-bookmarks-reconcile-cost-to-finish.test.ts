// Plan, 15 Nov 2026: a scheduled full X check that cannot finish inside the
// rest of today's budget is not started (Sparta spent its whole $2 a day on
// checks that never finished). It parks with a limit stop that says what
// finishing costs; Run once still runs it.
import { describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  XBookmarksLiveSyncError,
  createXBookmarksConnectorStoreSyncHandler,
  defaultXBookmarksLiveSyncConfig,
  type XBookmarkPost,
  type XBookmarksLiveSourceClient,
  type XBookmarksLiveSyncConfig,
} from '../src/workers/x-bookmarks/index.ts';
import { xBookmarksTestTierSet } from './helpers/lane-tier-sets.ts';

const AT = '2026-07-18T15:00:00.000Z';
const POSTS: XBookmarkPost[] = ['1', '2', '3'].map((id) => ({
  id, text: `bookmark ${id}`, createdAt: '2026-07-18T11:59:00.000Z', sourceVersion: `v-${id}`, url: `https://x.com/i/web/status/${id}`,
}));

function lane(config: XBookmarksLiveSyncConfig, usage: LocalXBookmarksApiUsageStore, reconcileStateStore: LocalXBookmarksReconcileStateStore) {
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'internal.x.bookmarks', family: 'x', trustDomain: 'internal' });
  const embedding: SourceEmbeddingProvider = {
    provider: 'test', modelId: 'test-x-embed', dimension: 3, configHash: 'test-config', epochId: 'test-epoch', backend: 'cloud',
    async embed(inputs) { return inputs.map(() => [1, 0, 0]); },
  };
  let reads = 0;
  const client: XBookmarksLiveSourceClient = {
    async fetchBookmarks() { reads += 1; return { posts: POSTS }; },
    async fetchBookmarkFolders() { return { folders: [] }; },
    async fetchBookmarksInFolder() { return { posts: [] }; },
  };
  const handler = createXBookmarksConnectorStoreSyncHandler({
    store, tierSet: xBookmarksTestTierSet(store, { embeddingProvider: embedding }), usageStore: usage, reconcileStateStore,
    embeddingProvider: embedding, sourceClient: client, account: 'personal', userId: 'provider-user-1', config,
    now: () => new Date(AT),
  });
  return { handler, reads: () => reads };
}

function config(spendMicrousd: number): XBookmarksLiveSyncConfig {
  return {
    ...defaultXBookmarksLiveSyncConfig({}),
    dailyApiRequestBudget: 10_000,
    dailyResourceReadBudget: 100_000,
    dailyEstimatedSpendMicrousd: spendMicrousd,
    headEstimatedSpendReserveMicrousd: 0,
    rateLimitLowWatermark: 0,
    estimatedUnitCostMicrousd: 1_000,
  };
}

describe('X full check cost to finish', () => {
  test('a scheduled check that would not finish today parks with its cost; Run once still runs it', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const state = new LocalXBookmarksReconcileStateStore(':memory:');
    // A first check measures the account (3 bookmarks).
    await lane(config(100_000_000), usage, state).handler.reconcile({ attempted_at: AT, provenance: 'operator' });

    // 3 posts x (3 + 1) resources x $0.001 = $0.012 to finish; the day has less left.
    const tight = lane(config(10_000), usage, state);
    let caught: unknown;
    try { await tight.handler.reconcile({ attempted_at: AT }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(XBookmarksLiveSyncError);
    const error = caught as XBookmarksLiveSyncError;
    expect(error.errorKind).toBe('api_request_guard');
    expect(error.degradedReason).toBe('reconcile_cost_to_finish_guard');
    expect(error.retryAt).toBe('2026-07-19T00:00:00.000Z');
    expect(error.counts?.limit_stop_to_continue).toBe(12_000);
    expect(tight.reads()).toBe(0);

    // Run once is never held by it.
    await tight.handler.reconcile({ attempted_at: AT, provenance: 'operator' });
    expect(tight.reads()).toBeGreaterThan(0);
  });

  test('a scheduled check that fits in the day runs', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const state = new LocalXBookmarksReconcileStateStore(':memory:');
    await lane(config(100_000_000), usage, state).handler.reconcile({ attempted_at: AT, provenance: 'operator' });
    const roomy = lane(config(100_000_000), usage, state);
    await roomy.handler.reconcile({ attempted_at: AT });
    expect(roomy.reads()).toBeGreaterThan(0);
  });
});
