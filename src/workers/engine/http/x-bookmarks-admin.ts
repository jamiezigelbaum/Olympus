import { type XBookmarksLiveSyncResult, X_BOOKMARKS_HEAD_MAX_LADDER_PAGES } from '../../x-bookmarks/index.ts';

export function xBookmarksLiveAdminResult(
  mode: 'head' | 'reconcile' | 'window_diagnostic',
  result: XBookmarksLiveSyncResult,
): Record<string, unknown> {
  const allowedCountKeys = new Set([
    'api_requests',
    'items_seen',
    'items_indexed',
    'items_tombstoned',
    'folders_seen',
    'folder_memberships_seen',
    'folder_posts_absent_from_global',
    'global_verification_matched',
    'folder_inventory_coverage_gaps',
    'folders_carried_forward',
    'folder_membership_coverage_gaps',
    'folder_provider_outage',
    'global_traversal_exhausted',
    'removal_authoritative',
    'folder_inventory_authoritative',
    'complete_reconciliation_authoritative',
    'global_current_authority',
    'folder_provenance_green',
    'staged_recovery_completed',
    'staged_failure_count',
    'staged_recovery_eligible',
    'staged_pages_cleared',
    'staged_posts_cleared',
    'staged_folders_cleared',
    'staged_memberships_cleared',
    'coverage_scope_recency_window',
    'window_boundary_verified',
    'traversal_cardinality',
    'verification_cardinality',
    'absence_items_tombstoned',
    'out_of_scope_removals',
    'window_removed_items',
    'window_removed_items_tombstoned',
    'window_removals_deferred',
    'window_removal_debt_carried',
    'window_removal_debt_spent',
    'window_removal_debt_standing',
    'window_removal_debt_oldest_age_ms',
    'deleted_event_items_tombstoned',
    'secrets_tier_items_tombstoned',
    'items_demoted',
    'diagnostic_probes',
    'diagnostic_requests',
    'diagnostic_successful_requests',
    'diagnostic_provider_errors',
    'diagnostic_guarded_requests',
    'chunks_indexed',
    'chunks_embedded',
    'head_pages_read',
    'head_truncation_deferrals',
    'reconcile_page_size_80_requests',
    'reconcile_page_size_50_requests',
    'reconcile_page_size_20_requests',
    'reconcile_page_size_other_requests',
    'reconcile_truncation_retries',
  ]);
  for (let index = 0; index < 8; index += 1) {
    allowedCountKeys.add(`traversal_digest_word_${index}`);
    allowedCountKeys.add(`verification_digest_word_${index}`);
  }
  // One key per head page actually read, so the ladder a run climbed is
  // legible from the receipt alone. The bound is the hard page cap both the
  // catch-up page limit and the ladder length validate against.
  for (let page = 1; page <= X_BOOKMARKS_HEAD_MAX_LADDER_PAGES; page += 1) {
    allowedCountKeys.add(`head_page_${page}_max_results`);
  }
  const numericCounts = Object.fromEntries(
    Object.entries(result.counts).filter((entry): entry is [string, number] => (
      allowedCountKeys.has(entry[0])
      && typeof entry[1] === 'number'
      && Number.isFinite(entry[1])
      && entry[1] >= 0
    )),
  );
  const usage = result.api_usage;
  const allowedWarnings = new Set([
    'x_head_catchup_bounded_daily_reconcile_required',
    'x_head_truncation_suspected_deferred_checkpoint_preserved',
    'x_reconcile_truncation_suspected_smaller_page_retry',
    'x_reconcile_truncation_suspected_no_authority',
    'x_reconcile_incomplete_no_removals_applied',
    'x_reconcile_coverage_window_partial_no_absence_removals',
    'x_reconcile_folder_post_absent_from_global_ignored',
    'x_reconcile_global_silent_window_removals_preserved',
    'x_reconcile_window_removal_newer_observation_preserved',
    'x_reconcile_window_removal_debt_standing_beyond_cadence',
    'x_reconcile_global_verification_mismatch_removals_preserved',
    'x_reconcile_folder_membership_coverage_partial_preserved',
    'x_reconcile_folder_inventory_coverage_partial_preserved',
    'x_reconcile_authoritative_freshness_not_advanced',
    'x_reconcile_completed_snapshot_reused_pending_application',
    'x_reconcile_folder_provenance_degraded_daily_cadence',
    'x_reconcile_folder_provider_outage_inventory_carried_forward',
    'x_reconcile_staged_failure_retry_bounded',
    'x_reconcile_staged_recovery_completed',
    'x_reconcile_explicit_staged_recovery_required',
    'x_reconcile_provider_window_boundary_verified',
    'x_reconcile_window_boundary_inconsistent_no_authority',
    'x_window_diagnostic_incomplete_review_report',
  ]);
  const safeWarnings = [...new Set((result.warnings ?? []).filter((warning) => allowedWarnings.has(warning)))];
  return {
    mode,
    status: result.status,
    counts: numericCounts,
    ...(result.authority
      ? {
          authority: {
            global_current_authority: result.authority.global_current_authority,
            folder_provenance: result.authority.folder_provenance,
            staged_recovery: result.authority.staged_recovery,
          },
        }
      : {}),
    ...(safeWarnings.length > 0 ? { warnings: safeWarnings } : {}),
    api_usage: {
      utc_day: usage.utc_day,
      api_requests: usage.api_requests,
      resource_reads: usage.resource_reads,
      estimated_billable_resources: usage.estimated_billable_resources,
      reserved_resource_reads: usage.reserved_resource_reads,
      estimated_spend_microusd: usage.estimated_spend_microusd,
      estimated_spend_usd: usage.estimated_spend_usd,
      estimated_unit_cost_usd: usage.estimated_unit_cost_usd,
      estimate: true,
      hard_budgets: {
        api_requests: usage.hard_budgets.api_requests,
        resource_reads: usage.hard_budgets.resource_reads,
        estimated_spend_microusd: usage.hard_budgets.estimated_spend_microusd,
      },
      ...(usage.rate_limit
        ? {
            rate_limit: {
              ...(usage.rate_limit.limit !== undefined ? { limit: usage.rate_limit.limit } : {}),
              ...(usage.rate_limit.remaining !== undefined ? { remaining: usage.rate_limit.remaining } : {}),
              ...(usage.rate_limit.reset_at !== undefined ? { reset_at: usage.rate_limit.reset_at } : {}),
            },
          }
        : {}),
      guard: {
        state: usage.guard.state,
        ...(usage.guard.degraded_reason ? { degraded_reason: usage.guard.degraded_reason } : {}),
        ...(usage.guard.retry_at ? { retry_at: usage.guard.retry_at } : {}),
      },
    },
    ...(result.retry_at
      ? {
          retry_at: {
            at: result.retry_at.at,
            effective_interval_ms: result.retry_at.effective_interval_ms,
            degraded_reason: result.retry_at.degraded_reason,
          },
        }
      : {}),
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      resource_ids_exposed: false,
      provider_cursor_exposed: false,
      sync_ids_exposed: false,
    },
  };
}
