import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  assertSqliteSchemaCanOpen,
  runSqliteMigrations,
  type SqliteMigration,
} from '../../core/sqlite-migrations.ts';
import type {
  XBookmarkFolder,
  XBookmarkFolderPage,
  XBookmarkPost,
  XBookmarkPostPage,
} from './api.ts';
import type { XBookmarkFolderIdentity } from './connector.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';

export const X_BOOKMARKS_RECONCILE_STATE_STORE_ID = 'x-bookmarks-reconcile-state';
export const X_BOOKMARKS_RECONCILE_STATE_SCHEMA_VERSION = 11;

const MAX_ACCOUNT_LENGTH = 256;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_FOLDER_ID_LENGTH = 512;
const MAX_FOLDER_NAME_LENGTH = 4_096;
const MAX_POST_ID_LENGTH = 256;
const MAX_POST_JSON_BYTES = 1_000_000;
const MAX_PROVIDER_USER_ID_LENGTH = 256;
const RECONCILE_ALGORITHM_VERSION = 6;
export const X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION = 2;
const PRESERVATION_FLOOR_MAX_UNREVIEWED_REMOVAL_BPS = 2_500;
const PRESERVATION_FLOOR_MIN_UNREVIEWED_REMOVALS = 20;
const FOLDER_FACET_REFRESH_LEASE_MS = 5 * 60_000;

export interface XBookmarksReconcileLimits {
  maxItems: number;
  maxFolders: number;
  maxPagesPerScope: number;
  pageSize: number;
}

export type XBookmarksReconcilePhase = 'global' | 'global_verify' | 'folders' | 'memberships';
export type XBookmarksStagedFailureClass =
  | 'invalid_or_expired_cursor'
  | 'deleted_scope'
  | 'pagination_cycle'
  | 'corrupt_stage'
  | 'incompatible_stage'
  /**
   * The provider window moved under a staged traversal: the verification pass
   * can no longer reproduce the rich pass, or a settled boundary step was
   * offered a second time. The staged evidence is unusable and no retry of the
   * same cursors can repair it, so it is recovery-eligible exactly like a
   * poisoned cursor rather than an anonymous temporary provider failure.
   */
  | 'window_boundary_drift';

export interface XBookmarksStagedRecoveryStatus {
  staged: boolean;
  staged_recovery: 'not_needed' | 'completed';
  phase?: XBookmarksReconcilePhase;
  staged_age_ms?: number;
  page_counts?: {
    global: number;
    global_verify: number;
    folders: number;
    memberships: number;
  };
  staged_counts?: {
    posts: number;
    folders: number;
    memberships: number;
  };
  failure_class?: XBookmarksStagedFailureClass;
  failure_count?: number;
  recovery_eligible?: boolean;
  automatic_recovery_ready?: boolean;
  staged_digest_sha256?: string;
  last_recovery_receipt_sha256?: string;
  policy: {
    counts_only: true;
    source_text_returned: false;
    provider_cursor_exposed: false;
  };
}

export interface XBookmarksStagedRecoveryReceipt {
  staged_recovery: 'completed';
  recovery_mode: 'automatic' | 'operator';
  failure_class?: XBookmarksStagedFailureClass;
  pages_cleared: number;
  staged_posts_cleared: number;
  staged_folders_cleared: number;
  staged_memberships_cleared: number;
  completed_baseline_preserved: true;
  staged_digest_sha256: string;
  completed_baseline_sha256: string;
  receipt_sha256: string;
  recovered_at: string;
  policy: {
    counts_only: true;
    source_text_returned: false;
    provider_cursor_exposed: false;
  };
}

export interface XBookmarksReconcileProgress {
  runId: string;
  phase: XBookmarksReconcilePhase;
  globalNextToken?: string;
  globalPages: number;
  globalVerifyNextToken?: string;
  globalVerifyPages: number;
  globalVerifyItemsStaged: number;
  /** Durable smaller retry rung for the current global/global-verify cursor. */
  postRetryPageSize?: number;
  folderNextToken?: string;
  folderPages: number;
  membershipFolderOrdinal: number;
  membershipNextToken?: string;
  membershipPages: number;
  itemsStaged: number;
  foldersStaged: number;
  membershipsStaged: number;
  folderPostsAbsentFromGlobal: number;
  globalRemovalAuthoritative: boolean;
  globalVerificationMatched: boolean;
  coverageScope: XBookmarksCoverageScope;
  windowBoundaryVerified: boolean;
  /**
   * The global traversal already settled where its window ends — by exhausting
   * the provider naturally or by consuming the boundary token an approved
   * provider refusal produced. A settled boundary is spent: the boundary step
   * is not a position a resumed run can ever occupy again.
   */
  globalBoundarySettled: boolean;
  folderInventoryAuthoritative: boolean;
  folderInventoryCoverageGaps: number;
  foldersCarriedForward: number;
  folderMembershipCoverageGaps: number;
  folderProviderOutage: boolean;
  startedAt: string;
  updatedAt: string;
}

export interface XBookmarksReconcileOpenResult {
  progress: XBookmarksReconcileProgress;
  warnings: string[];
}

export interface XBookmarksCompletedReconcileSnapshot {
  /** Immutable cutoff captured before the first provider page of this run. */
  snapshotObservedAt: string;
  /** Provider traversal completion, distinct from later shared-store application. */
  completedAt: string;
  appliedAt?: string;
  applicationStatus: 'pending' | 'applied' | 'degraded';
  itemsObserved: number;
  foldersObserved: number;
  posts: XBookmarkPost[];
  /** Explicit removals proven newer than the prior/current window overlap. */
  inWindowRemovedPosts: XBookmarkPost[];
  /**
   * Removals an EARLIER run proved and the shared store declined to apply
   * because an owner had been observed at or after that run's cutoff.
   *
   * Carried here because the derivation cannot reproduce them: a removal is a
   * prior-present/current-absent transition, and promotion drops the post from
   * both sides, so the transition is offered exactly once. Without this the
   * refusal silently became a permanent decision to keep an unbookmarked post
   * searchable for ever. These are re-presented against this run's newer cutoff
   * and are spent when they apply, or forgotten the moment the post is
   * genuinely re-observed in a promoted snapshot.
   */
  deferredWindowRemovalPostIds: readonly string[];
  folders: XBookmarkFolder[];
  foldersByPostId: ReadonlyMap<string, readonly XBookmarkFolderIdentity[]>;
  checkpoint?: string;
  folderPostsAbsentFromGlobal: number;
  globalRemovalAuthoritative: boolean;
  globalVerificationMatched: boolean;
  coverageScope: XBookmarksCoverageScope;
  windowBoundaryVerified: boolean;
  windowBoundaryAlgorithmVersion: number;
  traversalDigestSha256: string;
  traversalCardinality: number;
  verificationDigestSha256: string;
  verificationCardinality: number;
  pageSize80Requests: number;
  pageSize50Requests: number;
  pageSize20Requests: number;
  pageSizeOtherRequests: number;
  truncationRetries: number;
  folderInventoryAuthoritative: boolean;
  folderInventoryCoverageGaps: number;
  foldersCarriedForward: number;
  folderMembershipCoverageGaps: number;
  folderProviderOutage: boolean;
  completeReconciliationAuthoritative: boolean;
  globalCurrentAuthority: 'green' | 'degraded';
  folderProvenance: 'green' | 'degraded';
  stagedRecovery: 'not_needed' | 'completed';
}

/**
 * One application pass's answer about the removals it presented, settled in the
 * same transaction as the disposition that reports the pass finished.
 */
export interface XBookmarksWindowRemovalSettlement {
  /** Every removal this pass HANDED to the shared store, fresh plus carried. */
  presentedPostIds: readonly string[];
  /** The subset the store declined on the newer-observation ground. */
  deferredPostIds: readonly string[];
  /** The snapshot cutoff the declined removals failed against. */
  observedAt: string;
}

export interface XBookmarksWindowRemovalDebtOutcome {
  /** Presented ids the store declined again; still owed after this pass. */
  carried: number;
  /** Presented ids that left the debt table: applied, refused, or already gone. */
  spent: number;
  /** Rows still owed for this account once the pass settled. */
  standing: number;
  /**
   * Oldest standing `first_deferred_at`, absent when nothing is owed. This is
   * the only reading of how long a removal has gone unapplied, and a debt that
   * outlives several reconcile cadences is a stuck lane, not a timing accident.
   */
  oldestFirstDeferredAt?: string;
}

export type XBookmarksCoverageScope = 'account_snapshot' | 'recency_window';

export interface XBookmarksReconcileCoverageSelection {
  coverageScope: XBookmarksCoverageScope;
  windowBoundaryAlgorithmVersion?: number;
}

export interface XBookmarksFolderFacetRefreshProgress {
  status: 'running' | 'completed';
  sourceInventorySha256: string;
  embeddingProviderFingerprintSha256: string;
  algorithmVersion: number;
  cursor?: string;
  counts: {
    itemsScanned: number;
    itemsRefreshed: number;
    itemsUnchanged: number;
    itemsMissing: number;
    ftsRowsRefreshed: number;
    chunkEmbeddingInputsInvalidated: number;
    chunksEmbedded: number;
    chunksEmbeddingCurrent: number;
  };
}

export interface XBookmarksFolderFacetRefreshRun {
  runToken: string;
  leaseGeneration: number;
  embeddingCurrencyInvalidationRequired: boolean;
  progress: XBookmarksFolderFacetRefreshProgress;
}

export type XBookmarksFolderFacetRefreshAuthority =
  | { status: 'running' | 'completed'; leaseGeneration: number }
  | { status: 'unavailable' };

export interface XBookmarksPreservationFloorAssessment {
  status: 'not_applicable' | 'green' | 'authorization_required' | 'authorized';
  priorItems: number;
  proposedItems: number;
  minimumRetainedItems: number;
  priorSnapshotSha256: string;
  proposedSnapshotSha256: string;
  requiredAuthorizationSha256: string;
}

export function defaultXBookmarksReconcileStateDbPath(
  env: Record<string, string | undefined> = process.env,
  usageDbPath?: string,
): string {
  const configured = env.OLYMPUS_SOURCE_INDEX_X_RECONCILE_STATE_DB_PATH?.trim();
  if (configured) return configured;
  if (usageDbPath === ':memory:') return ':memory:';
  if (usageDbPath?.trim()) return `${usageDbPath.trim()}.reconcile`;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'x-bookmarks-reconcile-state.sqlite');
}

/**
 * X-private restart state. This store never participates in counts-only
 * admin/status responses; raw folder inventory is exposed only through the
 * explicit internal accessor used by acceptance tests and repair tooling.
 */
export class LocalXBookmarksReconcileStateStore {
  readonly dbPath: string;
  private readonly db: Database;

  constructor(dbPath = defaultXBookmarksReconcileStateDbPath()) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath, { create: true });
    if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
    this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    assertSqliteSchemaCanOpen(
      this.db,
      X_BOOKMARKS_RECONCILE_STATE_STORE_ID,
      X_BOOKMARKS_RECONCILE_STATE_SCHEMA_VERSION,
    );
    runSqliteMigrations(
      this.db,
      X_BOOKMARKS_RECONCILE_STATE_STORE_ID,
      xBookmarksReconcileStateMigrations(),
    );
  }

  close(): void {
    closeSqliteStore(this.db);
  }

  folderFacetRefreshAuthority(input: {
    account: string;
    providerUserId: string;
    algorithmVersion: number;
  }): XBookmarksFolderFacetRefreshAuthority {
    const account = requireAccount(input.account);
    const providerUserId = boundedRequired(
      input.providerUserId,
      MAX_PROVIDER_USER_ID_LENGTH,
      'X folder-facet refresh provider user id',
    );
    if (!Number.isSafeInteger(input.algorithmVersion) || input.algorithmVersion < 1) {
      throw new TypeError('X folder-facet refresh algorithm version must be positive.');
    }
    const row = this.db.query(`
      SELECT status, provider_user_id, algorithm_version, lease_generation
      FROM x_folder_facet_refresh_progress
      WHERE account_id = ?
    `).get(account) as {
      status: string;
      provider_user_id: string;
      algorithm_version: number;
      lease_generation: number;
    } | null;
    if (row?.provider_user_id !== providerUserId
      || row.algorithm_version !== input.algorithmVersion) {
      return { status: 'unavailable' };
    }
    if (!Number.isSafeInteger(row.lease_generation) || row.lease_generation < 0) {
      throw new Error('X folder-facet refresh lease generation is corrupt.');
    }
    if (row.status === 'running' || row.status === 'completed') {
      return {
        status: row.status,
        leaseGeneration: row.lease_generation,
      };
    }
    throw new Error('X folder-facet refresh checkpoint status is corrupt.');
  }

  beginFolderFacetRefreshRun(input: {
    account: string;
    providerUserId: string;
    sourceInventorySha256: string;
    embeddingProviderFingerprintSha256: string;
    algorithmVersion: number;
    now?: Date;
  }): XBookmarksFolderFacetRefreshRun {
    const account = requireAccount(input.account);
    const providerUserId = boundedRequired(
      input.providerUserId,
      MAX_PROVIDER_USER_ID_LENGTH,
      'X folder-facet refresh provider user id',
    );
    const sourceInventorySha256 = normalizeRequiredSha256(
      input.sourceInventorySha256,
      'X folder-facet refresh source inventory digest',
    );
    const embeddingProviderFingerprintSha256 = normalizeRequiredSha256(
      input.embeddingProviderFingerprintSha256,
      'X folder-facet refresh embedding provider fingerprint',
    );
    if (!Number.isSafeInteger(input.algorithmVersion) || input.algorithmVersion < 1) {
      throw new TypeError('X folder-facet refresh algorithm version must be positive.');
    }
    const nowDate = validDate(input.now ?? new Date());
    const now = nowDate.toISOString();
    const leaseExpiresAt = new Date(
      nowDate.getTime() + FOLDER_FACET_REFRESH_LEASE_MS,
    ).toISOString();
    const runToken = randomUUID();
    return this.db.transaction(() => {
      const existing = this.db.query(`
        SELECT *
        FROM x_folder_facet_refresh_progress
        WHERE account_id = ?
      `).get(account) as FolderFacetRefreshProgressRow | null;
      const authority = this.db.query(`
        SELECT lease_generation, embedding_provider_fingerprint_sha256,
          embedding_invalidation_required
        FROM x_folder_facet_refresh_authority
        WHERE account_id = ?
      `).get(account) as FolderFacetRefreshAuthorityRow | null;
      if (existing && !authority) {
        throw new Error(
          'X folder-facet refresh progress exists but its authority is missing; '
          + 'the checkpoint is corrupt or unbound.',
        );
      }
      if (existing?.run_token) {
        const existingLeaseExpiresAt = Date.parse(existing.lease_expires_at ?? '');
        if (!Number.isFinite(existingLeaseExpiresAt)) {
          throw new Error('X folder-facet refresh lease state is corrupt.');
        }
        if (existingLeaseExpiresAt > nowDate.getTime()) {
          throw new Error('X folder-facet refresh is already running for this account.');
        }
      }
      const progressFingerprintChanged = existing !== null
        && existing.embedding_provider_fingerprint_sha256 !== null
        && existing.embedding_provider_fingerprint_sha256
          !== embeddingProviderFingerprintSha256;
      if (progressFingerprintChanged && existing?.status !== 'completed') {
        throw new Error(
          'X folder-facet refresh embedding provider fingerprint changed; '
          + 'call resetFolderFacetRefresh(account, '
          + "'embedding_provider_migration') before a new run.",
        );
      }
      const fingerprintChanged = authority !== null
        && authority.embedding_provider_fingerprint_sha256 !== null
        && authority.embedding_provider_fingerprint_sha256
          !== embeddingProviderFingerprintSha256;
      const priorLeaseGeneration = Math.max(
        existing?.lease_generation ?? 0,
        authority?.lease_generation ?? 0,
      );
      if (!Number.isSafeInteger(priorLeaseGeneration)
        || priorLeaseGeneration < 0
        || priorLeaseGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new Error('X folder-facet refresh authority generation is corrupt.');
      }
      const leaseGeneration = priorLeaseGeneration + 1;
      const embeddingCurrencyInvalidationRequired = fingerprintChanged
        || authority?.embedding_invalidation_required === 1;
      this.db.query(`
        INSERT INTO x_folder_facet_refresh_authority (
          account_id, lease_generation, embedding_provider_fingerprint_sha256,
          embedding_invalidation_required
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          lease_generation = excluded.lease_generation,
          embedding_provider_fingerprint_sha256 =
            excluded.embedding_provider_fingerprint_sha256,
          embedding_invalidation_required =
            excluded.embedding_invalidation_required
      `).run(
        account,
        leaseGeneration,
        embeddingProviderFingerprintSha256,
        embeddingCurrencyInvalidationRequired ? 1 : 0,
      );
      if (!existing
        || existing.provider_user_id !== providerUserId
        || existing.source_inventory_sha256 !== sourceInventorySha256
        || progressFingerprintChanged
        || existing.algorithm_version !== input.algorithmVersion) {
        this.db.query(`
          INSERT INTO x_folder_facet_refresh_progress (
            account_id, provider_user_id, source_inventory_sha256,
            embedding_provider_fingerprint_sha256, algorithm_version, status, cursor,
            items_scanned, items_refreshed, items_unchanged, items_missing,
            fts_rows_refreshed, chunk_embedding_inputs_invalidated,
            chunks_embedded, chunks_embedding_current,
            started_at, updated_at, completed_at, run_token, lease_expires_at,
            lease_generation
          ) VALUES (?, ?, ?, ?, ?, 'running', NULL, 0, 0, 0, 0, 0, 0, 0, 0,
            ?, ?, NULL, ?, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            provider_user_id = excluded.provider_user_id,
            source_inventory_sha256 = excluded.source_inventory_sha256,
            embedding_provider_fingerprint_sha256 =
              excluded.embedding_provider_fingerprint_sha256,
            algorithm_version = excluded.algorithm_version,
            status = 'running',
            cursor = NULL,
            items_scanned = 0,
            items_refreshed = 0,
            items_unchanged = 0,
            items_missing = 0,
            fts_rows_refreshed = 0,
            chunk_embedding_inputs_invalidated = 0,
            chunks_embedded = 0,
            chunks_embedding_current = 0,
            started_at = excluded.started_at,
            updated_at = excluded.updated_at,
            completed_at = NULL,
            run_token = excluded.run_token,
            lease_expires_at = excluded.lease_expires_at,
            lease_generation = excluded.lease_generation
        `).run(
          account,
          providerUserId,
          sourceInventorySha256,
          embeddingProviderFingerprintSha256,
          input.algorithmVersion,
          now,
          now,
          runToken,
          leaseExpiresAt,
          leaseGeneration,
        );
      } else {
        this.db.query(`
          UPDATE x_folder_facet_refresh_progress
          SET embedding_provider_fingerprint_sha256 = ?,
            run_token = ?, lease_expires_at = ?, lease_generation = ?, updated_at = ?
          WHERE account_id = ?
        `).run(
          embeddingProviderFingerprintSha256,
          runToken,
          leaseExpiresAt,
          leaseGeneration,
          now,
          account,
        );
      }
      const row = this.db.query(`
        SELECT *
        FROM x_folder_facet_refresh_progress
        WHERE account_id = ?
      `).get(account) as FolderFacetRefreshProgressRow;
      return {
        runToken,
        leaseGeneration,
        embeddingCurrencyInvalidationRequired,
        progress: folderFacetRefreshProgressFromRow(row),
      };
    })();
  }

  renewFolderFacetRefreshRun(input: {
    account: string;
    runToken: string;
    leaseGeneration: number;
    now?: Date;
  }): void {
    const account = requireAccount(input.account);
    const runToken = boundedRequired(input.runToken, 128, 'X folder-facet refresh run token');
    const leaseGeneration = boundedPositive(
      input.leaseGeneration,
      Number.MAX_SAFE_INTEGER,
      'X folder-facet refresh lease generation',
    );
    const nowDate = validDate(input.now ?? new Date());
    const leaseExpiresAt = new Date(
      nowDate.getTime() + FOLDER_FACET_REFRESH_LEASE_MS,
    ).toISOString();
    const result = this.db.query(`
      UPDATE x_folder_facet_refresh_progress
      SET lease_expires_at = ?, updated_at = ?
      WHERE account_id = ? AND run_token = ? AND lease_generation = ?
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
    `).run(
      leaseExpiresAt,
      nowDate.toISOString(),
      account,
      runToken,
      leaseGeneration,
      nowDate.toISOString(),
    );
    if (result.changes !== 1) {
      throw new Error('X folder-facet refresh lease is no longer owned by this run.');
    }
  }

  releaseFolderFacetRefreshRun(input: {
    account: string;
    runToken: string;
    leaseGeneration: number;
    now?: Date;
  }): void {
    const account = requireAccount(input.account);
    const runToken = boundedRequired(input.runToken, 128, 'X folder-facet refresh run token');
    const leaseGeneration = boundedPositive(
      input.leaseGeneration,
      Number.MAX_SAFE_INTEGER,
      'X folder-facet refresh lease generation',
    );
    const now = validDate(input.now ?? new Date()).toISOString();
    this.db.query(`
      UPDATE x_folder_facet_refresh_progress
      SET run_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE account_id = ? AND run_token = ? AND lease_generation = ?
    `).run(now, account, runToken, leaseGeneration);
  }

  advanceFolderFacetRefresh(input: {
    account: string;
    runToken: string;
    leaseGeneration: number;
    sourceInventorySha256: string;
    embeddingProviderFingerprintSha256: string;
    algorithmVersion: number;
    expectedCursor?: string;
    nextCursor?: string;
    completed: boolean;
    counts: XBookmarksFolderFacetRefreshProgress['counts'];
    now?: Date;
  }): XBookmarksFolderFacetRefreshProgress {
    const account = requireAccount(input.account);
    const runToken = boundedRequired(input.runToken, 128, 'X folder-facet refresh run token');
    const leaseGeneration = boundedPositive(
      input.leaseGeneration,
      Number.MAX_SAFE_INTEGER,
      'X folder-facet refresh lease generation',
    );
    const sourceInventorySha256 = normalizeRequiredSha256(
      input.sourceInventorySha256,
      'X folder-facet refresh source inventory digest',
    );
    const embeddingProviderFingerprintSha256 = normalizeRequiredSha256(
      input.embeddingProviderFingerprintSha256,
      'X folder-facet refresh embedding provider fingerprint',
    );
    const expectedCursor = input.expectedCursor?.trim() || null;
    const nextCursor = input.nextCursor?.trim() || null;
    const counts = normalizeFolderFacetRefreshCounts(input.counts);
    const now = validDate(input.now ?? new Date()).toISOString();
    return this.db.transaction(() => {
      const current = this.db.query(`
        SELECT *
        FROM x_folder_facet_refresh_progress
        WHERE account_id = ?
      `).get(account) as FolderFacetRefreshProgressRow | null;
      if (!current
        || current.status !== 'running'
        || current.source_inventory_sha256 !== sourceInventorySha256
        || current.embedding_provider_fingerprint_sha256
          !== embeddingProviderFingerprintSha256
        || current.algorithm_version !== input.algorithmVersion
        || current.cursor !== expectedCursor
        || current.run_token !== runToken
        || current.lease_generation !== leaseGeneration
        || !current.lease_expires_at
        || Date.parse(current.lease_expires_at) <= Date.parse(now)) {
        throw new Error('X folder-facet refresh checkpoint changed before page commit.');
      }
      this.db.query(`
        UPDATE x_folder_facet_refresh_progress
        SET status = ?,
          cursor = ?,
          items_scanned = items_scanned + ?,
          items_refreshed = items_refreshed + ?,
          items_unchanged = items_unchanged + ?,
          items_missing = items_missing + ?,
          fts_rows_refreshed = fts_rows_refreshed + ?,
          chunk_embedding_inputs_invalidated =
            chunk_embedding_inputs_invalidated + ?,
          chunks_embedded = chunks_embedded + ?,
          chunks_embedding_current = chunks_embedding_current + ?,
          updated_at = ?,
          completed_at = ?
        WHERE account_id = ? AND run_token = ? AND lease_generation = ?
      `).run(
        input.completed ? 'completed' : 'running',
        nextCursor,
        counts.itemsScanned,
        counts.itemsRefreshed,
        counts.itemsUnchanged,
        counts.itemsMissing,
        counts.ftsRowsRefreshed,
        counts.chunkEmbeddingInputsInvalidated,
        counts.chunksEmbedded,
        counts.chunksEmbeddingCurrent,
        now,
        input.completed ? now : null,
        account,
        runToken,
        leaseGeneration,
      );
      if (input.completed) {
        const authority = this.db.query(`
          UPDATE x_folder_facet_refresh_authority
          SET embedding_invalidation_required = 0
          WHERE account_id = ? AND lease_generation = ?
            AND embedding_provider_fingerprint_sha256 = ?
        `).run(
          account,
          leaseGeneration,
          embeddingProviderFingerprintSha256,
        );
        if (authority.changes !== 1) {
          throw new Error('X folder-facet refresh authority changed before completion.');
        }
      }
      const updated = this.db.query(`
        SELECT *
        FROM x_folder_facet_refresh_progress
        WHERE account_id = ?
      `).get(account) as FolderFacetRefreshProgressRow;
      return folderFacetRefreshProgressFromRow(updated);
    })();
  }

  openRun(
    accountValue: string,
    limitsValue: XBookmarksReconcileLimits,
    providerUserIdValue: string,
    openedAt = new Date(),
    coverageSelection: XBookmarksReconcileCoverageSelection = {
      coverageScope: 'account_snapshot',
    },
  ): XBookmarksReconcileOpenResult {
    const account = requireAccount(accountValue);
    const limits = requireLimits(limitsValue);
    const providerUserId = boundedRequired(
      providerUserIdValue,
      MAX_PROVIDER_USER_ID_LENGTH,
      'provider user id',
    );
    const coverageScope = requireCoverageScope(coverageSelection.coverageScope);
    const windowBoundaryAlgorithmVersion = coverageScope === 'recency_window'
      ? boundedPositive(
          coverageSelection.windowBoundaryAlgorithmVersion
            ?? X_BOOKMARKS_WINDOW_BOUNDARY_ALGORITHM_VERSION,
          1_000_000,
          'window boundary algorithm version',
        )
      : 0;
    const now = validDate(openedAt).toISOString();
    const compatibilityHash = reconcileCompatibilityHash(
      limits,
      providerUserId,
      coverageScope,
      windowBoundaryAlgorithmVersion,
    );
    const existing = this.runRow(account);
    const warnings: string[] = [];

    const completed = this.completedSnapshotRow(account);
    if (completed && completed.provider_user_id !== providerUserId) {
      throw new Error(
        'X reconciliation provider identity changed; explicit account migration or state reset is required.',
      );
    }
    if (completed) this.completedSnapshot(account);

    if (existing && existing.provider_user_id !== providerUserId) {
      throw new Error(
        'X reconciliation provider identity changed during a staged run; explicit state reset is required.',
      );
    } else if (existing && existing.compatibility_hash !== compatibilityHash) {
      this.recordStagedFailure(account, 'incompatible_stage', openedAt);
      throw new ReconcileStagedRecoveryRequiredError('incompatible_stage');
    } else if (existing) {
      try {
        this.validateStagedRun(account, existing, limits);
      } catch {
        this.recordStagedFailure(account, 'corrupt_stage', openedAt);
        throw new ReconcileStagedRecoveryRequiredError('corrupt_stage');
      }
    }

    if (!this.runRow(account)) {
      this.db.query(`
        INSERT INTO x_reconcile_runs (
          account_id, run_id, provider_user_id, compatibility_hash, phase,
          global_pages, global_verify_pages, folder_pages, membership_folder_ordinal,
          membership_pages, coverage_scope, window_boundary_algorithm_version,
          started_at, updated_at
        ) VALUES (?, ?, ?, ?, 'global', 0, 0, 0, 0, 0, ?, ?, ?, ?)
      `).run(
        account,
        randomUUID(),
        providerUserId,
        compatibilityHash,
        coverageScope,
        windowBoundaryAlgorithmVersion,
        now,
        now,
      );
    }
    return { progress: this.progress(account), warnings };
  }

  progress(accountValue: string): XBookmarksReconcileProgress {
    const account = requireAccount(accountValue);
    const row = this.requireRun(account);
    const counts = this.stagedCounts(account);
    return {
      runId: row.run_id,
      phase: requirePhase(row.phase),
      ...(row.global_next_token ? { globalNextToken: row.global_next_token } : {}),
      globalPages: row.global_pages,
      ...(row.global_verify_next_token
        ? { globalVerifyNextToken: row.global_verify_next_token }
        : {}),
      globalVerifyPages: row.global_verify_pages,
      globalVerifyItemsStaged: counts.verifyPosts,
      ...(row.post_retry_page_size !== null
        ? { postRetryPageSize: requirePageSize(row.post_retry_page_size) }
        : {}),
      ...(row.folder_next_token ? { folderNextToken: row.folder_next_token } : {}),
      folderPages: row.folder_pages,
      membershipFolderOrdinal: row.membership_folder_ordinal,
      ...(row.membership_next_token ? { membershipNextToken: row.membership_next_token } : {}),
      membershipPages: row.membership_pages,
      itemsStaged: counts.posts,
      foldersStaged: counts.folders,
      membershipsStaged: counts.memberships,
      folderPostsAbsentFromGlobal: row.folder_posts_absent_from_global,
      globalRemovalAuthoritative: row.global_removal_authoritative === 1,
      globalVerificationMatched: row.global_verification_matches === 1,
      coverageScope: requireCoverageScope(row.coverage_scope),
      windowBoundaryVerified: row.window_boundary_verified === 1,
      globalBoundarySettled: Boolean(row.global_boundary_fingerprint_sha256),
      folderInventoryAuthoritative: row.folder_inventory_authoritative === 1,
      folderInventoryCoverageGaps: Number(row.folder_inventory_authoritative !== 1),
      foldersCarriedForward: this.foldersCarriedForwardCount(account),
      folderMembershipCoverageGaps: this.folderCoverageGapCount(account),
      folderProviderOutage: row.folder_provider_outage === 1,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    };
  }

  recordProviderPageRequest(accountValue: string, requestedSizeValue: number): void {
    const account = requireAccount(accountValue);
    const requestedSize = requirePageSize(requestedSizeValue);
    const column = requestedSize === 80
      ? 'page_size_80_requests'
      : requestedSize === 50
        ? 'page_size_50_requests'
        : requestedSize === 20
          ? 'page_size_20_requests'
          : 'page_size_other_requests';
    const updated = this.db.query(`
      UPDATE x_reconcile_runs SET ${column} = ${column} + 1 WHERE account_id = ?
    `).run(account);
    if (updated.changes !== 1) {
      throw new Error('X reconciliation provider request has no active staged run.');
    }
  }

  recordTruncationRetry(input: {
    account: string;
    runId: string;
    phase: 'global' | 'global_verify';
    expectedToken?: string;
    nextPageSize: number;
  }): number {
    const account = requireAccount(input.account);
    const runId = boundedRequired(input.runId, 128, 'X reconciliation run id');
    const expectedToken = optionalToken(input.expectedToken);
    const nextPageSize = requirePageSize(input.nextPageSize);
    const cursorColumn = input.phase === 'global'
      ? 'global_next_token'
      : 'global_verify_next_token';
    const updated = this.db.query(`
      UPDATE x_reconcile_runs
      SET truncation_retries = truncation_retries + 1,
        post_retry_page_size = CASE
          WHEN post_retry_page_size IS NULL THEN ?
          ELSE MIN(post_retry_page_size, ?)
        END
      WHERE account_id = ? AND run_id = ? AND phase = ?
        AND ${cursorColumn} IS ?
      RETURNING post_retry_page_size
    `).get(
      nextPageSize,
      nextPageSize,
      account,
      runId,
      input.phase,
      expectedToken ?? null,
    ) as { post_retry_page_size: number } | null;
    if (!updated) {
      throw new Error('X reconciliation truncation retry scope changed before persistence.');
    }
    return requirePageSize(updated.post_retry_page_size);
  }

  recordGlobalPage(input: {
    account: string;
    expectedToken?: string;
    page: XBookmarkPostPage;
    requestedSize: number;
    limits: XBookmarksReconcileLimits;
    settledAt?: Date;
  }): XBookmarksReconcileProgress {
    const account = requireAccount(input.account);
    const limits = requireLimits(input.limits);
    const settledAt = validDate(input.settledAt ?? new Date()).toISOString();
    const expectedToken = optionalToken(input.expectedToken);
    const nextToken = optionalToken(input.page.nextToken);
    const posts = requirePostPage(input.page.posts);
    const requestedSize = requirePageSize(input.requestedSize);

    this.db.transaction(() => {
      const row = this.requireRun(account);
      assertExpectedPage(row.phase, 'global', row.global_next_token, expectedToken);
      if (row.global_pages >= limits.maxPagesPerScope) throw new ReconcileStageLimitError('global_pages');
      this.assertFreshNextToken(account, 'global', '', expectedToken, nextToken);
      const pageIds = new Set<string>();
      let duplicateGlobalIdentity = false;
      for (const post of posts) {
        if (pageIds.has(post.id) || this.db.query(`
          SELECT 1 AS present FROM x_reconcile_stage_posts
          WHERE account_id = ? AND post_id = ? AND is_global = 1
        `).get(account, post.id)) duplicateGlobalIdentity = true;
        pageIds.add(post.id);
      }
      this.stagePosts(account, posts, true);
      const counts = this.stagedCounts(account);
      if (counts.posts > limits.maxItems) throw new ReconcileStageLimitError('items');
      const naturalWindowBoundaryFingerprint = !nextToken && row.coverage_scope === 'recency_window'
        ? terminalWindowBoundaryFingerprint({
            algorithmVersion: row.window_boundary_algorithm_version,
            traversalDigestSha256: this.globalTraversalDigest(account, false),
            traversalCardinality: this.globalObservedCount(account),
          })
        : undefined;
      this.db.query(`
        UPDATE x_reconcile_runs
        SET phase = ?, global_next_token = ?, global_pages = global_pages + 1,
          post_retry_page_size = NULL,
          global_boundary_fingerprint_sha256 = COALESCE(?, global_boundary_fingerprint_sha256),
          global_removal_authoritative = CASE
            WHEN ? = 1 THEN 0 ELSE global_removal_authoritative END,
          updated_at = ?
        WHERE account_id = ?
      `).run(
        nextToken ? 'global' : 'global_verify',
        nextToken ?? null,
        naturalWindowBoundaryFingerprint ?? null,
        Number(
          isAmbiguousGlobalTerminalWindow(requestedSize, posts.length, nextToken)
          || duplicateGlobalIdentity,
        ),
        settledAt,
        account,
      );
    })();
    return this.progress(account);
  }

  recordGlobalWindowBoundary(input: {
    account: string;
    expectedToken: string;
    boundaryFingerprintSha256: string;
    algorithmVersion: number;
    settledAt?: Date;
  }): XBookmarksReconcileProgress {
    const account = requireAccount(input.account);
    const expectedToken = optionalToken(input.expectedToken);
    if (!expectedToken) {
      throw new ReconcileWindowBoundaryMismatchError('root_boundary');
    }
    const boundaryFingerprintSha256 = normalizeRequiredSha256(
      input.boundaryFingerprintSha256,
      'X provider window boundary fingerprint',
    );
    const algorithmVersion = boundedPositive(
      input.algorithmVersion,
      1_000_000,
      'window boundary algorithm version',
    );
    const settledAt = validDate(input.settledAt ?? new Date()).toISOString();
    this.db.transaction(() => {
      const row = this.requireRun(account);
      // A settled boundary is spent. Re-entering this step would rewind a run
      // whose verification pass is already underway back to an unverified
      // boundary, which is how an interrupted run used to wedge itself past
      // every retry. Refusing as a classified drift routes it into staged
      // recovery instead of a bare provider_temporary loop.
      if (row.phase !== 'global' || row.global_boundary_fingerprint_sha256) {
        throw new ReconcileWindowBoundaryMismatchError('boundary_already_consumed');
      }
      assertExpectedPage(row.phase, 'global', row.global_next_token, expectedToken);
      if (row.global_pages < 1 || !row.global_next_token) {
        throw new ReconcileWindowBoundaryMismatchError('root_boundary');
      }
      this.db.query(`
        UPDATE x_reconcile_runs
        SET phase = 'global_verify', global_next_token = NULL,
          post_retry_page_size = NULL,
          coverage_scope = 'recency_window',
          window_boundary_algorithm_version = ?,
          global_boundary_fingerprint_sha256 = ?,
          window_boundary_verified = 0,
          updated_at = ?
        WHERE account_id = ?
      `).run(
        algorithmVersion,
        boundaryFingerprintSha256,
        settledAt,
        account,
      );
    })();
    return this.progress(account);
  }

  recordGlobalVerificationPage(input: {
    account: string;
    expectedToken?: string;
    page: XBookmarkPostPage;
    requestedSize: number;
    limits: XBookmarksReconcileLimits;
    settledAt?: Date;
  }): XBookmarksReconcileProgress {
    const account = requireAccount(input.account);
    const limits = requireLimits(input.limits);
    const settledAt = validDate(input.settledAt ?? new Date()).toISOString();
    const expectedToken = optionalToken(input.expectedToken);
    const nextToken = optionalToken(input.page.nextToken);
    const posts = requirePostPage(input.page.posts);
    const requestedSize = requirePageSize(input.requestedSize);

    this.db.transaction(() => {
      const row = this.requireRun(account);
      assertExpectedPage(
        row.phase,
        'global_verify',
        row.global_verify_next_token,
        expectedToken,
      );
      if (row.global_verify_pages >= limits.maxPagesPerScope) {
        throw new ReconcileStageLimitError('global_verify_pages');
      }
      this.assertFreshNextToken(account, 'global_verify', '', expectedToken, nextToken);
      const startOrdinal = this.stagedCounts(account).verifyPosts;
      let matches = true;
      posts.forEach((post, index) => {
        const ordinal = startOrdinal + index;
        const expected = this.db.query(`
          SELECT post_id FROM x_reconcile_stage_posts
          WHERE account_id = ? AND is_global = 1 AND ordinal = ?
        `).get(account, ordinal) as { post_id: string } | null;
        if (expected?.post_id !== post.id) matches = false;
        const inserted = this.db.query(`
          INSERT OR IGNORE INTO x_reconcile_stage_verify_posts (
            account_id, post_id, ordinal
          ) VALUES (?, ?, ?)
        `).run(account, post.id, ordinal);
        if (inserted.changes !== 1) matches = false;
      });
      const verifyCount = this.stagedCounts(account).verifyPosts;
      if (verifyCount > limits.maxItems) throw new ReconcileStageLimitError('items');
      if (!nextToken && verifyCount !== this.globalObservedCount(account)) matches = false;
      if (isAmbiguousGlobalTerminalWindow(requestedSize, posts.length, nextToken)) matches = false;
      let naturalWindowBoundaryVerified = false;
      if (!nextToken && row.coverage_scope === 'recency_window') {
        const verificationFingerprint = terminalWindowBoundaryFingerprint({
          algorithmVersion: row.window_boundary_algorithm_version,
          traversalDigestSha256: this.globalTraversalDigest(account, true),
          traversalCardinality: verifyCount,
        });
        naturalWindowBoundaryVerified = matches
          && row.global_boundary_fingerprint_sha256 === verificationFingerprint;
        if (!naturalWindowBoundaryVerified) {
          throw new ReconcileWindowBoundaryMismatchError('mixed_termination');
        }
      }
      this.db.query(`
        UPDATE x_reconcile_runs
        SET phase = ?, global_verify_next_token = ?,
          global_verify_pages = global_verify_pages + 1,
          post_retry_page_size = NULL,
          window_boundary_verified = CASE
            WHEN ? = 1 THEN 1 ELSE window_boundary_verified END,
          global_verification_matches = CASE
            WHEN ? = 1 THEN global_verification_matches ELSE 0 END,
          global_removal_authoritative = CASE
            WHEN ? = 1 THEN global_removal_authoritative ELSE 0 END,
          updated_at = ?
        WHERE account_id = ?
      `).run(
        nextToken ? 'global_verify' : 'folders',
        nextToken ?? null,
        Number(naturalWindowBoundaryVerified),
        Number(matches),
        Number(matches),
        settledAt,
        account,
      );
    })();
    return this.progress(account);
  }

  recordGlobalVerificationWindowBoundary(input: {
    account: string;
    expectedToken: string;
    boundaryFingerprintSha256: string;
    algorithmVersion: number;
    settledAt?: Date;
  }): XBookmarksReconcileProgress {
    const account = requireAccount(input.account);
    const expectedToken = optionalToken(input.expectedToken);
    if (!expectedToken) {
      throw new ReconcileWindowBoundaryMismatchError('root_boundary');
    }
    const boundaryFingerprintSha256 = normalizeRequiredSha256(
      input.boundaryFingerprintSha256,
      'X provider window boundary fingerprint',
    );
    const algorithmVersion = boundedPositive(
      input.algorithmVersion,
      1_000_000,
      'window boundary algorithm version',
    );
    const settledAt = validDate(input.settledAt ?? new Date()).toISOString();
    this.db.transaction(() => {
      const row = this.requireRun(account);
      // Same spent-step rule as the rich boundary: once the verification
      // boundary is proven the run has left this position for good.
      if (row.phase !== 'global_verify' || row.window_boundary_verified === 1) {
        throw new ReconcileWindowBoundaryMismatchError('boundary_already_consumed');
      }
      assertExpectedPage(
        row.phase,
        'global_verify',
        row.global_verify_next_token,
        expectedToken,
      );
      const counts = this.stagedCounts(account);
      const traversalDigest = this.globalTraversalDigest(account, false);
      const verificationDigest = this.globalTraversalDigest(account, true);
      const matchingBoundary =
        row.coverage_scope === 'recency_window'
        && row.window_boundary_algorithm_version === algorithmVersion
        && row.global_boundary_fingerprint_sha256 === boundaryFingerprintSha256;
      const matchingTraversal =
        row.global_verification_matches === 1
        && counts.verifyPosts === this.globalObservedCount(account)
        && traversalDigest === verificationDigest;
      if (
        row.global_verify_pages < 1
        || !row.global_verify_next_token
        || !matchingBoundary
        || !matchingTraversal
      ) {
        throw new ReconcileWindowBoundaryMismatchError('mixed_or_inconsistent');
      }
      this.db.query(`
        UPDATE x_reconcile_runs
        SET phase = 'folders', global_verify_next_token = NULL,
          post_retry_page_size = NULL,
          window_boundary_verified = 1,
          updated_at = ?
        WHERE account_id = ?
      `).run(settledAt, account);
    })();
    return this.progress(account);
  }

  recordFolderPage(input: {
    account: string;
    expectedToken?: string;
    page: XBookmarkFolderPage;
    requestedSize: number;
    limits: XBookmarksReconcileLimits;
    settledAt?: Date;
  }): XBookmarksReconcileProgress {
    const account = requireAccount(input.account);
    const limits = requireLimits(input.limits);
    const settledAt = validDate(input.settledAt ?? new Date()).toISOString();
    const expectedToken = optionalToken(input.expectedToken);
    const nextToken = optionalToken(input.page.nextToken);
    const folders = requireFolderPage(input.page.folders);
    const requestedSize = requirePageSize(input.requestedSize);

    this.db.transaction(() => {
      const row = this.requireRun(account);
      assertExpectedPage(row.phase, 'folders', row.folder_next_token, expectedToken);
      if (row.folder_pages >= limits.maxPagesPerScope) throw new ReconcileStageLimitError('folder_pages');
      this.assertFreshNextToken(account, 'folders', '', expectedToken, nextToken);
      const pageIds = new Set<string>();
      let duplicateInventoryIdentity = false;
      for (const folder of folders) {
        if (pageIds.has(folder.id) || this.db.query(`
          SELECT 1 AS present FROM x_reconcile_stage_folders
          WHERE account_id = ? AND folder_id = ?
        `).get(account, folder.id)) {
          duplicateInventoryIdentity = true;
        }
        pageIds.add(folder.id);
      }
      this.stageFolders(account, folders);
      const counts = this.stagedCounts(account);
      if (counts.folders > limits.maxFolders) throw new ReconcileStageLimitError('folders');
      const ambiguousTerminalWindow = isAmbiguousTerminalWindow(
        requestedSize,
        folders.length,
        nextToken,
      );
      const inventoryAmbiguous = ambiguousTerminalWindow
        || duplicateInventoryIdentity
        || row.folder_inventory_authoritative !== 1;
      if (!nextToken && inventoryAmbiguous) this.carryForwardUnseenFolders(account);
      this.db.query(`
        UPDATE x_reconcile_runs
        SET phase = ?, folder_next_token = ?, folder_pages = folder_pages + 1,
          folder_inventory_authoritative = CASE
            WHEN ? = 1 THEN 0 ELSE folder_inventory_authoritative END,
          membership_folder_ordinal = CASE WHEN ? IS NULL THEN 0 ELSE membership_folder_ordinal END,
          membership_next_token = CASE WHEN ? IS NULL THEN NULL ELSE membership_next_token END,
          membership_pages = CASE WHEN ? IS NULL THEN 0 ELSE membership_pages END,
          updated_at = ?
        WHERE account_id = ?
      `).run(
        nextToken ? 'folders' : 'memberships',
        nextToken ?? null,
        Number(ambiguousTerminalWindow || duplicateInventoryIdentity),
        nextToken ?? null,
        nextToken ?? null,
        nextToken ?? null,
        settledAt,
        account,
      );
    })();
    return this.progress(account);
  }

  nextMembershipFolder(accountValue: string): XBookmarkFolder | undefined {
    const account = requireAccount(accountValue);
    return this.db.transaction(() => {
      let row = this.requireRun(account);
      if (row.phase !== 'memberships') return undefined;
      while (true) {
        const folder = this.db.query(`
          SELECT folder_id, name, inventory_carried_forward
          FROM x_reconcile_stage_folders
          WHERE account_id = ? AND ordinal = ?
        `).get(account, row.membership_folder_ordinal) as FolderRow | null;
        if (!folder) return undefined;
        if (folder.inventory_carried_forward !== 1) {
          return { id: folder.folder_id, name: folder.name };
        }
        // An unseen folder carried through an ambiguous inventory window has
        // no provider traversal authority of its own. Its still-current
        // memberships were copied when inventory closed, so skip the provider
        // endpoint instead of turning a likely 404 into a failed reconcile.
        this.db.query(`
          UPDATE x_reconcile_runs
          SET membership_folder_ordinal = membership_folder_ordinal + 1,
            membership_next_token = NULL, membership_pages = 0
          WHERE account_id = ?
        `).run(account);
        row = this.requireRun(account);
      }
    })();
  }

  recordMembershipPage(input: {
    account: string;
    folderId: string;
    expectedToken?: string;
    page: XBookmarkPostPage;
    requestedSize: number;
    limits: XBookmarksReconcileLimits;
    settledAt?: Date;
  }): XBookmarksReconcileProgress {
    const account = requireAccount(input.account);
    const limits = requireLimits(input.limits);
    const folderId = boundedRequired(input.folderId, MAX_FOLDER_ID_LENGTH, 'folder id');
    const settledAt = validDate(input.settledAt ?? new Date()).toISOString();
    const expectedToken = optionalToken(input.expectedToken);
    const nextToken = optionalToken(input.page.nextToken);
    const posts = requirePostPage(input.page.posts);
    const requestedSize = requirePageSize(input.requestedSize);

    this.db.transaction(() => {
      const row = this.requireRun(account);
      assertExpectedPage(row.phase, 'memberships', row.membership_next_token, expectedToken);
      const folder = this.db.query(`
        SELECT folder_id, name, membership_ambiguous
        FROM x_reconcile_stage_folders
        WHERE account_id = ? AND ordinal = ?
      `).get(account, row.membership_folder_ordinal) as FolderRow | null;
      if (!folder || folder.folder_id !== folderId) {
        throw new Error('X reconciliation membership page does not match the staged folder ordinal.');
      }
      if (row.membership_pages >= limits.maxPagesPerScope) {
        throw new ReconcileStageLimitError('membership_pages');
      }
      this.assertFreshNextToken(account, 'membership', folderId, expectedToken, nextToken);
      let absentFromGlobal = 0;
      let duplicateMembershipIdentity = false;
      const pageIds = new Set<string>();
      for (const post of posts) {
        if (pageIds.has(post.id)) duplicateMembershipIdentity = true;
        pageIds.add(post.id);
        const global = this.db.query(`
          SELECT is_global FROM x_reconcile_stage_posts
          WHERE account_id = ? AND post_id = ?
        `).get(account, post.id) as { is_global: number } | null;
        if (global?.is_global !== 1) {
          absentFromGlobal += 1;
          continue;
        }
        const inserted = this.db.query(`
          INSERT OR IGNORE INTO x_reconcile_stage_memberships (account_id, folder_id, post_id)
          VALUES (?, ?, ?)
        `).run(account, folderId, post.id);
        if (inserted.changes !== 1) duplicateMembershipIdentity = true;
      }
      const counts = this.stagedCounts(account);
      if (counts.posts > limits.maxItems) throw new ReconcileStageLimitError('items');
      const ambiguousSilentWindow = isAmbiguousTerminalWindow(
        requestedSize,
        posts.length,
        nextToken,
      );
      const membershipAmbiguous = ambiguousSilentWindow
        || duplicateMembershipIdentity
        || folder.membership_ambiguous === 1;
      this.db.query(`
        UPDATE x_reconcile_stage_folders
        SET membership_last_requested = ?, membership_last_returned = ?,
          membership_token_exhausted = ?, membership_ambiguous = ?
        WHERE account_id = ? AND folder_id = ?
      `).run(
        requestedSize,
        posts.length,
        Number(!nextToken),
        Number(membershipAmbiguous),
        account,
        folderId,
      );
      if (membershipAmbiguous) {
        // Carry forward only memberships for posts still present in the new
        // global snapshot. A silent 20-item folder window is not deletion
        // evidence for older membership rows.
        this.db.query(`
          INSERT OR IGNORE INTO x_reconcile_stage_memberships (account_id, folder_id, post_id)
          SELECT old.account_id, old.folder_id, old.post_id
          FROM x_reconcile_completed_memberships old
          JOIN x_reconcile_stage_posts current
            ON current.account_id = old.account_id
            AND current.post_id = old.post_id
            AND current.is_global = 1
          WHERE old.account_id = ? AND old.folder_id = ?
        `).run(account, folderId);
      }
      this.db.query(`
        UPDATE x_reconcile_runs
        SET membership_folder_ordinal = membership_folder_ordinal + ?,
          membership_next_token = ?,
          membership_pages = CASE WHEN ? IS NULL THEN 0 ELSE membership_pages + 1 END,
          folder_posts_absent_from_global = folder_posts_absent_from_global + ?,
          updated_at = ?
        WHERE account_id = ?
      `).run(
        nextToken ? 0 : 1,
        nextToken ?? null,
        nextToken ?? null,
        absentFromGlobal,
        settledAt,
        account,
      );
    })();
    return this.progress(account);
  }

  traversalComplete(accountValue: string): boolean {
    const account = requireAccount(accountValue);
    const row = this.requireRun(account);
    if (row.phase !== 'memberships' || row.membership_next_token) return false;
    return row.membership_folder_ordinal >= this.stagedCounts(account).folders;
  }

  /**
   * Completes only the folder dimension as degraded after a provider 5xx/429.
   * The already matched global proof stays staged and authoritative; partial
   * folder pages are discarded before the last completed folder baseline is
   * carried forward. No baseline means there is no honest degraded completion.
   */
  completeFolderTraversalFromBaseline(
    accountValue: string,
    completedAt = new Date(),
  ): XBookmarksReconcileProgress | undefined {
    const account = requireAccount(accountValue);
    const settledAt = validDate(completedAt).toISOString();
    const completed = this.completedSnapshotRow(account);
    if (!completed) return undefined;
    const eligible = this.db.transaction(() => {
      const row = this.requireRun(account);
      if (row.phase !== 'folders' && row.phase !== 'memberships') return false;
      const counts = this.stagedCounts(account);
      const globalCount = this.globalObservedCount(account);
      const globalProofGreen =
        row.global_pages > 0
        && row.global_verify_pages > 0
        && row.global_removal_authoritative === 1
        && row.global_verification_matches === 1
        && counts.verifyPosts === globalCount
        && this.globalTraversalDigest(account, false)
          === this.globalTraversalDigest(account, true)
        && (
          row.coverage_scope !== 'recency_window'
          || row.window_boundary_verified === 1
        );
      if (!globalProofGreen) return false;

      // Discard every partial folder observation, including private cursor
      // evidence, while retaining the independently proven global pages.
      this.db.query(
        'DELETE FROM x_reconcile_stage_memberships WHERE account_id = ?',
      ).run(account);
      this.db.query(
        'DELETE FROM x_reconcile_stage_folders WHERE account_id = ?',
      ).run(account);
      this.db.query(`
        DELETE FROM x_reconcile_stage_tokens
        WHERE account_id = ? AND scope_kind IN ('folders', 'membership')
      `).run(account);

      this.db.query(`
        INSERT INTO x_reconcile_stage_folders (
          account_id, folder_id, name, ordinal,
          membership_last_requested, membership_last_returned,
          membership_token_exhausted, membership_ambiguous,
          inventory_carried_forward
        )
        SELECT account_id, folder_id, name, ordinal,
          membership_last_requested, membership_last_returned,
          membership_token_exhausted, 1, 1
        FROM x_reconcile_completed_folders
        WHERE account_id = ?
        ORDER BY ordinal ASC
      `).run(account);
      this.db.query(`
        INSERT INTO x_reconcile_stage_memberships (account_id, folder_id, post_id)
        SELECT old.account_id, old.folder_id, old.post_id
        FROM x_reconcile_completed_memberships old
        JOIN x_reconcile_stage_posts current
          ON current.account_id = old.account_id
          AND current.post_id = old.post_id
          AND current.is_global = 1
        WHERE old.account_id = ?
      `).run(account);
      const carried = this.stagedCounts(account);
      this.db.query(`
        UPDATE x_reconcile_runs
        SET phase = 'memberships',
          folder_next_token = NULL,
          folder_pages = 0,
          membership_folder_ordinal = ?,
          membership_next_token = NULL,
          membership_pages = 0,
          folder_posts_absent_from_global = 0,
          folder_inventory_authoritative = 0,
          folder_provider_outage = 1,
          failure_class = NULL,
          failure_count = 0,
          failed_at = NULL,
          updated_at = ?
        WHERE account_id = ?
      `).run(carried.folders, settledAt, account);
      return true;
    })();
    return eligible ? this.progress(account) : undefined;
  }

  promoteCompletedSnapshot(
    accountValue: string,
    completedAt = new Date(),
    options: { preservationFloorAuthorizationSha256?: string } = {},
  ): XBookmarksCompletedReconcileSnapshot {
    const account = requireAccount(accountValue);
    const completed = validDate(completedAt).toISOString();
    this.db.transaction(() => {
      if (!this.traversalComplete(account)) {
        throw new Error('X reconciliation cannot promote an incomplete staged traversal.');
      }
      const run = this.requireRun(account);
      if (Date.parse(completed) < Date.parse(run.started_at)) {
        throw new Error('X reconciliation completion cannot precede its immutable observation cutoff.');
      }
      const providerCounts = this.stagedCounts(account);
      const providerFoldersObserved = providerCounts.folders - this.foldersCarriedForwardCount(account);
      const floor = this.preservationFloorAssessment(account);
      if (floor.status === 'authorization_required') {
        const supplied = normalizeOptionalSha256(
          options.preservationFloorAuthorizationSha256,
          'X preservation-floor authorization',
        );
        if (supplied !== floor.requiredAuthorizationSha256) {
          throw new ReconcilePreservationFloorError(floor);
        }
      }
      const inWindowRemovedPosts = this.recencyWindowRemovalPosts(account);
      // The window proof is a statement about the PROVIDER traversal, so it is
      // settled before the degraded carry-forward appends anything — the same
      // pre-carry convention `providerCounts` already follows. Carried rows are
      // by construction absent from the verification traversal, so judging the
      // proof after the carry would fail every degraded run and leave the lane
      // retrying a stage that can never promote.
      const coverageScope = requireCoverageScope(run.coverage_scope);
      const traversalDigestSha256 = this.globalTraversalDigest(account, false);
      const verificationDigestSha256 = this.globalTraversalDigest(account, true);
      const traversalCardinality = this.globalObservedCount(account);
      const verificationCardinality = providerCounts.verifyPosts;
      if (
        coverageScope === 'recency_window'
        && (
          run.window_boundary_verified !== 1
          || traversalDigestSha256 !== verificationDigestSha256
          || traversalCardinality !== verificationCardinality
        )
      ) {
        throw new ReconcileWindowBoundaryMismatchError('unverified_promotion');
      }
      if (run.global_removal_authoritative !== 1) {
        this.carryForwardDegradedGlobalBaseline(account);
      }
      const counts = this.stagedCounts(account);
      const folderCoverageGaps = this.folderCoverageGapCount(account);
      const foldersCarriedForward = this.foldersCarriedForwardCount(account);
      const checkpointRow = this.db.query(`
        SELECT post_id FROM x_reconcile_stage_posts
        WHERE account_id = ?
        ORDER BY is_global DESC, ordinal ASC
        LIMIT 1
      `).get(account) as { post_id: string } | null;

      this.db.query('DELETE FROM x_reconcile_completed_memberships WHERE account_id = ?').run(account);
      this.db.query('DELETE FROM x_reconcile_completed_posts WHERE account_id = ?').run(account);
      this.db.query('DELETE FROM x_reconcile_completed_folders WHERE account_id = ?').run(account);
      this.db.query('DELETE FROM x_reconcile_completed_snapshots WHERE account_id = ?').run(account);
      this.db.query(`
        INSERT INTO x_reconcile_completed_snapshots (
          account_id, observed_at, completed_at, provider_user_id, snapshot_kind,
          application_status, checkpoint, items_seen, folders_seen,
          memberships_seen, folder_posts_absent_from_global,
          global_removal_authoritative, folder_inventory_authoritative,
          global_verification_matched,
          coverage_scope, window_boundary_verified,
          window_boundary_algorithm_version,
          traversal_digest_sha256, traversal_cardinality,
          verification_digest_sha256, verification_cardinality,
          page_size_80_requests, page_size_50_requests,
          page_size_20_requests, page_size_other_requests, truncation_retries,
          folder_inventory_coverage_gaps, folders_carried_forward,
          folder_membership_coverage_gaps, folder_provider_outage
        ) VALUES (
          ?, ?, ?, ?, 'api_reconcile', 'pending', ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        account,
        run.started_at,
        completed,
        run.provider_user_id,
        checkpointRow?.post_id ?? null,
        providerCounts.posts,
        providerFoldersObserved,
        counts.memberships,
        run.folder_posts_absent_from_global,
        run.global_removal_authoritative,
        run.folder_inventory_authoritative,
        run.global_verification_matches,
        coverageScope,
        run.window_boundary_verified,
        run.window_boundary_algorithm_version,
        traversalDigestSha256,
        traversalCardinality,
        verificationDigestSha256,
        verificationCardinality,
        run.page_size_80_requests,
        run.page_size_50_requests,
        run.page_size_20_requests,
        run.page_size_other_requests,
        run.truncation_retries,
        Number(run.folder_inventory_authoritative !== 1),
        foldersCarriedForward,
        folderCoverageGaps,
        run.folder_provider_outage,
      );
      this.db.query(`
        INSERT INTO x_reconcile_completed_posts (account_id, post_id, post_json, ordinal, is_global)
        SELECT account_id, post_id, post_json, ordinal, is_global
        FROM x_reconcile_stage_posts WHERE account_id = ?
      `).run(account);
      this.db.query(`
        INSERT INTO x_reconcile_completed_folders (
          account_id, folder_id, name, ordinal, membership_last_requested,
          membership_last_returned, membership_token_exhausted,
          membership_ambiguous, inventory_carried_forward
        )
        SELECT account_id, folder_id, name, ordinal, membership_last_requested,
          membership_last_returned, membership_token_exhausted,
          membership_ambiguous, inventory_carried_forward
        FROM x_reconcile_stage_folders WHERE account_id = ?
      `).run(account);
      this.db.query(`
        INSERT INTO x_reconcile_completed_memberships (account_id, folder_id, post_id)
        SELECT account_id, folder_id, post_id
        FROM x_reconcile_stage_memberships WHERE account_id = ?
      `).run(account);
      inWindowRemovedPosts.forEach((post, ordinal) => {
        this.db.query(`
          INSERT INTO x_reconcile_completed_window_removals (
            account_id, post_id, post_json, ordinal
          ) VALUES (?, ?, ?, ?)
        `).run(account, post.id, JSON.stringify(post), ordinal);
      });
      // Re-observation spends the debt. A post that is present in the snapshot
      // this promotion is installing is bookmarked NOW on the provider's own
      // authority, which outranks any older absence proof still owed against
      // it. The debt table is otherwise untouched here — it is deliberately not
      // a child of the snapshot row, so the cascade above cannot take it.
      this.db.query(`
        DELETE FROM x_reconcile_deferred_window_removals
        WHERE account_id = ?
          AND post_id IN (SELECT post_id FROM x_reconcile_completed_posts WHERE account_id = ?)
      `).run(account, account);
      this.db.query('DELETE FROM x_reconcile_runs WHERE account_id = ?').run(account);
    })();
    return this.completedSnapshot(account)!;
  }

  preservationFloorAssessment(
    accountValue: string,
    authorizationSha256?: string,
  ): XBookmarksPreservationFloorAssessment {
    const account = requireAccount(accountValue);
    if (!this.traversalComplete(account)) {
      throw new Error('X preservation floor requires a complete staged traversal.');
    }
    const coverageScope = requireCoverageScope(this.requireRun(account).coverage_scope);
    const proposedItems = this.globalObservedCount(account);
    const prior = this.db.query(`
      SELECT snapshot_kind, items_seen, coverage_scope,
        window_boundary_verified, traversal_cardinality
      FROM x_reconcile_completed_snapshots
      WHERE account_id = ?
    `).get(account) as {
      snapshot_kind: 'legacy_replay' | 'api_reconcile';
      items_seen: number;
      coverage_scope: string;
      window_boundary_verified: number;
      traversal_cardinality: number;
    } | null;
    const priorComparable = prior?.snapshot_kind === 'api_reconcile'
      && requireCoverageScope(prior.coverage_scope) === coverageScope
      && (coverageScope !== 'recency_window' || prior.window_boundary_verified === 1);
    const priorItems = priorComparable
      ? coverageScope === 'recency_window'
        ? prior.traversal_cardinality
        : prior.items_seen
      : 0;
    const priorSnapshotSha256 = this.completedBaselineDigest(account);
    const proposedSnapshotSha256 = this.stagedProposedSnapshotDigest(account);
    const allowance = Math.max(
      PRESERVATION_FLOOR_MIN_UNREVIEWED_REMOVALS,
      Math.floor(
        priorItems * PRESERVATION_FLOOR_MAX_UNREVIEWED_REMOVAL_BPS / 10_000,
      ),
    );
    const minimumRetainedItems = priorComparable && priorItems > 0
      ? Math.max(1, priorItems - allowance)
      : 0;
    const requiredAuthorizationSha256 = sha256Json({
      kind: 'x_preservation_floor_authorization_v2',
      account_sha256: sha256Json(account),
      coverage_scope: coverageScope,
      prior_snapshot_sha256: priorSnapshotSha256,
      proposed_snapshot_sha256: proposedSnapshotSha256,
      prior_items: priorItems,
      proposed_items: proposedItems,
      minimum_retained_items: minimumRetainedItems,
    });
    const supplied = normalizeOptionalSha256(
      authorizationSha256,
      'X preservation-floor authorization',
    );
    const crossesFloor = priorComparable
      && priorItems > 0
      && proposedItems < minimumRetainedItems;
    return {
      status: !priorComparable
        ? 'not_applicable'
        : !crossesFloor
          ? 'green'
          : supplied === requiredAuthorizationSha256
            ? 'authorized'
            : 'authorization_required',
      priorItems,
      proposedItems,
      minimumRetainedItems,
      priorSnapshotSha256,
      proposedSnapshotSha256,
      requiredAuthorizationSha256,
    };
  }

  completedSnapshot(accountValue: string): XBookmarksCompletedReconcileSnapshot | undefined {
    const account = requireAccount(accountValue);
    const snapshot = this.db.query(`
      SELECT observed_at, completed_at, applied_at, snapshot_kind,
        checkpoint, items_seen, folders_seen, memberships_seen,
        folder_posts_absent_from_global,
        application_status,
        global_removal_authoritative, folder_inventory_authoritative,
        global_verification_matched,
        coverage_scope, window_boundary_verified,
        window_boundary_algorithm_version,
        traversal_digest_sha256, traversal_cardinality,
        verification_digest_sha256, verification_cardinality,
        page_size_80_requests, page_size_50_requests,
        page_size_20_requests, page_size_other_requests, truncation_retries,
        folder_inventory_coverage_gaps, folders_carried_forward,
        folder_membership_coverage_gaps, folder_provider_outage
      FROM x_reconcile_completed_snapshots
      WHERE account_id = ?
    `).get(account) as {
      observed_at: string;
      completed_at: string;
      applied_at: string | null;
      snapshot_kind: 'legacy_replay' | 'api_reconcile';
      application_status: 'pending' | 'applied' | 'degraded';
      checkpoint: string | null;
      items_seen: number;
      folders_seen: number;
      memberships_seen: number;
      folder_posts_absent_from_global: number;
      global_removal_authoritative: number;
      folder_inventory_authoritative: number;
      global_verification_matched: number;
      coverage_scope: string;
      window_boundary_verified: number;
      window_boundary_algorithm_version: number;
      traversal_digest_sha256: string;
      traversal_cardinality: number;
      verification_digest_sha256: string;
      verification_cardinality: number;
      page_size_80_requests: number;
      page_size_50_requests: number;
      page_size_20_requests: number;
      page_size_other_requests: number;
      truncation_retries: number;
      folder_inventory_coverage_gaps: number;
      folders_carried_forward: number;
      folder_membership_coverage_gaps: number;
      folder_provider_outage: number;
    } | null;
    if (!snapshot) return undefined;
    const postRows = this.db.query(`
      SELECT post_id, post_json FROM x_reconcile_completed_posts
      WHERE account_id = ? ORDER BY ordinal ASC
    `).all(account) as PostRow[];
    const folderRows = this.db.query(`
      SELECT folder_id, name FROM x_reconcile_completed_folders
      WHERE account_id = ? ORDER BY ordinal ASC
    `).all(account) as FolderRow[];
    const membershipRows = this.db.query(`
      SELECT folder_id, post_id FROM x_reconcile_completed_memberships
      WHERE account_id = ? ORDER BY folder_id ASC, post_id ASC
    `).all(account) as MembershipRow[];
    const removalRows = this.db.query(`
      SELECT post_id, post_json FROM x_reconcile_completed_window_removals
      WHERE account_id = ? ORDER BY ordinal ASC
    `).all(account) as PostRow[];
    // Read alongside the snapshot rather than from it: the debt deliberately
    // outlives the snapshot that incurred it, which is the whole point.
    const deferredRows = this.db.query(`
      SELECT post_id FROM x_reconcile_deferred_window_removals
      WHERE account_id = ? ORDER BY first_deferred_at ASC, post_id ASC
    `).all(account) as Array<{ post_id: string }>;
    const posts = postRows.map((row) => parseStagedPost(row.post_json, row.post_id));
    const inWindowRemovedPosts = removalRows.map((row) =>
      parseStagedPost(row.post_json, row.post_id));
    const folders = folderRows.map((row) => ({ id: row.folder_id, name: row.name }));
    this.validateCompletedSnapshot(account, snapshot, postRows, folderRows, membershipRows);
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    const foldersByPostId = new Map<string, XBookmarkFolderIdentity[]>();
    for (const membership of membershipRows) {
      const folder = folderById.get(membership.folder_id);
      if (!folder) throw new Error('X completed reconciliation contains an orphaned folder membership.');
      if (!postRows.some((post) => post.post_id === membership.post_id)) {
        throw new Error('X completed reconciliation contains an orphaned post membership.');
      }
      const memberships = foldersByPostId.get(membership.post_id) ?? [];
      memberships.push(folder);
      foldersByPostId.set(membership.post_id, memberships);
    }
    return {
      snapshotObservedAt: snapshot.observed_at,
      completedAt: snapshot.completed_at,
      ...(snapshot.applied_at ? { appliedAt: snapshot.applied_at } : {}),
      applicationStatus: snapshot.application_status,
      itemsObserved: snapshot.items_seen,
      foldersObserved: snapshot.folders_seen,
      posts,
      inWindowRemovedPosts,
      deferredWindowRemovalPostIds: deferredRows.map((row) => row.post_id),
      folders,
      foldersByPostId,
      ...(snapshot.checkpoint ? { checkpoint: snapshot.checkpoint } : {}),
      folderPostsAbsentFromGlobal: snapshot.folder_posts_absent_from_global,
      globalRemovalAuthoritative: snapshot.global_removal_authoritative === 1,
      globalVerificationMatched: snapshot.global_verification_matched === 1,
      coverageScope: requireCoverageScope(snapshot.coverage_scope),
      windowBoundaryVerified: snapshot.window_boundary_verified === 1,
      windowBoundaryAlgorithmVersion: snapshot.window_boundary_algorithm_version,
      traversalDigestSha256: snapshot.traversal_digest_sha256,
      traversalCardinality: snapshot.traversal_cardinality,
      verificationDigestSha256: snapshot.verification_digest_sha256,
      verificationCardinality: snapshot.verification_cardinality,
      pageSize80Requests: snapshot.page_size_80_requests,
      pageSize50Requests: snapshot.page_size_50_requests,
      pageSize20Requests: snapshot.page_size_20_requests,
      pageSizeOtherRequests: snapshot.page_size_other_requests,
      truncationRetries: snapshot.truncation_retries,
      folderInventoryAuthoritative: snapshot.folder_inventory_authoritative === 1,
      folderInventoryCoverageGaps: snapshot.folder_inventory_coverage_gaps,
      foldersCarriedForward: snapshot.folders_carried_forward,
      folderMembershipCoverageGaps: snapshot.folder_membership_coverage_gaps,
      folderProviderOutage: snapshot.folder_provider_outage === 1,
      completeReconciliationAuthoritative:
        snapshot.global_removal_authoritative === 1
        && snapshot.global_verification_matched === 1
        && snapshot.folder_inventory_authoritative === 1
        && snapshot.folder_membership_coverage_gaps === 0,
      globalCurrentAuthority:
        snapshot.global_removal_authoritative === 1
        && snapshot.global_verification_matched === 1
          ? 'green'
          : 'degraded',
      folderProvenance:
        snapshot.folder_inventory_authoritative === 1
        && snapshot.folder_membership_coverage_gaps === 0
          ? 'green'
          : 'degraded',
      stagedRecovery: this.lastRecoveryRow(account) ? 'completed' : 'not_needed',
    };
  }

  /** Internal proof/repair accessor. Never return this through admin status. */
  completedFolderInventory(accountValue: string): XBookmarkFolder[] {
    return this.completedSnapshot(accountValue)?.folders ?? [];
  }

  pendingCompletedSnapshot(
    accountValue: string,
    providerUserIdValue: string,
  ): XBookmarksCompletedReconcileSnapshot | undefined {
    const account = requireAccount(accountValue);
    const providerUserId = boundedRequired(
      providerUserIdValue,
      MAX_PROVIDER_USER_ID_LENGTH,
      'provider user id',
    );
    const row = this.completedSnapshotRow(account);
    if (row?.snapshot_kind !== 'api_reconcile'
      || row.application_status !== 'pending'
      || row.provider_user_id !== providerUserId) return undefined;
    return this.completedSnapshot(account);
  }

  /**
   * Move a completed snapshot off `pending` and settle, in the SAME
   * transaction, the removal debt that disposition reports on.
   *
   * The two are one durable fact. `pending` is the only state that makes a
   * promoted snapshot replayable — `acquireReconciliation` re-presents a
   * pending snapshot's removals instead of traversing again — so a disposition
   * that commits alone has already spent the replay while the removals the
   * store declined are still unrecorded. The next traversal then promotes over
   * the baseline and cascade-deletes the completed window removals, and a
   * prior-present/current-absent transition that can never be derived again is
   * gone. Committed together, a crash before the commit leaves the snapshot
   * pending and the whole pass replays.
   */
  markCompletedSnapshotDisposition(
    accountValue: string,
    completedAtValue: string,
    disposition: 'applied' | 'degraded',
    appliedAtValue = new Date(),
    settlement?: XBookmarksWindowRemovalSettlement,
  ): XBookmarksWindowRemovalDebtOutcome {
    const account = requireAccount(accountValue);
    const completedAt = validDate(new Date(completedAtValue)).toISOString();
    const appliedAt = validDate(appliedAtValue).toISOString();
    const settled = settlement
      ? {
        presented: [...settlement.presentedPostIds],
        deferred: [...settlement.deferredPostIds],
        observedAt: validDate(new Date(settlement.observedAt)).toISOString(),
      }
      : undefined;
    return this.db.transaction(() => {
      const updated = this.db.query(`
        UPDATE x_reconcile_completed_snapshots
        SET application_status = ?, applied_at = ?
        WHERE account_id = ? AND completed_at = ?
          AND snapshot_kind = 'api_reconcile' AND application_status = 'pending'
      `).run(disposition, appliedAt, account, completedAt);
      if (updated.changes !== 1) {
        throw new Error('X reconciliation completed snapshot disposition no longer matches pending state.');
      }
      const counts = settled
        ? this.settleWindowRemovalDebtRows(account, {
          presentedPostIds: settled.presented,
          deferredPostIds: settled.deferred,
          observedAt: settled.observedAt,
          at: appliedAt,
        })
        : { carried: 0, spent: 0 };
      return { ...counts, ...this.windowRemovalDebtStanding(account) };
    })();
  }

  /**
   * Settle one application pass's window-removal debt.
   *
   * `presented` is every removal this pass handed the shared store — freshly
   * derived plus everything carried forward. `deferred` is the subset the store
   * declined because an owner had been observed at or after the cutoff. The
   * difference between them is settled: applied, refused on the standing
   * preservation-authority ground, or already gone. So a presented id leaves
   * the debt table unless it comes back deferred, and a deferred id is written
   * or refreshed with the cutoff it most recently failed against.
   *
   * The application path does NOT call this: it settles through
   * `markCompletedSnapshotDisposition`, which commits the settlement with the
   * disposition so neither can survive the other. This verb is the direct
   * repair/proof seam for the settlement rules themselves.
   */
  settleWindowRemovalDebt(
    accountValue: string,
    input: {
      presentedPostIds: readonly string[];
      deferredPostIds: readonly string[];
      observedAt: string;
      at?: Date;
    },
  ): XBookmarksWindowRemovalDebtOutcome {
    const account = requireAccount(accountValue);
    const observedAt = validDate(new Date(input.observedAt)).toISOString();
    const at = validDate(input.at ?? new Date()).toISOString();
    return this.db.transaction(() => {
      const counts = this.settleWindowRemovalDebtRows(account, {
        presentedPostIds: input.presentedPostIds,
        deferredPostIds: input.deferredPostIds,
        observedAt,
        at,
      });
      return { ...counts, ...this.windowRemovalDebtStanding(account) };
    })();
  }

  /**
   * Written as a replace over the PRESENTED set rather than a blind insert, so
   * a pass that carries an id forward and then applies it clears the debt in
   * the same transaction that recorded the attempt. Ids that were not presented
   * (a pass that could not run the window branch at all) are left standing
   * rather than silently forgiven.
   *
   * Caller-transactional on purpose: the disposition this settles is committed
   * with it or not at all.
   */
  private settleWindowRemovalDebtRows(
    account: string,
    input: {
      presentedPostIds: readonly string[];
      deferredPostIds: readonly string[];
      observedAt: string;
      at: string;
    },
  ): { carried: number; spent: number } {
    const presented = [...new Set(input.presentedPostIds)];
    const deferred = new Set(input.deferredPostIds);
    // A store that defers an id nobody presented is answering about a different
    // question; recording it as debt would invent an absence proof this pass
    // never had.
    const carried = presented.filter((postId) => deferred.has(postId));
    const settled = presented.filter((postId) => !deferred.has(postId));
    for (const postId of settled) {
      this.db.query(`
        DELETE FROM x_reconcile_deferred_window_removals
        WHERE account_id = ? AND post_id = ?
      `).run(account, postId);
    }
    // Only the still-deferred ids are written, and the upsert keeps the
    // ORIGINAL first_deferred_at: how long a removal has been owed is the
    // signal an operator needs, and deleting the row first would reset it on
    // every pass and make an ancient debt look new.
    for (const postId of carried) {
      this.db.query(`
        INSERT INTO x_reconcile_deferred_window_removals (
          account_id, post_id, first_deferred_at, last_deferred_at,
          deferred_against_observed_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, post_id) DO UPDATE SET
          last_deferred_at = excluded.last_deferred_at,
          deferred_against_observed_at = excluded.deferred_against_observed_at
      `).run(account, postId, input.at, input.at, input.observedAt);
    }
    return { carried: carried.length, spent: presented.length - carried.length };
  }

  /**
   * What is still owed, read after the settlement that produced it. The age
   * columns existed with no reader, which is how an indefinitely standing debt
   * stayed invisible to every receipt.
   */
  private windowRemovalDebtStanding(
    account: string,
  ): { standing: number; oldestFirstDeferredAt?: string } {
    const row = this.db.query(`
      SELECT COUNT(*) AS standing, MIN(first_deferred_at) AS oldest_first_deferred_at
      FROM x_reconcile_deferred_window_removals
      WHERE account_id = ?
    `).get(account) as { standing: number; oldest_first_deferred_at: string | null };
    return {
      standing: row.standing,
      ...(row.oldest_first_deferred_at
        ? { oldestFirstDeferredAt: row.oldest_first_deferred_at }
        : {}),
    };
  }
  recordStagedFailure(
    accountValue: string,
    failureClass: XBookmarksStagedFailureClass,
    failedAt = new Date(),
  ): XBookmarksStagedRecoveryStatus {
    const account = requireAccount(accountValue);
    const at = validDate(failedAt).toISOString();
    const updated = this.db.query(`
      UPDATE x_reconcile_runs
      SET failure_count = CASE WHEN failure_class = ? THEN failure_count + 1 ELSE 1 END,
        failure_class = ?, failed_at = ?, updated_at = ?
      WHERE account_id = ?
    `).run(failureClass, failureClass, at, at, account);
    if (updated.changes !== 1) {
      throw new Error('X reconciliation staged failure cannot be recorded without an active run.');
    }
    return this.stagedRecoveryStatus(account, failedAt);
  }

  stagedRecoveryStatus(
    accountValue: string,
    inspectedAt = new Date(),
  ): XBookmarksStagedRecoveryStatus {
    const account = requireAccount(accountValue);
    const now = validDate(inspectedAt);
    const row = this.runRow(account);
    const lastRecovery = this.lastRecoveryRow(account);
    const policy = recoveryPolicy();
    if (!row) {
      return {
        staged: false,
        staged_recovery: lastRecovery ? 'completed' : 'not_needed',
        ...(lastRecovery
          ? { last_recovery_receipt_sha256: lastRecovery.receipt_sha256 }
          : {}),
        policy,
      };
    }
    const counts = this.stagedCounts(account);
    const failureClass = optionalFailureClass(row.failure_class);
    const recoveryEligible = failureClass === 'invalid_or_expired_cursor'
      || failureClass === 'deleted_scope'
      || failureClass === 'window_boundary_drift';
    return {
      staged: true,
      staged_recovery: lastRecovery ? 'completed' : 'not_needed',
      phase: requirePhase(row.phase),
      staged_age_ms: Math.max(0, now.getTime() - Date.parse(row.started_at)),
      page_counts: {
        global: row.global_pages,
        global_verify: row.global_verify_pages,
        folders: row.folder_pages,
        memberships: row.membership_pages,
      },
      staged_counts: {
        posts: counts.posts,
        folders: counts.folders,
        memberships: counts.memberships,
      },
      ...(failureClass ? { failure_class: failureClass } : {}),
      failure_count: row.failure_count,
      recovery_eligible: recoveryEligible,
      automatic_recovery_ready: recoveryEligible && row.failure_count >= 2,
      staged_digest_sha256: this.stagedDigest(account, row, counts),
      ...(lastRecovery
        ? { last_recovery_receipt_sha256: lastRecovery.receipt_sha256 }
        : {}),
      policy,
    };
  }

  recoverStagedRun(input: {
    account: string;
    expectedStagedDigestSha256: string;
    mode: 'automatic' | 'operator';
    recoveredAt?: Date;
  }): XBookmarksStagedRecoveryReceipt {
    const account = requireAccount(input.account);
    const status = this.stagedRecoveryStatus(account, input.recoveredAt ?? new Date());
    if (!status.staged || !status.staged_digest_sha256 || !status.page_counts || !status.staged_counts) {
      throw new Error('X reconciliation has no staged run to recover.');
    }
    if (input.expectedStagedDigestSha256 !== status.staged_digest_sha256) {
      throw new Error('X reconciliation staged recovery digest no longer matches.');
    }
    if (input.mode === 'automatic' && !status.automatic_recovery_ready) {
      throw new Error('X reconciliation staged run is not eligible for automatic recovery.');
    }
    const recoveredAt = validDate(input.recoveredAt ?? new Date()).toISOString();
    const completedBaselineSha256 = this.completedBaselineDigest(account);
    const receiptWithoutDigest = {
      staged_recovery: 'completed' as const,
      recovery_mode: input.mode,
      ...(status.failure_class ? { failure_class: status.failure_class } : {}),
      pages_cleared: Object.values(status.page_counts).reduce((sum, value) => sum + value, 0),
      staged_posts_cleared: status.staged_counts.posts,
      staged_folders_cleared: status.staged_counts.folders,
      staged_memberships_cleared: status.staged_counts.memberships,
      completed_baseline_preserved: true as const,
      staged_digest_sha256: status.staged_digest_sha256,
      completed_baseline_sha256: completedBaselineSha256,
      recovered_at: recoveredAt,
      policy: recoveryPolicy(),
    };
    const receiptSha256 = sha256Json(receiptWithoutDigest);
    this.db.transaction(() => {
      const current = this.stagedRecoveryStatus(account, new Date(recoveredAt));
      if (current.staged_digest_sha256 !== input.expectedStagedDigestSha256) {
        throw new Error('X reconciliation staged recovery digest changed before deletion.');
      }
      if (!this.deleteStagedRun(account)) {
        throw new Error('X reconciliation staged run changed before recovery.');
      }
      if (this.completedBaselineDigest(account) !== completedBaselineSha256) {
        throw new Error('X reconciliation completed baseline changed during staged recovery.');
      }
      this.db.query(`
        INSERT INTO x_reconcile_recovery_receipts (
          account_id, recovered_at, recovery_mode, failure_class,
          staged_digest_sha256, completed_baseline_sha256, receipt_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          recovered_at = excluded.recovered_at,
          recovery_mode = excluded.recovery_mode,
          failure_class = excluded.failure_class,
          staged_digest_sha256 = excluded.staged_digest_sha256,
          completed_baseline_sha256 = excluded.completed_baseline_sha256,
          receipt_sha256 = excluded.receipt_sha256
      `).run(
        account,
        recoveredAt,
        input.mode,
        status.failure_class ?? null,
        status.staged_digest_sha256!,
        completedBaselineSha256,
        receiptSha256,
      );
    })();
    return { ...receiptWithoutDigest, receipt_sha256: receiptSha256 };
  }

  /**
   * Destructive provider-account migration boundary. This is deliberately not
   * the staged-run recovery verb because it deletes the completed baseline.
   */
  resetAccountState(
    accountValue: string,
    confirmation: 'provider_account_migration',
  ): boolean {
    if (confirmation !== 'provider_account_migration') {
      throw new Error('X account-state reset requires provider-account migration confirmation.');
    }
    const account = requireAccount(accountValue);
    return this.db.transaction(() => {
      const staged = this.deleteStagedRun(account);
      const completed = this.deleteCompletedSnapshot(account);
      const recovery = this.db.query(
        'DELETE FROM x_reconcile_recovery_receipts WHERE account_id = ?',
      ).run(account).changes > 0;
      // The debt is deliberately not a cascade child of the snapshot, because
      // it has to outlive promotion. That is why it must be deleted BY NAME
      // here: every standing row is an absence this account proved against the
      // provider user being migrated away from, and re-presenting it under the
      // new one would tombstone a live item on a retired account's evidence.
      const debt = this.db.query(
        'DELETE FROM x_reconcile_deferred_window_removals WHERE account_id = ?',
      ).run(account).changes > 0;
      return staged || completed || recovery || debt;
    })();
  }

  /**
   * Explicitly discards only the folder-facet refresh checkpoint. This is the
   * recovery verb named by the embedding-provider fingerprint refusal; it
   * does not delete reconciliation baselines, staged provider state, or
   * recovery receipts.
   */
  resetFolderFacetRefresh(
    accountValue: string,
    confirmation: 'embedding_provider_migration',
  ): boolean {
    if (confirmation !== 'embedding_provider_migration') {
      throw new Error(
        'resetFolderFacetRefresh requires embedding-provider migration confirmation.',
      );
    }
    const account = requireAccount(accountValue);
    return this.db.query(
      'DELETE FROM x_folder_facet_refresh_progress WHERE account_id = ?',
    ).run(account).changes > 0;
  }

  private stagePosts(account: string, posts: readonly XBookmarkPost[], isGlobal: boolean): void {
    let ordinal = (this.db.query(`
      SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
      FROM x_reconcile_stage_posts WHERE account_id = ?
    `).get(account) as { next_ordinal: number }).next_ordinal;
    for (const post of posts) {
      const postJson = JSON.stringify(post);
      if (Buffer.byteLength(postJson, 'utf8') > MAX_POST_JSON_BYTES) {
        throw new TypeError('X bookmark post exceeds the reconciliation staging bound.');
      }
      const existing = this.db.query(`
        SELECT ordinal, is_global FROM x_reconcile_stage_posts
        WHERE account_id = ? AND post_id = ?
      `).get(account, post.id) as { ordinal: number; is_global: number } | null;
      if (existing) {
        if (existing.is_global === 1 && !isGlobal) {
          // Folder membership endpoints may return an id-only copy of a post
          // already fetched richly from the global endpoint. Folder traversal
          // owns membership only; it must never erase the richer record.
          continue;
        }
        this.db.query(`
          UPDATE x_reconcile_stage_posts
          SET post_json = ?, is_global = ?
          WHERE account_id = ? AND post_id = ?
        `).run(postJson, Number(isGlobal || existing.is_global === 1), account, post.id);
      } else {
        this.db.query(`
          INSERT INTO x_reconcile_stage_posts (
            account_id, post_id, post_json, ordinal, is_global
          ) VALUES (?, ?, ?, ?, ?)
        `).run(account, post.id, postJson, ordinal, Number(isGlobal));
        ordinal += 1;
      }
    }
  }

  private stageFolders(account: string, folders: readonly XBookmarkFolder[]): void {
    let ordinal = (this.db.query(`
      SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
      FROM x_reconcile_stage_folders WHERE account_id = ?
    `).get(account) as { next_ordinal: number }).next_ordinal;
    for (const folder of folders) {
      const existing = this.db.query(`
        SELECT ordinal FROM x_reconcile_stage_folders
        WHERE account_id = ? AND folder_id = ?
      `).get(account, folder.id) as { ordinal: number } | null;
      if (existing) {
        this.db.query(`
          UPDATE x_reconcile_stage_folders SET name = ?
          WHERE account_id = ? AND folder_id = ?
        `).run(folder.name, account, folder.id);
      } else {
        this.db.query(`
          INSERT INTO x_reconcile_stage_folders (account_id, folder_id, name, ordinal)
          VALUES (?, ?, ?, ?)
        `).run(account, folder.id, folder.name, ordinal);
        ordinal += 1;
      }
    }
  }

  private carryForwardUnseenFolders(account: string): void {
    let ordinal = (this.db.query(`
      SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
      FROM x_reconcile_stage_folders WHERE account_id = ?
    `).get(account) as { next_ordinal: number }).next_ordinal;
    const prior = this.db.query(`
      SELECT old.folder_id, old.name
      FROM x_reconcile_completed_folders old
      WHERE old.account_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM x_reconcile_stage_folders current
          WHERE current.account_id = old.account_id
            AND current.folder_id = old.folder_id
        )
      ORDER BY old.ordinal ASC
    `).all(account) as FolderRow[];
    for (const folder of prior) {
      this.db.query(`
        INSERT INTO x_reconcile_stage_folders (
          account_id, folder_id, name, ordinal, inventory_carried_forward
        ) VALUES (?, ?, ?, ?, 1)
      `).run(account, folder.folder_id, folder.name, ordinal);
      ordinal += 1;
      this.db.query(`
        INSERT OR IGNORE INTO x_reconcile_stage_memberships (account_id, folder_id, post_id)
        SELECT old.account_id, old.folder_id, old.post_id
        FROM x_reconcile_completed_memberships old
        JOIN x_reconcile_stage_posts current
          ON current.account_id = old.account_id
          AND current.post_id = old.post_id
          AND current.is_global = 1
        WHERE old.account_id = ? AND old.folder_id = ?
      `).run(account, folder.folder_id);
    }
  }

  private carryForwardDegradedGlobalBaseline(account: string): void {
    let postOrdinal = (this.db.query(`
      SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
      FROM x_reconcile_stage_posts WHERE account_id = ?
    `).get(account) as { next_ordinal: number }).next_ordinal;
    const oldPosts = this.db.query(`
      SELECT post_id, post_json
      FROM x_reconcile_completed_posts old
      WHERE old.account_id = ? AND NOT EXISTS (
        SELECT 1 FROM x_reconcile_stage_posts current
        WHERE current.account_id = old.account_id AND current.post_id = old.post_id
      )
      ORDER BY old.ordinal ASC
    `).all(account) as PostRow[];
    for (const post of oldPosts) {
      this.db.query(`
        INSERT INTO x_reconcile_stage_posts (
          account_id, post_id, post_json, ordinal, is_global
        ) VALUES (?, ?, ?, ?, 1)
      `).run(account, post.post_id, post.post_json, postOrdinal);
      postOrdinal += 1;
    }

    let folderOrdinal = (this.db.query(`
      SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
      FROM x_reconcile_stage_folders WHERE account_id = ?
    `).get(account) as { next_ordinal: number }).next_ordinal;
    const oldFolders = this.db.query(`
      SELECT folder_id, name, inventory_carried_forward
      FROM x_reconcile_completed_folders old
      WHERE old.account_id = ? AND NOT EXISTS (
        SELECT 1 FROM x_reconcile_stage_folders current
        WHERE current.account_id = old.account_id AND current.folder_id = old.folder_id
      )
      ORDER BY old.ordinal ASC
    `).all(account) as FolderRow[];
    for (const folder of oldFolders) {
      this.db.query(`
        INSERT INTO x_reconcile_stage_folders (
          account_id, folder_id, name, ordinal, inventory_carried_forward,
          membership_ambiguous
        ) VALUES (?, ?, ?, ?, 1, 0)
      `).run(account, folder.folder_id, folder.name, folderOrdinal);
      folderOrdinal += 1;
    }
    this.db.query(`
      INSERT OR IGNORE INTO x_reconcile_stage_memberships (account_id, folder_id, post_id)
      SELECT old.account_id, old.folder_id, old.post_id
      FROM x_reconcile_completed_memberships old
      JOIN x_reconcile_stage_posts current_post
        ON current_post.account_id = old.account_id AND current_post.post_id = old.post_id
      JOIN x_reconcile_stage_folders current_folder
        ON current_folder.account_id = old.account_id AND current_folder.folder_id = old.folder_id
      WHERE old.account_id = ?
    `).run(account);
  }

  private validateStagedRun(account: string, row: RunRow, limits: XBookmarksReconcileLimits): void {
    requirePhase(row.phase);
    optionalToken(row.global_next_token ?? undefined);
    optionalToken(row.global_verify_next_token ?? undefined);
    optionalToken(row.folder_next_token ?? undefined);
    optionalToken(row.membership_next_token ?? undefined);
    requireNonNegative(row.global_pages, 'global pages');
    requireNonNegative(row.global_verify_pages, 'global verification pages');
    requireNonNegative(row.folder_pages, 'folder pages');
    requireNonNegative(row.membership_folder_ordinal, 'membership folder ordinal');
    requireNonNegative(row.membership_pages, 'membership pages');
    requireNonNegative(row.folder_posts_absent_from_global, 'folder posts absent from global');
    requireNonNegative(row.failure_count, 'staged failure count');
    requireNonNegative(row.page_size_80_requests, '80-item page requests');
    requireNonNegative(row.page_size_50_requests, '50-item page requests');
    requireNonNegative(row.page_size_20_requests, '20-item page requests');
    requireNonNegative(row.page_size_other_requests, 'other-size page requests');
    requireNonNegative(row.truncation_retries, 'truncation retries');
    if (row.post_retry_page_size !== null) {
      requirePageSize(row.post_retry_page_size);
      if (row.phase !== 'global' && row.phase !== 'global_verify') {
        throw new Error('X reconciliation post retry rung is attached to a non-post phase.');
      }
    }
    optionalFailureClass(row.failure_class);
    if (row.failed_at) validDate(new Date(row.failed_at));
    if (row.global_removal_authoritative !== 0 && row.global_removal_authoritative !== 1) {
      throw new Error('X reconciliation global authority state is corrupt.');
    }
    if (row.global_verification_matches !== 0 && row.global_verification_matches !== 1) {
      throw new Error('X reconciliation global verification state is corrupt.');
    }
    requireCoverageScope(row.coverage_scope);
    if (row.window_boundary_verified !== 0 && row.window_boundary_verified !== 1) {
      throw new Error('X reconciliation window-boundary state is corrupt.');
    }
    requireNonNegative(
      row.window_boundary_algorithm_version,
      'window boundary algorithm version',
    );
    if (row.global_boundary_fingerprint_sha256 !== null) {
      normalizeRequiredSha256(
        row.global_boundary_fingerprint_sha256,
        'X provider window boundary fingerprint',
      );
    }
    if (row.folder_inventory_authoritative !== 0 && row.folder_inventory_authoritative !== 1) {
      throw new Error('X reconciliation folder inventory authority state is corrupt.');
    }
    if (row.folder_provider_outage !== 0 && row.folder_provider_outage !== 1) {
      throw new Error('X reconciliation folder provider-outage state is corrupt.');
    }
    if (row.global_pages > limits.maxPagesPerScope
      || row.global_verify_pages > limits.maxPagesPerScope
      || row.folder_pages > limits.maxPagesPerScope
      || row.membership_pages > limits.maxPagesPerScope) {
      throw new Error('X reconciliation staged run exceeds configured page bounds.');
    }
    const counts = this.stagedCounts(account);
    if (counts.posts > limits.maxItems || counts.verifyPosts > limits.maxItems
      || counts.folders > limits.maxFolders
      || row.membership_folder_ordinal > counts.folders) {
      throw new Error('X reconciliation staged run exceeds configured inventory bounds.');
    }
    const posts = this.db.query(`
      SELECT post_id, post_json FROM x_reconcile_stage_posts WHERE account_id = ?
    `).all(account) as PostRow[];
    for (const post of posts) parseStagedPost(post.post_json, post.post_id);
    const folders = this.db.query(`
      SELECT folder_id, name FROM x_reconcile_stage_folders WHERE account_id = ?
    `).all(account) as FolderRow[];
    for (const folder of folders) requireFolder({ id: folder.folder_id, name: folder.name });
    const orphanedMemberships = this.db.query(`
      SELECT COUNT(*) AS count
      FROM x_reconcile_stage_memberships membership
      LEFT JOIN x_reconcile_stage_folders folder
        ON folder.account_id = membership.account_id AND folder.folder_id = membership.folder_id
      LEFT JOIN x_reconcile_stage_posts post
        ON post.account_id = membership.account_id AND post.post_id = membership.post_id
      WHERE membership.account_id = ?
        AND (folder.folder_id IS NULL OR post.post_id IS NULL OR post.is_global <> 1)
    `).get(account) as { count: number };
    if (orphanedMemberships.count !== 0) {
      throw new Error('X reconciliation staged memberships are relationally corrupt.');
    }
    assertContiguousOrdinals(this.db, 'x_reconcile_stage_posts', account);
    assertContiguousOrdinals(this.db, 'x_reconcile_stage_folders', account);
    assertContiguousOrdinals(this.db, 'x_reconcile_stage_verify_posts', account);
    if (row.global_verification_matches === 1) {
      const mismatches = this.db.query(`
        SELECT COUNT(*) AS count
        FROM x_reconcile_stage_verify_posts verified
        LEFT JOIN x_reconcile_stage_posts rich
          ON rich.account_id = verified.account_id
          AND rich.ordinal = verified.ordinal
          AND rich.post_id = verified.post_id
          AND rich.is_global = 1
        WHERE verified.account_id = ? AND rich.post_id IS NULL
      `).get(account) as { count: number };
      if (mismatches.count !== 0) {
        throw new Error('X reconciliation staged verification is inconsistent with the rich traversal.');
      }
    }
  }

  private validateCompletedSnapshot(
    account: string,
    snapshot: {
      observed_at: string;
      completed_at: string;
      applied_at: string | null;
      snapshot_kind: 'legacy_replay' | 'api_reconcile';
      checkpoint: string | null;
      items_seen: number;
      folders_seen: number;
      memberships_seen: number;
      global_removal_authoritative: number;
      folder_inventory_authoritative: number;
      global_verification_matched: number;
      coverage_scope: string;
      window_boundary_verified: number;
      window_boundary_algorithm_version: number;
      traversal_digest_sha256: string;
      traversal_cardinality: number;
      verification_digest_sha256: string;
      verification_cardinality: number;
      page_size_80_requests: number;
      page_size_50_requests: number;
      page_size_20_requests: number;
      page_size_other_requests: number;
      truncation_retries: number;
      folder_inventory_coverage_gaps: number;
      folders_carried_forward: number;
      folder_membership_coverage_gaps: number;
      folder_provider_outage: number;
    },
    posts: readonly PostRow[],
    folders: readonly FolderRow[],
    memberships: readonly MembershipRow[],
  ): void {
    validDate(new Date(snapshot.observed_at));
    validDate(new Date(snapshot.completed_at));
    if (snapshot.applied_at) validDate(new Date(snapshot.applied_at));
    for (const [label, value] of Object.entries({
      items_seen: snapshot.items_seen,
      folders_seen: snapshot.folders_seen,
      memberships_seen: snapshot.memberships_seen,
      folder_inventory_coverage_gaps: snapshot.folder_inventory_coverage_gaps,
      folders_carried_forward: snapshot.folders_carried_forward,
      folder_membership_coverage_gaps: snapshot.folder_membership_coverage_gaps,
      traversal_cardinality: snapshot.traversal_cardinality,
      verification_cardinality: snapshot.verification_cardinality,
      window_boundary_algorithm_version: snapshot.window_boundary_algorithm_version,
      page_size_80_requests: snapshot.page_size_80_requests,
      page_size_50_requests: snapshot.page_size_50_requests,
      page_size_20_requests: snapshot.page_size_20_requests,
      page_size_other_requests: snapshot.page_size_other_requests,
      truncation_retries: snapshot.truncation_retries,
    })) requireNonNegative(value, label);
    for (const value of [
      snapshot.global_removal_authoritative,
      snapshot.global_verification_matched,
      snapshot.folder_inventory_authoritative,
      snapshot.window_boundary_verified,
      snapshot.folder_provider_outage,
    ]) {
      if (value !== 0 && value !== 1) {
        throw new Error('X completed reconciliation authority state is corrupt.');
      }
    }
    const coverageScope = requireCoverageScope(snapshot.coverage_scope);
    normalizeRequiredSha256(snapshot.traversal_digest_sha256, 'X traversal digest');
    normalizeRequiredSha256(snapshot.verification_digest_sha256, 'X verification digest');
    if (
      coverageScope === 'recency_window'
      && (
        snapshot.window_boundary_verified !== 1
        || snapshot.window_boundary_algorithm_version < 1
        || snapshot.traversal_digest_sha256 !== snapshot.verification_digest_sha256
        || snapshot.traversal_cardinality !== snapshot.verification_cardinality
        || snapshot.traversal_cardinality !== snapshot.items_seen
      )
    ) {
      throw new Error('X completed reconciliation window-boundary receipt is corrupt.');
    }
    if (memberships.length !== snapshot.memberships_seen) {
      throw new Error('X completed reconciliation membership receipt is corrupt.');
    }
    if (snapshot.snapshot_kind === 'legacy_replay') {
      if (posts.length !== snapshot.items_seen || folders.length !== snapshot.folders_seen) {
        throw new Error('X completed legacy baseline inventory receipt is corrupt.');
      }
    } else {
      if (posts.length < snapshot.items_seen || folders.length < snapshot.folders_seen) {
        throw new Error('X completed reconciliation inventory is smaller than its provider receipt.');
      }
      if (snapshot.global_removal_authoritative === 1 && posts.length !== snapshot.items_seen) {
        throw new Error('X authoritative completed reconciliation post inventory is inconsistent.');
      }
      if (snapshot.global_removal_authoritative === 1
        && snapshot.folder_inventory_authoritative === 1
        && folders.length !== snapshot.folders_seen) {
        throw new Error('X authoritative completed reconciliation folder inventory is inconsistent.');
      }
    }
    const folderGapCount = (this.db.query(`
      SELECT COUNT(*) AS count FROM x_reconcile_completed_folders
      WHERE account_id = ? AND membership_ambiguous = 1
    `).get(account) as { count: number }).count;
    const carriedCount = (this.db.query(`
      SELECT COUNT(*) AS count FROM x_reconcile_completed_folders
      WHERE account_id = ? AND inventory_carried_forward = 1
    `).get(account) as { count: number }).count;
    if (folderGapCount !== snapshot.folder_membership_coverage_gaps
      || carriedCount !== snapshot.folders_carried_forward
      || snapshot.folder_inventory_coverage_gaps !== Number(snapshot.folder_inventory_authoritative !== 1)) {
      throw new Error('X completed reconciliation coverage receipt is corrupt.');
    }
    const orphanedMemberships = this.db.query(`
      SELECT COUNT(*) AS count
      FROM x_reconcile_completed_memberships membership
      LEFT JOIN x_reconcile_completed_folders folder
        ON folder.account_id = membership.account_id AND folder.folder_id = membership.folder_id
      LEFT JOIN x_reconcile_completed_posts post
        ON post.account_id = membership.account_id AND post.post_id = membership.post_id
      WHERE membership.account_id = ?
        AND (folder.folder_id IS NULL OR post.post_id IS NULL OR post.is_global <> 1)
    `).get(account) as { count: number };
    if (orphanedMemberships.count !== 0) {
      throw new Error('X completed reconciliation memberships are relationally corrupt.');
    }
    if (snapshot.checkpoint && !posts.some((post) => post.post_id === snapshot.checkpoint)) {
      throw new Error('X completed reconciliation checkpoint is not in its post inventory.');
    }
    assertContiguousOrdinals(this.db, 'x_reconcile_completed_posts', account);
    assertContiguousOrdinals(this.db, 'x_reconcile_completed_folders', account);
    assertContiguousOrdinals(this.db, 'x_reconcile_completed_window_removals', account);
  }

  private stagedCounts(account: string): {
    posts: number;
    verifyPosts: number;
    folders: number;
    memberships: number;
  } {
    return this.db.query(`
      SELECT
        (SELECT COUNT(*) FROM x_reconcile_stage_posts WHERE account_id = ?) AS posts,
        (SELECT COUNT(*) FROM x_reconcile_stage_verify_posts WHERE account_id = ?) AS verifyPosts,
        (SELECT COUNT(*) FROM x_reconcile_stage_folders WHERE account_id = ?) AS folders,
        (SELECT COUNT(*) FROM x_reconcile_stage_memberships WHERE account_id = ?) AS memberships
    `).get(account, account, account, account) as {
      posts: number;
      verifyPosts: number;
      folders: number;
      memberships: number;
    };
  }

  private globalObservedCount(account: string): number {
    return (this.db.query(`
      SELECT COUNT(*) AS count FROM x_reconcile_stage_posts
      WHERE account_id = ? AND is_global = 1
    `).get(account) as { count: number }).count;
  }

  private recencyWindowRemovalPosts(account: string): XBookmarkPost[] {
    const run = this.requireRun(account);
    if (run.coverage_scope !== 'recency_window'
      || run.window_boundary_verified !== 1
      || run.global_removal_authoritative !== 1
      || run.global_verification_matches !== 1) {
      return [];
    }
    const prior = this.db.query(`
      SELECT snapshot_kind, coverage_scope, window_boundary_verified
      FROM x_reconcile_completed_snapshots WHERE account_id = ?
    `).get(account) as {
      snapshot_kind: 'legacy_replay' | 'api_reconcile';
      coverage_scope: string;
      window_boundary_verified: number;
    } | null;
    if (prior?.snapshot_kind !== 'api_reconcile'
      || prior.coverage_scope !== 'recency_window'
      || prior.window_boundary_verified !== 1) return [];

    const currentOrdinals = new Map((this.db.query(`
      SELECT post_id, ordinal FROM x_reconcile_stage_posts
      WHERE account_id = ? AND is_global = 1 ORDER BY ordinal ASC
    `).all(account) as Array<{ post_id: string; ordinal: number }>)
      .map((row) => [row.post_id, row.ordinal] as const));
    const priorRows = this.db.query(`
      SELECT post_id, post_json, ordinal FROM x_reconcile_completed_posts
      WHERE account_id = ? AND is_global = 1 ORDER BY ordinal ASC
    `).all(account) as Array<PostRow & { ordinal: number }>;
    // Depth is proved by an ORDER-PRESERVING overlap, not by membership. Both
    // traversals run newest-first, so an overlap that sits higher in the
    // current traversal than an overlap above it means the post moved — X
    // orders bookmarks by bookmark time, so re-bookmarking an old post lifts it
    // to the top while it keeps its deep prior ordinal. Membership alone would
    // read that as "the traversal reached its old depth" and condemn every
    // still-bookmarked post the move pushed out of the served window.
    let provenDepth = -1;
    let lastCurrentOrdinal = -1;
    for (const row of priorRows) {
      const currentOrdinal = currentOrdinals.get(row.post_id);
      if (currentOrdinal === undefined) continue;
      if (currentOrdinal <= lastCurrentOrdinal) break;
      provenDepth = row.ordinal;
      lastCurrentOrdinal = currentOrdinal;
    }
    if (provenDepth < 0) return [];
    return priorRows
      .filter((row) => row.ordinal <= provenDepth && !currentOrdinals.has(row.post_id))
      .map((row) => parseStagedPost(row.post_json, row.post_id));
  }

  private folderCoverageGapCount(account: string): number {
    const row = this.db.query(`
      SELECT COUNT(*) AS count FROM x_reconcile_stage_folders
      WHERE account_id = ? AND membership_ambiguous = 1
    `).get(account) as { count: number };
    return row.count;
  }

  private foldersCarriedForwardCount(account: string): number {
    return (this.db.query(`
      SELECT COUNT(*) AS count FROM x_reconcile_stage_folders
      WHERE account_id = ? AND inventory_carried_forward = 1
    `).get(account) as { count: number }).count;
  }

  private assertFreshNextToken(
    account: string,
    scopeKind: 'global' | 'global_verify' | 'folders' | 'membership',
    scopeId: string,
    expectedToken: string | undefined,
    nextToken: string | undefined,
  ): void {
    if (expectedToken) {
      this.db.query(`
        INSERT OR IGNORE INTO x_reconcile_stage_tokens (
          account_id, scope_kind, scope_id, token
        ) VALUES (?, ?, ?, ?)
      `).run(account, scopeKind, scopeId, expectedToken);
    }
    if (nextToken && this.db.query(`
      SELECT 1 AS present FROM x_reconcile_stage_tokens
      WHERE account_id = ? AND scope_kind = ? AND scope_id = ? AND token = ?
    `).get(account, scopeKind, scopeId, nextToken)) {
      throw new ReconcilePaginationCycleError(scopeKind);
    }
  }

  private stagedDigest(
    account: string,
    row: RunRow,
    counts: ReturnType<LocalXBookmarksReconcileStateStore['stagedCounts']>,
  ): string {
    const tokenDigests = this.db.query(`
      SELECT scope_kind, scope_id, token
      FROM x_reconcile_stage_tokens
      WHERE account_id = ?
      ORDER BY scope_kind ASC, scope_id ASC, token ASC
    `).all(account).map((value) => {
      const token = value as { scope_kind: string; scope_id: string; token: string };
      return [token.scope_kind, sha256Json(token.scope_id), sha256Json(token.token)];
    });
    return sha256Json({
      run_id: row.run_id,
      compatibility_hash: row.compatibility_hash,
      phase: row.phase,
      pages: [
        row.global_pages,
        row.global_verify_pages,
        row.folder_pages,
        row.membership_pages,
      ],
      counts,
      failure_class: row.failure_class,
      failure_count: row.failure_count,
      post_retry_page_size: row.post_retry_page_size,
      token_digests: tokenDigests,
    });
  }

  private globalTraversalDigest(account: string, verification: boolean): string {
    const table = verification
      ? 'x_reconcile_stage_verify_posts'
      : 'x_reconcile_stage_posts';
    const filter = verification ? '' : ' AND is_global = 1';
    const rows = this.db.query(`
      SELECT post_id FROM ${table}
      WHERE account_id = ?${filter}
      ORDER BY ordinal ASC
    `).all(account) as Array<{ post_id: string }>;
    return sha256Json(rows.map((row) => row.post_id));
  }

  private stagedProposedSnapshotDigest(account: string): string {
    const run = this.requireRun(account);
    const counts = this.stagedCounts(account);
    return sha256Json({
      kind: 'x_reconcile_proposed_snapshot_v1',
      observed_at: run.started_at,
      authority: {
        global_removal_authoritative: run.global_removal_authoritative,
        global_verification_matched: run.global_verification_matches,
        folder_inventory_authoritative: run.folder_inventory_authoritative,
        folder_provider_outage: run.folder_provider_outage,
      },
      counts,
      posts: this.db.query(`
        SELECT post_id, post_json, ordinal, is_global
        FROM x_reconcile_stage_posts
        WHERE account_id = ?
        ORDER BY ordinal, post_id
      `).all(account),
      folders: this.db.query(`
        SELECT folder_id, name, ordinal, membership_last_requested,
          membership_last_returned, membership_token_exhausted,
          membership_ambiguous, inventory_carried_forward
        FROM x_reconcile_stage_folders
        WHERE account_id = ?
        ORDER BY ordinal, folder_id
      `).all(account),
      memberships: this.db.query(`
        SELECT folder_id, post_id
        FROM x_reconcile_stage_memberships
        WHERE account_id = ?
        ORDER BY folder_id, post_id
      `).all(account),
    });
  }

  private completedBaselineDigest(account: string): string {
    const snapshot = this.completedSnapshotRow(account);
    if (!snapshot) return sha256Json({ baseline: 'absent' });
    const tables = [
      ['posts', 'x_reconcile_completed_posts', 'post_id, post_json, ordinal, is_global'],
      [
        'folders',
        'x_reconcile_completed_folders',
        'folder_id, name, ordinal, membership_last_requested, membership_last_returned, '
          + 'membership_token_exhausted, membership_ambiguous, inventory_carried_forward',
      ],
      ['memberships', 'x_reconcile_completed_memberships', 'folder_id, post_id'],
      [
        'window_removals',
        'x_reconcile_completed_window_removals',
        'post_id, post_json, ordinal',
      ],
    ] as const;
    return sha256Json({
      snapshot,
      rows: tables.map(([label, table, columns]) => ({
        label,
        values: this.db.query(
          `SELECT ${columns} FROM ${table} WHERE account_id = ? ORDER BY 1 ASC, 2 ASC`,
        ).all(account),
      })),
    });
  }

  private lastRecoveryRow(account: string): RecoveryRow | undefined {
    return this.db.query(`
      SELECT receipt_sha256 FROM x_reconcile_recovery_receipts WHERE account_id = ?
    `).get(account) as RecoveryRow | null ?? undefined;
  }

  private completedSnapshotRow(account: string): CompletedSnapshotRow | undefined {
    return this.db.query(`
      SELECT account_id, completed_at, provider_user_id, snapshot_kind,
        application_status, source_receipt_sha256, folder_provider_outage
      FROM x_reconcile_completed_snapshots WHERE account_id = ?
    `).get(account) as CompletedSnapshotRow | null ?? undefined;
  }

  private deleteCompletedSnapshot(account: string): boolean {
    return this.db.query(
      'DELETE FROM x_reconcile_completed_snapshots WHERE account_id = ?',
    ).run(account).changes > 0;
  }

  private runRow(account: string): RunRow | undefined {
    return this.db.query(`
      SELECT account_id, run_id, provider_user_id, compatibility_hash, phase,
        global_next_token, global_pages, folder_next_token, folder_pages,
        global_verify_next_token, global_verify_pages, global_verification_matches,
        membership_folder_ordinal, membership_next_token, membership_pages,
        folder_posts_absent_from_global, global_removal_authoritative,
        folder_inventory_authoritative, coverage_scope,
        window_boundary_verified, window_boundary_algorithm_version,
        global_boundary_fingerprint_sha256,
        page_size_80_requests, page_size_50_requests,
        page_size_20_requests, page_size_other_requests, truncation_retries,
        post_retry_page_size,
        folder_provider_outage,
        failure_class, failure_count, failed_at,
        started_at, updated_at
      FROM x_reconcile_runs WHERE account_id = ?
    `).get(account) as RunRow | null ?? undefined;
  }

  private requireRun(account: string): RunRow {
    const row = this.runRow(account);
    if (!row) throw new Error('X reconciliation staged run is not open.');
    return row;
  }

  private deleteStagedRun(account: string): boolean {
    return this.db.query('DELETE FROM x_reconcile_runs WHERE account_id = ?').run(account).changes > 0;
  }
}

export class ReconcileStageLimitError extends Error {
  readonly limitKind: 'global_pages' | 'global_verify_pages' | 'folder_pages' | 'membership_pages' | 'items' | 'folders';

  constructor(limitKind: ReconcileStageLimitError['limitKind']) {
    super(`X reconciliation stopped at configured ${limitKind} bound.`);
    this.name = 'ReconcileStageLimitError';
    this.limitKind = limitKind;
  }
}

export class ReconcilePaginationCycleError extends Error {
  readonly scopeKind: 'global' | 'global_verify' | 'folders' | 'membership';

  constructor(scopeKind: ReconcilePaginationCycleError['scopeKind']) {
    super(`X reconciliation detected a ${scopeKind} pagination token cycle.`);
    this.name = 'ReconcilePaginationCycleError';
    this.scopeKind = scopeKind;
  }
}

export class ReconcileStagedRecoveryRequiredError extends Error {
  readonly failureClass: 'corrupt_stage' | 'incompatible_stage';

  constructor(failureClass: ReconcileStagedRecoveryRequiredError['failureClass']) {
    super(`X reconciliation ${failureClass} requires explicit staged-run recovery.`);
    this.name = 'ReconcileStagedRecoveryRequiredError';
    this.failureClass = failureClass;
  }
}

export class ReconcilePreservationFloorError extends Error {
  readonly assessment: XBookmarksPreservationFloorAssessment;

  constructor(assessment: XBookmarksPreservationFloorAssessment) {
    super(
      'X reconciliation refused an anomalous provider snapshot below the preservation floor.',
    );
    this.name = 'ReconcilePreservationFloorError';
    this.assessment = assessment;
  }
}

export class ReconcileWindowBoundaryMismatchError extends Error {
  readonly mismatchKind:
    | 'root_boundary'
    | 'boundary_already_consumed'
    | 'mixed_termination'
    | 'mixed_or_inconsistent'
    | 'unverified_promotion';

  constructor(mismatchKind: ReconcileWindowBoundaryMismatchError['mismatchKind']) {
    super('X reconciliation provider-window boundary proof was inconsistent.');
    this.name = 'ReconcileWindowBoundaryMismatchError';
    this.mismatchKind = mismatchKind;
  }
}

interface RunRow {
  account_id: string;
  run_id: string;
  provider_user_id: string;
  compatibility_hash: string;
  phase: string;
  global_next_token: string | null;
  global_pages: number;
  global_verify_next_token: string | null;
  global_verify_pages: number;
  global_verification_matches: number;
  folder_next_token: string | null;
  folder_pages: number;
  membership_folder_ordinal: number;
  membership_next_token: string | null;
  membership_pages: number;
  folder_posts_absent_from_global: number;
  global_removal_authoritative: number;
  folder_inventory_authoritative: number;
  folder_provider_outage: number;
  coverage_scope: string;
  window_boundary_verified: number;
  window_boundary_algorithm_version: number;
  global_boundary_fingerprint_sha256: string | null;
  page_size_80_requests: number;
  page_size_50_requests: number;
  page_size_20_requests: number;
  page_size_other_requests: number;
  truncation_retries: number;
  post_retry_page_size: number | null;
  failure_class: string | null;
  failure_count: number;
  failed_at: string | null;
  started_at: string;
  updated_at: string;
}

interface PostRow { post_id: string; post_json: string }
interface FolderRow {
  folder_id: string;
  name: string;
  inventory_carried_forward: number;
  membership_ambiguous: number;
}
interface MembershipRow { folder_id: string; post_id: string }
interface CompletedSnapshotRow {
  account_id: string;
  completed_at: string;
  provider_user_id: string;
  snapshot_kind: 'legacy_replay' | 'api_reconcile';
  application_status: 'pending' | 'applied' | 'degraded';
  source_receipt_sha256: string | null;
  folder_provider_outage: number;
}
interface RecoveryRow { receipt_sha256: string }

function xBookmarksReconcileStateMigrations(): SqliteMigration[] {
  return [{
    version: 1,
    name: 'create_restart_safe_x_reconcile_state',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS x_reconcile_runs (
          account_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          provider_user_id TEXT NOT NULL,
          compatibility_hash TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('global', 'global_verify', 'folders', 'memberships')),
          global_next_token TEXT,
          global_pages INTEGER NOT NULL,
          global_verify_next_token TEXT,
          global_verify_pages INTEGER NOT NULL DEFAULT 0,
          global_verification_matches INTEGER NOT NULL DEFAULT 1,
          folder_next_token TEXT,
          folder_pages INTEGER NOT NULL,
          membership_folder_ordinal INTEGER NOT NULL,
          membership_next_token TEXT,
          membership_pages INTEGER NOT NULL,
          folder_posts_absent_from_global INTEGER NOT NULL DEFAULT 0,
          global_removal_authoritative INTEGER NOT NULL DEFAULT 1,
          folder_inventory_authoritative INTEGER NOT NULL DEFAULT 1,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS x_reconcile_stage_posts (
          account_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          post_json TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          is_global INTEGER NOT NULL CHECK(is_global IN (0, 1)),
          PRIMARY KEY(account_id, post_id),
          UNIQUE(account_id, ordinal),
          FOREIGN KEY(account_id) REFERENCES x_reconcile_runs(account_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS x_reconcile_stage_verify_posts (
          account_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          PRIMARY KEY(account_id, post_id),
          UNIQUE(account_id, ordinal),
          FOREIGN KEY(account_id) REFERENCES x_reconcile_runs(account_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS x_reconcile_stage_folders (
          account_id TEXT NOT NULL,
          folder_id TEXT NOT NULL,
          name TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          membership_last_requested INTEGER,
          membership_last_returned INTEGER,
          membership_token_exhausted INTEGER NOT NULL DEFAULT 0,
          membership_ambiguous INTEGER NOT NULL DEFAULT 0,
          inventory_carried_forward INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(account_id, folder_id),
          UNIQUE(account_id, ordinal),
          FOREIGN KEY(account_id) REFERENCES x_reconcile_runs(account_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS x_reconcile_stage_memberships (
          account_id TEXT NOT NULL,
          folder_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          PRIMARY KEY(account_id, folder_id, post_id),
          FOREIGN KEY(account_id) REFERENCES x_reconcile_runs(account_id) ON DELETE CASCADE,
          FOREIGN KEY(account_id, folder_id)
            REFERENCES x_reconcile_stage_folders(account_id, folder_id) ON DELETE CASCADE,
          FOREIGN KEY(account_id, post_id)
            REFERENCES x_reconcile_stage_posts(account_id, post_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS x_reconcile_completed_snapshots (
          account_id TEXT PRIMARY KEY,
          observed_at TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          applied_at TEXT,
          provider_user_id TEXT NOT NULL,
          snapshot_kind TEXT NOT NULL CHECK(snapshot_kind IN ('legacy_replay', 'api_reconcile')),
          application_status TEXT NOT NULL CHECK(application_status IN ('pending', 'applied', 'degraded')),
          source_receipt_sha256 TEXT,
          checkpoint TEXT,
          items_seen INTEGER NOT NULL,
          folders_seen INTEGER NOT NULL,
          memberships_seen INTEGER NOT NULL,
          folder_posts_absent_from_global INTEGER NOT NULL DEFAULT 0,
          global_removal_authoritative INTEGER NOT NULL DEFAULT 1,
          global_verification_matched INTEGER NOT NULL DEFAULT 1,
          folder_inventory_authoritative INTEGER NOT NULL DEFAULT 1,
          folder_inventory_coverage_gaps INTEGER NOT NULL DEFAULT 0,
          folders_carried_forward INTEGER NOT NULL DEFAULT 0,
          folder_membership_coverage_gaps INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS x_reconcile_completed_posts (
          account_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          post_json TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          is_global INTEGER NOT NULL CHECK(is_global IN (0, 1)),
          PRIMARY KEY(account_id, post_id),
          UNIQUE(account_id, ordinal),
          FOREIGN KEY(account_id) REFERENCES x_reconcile_completed_snapshots(account_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS x_reconcile_completed_folders (
          account_id TEXT NOT NULL,
          folder_id TEXT NOT NULL,
          name TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          membership_last_requested INTEGER,
          membership_last_returned INTEGER,
          membership_token_exhausted INTEGER NOT NULL DEFAULT 0,
          membership_ambiguous INTEGER NOT NULL DEFAULT 0,
          inventory_carried_forward INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(account_id, folder_id),
          UNIQUE(account_id, ordinal),
          FOREIGN KEY(account_id) REFERENCES x_reconcile_completed_snapshots(account_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS x_reconcile_completed_memberships (
          account_id TEXT NOT NULL,
          folder_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          PRIMARY KEY(account_id, folder_id, post_id),
          FOREIGN KEY(account_id) REFERENCES x_reconcile_completed_snapshots(account_id) ON DELETE CASCADE,
          FOREIGN KEY(account_id, folder_id)
            REFERENCES x_reconcile_completed_folders(account_id, folder_id) ON DELETE CASCADE,
          FOREIGN KEY(account_id, post_id)
            REFERENCES x_reconcile_completed_posts(account_id, post_id) ON DELETE CASCADE
        );
      `);
    },
  }, {
    version: 2,
    name: 'add_guarded_staged_recovery_and_token_cycle_state',
    up(db) {
      db.exec(`
        ALTER TABLE x_reconcile_runs ADD COLUMN failure_class TEXT;
        ALTER TABLE x_reconcile_runs ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_runs ADD COLUMN failed_at TEXT;
        CREATE TABLE x_reconcile_stage_tokens (
          account_id TEXT NOT NULL,
          scope_kind TEXT NOT NULL
            CHECK(scope_kind IN ('global', 'global_verify', 'folders', 'membership')),
          scope_id TEXT NOT NULL,
          token TEXT NOT NULL,
          PRIMARY KEY(account_id, scope_kind, scope_id, token),
          FOREIGN KEY(account_id) REFERENCES x_reconcile_runs(account_id) ON DELETE CASCADE
        );
        CREATE TABLE x_reconcile_recovery_receipts (
          account_id TEXT PRIMARY KEY,
          recovered_at TEXT NOT NULL,
          recovery_mode TEXT NOT NULL CHECK(recovery_mode IN ('automatic', 'operator')),
          failure_class TEXT,
          staged_digest_sha256 TEXT NOT NULL,
          completed_baseline_sha256 TEXT NOT NULL,
          receipt_sha256 TEXT NOT NULL
        );
      `);
    },
  }, {
    version: 3,
    name: 'add_provider_window_boundary_evidence',
    up(db) {
      db.exec(`
        ALTER TABLE x_reconcile_runs
          ADD COLUMN coverage_scope TEXT NOT NULL DEFAULT 'account_snapshot'
          CHECK(coverage_scope IN ('account_snapshot', 'recency_window'));
        ALTER TABLE x_reconcile_runs
          ADD COLUMN window_boundary_verified INTEGER NOT NULL DEFAULT 0
          CHECK(window_boundary_verified IN (0, 1));
        ALTER TABLE x_reconcile_runs
          ADD COLUMN window_boundary_algorithm_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_runs
          ADD COLUMN global_boundary_fingerprint_sha256 TEXT;
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN coverage_scope TEXT NOT NULL DEFAULT 'account_snapshot'
          CHECK(coverage_scope IN ('account_snapshot', 'recency_window'));
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN window_boundary_verified INTEGER NOT NULL DEFAULT 0
          CHECK(window_boundary_verified IN (0, 1));
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN window_boundary_algorithm_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN traversal_digest_sha256 TEXT NOT NULL
          DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN traversal_cardinality INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN verification_digest_sha256 TEXT NOT NULL
          DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN verification_cardinality INTEGER NOT NULL DEFAULT 0;
      `);
    },
  }, {
    version: 4,
    name: 'persist_folder_provider_outage_degradation',
    up(db) {
      db.exec(`
        ALTER TABLE x_reconcile_runs
          ADD COLUMN folder_provider_outage INTEGER NOT NULL DEFAULT 0
          CHECK(folder_provider_outage IN (0, 1));
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN folder_provider_outage INTEGER NOT NULL DEFAULT 0
          CHECK(folder_provider_outage IN (0, 1));
      `);
    },
  }, {
    version: 5,
    name: 'add_folder_facet_refresh_checkpoint',
    up(db) {
      db.exec(`
        CREATE TABLE x_folder_facet_refresh_progress (
          account_id TEXT PRIMARY KEY,
          provider_user_id TEXT NOT NULL,
          source_inventory_sha256 TEXT NOT NULL,
          algorithm_version INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running', 'completed')),
          cursor TEXT,
          items_scanned INTEGER NOT NULL DEFAULT 0,
          items_refreshed INTEGER NOT NULL DEFAULT 0,
          items_unchanged INTEGER NOT NULL DEFAULT 0,
          items_missing INTEGER NOT NULL DEFAULT 0,
          fts_rows_refreshed INTEGER NOT NULL DEFAULT 0,
          chunk_embedding_inputs_invalidated INTEGER NOT NULL DEFAULT 0,
          chunks_embedded INTEGER NOT NULL DEFAULT 0,
          chunks_embedding_current INTEGER NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
      `);
    },
  }, {
    version: 6,
    name: 'add_folder_facet_refresh_run_lease',
    up(db) {
      db.exec(`
        ALTER TABLE x_folder_facet_refresh_progress ADD COLUMN run_token TEXT;
        ALTER TABLE x_folder_facet_refresh_progress ADD COLUMN lease_expires_at TEXT;
      `);
    },
  }, {
    version: 7,
    name: 'bind_folder_facet_provider_and_lease_generation',
    up(db) {
      db.exec(`
        ALTER TABLE x_folder_facet_refresh_progress
          ADD COLUMN embedding_provider_fingerprint_sha256 TEXT;
        ALTER TABLE x_folder_facet_refresh_progress
          ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;
      `);
    },
  }, {
    version: 8,
    name: 'make_folder_facet_authority_generation_non_recyclable',
    up(db) {
      db.exec(`
        CREATE TABLE x_folder_facet_refresh_authority (
          account_id TEXT PRIMARY KEY,
          lease_generation INTEGER NOT NULL CHECK(lease_generation >= 0),
          embedding_provider_fingerprint_sha256 TEXT,
          embedding_invalidation_required INTEGER NOT NULL DEFAULT 0
            CHECK(embedding_invalidation_required IN (0, 1))
        );
        INSERT INTO x_folder_facet_refresh_authority (
          account_id, lease_generation, embedding_provider_fingerprint_sha256,
          embedding_invalidation_required
        )
        SELECT account_id, lease_generation,
          embedding_provider_fingerprint_sha256,
          CASE WHEN status = 'running' THEN 1 ELSE 0 END
        FROM x_folder_facet_refresh_progress;
      `);
    },
  }, {
    version: 9,
    name: 'add_x_recency_window_removals_and_paging_telemetry',
    up(db) {
      db.exec(`
        ALTER TABLE x_reconcile_runs
          ADD COLUMN page_size_80_requests INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_runs
          ADD COLUMN page_size_50_requests INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_runs
          ADD COLUMN page_size_20_requests INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_runs
          ADD COLUMN page_size_other_requests INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_runs
          ADD COLUMN truncation_retries INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN page_size_80_requests INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN page_size_50_requests INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN page_size_20_requests INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN page_size_other_requests INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE x_reconcile_completed_snapshots
          ADD COLUMN truncation_retries INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE x_reconcile_completed_window_removals (
          account_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          post_json TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          PRIMARY KEY(account_id, post_id),
          UNIQUE(account_id, ordinal),
          FOREIGN KEY(account_id)
            REFERENCES x_reconcile_completed_snapshots(account_id) ON DELETE CASCADE
        );
      `);
    },
  }, {
    version: 10,
    name: 'persist_x_reconcile_truncation_retry_rung',
    up(db) {
      db.exec(`
        ALTER TABLE x_reconcile_runs
          ADD COLUMN post_retry_page_size INTEGER
          CHECK(post_retry_page_size BETWEEN 1 AND 100);
      `);
    },
  }, {
    version: 11,
    name: 'carry_deferred_x_window_removals_across_promotion',
    up(db) {
      // Deliberately NOT a child of x_reconcile_completed_snapshots. Every
      // other completed-* table is, and promotion deletes the snapshot row so
      // the cascade empties them — which is exactly what destroyed the only
      // record of a refused removal. A removal transition is offered once; this
      // table is what lets a later, stronger cutoff still spend it.
      db.exec(`
        CREATE TABLE IF NOT EXISTS x_reconcile_deferred_window_removals (
          account_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          first_deferred_at TEXT NOT NULL,
          last_deferred_at TEXT NOT NULL,
          deferred_against_observed_at TEXT NOT NULL,
          PRIMARY KEY(account_id, post_id)
        );
      `);
    },
  }];
}

interface FolderFacetRefreshAuthorityRow {
  lease_generation: number;
  embedding_provider_fingerprint_sha256: string | null;
  embedding_invalidation_required: number;
}

interface FolderFacetRefreshProgressRow {
  account_id: string;
  provider_user_id: string;
  source_inventory_sha256: string;
  embedding_provider_fingerprint_sha256: string | null;
  algorithm_version: number;
  status: string;
  cursor: string | null;
  items_scanned: number;
  items_refreshed: number;
  items_unchanged: number;
  items_missing: number;
  fts_rows_refreshed: number;
  chunk_embedding_inputs_invalidated: number;
  chunks_embedded: number;
  chunks_embedding_current: number;
  run_token: string | null;
  lease_expires_at: string | null;
  lease_generation: number;
}

function folderFacetRefreshProgressFromRow(
  row: FolderFacetRefreshProgressRow,
): XBookmarksFolderFacetRefreshProgress {
  if (row.status !== 'running' && row.status !== 'completed') {
    throw new Error('X folder-facet refresh checkpoint status is corrupt.');
  }
  return {
    status: row.status,
    sourceInventorySha256: normalizeRequiredSha256(
      row.source_inventory_sha256,
      'X folder-facet refresh checkpoint source inventory digest',
    ),
    embeddingProviderFingerprintSha256: normalizeRequiredSha256(
      row.embedding_provider_fingerprint_sha256 ?? '',
      'X folder-facet refresh checkpoint embedding provider fingerprint',
    ),
    algorithmVersion: row.algorithm_version,
    ...(row.cursor ? { cursor: row.cursor } : {}),
    counts: normalizeFolderFacetRefreshCounts({
      itemsScanned: row.items_scanned,
      itemsRefreshed: row.items_refreshed,
      itemsUnchanged: row.items_unchanged,
      itemsMissing: row.items_missing,
      ftsRowsRefreshed: row.fts_rows_refreshed,
      chunkEmbeddingInputsInvalidated: row.chunk_embedding_inputs_invalidated,
      chunksEmbedded: row.chunks_embedded,
      chunksEmbeddingCurrent: row.chunks_embedding_current,
    }),
  };
}

function normalizeFolderFacetRefreshCounts(
  counts: XBookmarksFolderFacetRefreshProgress['counts'],
): XBookmarksFolderFacetRefreshProgress['counts'] {
  return {
    itemsScanned: requireNonNegative(counts.itemsScanned, 'folder-facet items scanned'),
    itemsRefreshed: requireNonNegative(counts.itemsRefreshed, 'folder-facet items refreshed'),
    itemsUnchanged: requireNonNegative(counts.itemsUnchanged, 'folder-facet items unchanged'),
    itemsMissing: requireNonNegative(counts.itemsMissing, 'folder-facet items missing'),
    ftsRowsRefreshed: requireNonNegative(counts.ftsRowsRefreshed, 'folder-facet FTS rows refreshed'),
    chunkEmbeddingInputsInvalidated:
      requireNonNegative(
        counts.chunkEmbeddingInputsInvalidated,
        'folder-facet embedding inputs invalidated',
      ),
    chunksEmbedded: requireNonNegative(counts.chunksEmbedded, 'folder-facet chunks embedded'),
    chunksEmbeddingCurrent:
      requireNonNegative(counts.chunksEmbeddingCurrent, 'folder-facet chunks current'),
  };
}

function reconcileCompatibilityHash(
  limits: XBookmarksReconcileLimits,
  providerUserId: string,
  coverageScope: XBookmarksCoverageScope,
  windowBoundaryAlgorithmVersion: number,
): string {
  return createHash('sha256').update(JSON.stringify({
    algorithm: RECONCILE_ALGORITHM_VERSION,
    providerUserId,
    coverageScope,
    windowBoundaryAlgorithmVersion,
    ...limits,
  })).digest('hex');
}

function optionalFailureClass(value: string | null): XBookmarksStagedFailureClass | undefined {
  if (value === null) return undefined;
  if (value === 'invalid_or_expired_cursor'
    || value === 'deleted_scope'
    || value === 'pagination_cycle'
    || value === 'corrupt_stage'
    || value === 'incompatible_stage'
    || value === 'window_boundary_drift') return value;
  throw new Error('X reconciliation staged failure class is corrupt.');
}

function recoveryPolicy(): XBookmarksStagedRecoveryStatus['policy'] {
  return {
    counts_only: true,
    source_text_returned: false,
    provider_cursor_exposed: false,
  };
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeOptionalSha256(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a SHA-256 digest.`);
  }
  return normalized;
}

function normalizeRequiredSha256(value: string, label: string): string {
  const normalized = normalizeOptionalSha256(value, label);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requireCoverageScope(value: string): XBookmarksCoverageScope {
  if (value === 'account_snapshot' || value === 'recency_window') return value;
  throw new Error('X reconciliation coverage scope is corrupt.');
}

function isAmbiguousTerminalWindow(
  requested: number,
  returned: number,
  nextToken: string | undefined,
): boolean {
  if (nextToken) return false;
  // Folder endpoints have an independent, long-standing silent 20-item cap.
  return !nextToken
    && (
      (returned <= requested && returned >= Math.max(0, requested - 2))
      || (requested > 20 && returned === 20)
    );
}

function isAmbiguousGlobalTerminalWindow(
  requested: number,
  returned: number,
  nextToken: string | undefined,
): boolean {
  return !nextToken
    && returned <= requested
    && returned >= Math.max(0, requested - 2);
}

function terminalWindowBoundaryFingerprint(input: {
  algorithmVersion: number;
  traversalDigestSha256: string;
  traversalCardinality: number;
}): string {
  return sha256Json({
    kind: 'x_recency_window_terminal_boundary',
    algorithm_version: input.algorithmVersion,
    traversal_digest_sha256: normalizeRequiredSha256(
      input.traversalDigestSha256,
      'X terminal-window traversal digest',
    ),
    traversal_cardinality: requireNonNegative(
      input.traversalCardinality,
      'X terminal-window traversal cardinality',
    ),
  });
}

function assertExpectedPage(
  actualPhase: string,
  expectedPhase: XBookmarksReconcilePhase,
  actualToken: string | null,
  expectedToken: string | undefined,
): void {
  if (actualPhase !== expectedPhase || (actualToken ?? undefined) !== expectedToken) {
    throw new Error('X reconciliation staged page no longer matches the persisted traversal position.');
  }
}

function assertContiguousOrdinals(
  db: Database,
  table: 'x_reconcile_stage_posts'
    | 'x_reconcile_stage_folders'
    | 'x_reconcile_stage_verify_posts'
    | 'x_reconcile_completed_posts'
    | 'x_reconcile_completed_folders'
    | 'x_reconcile_completed_window_removals',
  account: string,
): void {
  const row = db.query(`
    SELECT COUNT(*) AS count, MIN(ordinal) AS minimum, MAX(ordinal) AS maximum
    FROM ${table} WHERE account_id = ?
  `).get(account) as { count: number; minimum: number | null; maximum: number | null };
  if (row.count === 0) return;
  if (row.minimum !== 0 || row.maximum !== row.count - 1) {
    throw new Error('X reconciliation inventory ordinals are corrupt.');
  }
}

function requirePostPage(posts: readonly XBookmarkPost[]): XBookmarkPost[] {
  if (!Array.isArray(posts) || posts.length > 100) throw new TypeError('X reconciliation post page is invalid.');
  return posts.map(requirePost);
}

function requirePost(post: XBookmarkPost): XBookmarkPost {
  if (!post || typeof post !== 'object') throw new TypeError('X reconciliation post is invalid.');
  const id = boundedRequired(post.id, MAX_POST_ID_LENGTH, 'post id');
  const normalized: XBookmarkPost = { id };
  for (const field of ['text', 'authorId', 'authorUsername', 'authorName', 'createdAt', 'lang', 'url', 'sourceVersion'] as const) {
    const value = post[field];
    if (value !== undefined) {
      if (typeof value !== 'string') throw new TypeError(`X reconciliation ${field} must be text.`);
      normalized[field] = value;
    }
  }
  if (post.mediaUrls !== undefined) {
    if (!Array.isArray(post.mediaUrls) || post.mediaUrls.some((value) => typeof value !== 'string')) {
      throw new TypeError('X reconciliation media URLs are invalid.');
    }
    normalized.mediaUrls = [...post.mediaUrls];
  }
  if (post.mediaKeys !== undefined) {
    if (!Array.isArray(post.mediaKeys) || post.mediaKeys.some((value) => typeof value !== 'string')) {
      throw new TypeError('X reconciliation media keys are invalid.');
    }
    normalized.mediaKeys = [...post.mediaKeys];
  }
  return normalized;
}

function parseStagedPost(postJson: string, expectedId: string): XBookmarkPost {
  if (Buffer.byteLength(postJson, 'utf8') > MAX_POST_JSON_BYTES) throw new Error('X staged post exceeds its bound.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(postJson);
  } catch {
    throw new Error('X staged post JSON is corrupt.');
  }
  const post = requirePost(parsed as XBookmarkPost);
  if (post.id !== expectedId) throw new Error('X staged post identity is corrupt.');
  return post;
}

function requireFolderPage(folders: readonly XBookmarkFolder[]): XBookmarkFolder[] {
  if (!Array.isArray(folders) || folders.length > 100) throw new TypeError('X reconciliation folder page is invalid.');
  return folders.map(requireFolder);
}

function requireFolder(folder: XBookmarkFolder): XBookmarkFolder {
  if (!folder || typeof folder !== 'object') throw new TypeError('X reconciliation folder is invalid.');
  return {
    id: boundedRequired(folder.id, MAX_FOLDER_ID_LENGTH, 'folder id'),
    name: boundedRequired(folder.name, MAX_FOLDER_NAME_LENGTH, 'folder name'),
  };
}

function requireLimits(value: XBookmarksReconcileLimits): XBookmarksReconcileLimits {
  return {
    maxItems: boundedPositive(value.maxItems, 100_000, 'item limit'),
    maxFolders: boundedPositive(value.maxFolders, 5_000, 'folder limit'),
    maxPagesPerScope: boundedPositive(value.maxPagesPerScope, 5_000, 'page limit'),
    pageSize: boundedPositive(value.pageSize, 100, 'provider page size'),
  };
}

function requirePageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError('X reconciliation provider page size is invalid.');
  }
  return value;
}

function boundedPositive(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`X reconciliation ${label} is invalid.`);
  }
  return value;
}

function requireNonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`X reconciliation ${label} is invalid.`);
  return value;
}

function requirePhase(value: string): XBookmarksReconcilePhase {
  if (value !== 'global' && value !== 'global_verify'
    && value !== 'folders' && value !== 'memberships') {
    throw new TypeError('X reconciliation phase is invalid.');
  }
  return value;
}

function requireAccount(value: string): string {
  return boundedRequired(value, MAX_ACCOUNT_LENGTH, 'account');
}

function boundedRequired(value: string, maxLength: number, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`X reconciliation ${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`X reconciliation ${label} must be bounded and non-empty.`);
  }
  return normalized;
}

function optionalToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return boundedRequired(value, MAX_TOKEN_LENGTH, 'pagination token');
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new TypeError('X reconciliation timestamp must be valid.');
  return value;
}
