// Real Contract 1 X connector: owns credential acquisition, provider listing,
// restart cursor interpretation, rate/cost control, normalization, fetch, and
// sensitivity. Downstream code sees only SourceConnector.

import { createHash } from 'node:crypto';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import type { SourceSensitivity } from '../../core/source-index/types.ts';
import {
  createEnvCredentialBroker,
  requireBearerTokenCredentialSession,
  type CredentialBroker,
} from '../credential-broker/index.ts';
import {
  XApiClient,
  XApiError,
  type XApiClientOptions,
  type XApiRateLimit,
  type XBookmarkFolder,
  type XBookmarkFolderPage,
  type XBookmarkPost,
  type XBookmarkPostPage,
} from './api.ts';
import {
  createXBookmarksSourceConnector,
  xBookmarkLocalItemId,
  type XBookmarkFolderIdentity,
} from './connector.ts';
import {
  LocalXBookmarksApiUsageStore,
  X_BOOKMARKS_FOLDER_PROVIDER_OUTAGE_WARNING,
  XApiUsageGuardError,
  defaultXBookmarksLiveSyncConfig,
  xApiInvocationProvenance,
  type XApiInvocationProvenance,
  type XApiUsageStatus,
  type XBookmarksLiveSyncConfig,
} from './live-control.ts';
import {
  LocalXBookmarksReconcileStateStore,
  ReconcilePaginationCycleError,
  ReconcilePreservationFloorError,
  ReconcileStageLimitError,
  ReconcileStagedRecoveryRequiredError,
  ReconcileWindowBoundaryMismatchError,
  X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION,
  defaultXBookmarksReconcileStateDbPath,
  type XBookmarksCompletedReconcileSnapshot,
  type XBookmarksReconcileLimits,
  type XBookmarksStagedFailureClass,
  type XBookmarksWindowRemovalDebtOutcome,
} from './reconcile-state.ts';

const X_BOOKMARKS_FOLDER_PROVIDER_MAX_ATTEMPTS = 3;

export type XBookmarksLiveSyncErrorKind =
  | 'provider_rate_limited'
  | 'provider_temporary'
  | 'api_request_guard'
  | 'reconcile_incomplete';

export class XBookmarksLiveSyncError extends Error {
  readonly errorKind: XBookmarksLiveSyncErrorKind;
  readonly retryAt: string | undefined;
  readonly degradedReason: string | undefined;
  readonly warnings: string[];
  readonly counts: Record<string, number> | undefined;
  /** Internal content-free provider classification; never crosses the admin boundary. */
  readonly providerStatus: number | undefined;

  constructor(options: {
    errorKind: XBookmarksLiveSyncErrorKind;
    message: string;
    retryAt?: string;
    degradedReason?: string;
    warnings?: string[];
    counts?: Record<string, number>;
    providerStatus?: number;
  }) {
    super(options.message);
    this.name = 'XBookmarksLiveSyncError';
    this.errorKind = options.errorKind;
    this.retryAt = options.retryAt;
    this.degradedReason = options.degradedReason;
    this.warnings = options.warnings ?? [];
    this.counts = options.counts;
    this.providerStatus = options.providerStatus;
  }
}

export interface XBookmarksLiveSourceClient {
  fetchBookmarks(request?: {
    maxResults?: number;
    paginationToken?: string;
    headOnly?: boolean;
    strictSnapshot?: boolean;
  }): Promise<XBookmarkPostPage>;
  fetchBookmarkFolders(request?: {
    maxResults?: number;
    paginationToken?: string;
    strictSnapshot?: boolean;
  }): Promise<XBookmarkFolderPage>;
  fetchBookmarksInFolder(folderId: string, request?: {
    maxResults?: number;
    paginationToken?: string;
    strictSnapshot?: boolean;
  }): Promise<XBookmarkPostPage>;
}

export interface XBookmarksApiConnectorStatus {
  mode: 'incremental' | 'reconcile';
  complete: boolean;
  changed: boolean;
  checkpoint?: string;
  warnings: string[];
  globalTraversalExhausted?: boolean;
  removalAuthoritative?: boolean;
  coverageScope?: 'account_snapshot' | 'recency_window';
  windowBoundaryVerified?: boolean;
  traversalDigestSha256?: string;
  traversalCardinality?: number;
  verificationDigestSha256?: string;
  verificationCardinality?: number;
  /** Internal exact removals proven inside the verified provider window. */
  inWindowRemovedLocalItemIds?: string[];
  /** Internal provider snapshot cutoff for retry-safe absence application. */
  snapshotObservedAt?: string;
  /** Immutable provider traversal completion for freshness proof. */
  snapshotCompletedAt?: string;
  completeReconciliationAuthoritative?: boolean;
  authority?: {
    global_current_authority: 'green' | 'degraded';
    folder_provenance: 'green' | 'degraded';
    staged_recovery: 'not_needed' | 'completed';
  };
  counts: {
    apiRequests: number;
    itemsSeen: number;
    foldersSeen: number;
    folderMembershipsSeen: number;
    folderPostsAbsentFromGlobal: number;
    globalVerificationMatched: number;
    folderInventoryCoverageGaps: number;
    foldersCarriedForward: number;
    folderMembershipCoverageGaps: number;
    folderProviderOutage: number;
    pageSize80Requests: number;
    pageSize50Requests: number;
    pageSize20Requests: number;
    pageSizeOtherRequests: number;
    truncationRetries: number;
    headPagesRead: number;
    headPageSizesUsed: readonly number[];
    headTruncationDeferrals: number;
  };
}

export interface XBookmarksApiSourceConnector extends SourceConnector {
  /** Source-owned minimal acquisition; caches results for the next listItems. */
  probe(cursor?: string): Promise<XBookmarksApiConnectorStatus>;
  status(): XBookmarksApiConnectorStatus;
  apiUsageStatus(): XApiUsageStatus;
  markReconciliationDisposition(
    disposition: 'applied' | 'degraded',
    outcome?: XBookmarksReconciliationApplicationOutcome,
  ): Promise<XBookmarksWindowRemovalDebtOutcome>;
}

/**
 * What the shared store did with the removals this pass presented.
 *
 * Reported back through the disposition call because this is the only moment
 * both facts exist together: the connector knows which removals it presented,
 * and only the store knows which of them it declined. Omitting it leaves the
 * standing debt exactly as it was, which is the honest outcome for a pass that
 * never reached the window branch.
 */
export interface XBookmarksReconciliationApplicationOutcome {
  /**
   * The removals this pass actually HANDED to the shared store, which is
   * narrower than the ones the snapshot offered: a run that lost removal
   * authority, or one whose coverage is an account snapshot rather than a
   * window, presents none. Only what was presented can be settled — the caller
   * reports it because only the caller knows which branch it took.
   */
  presentedWindowRemovalLocalItemIds: readonly string[];
  /**
   * Removals the store proved absent but declined to apply because an owner was
   * observed at or after this run's cutoff. Carried forward to a later cutoff.
   */
  deferredWindowRemovalLocalItemIds: readonly string[];
}

export interface XBookmarksApiSourceConnectorOptions {
  mode: 'incremental' | 'reconcile';
  account: string;
  attemptedAt: Date;
  /** Who initiated this run; anything but 'operator' fails closed to 'scheduled'. */
  provenance?: XApiInvocationProvenance;
  now?: () => Date;
  usageStore: LocalXBookmarksApiUsageStore;
  /** Optional test/repair injection. Production derives an owner-private DB from the usage-store path. */
  reconcileStateStore?: LocalXBookmarksReconcileStateStore;
  config?: XBookmarksLiveSyncConfig;
  sourceClient?: XBookmarksLiveSourceClient;
  credentialBroker?: CredentialBroker;
  credentialHandle?: string;
  userId?: string;
  fetch?: XApiClientOptions['fetch'];
  apiBaseUrl?: string;
  timeoutMs?: number;
  /** Exact owner-reviewed digest for one proposed below-floor snapshot. No env fallback. */
  preservationFloorAuthorizationSha256?: string;
  /**
   * Exact owner-approved provider boundary identifiers. Production deliberately
   * defaults to none until a diagnostic proves X emits a distinct contract.
   */
  providerWindowBoundaryPolicy?: XBookmarksProviderWindowBoundaryPolicy;
  env?: Record<string, string | undefined>;
}

export interface XBookmarksProviderWindowBoundaryPolicy {
  algorithmVersion: number;
  approvedProviderErrorTypes: readonly string[];
  approvedProviderErrorCodes: readonly string[];
}

export interface XBookmarksProviderWindowBoundaryEvidence {
  algorithmVersion: number;
  fingerprintSha256: string;
}

export const X_BOOKMARKS_NO_APPROVED_WINDOW_BOUNDARY:
  XBookmarksProviderWindowBoundaryPolicy = Object.freeze({
    algorithmVersion: X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION,
    approvedProviderErrorTypes: Object.freeze([]),
    approvedProviderErrorCodes: Object.freeze([]),
  });

export function createXBookmarksApiSourceConnector(
  options: XBookmarksApiSourceConnectorOptions,
): XBookmarksApiSourceConnector {
  const env = options.env ?? process.env;
  const config = options.config ?? defaultXBookmarksLiveSyncConfig(env);
  const account = options.account.trim();
  if (!account) throw new TypeError('X bookmark account must be non-empty.');
  const attemptedAt = validDate(options.attemptedAt);
  const rawClock = options.now ?? (() => new Date());
  const clock = (): Date => {
    const current = validDate(rawClock());
    return current.getTime() < attemptedAt.getTime() ? new Date(attemptedAt) : current;
  };
  const userId = options.userId?.trim() || env.OLYMPUS_SOURCE_INDEX_X_USER_ID?.trim();
  if (options.mode === 'reconcile' && !userId) {
    throw new Error('X bookmarks reconciliation requires an explicit provider user id.');
  }
  const credentialHandle = options.credentialHandle?.trim()
    || env.OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CREDENTIAL_HANDLE?.trim()
    || 'x.bookmarks.personal';
  const broker = options.credentialBroker ?? createEnvCredentialBroker({
    env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  let client: XBookmarksLiveSourceClient | undefined = options.sourceClient;
  let snapshot: SourceConnector | undefined;
  let acquired = false;
  let completedSnapshotAt: string | undefined;
  let latest: XBookmarksApiConnectorStatus = emptyStatus(options.mode);

  const connector: XBookmarksApiSourceConnector = {
    id: 'x_bookmarks_live',
    family: 'x',

    async authenticate(): Promise<void> {
      if (client) return;
      if (!userId) throw new Error('X bookmarks connector requires OLYMPUS_SOURCE_INDEX_X_USER_ID.');
      const session = requireBearerTokenCredentialSession(await broker.issueSession({
        handle: credentialHandle,
        provider: 'x',
        capability: 'x.bookmarks.sync',
        trustDomain: 'internal',
        purpose: 'Synchronize X bookmarks into the Olympus shared connector store.',
      }), credentialHandle);
      client = new XApiClient({
        token: session.token,
        userId,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    },

    async probe(cursor?: string): Promise<XBookmarksApiConnectorStatus> {
      await connector.authenticate();
      if (acquired) return latest;
      const provenance = xApiInvocationProvenance(options.provenance);
      const acquisition = options.mode === 'incremental'
        ? await acquireIncremental(
            client!, cursor, options.usageStore, account, config, clock, provenance,
          )
        : await withReconcileStateStore(options, env, (stateStore) => acquireReconciliation(
            client!, options.usageStore, stateStore, account,
            userId!, config, attemptedAt, clock, provenance,
            options.preservationFloorAuthorizationSha256,
            options.providerWindowBoundaryPolicy ?? X_BOOKMARKS_NO_APPROVED_WINDOW_BOUNDARY,
          ));
      latest = acquisition.status;
      completedSnapshotAt = acquisition.completedAt;
      snapshot = createXBookmarksSourceConnector({
        account,
        posts: acquisition.posts,
        ...(acquisition.foldersByPostId ? { foldersByPostId: acquisition.foldersByPostId } : {}),
        fetchedAt: acquisition.completedAt ?? clock().toISOString(),
      });
      acquired = true;
      return latest;
    },

    async *listItems(listOptions: SourceConnectorListOptions = {}): AsyncIterable<SourceConnectorListPage> {
      await connector.probe(listOptions.cursor);
      const activeSnapshot = snapshot;
      if (!activeSnapshot) throw new Error('X bookmark connector acquisition produced no snapshot.');
      for await (const page of activeSnapshot.listItems(listOptions.limit ? { limit: listOptions.limit } : undefined)) {
        yield {
          items: page.items,
          ...(latest.checkpoint ? { nextCursor: latest.checkpoint } : {}),
          done: latest.complete && page.done,
        };
      }
    },

    async fetchItem(localItemId: string): Promise<RawItem> {
      if (!snapshot) throw new Error('X bookmark connector fetchItem requires listItems first.');
      return snapshot.fetchItem(localItemId);
    },

    classify(item: RawItem): SourceSensitivity {
      return snapshot?.classify(item)
        ?? createXBookmarksSourceConnector({ account, posts: [] }).classify(item);
    },

    status: () => latest,
    apiUsageStatus: () => options.usageStore.status({ account, config, now: clock() }),
    async markReconciliationDisposition(
      disposition,
      outcome,
    ): Promise<XBookmarksWindowRemovalDebtOutcome> {
      if (options.mode !== 'reconcile' || !completedSnapshotAt) {
        throw new Error('X reconciliation has no completed snapshot to mark.');
      }
      const observedAt = latest.snapshotObservedAt;
      // Settled in the same TRANSACTION as the disposition, and only when the
      // caller actually reports an application outcome. A pass that never
      // reached the window branch reports nothing and leaves the standing debt
      // exactly where it was — forgiving it here would silently convert "we
      // could not try" into "we tried and it is fine".
      const settlement = outcome && observedAt
        ? {
          presentedPostIds: outcome.presentedWindowRemovalLocalItemIds
            .map((localItemId) => postIdFromLocalItemId(account, localItemId)),
          deferredPostIds: outcome.deferredWindowRemovalLocalItemIds
            .map((localItemId) => postIdFromLocalItemId(account, localItemId)),
          observedAt,
        }
        : undefined;
      return withReconcileStateStore(options, env, async (stateStore) => (
        stateStore.markCompletedSnapshotDisposition(
          account,
          completedSnapshotAt!,
          disposition,
          clock(),
          settlement,
        )
      ));
    },
  };
  return connector;
}

async function acquireIncremental(
  client: XBookmarksLiveSourceClient,
  checkpoint: string | undefined,
  usage: LocalXBookmarksApiUsageStore,
  account: string,
  config: XBookmarksLiveSyncConfig,
  clock: () => Date,
  provenance: XApiInvocationProvenance,
): Promise<Acquisition> {
  const previous = usage.headCheckpoint(account) || checkpoint?.trim();
  const catchupItemLimit = config.maxCatchupItems;
  // The ladder escalates only while a page is entirely unknown, and overlap
  // with the stored checkpoint is what stops it. A first activation has no
  // checkpoint to overlap with, so nothing would stop the escalation: keep the
  // pre-ladder invariant that a missing checkpoint reads one page and leaves
  // historical inventory to the independently due reconciliation, instead of
  // letting the fast lane become a quasi-full sync.
  // A standing deferral means the previous run already read this traversal and
  // refused to advance. Repeating the full ladder buys nothing — the pages are
  // the same — and it spends the daily budget the recovery run needs, so a
  // repeat deferral costs exactly one cheap overlap page. If the provider has
  // recovered, that page finds the overlap and the lane advances normally.
  const deferralStanding = previous !== undefined
    && usage.headTruncationDeferredAt(account) !== undefined;
  const catchupPageLimit = previous ? (deferralStanding ? 1 : config.maxCatchupPages) : 1;
  const posts: XBookmarkPost[] = [];
  let nextToken: string | undefined;
  let foundPrevious = false;
  let newestId: string | undefined;
  let truncationDeferred = false;
  const headPageSizesUsed: number[] = [];
  do {
    // Rung index is pages already read: the first page is the cheap 10-item
    // overlap check, and every all-new page buys the next, larger rung.
    const ladderIndex = deferralStanding
      ? 0
      : Math.min(
        headPageSizesUsed.length,
        config.headPageSizeLadder.length - 1,
      );
    const maxResults = Math.min(
      config.headPageSizeLadder[ladderIndex]!,
      catchupItemLimit - posts.length,
    );
    let providerPageSize = 0;
    const page = await guardedPage(
      usage, account, config, clock(), maxResults, false, provenance,
      config.richResourceExpansionMultiplier,
      (reservedMaxResults) => {
        providerPageSize = reservedMaxResults;
        return client.fetchBookmarks({
          maxResults: reservedMaxResults,
          ...(nextToken ? { paginationToken: nextToken } : {}),
        });
      },
      richPostResourceIds,
    );
    headPageSizesUsed.push(providerPageSize);
    newestId ??= page.posts[0]?.id;
    for (const post of page.posts) {
      if (previous && post.id === previous) {
        foundPrevious = true;
        break;
      }
      posts.push(post);
      if (posts.length >= catchupItemLimit) break;
    }
    nextToken = page.nextToken;
    // Same provider truncation signature the reconciliation ladder watches: a
    // terminal page (no next_token) whose result_count lands within two of the
    // requested size is not credible as an end of list. Reconciliation pays for
    // a smaller-page retry because it is the completeness authority; the head
    // lane defers instead — it spends nothing extra now, preserves the
    // checkpoint so the next hourly run re-attempts the same traversal, and
    // records the deferral in counts-only telemetry. The weekly reconciliation
    // rewrites the head checkpoint from its own snapshot, so a provider that
    // stays stuck cannot strand the head lane past one reconcile cadence.
    if (previous && !foundPrevious && !nextToken
      && isSuspiciousTerminalPage(providerPageSize, page.posts.length)) {
      truncationDeferred = true;
    }
    // Under a standing deferral the single cheap page is the whole run: either
    // it re-established the overlap, or the lane defers again rather than
    // climbing a ladder whose pages the previous run already refused.
    if (deferralStanding && !foundPrevious) {
      truncationDeferred = true;
    }
  } while (
    !foundPrevious
    && !truncationDeferred
    && nextToken
    && posts.length < catchupItemLimit
    && headPageSizesUsed.length < catchupPageLimit
  );

  // A first activation is bounded by design, not by a lost overlap, so it does
  // not raise the catch-up warning the checkpointed lane raises.
  const warnings = truncationDeferred
    ? ['x_head_truncation_suspected_deferred_checkpoint_preserved']
    : previous && !foundPrevious && nextToken
      ? ['x_head_catchup_bounded_daily_reconcile_required']
      : [];
  return acquisition(
    posts,
    true,
    posts.length > 0,
    truncationDeferred ? previous : (newestId ?? previous),
    headPageSizesUsed.length,
    warnings,
    posts.length,
    headPageSizesUsed,
    Number(truncationDeferred),
  );
}

async function acquireReconciliation(
  client: XBookmarksLiveSourceClient,
  usage: LocalXBookmarksApiUsageStore,
  stateStore: LocalXBookmarksReconcileStateStore,
  account: string,
  providerUserId: string,
  config: XBookmarksLiveSyncConfig,
  startedAt: Date,
  clock: () => Date,
  provenance: XApiInvocationProvenance,
  preservationFloorAuthorizationSha256?: string,
  providerWindowBoundaryPolicy: XBookmarksProviderWindowBoundaryPolicy =
    X_BOOKMARKS_NO_APPROVED_WINDOW_BOUNDARY,
): Promise<Acquisition> {
  const limits = reconcileLimits(config);
  const pending = stateStore.pendingCompletedSnapshot(account, providerUserId);
  if (pending) {
    return completedReconciliationAcquisition(pending, 0, [
      'x_reconcile_completed_snapshot_reused_pending_application',
    ], account);
  }
  let openedWarnings: string[] = [];
  let apiRequests = 0;
  try {
    const opened = stateStore.openRun(account, limits, providerUserId, startedAt, {
      coverageScope: 'recency_window',
      windowBoundaryAlgorithmVersion: X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION,
    });
    openedWarnings = opened.warnings;
    while (!stateStore.traversalComplete(account)) {
      const progress = stateStore.progress(account);
      if (progress.phase === 'global') {
        assertPageCapacity(progress.globalPages, config.reconcileMaxPagesPerScope, 'global_pages');
        const maxResults = availablePageSize(
          config.reconcileMaxItems,
          progress.itemsStaged,
          'items',
          progress.postRetryPageSize ?? config.reconcilePageSize,
        );
        let page: XBookmarkPostPage;
        let providerPageSize = 0;
        try {
          const fetched = await guardedReconcilePostPage({
            usage,
            stateStore,
            account,
            runId: progress.runId,
            phase: progress.phase,
            ...(progress.globalNextToken
              ? { expectedToken: progress.globalNextToken }
              : {}),
            config,
            now: clock(),
            provenance,
            maxResults,
            resourceExpansionMultiplier: config.richResourceExpansionMultiplier,
            onRequest: () => { apiRequests += 1; },
            call: (reservedMaxResults) => client.fetchBookmarks({
                maxResults: reservedMaxResults,
                strictSnapshot: true,
                ...(progress.globalNextToken ? { paginationToken: progress.globalNextToken } : {}),
              }),
            resourceIds: richPostResourceIds,
          });
          page = fetched.page;
          providerPageSize = fetched.requestedSize;
        } catch (error) {
          if (error instanceof XApiError) {
            const boundary = classifyXBookmarksProviderWindowBoundary(error, {
              hasCursor: Boolean(progress.globalNextToken),
              successfulPages: progress.globalPages,
            }, providerWindowBoundaryPolicy);
            // A run resumed after its boundary was settled has no boundary step
            // left to take: its next position is the verification pass. Letting
            // a provider refusal re-enter the step here is what turned an
            // interrupted run into a permanently wedged one.
            if (boundary && progress.globalNextToken && !progress.globalBoundarySettled) {
              stateStore.recordGlobalWindowBoundary({
                account,
                expectedToken: progress.globalNextToken,
                boundaryFingerprintSha256: boundary.fingerprintSha256,
                algorithmVersion: boundary.algorithmVersion,
                settledAt: clock(),
              });
              continue;
            }
          }
          throw error;
        }
        stateStore.recordGlobalPage({
          account,
          ...(progress.globalNextToken ? { expectedToken: progress.globalNextToken } : {}),
          page,
          requestedSize: providerPageSize,
          limits,
          settledAt: clock(),
        });
        continue;
      }
      if (progress.phase === 'global_verify') {
        assertPageCapacity(
          progress.globalVerifyPages,
          config.reconcileMaxPagesPerScope,
          'global_verify_pages',
        );
        const maxResults = availablePageSize(
          config.reconcileMaxItems,
          progress.globalVerifyItemsStaged,
          'items',
          progress.postRetryPageSize ?? config.reconcilePageSize,
        );
        let page: XBookmarkPostPage;
        let providerPageSize = 0;
        try {
          const fetched = await guardedReconcilePostPage({
            usage,
            stateStore,
            account,
            runId: progress.runId,
            phase: progress.phase,
            ...(progress.globalVerifyNextToken
              ? { expectedToken: progress.globalVerifyNextToken }
              : {}),
            config,
            now: clock(),
            provenance,
            maxResults,
            resourceExpansionMultiplier: 1,
            onRequest: () => { apiRequests += 1; },
            call: (reservedMaxResults) => client.fetchBookmarks({
                maxResults: reservedMaxResults,
                headOnly: true,
                strictSnapshot: true,
                ...(progress.globalVerifyNextToken
                  ? { paginationToken: progress.globalVerifyNextToken }
                  : {}),
              }),
            resourceIds: (value) =>
              distinctResourceIds(value.posts.map((post) => `post:${post.id}`)),
          });
          page = fetched.page;
          providerPageSize = fetched.requestedSize;
        } catch (error) {
          if (error instanceof XApiError) {
            const boundary = classifyXBookmarksProviderWindowBoundary(error, {
              hasCursor: Boolean(progress.globalVerifyNextToken),
              successfulPages: progress.globalVerifyPages,
            }, providerWindowBoundaryPolicy);
            if (boundary && progress.globalVerifyNextToken && !progress.windowBoundaryVerified) {
              stateStore.recordGlobalVerificationWindowBoundary({
                account,
                expectedToken: progress.globalVerifyNextToken,
                boundaryFingerprintSha256: boundary.fingerprintSha256,
                algorithmVersion: boundary.algorithmVersion,
                settledAt: clock(),
              });
              continue;
            }
          }
          throw error;
        }
        stateStore.recordGlobalVerificationPage({
          account,
          ...(progress.globalVerifyNextToken
            ? { expectedToken: progress.globalVerifyNextToken }
            : {}),
          page,
          requestedSize: providerPageSize,
          limits,
          settledAt: clock(),
        });
        continue;
      }
      if (progress.phase === 'folders') {
        assertPageCapacity(progress.folderPages, config.reconcileMaxPagesPerScope, 'folder_pages');
        const maxResults = availablePageSize(
          config.reconcileMaxFolders,
          progress.foldersStaged,
          'folders',
          config.reconcilePageSize,
        );
        let providerPageSize = 0;
        const page = await boundedFolderProviderPage(() =>
          guardedPage(usage, account, config, clock(), maxResults, true, provenance, 1,
            (reservedMaxResults) => {
              stateStore.recordProviderPageRequest(account, reservedMaxResults);
              apiRequests += 1;
              providerPageSize = reservedMaxResults;
              return client.fetchBookmarkFolders({
                maxResults: reservedMaxResults,
                strictSnapshot: true,
                ...(progress.folderNextToken ? { paginationToken: progress.folderNextToken } : {}),
              });
            },
            (value) => distinctResourceIds(value.folders.map((folder) => `folder:${folder.id}`))));
        stateStore.recordFolderPage({
          account,
          ...(progress.folderNextToken ? { expectedToken: progress.folderNextToken } : {}),
          page,
          requestedSize: providerPageSize,
          limits,
          settledAt: clock(),
        });
        continue;
      }

      const folder = stateStore.nextMembershipFolder(account);
      if (!folder) {
        if (stateStore.traversalComplete(account)) break;
        throw new Error('X reconciliation staged membership position is invalid.');
      }
      assertPageCapacity(progress.membershipPages, config.reconcileMaxPagesPerScope, 'membership_pages');
      let providerPageSize = 0;
      const page = await boundedFolderProviderPage(() =>
        guardedPage(
          usage, account, config, clock(), config.reconcilePageSize, true, provenance,
          config.richResourceExpansionMultiplier,
          (reservedMaxResults) => {
            stateStore.recordProviderPageRequest(account, reservedMaxResults);
            apiRequests += 1;
            providerPageSize = reservedMaxResults;
            return client.fetchBookmarksInFolder(folder.id, {
              maxResults: reservedMaxResults,
              strictSnapshot: true,
              ...(progress.membershipNextToken
                ? { paginationToken: progress.membershipNextToken }
                : {}),
            });
          },
          richPostResourceIds,
        ));
      stateStore.recordMembershipPage({
        account,
        folderId: folder.id,
        ...(progress.membershipNextToken ? { expectedToken: progress.membershipNextToken } : {}),
        page,
        requestedSize: providerPageSize,
        limits,
        settledAt: clock(),
      });
    }

    const completed = stateStore.promoteCompletedSnapshot(account, clock(), {
      ...(preservationFloorAuthorizationSha256
        ? { preservationFloorAuthorizationSha256 }
        : {}),
    });
    return completedReconciliationAcquisition(completed, apiRequests, openedWarnings, account);
  } catch (error) {
    if (isFolderProviderOutageError(error)) {
      const degraded = stateStore.completeFolderTraversalFromBaseline(account, clock());
      if (degraded) {
        const completed = stateStore.promoteCompletedSnapshot(account, clock(), {
          ...(preservationFloorAuthorizationSha256
            ? { preservationFloorAuthorizationSha256 }
            : {}),
        });
        return completedReconciliationAcquisition(completed, apiRequests, openedWarnings, account);
      }
    }
    if (error instanceof ReconcileStageLimitError) {
      throw incompleteReconcileError(config, clock(), openedWarnings, error.limitKind);
    }
    if (error instanceof ReconcilePaginationCycleError) {
      const failure = stateStore.recordStagedFailure(account, 'pagination_cycle', clock());
      throw stagedRecoveryRequiredError({
        config,
        now: clock(),
        failureClass: 'pagination_cycle',
        warnings: openedWarnings,
        failureCount: failure.failure_count ?? 1,
      });
    }
    if (error instanceof ReconcileStagedRecoveryRequiredError) {
      const failure = stateStore.stagedRecoveryStatus(account, clock());
      throw stagedRecoveryRequiredError({
        config,
        now: clock(),
        failureClass: error.failureClass,
        warnings: openedWarnings,
        failureCount: failure.failure_count ?? 1,
      });
    }
    if (error instanceof ReconcilePreservationFloorError) {
      throw new XBookmarksLiveSyncError({
        errorKind: 'reconcile_incomplete',
        message: error.message,
        retryAt: new Date(clock().getTime() + config.degradedIntervalMs).toISOString(),
        degradedReason: 'x_reconcile_preservation_floor_refused',
        warnings: [
          ...openedWarnings,
          'x_reconcile_preservation_floor_refused_prior_baseline_preserved',
        ],
        counts: {
          preservation_floor_prior_items: error.assessment.priorItems,
          preservation_floor_proposed_items: error.assessment.proposedItems,
          preservation_floor_minimum_retained_items: error.assessment.minimumRetainedItems,
        },
      });
    }
    if (error instanceof ReconcileWindowBoundaryMismatchError) {
      // A boundary proof that no longer matches the staged traversal is a
      // property of the staged evidence, not of the moment: retrying the same
      // cursors reproduces it exactly, which is how this used to park a run on
      // an endless provider_temporary backoff only an operator could clear.
      // The staged-recovery machinery already owns unusable stages, so hand it
      // over — the completed baseline is preserved either way.
      throw stagedFailureOutcome({
        stateStore,
        account,
        failureClass: 'window_boundary_drift',
        message: 'X bookmarks provider-window boundary proof drifted from its staged traversal.',
        config,
        now: clock(),
        warnings: [...openedWarnings, 'x_reconcile_window_boundary_inconsistent_no_authority'],
      });
    }
    if (error instanceof XApiError) {
      const failureClass = classifyRecoverableProviderFailure(
        error,
        stateStore.progress(account),
      );
      if (failureClass) {
        throw stagedFailureOutcome({
          stateStore,
          account,
          failureClass,
          message: 'X bookmarks staged traversal hit a recoverable provider cursor or scope failure.',
          config,
          now: clock(),
          warnings: openedWarnings,
        });
      }
      if (error.status === 429) {
        throw new XBookmarksLiveSyncError({
          errorKind: 'provider_rate_limited',
          message: 'X bookmarks provider rate limit reached.',
          retryAt: error.rateLimit?.resetAt
            ?? new Date(clock().getTime() + config.degradedIntervalMs).toISOString(),
          degradedReason: 'provider_rate_limit',
          warnings: [...openedWarnings, 'x_reconcile_progress_staged_restart_safe'],
        });
      }
      if (error.status === undefined || error.status >= 500) {
        throw new XBookmarksLiveSyncError({
          errorKind: 'provider_temporary',
          message: 'Temporary X bookmarks provider failure.',
          retryAt: new Date(clock().getTime() + config.degradedIntervalMs).toISOString(),
          degradedReason: 'x_reconcile_provider_temporary',
          warnings: [...openedWarnings, 'x_reconcile_progress_staged_restart_safe'],
        });
      }
    }
    if (error instanceof XBookmarksLiveSyncError) {
      throw new XBookmarksLiveSyncError({
        errorKind: error.errorKind,
        message: error.message,
        ...(error.retryAt ? { retryAt: error.retryAt } : {}),
        ...(error.degradedReason ? { degradedReason: error.degradedReason } : {}),
        warnings: [...openedWarnings, ...error.warnings, 'x_reconcile_progress_staged_restart_safe'],
        ...(error.counts ? { counts: error.counts } : {}),
      });
    }
    throw error;
  }
}

interface Acquisition {
  posts: XBookmarkPost[];
  foldersByPostId?: ReadonlyMap<string, readonly XBookmarkFolderIdentity[]>;
  status: XBookmarksApiConnectorStatus;
  completedAt?: string;
}

/**
 * The inverse of `xBookmarkLocalItemId`, which joins the account and the post
 * id with a colon.
 *
 * Decoded against the KNOWN account rather than by splitting on the first
 * colon. Nothing excludes a colon from either half — `requireAccount` and
 * `requirePostId` only trim and length-bound — so a split-based inverse
 * silently moves part of an account name into the post id: the debt row is
 * written under an id no completed post ever matches, promotion can never
 * forgive it, and the local id re-presented from it addresses no row in the
 * shared store, so the whole deferred-removal mechanism no-ops for that
 * account. Stripping the exact `${account}:` prefix round-trips whatever the
 * codec produced, and an id that never carried this account's prefix is not
 * this account's removal to settle.
 */
function postIdFromLocalItemId(account: string, localItemId: string): string {
  const prefix = `${account}:`;
  if (!localItemId.startsWith(prefix) || localItemId.length === prefix.length) {
    throw new TypeError('X window removal local item id does not belong to this account.');
  }
  return localItemId.slice(prefix.length);
}

/**
 * Every removal this snapshot may present, deduped and order-stable: the ones
 * this traversal derived, then the debt earlier traversals could not spend.
 */
function windowRemovalPostIds(
  completed: XBookmarksCompletedReconcileSnapshot,
): string[] {
  return [...new Set([
    ...completed.inWindowRemovedPosts.map((post) => post.id),
    ...completed.deferredWindowRemovalPostIds,
  ])];
}

function completedReconciliationAcquisition(
  completed: XBookmarksCompletedReconcileSnapshot,
  apiRequests: number,
  prefixWarnings: readonly string[],
  account: string,
): Acquisition {
  return {
    posts: completed.posts,
    foldersByPostId: completed.foldersByPostId,
    completedAt: completed.completedAt,
    status: {
      mode: 'reconcile',
      complete: true,
      // Standing debt counts as change. A traversal that found nothing new but
      // still owes a removal has work to apply, and reporting it unchanged is
      // how the debt would go another whole cadence without being offered.
      changed: completed.posts.length > 0 || windowRemovalPostIds(completed).length > 0,
      globalTraversalExhausted: true,
      removalAuthoritative: completed.globalRemovalAuthoritative,
      coverageScope: completed.coverageScope,
      windowBoundaryVerified: completed.windowBoundaryVerified,
      traversalDigestSha256: completed.traversalDigestSha256,
      traversalCardinality: completed.traversalCardinality,
      verificationDigestSha256: completed.verificationDigestSha256,
      verificationCardinality: completed.verificationCardinality,
      // Freshly derived removals PLUS everything a previous pass proved and the
      // store declined. The carried ids are indistinguishable from new ones
      // here on purpose: each is an absence this account has proven and not yet
      // applied, and this run's cutoff is newer than the one they failed
      // against, so they are re-presented on their merits.
      ...(windowRemovalPostIds(completed).length > 0
        ? {
            inWindowRemovedLocalItemIds: windowRemovalPostIds(completed)
              .map((postId) => xBookmarkLocalItemId(account, postId)),
          }
        : {}),
      snapshotObservedAt: completed.snapshotObservedAt,
      snapshotCompletedAt: completed.completedAt,
      completeReconciliationAuthoritative: completed.completeReconciliationAuthoritative,
      authority: {
        global_current_authority: completed.globalCurrentAuthority,
        folder_provenance: completed.folderProvenance,
        staged_recovery: completed.stagedRecovery,
      },
      ...(completed.checkpoint ? { checkpoint: completed.checkpoint } : {}),
      warnings: [
        ...prefixWarnings,
        ...(completed.folderPostsAbsentFromGlobal > 0
          ? ['x_reconcile_folder_post_absent_from_global_ignored']
          : []),
        ...(!completed.globalRemovalAuthoritative
          ? ['x_reconcile_global_silent_window_removals_preserved']
          : []),
        ...(!completed.globalVerificationMatched
          ? ['x_reconcile_global_verification_mismatch_removals_preserved']
          : []),
        ...(completed.coverageScope === 'recency_window'
          ? ['x_reconcile_provider_window_boundary_verified']
          : []),
        ...(completed.truncationRetries > 0
          ? ['x_reconcile_truncation_suspected_smaller_page_retry']
          : []),
        ...(completed.folderMembershipCoverageGaps > 0
          ? ['x_reconcile_folder_membership_coverage_partial_preserved']
          : []),
        ...(completed.folderInventoryCoverageGaps > 0
          ? ['x_reconcile_folder_inventory_coverage_partial_preserved']
          : []),
        ...(completed.folderProviderOutage
          ? [X_BOOKMARKS_FOLDER_PROVIDER_OUTAGE_WARNING]
          : []),
      ],
      counts: {
        apiRequests,
        itemsSeen: completed.itemsObserved,
        foldersSeen: completed.foldersObserved,
        folderMembershipsSeen: [...completed.foldersByPostId.values()]
          .reduce((count, memberships) => count + memberships.length, 0),
        folderPostsAbsentFromGlobal: completed.folderPostsAbsentFromGlobal,
        globalVerificationMatched: Number(completed.globalVerificationMatched),
        folderInventoryCoverageGaps: completed.folderInventoryCoverageGaps,
        foldersCarriedForward: completed.foldersCarriedForward,
        folderMembershipCoverageGaps: completed.folderMembershipCoverageGaps,
        folderProviderOutage: Number(completed.folderProviderOutage),
        pageSize80Requests: completed.pageSize80Requests,
        pageSize50Requests: completed.pageSize50Requests,
        pageSize20Requests: completed.pageSize20Requests,
        pageSizeOtherRequests: completed.pageSizeOtherRequests,
        truncationRetries: completed.truncationRetries,
        headPagesRead: 0,
        headPageSizesUsed: [],
        headTruncationDeferrals: 0,
      },
    },
  };
}

function acquisition(
  posts: XBookmarkPost[],
  complete: boolean,
  changed: boolean,
  checkpoint: string | undefined,
  apiRequests: number,
  warnings: string[] = [],
  itemsSeen = posts.length,
  headPageSizesUsed: readonly number[] = [],
  headTruncationDeferrals = 0,
): Acquisition {
  return {
    posts,
    status: {
      mode: 'incremental', complete, changed,
      ...(checkpoint ? { checkpoint } : {}),
      warnings,
      counts: {
        apiRequests,
        itemsSeen,
        foldersSeen: 0,
        folderMembershipsSeen: 0,
        folderPostsAbsentFromGlobal: 0,
        globalVerificationMatched: 1,
        folderInventoryCoverageGaps: 0,
        foldersCarriedForward: 0,
        folderMembershipCoverageGaps: 0,
        folderProviderOutage: 0,
        pageSize80Requests: 0,
        pageSize50Requests: 0,
        pageSize20Requests: 0,
        pageSizeOtherRequests: 0,
        truncationRetries: 0,
        headPagesRead: headPageSizesUsed.length,
        headPageSizesUsed,
        headTruncationDeferrals,
      },
    },
  };
}

async function guardedPage<T extends { rateLimit?: XApiRateLimit }>(
  usage: LocalXBookmarksApiUsageStore,
  account: string,
  config: XBookmarksLiveSyncConfig,
  now: Date,
  maxResources: number,
  preserveHeadReserve: boolean,
  provenance: XApiInvocationProvenance,
  resourceExpansionMultiplier: number,
  call: (reservedMaxResources: number) => Promise<T>,
  resourceIds: (page: T) => readonly string[],
  bubbleProviderErrors = false,
): Promise<T> {
  let reservation;
  try {
    reservation = usage.reserveRequest({
      account,
      requestedMaxResources: maxResources * resourceExpansionMultiplier,
      minimumResources: resourceExpansionMultiplier,
      preserveHeadReserve,
      provenance,
      config,
      now,
    });
  } catch (error) {
    if (error instanceof XApiUsageGuardError) {
      throw new XBookmarksLiveSyncError({
        errorKind: 'api_request_guard',
        message: 'X bookmarks request deferred by a configured usage guard.',
        retryAt: error.retryAt,
        degradedReason: error.guardKind,
      });
    }
    throw error;
  }
  try {
    const providerMaxResults = Math.min(
      maxResources,
      Math.floor(reservation.maxResources / resourceExpansionMultiplier),
    );
    if (providerMaxResults < 1) throw new RangeError('X API reservation cannot cover one provider result.');
    const page = await call(providerMaxResults);
    usage.settleSuccess({
      reservation, resourceIds: resourceIds(page),
      ...(page.rateLimit ? { rateLimit: page.rateLimit } : {}), config, now,
    });
    return page;
  } catch (error) {
    const rateLimit = error instanceof XApiError ? error.rateLimit : undefined;
    usage.settleFailure({
      reservation, ...(rateLimit ? { rateLimit } : {}),
      potentiallyBillable: !(error instanceof XApiError && error.status !== undefined), config, now,
    });
    if (bubbleProviderErrors && error instanceof XApiError) throw error;
    if (error instanceof XApiError && error.status === 429) {
      throw new XBookmarksLiveSyncError({
        errorKind: 'provider_rate_limited',
        message: 'X bookmarks provider rate limit reached.',
        retryAt: error.rateLimit?.resetAt ?? new Date(now.getTime() + config.degradedIntervalMs).toISOString(),
        degradedReason: 'provider_rate_limit',
        providerStatus: error.status,
      });
    }
    if (error instanceof XApiError && (error.status === undefined || error.status >= 500)) {
      throw new XBookmarksLiveSyncError({
        errorKind: 'provider_temporary',
        message: 'Temporary X bookmarks provider failure.',
        ...(error.status !== undefined ? { providerStatus: error.status } : {}),
      });
    }
    throw error;
  }
}

const X_BOOKMARKS_RECONCILE_PAGE_SIZE_LADDER = Object.freeze([80, 50, 20] as const);

async function guardedReconcilePostPage(input: {
  usage: LocalXBookmarksApiUsageStore;
  stateStore: LocalXBookmarksReconcileStateStore;
  account: string;
  runId: string;
  phase: 'global' | 'global_verify';
  expectedToken?: string;
  config: XBookmarksLiveSyncConfig;
  now: Date;
  provenance: XApiInvocationProvenance;
  maxResults: number;
  resourceExpansionMultiplier: number;
  onRequest: () => void;
  call: (maxResults: number) => Promise<XBookmarkPostPage>;
  resourceIds: (page: XBookmarkPostPage) => readonly string[];
}): Promise<{ page: XBookmarkPostPage; requestedSize: number }> {
  let requestedSize = input.maxResults;
  while (true) {
    let providerPageSize = 0;
    const page = await guardedPage(
      input.usage,
      input.account,
      input.config,
      input.now,
      requestedSize,
      true,
      input.provenance,
      input.resourceExpansionMultiplier,
      (reservedMaxResults) => {
        providerPageSize = reservedMaxResults;
        input.stateStore.recordProviderPageRequest(input.account, reservedMaxResults);
        input.onRequest();
        return input.call(reservedMaxResults);
      },
      input.resourceIds,
      true,
    );
    if (page.nextToken
      || !isSuspiciousTerminalPage(providerPageSize, page.posts.length)) {
      return { page, requestedSize: providerPageSize };
    }
    const nextSize = X_BOOKMARKS_RECONCILE_PAGE_SIZE_LADDER
      .find((candidate) => candidate < providerPageSize);
    if (nextSize === undefined) {
      throw new XBookmarksLiveSyncError({
        errorKind: 'reconcile_incomplete',
        message: 'X bookmarks reconciliation could not verify a terminal provider page.',
        // The admin projection emits degraded_reason only alongside retryAt, and
        // the scheduler otherwise falls back to the generic error backoff: every
        // sibling reconcile refusal parks on the degraded interval instead.
        retryAt: new Date(input.now.getTime() + input.config.degradedIntervalMs).toISOString(),
        degradedReason: 'x_reconcile_truncation_suspected',
        warnings: ['x_reconcile_truncation_suspected_no_authority'],
      });
    }
    // Persist the next rung before reserving it. If the daily guard stops the
    // retry, the next UTC day's invocation resumes at the smaller rung instead
    // of paying for the suspicious larger page again forever.
    requestedSize = input.stateStore.recordTruncationRetry({
      account: input.account,
      runId: input.runId,
      phase: input.phase,
      ...(input.expectedToken ? { expectedToken: input.expectedToken } : {}),
      nextPageSize: nextSize,
    });
  }
}

function isSuspiciousTerminalPage(requested: number, returned: number): boolean {
  return returned <= requested && returned >= Math.max(0, requested - 2);
}

async function boundedFolderProviderPage<T>(call: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= X_BOOKMARKS_FOLDER_PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isFolderProviderOutageError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function isFolderProviderOutageError(error: unknown): boolean {
  // A folder API call that never produced an HTTP status (timeout,
  // connection reset) is a provider outage exactly like a 5xx: the endpoint
  // is unreachable, and the matched-global degradation path must engage
  // rather than parking the run as an anonymous temporary failure. That
  // failure arrives either as a raw status-less XApiError or as the guarded
  // page's provider_temporary wrap, which carries providerStatus only when
  // the provider answered. Local guard stops (budgets, reservations) use
  // other error kinds and must never silently degrade folder authority; a
  // non-folder-phase failure landing here is screened out by the staged
  // eligibility proof inside completeFolderTraversalFromBaseline.
  if (error instanceof XApiError) {
    return error.status === undefined || error.status === 429 || error.status >= 500;
  }
  if (error instanceof XBookmarksLiveSyncError) {
    const status = error.providerStatus;
    if (status === 429 || (status !== undefined && status >= 500)) return true;
    return status === undefined && error.errorKind === 'provider_temporary';
  }
  return false;
}

function reconcileLimits(config: XBookmarksLiveSyncConfig): XBookmarksReconcileLimits {
  return {
    maxItems: config.reconcileMaxItems,
    maxFolders: config.reconcileMaxFolders,
    maxPagesPerScope: config.reconcileMaxPagesPerScope,
    pageSize: config.reconcilePageSize,
  };
}

export function classifyXBookmarksProviderWindowBoundary(
  error: XApiError,
  context: { hasCursor: boolean; successfulPages: number },
  policy: XBookmarksProviderWindowBoundaryPolicy =
    X_BOOKMARKS_NO_APPROVED_WINDOW_BOUNDARY,
): XBookmarksProviderWindowBoundaryEvidence | undefined {
  if (
    !context.hasCursor
    || !Number.isSafeInteger(context.successfulPages)
    || context.successfulPages < 1
    || error.status === undefined
    || error.status < 400
    || error.status > 599
  ) return undefined;
  const algorithmVersion = Number(policy.algorithmVersion);
  if (!Number.isSafeInteger(algorithmVersion) || algorithmVersion < 1) {
    throw new TypeError('X provider-window boundary algorithm version is invalid.');
  }
  const approvedTypes = new Set(
    policy.approvedProviderErrorTypes.map((value) =>
      normalizeBoundaryIdentifier(value, 'type')),
  );
  const approvedCodes = new Set(
    policy.approvedProviderErrorCodes.map((value) =>
      normalizeBoundaryIdentifier(value, 'code')),
  );
  const matchedType = error.providerErrorType
    && approvedTypes.has(error.providerErrorType)
    ? error.providerErrorType
    : undefined;
  const matchedCode = error.providerErrorCode
    && approvedCodes.has(error.providerErrorCode)
    ? error.providerErrorCode
    : undefined;
  if (!matchedType && !matchedCode) return undefined;
  const fingerprintSha256 = createHash('sha256').update(JSON.stringify({
    kind: 'x_provider_window_boundary',
    algorithm_version: algorithmVersion,
    http_status: error.status,
    provider_error_type: matchedType ?? null,
    provider_error_code: matchedCode ?? null,
  })).digest('hex');
  return { algorithmVersion, fingerprintSha256 };
}

function normalizeBoundaryIdentifier(value: string, label: 'type' | 'code'): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`X provider-window boundary ${label} is invalid.`);
  }
  return normalized;
}

function richPostResourceIds(page: XBookmarkPostPage): string[] {
  const resources: string[] = [];
  for (const post of page.posts) {
    resources.push(`post:${post.id}`);
    if (post.authorId?.trim()) resources.push(`author:${post.authorId.trim()}`);
    else if (post.authorUsername?.trim()) resources.push(`author-username:${post.authorUsername.trim()}`);
    for (const mediaKey of post.mediaKeys ?? []) {
      if (mediaKey.trim()) resources.push(`media:${mediaKey.trim()}`);
    }
    if (!post.mediaKeys?.length) {
      for (const mediaUrl of post.mediaUrls ?? []) {
        if (mediaUrl.trim()) resources.push(`media-url:${mediaUrl.trim()}`);
      }
    }
  }
  return distinctResourceIds(resources);
}

function distinctResourceIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function assertPageCapacity(
  pages: number,
  maxPages: number,
  kind: 'global_pages' | 'global_verify_pages' | 'folder_pages' | 'membership_pages',
): void {
  if (pages >= maxPages) throw new ReconcileStageLimitError(kind);
}

function availablePageSize(
  limit: number,
  staged: number,
  kind: 'items' | 'folders',
  pageSize: number,
): number {
  const available = Math.min(pageSize, limit - staged);
  if (available < 1) throw new ReconcileStageLimitError(kind);
  return available;
}

function incompleteReconcileError(
  config: XBookmarksLiveSyncConfig,
  now: Date,
  warnings: readonly string[],
  limitKind: ReconcileStageLimitError['limitKind'],
): XBookmarksLiveSyncError {
  return new XBookmarksLiveSyncError({
    errorKind: 'reconcile_incomplete',
    message: 'X bookmarks reconciliation stopped at a configured traversal bound.',
    retryAt: new Date(now.getTime() + config.degradedIntervalMs).toISOString(),
    degradedReason: `x_reconcile_${limitKind}_bound`,
    warnings: [
      ...warnings,
      'x_reconcile_incomplete_no_shared_store_write',
      'x_reconcile_progress_staged_restart_safe',
    ],
  });
}

function classifyRecoverableProviderFailure(
  error: XApiError,
  progress: ReturnType<LocalXBookmarksReconcileStateStore['progress']>,
): XBookmarksStagedFailureClass | undefined {
  if (error.status === 404 || error.status === 410) {
    if (progress.phase === 'memberships') return 'deleted_scope';
  }
  const hasCursor = Boolean(
    progress.globalNextToken
    || progress.globalVerifyNextToken
    || progress.folderNextToken
    || progress.membershipNextToken,
  );
  return hasCursor && (error.status === 400 || error.status === 404 || error.status === 410)
    ? 'invalid_or_expired_cursor'
    : undefined;
}

/**
 * Records one staged failure and returns the refusal to throw: the automatic
 * discard receipt once the class is recovery-eligible and has repeated, and the
 * bounded-retry refusal before that. Both callers must go through here, so a
 * new failure class cannot accidentally acquire a retry loop no recovery verb
 * is watching.
 */
function stagedFailureOutcome(input: {
  stateStore: LocalXBookmarksReconcileStateStore;
  account: string;
  failureClass: XBookmarksStagedFailureClass;
  message: string;
  config: XBookmarksLiveSyncConfig;
  now: Date;
  warnings: readonly string[];
}): XBookmarksLiveSyncError {
  const retryAt = new Date(input.now.getTime() + input.config.degradedIntervalMs).toISOString();
  const failure = input.stateStore.recordStagedFailure(
    input.account,
    input.failureClass,
    input.now,
  );
  if (failure.automatic_recovery_ready && failure.staged_digest_sha256) {
    const receipt = input.stateStore.recoverStagedRun({
      account: input.account,
      expectedStagedDigestSha256: failure.staged_digest_sha256,
      mode: 'automatic',
      recoveredAt: input.now,
    });
    return new XBookmarksLiveSyncError({
      errorKind: 'reconcile_incomplete',
      message: 'X bookmarks discarded a poisoned staged traversal while preserving its completed baseline.',
      retryAt,
      degradedReason: 'x_reconcile_staged_recovery_completed',
      warnings: [...input.warnings, 'x_reconcile_staged_recovery_completed'],
      counts: {
        staged_recovery_completed: 1,
        staged_pages_cleared: receipt.pages_cleared,
        staged_posts_cleared: receipt.staged_posts_cleared,
        staged_folders_cleared: receipt.staged_folders_cleared,
        staged_memberships_cleared: receipt.staged_memberships_cleared,
      },
    });
  }
  return new XBookmarksLiveSyncError({
    errorKind: 'reconcile_incomplete',
    message: input.message,
    retryAt,
    degradedReason: `x_reconcile_${input.failureClass}`,
    warnings: [...input.warnings, 'x_reconcile_staged_failure_retry_bounded'],
    counts: {
      staged_failure_count: failure.failure_count ?? 1,
      staged_recovery_eligible: Number(failure.recovery_eligible === true),
    },
  });
}

function stagedRecoveryRequiredError(input: {
  config: XBookmarksLiveSyncConfig;
  now: Date;
  failureClass: XBookmarksStagedFailureClass;
  warnings: readonly string[];
  failureCount: number;
}): XBookmarksLiveSyncError {
  return new XBookmarksLiveSyncError({
    errorKind: 'reconcile_incomplete',
    message: 'X bookmarks staged traversal requires explicit recovery.',
    retryAt: new Date(input.now.getTime() + input.config.reconcileIntervalMs).toISOString(),
    degradedReason: `x_reconcile_${input.failureClass}`,
    warnings: [...input.warnings, 'x_reconcile_explicit_staged_recovery_required'],
    counts: {
      staged_failure_count: input.failureCount,
      staged_recovery_eligible: 0,
    },
  });
}

async function withReconcileStateStore<T>(
  options: XBookmarksApiSourceConnectorOptions,
  env: Record<string, string | undefined>,
  run: (store: LocalXBookmarksReconcileStateStore) => Promise<T>,
): Promise<T> {
  const provided = options.reconcileStateStore;
  const store = provided ?? new LocalXBookmarksReconcileStateStore(
    defaultXBookmarksReconcileStateDbPath(env, options.usageStore.dbPath),
  );
  try {
    return await run(store);
  } finally {
    if (!provided) store.close();
  }
}

function emptyStatus(mode: XBookmarksApiConnectorStatus['mode']): XBookmarksApiConnectorStatus {
  return {
    mode,
    complete: false,
    changed: false,
    warnings: [],
    counts: {
      apiRequests: 0,
      itemsSeen: 0,
      foldersSeen: 0,
      folderMembershipsSeen: 0,
      folderPostsAbsentFromGlobal: 0,
      globalVerificationMatched: 0,
      folderInventoryCoverageGaps: 0,
      foldersCarriedForward: 0,
      folderMembershipCoverageGaps: 0,
      folderProviderOutage: 0,
      pageSize80Requests: 0,
      pageSize50Requests: 0,
      pageSize20Requests: 0,
      pageSizeOtherRequests: 0,
      truncationRetries: 0,
      headPagesRead: 0,
      headPageSizesUsed: [],
      headTruncationDeferrals: 0,
    },
  };
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new TypeError('X connector attemptedAt must be valid.');
  return value;
}
