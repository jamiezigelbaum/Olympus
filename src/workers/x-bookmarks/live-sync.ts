// Source-specific control plane around the real X SourceConnector. Provider
// I/O stays inside Contract 1; shared ingest and selected embedding stay in the
// generic connector-store runner. Results are counts-only (no provider or sync
// checkpoints cross this boundary).

import {
  syncAndEmbedFromConnector,
  type LocalConnectorStore,
} from '../connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import type { CredentialBroker } from '../credential-broker/index.ts';
import type { XApiClientOptions } from './api.ts';
import {
  XBookmarksLiveSyncError,
  createXBookmarksApiSourceConnector,
  type XBookmarksApiConnectorStatus,
  type XBookmarksLiveSourceClient,
  type XBookmarksProviderWindowBoundaryPolicy,
} from './api-connector.ts';
import {
  LocalXBookmarksApiUsageStore,
  X_BOOKMARKS_WINDOW_REMOVAL_DEBT_STALE_CADENCE_FACTOR,
  defaultXBookmarksLiveSyncConfig,
  xApiInvocationProvenance,
  xBookmarksReconcileEvidenceCounts,
  type XApiInvocationProvenance,
  type XApiUsageStatus,
  type XBookmarksLiveSyncConfig,
  type XBookmarksReconcileWatermark,
} from './live-control.ts';
import type { LocalXBookmarksReconcileStateStore } from './reconcile-state.ts';
import { LocalXBookmarksReconcileStateStore as XBookmarksReconcileStateStore } from './reconcile-state.ts';
import { X_BOOKMARKS_PROVIDER } from './connector.ts';
import {
  runXBookmarksWindowDiagnostic,
  type XBookmarksWindowDiagnosticResult,
} from './window-diagnostic.ts';

export { XBookmarksLiveSyncError } from './api-connector.ts';
export type {
  XBookmarksLiveSourceClient,
  XBookmarksLiveSyncErrorKind,
} from './api-connector.ts';

export interface XBookmarksHeadSyncRequest {
  attempted_at?: string;
  consecutive_failures?: number;
  /** Internal scheduler compatibility; never returned from this surface. */
  checkpoint?: string;
  /**
   * Who initiated this run. Operator runs are exempt from the daily budget and
   * head-reserve guards (owner ruling 2026-08-19); anything but the exact
   * literal 'operator' fails closed to 'scheduled'.
   */
  provenance?: XApiInvocationProvenance;
}

export interface XBookmarksReconcileRequest {
  attempted_at?: string;
  consecutive_failures?: number;
  /** Same contract as XBookmarksHeadSyncRequest.provenance. */
  provenance?: XApiInvocationProvenance;
}

export interface XBookmarksWindowDiagnosticRequest {
  attempted_at?: string;
  /** Same contract as XBookmarksHeadSyncRequest.provenance. */
  provenance?: XApiInvocationProvenance;
}

export interface XBookmarksLiveSyncResult {
  status: 'progress' | 'idle';
  counts: Record<string, number>;
  authority?: {
    global_current_authority: 'green' | 'degraded';
    folder_provenance: 'green' | 'degraded';
    staged_recovery: 'not_needed' | 'completed';
  };
  warnings?: string[];
  retry_at?: {
    at: string;
    effective_interval_ms: number;
    degraded_reason: string;
  };
  api_usage: XApiUsageStatus;
}

export interface XBookmarksReconcileTombstoneCounts {
  items_tombstoned?: number;
  window_removed_items?: number;
  window_removed_items_tombstoned?: number;
  deleted_event_items_tombstoned?: number;
  secrets_tier_items_tombstoned?: number;
  items_demoted?: number;
  absence_items_tombstoned?: number;
}

/**
 * Every tombstone applied by a canonical reconcile must be attributed to the
 * rule that applied it. This invariant used to live only in the one-time X
 * activation gate; keeping it in the reconcile lane preserves the safety
 * property after that migration gate is deleted.
 */
export function xBookmarksReconcileTombstonesAccounted(
  counts: XBookmarksReconcileTombstoneCounts,
): boolean {
  const tombstoned = counts.items_tombstoned;
  if (!nonNegativeSafeInteger(tombstoned)) return false;
  if (tombstoned === 0) return true;

  const components = [
    counts.window_removed_items_tombstoned,
    counts.deleted_event_items_tombstoned,
    counts.secrets_tier_items_tombstoned,
    counts.items_demoted,
    counts.absence_items_tombstoned,
  ];
  if (!components.every(nonNegativeSafeInteger)) return false;
  if (components.reduce((sum, count) => sum + count!, 0) !== tombstoned) return false;
  return nonNegativeSafeInteger(counts.window_removed_items)
    && counts.window_removed_items! >= counts.window_removed_items_tombstoned!;
}

export interface XBookmarksConnectorStoreSyncHandler {
  syncHead(request?: XBookmarksHeadSyncRequest): Promise<XBookmarksLiveSyncResult>;
  reconcile(request?: XBookmarksReconcileRequest): Promise<XBookmarksLiveSyncResult>;
  diagnoseWindow?(request?: XBookmarksWindowDiagnosticRequest): Promise<XBookmarksLiveSyncResult>;
  lastCompleteReconcileAt(): string | undefined;
  completeReconcileWatermark(): XBookmarksReconcileWatermark | undefined;
  apiUsageStatus(): XApiUsageStatus;
}

export interface XBookmarksConnectorStoreSyncHandlerOptions {
  store: LocalConnectorStore;
  embeddingProvider: SourceEmbeddingProvider;
  usageStore?: LocalXBookmarksApiUsageStore;
  /** Internal test/repair injection; normal runtime derives an owner-private state DB. */
  reconcileStateStore?: LocalXBookmarksReconcileStateStore;
  sourceClient?: XBookmarksLiveSourceClient;
  credentialBroker?: CredentialBroker;
  credentialHandle?: string;
  account?: string;
  userId?: string;
  fetch?: XApiClientOptions['fetch'];
  apiBaseUrl?: string;
  timeoutMs?: number;
  /** Exact owner-reviewed digest for one proposed below-floor snapshot. No env fallback. */
  preservationFloorAuthorizationSha256?: string;
  /** Test/owner-ruling injection; production has no approved boundary identifiers. */
  providerWindowBoundaryPolicy?: XBookmarksProviderWindowBoundaryPolicy;
  diagnosticReportPath?: string;
  config?: XBookmarksLiveSyncConfig;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export function createXBookmarksConnectorStoreSyncHandler(
  options: XBookmarksConnectorStoreSyncHandlerOptions,
): XBookmarksConnectorStoreSyncHandler {
  const env = options.env ?? process.env;
  const config = options.config ?? defaultXBookmarksLiveSyncConfig(env);
  const account = options.account?.trim() || 'personal';
  const usageStore = options.usageStore ?? new LocalXBookmarksApiUsageStore();
  const reconcileStateStore = options.reconcileStateStore
    ?? (usageStore.dbPath === ':memory:' ? new XBookmarksReconcileStateStore(':memory:') : undefined);
  const now = options.now ?? (() => new Date());
  const diagnosticReportPath = options.diagnosticReportPath?.trim()
    || env.OLYMPUS_SOURCE_INDEX_X_WINDOW_DIAGNOSTIC_REPORT_PATH?.trim()
    || (usageStore.dbPath === ':memory:'
      ? undefined
      : `${usageStore.dbPath}.window-diagnostic.json`);
  const connectorBase = {
    account,
    usageStore,
    ...(reconcileStateStore ? { reconcileStateStore } : {}),
    config,
    ...(options.sourceClient ? { sourceClient: options.sourceClient } : {}),
    ...(options.credentialBroker ? { credentialBroker: options.credentialBroker } : {}),
    ...(options.credentialHandle ? { credentialHandle: options.credentialHandle } : {}),
    ...(options.userId ? { userId: options.userId } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.preservationFloorAuthorizationSha256
      ? { preservationFloorAuthorizationSha256: options.preservationFloorAuthorizationSha256 }
      : {}),
    ...(options.providerWindowBoundaryPolicy
      ? { providerWindowBoundaryPolicy: options.providerWindowBoundaryPolicy }
      : {}),
    now,
    env,
  };

  return {
    async syncHead(request: XBookmarksHeadSyncRequest = {}): Promise<XBookmarksLiveSyncResult> {
      const attemptedAt = validAttemptedAt(request.attempted_at, now);
      const connector = createXBookmarksApiSourceConnector({
        ...connectorBase,
        mode: 'incremental',
        attemptedAt,
        provenance: xApiInvocationProvenance(request.provenance),
      });
      const probed = await connector.probe(request.checkpoint?.trim());
      if (!probed.changed) {
        if (probed.checkpoint && probed.counts.headTruncationDeferrals === 0) {
          usageStore.recordHeadCheckpoint(account, probed.checkpoint, validAttemptedAt(undefined, now));
        } else if (probed.counts.headTruncationDeferrals > 0) {
          usageStore.recordHeadTruncationDeferral(
            account,
            validAttemptedAt(undefined, now),
            probed.checkpoint,
          );
        }
        return withGuard({
          status: 'idle',
          counts: {
            api_requests: probed.counts.apiRequests,
            items_seen: probed.counts.itemsSeen,
            items_indexed: 0,
            chunks_indexed: 0,
            chunks_embedded: 0,
            ...headReceiptCounts(probed.counts),
          },
          ...(probed.warnings.length > 0 ? { warnings: probed.warnings } : {}),
        }, connector.apiUsageStatus(), config);
      }
      const run = await syncAndEmbedFromConnector({
        store: options.store,
        connector,
        embeddingProvider: options.embeddingProvider,
        sync: {
          fetchContent: true,
          ...(request.checkpoint?.trim() ? { cursor: request.checkpoint.trim() } : {}),
        },
      });
      const status = connector.status();
      // A truncation deferral deliberately returns the already-stored
      // checkpoint. Re-recording that value with this run's later wall clock
      // would make the preserve look newer than a concurrently completed
      // reconcile snapshot and could block the reconcile's replacement.
      // Preserve means no checkpoint write: its original ordering timestamp
      // remains intact, so the green reconcile's immutable completion time
      // wins regardless of which handler returns last.
      if (status.checkpoint && status.counts.headTruncationDeferrals === 0) {
        usageStore.recordHeadCheckpoint(account, status.checkpoint, validAttemptedAt(undefined, now));
      } else if (status.counts.headTruncationDeferrals > 0) {
        // Durable, because the next run has to know this traversal was already
        // read and refused: without it the lane re-climbs the whole ladder
        // every hour and starves the completed traversal that ends the defer.
        // A deferral returns the checkpoint the run started from, so that value
        // is also the compare-and-set the store binds the deferral to.
        usageStore.recordHeadTruncationDeferral(
          account,
          validAttemptedAt(undefined, now),
          status.checkpoint,
        );
      }
      return withGuard({
        status: run.sync.itemsIndexed > 0 ? 'progress' : 'idle',
        counts: {
          api_requests: status.counts.apiRequests,
          items_seen: status.counts.itemsSeen,
          items_indexed: run.sync.itemsIndexed,
          chunks_indexed: run.sync.chunksIndexed,
          chunks_embedded: run.embed.chunksEmbedded,
          ...headReceiptCounts(status.counts),
        },
        ...(status.warnings.length > 0 ? { warnings: status.warnings } : {}),
      }, connector.apiUsageStatus(), config);
    },

    async reconcile(request: XBookmarksReconcileRequest = {}): Promise<XBookmarksLiveSyncResult> {
      const attemptedAt = validAttemptedAt(request.attempted_at, now);
      const connector = createXBookmarksApiSourceConnector({
        ...connectorBase,
        mode: 'reconcile',
        attemptedAt,
        provenance: xApiInvocationProvenance(request.provenance),
      });
      const probed = await connector.probe();
      const coverageScope = probed.coverageScope ?? 'account_snapshot';
      const windowEvidenceGreen = coverageScope !== 'recency_window'
        || (
          probed.windowBoundaryVerified === true
          && probed.traversalDigestSha256 !== undefined
          && probed.traversalDigestSha256 === probed.verificationDigestSha256
          && probed.traversalCardinality === probed.verificationCardinality
        );
      const removalAuthoritative = probed.globalTraversalExhausted === true
        && probed.removalAuthoritative === true
        && windowEvidenceGreen;
      const globalCurrentAuthority =
        probed.authority?.global_current_authority === 'green';
      const folderProvenance = probed.authority?.folder_provenance ?? 'degraded';
      const stagedRecovery = probed.authority?.staged_recovery ?? 'not_needed';
      // The removals actually HANDED to the store, which is narrower than the
      // ones the snapshot offers: a run that lost removal authority, or one
      // whose coverage is an account snapshot rather than a window, passes none
      // at all. Settling the debt against the offered set instead of this one
      // would forgive removals the store was never asked about.
      const presentedWindowRemovalLocalItemIds =
        removalAuthoritative && coverageScope === 'recency_window'
          ? (probed.inWindowRemovedLocalItemIds ?? [])
          : [];
      const run = await syncAndEmbedFromConnector({
        store: options.store,
        connector,
        embeddingProvider: options.embeddingProvider,
        sync: {
          fetchContent: true,
          reconcileFullSnapshot: true,
          reconcileFullSnapshotScope: { provider: X_BOOKMARKS_PROVIDER, accountScope: account },
          // The connector exposes nothing until its durable traversal has
          // exhausted every global/folder token. Only that promoted snapshot
          // may own current X bookmark membership across replay/live owners.
          reconcileAbsenceAuthority: removalAuthoritative ? 'complete_snapshot' : 'partial_window',
          ...(removalAuthoritative
            ? {
                reconcileCurrentMembershipAuthority: coverageScope === 'recency_window'
                  ? 'provider_window_snapshot' as const
                  : 'provider_account_snapshot' as const,
                reconcileSnapshotObservedAt: probed.snapshotObservedAt,
                reconcileSnapshotCompletedAt: probed.snapshotCompletedAt,
                ...(coverageScope === 'recency_window'
                  ? {
                      reconcileWindowBoundarySha256: probed.traversalDigestSha256,
                      reconcileWindowRemovedLocalItemIds:
                        presentedWindowRemovalLocalItemIds,
                    }
                  : {}),
              }
            : {}),
        },
      });
      const status = connector.status();
      if (!status.complete) {
        const completedAt = validAttemptedAt(undefined, now);
        throw new XBookmarksLiveSyncError({
          errorKind: 'reconcile_incomplete',
          message: 'X bookmarks reconciliation was bounded before a complete provider traversal.',
          retryAt: new Date(completedAt.getTime() + config.degradedIntervalMs).toISOString(),
          degradedReason: 'x_reconcile_incomplete',
          warnings: status.warnings,
        });
      }
      const windowRemovalsDeferred = run.sync.windowRemovalsDeferredLocalItemIds ?? [];
      const counts = {
        api_requests: status.counts.apiRequests,
        items_seen: status.counts.itemsSeen,
        items_indexed: run.sync.itemsIndexed,
        items_tombstoned: run.sync.itemsTombstoned,
        // Every tombstone this run applied, split by the rule that applied it.
        // The gate's window-scoping proof was previously asserted against two
        // counters that are zero by construction on this lane; these are the
        // ones that can actually disagree, and they must add up to
        // items_tombstoned or something removed rows outside the proven window.
        window_removed_items: coverageScope === 'recency_window' && removalAuthoritative
          ? (probed.inWindowRemovedLocalItemIds ?? []).length
          : 0,
        window_removed_items_tombstoned: run.sync.windowRemovedItemsTombstoned ?? 0,
        // The store's window_removal_newer_observation_preserved coverage gap,
        // carried across this counts-only boundary rather than dropped with the
        // rest of run.sync.gaps. Presented minus tombstoned does not recover it:
        // that difference also holds the preservation-owned refusals.
        window_removals_deferred: windowRemovalsDeferred.length,
        deleted_event_items_tombstoned: run.sync.deletedEventItemsTombstoned ?? 0,
        secrets_tier_items_tombstoned: run.sync.secretsTierItemsTombstoned ?? 0,
        items_demoted: run.sync.itemsDemoted ?? 0,
        folders_seen: status.counts.foldersSeen,
        folder_memberships_seen: status.counts.folderMembershipsSeen,
        folder_posts_absent_from_global: status.counts.folderPostsAbsentFromGlobal,
        global_verification_matched: status.counts.globalVerificationMatched,
        folder_inventory_coverage_gaps: status.counts.folderInventoryCoverageGaps,
        folder_inventory_authoritative: Number(
          status.counts.folderInventoryCoverageGaps === 0,
        ),
        folders_carried_forward: status.counts.foldersCarriedForward,
        folder_membership_coverage_gaps: status.counts.folderMembershipCoverageGaps,
        folder_provider_outage: status.counts.folderProviderOutage,
        reconcile_page_size_80_requests: status.counts.pageSize80Requests,
        reconcile_page_size_50_requests: status.counts.pageSize50Requests,
        reconcile_page_size_20_requests: status.counts.pageSize20Requests,
        reconcile_page_size_other_requests: status.counts.pageSizeOtherRequests,
        reconcile_truncation_retries: status.counts.truncationRetries,
        global_traversal_exhausted: Number(status.globalTraversalExhausted === true),
        removal_authoritative: Number(status.removalAuthoritative === true),
        complete_reconciliation_authoritative: Number(
          status.completeReconciliationAuthoritative === true,
        ),
        global_current_authority: Number(globalCurrentAuthority),
        folder_provenance_green: Number(folderProvenance === 'green'),
        staged_recovery_completed: Number(stagedRecovery === 'completed'),
        ...xBookmarksReconcileEvidenceCounts({
          coverage_scope: coverageScope,
          window_boundary_verified: probed.windowBoundaryVerified === true,
          traversal_digest_sha256: probed.traversalDigestSha256 ?? '0'.repeat(64),
          traversal_cardinality: probed.traversalCardinality ?? 0,
          verification_digest_sha256: probed.verificationDigestSha256 ?? '0'.repeat(64),
          verification_cardinality: probed.verificationCardinality ?? 0,
          absence_items_tombstoned: run.sync.absenceItemsTombstoned ?? 0,
          // Provider-window absence is never broad deletion. X emits only
          // overlap-proven in-window removals as explicit tombstones, so the
          // shared store's absence counter must remain zero by construction.
          out_of_scope_removals: coverageScope === 'recency_window'
            ? (run.sync.absenceItemsTombstoned ?? 0)
            : 0,
        }),
        chunks_indexed: run.sync.chunksIndexed,
        chunks_embedded: run.embed.chunksEmbedded,
      };
      if (!xBookmarksReconcileTombstonesAccounted(counts)) {
        throw new XBookmarksLiveSyncError({
          errorKind: 'reconcile_incomplete',
          message: 'X bookmarks reconciliation could not account for every applied tombstone.',
          retryAt: new Date(attemptedAt.getTime() + config.degradedIntervalMs).toISOString(),
          degradedReason: 'x_reconcile_tombstone_accounting_mismatch',
          warnings: [...status.warnings, 'x_reconcile_tombstone_accounting_mismatch'],
          counts,
        });
      }
      if (!globalCurrentAuthority) {
        // Preserve any safely observed additions, but do not refresh the
        // authoritative daily watermark. Folder provenance is intentionally
        // irrelevant to this global current-membership/removal decision.
        await connector.markReconciliationDisposition('degraded');
        const completedAt = validAttemptedAt(undefined, now);
        throw new XBookmarksLiveSyncError({
          errorKind: 'reconcile_incomplete',
          message: 'X bookmarks reconciliation ended without complete global current-membership authority.',
          retryAt: new Date(completedAt.getTime() + config.degradedIntervalMs).toISOString(),
          degradedReason: 'x_reconcile_coverage_ambiguous',
          warnings: [...status.warnings, 'x_reconcile_authoritative_freshness_not_advanced'],
          counts,
        });
      }
      const snapshotCompletedAt = validSnapshotTimestamp(status.snapshotCompletedAt);
      usageStore.recordCompleteReconcile(account, snapshotCompletedAt, {
        itemsSeen: status.counts.itemsSeen,
        foldersSeen: status.counts.foldersSeen,
        folderMembershipsSeen: status.counts.folderMembershipsSeen,
        folderInventoryCoverageGaps: status.counts.folderInventoryCoverageGaps,
        foldersCarriedForward: status.counts.foldersCarriedForward,
        folderMembershipCoverageGaps: status.counts.folderMembershipCoverageGaps,
        folderProviderOutage: status.counts.folderProviderOutage === 1,
        ...(status.traversalCardinality !== undefined
          ? { traversalCardinality: status.traversalCardinality }
          : {}),
        ...(status.verificationCardinality !== undefined
          ? { verificationCardinality: status.verificationCardinality }
          : {}),
        absenceItemsTombstoned: run.sync.absenceItemsTombstoned ?? 0,
        outOfScopeRemovals: (status.coverageScope ?? 'account_snapshot') === 'recency_window'
          ? (run.sync.absenceItemsTombstoned ?? 0)
          : 0,
      }, {
        globalTraversalExhausted: status.globalTraversalExhausted === true,
        globalVerificationMatched: status.counts.globalVerificationMatched === 1,
        removalAuthoritative: status.removalAuthoritative === true,
        folderInventoryAuthoritative: status.counts.folderInventoryCoverageGaps === 0,
        folderProviderOutage: status.counts.folderProviderOutage === 1,
        stagedRecoveryCompleted: stagedRecovery === 'completed',
        coverageScope: status.coverageScope ?? 'account_snapshot',
        windowBoundaryVerified: status.windowBoundaryVerified === true,
        ...(status.traversalDigestSha256
          ? { traversalDigestSha256: status.traversalDigestSha256 }
          : {}),
        ...(status.verificationDigestSha256
          ? { verificationDigestSha256: status.verificationDigestSha256 }
          : {}),
      });
      if (status.checkpoint) {
        usageStore.recordHeadCheckpoint(account, status.checkpoint, snapshotCompletedAt);
      }
      const debt = await connector.markReconciliationDisposition(
        folderProvenance === 'green' ? 'applied' : 'degraded',
        {
          // What this pass asked, and what the store answered. Anything it
          // declined on the newer-observation ground is still owed and is
          // carried to a later cutoff; everything else PRESENTED is settled.
          // Reported here rather than counted into a gap string, because a
          // count cannot be re-presented.
          presentedWindowRemovalLocalItemIds,
          deferredWindowRemovalLocalItemIds: windowRemovalsDeferred,
        },
      );
      // How long the oldest unapplied removal has been owed. A standing debt
      // is only self-correcting while it keeps getting re-presented against
      // newer cutoffs; past a named multiple of the reconcile cadence it is a
      // lane that will never settle on its own, and it has to be visible before
      // the row count reaches the store's cardinality refusal.
      const debtOldestAgeMs = windowRemovalDebtAgeMs(
        debt.oldestFirstDeferredAt,
        validAttemptedAt(undefined, now),
      );
      const debtStaleAfterMs = config.reconcileIntervalMs
        * X_BOOKMARKS_WINDOW_REMOVAL_DEBT_STALE_CADENCE_FACTOR;
      const debtCounts = {
        window_removal_debt_carried: debt.carried,
        window_removal_debt_spent: debt.spent,
        window_removal_debt_standing: debt.standing,
        ...(debtOldestAgeMs !== undefined
          ? { window_removal_debt_oldest_age_ms: debtOldestAgeMs }
          : {}),
      };
      const reconcileWarnings = [...new Set([
        ...status.warnings,
        ...(folderProvenance === 'degraded'
          ? ['x_reconcile_folder_provenance_degraded_daily_cadence']
          : []),
        ...(windowRemovalsDeferred.length > 0
          ? ['x_reconcile_window_removal_newer_observation_preserved']
          : []),
        ...(debtOldestAgeMs !== undefined && debtOldestAgeMs > debtStaleAfterMs
          ? ['x_reconcile_window_removal_debt_standing_beyond_cadence']
          : []),
      ])];
      return withGuard({
        status: run.sync.itemsIndexed > 0 || run.sync.itemsTombstoned > 0 ? 'progress' : 'idle',
        counts: { ...counts, ...debtCounts },
        authority: {
          global_current_authority: 'green',
          folder_provenance: folderProvenance,
          staged_recovery: stagedRecovery,
        },
        ...(reconcileWarnings.length > 0 ? { warnings: reconcileWarnings } : {}),
        ...(folderProvenance === 'degraded'
          ? {
              retry_at: {
                at: new Date(
                  validAttemptedAt(undefined, now).getTime() + config.reconcileIntervalMs,
                ).toISOString(),
                effective_interval_ms: config.reconcileIntervalMs,
                degraded_reason: 'x_reconcile_folder_provenance_degraded',
              },
            }
          : {}),
      }, connector.apiUsageStatus(), config);
    },

    async diagnoseWindow(
      request: XBookmarksWindowDiagnosticRequest = {},
    ): Promise<XBookmarksLiveSyncResult> {
      if (!diagnosticReportPath) {
        throw new Error(
          'X window diagnostic requires OLYMPUS_SOURCE_INDEX_X_WINDOW_DIAGNOSTIC_REPORT_PATH for an in-memory usage store.',
        );
      }
      const attemptedAt = validAttemptedAt(request.attempted_at, now);
      const diagnostic: XBookmarksWindowDiagnosticResult =
        await runXBookmarksWindowDiagnostic({
          account,
          attemptedAt,
          usageStore,
          reportPath: diagnosticReportPath,
          provenance: xApiInvocationProvenance(request.provenance),
          config,
          ...(options.sourceClient ? { sourceClient: options.sourceClient } : {}),
          ...(options.credentialBroker ? { credentialBroker: options.credentialBroker } : {}),
          ...(options.credentialHandle ? { credentialHandle: options.credentialHandle } : {}),
          ...(options.userId ? { userId: options.userId } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          env,
        });
      const requests = diagnostic.report.probes
        .flatMap((probe) => probe.requests)
        .filter((observation) => observation.status !== 'skipped');
      const incomplete = diagnostic.report.probes
        .some((probe) => probe.status === 'failed' || probe.status === 'mixed');
      return withGuard({
        status: 'idle',
        counts: {
          diagnostic_probes: diagnostic.report.probes.length,
          diagnostic_requests: requests.length,
          diagnostic_successful_requests: requests
            .filter((observation) => observation.status === 'success').length,
          diagnostic_provider_errors: requests
            .filter((observation) => observation.status === 'provider_error').length,
          diagnostic_guarded_requests: requests
            .filter((observation) => observation.status === 'usage_guard').length,
        },
        ...(incomplete ? { warnings: ['x_window_diagnostic_incomplete_review_report'] } : {}),
      }, diagnostic.report.api_usage, config);
    },

    lastCompleteReconcileAt: () => usageStore.lastCompleteReconcileAt(account),
    completeReconcileWatermark: () => usageStore.completeReconcileWatermark(account),
    apiUsageStatus: () => usageStore.status({ account, config, now: now() }),
  };
}

function nonNegativeSafeInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value! >= 0;
}

function headReceiptCounts(
  counts: XBookmarksApiConnectorStatus['counts'],
): Record<string, number> {
  const receipt: Record<string, number> = {
    head_pages_read: counts.headPagesRead,
    head_truncation_deferrals: counts.headTruncationDeferrals,
  };
  counts.headPageSizesUsed.forEach((size, index) => {
    receipt[`head_page_${index + 1}_max_results`] = size;
  });
  return receipt;
}

function withGuard(
  result: Omit<XBookmarksLiveSyncResult, 'api_usage'>,
  usage: XApiUsageStatus,
  config: XBookmarksLiveSyncConfig,
): XBookmarksLiveSyncResult {
  const guardRetry = usage.guard.state === 'ok' || !usage.guard.retry_at || !usage.guard.degraded_reason
    ? undefined
    : {
        at: usage.guard.retry_at,
        effective_interval_ms: config.degradedIntervalMs,
        degraded_reason: usage.guard.degraded_reason,
      };
  const retry = !result.retry_at
    ? guardRetry
    : !guardRetry || Date.parse(result.retry_at.at) >= Date.parse(guardRetry.at)
      ? result.retry_at
      : guardRetry;
  return { ...result, ...(retry ? { retry_at: retry } : {}), api_usage: usage };
}

function validAttemptedAt(value: string | undefined, now: () => Date): Date {
  const attemptedAt = value ? new Date(value) : now();
  if (!Number.isFinite(attemptedAt.getTime())) throw new TypeError('X sync attempted_at must be valid.');
  return attemptedAt;
}

function windowRemovalDebtAgeMs(
  oldestFirstDeferredAt: string | undefined,
  at: Date,
): number | undefined {
  if (!oldestFirstDeferredAt) return undefined;
  const deferredAt = Date.parse(oldestFirstDeferredAt);
  if (!Number.isFinite(deferredAt)) return undefined;
  return Math.max(0, at.getTime() - deferredAt);
}

function validSnapshotTimestamp(value: string | undefined): Date {
  if (!value) throw new Error('X reconciliation completed without a provider snapshot timestamp.');
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('X reconciliation provider snapshot timestamp is invalid.');
  }
  return timestamp;
}
