// Durable deferred-removal debt.
//
// A window removal is a TRANSITION: prior-present, currently-absent. Promotion
// then replaces the prior baseline with a snapshot that omits the post too, so
// the post is absent from both sides for ever after and the derivation can
// never name it again. The transition is offered exactly once.
//
// That is fine while the removal applies. It is not fine when the shared store
// declines it — an owner observed at or after the run's cutoff is newer
// evidence than the absence proof, so the store correctly refuses. Before this,
// the refusal was reported as a count in a coverage gap and nothing else: the
// next promotion cascade-deleted the only record, and an unbookmarked post
// stayed searchable for ever on the strength of one badly-timed head sync.
//
// The debt therefore has to outlive the snapshot that incurred it, be
// re-presented against later cutoffs, and be forgotten the moment the post is
// genuinely re-observed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION,
  createXBookmarksApiSourceConnector,
  defaultXBookmarksLiveSyncConfig,
  type XBookmarkPost,
  type XBookmarksApiSourceConnector,
  type XBookmarksCompletedReconcileSnapshot,
  type XBookmarksLiveSourceClient,
  type XBookmarksReconcileLimits,
} from '../src/workers/x-bookmarks/index.ts';

const ACCOUNT = 'personal';
const PROVIDER_USER_ID = 'provider-user-1';
const LIMITS: XBookmarksReconcileLimits = {
  maxItems: 100,
  maxFolders: 20,
  maxPagesPerScope: 10,
  pageSize: 80,
};

function post(id: string): XBookmarkPost {
  return { id, text: `post ${id}` };
}

/**
 * A reconcile-mode connector whose provider returns exactly `posts`, wired to
 * the supplied state store. One probe promotes a completed snapshot that is
 * PENDING application, which is the state the disposition call settles.
 */
async function probedReconcileConnector(
  store: LocalXBookmarksReconcileStateStore,
  account: string,
  posts: readonly XBookmarkPost[],
  at: Date,
  usage: LocalXBookmarksApiUsageStore,
): Promise<XBookmarksApiSourceConnector> {
  const client: XBookmarksLiveSourceClient = {
    async fetchBookmarks(request = {}) {
      return { posts: request.headOnly ? posts.map((entry) => ({ id: entry.id })) : [...posts] };
    },
    async fetchBookmarkFolders() { return { folders: [] }; },
    async fetchBookmarksInFolder() { return { posts: [] }; },
  };
  const connector = createXBookmarksApiSourceConnector({
    mode: 'reconcile',
    account,
    attemptedAt: at,
    now: () => at,
    usageStore: usage,
    reconcileStateStore: store,
    userId: PROVIDER_USER_ID,
    sourceClient: client,
    config: {
      ...defaultXBookmarksLiveSyncConfig({}),
      dailyApiRequestBudget: 10_000,
      dailyResourceReadBudget: 100_000,
      dailyEstimatedSpendMicrousd: 100_000_000,
      rateLimitLowWatermark: 0,
    },
  });
  const status = await connector.probe();
  expect(status.complete).toBe(true);
  return connector;
}

function reconcileOnce(
  store: LocalXBookmarksReconcileStateStore,
  posts: readonly XBookmarkPost[],
  at: Date,
): XBookmarksCompletedReconcileSnapshot {
  store.openRun(ACCOUNT, LIMITS, PROVIDER_USER_ID, at, {
    coverageScope: 'recency_window',
    windowBoundaryAlgorithmVersion: X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION,
  });
  store.recordGlobalPage({
    account: ACCOUNT,
    page: { posts: [...posts] },
    requestedSize: LIMITS.pageSize,
    limits: LIMITS,
    settledAt: at,
  });
  store.recordGlobalVerificationPage({
    account: ACCOUNT,
    page: { posts: posts.map((entry) => ({ id: entry.id })) },
    requestedSize: LIMITS.pageSize,
    limits: LIMITS,
    settledAt: at,
  });
  store.recordFolderPage({
    account: ACCOUNT,
    page: { folders: [] },
    requestedSize: LIMITS.maxFolders,
    limits: LIMITS,
    settledAt: at,
  });
  return store.promoteCompletedSnapshot(ACCOUNT, at);
}

describe('X reconcile: a removal the store declined is still owed', () => {
  test('a deferred removal survives the promotion that erases its transition', () => {
    const store = new LocalXBookmarksReconcileStateStore(':memory:');
    try {
      reconcileOnce(store, ['a', 'b', 'c'].map(post), new Date('2026-07-24T10:00:00.000Z'));

      // Week two proves 'b' removed. The shared store declines it: a head sync
      // saw an owner after the cutoff, so the absence proof is outranked.
      const proven = reconcileOnce(store, ['a', 'c'].map(post), new Date('2026-07-31T10:00:00.000Z'));
      expect(proven.inWindowRemovedPosts.map((entry) => entry.id)).toEqual(['b']);
      store.settleWindowRemovalDebt(ACCOUNT, {
        presentedPostIds: ['b'],
        deferredPostIds: ['b'],
        observedAt: proven.snapshotObservedAt,
        at: new Date('2026-07-31T11:00:00.000Z'),
      });

      // Week three. 'b' is absent from BOTH the prior baseline and this
      // traversal, so the transition is gone and no derivation can produce it.
      const later = reconcileOnce(store, ['a', 'c'].map(post), new Date('2026-08-07T10:00:00.000Z'));
      expect(later.inWindowRemovedPosts).toEqual([]);
      // The debt is what carries it, straight through the promotion that
      // cascade-deletes every other completed-snapshot child row.
      expect(later.deferredWindowRemovalPostIds).toEqual(['b']);
    } finally {
      store.close();
    }
  });

  test('re-observation forgets the debt, and applying it spends the debt', () => {
    const store = new LocalXBookmarksReconcileStateStore(':memory:');
    try {
      reconcileOnce(store, ['a', 'b', 'c', 'd'].map(post), new Date('2026-07-24T10:00:00.000Z'));
      const proven = reconcileOnce(store, ['a', 'd'].map(post), new Date('2026-07-31T10:00:00.000Z'));
      expect(proven.inWindowRemovedPosts.map((entry) => entry.id)).toEqual(['b', 'c']);
      store.settleWindowRemovalDebt(ACCOUNT, {
        presentedPostIds: ['b', 'c'],
        deferredPostIds: ['b', 'c'],
        observedAt: proven.snapshotObservedAt,
        at: new Date('2026-07-31T11:00:00.000Z'),
      });

      // 'b' is bookmarked again. The provider's own current membership outranks
      // any older absence still owed against it, so promotion forgets that debt
      // and keeps the one it has no answer for.
      const reObserved = reconcileOnce(
        store,
        ['b', 'a', 'd'].map(post),
        new Date('2026-08-07T10:00:00.000Z'),
      );
      expect(reObserved.deferredWindowRemovalPostIds).toEqual(['c']);

      // The next pass presents 'c' again and the store applies it this time.
      store.settleWindowRemovalDebt(ACCOUNT, {
        presentedPostIds: ['c'],
        deferredPostIds: [],
        observedAt: reObserved.snapshotObservedAt,
        at: new Date('2026-08-07T11:00:00.000Z'),
      });
      const settled = reconcileOnce(
        store,
        ['b', 'a', 'd'].map(post),
        new Date('2026-08-14T10:00:00.000Z'),
      );
      expect(settled.deferredWindowRemovalPostIds).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('a pass that presented nothing forgives nothing', () => {
    const store = new LocalXBookmarksReconcileStateStore(':memory:');
    try {
      reconcileOnce(store, ['a', 'b', 'c'].map(post), new Date('2026-07-24T10:00:00.000Z'));
      const proven = reconcileOnce(store, ['a', 'c'].map(post), new Date('2026-07-31T10:00:00.000Z'));
      store.settleWindowRemovalDebt(ACCOUNT, {
        presentedPostIds: ['b'],
        deferredPostIds: ['b'],
        observedAt: proven.snapshotObservedAt,
        at: new Date('2026-07-31T11:00:00.000Z'),
      });

      // A degraded pass that never reached the window branch presents nothing.
      // Silence must not read as "we tried and it applied".
      const outcome = store.settleWindowRemovalDebt(ACCOUNT, {
        presentedPostIds: [],
        deferredPostIds: [],
        observedAt: proven.snapshotObservedAt,
        at: new Date('2026-08-01T11:00:00.000Z'),
      });
      // Nothing settled, and the standing debt is reported with the age anchor
      // an operator needs — the columns existed with no reader before.
      expect(outcome).toEqual({
        carried: 0,
        spent: 0,
        standing: 1,
        oldestFirstDeferredAt: '2026-07-31T11:00:00.000Z',
      });

      const later = reconcileOnce(store, ['a', 'c'].map(post), new Date('2026-08-07T10:00:00.000Z'));
      expect(later.deferredWindowRemovalPostIds).toEqual(['b']);
    } finally {
      store.close();
    }
  });

  test('a crash between the disposition and the settlement replays the whole pass', async () => {
    // The disposition and the debt are one durable fact. Committed apart, the
    // window between them is unrecoverable: 'pending' is the only state that
    // re-presents a promoted snapshot's removals, so a disposition that lands
    // alone spends the replay while the declined removal is still unrecorded,
    // and the next traversal promotes over the baseline and cascade-deletes
    // the transition for ever.
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-debt-atomicity-'));
    const statePath = join(dir, 'reconcile-state.sqlite');
    const store = new LocalXBookmarksReconcileStateStore(statePath);
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    try {
      const at = new Date('2026-07-31T10:00:00.000Z');
      const connector = await probedReconcileConnector(
        store,
        ACCOUNT,
        ['a', 'c'].map(post),
        at,
        usage,
      );

      // SQLITE_BUSY on the debt write, as a deterministic stand-in for any
      // crash after the disposition statement and before the settlement.
      const injected = new Database(statePath);
      injected.exec(`
        CREATE TRIGGER fail_x_window_removal_debt
        BEFORE INSERT ON x_reconcile_deferred_window_removals
        BEGIN
          SELECT RAISE(ABORT, 'injected debt settlement failure');
        END;
      `);
      injected.close();

      await expect(connector.markReconciliationDisposition('applied', {
        presentedWindowRemovalLocalItemIds: [`${ACCOUNT}:b`],
        deferredWindowRemovalLocalItemIds: [`${ACCOUNT}:b`],
      })).rejects.toThrow('injected debt settlement failure');

      // Still pending, so the next acquisition re-presents the same removals
      // instead of traversing afresh over a baseline that already omits them.
      expect(store.pendingCompletedSnapshot(ACCOUNT, PROVIDER_USER_ID)).toBeDefined();
      expect(store.completedSnapshot(ACCOUNT)?.applicationStatus).toBe('pending');
    } finally {
      usage.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a colon in the account does not corrupt the post id the debt is keyed on', async () => {
    // Nothing excludes a colon from an account name, and the codec joins with
    // one. Splitting the local item id on the first colon moved half the
    // account into the post id: the debt row matched no completed post, so
    // promotion could never forgive it, and the local id re-presented from it
    // addressed no row in the shared store.
    const account = 'x:personal';
    const store = new LocalXBookmarksReconcileStateStore(':memory:');
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    try {
      const at = new Date('2026-07-31T10:00:00.000Z');
      const connector = await probedReconcileConnector(
        store,
        account,
        [post('1234'), post('5678')],
        at,
        usage,
      );

      const debt = await connector.markReconciliationDisposition('applied', {
        presentedWindowRemovalLocalItemIds: [`${account}:9999`],
        deferredWindowRemovalLocalItemIds: [`${account}:9999`],
      });

      expect(debt).toMatchObject({ carried: 1, spent: 0, standing: 1 });
      expect(store.completedSnapshot(account)?.deferredWindowRemovalPostIds)
        .toEqual(['9999']);
    } finally {
      usage.close();
      store.close();
    }
  });

  test('the provider-account migration reset clears the debt it derived', () => {
    // The debt is deliberately not a cascade child of the snapshot, so the
    // reset that deletes the baseline has to delete it by name. Otherwise an
    // absence proven against the retired provider user is re-presented against
    // the new one and tombstones a live item.
    const store = new LocalXBookmarksReconcileStateStore(':memory:');
    try {
      reconcileOnce(store, ['a', 'b', 'c'].map(post), new Date('2026-07-24T10:00:00.000Z'));
      const proven = reconcileOnce(store, ['a', 'c'].map(post), new Date('2026-07-31T10:00:00.000Z'));
      store.settleWindowRemovalDebt(ACCOUNT, {
        presentedPostIds: ['b'],
        deferredPostIds: ['b'],
        observedAt: proven.snapshotObservedAt,
        at: new Date('2026-07-31T11:00:00.000Z'),
      });

      expect(store.resetAccountState(ACCOUNT, 'provider_account_migration')).toBe(true);

      const rebuilt = reconcileOnce(store, ['a', 'c'].map(post), new Date('2026-08-07T10:00:00.000Z'));
      expect(rebuilt.deferredWindowRemovalPostIds).toEqual([]);
      // And the reset still reports work done when the debt is all that is left.
      expect(store.resetAccountState('other-account', 'provider_account_migration')).toBe(false);
    } finally {
      store.close();
    }
  });
});
