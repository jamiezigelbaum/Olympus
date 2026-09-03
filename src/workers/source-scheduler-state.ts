import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  assertSqliteSchemaCanOpen,
  runSqliteMigrations,
  type SqliteMigration,
} from '../core/sqlite-migrations.ts';
import { closeSqliteStore } from '../core/sqlite-store.ts';
import { isBoundedSourceCheckpoint } from './source-checkpoint.ts';

export { SOURCE_CHECKPOINT_MAX_LENGTH } from './source-checkpoint.ts';

export const SOURCE_SCHEDULER_STATE_STORE_ID = 'source-scheduler-state';
export const SOURCE_SCHEDULER_STATE_SCHEMA_VERSION = 2;
const SOURCE_SCHEDULER_TASK_STATE_VERSION = 1;

const SAFE_STATE_TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SAFE_KEY_PART = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SAFE_HASH = /^[a-f0-9]{16,128}$/;

export interface SourceSchedulerTaskStateKey {
  sourceId: string;
  corpusId: string;
  taskId: string;
}

export type PersistedSourceSchedulerResultStatus = 'progress' | 'idle' | 'failed';

export interface PersistedSourceSchedulerTaskState extends SourceSchedulerTaskStateKey {
  stateVersion: 1;
  attemptPending: boolean;
  checkpoint?: string;
  lastAttemptAt?: string;
  lastCompletedAt?: string;
  lastSuccessAt?: string;
  notBeforeAt?: string;
  consecutiveFailures: number;
  lastErrorKind?: string;
  lastErrorHash?: string;
  lastResultStatus?: PersistedSourceSchedulerResultStatus;
  lastCounts?: Record<string, number>;
  lastWarnings?: string[];
  effectiveIntervalMs?: number;
  degradedReason?: string;
  updatedAt: string;
}

export interface RecordSourceSchedulerAttemptInput extends SourceSchedulerTaskStateKey {
  attemptedAt: string;
}

export interface RecordSourceSchedulerSuccessInput extends SourceSchedulerTaskStateKey {
  completedAt: string;
  resultStatus: 'progress' | 'idle';
  counts?: Record<string, number>;
  warnings?: string[];
  /** Omitted preserves the checkpoint, null clears it, and a string replaces it. */
  checkpoint?: string | null;
  /** Omitted clears any previous success-side deferral. */
  notBeforeAt?: string;
  /** Omitted returns the task to its configured cadence. */
  effectiveIntervalMs?: number;
  /** Omitted clears any previous degradation marker. */
  degradedReason?: string;
}

export interface AdoptSourceSchedulerExternalSuccessInput extends SourceSchedulerTaskStateKey {
  completedAt: string;
  resultStatus: 'progress' | 'idle';
  counts?: Record<string, number>;
  warnings?: string[];
}

export interface RecordSourceSchedulerFailureInput extends SourceSchedulerTaskStateKey {
  completedAt: string;
  notBeforeAt: string;
  errorKind: string;
  errorHash: string;
  warnings?: string[];
  counts?: Record<string, number>;
  /** Omitted preserves the prior effective cadence. */
  effectiveIntervalMs?: number;
  degradedReason?: string;
}

export type SourceSchedulerUnparkRefusalCode =
  | 'task_not_found'
  | 'task_identity_ambiguous'
  | 'expected_not_before_mismatch'
  | 'task_attempt_in_progress'
  | 'unpark_already_pending'
  | 'pending_unpark_not_found';

export class SourceSchedulerUnparkRefusal extends Error {
  readonly code: SourceSchedulerUnparkRefusalCode;

  constructor(code: SourceSchedulerUnparkRefusalCode, message: string) {
    super(`Source scheduler unpark refused (${code}): ${message}`);
    this.name = 'SourceSchedulerUnparkRefusal';
    this.code = code;
  }
}

export interface RequestSourceSchedulerUnparkInput {
  sourceId: string;
  taskId: string;
  expectedNotBeforeAt: string;
  reason: string;
  requestedAt: string;
}

export interface SourceSchedulerUnparkReceipt {
  kind: 'source_scheduler_unpark_requested';
  status: 'pending';
  source_id: string;
  task_id: string;
  expected_not_before_at: string;
  reason: string;
  requested_at: string;
  policy: {
    task_scoped: true;
    expected_state_guarded: true;
    one_attempt: true;
    configured_cadence_unchanged: true;
    counts_only: true;
  };
}

export interface CancelSourceSchedulerUnparkInput {
  sourceId: string;
  taskId: string;
  expectedNotBeforeAt: string;
  reason: string;
  cancelledAt: string;
}

export interface SourceSchedulerUnparkCancellationReceipt {
  kind: 'source_scheduler_unpark_cancelled';
  status: 'cancelled';
  source_id: string;
  task_id: string;
  expected_not_before_at: string;
  reason: string;
  cancelled_at: string;
  policy: {
    task_scoped: true;
    expected_request_guarded: true;
    configured_cadence_unchanged: true;
    counts_only: true;
  };
}

export interface PendingSourceSchedulerUnpark extends SourceSchedulerTaskStateKey {
  requestId: number;
  expectedNotBeforeAt: string;
  reason: string;
  requestedAt: string;
}

export interface ClaimSourceSchedulerUnparkAttemptInput extends PendingSourceSchedulerUnpark {
  attemptedAt: string;
}

interface SchedulerStateRow {
  source_id: string;
  corpus_id: string;
  task_id: string;
  state_version: number;
  attempt_in_progress: number;
  checkpoint: string | null;
  last_attempt_at: string | null;
  last_completed_at: string | null;
  last_success_at: string | null;
  not_before_at: string | null;
  consecutive_failures: number;
  last_error_kind: string | null;
  last_error_hash: string | null;
  last_result_status: string | null;
  last_counts_json: string | null;
  last_warnings_json: string | null;
  effective_interval_ms: number | null;
  degraded_reason: string | null;
  updated_at: string;
}

interface SchedulerUnparkRow {
  request_id: number;
  source_id: string;
  corpus_id: string;
  task_id: string;
  expected_not_before_at: string;
  reason: string;
  requested_at: string;
}

export function defaultSourceSchedulerStateDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'source-scheduler.sqlite');
}

/**
 * Durable, source-generic scheduler control state.
 *
 * The store deliberately has no free-form error/message column. Callers may
 * persist only bounded counts and safe categorical warning/error markers; the
 * hash is the sole durable correlation handle for private error text.
 */
export class LocalSourceSchedulerStateStore {
  readonly dbPath: string;
  private readonly db: Database;

  constructor(dbPath = defaultSourceSchedulerStateDbPath()) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbPath, { create: true });
    if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
    this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    assertSqliteSchemaCanOpen(
      this.db,
      SOURCE_SCHEDULER_STATE_STORE_ID,
      SOURCE_SCHEDULER_STATE_SCHEMA_VERSION,
    );
    runSqliteMigrations(
      this.db,
      SOURCE_SCHEDULER_STATE_STORE_ID,
      sourceSchedulerStateMigrations(),
    );
  }

  close(): void {
    closeSqliteStore(this.db);
  }

  get(key: SourceSchedulerTaskStateKey): PersistedSourceSchedulerTaskState | undefined {
    const safeKey = requireStateKey(key);
    const row = this.db.query(`
      SELECT *
      FROM source_scheduler_task_state
      WHERE source_id = ? AND corpus_id = ? AND task_id = ?
    `).get(safeKey.sourceId, safeKey.corpusId, safeKey.taskId) as SchedulerStateRow | null;
    return row ? decodeRow(row) : undefined;
  }

  list(): PersistedSourceSchedulerTaskState[] {
    const rows = this.db.query(`
      SELECT *
      FROM source_scheduler_task_state
      ORDER BY source_id, corpus_id, task_id
    `).all() as SchedulerStateRow[];
    return rows
      .map((row) => decodeRow(row))
      .filter((state): state is PersistedSourceSchedulerTaskState => state !== undefined);
  }

  requestUnpark(input: RequestSourceSchedulerUnparkInput): SourceSchedulerUnparkReceipt {
    const sourceId = requireKeyPart(input.sourceId, 'sourceId');
    const taskId = requireKeyPart(input.taskId, 'taskId');
    const expectedNotBeforeAt = requireTimestamp(input.expectedNotBeforeAt, 'expectedNotBeforeAt');
    const reason = requireStateToken(input.reason, 'reason');
    const requestedAt = requireTimestamp(input.requestedAt, 'requestedAt');

    return this.db.transaction(() => {
      const matches = this.db.query(`
        SELECT source_id, corpus_id, task_id, not_before_at, attempt_in_progress
        FROM source_scheduler_task_state
        WHERE source_id = ? AND task_id = ?
        ORDER BY corpus_id
      `).all(sourceId, taskId) as Array<{
        source_id: string;
        corpus_id: string;
        task_id: string;
        not_before_at: string | null;
        attempt_in_progress: number;
      }>;
      if (matches.length === 0) {
        throw new SourceSchedulerUnparkRefusal(
          'task_not_found',
          'the selected source and task have no durable scheduler state.',
        );
      }
      if (matches.length !== 1) {
        throw new SourceSchedulerUnparkRefusal(
          'task_identity_ambiguous',
          'the selected source and task do not identify exactly one scheduler row.',
        );
      }
      const observed = matches[0]!;
      if (observed.not_before_at !== expectedNotBeforeAt) {
        throw new SourceSchedulerUnparkRefusal(
          'expected_not_before_mismatch',
          'observed not_before_at does not match --expected-not-before.',
        );
      }
      if (observed.attempt_in_progress === 1) {
        throw new SourceSchedulerUnparkRefusal(
          'task_attempt_in_progress',
          'the selected task already has an attempt in progress.',
        );
      }
      const pending = this.db.query(`
        SELECT request_id
        FROM source_scheduler_unpark_request
        WHERE source_id = ? AND corpus_id = ? AND task_id = ? AND status = 'pending'
      `).get(sourceId, observed.corpus_id, taskId) as { request_id?: number } | null;
      if (pending) {
        throw new SourceSchedulerUnparkRefusal(
          'unpark_already_pending',
          'the selected task already has a pending one-attempt unpark request.',
        );
      }
      this.db.query(`
        INSERT INTO source_scheduler_unpark_request (
          source_id, corpus_id, task_id, expected_not_before_at,
          reason, requested_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        sourceId,
        observed.corpus_id,
        taskId,
        expectedNotBeforeAt,
        reason,
        requestedAt,
      );
      const receipt: SourceSchedulerUnparkReceipt = {
        kind: 'source_scheduler_unpark_requested',
        status: 'pending',
        source_id: sourceId,
        task_id: taskId,
        expected_not_before_at: expectedNotBeforeAt,
        reason,
        requested_at: requestedAt,
        policy: {
          task_scoped: true,
          expected_state_guarded: true,
          one_attempt: true,
          configured_cadence_unchanged: true,
          counts_only: true,
        },
      };
      return receipt;
    })();
  }

  /**
   * Releases a pending request that no scheduler can consume, including a
   * manual-cadence or currently unloaded task. The durable task state and its
   * configured cadence are untouched; only the exact pending control request
   * moves to the existing terminal `stale` state.
   */
  cancelUnpark(
    input: CancelSourceSchedulerUnparkInput,
  ): SourceSchedulerUnparkCancellationReceipt {
    const sourceId = requireKeyPart(input.sourceId, 'sourceId');
    const taskId = requireKeyPart(input.taskId, 'taskId');
    const expectedNotBeforeAt = requireTimestamp(input.expectedNotBeforeAt, 'expectedNotBeforeAt');
    const reason = requireStateToken(input.reason, 'reason');
    const cancelledAt = requireTimestamp(input.cancelledAt, 'cancelledAt');

    return this.db.transaction(() => {
      const matches = this.db.query(`
        SELECT request_id, expected_not_before_at
        FROM source_scheduler_unpark_request
        WHERE source_id = ? AND task_id = ? AND status = 'pending'
        ORDER BY corpus_id
      `).all(sourceId, taskId) as Array<{
        request_id: number;
        expected_not_before_at: string;
      }>;
      if (matches.length === 0) {
        throw new SourceSchedulerUnparkRefusal(
          'pending_unpark_not_found',
          'the selected source and task have no pending unpark request.',
        );
      }
      if (matches.length !== 1) {
        throw new SourceSchedulerUnparkRefusal(
          'task_identity_ambiguous',
          'the selected source and task do not identify exactly one pending request.',
        );
      }
      const pending = matches[0]!;
      if (pending.expected_not_before_at !== expectedNotBeforeAt) {
        throw new SourceSchedulerUnparkRefusal(
          'expected_not_before_mismatch',
          'the pending request does not match --expected-not-before.',
        );
      }
      const cancelled = this.db.query(`
        UPDATE source_scheduler_unpark_request
        SET status = 'stale', resolved_at = ?
        WHERE request_id = ? AND status = 'pending'
      `).run(cancelledAt, pending.request_id);
      if (cancelled.changes !== 1) {
        throw new SourceSchedulerUnparkRefusal(
          'pending_unpark_not_found',
          'the pending request was already resolved.',
        );
      }
      const receipt: SourceSchedulerUnparkCancellationReceipt = {
        kind: 'source_scheduler_unpark_cancelled',
        status: 'cancelled',
        source_id: sourceId,
        task_id: taskId,
        expected_not_before_at: expectedNotBeforeAt,
        reason,
        cancelled_at: cancelledAt,
        policy: {
          task_scoped: true,
          expected_request_guarded: true,
          configured_cadence_unchanged: true,
          counts_only: true,
        },
      };
      return receipt;
    })();
  }

  pendingUnparks(): PendingSourceSchedulerUnpark[] {
    const rows = this.db.query(`
      SELECT request_id, source_id, corpus_id, task_id,
             expected_not_before_at, reason, requested_at
      FROM source_scheduler_unpark_request
      WHERE status = 'pending'
      ORDER BY request_id
    `).all() as SchedulerUnparkRow[];
    return rows.map((row) => ({
      requestId: row.request_id,
      sourceId: row.source_id,
      corpusId: row.corpus_id,
      taskId: row.task_id,
      expectedNotBeforeAt: row.expected_not_before_at,
      reason: row.reason,
      requestedAt: row.requested_at,
    }));
  }

  /**
   * Claims one pending operator request and records its attempt in the same
   * transaction. Two scheduler processes may observe the request, but exactly
   * one can change `status = pending` and therefore exactly one can run it.
   */
  claimUnparkAttempt(
    input: ClaimSourceSchedulerUnparkAttemptInput,
  ): PersistedSourceSchedulerTaskState | undefined {
    const key = requireStateKey(input);
    const requestId = requirePositiveSafeInteger(input.requestId, 'requestId');
    const expectedNotBeforeAt = requireTimestamp(input.expectedNotBeforeAt, 'expectedNotBeforeAt');
    const attemptedAt = requireTimestamp(input.attemptedAt, 'attemptedAt');
    return this.db.transaction(() => {
      const state = this.db.query(`
        SELECT not_before_at, attempt_in_progress
        FROM source_scheduler_task_state
        WHERE source_id = ? AND corpus_id = ? AND task_id = ?
      `).get(key.sourceId, key.corpusId, key.taskId) as {
        not_before_at: string | null;
        attempt_in_progress: number;
      } | null;
      if (
        !state
        || state.not_before_at !== expectedNotBeforeAt
        || state.attempt_in_progress === 1
      ) {
        this.db.query(`
          UPDATE source_scheduler_unpark_request
          SET status = 'stale', resolved_at = ?
          WHERE request_id = ? AND status = 'pending'
        `).run(attemptedAt, requestId);
        return undefined;
      }
      const claimed = this.db.query(`
        UPDATE source_scheduler_unpark_request
        SET status = 'consumed', resolved_at = ?
        WHERE request_id = ?
          AND source_id = ? AND corpus_id = ? AND task_id = ?
          AND expected_not_before_at = ?
          AND status = 'pending'
      `).run(
        attemptedAt,
        requestId,
        key.sourceId,
        key.corpusId,
        key.taskId,
        expectedNotBeforeAt,
      );
      if (claimed.changes !== 1) return undefined;
      this.recordAttemptStatement(key, attemptedAt);
      const recorded = this.get(key);
      if (!recorded) {
        throw new Error('Source scheduler unpark attempt could not be read after its atomic claim.');
      }
      return recorded;
    })();
  }

  recordAttempt(input: RecordSourceSchedulerAttemptInput): PersistedSourceSchedulerTaskState {
    const key = requireStateKey(input);
    const attemptedAt = requireTimestamp(input.attemptedAt, 'attemptedAt');
    return this.writeCurrentVersion(key, () => {
      this.recordAttemptStatement(key, attemptedAt);
    });
  }

  recordSuccess(input: RecordSourceSchedulerSuccessInput): PersistedSourceSchedulerTaskState {
    const key = requireStateKey(input);
    const completedAt = requireTimestamp(input.completedAt, 'completedAt');
    const countsJson = encodeCounts(input.counts);
    const warningsJson = encodeWarnings(input.warnings);
    const checkpointSupplied = Object.prototype.hasOwnProperty.call(input, 'checkpoint');
    const checkpoint = input.checkpoint === null || input.checkpoint === undefined
      ? null
      : requireCheckpoint(input.checkpoint);
    const notBeforeAt = input.notBeforeAt === undefined
      ? null
      : requireTimestamp(input.notBeforeAt, 'notBeforeAt');
    const effectiveIntervalMs = input.effectiveIntervalMs === undefined
      ? null
      : requirePositiveSafeInteger(input.effectiveIntervalMs, 'effectiveIntervalMs');
    const degradedReason = input.degradedReason === undefined
      ? null
      : requireStateToken(input.degradedReason, 'degradedReason');

    return this.writeCurrentVersion(key, () => {
      this.db.query(`
        INSERT INTO source_scheduler_task_state (
          source_id, corpus_id, task_id, state_version, checkpoint,
          last_completed_at, last_success_at, not_before_at,
          attempt_in_progress, consecutive_failures, last_error_kind, last_error_hash,
          last_result_status, last_counts_json, last_warnings_json,
          effective_interval_ms, degraded_reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, corpus_id, task_id) DO UPDATE SET
          checkpoint = CASE WHEN ? = 1 THEN excluded.checkpoint ELSE source_scheduler_task_state.checkpoint END,
          last_completed_at = excluded.last_completed_at,
          last_success_at = excluded.last_success_at,
          not_before_at = excluded.not_before_at,
          attempt_in_progress = 0,
          consecutive_failures = 0,
          last_error_kind = NULL,
          last_error_hash = NULL,
          last_result_status = excluded.last_result_status,
          last_counts_json = excluded.last_counts_json,
          last_warnings_json = excluded.last_warnings_json,
          effective_interval_ms = excluded.effective_interval_ms,
          degraded_reason = excluded.degraded_reason,
          updated_at = excluded.updated_at
      `).run(
        key.sourceId,
        key.corpusId,
        key.taskId,
        SOURCE_SCHEDULER_TASK_STATE_VERSION,
        checkpoint,
        completedAt,
        completedAt,
        notBeforeAt,
        input.resultStatus,
        countsJson,
        warningsJson,
        effectiveIntervalMs,
        degradedReason,
        completedAt,
        checkpointSupplied ? 1 : 0,
      );
    });
  }

  /**
   * Atomically imports a newer source-owned completion proof. Older/equal
   * external clocks never erase newer attempts or failures.
   *
   * Adoption never erases attempt history either: `last_attempt_at` survives
   * so an operator can still see that the task was tried. Erasing it made a
   * budget-refused task read as "no attempt recorded" during the 2026-07-26
   * hold incident. The scheduling anchor is unaffected — an adopted
   * completion is by definition newer than the preserved attempt, so
   * `initialNextRunAt` still schedules from the adopted completion.
   */
  adoptExternalSuccess(
    input: AdoptSourceSchedulerExternalSuccessInput,
  ): PersistedSourceSchedulerTaskState {
    const key = requireStateKey(input);
    const completedAt = requireTimestamp(input.completedAt, 'completedAt');
    const countsJson = encodeCounts(input.counts);
    const warningsJson = encodeWarnings(input.warnings);
    return this.writeCurrentVersion(key, () => {
      const existing = this.get(key);
      const newestActivity = Math.max(
        ...[existing?.lastAttemptAt, existing?.lastCompletedAt, existing?.lastSuccessAt]
          .map((value) => value ? Date.parse(value) : Number.NEGATIVE_INFINITY),
      );
      if (existing && Date.parse(completedAt) <= newestActivity) return;
      this.db.query(`
        INSERT INTO source_scheduler_task_state (
          source_id, corpus_id, task_id, state_version,
          last_completed_at, last_success_at, attempt_in_progress,
          consecutive_failures, last_error_kind, last_error_hash,
          last_result_status, last_counts_json, last_warnings_json,
          not_before_at, effective_interval_ms, degraded_reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, ?)
        ON CONFLICT(source_id, corpus_id, task_id) DO UPDATE SET
          last_completed_at = excluded.last_completed_at,
          last_success_at = excluded.last_success_at,
          attempt_in_progress = 0,
          consecutive_failures = 0,
          last_error_kind = NULL,
          last_error_hash = NULL,
          last_result_status = excluded.last_result_status,
          last_counts_json = excluded.last_counts_json,
          last_warnings_json = excluded.last_warnings_json,
          not_before_at = NULL,
          effective_interval_ms = NULL,
          degraded_reason = NULL,
          updated_at = excluded.updated_at
      `).run(
        key.sourceId,
        key.corpusId,
        key.taskId,
        SOURCE_SCHEDULER_TASK_STATE_VERSION,
        completedAt,
        completedAt,
        input.resultStatus,
        countsJson,
        warningsJson,
        completedAt,
      );
    });
  }

  recordFailure(input: RecordSourceSchedulerFailureInput): PersistedSourceSchedulerTaskState {
    const key = requireStateKey(input);
    const completedAt = requireTimestamp(input.completedAt, 'completedAt');
    const notBeforeAt = requireTimestamp(input.notBeforeAt, 'notBeforeAt');
    const errorKind = requireStateToken(input.errorKind, 'errorKind');
    const errorHash = requireHash(input.errorHash);
    const warningsJson = encodeWarnings(input.warnings);
    const countsJson = encodeCounts(input.counts);
    const effectiveIntervalSupplied = Object.prototype.hasOwnProperty.call(input, 'effectiveIntervalMs');
    const effectiveIntervalMs = input.effectiveIntervalMs === undefined
      ? null
      : requirePositiveSafeInteger(input.effectiveIntervalMs, 'effectiveIntervalMs');
    const degradedReasonSupplied = Object.prototype.hasOwnProperty.call(input, 'degradedReason');
    const degradedReason = input.degradedReason === undefined
      ? null
      : requireStateToken(input.degradedReason, 'degradedReason');

    return this.writeCurrentVersion(key, () => {
      this.db.query(`
        INSERT INTO source_scheduler_task_state (
          source_id, corpus_id, task_id, state_version,
          last_completed_at, not_before_at, attempt_in_progress, consecutive_failures,
          last_error_kind, last_error_hash, last_result_status,
          last_counts_json, last_warnings_json, effective_interval_ms,
          degraded_reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, 'failed', ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, corpus_id, task_id) DO UPDATE SET
          last_completed_at = excluded.last_completed_at,
          not_before_at = excluded.not_before_at,
          attempt_in_progress = 0,
          consecutive_failures = source_scheduler_task_state.consecutive_failures + 1,
          last_error_kind = excluded.last_error_kind,
          last_error_hash = excluded.last_error_hash,
          last_result_status = 'failed',
          last_counts_json = excluded.last_counts_json,
          last_warnings_json = excluded.last_warnings_json,
          effective_interval_ms = CASE WHEN ? = 1 THEN excluded.effective_interval_ms ELSE source_scheduler_task_state.effective_interval_ms END,
          degraded_reason = CASE WHEN ? = 1 THEN excluded.degraded_reason ELSE source_scheduler_task_state.degraded_reason END,
          updated_at = excluded.updated_at
      `).run(
        key.sourceId,
        key.corpusId,
        key.taskId,
        SOURCE_SCHEDULER_TASK_STATE_VERSION,
        completedAt,
        notBeforeAt,
        errorKind,
        errorHash,
        countsJson,
        warningsJson,
        effectiveIntervalMs,
        degradedReason,
        completedAt,
        effectiveIntervalSupplied ? 1 : 0,
        degradedReasonSupplied ? 1 : 0,
      );
    });
  }

  private writeCurrentVersion(
    key: SourceSchedulerTaskStateKey,
    write: () => void,
  ): PersistedSourceSchedulerTaskState {
    return this.db.transaction(() => {
      const existing = this.db.query(`
        SELECT state_version
        FROM source_scheduler_task_state
        WHERE source_id = ? AND corpus_id = ? AND task_id = ?
      `).get(key.sourceId, key.corpusId, key.taskId) as { state_version?: number } | null;
      if (existing && existing.state_version !== SOURCE_SCHEDULER_TASK_STATE_VERSION) {
        throw new Error('Source scheduler task state uses an unsupported state_version.');
      }
      write();
      const state = this.get(key);
      if (!state) throw new Error('Source scheduler task state could not be read after its atomic update.');
      return state;
    })();
  }

  private recordAttemptStatement(
    key: SourceSchedulerTaskStateKey,
    attemptedAt: string,
  ): void {
    this.db.query(`
      INSERT INTO source_scheduler_task_state (
        source_id, corpus_id, task_id, state_version,
        last_attempt_at, attempt_in_progress, consecutive_failures, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 0, ?)
      ON CONFLICT(source_id, corpus_id, task_id) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        attempt_in_progress = 1,
        updated_at = excluded.updated_at
    `).run(
      key.sourceId,
      key.corpusId,
      key.taskId,
      SOURCE_SCHEDULER_TASK_STATE_VERSION,
      attemptedAt,
      attemptedAt,
    );
  }
}

function sourceSchedulerStateMigrations(): SqliteMigration[] {
  return [
    {
      version: 1,
      name: 'create_source_scheduler_task_state',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS source_scheduler_task_state (
            source_id TEXT NOT NULL,
            corpus_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            state_version INTEGER NOT NULL DEFAULT 1,
            attempt_in_progress INTEGER NOT NULL DEFAULT 0 CHECK(attempt_in_progress IN (0, 1)),
            checkpoint TEXT,
            last_attempt_at TEXT,
            last_completed_at TEXT,
            last_success_at TEXT,
            not_before_at TEXT,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            last_error_kind TEXT,
            last_error_hash TEXT,
            last_result_status TEXT CHECK(last_result_status IN ('progress','idle','failed')),
            last_counts_json TEXT,
            last_warnings_json TEXT,
            effective_interval_ms INTEGER,
            degraded_reason TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(source_id, corpus_id, task_id)
          );
        `);
      },
    },
    {
      version: 2,
      name: 'add_guarded_scheduler_unpark_requests',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS source_scheduler_unpark_request (
            request_id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id TEXT NOT NULL,
            corpus_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            expected_not_before_at TEXT NOT NULL,
            reason TEXT NOT NULL,
            requested_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','consumed','stale')),
            resolved_at TEXT
          );
          CREATE UNIQUE INDEX IF NOT EXISTS source_scheduler_unpark_request_pending
          ON source_scheduler_unpark_request(source_id, corpus_id, task_id)
          WHERE status = 'pending';
        `);
      },
    },
  ];
}

function requireStateKey(input: SourceSchedulerTaskStateKey): SourceSchedulerTaskStateKey {
  return {
    sourceId: requireKeyPart(input.sourceId, 'sourceId'),
    corpusId: requireKeyPart(input.corpusId, 'corpusId'),
    taskId: requireKeyPart(input.taskId, 'taskId'),
  };
}

function requireKeyPart(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_KEY_PART.test(value)) {
    throw new TypeError(`Source scheduler ${field} must be a safe identifier.`);
  }
  return value;
}

function requireTimestamp(value: string, field: string): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Source scheduler ${field} must be a valid timestamp.`);
  }
  return value;
}

function requireStateToken(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_STATE_TOKEN.test(value)) {
    throw new TypeError(`Source scheduler ${field} must be a safe categorical token.`);
  }
  return value;
}

function requireHash(value: string): string {
  if (typeof value !== 'string' || !SAFE_HASH.test(value)) {
    throw new TypeError('Source scheduler errorHash must be a lowercase hexadecimal digest.');
  }
  return value;
}

function requireCheckpoint(value: string): string {
  if (!isBoundedSourceCheckpoint(value)) {
    throw new TypeError('Source scheduler checkpoint must be a bounded non-empty string.');
  }
  return value;
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Source scheduler ${field} must be a positive safe integer.`);
  }
  return value;
}

function encodeCounts(counts: Record<string, number> | undefined): string | null {
  if (counts === undefined) return null;
  const safe: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) {
    if (!SAFE_STATE_TOKEN.test(key) || !Number.isSafeInteger(counts[key]) || counts[key]! < 0) {
      throw new TypeError('Source scheduler counts must use safe keys and non-negative safe integers.');
    }
    safe[key] = counts[key]!;
  }
  return JSON.stringify(safe);
}

function encodeWarnings(warnings: string[] | undefined): string | null {
  if (warnings === undefined) return null;
  const safe = [...new Set(warnings.map((warning) => requireStateToken(warning, 'warning')))];
  return JSON.stringify(safe);
}

function decodeRow(row: SchedulerStateRow): PersistedSourceSchedulerTaskState | undefined {
  if (row.state_version !== SOURCE_SCHEDULER_TASK_STATE_VERSION) return undefined;
  if (!SAFE_KEY_PART.test(row.source_id) || !SAFE_KEY_PART.test(row.corpus_id) || !SAFE_KEY_PART.test(row.task_id)) {
    return undefined;
  }
  const updatedAt = safeTimestamp(row.updated_at);
  if (!updatedAt) return undefined;

  const lastResultStatus = safeResultStatus(row.last_result_status);
  const lastCounts = decodeCounts(row.last_counts_json);
  const lastWarnings = decodeWarnings(row.last_warnings_json);
  const checkpoint = isBoundedSourceCheckpoint(row.checkpoint) ? row.checkpoint : undefined;
  const effectiveIntervalMs = typeof row.effective_interval_ms === 'number'
    && Number.isSafeInteger(row.effective_interval_ms)
    && row.effective_interval_ms > 0
    ? row.effective_interval_ms
    : undefined;
  const degradedReason = typeof row.degraded_reason === 'string' && SAFE_STATE_TOKEN.test(row.degraded_reason)
    ? row.degraded_reason
    : undefined;
  const lastErrorKind = typeof row.last_error_kind === 'string' && SAFE_STATE_TOKEN.test(row.last_error_kind)
    ? row.last_error_kind
    : undefined;
  const lastErrorHash = typeof row.last_error_hash === 'string' && SAFE_HASH.test(row.last_error_hash)
    ? row.last_error_hash
    : undefined;

  return {
    sourceId: row.source_id,
    corpusId: row.corpus_id,
    taskId: row.task_id,
    stateVersion: SOURCE_SCHEDULER_TASK_STATE_VERSION,
    attemptPending: row.attempt_in_progress === 1,
    ...(checkpoint ? { checkpoint } : {}),
    ...(safeTimestamp(row.last_attempt_at) ? { lastAttemptAt: safeTimestamp(row.last_attempt_at)! } : {}),
    ...(safeTimestamp(row.last_completed_at) ? { lastCompletedAt: safeTimestamp(row.last_completed_at)! } : {}),
    ...(safeTimestamp(row.last_success_at) ? { lastSuccessAt: safeTimestamp(row.last_success_at)! } : {}),
    ...(safeTimestamp(row.not_before_at) ? { notBeforeAt: safeTimestamp(row.not_before_at)! } : {}),
    consecutiveFailures: Number.isSafeInteger(row.consecutive_failures) && row.consecutive_failures >= 0
      ? row.consecutive_failures
      : 0,
    ...(lastErrorKind ? { lastErrorKind } : {}),
    ...(lastErrorHash ? { lastErrorHash } : {}),
    ...(lastResultStatus ? { lastResultStatus } : {}),
    ...(lastCounts ? { lastCounts } : {}),
    ...(lastWarnings ? { lastWarnings } : {}),
    ...(effectiveIntervalMs ? { effectiveIntervalMs } : {}),
    ...(degradedReason ? { degradedReason } : {}),
    updatedAt,
  };
}

function safeTimestamp(value: string | null): string | undefined {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function safeResultStatus(value: string | null): PersistedSourceSchedulerResultStatus | undefined {
  return value === 'progress' || value === 'idle' || value === 'failed' ? value : undefined;
}

function decodeCounts(value: string | null): Record<string, number> | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const safe: Record<string, number> = {};
    for (const [key, count] of Object.entries(parsed)) {
      if (!SAFE_STATE_TOKEN.test(key) || !Number.isSafeInteger(count) || (count as number) < 0) return undefined;
      safe[key] = count as number;
    }
    return safe;
  } catch {
    return undefined;
  }
}

function decodeWarnings(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((warning) => typeof warning !== 'string' || !SAFE_STATE_TOKEN.test(warning))) {
      return undefined;
    }
    return [...new Set(parsed as string[])];
  } catch {
    return undefined;
  }
}
