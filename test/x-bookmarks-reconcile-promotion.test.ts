// Promotion-time proofs in the reconcile state store, driven directly.
//
// Two properties live here, both invisible from the connector-level tests:
// what counts as PROOF that an in-window post was really removed, and whether a
// degraded run (one that lost global removal authority) can still come to rest.
// Both decide whether a weekly reconcile deletes rows or stalls the lane, so
// they are exercised against the store rather than through a provider fake.

import { describe, expect, test } from 'bun:test';
import {
  LocalXBookmarksReconcileStateStore,
  X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION,
  type XBookmarkPost,
  type XBookmarksCompletedReconcileSnapshot,
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
 * One complete recency-window run: a single terminal global page, its
 * verification pass, an empty folder inventory, then promotion. `verifyPosts`
 * exists only so a degraded run can stage a provider duplicate on the global
 * pass while the verification pass still matches the deduped sequence.
 */
function reconcileOnce(
  store: LocalXBookmarksReconcileStateStore,
  posts: readonly XBookmarkPost[],
  at: Date,
  verifyPosts: readonly XBookmarkPost[] = posts,
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
    page: { posts: verifyPosts.map((entry) => ({ id: entry.id })) },
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
  expect(store.traversalComplete(ACCOUNT)).toBe(true);
  return store.promoteCompletedSnapshot(ACCOUNT, at);
}

function removedIds(snapshot: XBookmarksCompletedReconcileSnapshot): string[] {
  return snapshot.inWindowRemovedPosts.map((entry) => entry.id);
}

describe('X reconcile promotion: in-window removal proof', () => {
  test('a post that moved above the window cut does not certify the posts it displaced', () => {
    // Re-bookmarking an old post moves it to the newest position, so it appears
    // in the current traversal while still carrying a deep prior ordinal. Set
    // membership alone then "proves" the whole prefix above it was traversed,
    // and the posts its old neighbourhood pushed out of the served window get
    // reported as removals — they are still bookmarked, merely out of reach.
    const store = new LocalXBookmarksReconcileStateStore(':memory:');
    try {
      reconcileOnce(store, ['a', 'b', 'c', 'd'].map(post), new Date('2026-07-24T10:00:00.000Z'));

      const moved = reconcileOnce(
        store,
        ['d', 'a', 'b'].map(post),
        new Date('2026-07-31T10:00:00.000Z'),
      );
      expect(removedIds(moved)).toEqual([]);
      expect(moved.posts.map((entry) => entry.id)).toEqual(['d', 'a', 'b']);

      // The proof still works where the overlap really is order-preserving: an
      // unbookmarked post between two current ones is a proven removal.
      const removed = reconcileOnce(
        store,
        ['d', 'b'].map(post),
        new Date('2026-08-07T10:00:00.000Z'),
      );
      expect(removedIds(removed)).toEqual(['a']);
    } finally {
      store.close();
    }
  });
});

describe('X reconcile promotion: degraded runs', () => {
  test('a run that lost removal authority promotes its carry-forward instead of stalling', () => {
    // A provider duplicate inside one page costs the run its removal authority
    // while the verification pass still matches the deduped sequence. The
    // window proof has to be judged on what the provider actually returned,
    // because the carry-forward that follows it appends rows the verification
    // traversal never saw and can never match.
    const store = new LocalXBookmarksReconcileStateStore(':memory:');
    try {
      reconcileOnce(store, ['a', 'b', 'c'].map(post), new Date('2026-07-24T10:00:00.000Z'));

      const degraded = reconcileOnce(
        store,
        [post('a'), post('a'), post('b')],
        new Date('2026-07-31T10:00:00.000Z'),
        [post('a'), post('b')],
      );

      expect(degraded.globalRemovalAuthoritative).toBe(false);
      expect(degraded.windowBoundaryVerified).toBe(true);
      // The post the degraded run could not vouch for is carried, not dropped,
      // and nothing is reported as a removal.
      expect(degraded.posts.map((entry) => entry.id).sort()).toEqual(['a', 'b', 'c']);
      expect(removedIds(degraded)).toEqual([]);
      expect(degraded.itemsObserved).toBe(2);

      // The promoted snapshot is well formed enough for the next run to open on.
      expect(() => store.openRun(ACCOUNT, LIMITS, PROVIDER_USER_ID, new Date('2026-08-07T10:00:00.000Z'), {
        coverageScope: 'recency_window',
        windowBoundaryAlgorithmVersion: X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION,
      })).not.toThrow();
    } finally {
      store.close();
    }
  });
});
