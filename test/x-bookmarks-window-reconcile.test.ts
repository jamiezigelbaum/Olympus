import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type {
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  ReconcileStagedRecoveryRequiredError,
  ReconcileWindowBoundaryMismatchError,
  XApiClient,
  XApiError,
  X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION,
  classifyXBookmarksProviderWindowBoundary,
  createXBookmarksConnectorStoreSyncHandler,
  createXBookmarksSourceConnector,
  defaultXBookmarksLiveSyncConfig,
  runXBookmarksWindowDiagnostic,
  type XBookmarkPost,
  type XBookmarksLiveSourceClient,
  type XBookmarksLiveSyncConfig,
  type XBookmarksProviderWindowBoundaryPolicy,
  type XBookmarksReconcileLimits,
} from '../src/workers/x-bookmarks/index.ts';

const ACCOUNT = 'personal';
const ATTEMPTED_AT = new Date('2026-07-24T10:00:00.000Z');
const WINDOW_TYPE = 'urn:x-provider:test:bookmarks-recency-window';
const WINDOW_POLICY: XBookmarksProviderWindowBoundaryPolicy = {
  algorithmVersion: X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION,
  approvedProviderErrorTypes: [WINDOW_TYPE],
  approvedProviderErrorCodes: [],
};
const LIMITS: XBookmarksReconcileLimits = {
  maxItems: 100,
  maxFolders: 20,
  maxPagesPerScope: 10,
  pageSize: 100,
};

describe('X provider-window reconciliation', () => {
  test('extracts only bounded typed provider error fields and never retains the raw body', async () => {
    const token = 'test-secret-token';
    const client = new XApiClient({
      token,
      userId: 'provider-user-1',
      fetch: async () => new Response(JSON.stringify({
        type: WINDOW_TYPE,
        title: 'Bookmark window boundary',
        detail: `PRIVATE POST BODY ${token}`,
        errors: [{ code: 50301, message: 'PRIVATE PROVIDER DETAIL' }],
      }), {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'x-rate-limit-limit': '180',
          'x-rate-limit-remaining': '12',
        },
      }),
    });
    let caught: unknown;
    try {
      await client.fetchBookmarks({ maxResults: 100 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(XApiError);
    expect(caught).toMatchObject({
      status: 503,
      providerErrorType: WINDOW_TYPE,
      providerErrorTitle: 'Bookmark window boundary',
      providerErrorCode: '50301',
      rateLimit: { limit: 180, remaining: 12 },
    });
    expect(String(caught)).not.toContain('PRIVATE');
    expect(String(caught)).not.toContain(token);
    expect(JSON.stringify(caught)).not.toContain('PRIVATE');
    expect(JSON.stringify(caught)).not.toContain(token);
  }, 10_000);

  test('classifies typed, root, mixed, and token-free boundaries fail-closed', () => {
    const providerBoundary = boundaryError();
    expect(classifyXBookmarksProviderWindowBoundary(
      providerBoundary,
      { hasCursor: true, successfulPages: 1 },
      WINDOW_POLICY,
    )).toMatchObject({
      algorithmVersion: X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION,
    });
    expect(classifyXBookmarksProviderWindowBoundary(
      providerBoundary,
      { hasCursor: false, successfulPages: 0 },
      WINDOW_POLICY,
    )).toBeUndefined();
    expect(classifyXBookmarksProviderWindowBoundary(
      new XApiError('generic outage', 503),
      { hasCursor: true, successfulPages: 1 },
      WINDOW_POLICY,
    )).toBeUndefined();

    const typed = new LocalXBookmarksReconcileStateStore(':memory:');
    typed.openRun(ACCOUNT, LIMITS, 'provider-user-1', ATTEMPTED_AT);
    typed.recordGlobalPage({
      account: ACCOUNT,
      page: { posts: [bookmark('3'), bookmark('2')], nextToken: 'rich-edge' },
      requestedSize: 100,
      limits: LIMITS,
    });
    const evidence = classifyXBookmarksProviderWindowBoundary(
      providerBoundary,
      { hasCursor: true, successfulPages: 1 },
      WINDOW_POLICY,
    )!;
    typed.recordGlobalWindowBoundary({
      account: ACCOUNT,
      expectedToken: 'rich-edge',
      boundaryFingerprintSha256: evidence.fingerprintSha256,
      algorithmVersion: evidence.algorithmVersion,
    });
    typed.recordGlobalVerificationPage({
      account: ACCOUNT,
      page: { posts: [bookmark('3'), bookmark('2')], nextToken: 'verify-edge' },
      requestedSize: 100,
      limits: LIMITS,
    });
    expect(typed.recordGlobalVerificationWindowBoundary({
      account: ACCOUNT,
      expectedToken: 'verify-edge',
      boundaryFingerprintSha256: evidence.fingerprintSha256,
      algorithmVersion: evidence.algorithmVersion,
    })).toMatchObject({
      phase: 'folders',
      coverageScope: 'recency_window',
      windowBoundaryVerified: true,
    });
    typed.close();

    const mixed = new LocalXBookmarksReconcileStateStore(':memory:');
    mixed.openRun(ACCOUNT, LIMITS, 'provider-user-1', ATTEMPTED_AT);
    mixed.recordGlobalPage({
      account: ACCOUNT,
      page: { posts: [bookmark('3')], nextToken: 'rich-edge' },
      requestedSize: 100,
      limits: LIMITS,
    });
    mixed.recordGlobalWindowBoundary({
      account: ACCOUNT,
      expectedToken: 'rich-edge',
      boundaryFingerprintSha256: evidence.fingerprintSha256,
      algorithmVersion: evidence.algorithmVersion,
    });
    expect(() => mixed.recordGlobalVerificationPage({
      account: ACCOUNT,
      page: { posts: [bookmark('3')] },
      requestedSize: 100,
      limits: LIMITS,
    })).toThrow(ReconcileWindowBoundaryMismatchError);
    mixed.close();

    const tokenFree = new LocalXBookmarksReconcileStateStore(':memory:');
    tokenFree.openRun(ACCOUNT, LIMITS, 'provider-user-1', ATTEMPTED_AT);
    tokenFree.recordGlobalPage({
      account: ACCOUNT,
      page: { posts: [bookmark('3')] },
      requestedSize: 100,
      limits: LIMITS,
    });
    expect(tokenFree.recordGlobalVerificationPage({
      account: ACCOUNT,
      page: { posts: [bookmark('3')] },
      requestedSize: 100,
      limits: LIMITS,
    })).toMatchObject({
      phase: 'folders',
      coverageScope: 'account_snapshot',
      windowBoundaryVerified: false,
    });
    tokenFree.close();
  }, 10_000);

  test('runs exactly four budgeted probes and writes a content-free 0600 report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-x-window-diagnostic-'));
    const reportPath = join(root, 'window-diagnostic.json');
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks(request = {}) {
        if (request.headOnly) {
          return request.paginationToken
            ? { posts: [{ id: 'id-secret-2' }] }
            : { posts: [{ id: 'id-secret-1' }], nextToken: 'id-cursor-secret' };
        }
        if (request.paginationToken) {
          throw new XApiError('PRIVATE RAW PROVIDER BODY', 503, {
            limit: 180,
            remaining: 17,
          }, {
            type: WINDOW_TYPE,
            title: 'Bookmark window boundary',
            code: '50301',
          });
        }
        return {
          posts: [bookmark('post-secret-1', 'PRIVATE POST TEXT')],
          nextToken: 'cursor-secret',
        };
      },
      async fetchBookmarkFolders() { throw new Error('not used'); },
      async fetchBookmarksInFolder() { throw new Error('not used'); },
    };
    try {
      const result = await runXBookmarksWindowDiagnostic({
        account: ACCOUNT,
        attemptedAt: ATTEMPTED_AT,
        usageStore: usage,
        reportPath,
        sourceClient: client,
        config: testConfig(),
      });
      expect(result.report.probes.map((probe) => probe.name)).toEqual([
        'fresh_root_global',
        'identical_cursor_retry',
        'id_only_traversal',
        'rich_traversal',
      ]);
      expect(result.report.probes).toHaveLength(4);
      expect(result.report.probes[1]).toMatchObject({
        pages_attempted: 2,
        status: 'failed',
      });
      expect(result.report.probes[2]!.pages_attempted).toBeLessThanOrEqual(3);
      expect(result.report.probes[3]!.pages_attempted).toBeLessThanOrEqual(3);
      expect(result.report.api_usage.api_requests).toBe(7);
      expect(statSync(reportPath).mode & 0o777).toBe(0o600);
      const serialized = readFileSync(reportPath, 'utf8');
      expect(serialized).not.toContain('post-secret');
      expect(serialized).not.toContain('cursor-secret');
      expect(serialized).not.toContain('PRIVATE');
      expect(serialized).toContain(WINDOW_TYPE);
      expect(result.report.policy).toMatchObject({
        admin_gated: true,
        budget_accounted: true,
        content_free: true,
        provider_cursor_exposed: false,
        provider_error_body_exposed: false,
      });
    } finally {
      usage.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test('honors the reconcile page-size knob and invalidates incompatible staged state', async () => {
    expect(defaultXBookmarksLiveSyncConfig({}).reconcilePageSize).toBe(80);
    expect(defaultXBookmarksLiveSyncConfig({
      OLYMPUS_SOURCE_INDEX_X_RECONCILE_PAGE_SIZE: '1',
    }).reconcilePageSize).toBe(20);
    expect(defaultXBookmarksLiveSyncConfig({
      OLYMPUS_SOURCE_INDEX_X_RECONCILE_PAGE_SIZE: '101',
    }).reconcilePageSize).toBe(100);
    const calls: Array<{ scope: string; maxResults: number | undefined }> = [];
    const current = bookmark('current', 'current page-size marker');
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks(request = {}) {
        calls.push({ scope: request.headOnly ? 'verify' : 'global', maxResults: request.maxResults });
        return { posts: [request.headOnly ? { id: current.id } : current] };
      },
      async fetchBookmarkFolders(request = {}) {
        calls.push({ scope: 'folders', maxResults: request.maxResults });
        return { folders: [{ id: 'folder-1', name: 'Folder' }] };
      },
      async fetchBookmarksInFolder(_folderId, request = {}) {
        calls.push({ scope: 'memberships', maxResults: request.maxResults });
        return { posts: [current] };
      },
    };
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    try {
      const handler = createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        embeddingProvider: fakeEmbeddingProvider(),
        sourceClient: client,
        account: ACCOUNT,
        userId: 'provider-user-1',
        config: testConfig({ reconcilePageSize: 37 }),
        now: () => ATTEMPTED_AT,
      });
      await handler.reconcile({ attempted_at: ATTEMPTED_AT.toISOString() });
      expect(calls).toEqual([
        { scope: 'global', maxResults: 37 },
        { scope: 'verify', maxResults: 37 },
        { scope: 'folders', maxResults: 37 },
        { scope: 'memberships', maxResults: 37 },
      ]);
    } finally {
      usage.close();
      store.close();
    }

    const state = new LocalXBookmarksReconcileStateStore(':memory:');
    state.openRun(ACCOUNT, LIMITS, 'provider-user-1', ATTEMPTED_AT);
    expect(() => state.openRun(
      ACCOUNT,
      { ...LIMITS, pageSize: 50 },
      'provider-user-1',
      new Date(ATTEMPTED_AT.getTime() + 1_000),
    )).toThrow(ReconcileStagedRecoveryRequiredError);
    state.close();
  }, 10_000);

  test('retries the known 99-without-token truncation signature at a smaller page size', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const calls: Array<{ scope: 'global' | 'verify' | 'folders'; maxResults: number | undefined }> = [];
    const phantom = Array.from({ length: 99 }, (_, index) =>
      bookmark(`phantom-${index}`, `phantom truncation ${index}`));
    const complete = Array.from({ length: 10 }, (_, index) =>
      bookmark(`complete-${index}`, `complete traversal ${index}`));
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks(request = {}) {
        const scope = request.headOnly ? 'verify' : 'global';
        calls.push({ scope, maxResults: request.maxResults });
        const posts = request.maxResults === 100 ? phantom : complete;
        return {
          posts: request.headOnly ? posts.map((post) => ({ id: post.id })) : posts,
        };
      },
      async fetchBookmarkFolders(request = {}) {
        calls.push({ scope: 'folders', maxResults: request.maxResults });
        return { folders: [] };
      },
      async fetchBookmarksInFolder() { throw new Error('no folders'); },
    };
    try {
      const handler = createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        embeddingProvider: fakeEmbeddingProvider(),
        sourceClient: client,
        account: ACCOUNT,
        userId: 'provider-user-1',
        config: testConfig({ reconcilePageSize: 100 }),
        now: () => ATTEMPTED_AT,
      });
      const result = await handler.reconcile({ attempted_at: ATTEMPTED_AT.toISOString() });
      expect(calls).toEqual([
        { scope: 'global', maxResults: 100 },
        { scope: 'global', maxResults: 80 },
        { scope: 'verify', maxResults: 100 },
        { scope: 'verify', maxResults: 80 },
        { scope: 'folders', maxResults: 100 },
      ]);
      expect(result.warnings).toContain('x_reconcile_truncation_suspected_smaller_page_retry');
      expect(result.counts).toMatchObject({
        items_seen: 10,
        coverage_scope_recency_window: 1,
        window_boundary_verified: 1,
        absence_items_tombstoned: 0,
        out_of_scope_removals: 0,
        reconcile_page_size_80_requests: 2,
        reconcile_page_size_other_requests: 3,
        reconcile_truncation_retries: 2,
      });
      expect(store.searchItems('phantom truncation', 100)).toHaveLength(0);
      expect(store.searchItems('complete traversal', 100)).toHaveLength(10);
    } finally {
      usage.close();
      store.close();
    }
  }, 20_000);

  test('walks every truncation fallback and accepts genuinely short terminal pages at each size', async () => {
    const fallbackCalls: number[] = [];
    const fallbackPosts = Array.from({ length: 10 }, (_, index) => bookmark(`fallback-${index}`));
    const fallbackStore = xStore();
    const fallbackUsage = new LocalXBookmarksApiUsageStore(':memory:');
    try {
      const handler = createXBookmarksConnectorStoreSyncHandler({
        store: fallbackStore,
        usageStore: fallbackUsage,
        embeddingProvider: fakeEmbeddingProvider(),
        sourceClient: {
          async fetchBookmarks(request = {}) {
            const requested = request.maxResults ?? 80;
            fallbackCalls.push(requested);
            const count = requested === 80 ? 79 : requested === 50 ? 49 : 10;
            const posts = requested === 20
              ? fallbackPosts
              : Array.from({ length: count }, (_, index) => bookmark(`phantom-${requested}-${index}`));
            return { posts: request.headOnly ? posts.map((post) => ({ id: post.id })) : posts };
          },
          async fetchBookmarkFolders() { return { folders: [] }; },
          async fetchBookmarksInFolder() { throw new Error('no folders'); },
        },
        account: ACCOUNT,
        userId: 'provider-user-ladder',
        config: testConfig(),
        now: () => ATTEMPTED_AT,
      });
      const result = await handler.reconcile({ attempted_at: ATTEMPTED_AT.toISOString() });
      expect(fallbackCalls).toEqual([80, 50, 20, 80, 50, 20]);
      expect(result.counts).toMatchObject({
        api_requests: 7,
        reconcile_page_size_80_requests: 3,
        reconcile_page_size_50_requests: 2,
        reconcile_page_size_20_requests: 2,
        reconcile_page_size_other_requests: 0,
        reconcile_truncation_retries: 4,
      });
      expect(result.api_usage.api_requests).toBe(7);
    } finally {
      fallbackUsage.close();
      fallbackStore.close();
    }

    for (const pageSize of [80, 50, 20]) {
      const store = xStore();
      const usage = new LocalXBookmarksApiUsageStore(':memory:');
      const calls: number[] = [];
      const posts = Array.from({ length: pageSize - 3 }, (_, index) =>
        bookmark(`short-${pageSize}-${index}`));
      try {
        const handler = createXBookmarksConnectorStoreSyncHandler({
          store,
          usageStore: usage,
          embeddingProvider: fakeEmbeddingProvider(),
          sourceClient: {
            async fetchBookmarks(request = {}) {
              calls.push(request.maxResults ?? pageSize);
              return {
                posts: request.headOnly ? posts.map((post) => ({ id: post.id })) : posts,
              };
            },
            async fetchBookmarkFolders() { return { folders: [] }; },
            async fetchBookmarksInFolder() { throw new Error('no folders'); },
          },
          account: ACCOUNT,
          userId: `provider-user-short-${pageSize}`,
          config: testConfig({ reconcilePageSize: pageSize }),
          now: () => ATTEMPTED_AT,
        });
        const result = await handler.reconcile({ attempted_at: ATTEMPTED_AT.toISOString() });
        expect(calls).toEqual([pageSize, pageSize]);
        expect(result.counts.reconcile_truncation_retries).toBe(0);
      } finally {
        usage.close();
        store.close();
      }
    }
  }, 30_000);

  test('tombstones an overlap-proven in-window removal while preserving archive-owned history', async () => {
    let clock = ATTEMPTED_AT;
    let visible = [
      bookmark('window-newest', 'window newest marker'),
      bookmark('window-removed', 'uniquedeletiontoken'),
      // Preservation-owned AND provider-current, so dropping it below puts a
      // preserved row into the window removal list itself.
      bookmark('archive-current', 'uniquepreservedtoken'),
      bookmark('window-boundary', 'window boundary marker'),
    ];
    const store = xStore(() => clock);
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    await store.syncFromConnector(createXBookmarksSourceConnector({
      account: ACCOUNT,
      connectorId: 'x_bookmarks_archive',
      posts: [
        bookmark('archive-older', 'archive older marker'),
        bookmark('archive-current', 'uniquepreservedtoken'),
      ],
    }), { fetchContent: true, ownershipKind: 'preservation' });
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: {
        async fetchBookmarks(request = {}) {
          return {
            posts: request.headOnly ? visible.map((post) => ({ id: post.id })) : visible,
          };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { throw new Error('no folders'); },
      },
      account: ACCOUNT,
      userId: 'provider-user-removal',
      config: testConfig(),
      now: () => clock,
    });
    try {
      await handler.reconcile({ attempted_at: clock.toISOString() });
      visible = [visible[0]!, visible[3]!];
      clock = new Date('2026-07-25T10:00:00.000Z');
      const result = await handler.reconcile({ attempted_at: clock.toISOString() });
      expect(result.counts).toMatchObject({
        coverage_scope_recency_window: 1,
        window_boundary_verified: 1,
        items_tombstoned: 1,
        absence_items_tombstoned: 0,
        out_of_scope_removals: 0,
      });
      expect(store.searchItems('uniquedeletiontoken', 5)).toHaveLength(0);
      expect(store.searchItems('uniquepreservedtoken', 5)).toHaveLength(1);
      expect(store.searchItems('archive older marker', 5)).toHaveLength(1);
    } finally {
      usage.close();
      store.close();
    }
  }, 20_000);

  test('a standing removal debt is visible in the receipt and warns past the cadence bound', async () => {
    // The store's window_removal_newer_observation_preserved gap never crossed
    // this counts-only boundary, settleWindowRemovalDebt's answer was dropped
    // by its only caller, and first_deferred_at had no reader at all — so a
    // removal could stay owed for ever with no metric, warning or receipt.
    let handlerClock = ATTEMPTED_AT;
    let storeClock = ATTEMPTED_AT;
    const newest = bookmark('debt-newest', 'debt newest marker');
    const removed = bookmark('debt-removed', 'uniquedebtremovedtoken');
    const boundary = bookmark('debt-boundary', 'debt boundary marker');
    let visible = [newest, removed, boundary];
    const store = xStore(() => storeClock);
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: fakeEmbeddingProvider(),
      sourceClient: {
        async fetchBookmarks(request = {}) {
          return {
            posts: request.headOnly ? visible.map((post) => ({ id: post.id })) : visible,
          };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { throw new Error('no folders'); },
      },
      account: ACCOUNT,
      userId: 'provider-user-debt',
      config: testConfig(),
      now: () => handlerClock,
    });
    // Another lane lists the post at the provider AFTER a reconcile's cutoff,
    // which is the one refusal ground the fence honours. Repeat it every cycle
    // and the removal is never applied and never re-derivable.
    const reobserve = async (): Promise<void> => {
      await store.syncFromConnector(createXBookmarksSourceConnector({
        account: ACCOUNT,
        posts: [removed],
      }), { fetchContent: true });
    };
    try {
      await handler.reconcile({ attempted_at: handlerClock.toISOString() });
      visible = [newest, boundary];

      storeClock = new Date('2026-07-26T00:00:00.000Z');
      await reobserve();
      handlerClock = new Date('2026-07-25T10:00:00.000Z');
      const deferred = await handler.reconcile({ attempted_at: handlerClock.toISOString() });
      expect(deferred.counts).toMatchObject({
        window_removed_items: 1,
        window_removed_items_tombstoned: 0,
        window_removals_deferred: 1,
        window_removal_debt_carried: 1,
        window_removal_debt_spent: 0,
        window_removal_debt_standing: 1,
        window_removal_debt_oldest_age_ms: 0,
      });
      expect(deferred.warnings)
        .toContain('x_reconcile_window_removal_newer_observation_preserved');
      expect(deferred.warnings ?? [])
        .not.toContain('x_reconcile_window_removal_debt_standing_beyond_cadence');
      expect(store.searchItems('uniquedebtremovedtoken', 5)).toHaveLength(1);

      // Six days on: still owed, still re-presented, and now past four
      // reconcile cadences — the point at which "not yet" stops being credible.
      storeClock = new Date('2026-08-05T00:00:00.000Z');
      await reobserve();
      handlerClock = new Date('2026-07-31T10:00:00.000Z');
      const stale = await handler.reconcile({ attempted_at: handlerClock.toISOString() });
      expect(stale.counts).toMatchObject({
        window_removals_deferred: 1,
        window_removal_debt_carried: 1,
        window_removal_debt_standing: 1,
        window_removal_debt_oldest_age_ms: 6 * 24 * 60 * 60_000,
      });
      expect(stale.warnings)
        .toContain('x_reconcile_window_removal_debt_standing_beyond_cadence');
    } finally {
      usage.close();
      store.close();
    }
  }, 20_000);

  test('accepts a matching typed window but never removes rows outside that window', async () => {
    const store = xStore();
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const olderObserved = bookmark('older-observed', 'outside window unknown marker');
    await store.syncFromConnector(createXBookmarksSourceConnector({
      account: ACCOUNT,
      posts: [olderObserved],
    }), { fetchContent: true });
    const visible = [
      bookmark('visible-2', 'uniquetwowindowtoken'),
      bookmark('visible-1', 'uniqueonewindowtoken'),
    ];
    const client: XBookmarksLiveSourceClient = {
      async fetchBookmarks(request = {}) {
        if (request.paginationToken) throw boundaryError();
        return {
          posts: request.headOnly
            ? visible.map((post) => ({ id: post.id }))
            : visible,
          nextToken: request.headOnly ? 'verify-edge' : 'rich-edge',
        };
      },
      async fetchBookmarkFolders() { return { folders: [] }; },
      async fetchBookmarksInFolder() { throw new Error('no folders'); },
    };
    try {
      const handler = createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        embeddingProvider: fakeEmbeddingProvider(),
        sourceClient: client,
        account: ACCOUNT,
        userId: 'provider-user-1',
        config: testConfig(),
        providerWindowBoundaryPolicy: WINDOW_POLICY,
        now: () => ATTEMPTED_AT,
      });
      const result = await handler.reconcile({ attempted_at: ATTEMPTED_AT.toISOString() });
      expect(result.counts).toMatchObject({
        coverage_scope_recency_window: 1,
        window_boundary_verified: 1,
        traversal_cardinality: 2,
        verification_cardinality: 2,
        absence_items_tombstoned: 0,
        out_of_scope_removals: 0,
        items_tombstoned: 0,
      });
      expect(result.warnings).toContain('x_reconcile_provider_window_boundary_verified');
      expect(store.searchItems('outside window unknown', 5)).toHaveLength(1);
      expect(store.searchItems('uniquetwowindowtoken', 5)).toHaveLength(1);
      expect(usage.completeReconcileWatermark(ACCOUNT)).toMatchObject({
        coverage_scope: 'recency_window',
        window_boundary_verified: true,
        traversal_cardinality: 2,
        verification_cardinality: 2,
        absence_items_tombstoned: 0,
        out_of_scope_removals: 0,
        global_current_authority: 'green',
      });
    } finally {
      usage.close();
      store.close();
    }
  }, 20_000);
});

function boundaryError(): XApiError {
  return new XApiError('typed provider boundary', 503, undefined, {
    type: WINDOW_TYPE,
    title: 'Bookmark window boundary',
    code: '50301',
  });
}

function bookmark(
  id: string,
  text = `marker-${id}`,
): XBookmarkPost {
  return {
    id,
    text,
    createdAt: '2026-07-24T09:00:00.000Z',
    url: `https://x.com/i/web/status/${id}`,
  };
}

function testConfig(
  overrides: Partial<XBookmarksLiveSyncConfig> = {},
): XBookmarksLiveSyncConfig {
  return {
    ...defaultXBookmarksLiveSyncConfig({}),
    dailyApiRequestBudget: 10_000,
    dailyResourceReadBudget: 100_000,
    dailyEstimatedSpendMicrousd: 100_000_000,
    headApiRequestReserve: 0,
    headResourceReadReserve: 0,
    headEstimatedSpendReserveMicrousd: 0,
    rateLimitLowWatermark: 0,
    ...overrides,
  };
}

// The store stamps owner observation times, and a reconcile compares them
// against its own snapshot cutoff. A store left on the wall clock while the
// handler runs on a mocked one puts every owner in the future relative to the
// snapshot, which is a state no real run can reach, so the clock is injected
// here alongside the handler's.
function xStore(now: () => Date = () => ATTEMPTED_AT): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'internal.x.bookmarks',
    family: 'x',
    trustDomain: 'internal',
    now,
  });
}

function fakeEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'test',
    modelId: 'x-window-test',
    dimension: 3,
    configHash: 'x-window-test-config',
    epochId: 'x-window-test-epoch',
    backend: 'cloud',
    async embed(inputs: SourceEmbeddingInput[]) {
      return inputs.map(() => [1, 0, 0]);
    },
  };
}
