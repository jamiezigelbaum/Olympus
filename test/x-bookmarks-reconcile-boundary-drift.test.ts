import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  XApiError,
  createXBookmarksApiSourceConnector,
  defaultXBookmarksLiveSyncConfig,
  defaultXBookmarksReconcileStateDbPath,
  type XBookmarkPost,
  type XBookmarksLiveSyncConfig,
} from '../src/workers/x-bookmarks/index.ts';

const ACCOUNT = 'personal';
const ATTEMPT_1 = new Date('2026-08-21T12:00:00.000Z');
const ATTEMPT_2 = new Date('2026-08-21T12:20:00.000Z');
const ATTEMPT_3 = new Date('2026-08-21T12:40:00.000Z');

describe('X reconciliation window-boundary drift', () => {
  test('a verification pass interrupted by the provider rate limit resumes where it stopped', async () => {
    await withStateFiles(async ({ usage, statePath }) => {
      const posts = [bookmark('live-a'), bookmark('live-b'), bookmark('live-c')];
      const firstCalls: string[] = [];
      const first = createXBookmarksApiSourceConnector({
        mode: 'reconcile', account: ACCOUNT, attemptedAt: ATTEMPT_1,
        now: () => ATTEMPT_1, userId: 'provider-user-1', usageStore: usage, config: config(),
        sourceClient: {
          async fetchBookmarks(request = {}) {
            if (!request.headOnly) { firstCalls.push('global'); return { posts }; }
            firstCalls.push(`verify:${request.paginationToken ?? 'first'}`);
            if (!request.paginationToken) {
              return { posts: posts.slice(0, 2).map((post) => ({ id: post.id })), nextToken: 'verify-2' };
            }
            throw new XApiError('rate limited', 429, {
              remaining: 0,
              resetAt: '2026-08-21T12:15:00.000Z',
            });
          },
          async fetchBookmarkFolders() { throw new Error('folders must not run'); },
          async fetchBookmarksInFolder() { throw new Error('memberships must not run'); },
        },
      });
      await expect(first.probe()).rejects.toMatchObject({
        errorKind: 'provider_rate_limited',
        degradedReason: 'provider_rate_limit',
      });
      expect(firstCalls).toEqual(['global', 'verify:first', 'verify:verify-2']);

      const staged = new LocalXBookmarksReconcileStateStore(statePath);
      expect(staged.progress(ACCOUNT)).toMatchObject({
        phase: 'global_verify',
        globalVerifyNextToken: 'verify-2',
        globalVerifyItemsStaged: 2,
        itemsStaged: 3,
        windowBoundaryVerified: false,
      });
      staged.close();

      const resumedCalls: string[] = [];
      const resumed = createXBookmarksApiSourceConnector({
        mode: 'reconcile', account: ACCOUNT, attemptedAt: ATTEMPT_2,
        now: () => ATTEMPT_2, userId: 'provider-user-1', usageStore: usage, config: config(),
        sourceClient: {
          async fetchBookmarks(request = {}) {
            if (!request.headOnly) throw new Error('rich global pages must not replay');
            resumedCalls.push(`verify:${request.paginationToken ?? 'first'}`);
            return { posts: posts.slice(2).map((post) => ({ id: post.id })) };
          },
          async fetchBookmarkFolders() { resumedCalls.push('folders'); return { folders: [] }; },
          async fetchBookmarksInFolder() { return { posts: [] }; },
        },
      });
      expect(await resumed.probe()).toMatchObject({
        complete: true,
        removalAuthoritative: true,
        counts: { itemsSeen: 3, globalVerificationMatched: 1 },
      });
      expect(resumedCalls).toEqual(['verify:verify-2', 'folders']);
      await resumed.markReconciliationDisposition('applied');
    });
  });

  test('a drifted verification tail classifies into staged recovery instead of wedging the run', async () => {
    await withStateFiles(async ({ usage, statePath }) => {
      const posts = [bookmark('drift-a'), bookmark('drift-b'), bookmark('drift-c')];
      // The live sequence: the rich pass observes three items, the verification
      // pass is interrupted by the 15-minute provider rate limit, and by the
      // time it resumes the owner has unbookmarked the tail item. The
      // verification tail can then never match the staged traversal again.
      const client = (verifyTail: XBookmarkPost[]) => ({
        async fetchBookmarks(request: { headOnly?: boolean; paginationToken?: string } = {}) {
          if (!request.headOnly) return { posts };
          if (!request.paginationToken) {
            return {
              posts: posts.slice(0, 2).map((post) => ({ id: post.id })),
              nextToken: 'verify-2',
            };
          }
          return { posts: verifyTail.map((post) => ({ id: post.id })) };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      });
      const connector = (at: Date, verifyTail: XBookmarkPost[]) =>
        createXBookmarksApiSourceConnector({
          mode: 'reconcile', account: ACCOUNT, attemptedAt: at, now: () => at,
          userId: 'provider-user-1', usageStore: usage, config: config(),
          sourceClient: client(verifyTail),
        });

      // First encounter: the drift is recorded as a staged failure the existing
      // recovery machinery owns, not as an anonymous provider_temporary retry.
      await expect(connector(ATTEMPT_1, []).probe()).rejects.toMatchObject({
        errorKind: 'reconcile_incomplete',
        degradedReason: 'x_reconcile_window_boundary_drift',
        counts: { staged_failure_count: 1, staged_recovery_eligible: 1 },
      });
      let state = new LocalXBookmarksReconcileStateStore(statePath);
      expect(state.stagedRecoveryStatus(ACCOUNT, ATTEMPT_1)).toMatchObject({
        staged: true,
        failure_class: 'window_boundary_drift',
        recovery_eligible: true,
      });
      state.close();

      // Second encounter: automatic staged recovery clears the poisoned stage
      // without an operator, exactly as a poisoned cursor does.
      await expect(connector(ATTEMPT_2, []).probe()).rejects.toMatchObject({
        degradedReason: 'x_reconcile_staged_recovery_completed',
        counts: { staged_recovery_completed: 1 },
      });
      state = new LocalXBookmarksReconcileStateStore(statePath);
      expect(state.stagedRecoveryStatus(ACCOUNT, ATTEMPT_2)).toMatchObject({
        staged: false,
        staged_recovery: 'completed',
      });
      state.close();

      // The next run traverses a settled list and completes on its own.
      const healthy = connector(ATTEMPT_3, posts.slice(2));
      expect(await healthy.probe()).toMatchObject({
        complete: true,
        removalAuthoritative: true,
        counts: { itemsSeen: 3, globalVerificationMatched: 1 },
      });
      await healthy.markReconciliationDisposition('applied');
    });
  });

  test('a run that already settled its global boundary never revisits the boundary step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-boundary-consumed-'));
    try {
      const limits = { maxItems: 100, maxFolders: 20, maxPagesPerScope: 10, pageSize: 100 };
      const state = new LocalXBookmarksReconcileStateStore(join(dir, 'reconcile.sqlite'));
      state.openRun(ACCOUNT, limits, 'provider-user-1', ATTEMPT_1, {
        coverageScope: 'recency_window',
        windowBoundaryAlgorithmVersion: 1,
      });
      state.recordGlobalPage({
        account: ACCOUNT,
        page: { posts: [bookmark('settled-a')], nextToken: 'global-2' },
        requestedSize: 100,
        limits,
        settledAt: ATTEMPT_1,
      });
      state.recordGlobalWindowBoundary({
        account: ACCOUNT,
        expectedToken: 'global-2',
        boundaryFingerprintSha256: 'a'.repeat(64),
        algorithmVersion: 1,
        settledAt: ATTEMPT_1,
      });
      const settled = state.progress(ACCOUNT);
      expect(settled).toMatchObject({
        phase: 'global_verify',
        globalBoundarySettled: true,
        windowBoundaryVerified: false,
      });
      expect(settled.globalNextToken).toBeUndefined();

      // Replaying the consumed boundary step is refused as a classified staged
      // drift, so the caller routes it into staged recovery rather than
      // rewinding a verification pass that is already underway.
      expect(() => state.recordGlobalWindowBoundary({
        account: ACCOUNT,
        expectedToken: 'global-2',
        boundaryFingerprintSha256: 'a'.repeat(64),
        algorithmVersion: 1,
        settledAt: ATTEMPT_2,
      })).toThrow('provider-window boundary proof was inconsistent');
      expect(state.progress(ACCOUNT)).toMatchObject({
        phase: 'global_verify',
        globalVerifyPages: 0,
        globalBoundarySettled: true,
      });
      state.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function withStateFiles(
  run: (paths: { usage: LocalXBookmarksApiUsageStore; statePath: string }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-x-boundary-drift-'));
  const usagePath = join(dir, 'usage.sqlite');
  const usage = new LocalXBookmarksApiUsageStore(usagePath);
  try {
    await run({ usage, statePath: defaultXBookmarksReconcileStateDbPath({}, usagePath) });
  } finally {
    usage.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function bookmark(id: string): XBookmarkPost {
  return {
    id,
    text: `marker-${id}`,
    createdAt: '2026-08-21T11:00:00.000Z',
    url: `https://x.com/i/web/status/${id}`,
  };
}

function config(overrides: Partial<XBookmarksLiveSyncConfig> = {}): XBookmarksLiveSyncConfig {
  return {
    ...defaultXBookmarksLiveSyncConfig({}),
    dailyApiRequestBudget: 500,
    dailyResourceReadBudget: 5_000,
    dailyEstimatedSpendMicrousd: 5_000_000,
    headApiRequestReserve: 0,
    headResourceReadReserve: 0,
    headEstimatedSpendReserveMicrousd: 0,
    ...overrides,
  };
}
