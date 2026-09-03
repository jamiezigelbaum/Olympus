import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  XApiError,
  XBookmarksLiveSyncError,
  createXBookmarksApiSourceConnector,
  createXBookmarksConnectorStoreSyncHandler,
  createXBookmarksSourceConnector,
  defaultXBookmarksLiveSyncConfig,
  defaultXBookmarksReconcileStateDbPath,
  type XBookmarkPost,
  type XBookmarksLiveSourceClient,
  type XBookmarksLiveSyncConfig,
} from '../src/workers/x-bookmarks/index.ts';
import { seedCanonicalXBookmarksSnapshot } from './helpers/x-bookmarks-reconcile.ts';

const ACCOUNT = 'personal';
const ATTEMPT_1 = new Date('2026-07-18T12:00:00.000Z');
const ATTEMPT_2 = new Date('2026-07-18T12:05:00.000Z');

describe('X daily reconciliation restart state', () => {
  test('resumes a truncation retry at its persisted smaller rung on the next UTC day', async () => {
    await withStateFiles(async ({ usage }) => {
      const firstDay = new Date('2026-08-17T00:00:00.000Z');
      const secondDay = new Date('2026-08-18T00:00:00.000Z');
      const guarded = config({
        dailyResourceReadBudget: 10_000,
        dailyEstimatedSpendMicrousd: 2_000_000,
        estimatedUnitCostMicrousd: 1_000,
        richResourceExpansionMultiplier: 6,
        headResourceReadReserve: 1_440,
        headEstimatedSpendReserveMicrousd: 1_440_000,
      });
      const seed = usage.reserveRequest({
        account: ACCOUNT,
        requestedMaxResources: 80,
        minimumResources: 80,
        preserveHeadReserve: true,
        config: guarded,
        now: firstDay,
      });
      usage.settleFailure({
        reservation: seed,
        potentiallyBillable: true,
        config: guarded,
        now: firstDay,
      });
      const worstCasePage = Array.from({ length: 80 }, (_, index) => ({
        ...bookmark(`rich-${index}`),
        authorId: `author-${index}`,
        mediaKeys: Array.from({ length: 4 }, (_unused, media) => `media-${index}-${media}`),
      }));
      const firstCalls: number[] = [];
      const first = createXBookmarksApiSourceConnector({
        mode: 'reconcile',
        account: ACCOUNT,
        attemptedAt: firstDay,
        now: () => firstDay,
        userId: 'provider-user-1',
        usageStore: usage,
        config: guarded,
        sourceClient: {
          async fetchBookmarks(request = {}) {
            firstCalls.push(request.maxResults ?? 0);
            return { posts: worstCasePage.slice(0, request.maxResults) };
          },
          async fetchBookmarkFolders() { return { folders: [] }; },
          async fetchBookmarksInFolder() { return { posts: [] }; },
        },
      });
      const firstError = await first.probe().catch((error: unknown) => error);
      expect(firstError).toBeInstanceOf(XBookmarksLiveSyncError);
      expect((firstError as XBookmarksLiveSyncError).errorKind).toBe('api_request_guard');
      expect(firstCalls).toEqual([80]);

      const resumedCalls: number[] = [];
      const resumed = createXBookmarksApiSourceConnector({
        mode: 'reconcile',
        account: ACCOUNT,
        attemptedAt: secondDay,
        now: () => secondDay,
        userId: 'provider-user-1',
        usageStore: usage,
        config: guarded,
        sourceClient: {
          async fetchBookmarks(request = {}) {
            resumedCalls.push(request.maxResults ?? 0);
            throw new XApiError('temporary', 503);
          },
          async fetchBookmarkFolders() { return { folders: [] }; },
          async fetchBookmarksInFolder() { return { posts: [] }; },
        },
      });
      await expect(resumed.probe()).rejects.toMatchObject({ errorKind: 'provider_temporary' });
      expect(resumedCalls).toEqual([50]);
    });
  });

  test('concurrent reconcile callers converge to the tighter retry rung', async () => {
    await withStateFiles(async ({ usage, statePath }) => {
      const state = new LocalXBookmarksReconcileStateStore(statePath);
      const guarded = config({ richResourceExpansionMultiplier: 1 });
      const suspicious = (size: number) => Array.from(
        { length: size },
        (_, index) => bookmark(`race-${size}-${index}`),
      );
      let releaseCallerA!: () => void;
      const callerAHeld = new Promise<void>((resolve) => { releaseCallerA = resolve; });
      let markCallerAStarted!: () => void;
      const callerAStarted = new Promise<void>((resolve) => { markCallerAStarted = resolve; });
      let markCallerBAtTwenty!: () => void;
      const callerBAtTwenty = new Promise<void>((resolve) => { markCallerBAtTwenty = resolve; });
      const callerACalls: number[] = [];
      const callerA = createXBookmarksApiSourceConnector({
        mode: 'reconcile', account: ACCOUNT, attemptedAt: ATTEMPT_1,
        now: () => ATTEMPT_1, userId: 'provider-user-1', usageStore: usage,
        reconcileStateStore: state, config: guarded,
        sourceClient: {
          async fetchBookmarks(request = {}) {
            const size = request.maxResults ?? 0;
            callerACalls.push(size);
            if (size === 80) {
              markCallerAStarted();
              await callerAHeld;
              return { posts: suspicious(80) };
            }
            throw new XApiError('temporary', 503);
          },
          async fetchBookmarkFolders() { return { folders: [] }; },
          async fetchBookmarksInFolder() { return { posts: [] }; },
        },
      });
      const callerBCalls: number[] = [];
      const callerB = createXBookmarksApiSourceConnector({
        mode: 'reconcile', account: ACCOUNT, attemptedAt: ATTEMPT_1,
        now: () => ATTEMPT_1, userId: 'provider-user-1', usageStore: usage,
        reconcileStateStore: state, config: guarded,
        sourceClient: {
          async fetchBookmarks(request = {}) {
            const size = request.maxResults ?? 0;
            callerBCalls.push(size);
            if (size === 20) {
              markCallerBAtTwenty();
              throw new XApiError('temporary', 503);
            }
            return { posts: suspicious(size) };
          },
          async fetchBookmarkFolders() { return { folders: [] }; },
          async fetchBookmarksInFolder() { return { posts: [] }; },
        },
      });

      const callerAProbe = callerA.probe();
      await callerAStarted;
      const callerBProbe = callerB.probe();
      await callerBAtTwenty;
      await expect(callerBProbe).rejects.toMatchObject({ errorKind: 'provider_temporary' });
      expect(callerBCalls).toEqual([80, 50, 20]);
      expect(state.progress(ACCOUNT).postRetryPageSize).toBe(20);

      releaseCallerA();
      await expect(callerAProbe).rejects.toMatchObject({ errorKind: 'provider_temporary' });
      expect(callerACalls).toEqual([80, 20]);
      expect(state.progress(ACCOUNT).postRetryPageSize).toBe(20);
      state.close();
    });
  });

  test('resumes the committed global page after a 429 without rereading page one or writing a partial snapshot', async () => {
    await withStateFiles(async ({ usage, usagePath, statePath }) => {
      const store = xStore();
      const firstCalls: string[] = [];
      const firstClient: XBookmarksLiveSourceClient = {
        async fetchBookmarks(request = {}) {
          firstCalls.push(request.paginationToken ?? 'first');
          if (!request.paginationToken) return { posts: [bookmark('3')], nextToken: 'global-2' };
          throw new XApiError('rate limited', 429, {
            remaining: 0,
            resetAt: '2026-07-18T12:04:00.000Z',
          });
        },
        async fetchBookmarkFolders() { throw new Error('folders must not run'); },
        async fetchBookmarksInFolder() { throw new Error('memberships must not run'); },
      };
      const firstHandler = createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        sourceClient: firstClient,
        embeddingProvider: fakeEmbeddingProvider(),
        account: ACCOUNT,
        userId: 'provider-user-1',
        config: config(),
      });
      await expect(firstHandler.reconcile({ attempted_at: ATTEMPT_1.toISOString() })).rejects.toMatchObject({
        errorKind: 'provider_rate_limited',
        warnings: ['x_reconcile_progress_staged_restart_safe'],
      });
      expect(firstCalls).toEqual(['first', 'global-2']);
      expect(store.searchItems('marker-3', 5)).toHaveLength(0);
      expect(usage.lastCompleteReconcileAt(ACCOUNT)).toBeUndefined();
      expect(usage.headCheckpoint(ACCOUNT)).toBeUndefined();

      const staged = new LocalXBookmarksReconcileStateStore(statePath);
      expect(staged.progress(ACCOUNT)).toMatchObject({
        phase: 'global',
        globalNextToken: 'global-2',
        globalPages: 1,
        itemsStaged: 1,
      });
      staged.close();

      const resumedCalls: string[] = [];
      const resumedClient: XBookmarksLiveSourceClient = {
        async fetchBookmarks(request = {}) {
          if (request.headOnly) {
            resumedCalls.push(`verify:${request.paginationToken ?? 'first'}`);
            return { posts: [bookmark('3'), bookmark('2')] };
          }
          resumedCalls.push(request.paginationToken ?? 'first');
          expect(request.paginationToken).toBe('global-2');
          return { posts: [bookmark('2')] };
        },
        async fetchBookmarkFolders(request = {}) {
          resumedCalls.push(`folders:${request.paginationToken ?? 'first'}`);
          return { folders: [] };
        },
        async fetchBookmarksInFolder() { throw new Error('no folders exist'); },
      };
      const resumedHandler = createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        sourceClient: resumedClient,
        embeddingProvider: fakeEmbeddingProvider(),
        account: ACCOUNT,
        userId: 'provider-user-1',
        config: config(),
        now: () => ATTEMPT_2,
      });
      const result = await resumedHandler.reconcile({ attempted_at: ATTEMPT_2.toISOString() });
      expect(resumedCalls).toEqual(['global-2', 'verify:first', 'folders:first']);
      expect(result).toMatchObject({
        counts: { items_seen: 2, folders_seen: 0, folder_memberships_seen: 0 },
      });
      expect(new Set(store.searchItems('marker', 5).map((hit) => hit.sourceItem.providerItemId)))
        .toEqual(new Set(['3', '2']));
      expect(usage.lastCompleteReconcileAt(ACCOUNT)).toBe(ATTEMPT_2.toISOString());
      expect(usage.headCheckpoint(ACCOUNT)).toBe('3');
      expect(usage.completeReconcileWatermark(ACCOUNT)).toMatchObject({
        completed_at: ATTEMPT_2.toISOString(),
        global_traversal_exhausted: true,
        removal_authoritative: true,
      });

      const completed = new LocalXBookmarksReconcileStateStore(statePath);
      expect(() => completed.progress(ACCOUNT)).toThrow('staged run is not open');
      expect(completed.completedSnapshot(ACCOUNT)).toMatchObject({
        completedAt: ATTEMPT_2.toISOString(),
        checkpoint: '3',
        posts: [{ id: '3' }, { id: '2' }],
      });
      completed.close();
      store.close();
      expect(defaultXBookmarksReconcileStateDbPath({}, usagePath)).toBe(statePath);
    });
  });

  test('resumes between folder inventory pages without replaying global or the first folder page', async () => {
    await withStateFiles(async ({ usage, statePath }) => {
      const firstCalls: string[] = [];
      const first = createXBookmarksApiSourceConnector({
        mode: 'reconcile', account: ACCOUNT, attemptedAt: ATTEMPT_1, userId: 'provider-user-1',
        usageStore: usage, config: config(),
        sourceClient: {
          async fetchBookmarks() { firstCalls.push('global:first'); return { posts: [bookmark('7')] }; },
          async fetchBookmarkFolders(request = {}) {
            firstCalls.push(`folders:${request.paginationToken ?? 'first'}`);
            if (!request.paginationToken) {
              return { folders: [{ id: 'folder-a', name: 'Folder A' }], nextToken: 'folders-2' };
            }
            throw new XApiError('temporary', 503);
          },
          async fetchBookmarksInFolder() { throw new Error('memberships must not run'); },
        },
      });
      await expect(first.probe()).rejects.toBeInstanceOf(XBookmarksLiveSyncError);
      expect(firstCalls).toEqual([
        'global:first',
        'global:first',
        'folders:first',
        'folders:folders-2',
        'folders:folders-2',
        'folders:folders-2',
      ]);

      const resumedCalls: string[] = [];
      const resumed = createXBookmarksApiSourceConnector({
        mode: 'reconcile', account: ACCOUNT, attemptedAt: ATTEMPT_2, userId: 'provider-user-1',
        usageStore: usage, config: config(),
        sourceClient: {
          async fetchBookmarks() { throw new Error('global must not replay'); },
          async fetchBookmarkFolders(request = {}) {
            resumedCalls.push(`folders:${request.paginationToken ?? 'first'}`);
            expect(request.paginationToken).toBe('folders-2');
            return { folders: [{ id: 'folder-empty', name: 'Empty Folder' }] };
          },
          async fetchBookmarksInFolder(folderId) {
            resumedCalls.push(`membership:${folderId}`);
            return { posts: [] };
          },
        },
      });
      expect(await resumed.probe()).toMatchObject({
        complete: true,
        authority: {
          global_current_authority: 'green',
          folder_provenance: 'green',
        },
        counts: {
          foldersSeen: 2,
          folderInventoryCoverageGaps: 0,
          folderMembershipCoverageGaps: 0,
        },
      });
      expect(resumedCalls).toEqual([
        'folders:folders-2',
        'membership:folder-a',
        'membership:folder-empty',
      ]);
      const inventory = new LocalXBookmarksReconcileStateStore(statePath);
      expect(inventory.completedFolderInventory(ACCOUNT)).toEqual([
        { id: 'folder-a', name: 'Folder A' },
        { id: 'folder-empty', name: 'Empty Folder' },
      ]);
      inventory.close();
    });
  }, 10_000);

  test('resumes mid-folder membership at the persisted token and retains prior memberships', async () => {
    await withStateFiles(async ({ usage, statePath }) => {
      const firstCalls: string[] = [];
      const first = createXBookmarksApiSourceConnector({
        mode: 'reconcile', account: ACCOUNT, attemptedAt: ATTEMPT_1, userId: 'provider-user-1',
        usageStore: usage, config: config(),
        sourceClient: {
          async fetchBookmarks() {
            return { posts: [bookmark('base'), bookmark('member-1'), bookmark('member-2')] };
          },
          async fetchBookmarkFolders() { return { folders: [{ id: 'folder-r', name: 'Research' }] }; },
          async fetchBookmarksInFolder(_folderId, request = {}) {
            firstCalls.push(request.paginationToken ?? 'first');
            if (!request.paginationToken) {
              return { posts: [{ id: 'base' }, { id: 'member-1' }], nextToken: 'members-2' };
            }
            throw new XApiError('temporary', 503);
          },
        },
      });
      await expect(first.probe()).rejects.toBeInstanceOf(XBookmarksLiveSyncError);
      expect(firstCalls).toEqual(['first', 'members-2', 'members-2', 'members-2']);

      const staged = new LocalXBookmarksReconcileStateStore(statePath);
      expect(staged.progress(ACCOUNT)).toMatchObject({
        phase: 'memberships',
        membershipFolderOrdinal: 0,
        membershipNextToken: 'members-2',
        membershipPages: 1,
        membershipsStaged: 2,
      });
      staged.close();

      const resumedCalls: string[] = [];
      const resumed = createXBookmarksApiSourceConnector({
        mode: 'reconcile', account: ACCOUNT, attemptedAt: ATTEMPT_2, userId: 'provider-user-1',
        usageStore: usage, config: config(),
        sourceClient: {
          async fetchBookmarks() { throw new Error('global must not replay'); },
          async fetchBookmarkFolders() { throw new Error('folders must not replay'); },
          async fetchBookmarksInFolder(_folderId, request = {}) {
            resumedCalls.push(request.paginationToken ?? 'first');
            return { posts: [{ id: 'member-2' }] };
          },
        },
      });
      expect(await resumed.probe()).toMatchObject({
        complete: true,
        authority: { folder_provenance: 'green' },
        counts: { itemsSeen: 3, foldersSeen: 1, folderMembershipsSeen: 3 },
      });
      expect(resumedCalls).toEqual(['members-2']);
      const completed = new LocalXBookmarksReconcileStateStore(statePath);
      expect(completed.completedSnapshot(ACCOUNT)?.posts.find((post) => post.id === 'base')?.text)
        .toBe('marker-base');
      expect(completed.completedSnapshot(ACCOUNT)?.foldersByPostId.get('base')).toEqual([
        { id: 'folder-r', name: 'Research' },
      ]);
      expect(completed.completedSnapshot(ACCOUNT)?.foldersByPostId.get('member-1')).toEqual([
        { id: 'folder-r', name: 'Research' },
      ]);
      expect(completed.completedSnapshot(ACCOUNT)?.foldersByPostId.get('member-2')).toEqual([
        { id: 'folder-r', name: 'Research' },
      ]);
      completed.close();
    });
  }, 10_000);

  test('keeps token cycles, malformed pages, and duplicate identities fail-closed', async () => {
    await withStateFiles(async ({ usage, statePath }) => {
      const cycle = createXBookmarksApiSourceConnector({
        mode: 'reconcile',
        account: 'cycle',
        attemptedAt: ATTEMPT_1,
        userId: 'provider-user-1',
        usageStore: usage,
        config: config(),
        sourceClient: {
          async fetchBookmarks(request = {}) {
            if (!request.paginationToken) {
              return { posts: [bookmark('cycle-1')], nextToken: 'token-a' };
            }
            if (request.paginationToken === 'token-a') {
              return { posts: [bookmark('cycle-2')], nextToken: 'token-b' };
            }
            return { posts: [bookmark('cycle-3')], nextToken: 'token-a' };
          },
          async fetchBookmarkFolders() { throw new Error('folders must not run'); },
          async fetchBookmarksInFolder() { throw new Error('memberships must not run'); },
        },
      });
      await expect(cycle.probe()).rejects.toMatchObject({
        errorKind: 'reconcile_incomplete',
        degradedReason: 'x_reconcile_pagination_cycle',
        warnings: ['x_reconcile_explicit_staged_recovery_required'],
      });
      const state = new LocalXBookmarksReconcileStateStore(statePath);
      expect(state.completedSnapshot('cycle')).toBeUndefined();
      expect(state.stagedRecoveryStatus('cycle', ATTEMPT_2)).toMatchObject({
        staged: true,
        failure_class: 'pagination_cycle',
        recovery_eligible: false,
        page_counts: { global: 2 },
      });
      state.close();

      const malformed = createXBookmarksApiSourceConnector({
        mode: 'reconcile',
        account: 'malformed',
        attemptedAt: ATTEMPT_1,
        userId: 'provider-user-1',
        usageStore: usage,
        config: config(),
        sourceClient: {
          async fetchBookmarks() {
            return { posts: undefined } as unknown as Awaited<
              ReturnType<XBookmarksLiveSourceClient['fetchBookmarks']>
            >;
          },
          async fetchBookmarkFolders() { throw new Error('folders must not run'); },
          async fetchBookmarksInFolder() { throw new Error('memberships must not run'); },
        },
      });
      await expect(malformed.probe()).rejects.toThrow();
      const malformedState = new LocalXBookmarksReconcileStateStore(statePath);
      expect(malformedState.completedSnapshot('malformed')).toBeUndefined();
      expect(malformedState.progress('malformed')).toMatchObject({
        phase: 'global',
        globalPages: 0,
        itemsStaged: 0,
      });
      malformedState.close();

      const duplicate = createXBookmarksApiSourceConnector({
        mode: 'reconcile',
        account: 'duplicate',
        attemptedAt: ATTEMPT_1,
        userId: 'provider-user-1',
        usageStore: usage,
        config: config(),
        sourceClient: {
          async fetchBookmarks(request = {}) {
            return {
              posts: request.headOnly
                ? [{ id: 'duplicate-1' }]
                : [bookmark('duplicate-1'), bookmark('duplicate-1')],
            };
          },
          async fetchBookmarkFolders() { return { folders: [] }; },
          async fetchBookmarksInFolder() { return { posts: [] }; },
        },
      });
      expect(await duplicate.probe()).toMatchObject({
        authority: { global_current_authority: 'degraded' },
        removalAuthoritative: false,
      });
    });
  });

  test('bounds poisoned-cursor and deleted-folder 4xx recovery to staged state', async () => {
    await withStateFiles(async ({ usage, statePath }) => {
      for (const [index, failureKind] of ['expired_cursor', 'deleted_folder'].entries()) {
        const account = `recovery-${failureKind}`;
        const baselinePost = bookmark(`baseline-${index}`);
        const folder = { id: `folder-${index}`, name: `Folder ${index}` };
        let state = new LocalXBookmarksReconcileStateStore(statePath);
        seedCanonicalXBookmarksSnapshot(state, {
          account,
          providerUserId: 'provider-user-1',
          posts: [baselinePost],
          folders: [folder],
          foldersByPostId: new Map([[baselinePost.id, [folder]]]),
          seededAt: ATTEMPT_1,
        });
        state.close();

        const connectorStore = xStore();
        await connectorStore.syncFromConnector(createXBookmarksSourceConnector({
          account,
          posts: [baselinePost],
        }), { fetchContent: true });
        const beforeItem = connectorStore.searchItems(`marker-${baselinePost.id}`, 5)[0]?.sourceItem;

        const poisonedClient: XBookmarksLiveSourceClient = {
          async fetchBookmarks(request = {}) {
            if (failureKind === 'expired_cursor' && request.paginationToken) {
              throw new XApiError('expired cursor', 400);
            }
            return {
              posts: request.headOnly ? [{ id: baselinePost.id }] : [baselinePost],
              ...(failureKind === 'expired_cursor' && !request.headOnly
                ? { nextToken: 'poisoned-token' }
                : {}),
            };
          },
          async fetchBookmarkFolders() { return { folders: [folder] }; },
          async fetchBookmarksInFolder() {
            if (failureKind === 'deleted_folder') {
              throw new XApiError('deleted folder', 404);
            }
            return { posts: [{ id: baselinePost.id }] };
          },
        };
        const connector = (at: Date, sourceClient = poisonedClient) =>
          createXBookmarksApiSourceConnector({
            mode: 'reconcile',
            account,
            attemptedAt: at,
            userId: 'provider-user-1',
            usageStore: usage,
            sourceClient,
            config: config(),
            now: () => at,
          });

        await expect(connector(ATTEMPT_1).probe()).rejects.toMatchObject({
          degradedReason: failureKind === 'expired_cursor'
            ? 'x_reconcile_invalid_or_expired_cursor'
            : 'x_reconcile_deleted_scope',
          counts: { staged_failure_count: 1, staged_recovery_eligible: 1 },
        });
        await expect(connector(ATTEMPT_2).probe()).rejects.toMatchObject({
          degradedReason: 'x_reconcile_staged_recovery_completed',
          warnings: ['x_reconcile_staged_recovery_completed'],
          counts: { staged_recovery_completed: 1 },
        });

        state = new LocalXBookmarksReconcileStateStore(statePath);
        expect(state.stagedRecoveryStatus(account, ATTEMPT_2)).toMatchObject({
          staged: false,
          staged_recovery: 'completed',
        });
        expect(state.completedSnapshot(account)).toMatchObject({
          posts: [{ id: baselinePost.id, text: baselinePost.text }],
          folders: [folder],
          folderMembershipCoverageGaps: 0,
        });
        state.close();
        expect(connectorStore.searchItems(`marker-${baselinePost.id}`, 5)[0]?.sourceItem)
          .toEqual(beforeItem);

        const healthyClient: XBookmarksLiveSourceClient = {
          async fetchBookmarks(request = {}) {
            return { posts: request.headOnly ? [{ id: baselinePost.id }] : [baselinePost] };
          },
          async fetchBookmarkFolders() { return { folders: [folder] }; },
          async fetchBookmarksInFolder() { return { posts: [{ id: baselinePost.id }] }; },
        };
        expect(await connector(
          new Date(ATTEMPT_2.getTime() + 5 * 60_000),
          healthyClient,
        ).probe()).toMatchObject({
          authority: {
            global_current_authority: 'green',
            folder_provenance: 'green',
            staged_recovery: 'completed',
          },
        });
        connectorStore.close();
      }
    });
  });

  test('requires an identical ordered ID-only global verification pass for removal authority', async () => {
    await withStateFiles(async ({ usage }) => {
      const original = [bookmark('verify-a'), bookmark('verify-b'), bookmark('verify-c')];
      const cases = [
        { account: 'exact', verified: original, authoritative: true },
        { account: 'reordered', verified: [original[1]!, original[0]!, original[2]!], authoritative: false },
        { account: 'added', verified: [...original, bookmark('verify-d')], authoritative: false },
        { account: 'removed', verified: original.slice(0, 2), authoritative: false },
      ];
      for (const candidate of cases) {
        const connector = createXBookmarksApiSourceConnector({
          mode: 'reconcile',
          account: candidate.account,
          attemptedAt: ATTEMPT_1,
          userId: 'provider-user-1',
          usageStore: usage,
          config: config(),
          sourceClient: {
            async fetchBookmarks(request = {}) {
              return { posts: request.headOnly ? candidate.verified : original };
            },
            async fetchBookmarkFolders() { return { folders: [] }; },
            async fetchBookmarksInFolder() { return { posts: [] }; },
          },
        });
        if (candidate.authoritative) {
          const status = await connector.probe();
          expect(status).toMatchObject({
            removalAuthoritative: true,
            counts: { globalVerificationMatched: 1 },
          });
          await connector.markReconciliationDisposition('applied');
        } else {
          // No removal authority without an identical ordered verification
          // pass — and the unusable stage is handed to staged recovery rather
          // than parked on a retry loop that replays the same mismatch.
          await expect(connector.probe()).rejects.toMatchObject({
            errorKind: 'reconcile_incomplete',
            degradedReason: 'x_reconcile_window_boundary_drift',
            counts: { staged_failure_count: 1, staged_recovery_eligible: 1 },
          });
        }
      }
    });
  });

  test('resumes a second-pass verification token without refetching rich global pages', async () => {
    await withStateFiles(async ({ usage, statePath }) => {
      const posts = [bookmark('restart-a'), bookmark('restart-b'), bookmark('restart-c')];
      const firstCalls: string[] = [];
      const first = createXBookmarksApiSourceConnector({
        mode: 'reconcile', account: ACCOUNT, attemptedAt: ATTEMPT_1,
        userId: 'provider-user-1', usageStore: usage, config: config(),
        sourceClient: {
          async fetchBookmarks(request = {}) {
            if (!request.headOnly) {
              firstCalls.push('rich');
              return { posts };
            }
            firstCalls.push(`verify:${request.paginationToken ?? 'first'}`);
            if (!request.paginationToken) {
              return { posts: posts.slice(0, 2), nextToken: 'verify-2' };
            }
            throw new XApiError('temporary', 503);
          },
          async fetchBookmarkFolders() { throw new Error('folders must not run'); },
          async fetchBookmarksInFolder() { throw new Error('memberships must not run'); },
        },
      });
      await expect(first.probe()).rejects.toBeInstanceOf(XBookmarksLiveSyncError);
      expect(firstCalls).toEqual(['rich', 'verify:first', 'verify:verify-2']);
      const staged = new LocalXBookmarksReconcileStateStore(statePath);
      expect(staged.progress(ACCOUNT)).toMatchObject({
        phase: 'global_verify',
        globalVerifyNextToken: 'verify-2',
        globalVerifyPages: 1,
        globalVerifyItemsStaged: 2,
      });
      staged.close();

      const resumedCalls: string[] = [];
      const resumed = createXBookmarksApiSourceConnector({
        mode: 'reconcile', account: ACCOUNT, attemptedAt: ATTEMPT_2,
        userId: 'provider-user-1', usageStore: usage, config: config(),
        sourceClient: {
          async fetchBookmarks(request = {}) {
            resumedCalls.push(`verify:${request.paginationToken ?? 'first'}`);
            expect(request.headOnly).toBe(true);
            expect(request.paginationToken).toBe('verify-2');
            return { posts: posts.slice(2) };
          },
          async fetchBookmarkFolders() { resumedCalls.push('folders'); return { folders: [] }; },
          async fetchBookmarksInFolder() { return { posts: [] }; },
        },
      });
      expect(await resumed.probe()).toMatchObject({
        complete: true,
        removalAuthoritative: true,
        counts: { globalVerificationMatched: 1 },
      });
      expect(resumedCalls).toEqual(['verify:verify-2', 'folders']);
      await resumed.markReconciliationDisposition('applied');
    });
  });

  test('preserves prior memberships for a silent 20-item folder window, then replaces them on an authoritative short page', async () => {
    await withStateFiles(async ({ usage, statePath }) => {
      const posts = Array.from({ length: 25 }, (_, index) => bookmark(`folder-post-${index}`));
      let pass: 'seed' | 'silent' | 'short' = 'seed';
      const client: XBookmarksLiveSourceClient = {
        async fetchBookmarks() { return { posts }; },
        async fetchBookmarkFolders() { return { folders: [{ id: 'folder-coverage', name: 'Coverage' }] }; },
        async fetchBookmarksInFolder(_folderId, request = {}) {
          if (pass === 'seed') {
            return request.paginationToken
              ? { posts: posts.slice(20) }
              : { posts: posts.slice(0, 20), nextToken: 'folder-page-2' };
          }
          if (pass === 'silent') return { posts: posts.slice(0, 20) };
          return { posts: [] };
        },
      };
      const connector = (at: Date) => createXBookmarksApiSourceConnector({
        mode: 'reconcile',
        account: ACCOUNT,
        attemptedAt: at,
        userId: 'provider-user-1',
        usageStore: usage,
        sourceClient: client,
        config: config(),
      });

      const seededConnector = connector(ATTEMPT_1);
      expect(await seededConnector.probe()).toMatchObject({
        removalAuthoritative: true,
        authority: { folder_provenance: 'green' },
        counts: { folderMembershipsSeen: 25, folderMembershipCoverageGaps: 0 },
        warnings: ['x_reconcile_provider_window_boundary_verified'],
      });
      await seededConnector.markReconciliationDisposition('applied');

      pass = 'silent';
      const silentConnector = connector(ATTEMPT_2);
      const silent = await silentConnector.probe();
      expect(silent).toMatchObject({
        removalAuthoritative: true,
        counts: { folderMembershipsSeen: 25, folderMembershipCoverageGaps: 1 },
        warnings: [
          'x_reconcile_provider_window_boundary_verified',
          'x_reconcile_folder_membership_coverage_partial_preserved',
        ],
      });
      await silentConnector.markReconciliationDisposition('applied');
      let state = new LocalXBookmarksReconcileStateStore(statePath);
      expect(state.completedSnapshot(ACCOUNT)?.foldersByPostId.get('folder-post-24')).toEqual([
        { id: 'folder-coverage', name: 'Coverage' },
      ]);
      state.close();

      pass = 'short';
      const shortConnector = connector(new Date('2026-07-18T12:10:00.000Z'));
      expect(await shortConnector.probe()).toMatchObject({
        removalAuthoritative: true,
        counts: { folderMembershipsSeen: 0, folderMembershipCoverageGaps: 0 },
      });
      await shortConnector.markReconciliationDisposition('applied');
      state = new LocalXBookmarksReconcileStateStore(statePath);
      expect(state.completedSnapshot(ACCOUNT)?.foldersByPostId.size).toBe(0);
      state.close();
    });
  });

  test('carries a 640-item canonical snapshot through the first silent folder reconciliation', async () => {
    await withStateFiles(async ({ usage, statePath }) => {
      const state = new LocalXBookmarksReconcileStateStore(statePath);
      const posts = Array.from({ length: 640 }, (_, index) => bookmark(`legacy-${index}`));
      const folder = { id: 'legacy-large-folder', name: 'Legacy Large Folder' };
      expect(seedCanonicalXBookmarksSnapshot(state, {
        account: ACCOUNT,
        providerUserId: 'provider-user-1',
        posts,
        folders: [folder],
        foldersByPostId: new Map(posts.map((post) => [post.id, [folder]])),
      })).toMatchObject({
        applicationStatus: 'applied', itemsObserved: 640, foldersObserved: 1,
      });

      const connector = createXBookmarksApiSourceConnector({
        mode: 'reconcile',
        account: ACCOUNT,
        attemptedAt: ATTEMPT_1,
        userId: 'provider-user-1',
        usageStore: usage,
        reconcileStateStore: state,
        config: config({
          richResourceExpansionMultiplier: 1,
          dailyResourceReadBudget: 20_000,
          dailyEstimatedSpendMicrousd: 20_000_000,
        }),
        sourceClient: {
          async fetchBookmarks(request = {}) {
            const token = request.paginationToken;
            const offset = token ? Number(token.split('-').at(-1)) : 0;
            const pageSize = request.maxResults ?? 100;
            const selected = posts.slice(offset, offset + pageSize);
            const nextOffset = offset + selected.length;
            return {
              posts: request.headOnly
                ? selected.map((post) => ({ id: post.id }))
                : selected,
              ...(nextOffset < posts.length
                ? { nextToken: `${request.headOnly ? 'verify' : 'rich'}-${nextOffset}` }
                : {}),
            };
          },
          async fetchBookmarkFolders() { return { folders: [folder] }; },
          async fetchBookmarksInFolder() {
            return { posts: posts.slice(0, 20).map((post) => ({ id: post.id })) };
          },
        },
      });
      expect(await connector.probe()).toMatchObject({
        removalAuthoritative: true,
        counts: {
          itemsSeen: 640,
          folderMembershipsSeen: 640,
          folderMembershipCoverageGaps: 1,
          globalVerificationMatched: 1,
        },
      });
      expect(state.completedSnapshot(ACCOUNT)?.foldersByPostId.get('legacy-639')).toEqual([folder]);
      await connector.markReconciliationDisposition('applied');
      expect(state.completedSnapshot(ACCOUNT)?.applicationStatus).toBe('applied');
      expect(state.completedSnapshot(ACCOUNT)?.posts).toHaveLength(640);
      state.close();
    });
  });

  test('persists empty folders privately, requires digest-guarded incompatible/corrupt recovery, and keeps the DB owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-reconcile-state-'));
    const path = join(dir, 'reconcile.sqlite');
    const limits = { maxItems: 100, maxFolders: 20, maxPagesPerScope: 10, pageSize: 100 };
    try {
      let state = new LocalXBookmarksReconcileStateStore(path);
      state.openRun(ACCOUNT, limits, 'provider-user-a', ATTEMPT_1);
      state.recordGlobalPage({
        account: ACCOUNT,
        page: { posts: [bookmark('1')], nextToken: 'next' },
        requestedSize: 100,
        limits,
        settledAt: ATTEMPT_1,
      });
      state.close();
      expect(statSync(path).mode & 0o777).toBe(0o600);

      state = new LocalXBookmarksReconcileStateStore(path);
      expect(() => state.openRun(ACCOUNT, limits, 'provider-user-b', ATTEMPT_2))
        .toThrow('explicit state reset is required');
      expect(state.resetAccountState(ACCOUNT, 'provider_account_migration')).toBe(true);
      expect(state.openRun(ACCOUNT, limits, 'provider-user-b', ATTEMPT_2)).toMatchObject({
        warnings: [],
        progress: { phase: 'global', itemsStaged: 0, globalPages: 0 },
      });
      state.recordGlobalPage({
        account: ACCOUNT,
        page: { posts: [bookmark('before-limit-change')], nextToken: 'next-limit' },
        requestedSize: 100,
        limits,
        settledAt: ATTEMPT_2,
      });
      expect(() => state.openRun(
        ACCOUNT,
        { ...limits, maxItems: 101 },
        'provider-user-b',
        ATTEMPT_2,
      )).toThrow('incompatible_stage requires explicit staged-run recovery');
      let recovery = state.stagedRecoveryStatus(ACCOUNT, ATTEMPT_2);
      expect(recovery).toMatchObject({
        staged: true,
        failure_class: 'incompatible_stage',
        recovery_eligible: false,
      });
      expect(state.recoverStagedRun({
        account: ACCOUNT,
        expectedStagedDigestSha256: recovery.staged_digest_sha256!,
        mode: 'operator',
        recoveredAt: ATTEMPT_2,
      })).toMatchObject({ staged_recovery: 'completed', completed_baseline_preserved: true });
      expect(state.openRun(ACCOUNT, { ...limits, maxItems: 101 }, 'provider-user-b', ATTEMPT_2))
        .toMatchObject({ warnings: [], progress: { phase: 'global', itemsStaged: 0 } });
      state.recordGlobalPage({
        account: ACCOUNT,
        page: { posts: [bookmark('corrupt-me')], nextToken: 'later' },
        requestedSize: 100,
        limits: { ...limits, maxItems: 101 },
        settledAt: ATTEMPT_2,
      });
      state.close();

      const db = new Database(path);
      db.query(`
        UPDATE x_reconcile_stage_posts SET post_json = 'not-json'
        WHERE account_id = ? AND post_id = ?
      `).run(ACCOUNT, 'corrupt-me');
      db.close();

      state = new LocalXBookmarksReconcileStateStore(path);
      expect(() => state.openRun(
        ACCOUNT,
        { ...limits, maxItems: 101 },
        'provider-user-b',
        ATTEMPT_2,
      )).toThrow('corrupt_stage requires explicit staged-run recovery');
      recovery = state.stagedRecoveryStatus(ACCOUNT, ATTEMPT_2);
      expect(recovery).toMatchObject({
        staged: true,
        failure_class: 'corrupt_stage',
        recovery_eligible: false,
      });
      expect(state.recoverStagedRun({
        account: ACCOUNT,
        expectedStagedDigestSha256: recovery.staged_digest_sha256!,
        mode: 'operator',
        recoveredAt: ATTEMPT_2,
      })).toMatchObject({ staged_recovery: 'completed', completed_baseline_preserved: true });
      expect(state.openRun(ACCOUNT, { ...limits, maxItems: 101 }, 'provider-user-b', ATTEMPT_2))
        .toMatchObject({ progress: { phase: 'global', itemsStaged: 0, globalPages: 0 } });
      expect(state.completedFolderInventory(ACCOUNT)).toEqual([]);
      state.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function withStateFiles(
  run: (paths: {
    usage: LocalXBookmarksApiUsageStore;
    usagePath: string;
    statePath: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-x-reconcile-resume-'));
  const usagePath = join(dir, 'usage.sqlite');
  const statePath = defaultXBookmarksReconcileStateDbPath({}, usagePath);
  const usage = new LocalXBookmarksApiUsageStore(usagePath);
  try {
    await run({ usage, usagePath, statePath });
  } finally {
    usage.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function xStore(): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'internal.x.bookmarks',
    family: 'x',
    trustDomain: 'internal',
  });
}

function bookmark(id: string): XBookmarkPost {
  return {
    id,
    text: `marker-${id}`,
    createdAt: '2026-07-18T11:00:00.000Z',
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

function fakeEmbeddingProvider(): SourceEmbeddingProvider & { calls: SourceEmbeddingInput[][] } {
  const calls: SourceEmbeddingInput[][] = [];
  return {
    provider: 'test',
    modelId: 'x-reconcile-test',
    dimension: 3,
    configHash: 'x-reconcile-test-config',
    epochId: 'x-reconcile-test-epoch',
    backend: 'cloud',
    calls,
    async embed(inputs) {
      calls.push(inputs);
      return inputs.map(() => [1, 0, 0]);
    },
  };
}
