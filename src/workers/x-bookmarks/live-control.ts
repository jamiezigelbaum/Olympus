import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  assertSqliteSchemaCanOpen,
  runSqliteMigrations,
  type SqliteMigration,
} from '../../core/sqlite-migrations.ts';
import type { XApiRateLimit } from './api.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';

export const X_BOOKMARKS_HEAD_INTERVAL_MS = 30_000;
export const X_BOOKMARKS_HEAD_FRESHNESS_THRESHOLD_MS = 5 * 60_000;
export const X_BOOKMARKS_RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;
export const X_BOOKMARKS_RECONCILE_FRESHNESS_THRESHOLD_MS = 26 * 60 * 60_000;
export const X_BOOKMARKS_FOLDER_PROVIDER_OUTAGE_WARNING =
  'x_reconcile_folder_provider_outage_inventory_carried_forward';
/**
 * How many reconcile cadences a proven window removal may stand unapplied
 * before the lane says so out loud.
 *
 * A deferral is a timing accident: the next reconcile re-presents it against a
 * newer cutoff and it applies. A deferral that survives several cadences is not
 * a timing accident — some other lane is re-stamping the item's owner every
 * pass — and without a named bound the debt grows silently until the shared
 * store's own cardinality guard refuses the whole reconcile. Four cadences is
 * three chances to settle plus one, so a single slow provider week cannot
 * raise it.
 */
export const X_BOOKMARKS_WINDOW_REMOVAL_DEBT_STALE_CADENCE_FACTOR = 4;

export const X_BOOKMARKS_API_USAGE_STORE_ID = 'x-bookmarks-api-usage';
export const X_BOOKMARKS_API_USAGE_SCHEMA_VERSION = 11;

/**
 * Hard cap on head pages one run may read. The catch-up page limit, the
 * expansion ladder length, and the per-page receipt keys all validate against
 * this single number so a receipt can never name a page the lane cannot read.
 */
export const X_BOOKMARKS_HEAD_MAX_LADDER_PAGES = 50;

const MICRO_USD_PER_USD = 1_000_000;
const EMPTY_SHA256 = '0'.repeat(64);
const MAX_ACCOUNT_LENGTH = 256;
const MAX_REQUEST_RESOURCES = 1_000;
const UNDISPATCHED_RESERVATION_LEASE_MS = 5 * 60_000;
// Generous next to any provider call this store fences, because expiry is a
// crash verdict, not a request timeout: only a process that died between
// dispatch and settlement leaves a dispatched reservation standing this long.
const IN_FLIGHT_RESERVATION_LEASE_MS = 15 * 60_000;

export interface XBookmarksLiveSyncConfig {
  headIntervalMs: number;
  headFreshnessThresholdMs: number;
  reconcileIntervalMs: number;
  reconcileFreshnessThresholdMs: number;
  maxCatchupItems: number;
  maxCatchupPages: number;
  headPageSizeLadder: readonly number[];
  reconcileMaxItems: number;
  reconcileMaxFolders: number;
  reconcileMaxPagesPerScope: number;
  reconcilePageSize: number;
  degradedIntervalMs: number;
  rateLimitLowWatermark: number;
  dailyApiRequestBudget: number;
  dailyResourceReadBudget: number;
  dailyEstimatedSpendMicrousd: number;
  headApiRequestReserve: number;
  headResourceReadReserve: number;
  headEstimatedSpendReserveMicrousd: number;
  estimatedUnitCostMicrousd: number;
  /** Conservative post + author + media expansion reservation per rich post. */
  richResourceExpansionMultiplier: number;
}

/**
 * Who initiated the run this request belongs to. The daily budgets and head
 * reserves in this store are Olympus's own artificial constraint and gate
 * ROUTINE operations only (owner ruling 2026-08-19): an operator/dev-initiated
 * run is never refused by them, though its usage is still recorded truthfully
 * and the provider's own rate limit still applies. Anything that is not the
 * exact literal 'operator' fails closed to 'scheduled'.
 */
export type XApiInvocationProvenance = 'scheduled' | 'operator';

export function xApiInvocationProvenance(value: unknown): XApiInvocationProvenance {
  return value === 'operator' ? 'operator' : 'scheduled';
}

export interface XApiUsageReservation {
  reservationId: string;
  account: string;
  utcDay: string;
  maxResources: number;
  requestedAt: string;
  provenance: XApiInvocationProvenance;
}

export interface XApiUsageStatus {
  utc_day: string;
  api_requests: number;
  resource_reads: number;
  estimated_billable_resources: number;
  reserved_resource_reads: number;
  estimated_spend_microusd: number;
  estimated_spend_usd: number;
  estimated_unit_cost_usd: number;
  estimate: true;
  hard_budgets: {
    api_requests: number;
    resource_reads: number;
    estimated_spend_microusd: number;
  };
  rate_limit?: {
    limit?: number;
    remaining?: number;
    reset_at?: string;
  };
  guard: {
    state: 'ok' | 'approaching' | 'exhausted';
    degraded_reason?: XApiUsageGuardKind;
    retry_at?: string;
  };
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    resource_ids_exposed: false;
    provider_cursor_exposed: false;
  };
}

export interface XBookmarksReconcileWatermark {
  completed_at: string;
  items_seen: number;
  folders_seen: number;
  folder_memberships_seen: number;
  global_traversal_exhausted: boolean;
  global_verification_matched: boolean;
  removal_authoritative: boolean;
  coverage_scope: 'account_snapshot' | 'recency_window';
  window_boundary_verified: boolean;
  traversal_digest_sha256: string;
  traversal_cardinality: number;
  verification_digest_sha256: string;
  verification_cardinality: number;
  absence_items_tombstoned: number;
  out_of_scope_removals: number;
  folder_inventory_authoritative: boolean;
  folder_inventory_coverage_gaps: number;
  folders_carried_forward: number;
  folder_membership_coverage_gaps: number;
  folder_provider_outage: boolean;
  complete_reconciliation_authoritative: boolean;
  global_current_authority: 'green' | 'degraded';
  folder_provenance: 'green' | 'degraded';
  staged_recovery: 'not_needed' | 'completed';
}

export interface XBookmarksReconcileWatermarkResult {
  status: 'idle';
  counts: Record<string, number>;
  warnings?: string[];
}

interface XBookmarksReconcileWatermarkRow {
  reconcile_completed_at: string | null;
  reconcile_items_seen: number;
  reconcile_folders_seen: number;
  reconcile_folder_memberships_seen: number;
  reconcile_global_traversal_exhausted: number;
  reconcile_global_verification_matched: number;
  reconcile_removal_authoritative: number;
  reconcile_coverage_scope: string;
  reconcile_window_boundary_verified: number;
  reconcile_traversal_digest_sha256: string;
  reconcile_traversal_cardinality: number;
  reconcile_verification_digest_sha256: string;
  reconcile_verification_cardinality: number;
  reconcile_absence_items_tombstoned: number;
  reconcile_out_of_scope_removals: number;
  reconcile_folder_inventory_authoritative: number;
  reconcile_folder_inventory_coverage_gaps: number;
  reconcile_folders_carried_forward: number;
  reconcile_folder_membership_coverage_gaps: number;
  reconcile_folder_provider_outage: number;
  reconcile_staged_recovery_completed: number;
}

export type XApiUsageGuardKind =
  | 'daily_api_request_guard'
  | 'daily_resource_read_guard'
  | 'daily_cost_guard'
  | 'head_api_request_reserve_guard'
  | 'head_resource_read_reserve_guard'
  | 'head_cost_reserve_guard'
  | 'provider_rate_limit';

export class XApiUsageGuardError extends Error {
  readonly guardKind: XApiUsageGuardKind;
  readonly retryAt: string;

  constructor(guardKind: XApiUsageGuardKind, retryAt: string) {
    super(`X bookmarks request deferred by ${guardKind}.`);
    this.name = 'XApiUsageGuardError';
    this.guardKind = guardKind;
    this.retryAt = retryAt;
  }
}

interface UsageDayRow {
  api_requests: number;
  resource_reads: number;
  estimated_billable_resources: number;
  estimated_spend_microusd: number;
  rate_limit_limit: number | null;
  rate_limit_remaining: number | null;
  rate_limit_reset_at: string | null;
}

interface ReservationRow {
  reservation_id: string;
  account_id: string;
  utc_day: string;
  max_resources: number;
  requested_at: string;
  api_request_counted: number;
  dispatch_by: string | null;
  provenance: string;
}

export function defaultXBookmarksLiveSyncConfig(
  env: Record<string, string | undefined> = process.env,
): XBookmarksLiveSyncConfig {
  const headIntervalMs = positiveIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_HEAD_INTERVAL_SECONDS, 30) * 1_000;
  const dailyHeadPolls = Math.ceil((24 * 60 * 60_000) / headIntervalMs);
  const unitCostUsd = positiveNumberEnv(env.OLYMPUS_SOURCE_INDEX_X_ESTIMATED_UNIT_COST_USD, 0.001);
  const spendBudgetUsd = positiveNumberEnv(env.OLYMPUS_SOURCE_INDEX_X_DAILY_ESTIMATED_SPEND_BUDGET_USD, 2);
  const headSpendReserveUsd = positiveNumberEnv(
    env.OLYMPUS_SOURCE_INDEX_X_HEAD_ESTIMATED_SPEND_RESERVE_USD,
    0.25,
  );
  return {
    headIntervalMs,
    headFreshnessThresholdMs: positiveIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_HEAD_STALE_SECONDS, 300) * 1_000,
    reconcileIntervalMs: positiveIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_RECONCILE_INTERVAL_SECONDS, 86_400) * 1_000,
    reconcileFreshnessThresholdMs: positiveIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_RECONCILE_STALE_SECONDS, 93_600) * 1_000,
    maxCatchupItems: boundedPositiveIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_HEAD_MAX_CATCHUP_ITEMS, 100, 1, 1_000),
    maxCatchupPages: boundedPositiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_X_HEAD_MAX_CATCHUP_PAGES,
      5,
      1,
      X_BOOKMARKS_HEAD_MAX_LADDER_PAGES,
    ),
    headPageSizeLadder: headPageSizeLadderEnv(
      env.OLYMPUS_SOURCE_INDEX_X_HEAD_PAGE_SIZE_LADDER,
    ),
    reconcileMaxItems: boundedPositiveIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_RECONCILE_MAX_ITEMS, 25_000, 1, 100_000),
    reconcileMaxFolders: boundedPositiveIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_RECONCILE_MAX_FOLDERS, 500, 1, 5_000),
    reconcileMaxPagesPerScope: boundedPositiveIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_RECONCILE_MAX_PAGES_PER_SCOPE, 500, 1, 5_000),
    reconcilePageSize: boundedPositiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_X_RECONCILE_PAGE_SIZE,
      80,
      20,
      100,
    ),
    degradedIntervalMs: positiveIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_DEGRADED_INTERVAL_SECONDS, 300) * 1_000,
    rateLimitLowWatermark: nonNegativeIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_RATE_LIMIT_LOW_WATERMARK, 12),
    dailyApiRequestBudget: positiveIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_DAILY_API_REQUEST_BUDGET, 4_000),
    dailyResourceReadBudget: positiveIntegerEnv(env.OLYMPUS_SOURCE_INDEX_X_DAILY_RESOURCE_READ_BUDGET, 10_000),
    dailyEstimatedSpendMicrousd: usdToMicrousd(spendBudgetUsd),
    headApiRequestReserve: nonNegativeIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_X_HEAD_API_REQUEST_RESERVE,
      dailyHeadPolls + 120,
    ),
    headResourceReadReserve: nonNegativeIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_X_HEAD_RESOURCE_READ_RESERVE,
      dailyHeadPolls + 320,
    ),
    headEstimatedSpendReserveMicrousd: usdToMicrousd(headSpendReserveUsd),
    estimatedUnitCostMicrousd: usdToMicrousd(unitCostUsd),
    richResourceExpansionMultiplier: boundedPositiveIntegerEnv(
      env.OLYMPUS_SOURCE_INDEX_X_RICH_RESOURCE_EXPANSION_MULTIPLIER,
      6,
      1,
      10,
    ),
  };
}

export function defaultXBookmarksApiUsageDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.OLYMPUS_SOURCE_INDEX_X_API_USAGE_DB_PATH?.trim()) {
    return env.OLYMPUS_SOURCE_INDEX_X_API_USAGE_DB_PATH.trim();
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'x-bookmarks-api-usage.sqlite');
}

/**
 * Read the durable manual-reconcile watermark without migrations, WAL changes,
 * or any other write. Activation uses this before X is selected by the live
 * scheduler, so the adapter must not manufacture scheduler state or mutate the
 * runtime it is proving.
 */
export function readXBookmarksReconcileWatermark(
  dbPath: string,
  account: string,
): XBookmarksReconcileWatermark | undefined {
  const stat = lstatSync(dbPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('X API usage store must be a regular non-symlink file.');
  }
  const db = new Database(dbPath, { readonly: true, create: false, strict: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON; PRAGMA foreign_keys = ON;');
    assertSqliteSchemaCanOpen(
      db,
      X_BOOKMARKS_API_USAGE_STORE_ID,
      X_BOOKMARKS_API_USAGE_SCHEMA_VERSION,
    );
    return xBookmarksReconcileWatermarkFromRow(
      readXBookmarksReconcileWatermarkRow(db, requireAccount(account)),
    );
  } finally {
    closeSqliteStore(db);
  }
}

/**
 * The one counts-only projection used both by scheduler bootstrap and the
 * pre-activation watermark-derived status adapter.
 */
export function xBookmarksReconcileWatermarkResult(
  watermark: XBookmarksReconcileWatermark,
): XBookmarksReconcileWatermarkResult {
  const folderDegraded = watermark.folder_provenance === 'degraded';
  return {
    status: 'idle',
    counts: {
      items_seen: watermark.items_seen,
      folders_seen: watermark.folders_seen,
      folder_memberships_seen: watermark.folder_memberships_seen,
      global_traversal_exhausted: Number(watermark.global_traversal_exhausted),
      global_verification_matched: Number(watermark.global_verification_matched),
      removal_authoritative: Number(watermark.removal_authoritative),
      folder_inventory_authoritative: Number(watermark.folder_inventory_authoritative),
      folder_inventory_coverage_gaps: watermark.folder_inventory_coverage_gaps,
      folders_carried_forward: watermark.folders_carried_forward,
      folder_membership_coverage_gaps: watermark.folder_membership_coverage_gaps,
      folder_provider_outage: Number(watermark.folder_provider_outage),
      complete_reconciliation_authoritative: Number(
        watermark.complete_reconciliation_authoritative,
      ),
      global_current_authority: Number(watermark.global_current_authority === 'green'),
      folder_provenance_green: Number(!folderDegraded),
      staged_recovery_completed: Number(watermark.staged_recovery === 'completed'),
      ...xBookmarksReconcileEvidenceCounts(watermark),
    },
    ...(folderDegraded
      ? {
          warnings: [
            'x_reconcile_folder_provenance_degraded_daily_cadence',
            ...(watermark.folder_provider_outage
              ? [X_BOOKMARKS_FOLDER_PROVIDER_OUTAGE_WARNING]
              : []),
          ],
        }
      : {}),
  };
}

export function xBookmarksReconcileEvidenceCounts(evidence: {
  coverage_scope: 'account_snapshot' | 'recency_window';
  window_boundary_verified: boolean;
  traversal_digest_sha256: string;
  traversal_cardinality: number;
  verification_digest_sha256: string;
  verification_cardinality: number;
  absence_items_tombstoned: number;
  out_of_scope_removals: number;
}): Record<string, number> {
  const traversalDigest = normalizeSha256(
    evidence.traversal_digest_sha256,
    'X reconciliation traversal digest',
  );
  const verificationDigest = normalizeSha256(
    evidence.verification_digest_sha256,
    'X reconciliation verification digest',
  );
  const counts: Record<string, number> = {
    coverage_scope_recency_window: Number(evidence.coverage_scope === 'recency_window'),
    window_boundary_verified: Number(evidence.window_boundary_verified),
    traversal_cardinality: nonNegativeCount(evidence.traversal_cardinality),
    verification_cardinality: nonNegativeCount(evidence.verification_cardinality),
    absence_items_tombstoned: nonNegativeCount(evidence.absence_items_tombstoned),
    out_of_scope_removals: nonNegativeCount(evidence.out_of_scope_removals),
  };
  for (let index = 0; index < 8; index += 1) {
    counts[`traversal_digest_word_${index}`] = Number.parseInt(
      traversalDigest.slice(index * 8, index * 8 + 8),
      16,
    );
    counts[`verification_digest_word_${index}`] = Number.parseInt(
      verificationDigest.slice(index * 8, index * 8 + 8),
      16,
    );
  }
  return counts;
}

/**
 * Restart-safe X request/cost guard. Ordinary callers count a request at
 * reservation time, preserving the conservative crash behavior for an
 * in-flight provider call. Callers that must do fallible local setup first can
 * reserve an expiring undispatched lease; the durable request count then moves
 * atomically only when markRequestDispatched commits immediately before I/O.
 */
export class LocalXBookmarksApiUsageStore {
  readonly dbPath: string;
  private readonly db: Database;

  constructor(dbPath = defaultXBookmarksApiUsageDbPath()) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath, { create: true });
    if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
    this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    assertSqliteSchemaCanOpen(this.db, X_BOOKMARKS_API_USAGE_STORE_ID, X_BOOKMARKS_API_USAGE_SCHEMA_VERSION);
    runSqliteMigrations(this.db, X_BOOKMARKS_API_USAGE_STORE_ID, xBookmarksApiUsageMigrations());
    this.reapExpiredReservations(new Date());
  }

  close(): void {
    closeSqliteStore(this.db);
  }

  headCheckpoint(account: string): string | undefined {
    const row = this.db.query(`
      SELECT head_checkpoint FROM x_bookmarks_live_state WHERE account_id = ?
    `).get(requireAccount(account)) as { head_checkpoint: string | null } | null;
    return row?.head_checkpoint ?? undefined;
  }

  headCheckpointState(account: string): { checkpoint: string; completedAt: string } | undefined {
    const row = this.db.query(`
      SELECT head_checkpoint, head_completed_at
      FROM x_bookmarks_live_state WHERE account_id = ?
    `).get(requireAccount(account)) as {
      head_checkpoint: string | null;
      head_completed_at: string | null;
    } | null;
    return row?.head_checkpoint && row.head_completed_at
      ? { checkpoint: row.head_checkpoint, completedAt: row.head_completed_at }
      : undefined;
  }

  recordHeadCheckpoint(account: string, checkpoint: string, completedAt = new Date()): void {
    const normalized = checkpoint.trim();
    if (!normalized || normalized.length > 1_024) throw new TypeError('X head checkpoint must be bounded and non-empty.');
    const now = validDate(completedAt).toISOString();
    this.db.query(`
      INSERT INTO x_bookmarks_live_state (account_id, head_checkpoint, head_completed_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        head_checkpoint = excluded.head_checkpoint,
        head_completed_at = excluded.head_completed_at,
        -- Recording a checkpoint IS the escape: the traversal completed, so
        -- the standing deferral is spent. Cleared inside the same conditional
        -- update, so a write the ordering guard refuses does not clear it.
        head_truncation_deferred_at = NULL,
        updated_at = excluded.updated_at
      WHERE x_bookmarks_live_state.head_completed_at IS NULL
        OR excluded.head_completed_at > x_bookmarks_live_state.head_completed_at
        OR (
          excluded.head_completed_at = x_bookmarks_live_state.head_completed_at
          AND excluded.head_checkpoint = x_bookmarks_live_state.head_checkpoint
        )
    `).run(requireAccount(account), normalized, now, now);
  }

  /**
   * When the head lane last deferred on a suspected provider truncation.
   *
   * Durable because the deferral's whole point is to repeat the traversal on
   * the next run, and an in-process flag cannot tell a first deferral from the
   * hundredth: the lane re-read the same pages hourly at full ladder cost,
   * spending the budget that its own escape — the next completed traversal —
   * needs. Cleared by `recordHeadCheckpoint`.
   */
  headTruncationDeferredAt(account: string): string | undefined {
    const row = this.db.query(`
      SELECT head_truncation_deferred_at FROM x_bookmarks_live_state WHERE account_id = ?
    `).get(requireAccount(account)) as { head_truncation_deferred_at: string | null } | null;
    return row?.head_truncation_deferred_at ?? undefined;
  }

  /**
   * `incurredCheckpoint` is the checkpoint the deferring run read at its start.
   * Head and reconcile hold different concurrency keys, so a reconcile can
   * record a newer checkpoint — spending the standing deferral — while a head
   * run is still in flight. Compare-and-set on that checkpoint, or the late
   * write reinstates a deferral belonging to a traversal nobody is running any
   * more, and every later head run reads one cheap page it can never match.
   */
  recordHeadTruncationDeferral(
    account: string,
    deferredAt = new Date(),
    incurredCheckpoint?: string,
  ): void {
    const now = validDate(deferredAt).toISOString();
    const expected = incurredCheckpoint?.trim() || null;
    this.db.query(`
      INSERT INTO x_bookmarks_live_state (account_id, head_truncation_deferred_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        head_truncation_deferred_at = excluded.head_truncation_deferred_at,
        updated_at = excluded.updated_at
      WHERE ? IS NULL OR x_bookmarks_live_state.head_checkpoint IS ?
    `).run(requireAccount(account), now, now, expected, expected);
  }

  lastCompleteReconcileAt(account: string): string | undefined {
    const watermark = this.completeReconcileWatermark(account);
    return watermark?.global_current_authority === 'green'
      ? watermark.completed_at
      : undefined;
  }

  completeReconcileWatermark(account: string): XBookmarksReconcileWatermark | undefined {
    return xBookmarksReconcileWatermarkFromRow(
      readXBookmarksReconcileWatermarkRow(this.db, requireAccount(account)),
    );
  }

  recordCompleteReconcile(
    account: string,
    completedAt = new Date(),
    counts: {
      itemsSeen?: number;
      foldersSeen?: number;
      folderMembershipsSeen?: number;
      folderInventoryCoverageGaps?: number;
      foldersCarriedForward?: number;
      folderMembershipCoverageGaps?: number;
      folderProviderOutage?: boolean;
      traversalCardinality?: number;
      verificationCardinality?: number;
      absenceItemsTombstoned?: number;
      outOfScopeRemovals?: number;
    } = {},
    proof: {
      globalTraversalExhausted?: boolean;
      globalVerificationMatched?: boolean;
      removalAuthoritative?: boolean;
      folderInventoryAuthoritative?: boolean;
      folderProviderOutage?: boolean;
      stagedRecoveryCompleted?: boolean;
      coverageScope?: 'account_snapshot' | 'recency_window';
      windowBoundaryVerified?: boolean;
      traversalDigestSha256?: string;
      verificationDigestSha256?: string;
    } = {},
  ): void {
    const now = validDate(completedAt).toISOString();
    const coverageScope = proof.coverageScope ?? 'account_snapshot';
    if (coverageScope !== 'account_snapshot' && coverageScope !== 'recency_window') {
      throw new Error('X reconciliation watermark coverage scope is invalid.');
    }
    const traversalDigestSha256 = normalizeSha256(
      proof.traversalDigestSha256,
      'X reconciliation traversal digest',
    );
    const verificationDigestSha256 = normalizeSha256(
      proof.verificationDigestSha256,
      'X reconciliation verification digest',
    );
    if (
      coverageScope === 'recency_window'
      && (
        proof.windowBoundaryVerified !== true
        || traversalDigestSha256 !== verificationDigestSha256
        || nonNegativeCount(counts.traversalCardinality)
          !== nonNegativeCount(counts.verificationCardinality)
      )
    ) {
      throw new Error('X recency-window watermark requires matching verified boundary evidence.');
    }
    this.db.query(`
      INSERT INTO x_bookmarks_live_state (
        account_id, reconcile_completed_at, reconcile_items_seen,
        reconcile_folders_seen, reconcile_folder_memberships_seen,
        reconcile_global_traversal_exhausted, reconcile_global_verification_matched,
        reconcile_removal_authoritative,
        reconcile_coverage_scope, reconcile_window_boundary_verified,
        reconcile_traversal_digest_sha256, reconcile_traversal_cardinality,
        reconcile_verification_digest_sha256, reconcile_verification_cardinality,
        reconcile_absence_items_tombstoned, reconcile_out_of_scope_removals,
        reconcile_folder_inventory_authoritative,
        reconcile_folder_inventory_coverage_gaps, reconcile_folders_carried_forward,
        reconcile_folder_membership_coverage_gaps, reconcile_folder_provider_outage,
        reconcile_staged_recovery_completed,
        updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(account_id) DO UPDATE SET
        reconcile_completed_at = excluded.reconcile_completed_at,
        reconcile_items_seen = excluded.reconcile_items_seen,
        reconcile_folders_seen = excluded.reconcile_folders_seen,
        reconcile_folder_memberships_seen = excluded.reconcile_folder_memberships_seen,
        reconcile_global_traversal_exhausted = excluded.reconcile_global_traversal_exhausted,
        reconcile_global_verification_matched = excluded.reconcile_global_verification_matched,
        reconcile_removal_authoritative = excluded.reconcile_removal_authoritative,
        reconcile_coverage_scope = excluded.reconcile_coverage_scope,
        reconcile_window_boundary_verified = excluded.reconcile_window_boundary_verified,
        reconcile_traversal_digest_sha256 = excluded.reconcile_traversal_digest_sha256,
        reconcile_traversal_cardinality = excluded.reconcile_traversal_cardinality,
        reconcile_verification_digest_sha256 = excluded.reconcile_verification_digest_sha256,
        reconcile_verification_cardinality = excluded.reconcile_verification_cardinality,
        reconcile_absence_items_tombstoned = excluded.reconcile_absence_items_tombstoned,
        reconcile_out_of_scope_removals = excluded.reconcile_out_of_scope_removals,
        reconcile_folder_inventory_authoritative = excluded.reconcile_folder_inventory_authoritative,
        reconcile_folder_inventory_coverage_gaps = excluded.reconcile_folder_inventory_coverage_gaps,
        reconcile_folders_carried_forward = excluded.reconcile_folders_carried_forward,
        reconcile_folder_membership_coverage_gaps = excluded.reconcile_folder_membership_coverage_gaps,
        reconcile_folder_provider_outage = excluded.reconcile_folder_provider_outage,
        reconcile_staged_recovery_completed = excluded.reconcile_staged_recovery_completed,
        updated_at = excluded.updated_at
      WHERE x_bookmarks_live_state.reconcile_completed_at IS NULL
        OR excluded.reconcile_completed_at >= x_bookmarks_live_state.reconcile_completed_at
    `).run(
      requireAccount(account), now,
      nonNegativeCount(counts.itemsSeen),
      nonNegativeCount(counts.foldersSeen),
      nonNegativeCount(counts.folderMembershipsSeen),
      Number(proof.globalTraversalExhausted === true),
      Number(proof.globalVerificationMatched === true),
      Number(proof.removalAuthoritative === true),
      coverageScope,
      Number(proof.windowBoundaryVerified === true),
      traversalDigestSha256,
      nonNegativeCount(counts.traversalCardinality),
      verificationDigestSha256,
      nonNegativeCount(counts.verificationCardinality),
      nonNegativeCount(counts.absenceItemsTombstoned),
      nonNegativeCount(counts.outOfScopeRemovals),
      Number(proof.folderInventoryAuthoritative === true),
      nonNegativeCount(counts.folderInventoryCoverageGaps),
      nonNegativeCount(counts.foldersCarriedForward),
      nonNegativeCount(counts.folderMembershipCoverageGaps),
      Number(proof.folderProviderOutage === true || counts.folderProviderOutage === true),
      Number(proof.stagedRecoveryCompleted === true),
      now,
    );
  }

  reserveRequest(input: {
    account: string;
    requestedMaxResources: number;
    minimumResources?: number;
    preserveHeadReserve?: boolean;
    countApiRequestOnDispatch?: boolean;
    provenance?: XApiInvocationProvenance;
    config: XBookmarksLiveSyncConfig;
    now?: Date;
  }): XApiUsageReservation {
    const account = requireAccount(input.account);
    const now = validDate(input.now ?? new Date());
    const utcDay = utcDayFrom(now);
    const requestedMaxResources = boundedResourceCount(input.requestedMaxResources);
    const minimumResources = boundedResourceCount(input.minimumResources ?? requestedMaxResources);
    if (minimumResources > requestedMaxResources) {
      throw new TypeError('X API minimumResources cannot exceed requestedMaxResources.');
    }
    // The budgets and reserves below are Olympus's own constraint on ROUTINE
    // operations. An operator run is exempt from every one of them — a smaller
    // grant would be the same refusal in slow motion — but never from the
    // provider's own rate limit, and its usage still lands in the same ledger.
    const provenance = xApiInvocationProvenance(input.provenance);
    const routine = provenance === 'scheduled';

    return this.db.transaction(() => {
      this.reapExpiredReservations(now, input.config);
      this.ensureDay(account, utcDay, now.toISOString());
      const row = this.dayRow(account, utcDay);
      const reserved = this.reservedResources(account, utcDay);
      const pendingRequests = this.pendingRequestCount(account, utcDay);
      const retryAt = nextUtcDay(now);

      // The low watermark is Olympus's protective buffer over X's remaining
      // count; only the buffer yields to an operator run. remaining <= 0 until
      // a future reset is X itself refusing, and that binds every provenance.
      if (rateLimitBlocks(row, input.config, now, routine && input.preserveHeadReserve === true)) {
        throw new XApiUsageGuardError('provider_rate_limit', row.rate_limit_reset_at!);
      }
      if (routine && row.api_requests + pendingRequests + 1 > input.config.dailyApiRequestBudget) {
        throw new XApiUsageGuardError('daily_api_request_guard', retryAt);
      }
      if (routine && input.preserveHeadReserve && row.api_requests + pendingRequests + 1
        > backgroundBudget(
          input.config.dailyApiRequestBudget,
          cadenceSteppedHeadReserve(
            input.config.headApiRequestReserve,
            input.config.headIntervalMs,
            now,
          ),
        )) {
        throw new XApiUsageGuardError('head_api_request_reserve_guard', retryAt);
      }

      const remainingReads = input.config.dailyResourceReadBudget - row.resource_reads - reserved;
      if (routine && remainingReads < minimumResources) {
        throw new XApiUsageGuardError('daily_resource_read_guard', retryAt);
      }
      const remainingCostUnits = Math.floor(
        (input.config.dailyEstimatedSpendMicrousd - row.estimated_spend_microusd
          - reserved * input.config.estimatedUnitCostMicrousd)
        / input.config.estimatedUnitCostMicrousd,
      );
      if (routine && remainingCostUnits < minimumResources) {
        throw new XApiUsageGuardError('daily_cost_guard', retryAt);
      }
      const backgroundRemainingReads = remainingReads
        - cadenceSteppedHeadReserve(
          input.config.headResourceReadReserve,
          input.config.headIntervalMs,
          now,
        );
      if (routine && input.preserveHeadReserve && backgroundRemainingReads < minimumResources) {
        throw new XApiUsageGuardError('head_resource_read_reserve_guard', retryAt);
      }
      const backgroundRemainingCostUnits = Math.floor(
        (input.config.dailyEstimatedSpendMicrousd
          - cadenceSteppedHeadReserve(
            input.config.headEstimatedSpendReserveMicrousd,
            input.config.headIntervalMs,
            now,
          )
          - row.estimated_spend_microusd - reserved * input.config.estimatedUnitCostMicrousd)
        / input.config.estimatedUnitCostMicrousd,
      );
      if (routine && input.preserveHeadReserve && backgroundRemainingCostUnits < minimumResources) {
        throw new XApiUsageGuardError('head_cost_reserve_guard', retryAt);
      }

      const maxResources = routine
        ? Math.min(
            requestedMaxResources,
            input.preserveHeadReserve ? backgroundRemainingReads : remainingReads,
            input.preserveHeadReserve ? backgroundRemainingCostUnits : remainingCostUnits,
          )
        : requestedMaxResources;
      const reservation: XApiUsageReservation = {
        reservationId: randomUUID(),
        account,
        utcDay,
        maxResources,
        requestedAt: now.toISOString(),
        provenance,
      };
      const countOnDispatch = input.countApiRequestOnDispatch === true;
      this.db.query(`
        INSERT INTO x_api_request_reservations (
          reservation_id, account_id, utc_day, max_resources, requested_at,
          api_request_counted, dispatch_by, provenance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reservation.reservationId,
        account,
        utcDay,
        maxResources,
        reservation.requestedAt,
        Number(!countOnDispatch),
        new Date(now.getTime() + (countOnDispatch
          ? UNDISPATCHED_RESERVATION_LEASE_MS
          : IN_FLIGHT_RESERVATION_LEASE_MS)).toISOString(),
        provenance,
      );
      if (!countOnDispatch) {
        this.db.query(`
          UPDATE x_api_usage_days
          SET api_requests = api_requests + 1, updated_at = ?
          WHERE account_id = ? AND utc_day = ?
        `).run(now.toISOString(), account, utcDay);
      }
      return reservation;
    })();
  }

  markRequestDispatched(input: {
    reservation: XApiUsageReservation;
    config: XBookmarksLiveSyncConfig;
    preserveHeadReserve?: boolean;
    now?: Date;
  }): void {
    const now = validDate(input.now ?? new Date());
    this.db.transaction(() => {
      this.reapExpiredReservations(now, input.config);
      const reservation = this.reservationRow(input.reservation.reservationId);
      if (!reservation) {
        throw new Error('X API request reservation expired before provider dispatch.');
      }
      if (reservation.api_request_counted === 1) return;
      const dispatchDay = utcDayFrom(now);
      this.ensureDay(reservation.account_id, dispatchDay, now.toISOString());
      const row = this.dayRow(reservation.account_id, dispatchDay);
      const sameDay = reservation.utc_day === dispatchDay;
      const reserved = this.reservedResources(reservation.account_id, dispatchDay)
        - (sameDay ? reservation.max_resources : 0);
      const pendingRequests = this.pendingRequestCount(reservation.account_id, dispatchDay)
        - (sameDay ? 1 : 0);
      const retryAt = nextUtcDay(now);
      // Provenance is read from the durable row, not the caller: the same
      // operator exemption that admitted the reservation must survive to its
      // dispatch. Only the provider's own exhausted rate limit binds both.
      const routine = xApiInvocationProvenance(reservation.provenance) === 'scheduled';
      if (rateLimitBlocks(row, input.config, now, routine && input.preserveHeadReserve === true)) {
        throw new XApiUsageGuardError('provider_rate_limit', row.rate_limit_reset_at!);
      }
      if (routine && row.api_requests + pendingRequests + 1 > input.config.dailyApiRequestBudget) {
        throw new XApiUsageGuardError('daily_api_request_guard', retryAt);
      }
      if (routine && input.preserveHeadReserve && row.api_requests + pendingRequests + 1
        > backgroundBudget(
          input.config.dailyApiRequestBudget,
          cadenceSteppedHeadReserve(
            input.config.headApiRequestReserve,
            input.config.headIntervalMs,
            now,
          ),
        )) {
        throw new XApiUsageGuardError('head_api_request_reserve_guard', retryAt);
      }
      const remainingReads = input.config.dailyResourceReadBudget
        - row.resource_reads - reserved;
      if (routine && remainingReads < reservation.max_resources) {
        throw new XApiUsageGuardError('daily_resource_read_guard', retryAt);
      }
      const remainingCostUnits = Math.floor(
        (input.config.dailyEstimatedSpendMicrousd - row.estimated_spend_microusd
          - reserved * input.config.estimatedUnitCostMicrousd)
        / input.config.estimatedUnitCostMicrousd,
      );
      if (routine && remainingCostUnits < reservation.max_resources) {
        throw new XApiUsageGuardError('daily_cost_guard', retryAt);
      }
      if (routine && input.preserveHeadReserve
        && remainingReads - cadenceSteppedHeadReserve(
          input.config.headResourceReadReserve,
          input.config.headIntervalMs,
          now,
        )
          < reservation.max_resources) {
        throw new XApiUsageGuardError('head_resource_read_reserve_guard', retryAt);
      }
      const backgroundRemainingCostUnits = Math.floor(
        (input.config.dailyEstimatedSpendMicrousd
          - cadenceSteppedHeadReserve(
            input.config.headEstimatedSpendReserveMicrousd,
            input.config.headIntervalMs,
            now,
          )
          - row.estimated_spend_microusd
          - reserved * input.config.estimatedUnitCostMicrousd)
        / input.config.estimatedUnitCostMicrousd,
      );
      if (routine && input.preserveHeadReserve
        && backgroundRemainingCostUnits < reservation.max_resources) {
        throw new XApiUsageGuardError('head_cost_reserve_guard', retryAt);
      }
      this.db.query(`
        UPDATE x_api_request_reservations
        SET utc_day = ?, api_request_counted = 1, dispatch_by = ?
        WHERE reservation_id = ? AND api_request_counted = 0
      `).run(
        dispatchDay,
        new Date(now.getTime() + IN_FLIGHT_RESERVATION_LEASE_MS).toISOString(),
        reservation.reservation_id,
      );
      this.db.query(`
        UPDATE x_api_usage_days
        SET api_requests = api_requests + 1, updated_at = ?
        WHERE account_id = ? AND utc_day = ?
      `).run(now.toISOString(), reservation.account_id, dispatchDay);
    })();
  }

  cancelUndispatchedRequest(input: {
    reservation: XApiUsageReservation;
  }): boolean {
    return this.db.transaction(() => {
      const deleted = this.db.query(`
        DELETE FROM x_api_request_reservations
        WHERE reservation_id = ? AND api_request_counted = 0
      `).run(input.reservation.reservationId);
      return deleted.changes > 0;
    })();
  }

  settleSuccess(input: {
    reservation: XApiUsageReservation;
    resourceIds: readonly string[];
    rateLimit?: XApiRateLimit;
    config: XBookmarksLiveSyncConfig;
    now?: Date;
  }): void {
    const now = validDate(input.now ?? new Date());
    this.db.transaction(() => {
      const reservation = this.reservationRow(input.reservation.reservationId);
      if (!reservation) return;
      if (reservation.api_request_counted !== 1) {
        throw new Error('X API request cannot settle before provider dispatch.');
      }
      const usage = this.dayRow(reservation.account_id, reservation.utc_day);
      // The reservation contract binds every provenance; the daily budget line
      // is routine-only, and an operator settle records truthfully past it.
      const routine = xApiInvocationProvenance(reservation.provenance) === 'scheduled';
      if (input.resourceIds.length > reservation.max_resources
        || (routine
          && usage.resource_reads + input.resourceIds.length > input.config.dailyResourceReadBudget)) {
        throw new RangeError('X API response exceeded its reserved resource limit.');
      }
      const resourceHashes = [...new Set(input.resourceIds
        .map((resourceId) => resourceId.trim())
        .filter(Boolean)
        .map(hashResourceId))];
      for (const resourceHash of resourceHashes) {
        this.db.query(`
          INSERT OR IGNORE INTO x_api_usage_resources (
            account_id, utc_day, resource_hash, first_seen_at
          ) VALUES (?, ?, ?, ?)
        `).run(reservation.account_id, reservation.utc_day, resourceHash, now.toISOString());
      }
      // Owned-account bookmark reads are billed per returned resource, not
      // per distinct identity seen during the UTC day. Keep the hashed set as
      // counts-private diagnostic inventory, but charge every returned item.
      const billableResources = input.resourceIds.length;
      if (routine && usage.estimated_spend_microusd
        + billableResources * input.config.estimatedUnitCostMicrousd
        > input.config.dailyEstimatedSpendMicrousd) {
        throw new RangeError('X API response exceeded its reserved spend limit.');
      }
      this.db.query(`
        UPDATE x_api_usage_days
        SET resource_reads = resource_reads + ?,
          estimated_billable_resources = estimated_billable_resources + ?,
          estimated_spend_microusd = estimated_spend_microusd + ?,
          rate_limit_limit = COALESCE(?, rate_limit_limit),
          rate_limit_remaining = COALESCE(?, rate_limit_remaining),
          rate_limit_reset_at = COALESCE(?, rate_limit_reset_at),
          updated_at = ?
        WHERE account_id = ? AND utc_day = ?
      `).run(
        input.resourceIds.length,
        billableResources,
        billableResources * input.config.estimatedUnitCostMicrousd,
        input.rateLimit?.limit ?? null,
        input.rateLimit?.remaining ?? null,
        input.rateLimit?.resetAt ?? null,
        now.toISOString(),
        reservation.account_id,
        reservation.utc_day,
      );
      this.deleteReservation(reservation.reservation_id);
    })();
  }

  settleFailure(input: {
    reservation: XApiUsageReservation;
    rateLimit?: XApiRateLimit;
    potentiallyBillable: boolean;
    config: XBookmarksLiveSyncConfig;
    now?: Date;
  }): void {
    const now = validDate(input.now ?? new Date());
    this.db.transaction(() => {
      const reservation = this.reservationRow(input.reservation.reservationId);
      if (!reservation) return;
      if (reservation.api_request_counted !== 1) {
        throw new Error('X API request cannot settle before provider dispatch.');
      }
      const usage = this.dayRow(reservation.account_id, reservation.utc_day);
      const remainingReads = Math.max(0, input.config.dailyResourceReadBudget - usage.resource_reads);
      const remainingCostUnits = Math.max(0, Math.floor(
        (input.config.dailyEstimatedSpendMicrousd - usage.estimated_spend_microusd)
        / input.config.estimatedUnitCostMicrousd,
      ));
      // A routine charge never records past the daily line it was admitted
      // under; an operator run was admitted past it, so clamping here would
      // silently under-record the very spend the exemption authorized.
      const uncertain = !input.potentiallyBillable
        ? 0
        : xApiInvocationProvenance(reservation.provenance) === 'operator'
          ? reservation.max_resources
          : Math.min(reservation.max_resources, remainingReads, remainingCostUnits);
      this.db.query(`
        UPDATE x_api_usage_days
        SET resource_reads = resource_reads + ?,
          estimated_billable_resources = estimated_billable_resources + ?,
          estimated_spend_microusd = estimated_spend_microusd + ?,
          rate_limit_limit = COALESCE(?, rate_limit_limit),
          rate_limit_remaining = COALESCE(?, rate_limit_remaining),
          rate_limit_reset_at = COALESCE(?, rate_limit_reset_at),
          updated_at = ?
        WHERE account_id = ? AND utc_day = ?
      `).run(
        uncertain,
        uncertain,
        uncertain * input.config.estimatedUnitCostMicrousd,
        input.rateLimit?.limit ?? null,
        input.rateLimit?.remaining ?? null,
        input.rateLimit?.resetAt ?? null,
        now.toISOString(),
        reservation.account_id,
        reservation.utc_day,
      );
      this.deleteReservation(reservation.reservation_id);
    })();
  }

  status(input: {
    account: string;
    config: XBookmarksLiveSyncConfig;
    now?: Date;
  }): XApiUsageStatus {
    const account = requireAccount(input.account);
    const now = validDate(input.now ?? new Date());
    const utcDay = utcDayFrom(now);
    this.reapExpiredReservations(now, input.config);
    this.ensureDay(account, utcDay, now.toISOString());
    const row = this.dayRow(account, utcDay);
    const reserved = this.reservedResources(account, utcDay);
    const pendingRequests = this.pendingRequestCount(account, utcDay);
    const guard = usageGuard(row, reserved, pendingRequests, input.config, now);
    return {
      utc_day: utcDay,
      api_requests: row.api_requests,
      resource_reads: row.resource_reads,
      estimated_billable_resources: row.estimated_billable_resources,
      reserved_resource_reads: reserved,
      estimated_spend_microusd: row.estimated_spend_microusd,
      estimated_spend_usd: row.estimated_spend_microusd / MICRO_USD_PER_USD,
      estimated_unit_cost_usd: input.config.estimatedUnitCostMicrousd / MICRO_USD_PER_USD,
      estimate: true,
      hard_budgets: {
        api_requests: input.config.dailyApiRequestBudget,
        resource_reads: input.config.dailyResourceReadBudget,
        estimated_spend_microusd: input.config.dailyEstimatedSpendMicrousd,
      },
      ...(rateLimitStatus(row)),
      guard,
      policy: {
        counts_only: true,
        raw_source_exposed: false,
        source_text_returned: false,
        resource_ids_exposed: false,
        provider_cursor_exposed: false,
      },
    };
  }

  private ensureDay(account: string, utcDay: string, now: string): void {
    this.db.query(`
      INSERT OR IGNORE INTO x_api_usage_days (
        account_id, utc_day, created_at, updated_at
      ) VALUES (?, ?, ?, ?)
    `).run(account, utcDay, now, now);
  }

  private dayRow(account: string, utcDay: string): UsageDayRow {
    const row = this.db.query(`
      SELECT api_requests, resource_reads, estimated_billable_resources,
        estimated_spend_microusd, rate_limit_limit, rate_limit_remaining,
        rate_limit_reset_at
      FROM x_api_usage_days
      WHERE account_id = ? AND utc_day = ?
    `).get(account, utcDay) as UsageDayRow | null;
    if (!row) throw new Error('X API usage day could not be initialized.');
    return row;
  }

  private reservedResources(account: string, utcDay: string): number {
    const row = this.db.query(`
      SELECT COALESCE(SUM(max_resources), 0) AS count
      FROM x_api_request_reservations
      WHERE account_id = ? AND utc_day = ?
    `).get(account, utcDay) as { count: number };
    return row.count;
  }

  private pendingRequestCount(account: string, utcDay: string): number {
    const row = this.db.query(`
      SELECT COUNT(*) AS count
      FROM x_api_request_reservations
      WHERE account_id = ? AND utc_day = ? AND api_request_counted = 0
    `).get(account, utcDay) as { count: number };
    return row.count;
  }

  private reservationRow(reservationId: string): ReservationRow | undefined {
    return this.db.query(`
      SELECT reservation_id, account_id, utc_day, max_resources, requested_at,
        api_request_counted, dispatch_by, provenance
      FROM x_api_request_reservations
      WHERE reservation_id = ?
    `).get(reservationId) as ReservationRow | null ?? undefined;
  }

  private deleteReservation(reservationId: string): void {
    this.db.query('DELETE FROM x_api_request_reservations WHERE reservation_id = ?').run(reservationId);
  }

  /**
   * An undispatched lease expires free: nothing was sent, so nothing is owed.
   * A dispatched one expires charged, because the request WAS sent and its
   * outcome is unknown — the same conservative arithmetic settleFailure applies
   * to a potentially-billable failure, moved into the day's spend counters
   * where it is visible and bounded instead of held as a reservation no settle
   * will ever release.
   */
  private reapExpiredReservations(now: Date, config?: XBookmarksLiveSyncConfig): void {
    const nowIso = now.toISOString();
    this.db.transaction(() => {
      this.db.query(`
        DELETE FROM x_api_request_reservations
        WHERE api_request_counted = 0 AND dispatch_by <= ?
      `).run(nowIso);
      if (!config) return;
      // COALESCE covers rows written before dispatched reservations carried a
      // lease at all: their process is gone by definition, so requested_at is
      // the only deadline they can have.
      const abandoned = this.db.query(`
        SELECT reservation_id, account_id, utc_day, max_resources, requested_at,
          api_request_counted, dispatch_by, provenance
        FROM x_api_request_reservations
        WHERE api_request_counted = 1 AND COALESCE(dispatch_by, requested_at) <= ?
      `).all(nowIso) as ReservationRow[];
      for (const reservation of abandoned) {
        this.chargeAbandonedDispatch(reservation, config, nowIso);
      }
    })();
  }

  private chargeAbandonedDispatch(
    reservation: ReservationRow,
    config: XBookmarksLiveSyncConfig,
    nowIso: string,
  ): void {
    const usage = this.db.query(`
      SELECT api_requests, resource_reads, estimated_billable_resources,
        estimated_spend_microusd, rate_limit_limit, rate_limit_remaining,
        rate_limit_reset_at
      FROM x_api_usage_days
      WHERE account_id = ? AND utc_day = ?
    `).get(reservation.account_id, reservation.utc_day) as UsageDayRow | null;
    if (usage) {
      const remainingReads = Math.max(0, config.dailyResourceReadBudget - usage.resource_reads);
      const remainingCostUnits = Math.max(0, Math.floor(
        (config.dailyEstimatedSpendMicrousd - usage.estimated_spend_microusd)
        / config.estimatedUnitCostMicrousd,
      ));
      // Same rule as settleFailure: an abandoned operator dispatch converts to
      // its full conservative charge even past the routine daily line.
      const uncertain = xApiInvocationProvenance(reservation.provenance) === 'operator'
        ? reservation.max_resources
        : Math.min(reservation.max_resources, remainingReads, remainingCostUnits);
      this.db.query(`
        UPDATE x_api_usage_days
        SET resource_reads = resource_reads + ?,
          estimated_billable_resources = estimated_billable_resources + ?,
          estimated_spend_microusd = estimated_spend_microusd + ?,
          updated_at = ?
        WHERE account_id = ? AND utc_day = ?
      `).run(
        uncertain,
        uncertain,
        uncertain * config.estimatedUnitCostMicrousd,
        nowIso,
        reservation.account_id,
        reservation.utc_day,
      );
    }
    this.deleteReservation(reservation.reservation_id);
  }
}

function readXBookmarksReconcileWatermarkRow(
  db: Database,
  account: string,
): XBookmarksReconcileWatermarkRow | null {
  return db.query(`
    SELECT reconcile_completed_at, reconcile_items_seen, reconcile_folders_seen,
      reconcile_folder_memberships_seen, reconcile_global_traversal_exhausted,
      reconcile_global_verification_matched,
      reconcile_removal_authoritative, reconcile_folder_inventory_authoritative,
      reconcile_coverage_scope, reconcile_window_boundary_verified,
      reconcile_traversal_digest_sha256, reconcile_traversal_cardinality,
      reconcile_verification_digest_sha256, reconcile_verification_cardinality,
      reconcile_absence_items_tombstoned, reconcile_out_of_scope_removals,
      reconcile_folder_inventory_coverage_gaps, reconcile_folders_carried_forward,
      reconcile_folder_membership_coverage_gaps, reconcile_folder_provider_outage,
      reconcile_staged_recovery_completed
    FROM x_bookmarks_live_state WHERE account_id = ?
  `).get(account) as XBookmarksReconcileWatermarkRow | null;
}

function xBookmarksReconcileWatermarkFromRow(
  row: XBookmarksReconcileWatermarkRow | null,
): XBookmarksReconcileWatermark | undefined {
  if (!row?.reconcile_completed_at) return undefined;
  const coverageScope = row.reconcile_coverage_scope;
  if (coverageScope !== 'account_snapshot' && coverageScope !== 'recency_window') {
    throw new Error('X reconciliation watermark coverage scope is corrupt.');
  }
  const windowProofGreen = coverageScope !== 'recency_window'
    || (
      row.reconcile_window_boundary_verified === 1
      && row.reconcile_traversal_digest_sha256 === row.reconcile_verification_digest_sha256
      && row.reconcile_traversal_cardinality === row.reconcile_verification_cardinality
      && row.reconcile_out_of_scope_removals === 0
    );
  const completeReconciliationAuthoritative = row.reconcile_global_traversal_exhausted === 1
    && row.reconcile_global_verification_matched === 1
    && row.reconcile_removal_authoritative === 1
    && windowProofGreen
    && row.reconcile_folder_inventory_authoritative === 1
    && row.reconcile_folder_inventory_coverage_gaps === 0
    && row.reconcile_folders_carried_forward === 0
    && row.reconcile_folder_membership_coverage_gaps === 0;
  return {
    completed_at: row.reconcile_completed_at,
    items_seen: row.reconcile_items_seen,
    folders_seen: row.reconcile_folders_seen,
    folder_memberships_seen: row.reconcile_folder_memberships_seen,
    global_traversal_exhausted: row.reconcile_global_traversal_exhausted === 1,
    global_verification_matched: row.reconcile_global_verification_matched === 1,
    removal_authoritative: row.reconcile_removal_authoritative === 1,
    coverage_scope: coverageScope,
    window_boundary_verified: row.reconcile_window_boundary_verified === 1,
    traversal_digest_sha256: normalizeSha256(
      row.reconcile_traversal_digest_sha256,
      'X reconciliation traversal digest',
    ),
    traversal_cardinality: nonNegativeCount(row.reconcile_traversal_cardinality),
    verification_digest_sha256: normalizeSha256(
      row.reconcile_verification_digest_sha256,
      'X reconciliation verification digest',
    ),
    verification_cardinality: nonNegativeCount(row.reconcile_verification_cardinality),
    absence_items_tombstoned: nonNegativeCount(row.reconcile_absence_items_tombstoned),
    out_of_scope_removals: nonNegativeCount(row.reconcile_out_of_scope_removals),
    folder_inventory_authoritative: row.reconcile_folder_inventory_authoritative === 1,
    folder_inventory_coverage_gaps: row.reconcile_folder_inventory_coverage_gaps,
    folders_carried_forward: row.reconcile_folders_carried_forward,
    folder_membership_coverage_gaps: row.reconcile_folder_membership_coverage_gaps,
    folder_provider_outage: row.reconcile_folder_provider_outage === 1,
    complete_reconciliation_authoritative: completeReconciliationAuthoritative,
    global_current_authority:
      row.reconcile_global_traversal_exhausted === 1
      && row.reconcile_global_verification_matched === 1
      && row.reconcile_removal_authoritative === 1
      && windowProofGreen
        ? 'green'
        : 'degraded',
    folder_provenance:
      row.reconcile_folder_inventory_authoritative === 1
      && row.reconcile_folder_inventory_coverage_gaps === 0
      && row.reconcile_folders_carried_forward === 0
      && row.reconcile_folder_membership_coverage_gaps === 0
        ? 'green'
        : 'degraded',
    staged_recovery: row.reconcile_staged_recovery_completed === 1
      ? 'completed'
      : 'not_needed',
  };
}

function xBookmarksApiUsageMigrations(): SqliteMigration[] {
  return [{
    version: 1,
    name: 'create_x_bookmarks_api_usage',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS x_api_usage_days (
          account_id TEXT NOT NULL,
          utc_day TEXT NOT NULL,
          api_requests INTEGER NOT NULL DEFAULT 0,
          resource_reads INTEGER NOT NULL DEFAULT 0,
          estimated_billable_resources INTEGER NOT NULL DEFAULT 0,
          estimated_spend_microusd INTEGER NOT NULL DEFAULT 0,
          rate_limit_limit INTEGER,
          rate_limit_remaining INTEGER,
          rate_limit_reset_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(account_id, utc_day)
        );
        CREATE TABLE IF NOT EXISTS x_api_request_reservations (
          reservation_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          utc_day TEXT NOT NULL,
          max_resources INTEGER NOT NULL,
          requested_at TEXT NOT NULL,
          FOREIGN KEY(account_id, utc_day) REFERENCES x_api_usage_days(account_id, utc_day)
        );
        CREATE TABLE IF NOT EXISTS x_api_usage_resources (
          account_id TEXT NOT NULL,
          utc_day TEXT NOT NULL,
          resource_hash TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          PRIMARY KEY(account_id, utc_day, resource_hash),
          FOREIGN KEY(account_id, utc_day) REFERENCES x_api_usage_days(account_id, utc_day)
        );
        CREATE TABLE IF NOT EXISTS x_bookmarks_live_state (
          account_id TEXT PRIMARY KEY,
          head_checkpoint TEXT,
          head_completed_at TEXT,
          reconcile_completed_at TEXT,
          updated_at TEXT NOT NULL
        );
      `);
    },
  }, {
    version: 2,
    name: 'persist_reconcile_inventory_watermark',
    up(db) {
      db.exec(`
        ALTER TABLE x_bookmarks_live_state ADD COLUMN reconcile_items_seen INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_bookmarks_live_state ADD COLUMN reconcile_folders_seen INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_bookmarks_live_state ADD COLUMN reconcile_folder_memberships_seen INTEGER NOT NULL DEFAULT 0;
      `);
    },
  }, {
    version: 3,
    name: 'persist_reconcile_authority_proof',
    up(db) {
      db.exec(`
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_global_traversal_exhausted INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_removal_authoritative INTEGER NOT NULL DEFAULT 0;
      `);
    },
  }, {
    version: 4,
    name: 'persist_reconcile_consistency_proof',
    up(db) {
      db.exec(`
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_global_verification_matched INTEGER NOT NULL DEFAULT 0;
      `);
    },
  }, {
    version: 5,
    name: 'persist_complete_folder_reconcile_proof',
    up(db) {
      db.exec(`
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_folder_inventory_authoritative INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_folder_inventory_coverage_gaps INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_folders_carried_forward INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_folder_membership_coverage_gaps INTEGER NOT NULL DEFAULT 0;
      `);
    },
  }, {
    version: 6,
    name: 'persist_split_reconcile_authority_and_recovery_proof',
    up(db) {
      db.exec(`
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_staged_recovery_completed INTEGER NOT NULL DEFAULT 0;
      `);
    },
  }, {
    version: 7,
    name: 'persist_reconcile_window_boundary_evidence',
    up(db) {
      db.exec(`
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_coverage_scope TEXT NOT NULL DEFAULT 'account_snapshot'
          CHECK(reconcile_coverage_scope IN ('account_snapshot', 'recency_window'));
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_window_boundary_verified INTEGER NOT NULL DEFAULT 0
          CHECK(reconcile_window_boundary_verified IN (0, 1));
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_traversal_digest_sha256 TEXT NOT NULL
          DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_traversal_cardinality INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_verification_digest_sha256 TEXT NOT NULL
          DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_verification_cardinality INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_absence_items_tombstoned INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_out_of_scope_removals INTEGER NOT NULL DEFAULT 0;
      `);
    },
  }, {
    version: 8,
    name: 'persist_folder_provider_outage_evidence',
    up(db) {
      db.exec(`
        ALTER TABLE x_bookmarks_live_state
          ADD COLUMN reconcile_folder_provider_outage INTEGER NOT NULL DEFAULT 0
          CHECK(reconcile_folder_provider_outage IN (0, 1));
      `);
    },
  }, {
    version: 9,
    name: 'defer_api_request_count_until_dispatch',
    up(db) {
      db.exec(`
        ALTER TABLE x_api_request_reservations
          ADD COLUMN api_request_counted INTEGER NOT NULL DEFAULT 1
          CHECK(api_request_counted IN (0, 1));
        ALTER TABLE x_api_request_reservations
          ADD COLUMN dispatch_by TEXT;
      `);
    },
  }, {
    version: 10,
    name: 'persist_head_truncation_deferral',
    up(db) {
      db.exec(`
        ALTER TABLE x_bookmarks_live_state ADD COLUMN head_truncation_deferred_at TEXT;
      `);
    },
  }, {
    version: 11,
    name: 'reservation_invocation_provenance',
    // Durable rather than in-memory: the operator exemption admitted at
    // reservation time must survive to dispatch, settlement, and the
    // crash-reap conversion, and the ledger keeps a truthful record of which
    // requests were operator-initiated (owner ruling 2026-08-19).
    up(db) {
      db.exec(`
        ALTER TABLE x_api_request_reservations
          ADD COLUMN provenance TEXT NOT NULL DEFAULT 'scheduled'
          CHECK(provenance IN ('scheduled', 'operator'));
      `);
    },
  }];
}

function usageGuard(
  row: UsageDayRow,
  reserved: number,
  pendingRequests: number,
  config: XBookmarksLiveSyncConfig,
  now: Date,
): XApiUsageStatus['guard'] {
  const nextDay = nextUtcDay(now);
  const degradedRetry = new Date(now.getTime() + config.degradedIntervalMs).toISOString();
  if (rateLimitBlocks(row, config, now)) {
    return { state: 'approaching', degraded_reason: 'provider_rate_limit', retry_at: row.rate_limit_reset_at! };
  }
  if (row.api_requests + pendingRequests >= config.dailyApiRequestBudget) {
    return { state: 'exhausted', degraded_reason: 'daily_api_request_guard', retry_at: nextDay };
  }
  if (row.resource_reads + reserved >= config.dailyResourceReadBudget) {
    return { state: 'exhausted', degraded_reason: 'daily_resource_read_guard', retry_at: nextDay };
  }
  if (row.estimated_spend_microusd + reserved * config.estimatedUnitCostMicrousd
    >= config.dailyEstimatedSpendMicrousd) {
    return { state: 'exhausted', degraded_reason: 'daily_cost_guard', retry_at: nextDay };
  }
  const requestNear = row.api_requests + pendingRequests >= Math.floor(config.dailyApiRequestBudget * 0.9);
  const readsNear = row.resource_reads + reserved >= Math.floor(config.dailyResourceReadBudget * 0.9);
  const spendNear = row.estimated_spend_microusd + reserved * config.estimatedUnitCostMicrousd
    >= Math.floor(config.dailyEstimatedSpendMicrousd * 0.9);
  // Near-budget is an advisory, not a park: the lane keeps running at the
  // degraded cadence rather than sleeping to the rollover like the exhausted
  // branches above. Expiry is not carried by `retry_at` for that reason --
  // the marker is scoped to its UTC day and readers drop it once the day has
  // rolled over (`UTC_DAY_SCOPED_DEGRADED_REASONS`, source-scheduler.ts), so
  // it expires even when the task never runs again.
  if (requestNear) return { state: 'approaching', degraded_reason: 'daily_api_request_guard', retry_at: degradedRetry };
  if (readsNear) return { state: 'approaching', degraded_reason: 'daily_resource_read_guard', retry_at: degradedRetry };
  if (spendNear) return { state: 'approaching', degraded_reason: 'daily_cost_guard', retry_at: degradedRetry };
  return { state: 'ok' };
}

function rateLimitBlocks(
  row: UsageDayRow,
  config: XBookmarksLiveSyncConfig,
  now: Date,
  background = true,
): boolean {
  return row.rate_limit_remaining !== null
    && row.rate_limit_remaining <= (background ? config.rateLimitLowWatermark : 0)
    && row.rate_limit_reset_at !== null
    && Date.parse(row.rate_limit_reset_at) > now.getTime();
}

function rateLimitStatus(row: UsageDayRow): Pick<XApiUsageStatus, 'rate_limit'> {
  if (row.rate_limit_limit === null && row.rate_limit_remaining === null && row.rate_limit_reset_at === null) return {};
  return {
    rate_limit: {
      ...(row.rate_limit_limit !== null ? { limit: row.rate_limit_limit } : {}),
      ...(row.rate_limit_remaining !== null ? { remaining: row.rate_limit_remaining } : {}),
      ...(row.rate_limit_reset_at !== null ? { reset_at: row.rate_limit_reset_at } : {}),
    },
  };
}

function hashResourceId(resourceId: string): string {
  return createHash('sha256').update(resourceId).digest('hex');
}

function utcDayFrom(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextUtcDay(date: Date): string {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return next.toISOString();
}

function requireAccount(value: string): string {
  const account = value.trim();
  if (!account || account.length > MAX_ACCOUNT_LENGTH) throw new TypeError('X API usage account must be bounded and non-empty.');
  return account;
}

function boundedResourceCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_REQUEST_RESOURCES) {
    throw new TypeError(`X API request resources must be an integer from 0 to ${MAX_REQUEST_RESOURCES}.`);
  }
  return value;
}

function backgroundBudget(hardBudget: number, headReserve: number): number {
  return Math.max(0, hardBudget - headReserve);
}

// Release full cadence slots only. Continuous proration can release part of
// the next poll before it runs; at an hourly cadence that can strand the last
// full poll. The hard daily budget and spend ceilings remain unchanged.
function cadenceSteppedHeadReserve(reserve: number, cadenceMs: number, now: Date): number {
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const elapsedMs = now.getTime() - dayStartMs;
  const dayMs = 86_400_000;
  const slotsPerDay = Math.ceil(dayMs / cadenceMs);
  const remainingMs = Math.min(dayMs, Math.max(0, dayMs - elapsedMs));
  const remainingSlots = Math.ceil(remainingMs / cadenceMs);
  return Math.ceil((reserve * remainingSlots) / slotsPerDay);
}

function nonNegativeCount(value: number | undefined): number {
  const count = value ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('X reconciliation counts must be non-negative integers.');
  return count;
}

function normalizeSha256(value: string | undefined, label: string): string {
  const normalized = value?.trim().toLowerCase() || EMPTY_SHA256;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new TypeError(`${label} must be a SHA-256 digest.`);
  }
  return normalized;
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new TypeError('X API usage timestamp must be valid.');
  return value;
}

function usdToMicrousd(value: number): number {
  const microusd = Math.round(value * MICRO_USD_PER_USD);
  if (!Number.isSafeInteger(microusd) || microusd <= 0) throw new TypeError('X estimated USD values must be positive and bounded.');
  return microusd;
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError('X live-sync integer configuration must be positive.');
  return parsed;
}

function nonNegativeIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError('X live-sync integer configuration must be non-negative.');
  return parsed;
}

function boundedPositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Math.max(min, Math.min(max, positiveIntegerEnv(value, fallback)));
}

const DEFAULT_X_HEAD_PAGE_SIZE_LADDER = Object.freeze([10, 20, 40, 80, 100]);

function headPageSizeLadderEnv(value: string | undefined): readonly number[] {
  if (value === undefined || value.trim() === '') return DEFAULT_X_HEAD_PAGE_SIZE_LADDER;
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length < 1 || entries.length > X_BOOKMARKS_HEAD_MAX_LADDER_PAGES) {
    throw new TypeError(
      `X head page-size ladder must contain 1 through ${X_BOOKMARKS_HEAD_MAX_LADDER_PAGES} entries.`,
    );
  }
  const ladder = entries.map((entry) => Number(entry));
  for (let index = 0; index < ladder.length; index += 1) {
    const size = ladder[index]!;
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) {
      throw new TypeError('X head page-size ladder entries must be integers from 1 through 100.');
    }
    if (index > 0 && size <= ladder[index - 1]!) {
      throw new TypeError('X head page-size ladder entries must be strictly increasing.');
    }
  }
  return Object.freeze(ladder);
}

function positiveNumberEnv(value: string | undefined, fallback: number): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) throw new TypeError('X live-sync numeric configuration must be positive.');
  return parsed;
}
