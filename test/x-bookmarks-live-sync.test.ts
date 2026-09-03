import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  XApiClient,
  XApiError,
  XApiUsageGuardError,
  XBookmarksLiveSyncError,
  X_BOOKMARKS_ARCHIVE_CONNECTOR_ID,
  X_BOOKMARKS_FOLDER_PROVIDER_OUTAGE_WARNING,
  X_BOOKMARKS_LIVE_CONNECTOR_ID,
  X_BOOKMARKS_PROVIDER,
  createXBookmarksConnectorStoreSyncHandler,
  createXBookmarksApiSourceConnector,
  createXBookmarksSourceConnector,
  defaultXBookmarksLiveSyncConfig,
  type XBookmarkFolderPage,
  type XBookmarkPost,
  type XBookmarkPostPage,
  type XBookmarksLiveSourceClient,
  type XBookmarksLiveSyncConfig,
} from '../src/workers/x-bookmarks/index.ts';
import { seedCanonicalXBookmarksSnapshot } from './helpers/x-bookmarks-reconcile.ts';

const ACCOUNT = 'personal';

describe('X bookmarks thin connector', () => {
  test('normalizes API and archive snapshots to stable provider identity with distinct connector owners', async () => {
    const post = {
      ...bookmark('101', 'thin connector marker', 'connector_author'),
      authorId: 'author-101',
      authorName: 'Connector Author',
      url: 'https://x.com/connector_author/status/101',
    };
    const live = createXBookmarksSourceConnector({ account: ACCOUNT, posts: [post] });
    const archive = createXBookmarksSourceConnector({
      account: ACCOUNT,
      posts: [post],
      connectorId: X_BOOKMARKS_ARCHIVE_CONNECTOR_ID,
    });
    expect(live.id).toBe(X_BOOKMARKS_LIVE_CONNECTOR_ID);
    expect(archive.id).toBe(X_BOOKMARKS_ARCHIVE_CONNECTOR_ID);
    const page = await firstPage(live);
    expect(page.items[0]).toMatchObject({
      identity: {
        family: 'x',
        provider: X_BOOKMARKS_PROVIDER,
        providerItemId: '101',
        localItemId: 'personal:101',
      },
      content: { kind: 'text', text: 'thin connector marker' },
      metadata: {
        locatorUri: 'https://x.com/i/web/status/101',
        originalUrl: 'https://x.com/connector_author/status/101',
        senderId: 'author-101',
        senderLabel: 'Connector Author',
      },
    });
    expect(page.items[0]?.identity.providerConversationId).toBeUndefined();
    expect(live.classify(page.items[0]!)).toMatchObject({ trustTier: 'S1', trustDomain: 'internal' });
  });

  test('real connector owns the rich overlap-aware head listing', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const calls: Array<{ maxResults?: number; headOnly?: boolean }> = [];
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks(request = {}) {
        calls.push(request);
        return request.headOnly
          ? { posts: [{ id: '2' }] }
          : { posts: [bookmark('2', 'real connector marker'), bookmark('1', 'old')] };
      },
      async fetchBookmarkFolders() { return { folders: [] }; },
      async fetchBookmarksInFolder() { return { posts: [] }; },
    };
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental',
      account: ACCOUNT,
      attemptedAt: new Date('2026-07-18T12:00:00.000Z'),
      now: () => new Date('2026-07-18T12:00:00.000Z'),
      usageStore: usage,
      sourceClient: client,
      config: testConfig(),
    });
    const page = await firstPageWithCursor(connector, '1');
    expect(calls).toEqual([{ maxResults: 10 }]);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.identity).toMatchObject({ provider: 'x', providerItemId: '2' });
    expect(connector.status()).toMatchObject({ mode: 'incremental', complete: true, checkpoint: '2' });
    usage.close();
  });

  test('first-run head fetch starts at ten and accepts a genuinely short end-of-list', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const calls: Array<{ maxResults?: number; headOnly?: boolean }> = [];
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks(request = {}) {
        calls.push(request);
        return { posts: [bookmark('50', 'bootstrap newest')] };
      },
      async fetchBookmarkFolders() { return { folders: [] }; },
      async fetchBookmarksInFolder() { return { posts: [] }; },
    };
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental', account: ACCOUNT,
      attemptedAt: new Date('2026-07-18T12:00:00.000Z'),
      now: () => new Date('2026-07-18T12:00:00.000Z'),
      usageStore: usage, sourceClient: client, config: testConfig(),
    });
    const page = await firstPageWithCursor(connector, '');
    expect(calls).toEqual([{ maxResults: 10 }]);
    expect(page.items.map((item) => item.identity.providerItemId)).toEqual(['50']);
    expect(connector.status().warnings).toEqual([]);
    usage.close();
  });

  test('a first activation reads one ladder page and leaves history to reconciliation', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const calls: Array<{ maxResults?: number; paginationToken?: string }> = [];
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental',
      account: ACCOUNT,
      attemptedAt: new Date('2026-08-17T10:00:00.000Z'),
      now: () => new Date('2026-08-17T10:00:00.000Z'),
      usageStore: usage,
      config: testConfig(),
      sourceClient: {
        async fetchBookmarks(request = {}) {
          calls.push(request);
          return {
            posts: Array.from({ length: 10 }, (_, index) => bookmark(
              `boot-${index}`,
              `bootstrap marker ${index}`,
            )),
            nextToken: 'historical-page',
          };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
    });

    // Nothing is stored yet, so no page can contain an overlap and the ladder
    // has no stopping condition. The fast lane still refuses to become a
    // quasi-full sync on a missing checkpoint.
    const page = await firstPageWithCursor(connector, '');
    expect(calls).toEqual([{ maxResults: 10 }]);
    expect(page.items).toHaveLength(10);
    expect(connector.status()).toMatchObject({
      changed: true,
      checkpoint: 'boot-0',
      warnings: [],
      counts: { headPagesRead: 1, headPageSizesUsed: [10], headTruncationDeferrals: 0 },
    });
    usage.close();
  });

  test('a first activation takes the checkpoint even from a suspicious terminal page', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental',
      account: ACCOUNT,
      attemptedAt: new Date('2026-08-17T10:30:00.000Z'),
      now: () => new Date('2026-08-17T10:30:00.000Z'),
      usageStore: usage,
      config: testConfig(),
      sourceClient: {
        async fetchBookmarks() {
          return {
            posts: Array.from({ length: 10 }, (_, index) => bookmark(
              `boot-${index}`,
              `bootstrap marker ${index}`,
            )),
          };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
    });

    // Deferral exists to preserve a checkpoint. There is none to preserve
    // here, and refusing the newest identity would strand the lane on the
    // same page every hour until the next reconciliation.
    expect(await connector.probe()).toMatchObject({
      changed: true,
      checkpoint: 'boot-0',
      warnings: [],
      counts: { headTruncationDeferrals: 0 },
    });
    usage.close();
  });

  test('reports a suspicious terminal head page when the checkpoint is not found', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    usage.recordHeadCheckpoint(ACCOUNT, 'older-checkpoint', new Date('2026-07-18T11:00:00.000Z'));
    const visible = Array.from({ length: 10 }, (_, index) => bookmark(
      `head-window-${index}`,
      `head window ${index}`,
    ));
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental',
      account: ACCOUNT,
      attemptedAt: new Date('2026-07-18T11:01:00.000Z'),
      now: () => new Date('2026-07-18T11:01:00.000Z'),
      usageStore: usage,
      config: testConfig(),
      sourceClient: {
        async fetchBookmarks(request = {}) {
          return { posts: visible };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
    });
    expect(await connector.probe()).toMatchObject({
      changed: true,
      checkpoint: 'older-checkpoint',
      warnings: ['x_head_truncation_suspected_deferred_checkpoint_preserved'],
      counts: { headTruncationDeferrals: 1, headPageSizesUsed: [10] },
    });
    usage.close();
  });

  test('escalates all-new head pages 10 -> 20 -> 40 and stops on the first overlap', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const calls: Array<{ maxResults?: number; paginationToken?: string }> = [];
    const page = (prefix: string, count: number) => Array.from(
      { length: count },
      (_, index) => bookmark(`${prefix}-${index}`, `${prefix} marker ${index}`),
    );
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental',
      account: ACCOUNT,
      attemptedAt: new Date('2026-08-17T12:00:00.000Z'),
      now: () => new Date('2026-08-17T12:00:00.000Z'),
      usageStore: usage,
      config: testConfig(),
      sourceClient: {
        async fetchBookmarks(request = {}) {
          calls.push(request);
          if (!request.paginationToken) {
            return { posts: page('first', 10), nextToken: 'second' };
          }
          if (request.paginationToken === 'second') {
            return { posts: page('second', 20), nextToken: 'third' };
          }
          return {
            posts: [...page('third', 5), bookmark('stored', 'stored overlap'), ...page('older', 3)],
            nextToken: 'must-not-be-read',
          };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
    });

    const result = await firstPageWithCursor(connector, 'stored');
    expect(calls).toEqual([
      { maxResults: 10 },
      { maxResults: 20, paginationToken: 'second' },
      { maxResults: 40, paginationToken: 'third' },
    ]);
    expect(result.items).toHaveLength(35);
    expect(connector.status()).toMatchObject({
      changed: true,
      checkpoint: 'first-0',
      counts: {
        apiRequests: 3,
        itemsSeen: 35,
        headPagesRead: 3,
        headTruncationDeferrals: 0,
        headPageSizesUsed: [10, 20, 40],
      },
    });
    usage.close();
  });

  test('stops the typical head run on first-page overlap and bills every returned item', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const now = new Date('2026-08-17T13:00:00.000Z');
    const calls: Array<{ maxResults?: number; paginationToken?: string }> = [];
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental',
      account: ACCOUNT,
      attemptedAt: now,
      now: () => now,
      usageStore: usage,
      config: testConfig(),
      sourceClient: {
        async fetchBookmarks(request = {}) {
          calls.push(request);
          return {
            posts: [bookmark('stored', 'stored overlap'), ...Array.from(
              { length: 9 },
              (_, index) => bookmark(`older-${index}`, `older marker ${index}`),
            )],
            nextToken: 'must-not-be-read',
          };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
    });

    const result = await firstPageWithCursor(connector, 'stored');
    expect(calls).toEqual([{ maxResults: 10 }]);
    expect(result.items).toEqual([]);
    expect(connector.status().counts).toMatchObject({
      apiRequests: 1,
      itemsSeen: 0,
      headPagesRead: 1,
      headPageSizesUsed: [10],
    });
    expect(usage.status({ account: ACCOUNT, config: testConfig(), now })).toMatchObject({
      resource_reads: 10,
      estimated_billable_resources: 10,
      estimated_spend_microusd: 10_000,
    });
    usage.close();
  });

  test('clamps the head ladder to catch-up item and page bounds', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const calls: number[] = [];
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental',
      account: ACCOUNT,
      attemptedAt: new Date('2026-08-17T14:00:00.000Z'),
      now: () => new Date('2026-08-17T14:00:00.000Z'),
      usageStore: usage,
      config: testConfig({ maxCatchupItems: 25, maxCatchupPages: 2 }),
      sourceClient: {
        async fetchBookmarks(request = {}) {
          const requested = request.maxResults ?? 0;
          calls.push(requested);
          return {
            posts: Array.from(
              { length: requested },
              (_, index) => bookmark(`page-${calls.length}-${index}`, `bounded marker ${index}`),
            ),
            nextToken: `page-${calls.length + 1}`,
          };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
    });

    const result = await firstPageWithCursor(connector, 'stored');
    expect(calls).toEqual([10, 15]);
    expect(result.items).toHaveLength(25);
    expect(connector.status()).toMatchObject({
      warnings: ['x_head_catchup_bounded_daily_reconcile_required'],
      counts: { headPagesRead: 2, headPageSizesUsed: [10, 15] },
    });
    usage.close();
  });

  test('defers a suspicious terminal head page to the next run without advancing overlap', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const now = new Date('2026-08-17T15:00:00.000Z');
    const originalCheckpointAt = new Date(now.getTime() - 60_000);
    usage.recordHeadCheckpoint(ACCOUNT, 'stored', originalCheckpointAt);
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: fakeEmbeddingProvider(),
      account: ACCOUNT,
      now: () => now,
      config: testConfig(),
      sourceClient: {
        async fetchBookmarks(request = {}) {
          const requested = request.maxResults ?? 0;
          return {
            posts: Array.from(
              { length: requested },
              (_, index) => bookmark(`suspect-${index}`, `suspect marker ${index}`),
            ),
          };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
    });

    await expect(handler.syncHead({ attempted_at: now.toISOString() })).resolves.toMatchObject({
      status: 'progress',
      counts: {
        api_requests: 1,
        items_seen: 10,
        items_indexed: 10,
        head_pages_read: 1,
        head_page_1_max_results: 10,
        head_truncation_deferrals: 1,
      },
      warnings: ['x_head_truncation_suspected_deferred_checkpoint_preserved'],
    });
    expect(usage.headCheckpoint(ACCOUNT)).toBe('stored');
    expect(usage.headCheckpointState(ACCOUNT)).toEqual({
      checkpoint: 'stored',
      completedAt: originalCheckpointAt.toISOString(),
    });
    usage.close();
    store.close();
  });

  test('a green reconcile wins the R52 interleaving after a concurrent head deferral', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const state = new LocalXBookmarksReconcileStateStore(':memory:');
    usage.recordHeadCheckpoint(ACCOUNT, 'stale-checkpoint', new Date('2026-08-17T11:59:00.000Z'));

    let releaseHead!: () => void;
    let headRequested!: () => void;
    const headRelease = new Promise<void>((resolve) => { releaseHead = resolve; });
    const headStarted = new Promise<void>((resolve) => { headRequested = resolve; });
    const head = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      reconcileStateStore: state,
      embeddingProvider: fakeEmbeddingProvider(),
      account: ACCOUNT,
      now: () => new Date('2026-08-17T12:01:00.000Z'),
      config: testConfig(),
      sourceClient: {
        async fetchBookmarks(request = {}) {
          headRequested();
          await headRelease;
          return {
            posts: Array.from(
              { length: request.maxResults ?? 10 },
              (_, index) => bookmark(`deferred-${index}`, `deferred marker ${index}`),
            ),
          };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
    });
    const reconcile = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      reconcileStateStore: state,
      embeddingProvider: fakeEmbeddingProvider(),
      account: ACCOUNT,
      userId: 'provider-user-1',
      now: () => new Date('2026-08-17T12:00:00.000Z'),
      config: testConfig(),
      sourceClient: {
        async fetchBookmarks() { return { posts: [bookmark('reconcile-newest', 'reconcile marker')] }; },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
    });

    const deferredHead = head.syncHead({ attempted_at: '2026-08-17T12:01:00.000Z' });
    await headStarted;
    await expect(reconcile.reconcile({ attempted_at: '2026-08-17T12:00:00.000Z' }))
      .resolves.toMatchObject({ authority: { global_current_authority: 'green' } });
    expect(usage.headCheckpoint(ACCOUNT)).toBe('reconcile-newest');
    releaseHead();
    await expect(deferredHead).resolves.toMatchObject({
      warnings: ['x_head_truncation_suspected_deferred_checkpoint_preserved'],
    });
    expect(usage.headCheckpointState(ACCOUNT)).toEqual({
      checkpoint: 'reconcile-newest',
      completedAt: '2026-08-17T12:00:00.000Z',
    });
    state.close();
    usage.close();
    store.close();
  });
});

describe('X bookmarks two-speed connector-store sync', () => {
  test('head-checks ten items, catches up only before overlap, embeds new items, and no-ops', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const embedding = fakeEmbeddingProvider();
    const calls: Array<{ maxResults?: number; paginationToken?: string; headOnly?: boolean }> = [];
    const newest = bookmark('103', 'near real time bookmark marker', 'fast_author');
    const middle = bookmark('102', 'middle catchup marker');
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks(request = {}) {
        calls.push(request);
        if (request.headOnly) return { posts: [{ id: newest.id }] };
        return { posts: [newest, middle, bookmark('101', 'old checkpoint')] };
      },
      async fetchBookmarkFolders() { return { folders: [] }; },
      async fetchBookmarksInFolder() { return { posts: [] }; },
    };
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: embedding,
      sourceClient: client,
      account: ACCOUNT,
      userId: 'provider-user-1',
      config: testConfig(),
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });

    const changed = await handler.syncHead({
      attempted_at: '2026-07-18T12:00:00.000Z',
      checkpoint: '101',
    });
    expect(calls).toEqual([
      { maxResults: 10 },
    ]);
    expect(changed).toMatchObject({
      status: 'progress',
      counts: {
        api_requests: 1,
        items_indexed: 2,
        chunks_embedded: 2,
        head_pages_read: 1,
        head_page_1_max_results: 10,
      },
    });
    expect(changed).not.toHaveProperty('checkpoint');
    expect(changed).not.toHaveProperty('sync');
    expect(store.searchItems('near real time', 5)[0]?.sourceItem).toMatchObject({
      provider: 'x',
      providerItemId: '103',
    });
    expect(store.searchItems('fast_author', 5)[0]?.sourceItem.providerItemId).toBe('103');
    expect(usage.headCheckpoint(ACCOUNT)).toBe('103');
    expect(embedding.embedCalls).toHaveLength(1);

    const noChange = await handler.syncHead({ attempted_at: '2026-07-18T12:00:30.000Z' });
    expect(noChange).toMatchObject({ status: 'idle', counts: { api_requests: 1 } });
    expect(noChange).not.toHaveProperty('checkpoint');
    expect(calls.at(-1)).toEqual({ maxResults: 10 });
    expect(embedding.embedCalls).toHaveLength(1);
    expect(store.status().counts.syncRuns).toBe(1);

    usage.close();
    store.close();
  });

  test('first recency-window traversal preserves pre-window state and ignores folder-only anomalies', async () => {
    const reconciliationAt = new Date('2026-07-18T12:00:00.000Z');
    const store = xStore(() => new Date('2026-07-18T11:59:00.000Z'));
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const embedding = fakeEmbeddingProvider();
    await store.syncFromConnector(createXBookmarksSourceConnector({
      account: ACCOUNT,
      posts: [bookmark('archive-only', 'archive preservation marker')],
      connectorId: X_BOOKMARKS_ARCHIVE_CONNECTOR_ID,
    }), { fetchContent: true, ownershipKind: 'preservation' });
    await store.syncFromConnector(createXBookmarksSourceConnector({
      account: ACCOUNT,
      posts: [bookmark('removed-live', 'removed live marker')],
    }), { fetchContent: true });

    const current = bookmark('current', 'current global marker');
    const folderOnly = bookmark('folder-only', 'folder endpoint only marker');
    let folderName = 'Robotics Research';
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks() { return { posts: [current] }; },
      async fetchBookmarkFolders() { return { folders: [{ id: 'zephyrfolder42', name: folderName }] }; },
      async fetchBookmarksInFolder(folderId) {
        expect(folderId).toBe('zephyrfolder42');
        return { posts: [current, folderOnly] };
      },
    };
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: embedding,
      sourceClient: client,
      account: ACCOUNT,
      userId: 'provider-user-1',
      config: testConfig(),
      now: () => reconciliationAt,
    });
    const result = await handler.reconcile({ attempted_at: reconciliationAt.toISOString() });

    expect(result).toMatchObject({
      status: 'progress',
      counts: {
        items_seen: 1,
        items_tombstoned: 0,
        folders_seen: 1,
        folder_memberships_seen: 1,
        folder_posts_absent_from_global: 1,
        global_traversal_exhausted: 1,
        removal_authoritative: 1,
      },
      warnings: [
        'x_reconcile_folder_post_absent_from_global_ignored',
        'x_reconcile_provider_window_boundary_verified',
      ],
    });
    expect(store.searchItems('removed live', 5)).toHaveLength(1);
    expect(store.searchItems('archive preservation', 5)).toHaveLength(1);
    expect(store.searchItems('folder endpoint only', 5)
      .some((row) => row.sourceItem.providerItemId === 'folder-only')).toBe(false);
    expect(new Set(store.searchItems('Robotics Research', 5).map((row) => row.sourceItem.providerItemId)))
      .toEqual(new Set(['current']));
    expect(new Set(store.searchItems('zephyrfolder42', 5).map((row) => row.sourceItem.providerItemId)))
      .toEqual(new Set(['current']));
    expect(handler.lastCompleteReconcileAt()).toBe(reconciliationAt.toISOString());

    folderName = 'Machine Intelligence';
    await handler.reconcile({
      attempted_at: new Date(reconciliationAt.getTime() + 5 * 60_000).toISOString(),
    });
    expect(store.searchItems('Robotics Research', 5)).toHaveLength(0);
    expect(new Set(store.searchItems('Machine Intelligence', 5).map((row) => row.sourceItem.providerItemId)))
      .toEqual(new Set(['current']));

    usage.close();
    store.close();
  });

  test('refuses zero and implausibly short provider snapshots before baseline or searchable artifacts change', async () => {
    for (const proposedCount of [0, 5]) {
      let clock = new Date('2026-07-18T12:00:00.000Z');
      let currentPosts = Array.from({ length: 99 }, (_, index) => (
        bookmark(`floor-${index}`, `preservation floor marker ${index}`)
      ));
      const store = xStore(() => clock);
      const usage = new LocalXBookmarksApiUsageStore(':memory:');
      const reconcileState = new LocalXBookmarksReconcileStateStore(':memory:');
      const client = paginatedCurrentPostsClient(() => currentPosts);
      const handler = createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        reconcileStateStore: reconcileState,
        embeddingProvider: fakeEmbeddingProvider(),
        sourceClient: client,
        account: ACCOUNT,
        userId: 'provider-user-floor',
        config: testConfig(),
        now: () => clock,
      });
      await handler.reconcile({ attempted_at: clock.toISOString() });
      const prior = reconcileState.completedSnapshot(ACCOUNT)!;
      const before = store.status().counts;
      expect(prior.itemsObserved).toBe(99);
      expect(before).toMatchObject({
        items: 99,
        tombstonedItems: 0,
        chunks: 99,
        embeddedChunks: 99,
      });

      currentPosts = currentPosts.slice(0, proposedCount);
      clock = new Date('2026-07-19T12:00:00.000Z');
      await expect(handler.reconcile({ attempted_at: clock.toISOString() })).rejects.toMatchObject({
        errorKind: 'reconcile_incomplete',
        degradedReason: 'x_reconcile_preservation_floor_refused',
        warnings: ['x_reconcile_preservation_floor_refused_prior_baseline_preserved'],
        counts: {
          preservation_floor_prior_items: 99,
          preservation_floor_proposed_items: proposedCount,
          preservation_floor_minimum_retained_items: 75,
        },
      });

      expect(reconcileState.completedSnapshot(ACCOUNT)?.itemsObserved).toBe(99);
      expect(store.status().counts).toEqual(before);
      expect(store.searchItems('preservation floor marker', 99)).toHaveLength(50);
      reconcileState.close();
      usage.close();
      store.close();
    }
  });

  test('requires the exact proposed-snapshot digest to authorize a floor crossing', async () => {
    let clock = new Date('2026-07-18T12:00:00.000Z');
    let currentPosts = Array.from({ length: 99 }, (_, index) => (
      bookmark(`authorized-floor-${index}`, `authorized preservation marker ${index}`)
    ));
    const store = xStore(() => clock);
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const reconcileState = new LocalXBookmarksReconcileStateStore(':memory:');
    const client = paginatedCurrentPostsClient(() => currentPosts);
    const handlerOptions = {
      store,
      usageStore: usage,
      reconcileStateStore: reconcileState,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: client,
      account: ACCOUNT,
      userId: 'provider-user-floor-auth',
      config: testConfig(),
      now: () => clock,
    };
    await createXBookmarksConnectorStoreSyncHandler(handlerOptions)
      .reconcile({ attempted_at: clock.toISOString() });
    currentPosts = currentPosts.slice(-5);
    clock = new Date('2026-07-19T12:00:00.000Z');
    await expect(createXBookmarksConnectorStoreSyncHandler({
      ...handlerOptions,
      preservationFloorAuthorizationSha256: '0'.repeat(64),
    }).reconcile({ attempted_at: clock.toISOString() })).rejects.toMatchObject({
      degradedReason: 'x_reconcile_preservation_floor_refused',
    });
    const assessment = reconcileState.preservationFloorAssessment(ACCOUNT);
    expect(assessment).toMatchObject({
      status: 'authorization_required',
      priorItems: 99,
      proposedItems: 5,
      minimumRetainedItems: 75,
    });
    expect(assessment.requiredAuthorizationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(reconcileState.preservationFloorAssessment(
      ACCOUNT,
      assessment.requiredAuthorizationSha256,
    ).status).toBe('authorized');

    const authorized = await createXBookmarksConnectorStoreSyncHandler({
      ...handlerOptions,
      preservationFloorAuthorizationSha256: assessment.requiredAuthorizationSha256,
    }).reconcile({ attempted_at: clock.toISOString() });
    expect(authorized.counts.items_tombstoned).toBe(94);
    expect(reconcileState.completedSnapshot(ACCOUNT)?.itemsObserved).toBe(5);
    expect(store.status().counts).toMatchObject({
      items: 5,
      tombstonedItems: 94,
      chunks: 5,
      embeddedChunks: 5,
    });
    reconcileState.close();
    usage.close();
    store.close();
  });

  test('a capped daily traversal indexes safely but never tombstones or advances the complete marker', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    await store.syncFromConnector(createXBookmarksSourceConnector({
      account: ACCOUNT,
      posts: [bookmark('must-survive', 'partial traversal survivor')],
      connectorId: X_BOOKMARKS_ARCHIVE_CONNECTOR_ID,
    }), { fetchContent: true, ownershipKind: 'preservation' });
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks() {
        return { posts: [bookmark('partial-new', 'newmarkerunique')], nextToken: 'still-more' };
      },
      async fetchBookmarkFolders() { return { folders: [] }; },
      async fetchBookmarksInFolder() { return { posts: [] }; },
    };
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: client,
      account: ACCOUNT,
      userId: 'provider-user-1',
      config: testConfig({ reconcileMaxPagesPerScope: 1 }),
      now: () => new Date('2026-07-18T14:00:00.000Z'),
    });

    try {
      await handler.reconcile({ attempted_at: '2026-07-18T14:00:00.000Z' });
      throw new Error('expected incomplete reconciliation');
    } catch (error) {
      expect(error).toBeInstanceOf(XBookmarksLiveSyncError);
      expect(error).toMatchObject({
        errorKind: 'reconcile_incomplete',
        warnings: [
          'x_reconcile_incomplete_no_shared_store_write',
          'x_reconcile_progress_staged_restart_safe',
        ],
      });
    }
    expect(store.searchItems('survivor', 5)).toHaveLength(1);
    expect(store.searchItems('newmarkerunique', 5)).toHaveLength(0);
    expect(handler.lastCompleteReconcileAt()).toBeUndefined();

    usage.close();
    store.close();
  });

  test('a genuinely short 20-item global page is a verified recency window', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    await store.syncFromConnector(createXBookmarksSourceConnector({
      account: ACCOUNT,
      posts: [bookmark('unseen-preserved', 'silent window survivor')],
      connectorId: X_BOOKMARKS_ARCHIVE_CONNECTOR_ID,
    }), { fetchContent: true, ownershipKind: 'preservation' });
    const visible = Array.from({ length: 20 }, (_, index) => bookmark(
      `visible-${index}`,
      `visible marker ${index}`,
    ));
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: {
        async fetchBookmarks() { return { posts: visible }; },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
      account: ACCOUNT,
      userId: 'provider-user-1',
      config: testConfig(),
      now: () => new Date('2026-07-18T14:10:00.000Z'),
    });

    await expect(handler.reconcile({ attempted_at: '2026-07-18T14:10:00.000Z' })).resolves.toMatchObject({
      counts: {
        items_seen: 20,
        items_tombstoned: 0,
        global_traversal_exhausted: 1,
        removal_authoritative: 1,
        coverage_scope_recency_window: 1,
        window_boundary_verified: 1,
      },
      warnings: ['x_reconcile_provider_window_boundary_verified'],
    });
    expect(store.searchItems('survivor', 5)[0]?.sourceItem.providerItemId).toBe('unseen-preserved');
    expect(store.searchItems('visible marker', 25)).toHaveLength(20);
    expect(usage.completeReconcileWatermark(ACCOUNT)).toMatchObject({
      coverage_scope: 'recency_window',
      window_boundary_verified: true,
      out_of_scope_removals: 0,
    });
    usage.close();
    store.close();
  });

  test('daily reconciliation durably records complete empty-folder inventory', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const embedding = fakeEmbeddingProvider();
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks() { return { posts: [] }; },
      async fetchBookmarkFolders() { return { folders: [{ id: 'empty-7', name: 'Empty Research' }] }; },
      async fetchBookmarksInFolder(folderId) {
        expect(folderId).toBe('empty-7');
        return { posts: [] };
      },
    };
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store, usageStore: usage, embeddingProvider: embedding,
      sourceClient: client, account: ACCOUNT, userId: 'provider-user-1', config: testConfig(),
      now: () => new Date('2026-07-18T15:00:00.000Z'),
    });
    const result = await handler.reconcile({ attempted_at: '2026-07-18T15:00:00.000Z' });
    expect(result.counts).toMatchObject({ items_seen: 0, folders_seen: 1, folder_memberships_seen: 0 });
    expect(usage.completeReconcileWatermark(ACCOUNT)).toEqual({
      completed_at: '2026-07-18T15:00:00.000Z',
      items_seen: 0,
      folders_seen: 1,
      folder_memberships_seen: 0,
      global_traversal_exhausted: true,
      global_verification_matched: true,
      removal_authoritative: true,
      coverage_scope: 'recency_window',
      window_boundary_verified: true,
      traversal_digest_sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      traversal_cardinality: 0,
      verification_digest_sha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      verification_cardinality: 0,
      absence_items_tombstoned: 0,
      out_of_scope_removals: 0,
      folder_inventory_authoritative: true,
      folder_inventory_coverage_gaps: 0,
      folders_carried_forward: 0,
      folder_membership_coverage_gaps: 0,
      folder_provider_outage: false,
      complete_reconciliation_authoritative: true,
      global_current_authority: 'green',
      folder_provenance: 'green',
      staged_recovery: 'not_needed',
    });
    expect(embedding.embedCalls).toHaveLength(0);
    usage.close();
    store.close();
  });

  test('identical complete reconciliations preserve chunk identities and do not re-embed the corpus', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const embedding = fakeEmbeddingProvider();
    const post = bookmark('stable-post', 'stable daily content marker');
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: embedding,
      sourceClient: {
        async fetchBookmarks() { return { posts: [post] }; },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
      account: ACCOUNT,
      userId: 'provider-user-1',
      config: testConfig(),
      now: () => new Date('2026-07-18T15:10:00.000Z'),
    });

    const first = await handler.reconcile({ attempted_at: '2026-07-18T15:10:00.000Z' });
    const afterFirst = store.status().counts;
    const second = await handler.reconcile({ attempted_at: '2026-07-18T15:20:00.000Z' });
    const afterSecond = store.status().counts;
    expect(first.counts).toMatchObject({ chunks_indexed: 1, chunks_embedded: 1 });
    expect(second.counts).toMatchObject({ chunks_indexed: 0, chunks_embedded: 0 });
    expect(embedding.embedCalls).toHaveLength(1);
    expect(afterSecond.chunks).toBe(afterFirst.chunks);
    expect(afterSecond.embeddedChunks).toBe(afterFirst.embeddedChunks);
    usage.close();
    store.close();
  });

  test('reuses a promoted pending snapshot after embedding failure with zero duplicate provider reads', async () => {
    let now = new Date('2026-07-18T15:30:00.000Z');
    const store = xStore(() => now);
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const state = new LocalXBookmarksReconcileStateStore(':memory:');
    let providerCalls = 0;
    let failEmbedding = true;
    let headAdded = false;
    const pendingPost = bookmark('pending', 'pending marker');
    const newerHeadPost = bookmark('newer-head', 'newer head marker');
    const embedding = fakeEmbeddingProvider();
    embedding.embed = async (inputs) => {
      embedding.embedCalls.push(inputs);
      if (failEmbedding) throw new Error('injected embedding application failure');
      return inputs.map(() => [1, 0, 0]);
    };
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      reconcileStateStore: state,
      embeddingProvider: embedding,
      sourceClient: {
        async fetchBookmarks(request = {}) {
          providerCalls += 1;
          if (request.headOnly && request.maxResults === 1 && headAdded) {
            return { posts: [newerHeadPost] };
          }
          if (request.headOnly) return { posts: [pendingPost] };
          return { posts: headAdded ? [newerHeadPost, pendingPost] : [pendingPost] };
        },
        async fetchBookmarkFolders() { providerCalls += 1; return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
      account: ACCOUNT,
      userId: 'provider-user-1',
      config: testConfig(),
      now: () => now,
    });
    await expect(handler.reconcile({ attempted_at: now.toISOString() }))
      .rejects.toThrow('injected embedding application failure');
    expect(providerCalls).toBe(3); // rich global + ID-only verify + folders
    expect(handler.lastCompleteReconcileAt()).toBeUndefined();
    expect(state.completedSnapshot(ACCOUNT)?.applicationStatus).toBe('pending');
    const providerCompletedAt = state.completedSnapshot(ACCOUNT)!.completedAt;

    headAdded = true;
    failEmbedding = false;
    now = new Date('2026-07-18T15:31:00.000Z');
    await handler.syncHead({ attempted_at: now.toISOString() });
    expect(store.searchItems('newer head marker', 5)
      .filter((row) => row.sourceItem.providerItemId === 'newer-head')).toHaveLength(1);
    expect(providerCalls).toBe(4);
    now = new Date('2026-07-18T15:32:00.000Z');
    const retry = await handler.reconcile({ attempted_at: now.toISOString() });
    expect(retry.counts).toMatchObject({ api_requests: 0, removal_authoritative: 1 });
    expect(providerCalls).toBe(4);
    expect(store.searchItems('newer head marker', 5)
      .filter((row) => row.sourceItem.providerItemId === 'newer-head')).toHaveLength(1);
    expect(state.completedSnapshot(ACCOUNT)?.applicationStatus).toBe('applied');
    expect(handler.lastCompleteReconcileAt()).toBe(providerCompletedAt);
    state.close();
    usage.close();
    store.close();
  });

  test('completes matched global authority through bounded folder 5xx/429 degradation', async () => {
    for (const outage of [
      { phase: 'inventory' as const, status: 503 },
      { phase: 'membership' as const, status: 429 },
    ]) {
      const account = `folder-outage-${outage.phase}`;
      const now = new Date('2026-07-18T16:00:00.000Z');
      const store = xStore(() => now);
      const usage = new LocalXBookmarksApiUsageStore(':memory:');
      const state = new LocalXBookmarksReconcileStateStore(':memory:');
      const current = bookmark(`current-${outage.phase}`, `current ${outage.phase}`);
      const archiveOnly = bookmark(`archive-${outage.phase}`, `archive ${outage.phase}`);
      const folder = { id: `folder-${outage.phase}`, name: `Folder ${outage.phase}` };
      seedCanonicalXBookmarksSnapshot(state, {
        account,
        providerUserId: 'provider-user-1',
        posts: [current, archiveOnly],
        folders: [folder],
        foldersByPostId: new Map([
          [current.id, [folder]],
          [archiveOnly.id, [folder]],
        ]),
        seededAt: new Date(now.getTime() - 60_000),
      });
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account,
        posts: [current, archiveOnly],
        foldersByPostId: new Map([
          [current.id, [folder]],
          [archiveOnly.id, [folder]],
        ]),
        connectorId: X_BOOKMARKS_ARCHIVE_CONNECTOR_ID,
      }), { fetchContent: true, ownershipKind: 'preservation' });

      let globalCalls = 0;
      let inventoryCalls = 0;
      let membershipCalls = 0;
      const handler = createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        reconcileStateStore: state,
        embeddingProvider: fakeEmbeddingProvider(),
        sourceClient: {
          async fetchBookmarks(request = {}) {
            globalCalls += 1;
            return { posts: [request.headOnly ? { id: current.id } : current] };
          },
          async fetchBookmarkFolders() {
            inventoryCalls += 1;
            if (outage.phase === 'inventory') {
              throw new XApiError('content-free provider failure', outage.status);
            }
            return { folders: [folder] };
          },
          async fetchBookmarksInFolder() {
            membershipCalls += 1;
            throw new XApiError('content-free provider failure', outage.status);
          },
        },
        account,
        userId: 'provider-user-1',
        config: testConfig(),
        now: () => now,
      });
      const result = await handler.reconcile({ attempted_at: now.toISOString() });

      expect(result).toMatchObject({
        authority: {
          global_current_authority: 'green',
          folder_provenance: 'degraded',
          staged_recovery: 'not_needed',
        },
        counts: {
          api_requests: outage.phase === 'inventory' ? 5 : 6,
          items_seen: 1,
          items_tombstoned: 0,
          folder_inventory_authoritative: 0,
          folder_inventory_coverage_gaps: 1,
          folders_carried_forward: 1,
          folder_membership_coverage_gaps: 1,
          folder_memberships_seen: 1,
          folder_provider_outage: 1,
          global_traversal_exhausted: 1,
          global_verification_matched: 1,
          removal_authoritative: 1,
          global_current_authority: 1,
          complete_reconciliation_authoritative: 0,
        },
        warnings: expect.arrayContaining([
          X_BOOKMARKS_FOLDER_PROVIDER_OUTAGE_WARNING,
          'x_reconcile_folder_provenance_degraded_daily_cadence',
        ]),
      });
      expect(globalCalls).toBe(2);
      expect(inventoryCalls).toBe(outage.phase === 'inventory' ? 3 : 1);
      expect(membershipCalls).toBe(outage.phase === 'membership' ? 3 : 0);
      expect(state.stagedRecoveryStatus(account, now)).toMatchObject({
        staged: false,
        staged_recovery: 'not_needed',
      });
      expect(state.completedSnapshot(account)).toMatchObject({
        applicationStatus: 'degraded',
        globalCurrentAuthority: 'green',
        folderProvenance: 'degraded',
        folderProviderOutage: true,
        foldersCarriedForward: 1,
        folderMembershipCoverageGaps: 1,
      });
      expect(state.completedSnapshot(account)?.foldersByPostId.get(current.id)).toEqual([folder]);
      expect(state.completedSnapshot(account)?.foldersByPostId.has(archiveOnly.id)).toBe(false);
      expect(usage.completeReconcileWatermark(account)).toMatchObject({
        global_current_authority: 'green',
        folder_provenance: 'degraded',
        folder_provider_outage: true,
        staged_recovery: 'not_needed',
      });
      expect(store.searchItems(`archive ${outage.phase}`, 5)
        .map((hit) => hit.sourceItem.providerItemId)).toContain(archiveOnly.id);

      state.close();
      usage.close();
      store.close();
    }
  }, 20_000);

  test('completes folder degradation when the real guarded client wraps an HTTP 503', async () => {
    const now = new Date('2026-07-18T16:30:00.000Z');
    const account = 'folder-outage-real-guarded-client';
    const current = bookmark('990001', 'current real guarded client');
    const folder = { id: 'folder-real-guarded-client', name: 'Real Guarded Client' };
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const state = new LocalXBookmarksReconcileStateStore(':memory:');
    seedCanonicalXBookmarksSnapshot(state, {
      account,
      providerUserId: 'provider-user-1',
      posts: [current],
      folders: [folder],
      foldersByPostId: new Map([[current.id, [folder]]]),
      seededAt: new Date(now.getTime() - 60_000),
    });
    let folderRequests = 0;
    const client = new XApiClient({
      token: 'test-token',
      userId: 'provider-user-1',
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/bookmarks/folders')) {
          folderRequests += 1;
          return new Response(JSON.stringify({
            title: 'Service Unavailable',
            type: 'https://api.x.com/problems/service-unavailable',
          }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          data: [{ id: current.id, text: current.text }],
          meta: { result_count: 1 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const connector = createXBookmarksApiSourceConnector({
      mode: 'reconcile',
      account,
      attemptedAt: now,
      now: () => now,
      usageStore: usage,
      reconcileStateStore: state,
      sourceClient: client,
      userId: 'provider-user-1',
      config: testConfig(),
    });

    const result = await connector.probe();
    expect(result).toMatchObject({
      authority: {
        global_current_authority: 'green',
        folder_provenance: 'degraded',
      },
      counts: {
        apiRequests: 5,
        folderProviderOutage: 1,
        foldersCarriedForward: 1,
        globalVerificationMatched: 1,
      },
      warnings: expect.arrayContaining([X_BOOKMARKS_FOLDER_PROVIDER_OUTAGE_WARNING]),
    });
    expect(folderRequests).toBe(3);
    expect(state.completedSnapshot(account)).toMatchObject({
      folderProvenance: 'degraded',
      folderProviderOutage: true,
    });
    state.close();
    usage.close();
  }, 20_000);

  test('completes folder degradation when the folder endpoint hangs without an HTTP status', async () => {
    // Live incident 2026-07-25: X's folder inventory endpoint stopped
    // returning 503s and began failing at the network layer instead. The
    // real client wraps that into a status-less XApiError, which must
    // classify as a provider outage so the matched-global degradation path
    // engages instead of parking the run as an anonymous temporary failure.
    const now = new Date('2026-07-25T12:00:00.000Z');
    const account = 'folder-outage-network-timeout';
    const current = bookmark('990002', 'current network timeout');
    const folder = { id: 'folder-network-timeout', name: 'Network Timeout' };
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const state = new LocalXBookmarksReconcileStateStore(':memory:');
    seedCanonicalXBookmarksSnapshot(state, {
      account,
      providerUserId: 'provider-user-1',
      posts: [current],
      folders: [folder],
      foldersByPostId: new Map([[current.id, [folder]]]),
      seededAt: new Date(now.getTime() - 60_000),
    });
    let folderRequests = 0;
    const client = new XApiClient({
      token: 'test-token',
      userId: 'provider-user-1',
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/bookmarks/folders')) {
          folderRequests += 1;
          throw new TypeError('fetch failed: connect ETIMEDOUT');
        }
        return new Response(JSON.stringify({
          data: [{ id: current.id, text: current.text }],
          meta: { result_count: 1 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const connector = createXBookmarksApiSourceConnector({
      mode: 'reconcile',
      account,
      attemptedAt: now,
      now: () => now,
      usageStore: usage,
      reconcileStateStore: state,
      sourceClient: client,
      userId: 'provider-user-1',
      config: testConfig(),
    });

    const result = await connector.probe();
    expect(result).toMatchObject({
      authority: {
        global_current_authority: 'green',
        folder_provenance: 'degraded',
      },
      warnings: expect.arrayContaining([X_BOOKMARKS_FOLDER_PROVIDER_OUTAGE_WARNING]),
    });
    expect(folderRequests).toBe(3);
    expect(state.completedSnapshot(account)).toMatchObject({
      folderProvenance: 'degraded',
      folderProviderOutage: true,
    });
    state.close();
    usage.close();
  }, 20_000);

  test('verified recency windows preserve the last safe folder baseline for a later partial folder pass', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const state = new LocalXBookmarksReconcileStateStore(':memory:');
    const posts = Array.from({ length: 25 }, (_, index) => bookmark(
      `baseline-${index}`,
      `baseline marker ${index}`,
    ));
    const folder = { id: 'baseline-folder', name: 'Baseline Folder' };
    seedCanonicalXBookmarksSnapshot(state, {
      account: ACCOUNT,
      providerUserId: 'provider-user-1',
      posts,
      folders: [folder],
      foldersByPostId: new Map(posts.map((post) => [post.id, [folder]])),
    });
    let fullGlobal = false;
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      reconcileStateStore: state,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: {
        async fetchBookmarks(request = {}) {
          const visible = fullGlobal ? posts : posts.slice(0, 20);
          return { posts: visible.map((post) => request.headOnly ? { id: post.id } : post) };
        },
        async fetchBookmarkFolders() { return { folders: [folder] }; },
        async fetchBookmarksInFolder() { return { posts: posts.slice(0, 20).map((post) => ({ id: post.id })) }; },
      },
      account: ACCOUNT,
      userId: 'provider-user-1',
      config: testConfig(),
      now: () => new Date('2026-07-18T16:30:00.000Z'),
    });
    await expect(handler.reconcile({ attempted_at: '2026-07-18T16:20:00.000Z' }))
      .resolves.toMatchObject({
        authority: {
          global_current_authority: 'green',
          folder_provenance: 'degraded',
        },
        counts: { removal_authoritative: 1 },
      });
    expect(state.completedSnapshot(ACCOUNT)?.foldersByPostId.get('baseline-24')).toBeUndefined();

    fullGlobal = true;
    await expect(handler.reconcile({ attempted_at: '2026-07-18T16:25:00.000Z' }))
      .resolves.toMatchObject({
        authority: {
          global_current_authority: 'green',
          folder_provenance: 'degraded',
        },
        retry_at: {
          effective_interval_ms: 86_400_000,
          degraded_reason: 'x_reconcile_folder_provenance_degraded',
        },
        counts: {
          removal_authoritative: 1,
          folder_memberships_seen: 20,
          folder_membership_coverage_gaps: 1,
          complete_reconciliation_authoritative: 0,
        },
      });
    expect(handler.lastCompleteReconcileAt()).toBe('2026-07-18T16:30:00.000Z');
    expect(state.completedSnapshot(ACCOUNT)?.foldersByPostId.get('baseline-24')).toBeUndefined();
    state.close();
    usage.close();
    store.close();
  });

  test('ambiguous folder inventory carries empty folders but drops removed-post memberships', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const state = new LocalXBookmarksReconcileStateStore(':memory:');
    const keep = bookmark('inventory-keep', 'inventory keep');
    const removed = bookmark('inventory-removed', 'inventory removed');
    const emptyFolder = { id: 'prior-empty', name: 'Prior Empty' };
    const removedFolder = { id: 'prior-removed', name: 'Prior Removed' };
    seedCanonicalXBookmarksSnapshot(state, {
      account: ACCOUNT,
      providerUserId: 'provider-user-1',
      posts: [keep, removed],
      folders: [emptyFolder, removedFolder],
      foldersByPostId: new Map([[removed.id, [removedFolder]]]),
    });
    const observedFolders = Array.from({ length: 20 }, (_, index) => ({
      id: `observed-${index}`,
      name: `Observed ${index}`,
    }));
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      reconcileStateStore: state,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: {
        async fetchBookmarks(request = {}) { return { posts: [request.headOnly ? { id: keep.id } : keep] }; },
        async fetchBookmarkFolders() { return { folders: observedFolders }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
      account: ACCOUNT,
      userId: 'provider-user-1',
      config: testConfig(),
      now: () => new Date('2026-07-18T17:00:00.000Z'),
    });
    await expect(handler.reconcile({ attempted_at: '2026-07-18T16:59:00.000Z' }))
      .resolves.toMatchObject({
        authority: {
          global_current_authority: 'green',
          folder_provenance: 'degraded',
        },
        retry_at: {
          effective_interval_ms: 86_400_000,
          degraded_reason: 'x_reconcile_folder_provenance_degraded',
        },
        counts: {
          folder_inventory_coverage_gaps: 1,
          folders_carried_forward: 2,
          folder_memberships_seen: 0,
          complete_reconciliation_authoritative: 0,
        },
        warnings: expect.arrayContaining([
          'x_reconcile_folder_inventory_coverage_partial_preserved',
        ]),
      });
    const completed = state.completedSnapshot(ACCOUNT)!;
    expect(completed.folders).toContainEqual(emptyFolder);
    expect(completed.folders).toContainEqual(removedFolder);
    expect(completed.foldersByPostId.has(removed.id)).toBe(false);
    state.close();
    usage.close();
    store.close();
  });

  test('authoritative cross-owner removals roll back as one set if SQLite aborts mid-application', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-atomic-removal-'));
    const dbPath = join(dir, 'connector.sqlite');
    let snapshotAttemptedAt = new Date('2026-07-18T12:00:00.000Z');
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: 'internal.x.bookmarks',
      family: 'x',
      trustDomain: 'internal',
      now: () => new Date('2026-07-18T11:59:00.000Z'),
    });
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    try {
      let visiblePosts = [
        bookmark('remove-a', 'atomic survivor a'),
        bookmark('remove-b', 'atomic survivor b'),
        bookmark('keep', 'keep marker'),
      ];
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account: ACCOUNT,
        posts: visiblePosts,
        connectorId: X_BOOKMARKS_ARCHIVE_CONNECTOR_ID,
      }), { fetchContent: true });
      const handler = createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        embeddingProvider: fakeEmbeddingProvider(),
        sourceClient: {
          async fetchBookmarks(request = {}) {
            return {
              posts: request.headOnly
                ? visiblePosts.map((post) => ({ id: post.id }))
                : visiblePosts,
            };
          },
          async fetchBookmarkFolders() { return { folders: [] }; },
          async fetchBookmarksInFolder() { return { posts: [] }; },
        },
        account: ACCOUNT,
        userId: 'provider-user-1',
        config: testConfig(),
        now: () => snapshotAttemptedAt,
      });
      await handler.reconcile({ attempted_at: snapshotAttemptedAt.toISOString() });
      const db = new Database(dbPath);
      db.exec(`
        CREATE TRIGGER fail_x_removal_set
        BEFORE UPDATE OF tombstoned ON items
        WHEN OLD.provider_item_id = 'remove-b' AND NEW.tombstoned = 1
        BEGIN
          SELECT RAISE(ABORT, 'injected authoritative removal failure');
        END;
      `);
      db.close();
      visiblePosts = [visiblePosts[2]!];
      snapshotAttemptedAt = new Date('2026-07-18T12:05:00.000Z');
      await expect(handler.reconcile({ attempted_at: snapshotAttemptedAt.toISOString() }))
        .rejects.toThrow('injected authoritative removal failure');
      const survivors = new Set(store.searchItems('atomic survivor', 5)
        .map((hit) => hit.sourceItem.providerItemId));
      expect(survivors).toContain('remove-a');
      expect(survivors).toContain('remove-b');
      expect(handler.lastCompleteReconcileAt()).toBe('2026-07-18T12:00:00.000Z');
    } finally {
      usage.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('maps 429 reset headers to a bounded provider deferral', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks() {
        throw new XApiError('private provider body', 429, {
          limit: 180,
          remaining: 0,
          resetAt: '2026-07-18T12:15:00.000Z',
        });
      },
      async fetchBookmarkFolders() { return { folders: [] }; },
      async fetchBookmarksInFolder() { return { posts: [] }; },
    };
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: client,
      account: ACCOUNT,
      userId: 'provider-user-1',
      config: testConfig(),
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    await expect(handler.syncHead({ attempted_at: '2026-07-18T12:00:00.000Z' })).rejects.toMatchObject({
      errorKind: 'provider_rate_limited',
      retryAt: '2026-07-18T12:15:00.000Z',
      degradedReason: 'provider_rate_limit',
    });
    usage.close();
    store.close();
  });
});

describe('X bookmarks API usage and response controls', () => {
  test('validates and accepts an environment-overridden head page-size ladder', () => {
    expect(defaultXBookmarksLiveSyncConfig({
      OLYMPUS_SOURCE_INDEX_X_HEAD_PAGE_SIZE_LADDER: '7,14,28,56,100',
    }).headPageSizeLadder).toEqual([7, 14, 28, 56, 100]);
    for (const invalid of ['10,10,20', '0,10,20', '10,20,101', '10,nope,40']) {
      expect(() => defaultXBookmarksLiveSyncConfig({
        OLYMPUS_SOURCE_INDEX_X_HEAD_PAGE_SIZE_LADDER: invalid,
      })).toThrow('X head page-size ladder');
    }
  });

  test('keeps the product cadences at 30 seconds and 24 hours with independent stale alarms', () => {
    const config = defaultXBookmarksLiveSyncConfig({});
    expect(config).toMatchObject({
      headIntervalMs: 30_000,
      headFreshnessThresholdMs: 300_000,
      reconcileIntervalMs: 86_400_000,
      reconcileFreshnessThresholdMs: 93_600_000,
      headApiRequestReserve: 3_000,
      headResourceReadReserve: 3_200,
      headEstimatedSpendReserveMicrousd: 250_000,
      richResourceExpansionMultiplier: 6,
    });
    expect(defaultXBookmarksLiveSyncConfig({
      OLYMPUS_SOURCE_INDEX_X_HEAD_API_REQUEST_RESERVE: '3100',
      OLYMPUS_SOURCE_INDEX_X_HEAD_RESOURCE_READ_RESERVE: '3300',
      OLYMPUS_SOURCE_INDEX_X_HEAD_ESTIMATED_SPEND_RESERVE_USD: '0.4',
    })).toMatchObject({
      headApiRequestReserve: 3_100,
      headResourceReadReserve: 3_300,
      headEstimatedSpendReserveMicrousd: 400_000,
    });
  });

  test('persists restart checkpoints and complete-reconcile clock independently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-live-state-'));
    const path = join(dir, 'usage.sqlite');
    try {
      let usage = new LocalXBookmarksApiUsageStore(path);
      usage.recordHeadCheckpoint(ACCOUNT, 'checkpoint-7', new Date('2026-07-18T10:00:00.000Z'));
      usage.recordCompleteReconcile(ACCOUNT, new Date('2026-07-18T10:01:00.000Z'), {
        itemsSeen: 12,
        foldersSeen: 3,
        folderMembershipsSeen: 7,
        folderInventoryCoverageGaps: 0,
        foldersCarriedForward: 0,
        folderMembershipCoverageGaps: 0,
      }, {
        globalTraversalExhausted: true,
        globalVerificationMatched: true,
        removalAuthoritative: true,
        folderInventoryAuthoritative: true,
      });
      usage.close();
      usage = new LocalXBookmarksApiUsageStore(path);
      expect(usage.headCheckpoint(ACCOUNT)).toBe('checkpoint-7');
      expect(usage.lastCompleteReconcileAt(ACCOUNT)).toBe('2026-07-18T10:01:00.000Z');
      expect(usage.completeReconcileWatermark(ACCOUNT)).toMatchObject({
        items_seen: 12, folders_seen: 3, folder_memberships_seen: 7,
        global_traversal_exhausted: true,
        global_verification_matched: true,
        removal_authoritative: true,
        folder_inventory_authoritative: true,
        complete_reconciliation_authoritative: true,
      });
      usage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('approaching budget slows for one degraded interval; exhausted budget waits for UTC reset', () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const config = testConfig({
      dailyApiRequestBudget: 10,
      dailyResourceReadBudget: 1_000,
      dailyEstimatedSpendMicrousd: 1_000_000,
      degradedIntervalMs: 300_000,
    });
    const now = new Date('2026-07-18T12:00:00.000Z');
    for (let index = 0; index < 9; index += 1) {
      const reservation = usage.reserveRequest({ account: ACCOUNT, requestedMaxResources: 1, config, now });
      usage.settleSuccess({ reservation, resourceIds: ['post:same'], config, now });
    }
    expect(usage.status({ account: ACCOUNT, config, now }).guard).toEqual({
      state: 'approaching',
      degraded_reason: 'daily_api_request_guard',
      retry_at: '2026-07-18T12:05:00.000Z',
    });
    expect(usage.status({ account: ACCOUNT, config, now })).toMatchObject({
      resource_reads: 9,
      estimated_billable_resources: 9,
      estimated_spend_microusd: 9_000,
      estimate: true,
    });
    const tenth = usage.reserveRequest({ account: ACCOUNT, requestedMaxResources: 1, config, now });
    usage.settleSuccess({ reservation: tenth, resourceIds: ['post:same'], config, now });
    expect(usage.status({ account: ACCOUNT, config, now }).guard).toEqual({
      state: 'exhausted',
      degraded_reason: 'daily_api_request_guard',
      retry_at: '2026-07-19T00:00:00.000Z',
    });
    expect(() => usage.reserveRequest({ account: ACCOUNT, requestedMaxResources: 1, config, now }))
      .toThrow(XApiUsageGuardError);
    usage.close();
  });

  test('passes the reservation-shrunk maximum to the provider before any resource read', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const now = new Date('2026-07-18T12:00:00.000Z');
    const config = testConfig({
      dailyResourceReadBudget: 4,
      dailyEstimatedSpendMicrousd: 100_000,
      richResourceExpansionMultiplier: 1,
    });
    const seed = usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 1,
      config,
      now,
    });
    usage.settleSuccess({ reservation: seed, resourceIds: ['seed:1'], config, now });

    const calls: Array<{ maxResults?: number; headOnly?: boolean }> = [];
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks(request = {}) {
        calls.push(request);
        if (request.headOnly) return { posts: [{ id: '3' }] };
        return {
          posts: [bookmark('3', 'newest'), bookmark('2', 'middle')]
            .slice(0, request.maxResults),
        };
      },
      async fetchBookmarkFolders() { return { folders: [] }; },
      async fetchBookmarksInFolder() { return { posts: [] }; },
    };
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental',
      account: ACCOUNT,
      attemptedAt: now,
      now: () => now,
      usageStore: usage,
      sourceClient: client,
      config,
    });

    await firstPageWithCursor(connector, '1');

    expect(calls).toEqual([
      { maxResults: 3 },
    ]);
    const status = usage.status({ account: ACCOUNT, config, now });
    expect(status.resource_reads).toBe(3);
    expect(status.resource_reads).toBeLessThanOrEqual(status.hard_budgets.resource_reads);
    usage.close();
  });

  test('settlement fails closed without exceeding read or estimated-spend budgets', () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const now = new Date('2026-07-18T12:00:00.000Z');
    const config = testConfig({
      dailyResourceReadBudget: 2,
      dailyEstimatedSpendMicrousd: 2_000,
      estimatedUnitCostMicrousd: 1_000,
    });
    const reservation = usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 100,
      minimumResources: 1,
      config,
      now,
    });
    expect(reservation.maxResources).toBe(2);

    expect(() => usage.settleSuccess({
      reservation,
      resourceIds: ['post:1', 'post:2', 'post:3'],
      config,
      now,
    })).toThrow('exceeded its reserved resource limit');

    usage.settleFailure({
      reservation,
      potentiallyBillable: true,
      config,
      now,
    });
    const status = usage.status({ account: ACCOUNT, config, now });
    expect(status).toMatchObject({
      resource_reads: 2,
      estimated_billable_resources: 2,
      estimated_spend_microusd: 2_000,
      reserved_resource_reads: 0,
    });
    expect(status.resource_reads).toBeLessThanOrEqual(status.hard_budgets.resource_reads);
    expect(status.estimated_spend_microusd)
      .toBeLessThanOrEqual(status.hard_budgets.estimated_spend_microusd);
    expect(() => usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 1,
      config,
      now,
    })).toThrow(XApiUsageGuardError);
    usage.close();
  });

  test('rich pages account for distinct post, author, and media resources without exposing identities', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const now = new Date('2026-07-18T12:00:00.000Z');
    const config = testConfig({ richResourceExpansionMultiplier: 6 });
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks(request = {}) {
        if (request.headOnly) return { posts: [{ id: '2' }] };
        return {
          posts: [
            { ...bookmark('2', 'rich two'), authorId: 'author-a', mediaKeys: ['media-1', 'media-2'] },
            { ...bookmark('1', 'rich one'), authorId: 'author-a', mediaKeys: ['media-1'] },
          ],
        };
      },
      async fetchBookmarkFolders() { return { folders: [] }; },
      async fetchBookmarksInFolder() { return { posts: [] }; },
    };
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental', account: ACCOUNT, attemptedAt: now,
      now: () => now,
      usageStore: usage, sourceClient: client, config,
    });
    await firstPageWithCursor(connector, '0');
    const status = usage.status({ account: ACCOUNT, config, now });
    expect(status).toMatchObject({
      api_requests: 1,
      resource_reads: 5,
      estimated_billable_resources: 5,
      estimated_spend_microusd: 5_000,
    });
    expect(JSON.stringify(status)).not.toContain('author-a');
    expect(JSON.stringify(status)).not.toContain('media-1');
    usage.close();
  });

  test('rich expansion reservation stops before the spend guard can be exceeded', async () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const now = new Date('2026-07-18T12:00:00.000Z');
    const calls: string[] = [];
    const config = testConfig({
      dailyEstimatedSpendMicrousd: 5_000,
      estimatedUnitCostMicrousd: 1_000,
      richResourceExpansionMultiplier: 6,
    });
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental', account: ACCOUNT, attemptedAt: now,
      now: () => now,
      usageStore: usage,
      config,
      sourceClient: {
        async fetchBookmarks(request = {}) {
          calls.push(request.headOnly ? 'head' : 'rich');
          return { posts: [{ id: 'new' }] };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
    });
    await expect(firstPageWithCursor(connector, 'old')).rejects.toMatchObject({
      errorKind: 'api_request_guard',
      degradedReason: 'daily_cost_guard',
    });
    expect(calls).toEqual([]);
    expect(usage.status({ account: ACCOUNT, config, now }).estimated_spend_microusd).toBe(0);
    usage.close();
  });

  test('stops reconciliation at its API reserve while the fast head lane remains available', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const calls: Array<{ maxResults?: number; headOnly?: boolean; strictSnapshot?: boolean }> = [];
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks(request = {}) {
        calls.push(request);
        return { posts: [] };
      },
      async fetchBookmarkFolders() {
        throw new Error('folder request must stop before consuming head API reserve');
      },
      async fetchBookmarksInFolder() { return { posts: [] }; },
    };
    const config = testConfig({
      dailyApiRequestBudget: 3,
      headApiRequestReserve: 2,
      headResourceReadReserve: 0,
      headEstimatedSpendReserveMicrousd: 0,
    });
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: client,
      account: ACCOUNT,
      userId: 'provider-user-1',
      config,
      // Day start: the head reserve is at full strength (prorated reserve
      // equals the configured reserve at 00:00 UTC).
      now: () => new Date('2026-07-18T00:00:00.000Z'),
    });

    await expect(handler.reconcile({ attempted_at: '2026-07-18T00:00:00.000Z' }))
      .rejects.toMatchObject({
        errorKind: 'api_request_guard',
        degradedReason: 'head_api_request_reserve_guard',
        retryAt: '2026-07-19T00:00:00.000Z',
      });
    await expect(handler.syncHead({ attempted_at: '2026-07-18T00:00:30.000Z' }))
      .resolves.toMatchObject({ status: 'idle' });
    expect(calls).toEqual([
      { maxResults: 80, strictSnapshot: true },
      { maxResults: 10 },
    ]);
    expect(usage.status({
      account: ACCOUNT,
      config,
      now: new Date('2026-07-18T12:00:30.000Z'),
    }).api_requests).toBe(2);
    usage.close();
    store.close();
  });

  test('the head reserve prorates with the remaining day so background work schedules after midday', async () => {
    // Live incident 2026-07-26: a full-day static reserve double-booked
    // capacity the head had already consumed, making every reconcile
    // unschedulable after ~08:00 UTC. At 18:00 UTC a quarter of the day
    // remains, so only a quarter of the reserve is still protected.
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks() { return { posts: [] }; },
      async fetchBookmarkFolders() { return { folders: [] }; },
      async fetchBookmarksInFolder() { return { posts: [] }; },
    };
    const config = testConfig({
      dailyApiRequestBudget: 4,
      headApiRequestReserve: 4,
      headResourceReadReserve: 0,
      headEstimatedSpendReserveMicrousd: 0,
    });
    const at = (iso: string) => new Date(iso);
    const midnightHandler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: client,
      account: ACCOUNT,
      userId: 'provider-user-1',
      config,
      now: () => at('2026-07-18T00:00:00.000Z'),
    });
    // Full reserve at day start: background budget is zero and the very
    // first reconcile request refuses.
    await expect(midnightHandler.reconcile({ attempted_at: '2026-07-18T00:00:00.000Z' }))
      .rejects.toMatchObject({
        errorKind: 'api_request_guard',
        degradedReason: 'head_api_request_reserve_guard',
      });

    const eveningHandler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: client,
      account: ACCOUNT,
      userId: 'provider-user-1',
      config,
      now: () => at('2026-07-18T18:00:00.000Z'),
    });
    // At 18:00 UTC the prorated reserve is ceil(4 * 0.25) = 1, leaving a
    // background budget of 3 — enough for the empty-account reconcile to
    // complete inside the same hard daily budget.
    await expect(eveningHandler.reconcile({ attempted_at: '2026-07-18T18:00:00.000Z' }))
      .resolves.toMatchObject({ status: expect.any(String) });
    usage.close();
    store.close();
  });

  test('preserves independently configured read and spend headroom from reconciliation', () => {
    const cases: Array<{
      expectedGuard: 'head_resource_read_reserve_guard' | 'head_cost_reserve_guard';
      config: XBookmarksLiveSyncConfig;
    }> = [
      {
        expectedGuard: 'head_resource_read_reserve_guard',
        config: testConfig({
          dailyResourceReadBudget: 4,
          headResourceReadReserve: 2,
          headEstimatedSpendReserveMicrousd: 0,
        }),
      },
      {
        expectedGuard: 'head_cost_reserve_guard',
        config: testConfig({
          dailyResourceReadBudget: 100,
          headResourceReadReserve: 0,
          dailyEstimatedSpendMicrousd: 4_000,
          headEstimatedSpendReserveMicrousd: 2_000,
          estimatedUnitCostMicrousd: 1_000,
        }),
      },
    ];

    for (const { config, expectedGuard } of cases) {
      const usage = new LocalXBookmarksApiUsageStore(':memory:');
      // Day start: reserves at full configured strength (prorating is
      // covered by its own test above).
      const now = new Date('2026-07-18T00:00:00.000Z');
      const background = usage.reserveRequest({
        account: ACCOUNT,
        requestedMaxResources: 100,
        minimumResources: 1,
        preserveHeadReserve: true,
        config,
        now,
      });
      expect(background.maxResources).toBe(2);
      usage.settleSuccess({
        reservation: background,
        resourceIds: ['background:1', 'background:2'],
        config,
        now,
      });

      let caught: unknown;
      try {
        usage.reserveRequest({
          account: ACCOUNT,
          requestedMaxResources: 1,
          preserveHeadReserve: true,
          config,
          now,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(XApiUsageGuardError);
      expect(caught).toMatchObject({ guardKind: expectedGuard });

      const head = usage.reserveRequest({
        account: ACCOUNT,
        requestedMaxResources: 2,
        config,
        now,
      });
      expect(head.maxResources).toBe(2);
      usage.settleSuccess({
        reservation: head,
        resourceIds: ['head:1', 'head:2'],
        config,
        now,
      });
      const status = usage.status({ account: ACCOUNT, config, now });
      expect(status.resource_reads).toBeLessThanOrEqual(status.hard_budgets.resource_reads);
      expect(status.estimated_spend_microusd)
        .toBeLessThanOrEqual(status.hard_budgets.estimated_spend_microusd);
      usage.close();
    }
  });

  test('reads rate-limit headers and sends bounded max_results to folder membership', async () => {
    const urls: URL[] = [];
    const client = new XApiClient({
      token: 'test-token',
      userId: 'user-1',
      fetch: async (input) => {
        urls.push(new URL(String(input)));
        return new Response(JSON.stringify({ data: [{ id: '9', text: 'marker' }] }), {
          headers: {
            'content-type': 'application/json',
            'x-rate-limit-limit': '180',
            'x-rate-limit-remaining': '179',
            'x-rate-limit-reset': '1784376900',
          },
        });
      },
    });
    const page = await client.fetchBookmarksInFolder('folder-1', { maxResults: 1 });
    expect(urls[0]?.searchParams.get('max_results')).toBe('1');
    expect(page.rateLimit).toEqual({
      limit: 180,
      remaining: 179,
      resetAt: new Date(1784376900 * 1_000).toISOString(),
    });
  });

  test('keeps the 30-second head request ID-only and requests rich fields only for catch-up', async () => {
    const urls: URL[] = [];
    const client = new XApiClient({
      token: 'test-token',
      userId: 'user-1',
      fetch: async (input) => {
        urls.push(new URL(String(input)));
        return new Response(JSON.stringify({ data: [{ id: '9' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await client.fetchBookmarks({ maxResults: 1, headOnly: true });
    await client.fetchBookmarks({ maxResults: 100 });
    expect(urls[0]?.searchParams.get('max_results')).toBe('1');
    expect(urls[0]?.searchParams.has('tweet.fields')).toBe(false);
    expect(urls[0]?.searchParams.has('expansions')).toBe(false);
    expect(urls[1]?.searchParams.get('max_results')).toBe('100');
    expect(urls[1]?.searchParams.get('tweet.fields')).toContain('text');
    expect(urls[1]?.searchParams.get('expansions')).toContain('author_id');
  });

  test('converts generic fetch failures into a content-free provider-temporary error', async () => {
    const client = new XApiClient({
      token: 'test-token',
      userId: 'user-1',
      fetch: async () => { throw new TypeError('fetch failed at /private/network/path'); },
    });
    let caught: unknown;
    try {
      await client.fetchBookmarks({ maxResults: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(XApiError);
    expect(String(caught)).toContain('network request failed');
    expect(String(caught)).not.toContain('/private/network/path');

    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: client,
      account: ACCOUNT,
      config: testConfig(),
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    await expect(handler.syncHead({ attempted_at: '2026-07-18T12:00:00.000Z' })).rejects.toMatchObject({
      errorKind: 'provider_temporary',
      retryAt: undefined,
    });
    usage.close();
    store.close();
  });
});

function xStore(now?: () => Date): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'internal.x.bookmarks',
    family: 'x',
    trustDomain: 'internal',
    ...(now ? { now } : {}),
  });
}

function bookmark(id: string, text: string, authorUsername?: string): XBookmarkPost {
  return {
    id,
    text,
    ...(authorUsername ? { authorUsername } : {}),
    createdAt: '2026-07-18T11:59:00.000Z',
    sourceVersion: `v-${id}`,
    url: `https://x.com/i/web/status/${id}`,
  };
}

type FakeEmbeddingProvider = SourceEmbeddingProvider & { embedCalls: SourceEmbeddingInput[][] };

function fakeEmbeddingProvider(): FakeEmbeddingProvider {
  const embedCalls: SourceEmbeddingInput[][] = [];
  return {
    provider: 'test',
    modelId: 'test-x-embed',
    dimension: 3,
    configHash: 'test-config',
    epochId: 'test-epoch',
    backend: 'cloud',
    embedCalls,
    async embed(inputs) {
      embedCalls.push(inputs);
      return inputs.map(() => [1, 0, 0]);
    },
  };
}

function testConfig(overrides: Partial<XBookmarksLiveSyncConfig> = {}): XBookmarksLiveSyncConfig {
  return {
    ...defaultXBookmarksLiveSyncConfig({}),
    dailyApiRequestBudget: 10_000,
    dailyResourceReadBudget: 100_000,
    dailyEstimatedSpendMicrousd: 100_000_000,
    rateLimitLowWatermark: 0,
    ...overrides,
  };
}

function paginatedCurrentPostsClient(
  current: () => readonly XBookmarkPost[],
): XBookmarksLiveSourceClient {
  return {
    async fetchBookmarks(request = {}) {
      const offset = request.paginationToken
        ? Number(request.paginationToken.replace('offset-', ''))
        : 0;
      const size = request.maxResults ?? 80;
      const posts = current().slice(offset, offset + size);
      const nextOffset = offset + posts.length;
      return {
        posts: request.headOnly ? posts.map((post) => ({ id: post.id })) : [...posts],
        ...(nextOffset < current().length ? { nextToken: `offset-${nextOffset}` } : {}),
      };
    },
    async fetchBookmarkFolders() { return { folders: [] }; },
    async fetchBookmarksInFolder() { return { posts: [] }; },
  };
}

async function firstPage(connector: ReturnType<typeof createXBookmarksSourceConnector>) {
  for await (const page of connector.listItems()) return page;
  throw new Error('connector yielded no page');
}

async function firstPageWithCursor(
  connector: ReturnType<typeof createXBookmarksApiSourceConnector>,
  cursor: string,
) {
  for await (const page of connector.listItems({ cursor })) return page;
  throw new Error('connector yielded no page');
}
