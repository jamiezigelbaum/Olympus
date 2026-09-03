import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  assertSqliteSchemaCanOpen,
  readSqliteSchemaVersion,
  runSqliteMigrations,
  type SqliteMigration,
} from './sqlite-migrations.ts';
import { closeSqliteStore } from './sqlite-store.ts';

export const SOURCE_WATCH_STORE_ID = 'source-watch';
export const SOURCE_WATCH_SCHEMA_VERSION = 1;
export const SOURCE_WATCH_MIN_LEASE_MS = 1_000;
export const SOURCE_WATCH_MAX_LEASE_MS = 5 * 60_000;
export const SOURCE_WATCH_MIN_RETRY_MS = 1_000;
export const SOURCE_WATCH_MAX_RETRY_MS = 24 * 60 * 60_000;
export const SOURCE_WATCH_MIN_RETENTION_MS = 24 * 60 * 60_000;
export const SOURCE_WATCH_MAX_RETENTION_MS = 365 * 24 * 60 * 60_000;
export const SOURCE_WATCH_OWNER_HEADER = 'X-Olympus-Source-Watch-Owner';
export const SOURCE_WATCH_ROUTE_KIND_HEADER = 'X-Olympus-Source-Watch-Route-Kind';
export const SOURCE_WATCH_ROUTE_TARGET_HEADER = 'X-Olympus-Source-Watch-Route-Target';
export const SOURCE_WATCH_ROUTE_ACCOUNT_HEADER = 'X-Olympus-Source-Watch-Route-Account';
export const SOURCE_WATCH_MAX_QUERY_LENGTH = 4_096;

const MAX_WATCH_LIFETIME_MS = 5 * 365 * 24 * 60 * 60_000;
const MAX_SOURCE_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_LOCAL_ITEM_ID_LENGTH = 4_096;
const MAX_SOURCE_VERSION_LENGTH = 1_024;
const MAX_DELIVERY_ATTEMPTS = 100;
const MAX_AVAILABLE_DELAY_MS = 24 * 60 * 60_000;
const MAX_PAGE_SIZE = 100;
const MAX_MAINTENANCE_BATCH = 1_000;
const MAX_CURSOR_LENGTH = 1_024;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;
const DEFAULT_PAGE_SIZE = 50;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SAFE_TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SAFE_HASH = /^[a-f0-9]{64}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_CHANNEL_TARGET = /^(telegram|whatsapp|signal|discord|slack):[A-Za-z0-9][A-Za-z0-9._@/-]{0,191}$/;
const SAFE_CANONICAL_REF = /^[^\u0000-\u001f\u007f]+$/u;

const OWNER_CONTEXT_FIELDS = new Set(['ownerId', 'routeKind', 'routeTargetId', 'routeAccountId']);
const CREATE_WATCH_FIELDS = new Set([
  'watchId',
  'corpusId',
  'queryText',
  'mode',
  'expiresAt',
  'maxDeliveryAttempts',
]);
const CANONICAL_REF_FIELDS = new Set(['corpusId', 'localItemId', 'sourceVersion']);
const WATCH_STATUS_VALUES = new Set(['active', 'completed', 'cancelled', 'expired']);
const OUTBOX_STATUS_VALUES = new Set([
  'pending',
  'leased',
  'retry',
  'delivered',
  'dead_letter',
  'cancelled',
]);

const ownedContexts = new WeakSet<object>();
const executorCapabilities = new WeakSet<object>();

const OWNED_SCHEMA_OBJECTS = [
  'source_watches',
  'source_watch_watermarks',
  'source_watch_matches',
  'source_watch_outbox',
  'source_watch_matches_watch_idx',
  'source_watch_outbox_ready_idx',
  'source_watch_outbox_watch_idx',
] as const;

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  source_watches: [
    'watch_id',
    'corpus_id',
    'query_text',
    'mode',
    'status',
    'owner_id',
    'route_kind',
    'route_target_id',
    'route_account_id',
    'max_delivery_attempts',
    'created_at',
    'updated_at',
    'expires_at',
    'cancelled_at',
    'cancel_reason',
    'completed_at',
  ],
  source_watch_watermarks: [
    'watch_id',
    'corpus_id',
    'local_item_id',
    'source_version',
    'source_observed_at',
    'recorded_at',
  ],
  source_watch_matches: [
    'delivery_key',
    'watch_id',
    'corpus_id',
    'local_item_id',
    'source_version',
    'matched_at',
  ],
  source_watch_outbox: [
    'delivery_key',
    'watch_id',
    'corpus_id',
    'status',
    'available_at',
    'attempt_count',
    'max_attempts',
    'lease_owner',
    'lease_token',
    'lease_generation',
    'lease_expires_at',
    'last_error_kind',
    'last_error_hash',
    'delivered_at',
    'dead_lettered_at',
    'cancelled_at',
    'created_at',
    'updated_at',
  ],
};

export type SourceWatchMode = 'continuous' | 'one_shot';
export type SourceWatchStatus = 'active' | 'completed' | 'cancelled' | 'expired';
export type SourceWatchRouteKind = 'openclaw_task' | 'openclaw_channel';
export type SourceWatchOutboxStatus =
  | 'pending'
  | 'leased'
  | 'retry'
  | 'delivered'
  | 'dead_letter'
  | 'cancelled';

export interface SourceWatchClock {
  now(): Date;
}

export interface SourceWatchOwnerContextInput {
  ownerId: string;
  routeKind: SourceWatchRouteKind;
  routeTargetId: string;
  routeAccountId?: string;
}

/** Trusted OpenClaw tool-factory context forwarded over the authenticated worker hop. */
export type SourceWatchAuthenticatedRoute = SourceWatchOwnerContextInput;

export function sourceWatchAuthenticatedRouteHeaders(
  route: SourceWatchAuthenticatedRoute,
): Headers {
  const headers = new Headers({
    [SOURCE_WATCH_OWNER_HEADER]: route.ownerId,
    [SOURCE_WATCH_ROUTE_KIND_HEADER]: route.routeKind,
    [SOURCE_WATCH_ROUTE_TARGET_HEADER]: route.routeTargetId,
  });
  if (route.routeAccountId) headers.set(SOURCE_WATCH_ROUTE_ACCOUNT_HEADER, route.routeAccountId);
  return headers;
}

/** Opaque authority built from authenticated harness/session context. */
export interface TrustedSourceWatchOwnerContext {
  readonly ownerId: string;
  readonly routeKind: SourceWatchRouteKind;
  readonly routeTargetId: string;
  readonly routeAccountId?: string;
  readonly __trustedSourceWatchOwnerContext: never;
}

/** Opaque authority for the deterministic evaluator/dispatcher, never a tool argument. */
export interface SourceWatchExecutorCapability {
  readonly executorId: string;
  readonly __sourceWatchExecutorCapability: never;
}

export interface CreateSourceWatchInput {
  watchId?: string;
  corpusId: string;
  queryText: string;
  mode: SourceWatchMode;
  /** Matching deadline. Matches accepted before it remain deliverable afterward. */
  expiresAt?: string;
  maxDeliveryAttempts?: number;
}

export interface SourceWatchCanonicalRef {
  corpusId: string;
  localItemId: string;
  sourceVersion: string;
}

export interface PersistedSourceWatch {
  watchId: string;
  corpusId: string;
  queryText: string;
  mode: SourceWatchMode;
  status: SourceWatchStatus;
  createdAt: string;
  updatedAt: string;
  /** Matching deadline, not a delivery deadline. */
  expiresAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  completedAt?: string;
  maxDeliveryAttempts: number;
}

export interface SourceWatchWatermark {
  watchId: string;
  ref: SourceWatchCanonicalRef;
  sourceObservedAt: string;
  recordedAt: string;
}

export interface SourceWatchMatch {
  /** Stable downstream idempotency key: hash(watch + corpus + item + version). */
  deliveryKey: string;
  watchId: string;
  ref: SourceWatchCanonicalRef;
  matchedAt: string;
}

export interface SourceWatchOutboxEntry {
  /** Stable downstream idempotency key; every retry of this delivery reuses it. */
  deliveryKey: string;
  watchId: string;
  corpusId: string;
  status: SourceWatchOutboxStatus;
  availableAt: string;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseGeneration: number;
  leaseExpiresAt?: string;
  lastErrorKind?: string;
  lastErrorHash?: string;
  deliveredAt?: string;
  deadLetteredAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Dispatcher contract: pass downstreamIdempotencyKey to the downstream send.
 * If the process crashes after send but before recordDelivered(), a later
 * lease has a new fence but the same idempotency key, so downstream can safely
 * collapse the replay.
 */
export interface SourceWatchDeliveryLease extends SourceWatchOutboxEntry {
  status: 'leased';
  leaseOwner: string;
  leaseToken: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  downstreamIdempotencyKey: string;
  matchedAt: string;
  queryText: string;
  watchMode: SourceWatchMode;
  ref: SourceWatchCanonicalRef;
  route: {
    ownerId: string;
    kind: SourceWatchRouteKind;
    targetId: string;
    accountId?: string;
  };
}

export interface SourceWatchDeliverySummary {
  pendingCount: number;
  inFlightCount: number;
  retryCount: number;
  deliveredCount: number;
  deadLetterCount: number;
  cancelledCount: number;
  attempts: number;
  lastErrorKind?: string;
}

export interface SourceWatchPage<T> {
  items: T[];
  nextCursor?: string;
}

interface WatchRow {
  watch_id: string;
  corpus_id: string;
  query_text: string;
  mode: string;
  status: string;
  owner_id: string;
  route_kind: string;
  route_target_id: string;
  route_account_id: string | null;
  max_delivery_attempts: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  completed_at: string | null;
}

interface WatermarkRow {
  watch_id: string;
  corpus_id: string;
  local_item_id: string;
  source_version: string;
  source_observed_at: string;
  recorded_at: string;
}

interface MatchRow {
  delivery_key: string;
  watch_id: string;
  corpus_id: string;
  local_item_id: string;
  source_version: string;
  matched_at: string;
}

interface OutboxRow {
  delivery_key: string;
  watch_id: string;
  corpus_id: string;
  status: string;
  available_at: string;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_generation: number;
  lease_expires_at: string | null;
  last_error_kind: string | null;
  last_error_hash: string | null;
  delivered_at: string | null;
  dead_lettered_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryLeaseRow extends OutboxRow {
  local_item_id: string;
  source_version: string;
  matched_at: string;
  query_text: string;
  mode: string;
  owner_id: string;
  route_kind: string;
  route_target_id: string;
  route_account_id: string | null;
}

const SYSTEM_CLOCK: SourceWatchClock = Object.freeze({
  now: () => new Date(),
});

export function defaultSourceWatchDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.XDG_DATA_HOME?.trim();
  const dataRoot = configured || join(homedir(), '.local', 'share');
  if (!isAbsolute(dataRoot)) {
    throw new TypeError('Source watch XDG_DATA_HOME must be an absolute private data root.');
  }
  return join(dataRoot, 'openclaw', 'olympus', 'source-watches.sqlite');
}

export function createTrustedSourceWatchOwnerContext(
  input: SourceWatchOwnerContextInput,
): TrustedSourceWatchOwnerContext {
  assertOnlyFields(input as unknown as Record<string, unknown>, OWNER_CONTEXT_FIELDS, 'owner context');
  const routeKind = requireRouteKind(input.routeKind);
  const context = Object.freeze({
    ownerId: requireId(input.ownerId, 'ownerId'),
    routeKind,
    routeTargetId: requireRouteTarget(routeKind, input.routeTargetId),
    ...(input.routeAccountId === undefined
      ? {}
      : { routeAccountId: requireId(input.routeAccountId, 'routeAccountId') }),
  }) as unknown as TrustedSourceWatchOwnerContext;
  ownedContexts.add(context);
  return context;
}

export function createSourceWatchExecutorCapability(input: {
  executorId: string;
}): SourceWatchExecutorCapability {
  assertOnlyFields(input as unknown as Record<string, unknown>, new Set(['executorId']), 'executor capability');
  const capability = Object.freeze({
    executorId: requireId(input.executorId, 'executorId'),
  }) as unknown as SourceWatchExecutorCapability;
  executorCapabilities.add(capability);
  return capability;
}

export function sourceWatchDeliveryKey(
  watchId: string,
  ref: SourceWatchCanonicalRef,
): string {
  const canonical = requireCanonicalRef(ref);
  return createHash('sha256').update(JSON.stringify([
    requireId(watchId, 'watchId'),
    canonical.corpusId,
    canonical.localItemId,
    canonical.sourceVersion,
  ]), 'utf8').digest('hex');
}

/**
 * Durable, source-generic watch control state.
 *
 * The store clock is authoritative for creation, matching, leasing, retries,
 * cancellation, delivery, and retention. Provider timestamps are data used
 * only for deterministic watermark ordering. Source bodies and provider
 * cursors have no accepted field or schema column.
 *
 * Watch expiresAt is a matching deadline. A match committed before the
 * deadline remains deliverable after the watch transitions to expired.
 */
export class LocalSourceWatchStore {
  readonly dbPath: string;
  private readonly db: Database;
  private readonly clock: SourceWatchClock;

  constructor(
    dbPath = defaultSourceWatchDbPath(),
    options: { clock?: SourceWatchClock } = {},
  ) {
    this.dbPath = dbPath;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    hardenPrivateDatabasePath(dbPath);
    this.db = new Database(dbPath, { create: true });
    try {
      chmodSync(dbPath, 0o600);
      this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA journal_mode = WAL;');
      refuseUnversionedOwnedSchema(this.db);
      assertSqliteSchemaCanOpen(this.db, SOURCE_WATCH_STORE_ID, SOURCE_WATCH_SCHEMA_VERSION);
      runSqliteMigrations(this.db, SOURCE_WATCH_STORE_ID, sourceWatchMigrations());
      validateSourceWatchSchema(this.db);
    } catch (error) {
      closeSqliteStore(this.db);
      throw error;
    }
  }

  close(): void {
    closeSqliteStore(this.db);
  }

  createWatch(
    input: CreateSourceWatchInput,
    ownerContext: TrustedSourceWatchOwnerContext,
  ): PersistedSourceWatch {
    requireOwnerContext(ownerContext);
    assertOnlyFields(input as unknown as Record<string, unknown>, CREATE_WATCH_FIELDS, 'create watch');
    const now = this.now();
    const watchId = input.watchId === undefined ? randomUUID() : requireId(input.watchId, 'watchId');
    const corpusId = requireId(input.corpusId, 'corpusId');
    const queryText = requireQuery(input.queryText);
    const mode = requireMode(input.mode);
    const expiresAt = input.expiresAt === undefined
      ? null
      : requireFutureDeadline(input.expiresAt, now, 'expiresAt');
    const maxAttempts = requireMaxAttempts(input.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS);

    return this.db.transaction(() => {
      this.db.query(`
        INSERT INTO source_watches (
          watch_id, corpus_id, query_text, mode, status,
          owner_id, route_kind, route_target_id, route_account_id,
          max_delivery_attempts, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(watch_id) DO NOTHING
      `).run(
        watchId,
        corpusId,
        queryText,
        mode,
        ownerContext.ownerId,
        ownerContext.routeKind,
        ownerContext.routeTargetId,
        ownerContext.routeAccountId ?? null,
        maxAttempts,
        now,
        now,
        expiresAt,
      );
      const row = this.readWatchRow(watchId);
      if (!row) throw new Error('Source watch could not be read after creation.');
      if (
        row.corpus_id !== corpusId
        || row.query_text !== queryText
        || row.mode !== mode
        || row.owner_id !== ownerContext.ownerId
        || row.route_kind !== ownerContext.routeKind
        || row.route_target_id !== ownerContext.routeTargetId
        || row.route_account_id !== (ownerContext.routeAccountId ?? null)
        || row.max_delivery_attempts !== maxAttempts
        || row.expires_at !== expiresAt
      ) {
        throw new Error('Source watch id already exists with different immutable fields.');
      }
      return decodeWatch(row);
    })();
  }

  getWatch(
    ownerContext: TrustedSourceWatchOwnerContext,
    watchIdInput: string,
  ): PersistedSourceWatch | undefined {
    requireOwnerContext(ownerContext);
    const watchId = requireId(watchIdInput, 'watchId');
    const row = this.readOwnerWatchRow(ownerContext, watchId);
    if (!row) return undefined;
    this.expireValidatedWatchIfDue(row, this.now());
    const current = this.readOwnerWatchRow(ownerContext, watchId);
    return current ? decodeWatch(current) : undefined;
  }

  deliverySummary(
    ownerContext: TrustedSourceWatchOwnerContext,
    watchIdInput: string,
  ): SourceWatchDeliverySummary {
    requireOwnerContext(ownerContext);
    const watchId = requireId(watchIdInput, 'watchId');
    this.requireOwnerWatchRow(ownerContext, watchId);
    const counts = this.db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count,
        COALESCE(SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END), 0) AS in_flight_count,
        COALESCE(SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END), 0) AS retry_count,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered_count,
        COALESCE(SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END), 0) AS dead_letter_count,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count,
        COALESCE(SUM(attempt_count), 0) AS attempts
      FROM source_watch_outbox
      WHERE watch_id = ?
    `).get(watchId) as {
      pending_count: number;
      in_flight_count: number;
      retry_count: number;
      delivered_count: number;
      dead_letter_count: number;
      cancelled_count: number;
      attempts: number;
    };
    const lastError = this.db.query(`
      SELECT last_error_kind
      FROM source_watch_outbox
      WHERE watch_id = ? AND last_error_kind IS NOT NULL
      ORDER BY updated_at DESC, delivery_key DESC
      LIMIT 1
    `).get(watchId) as { last_error_kind: string } | null;
    return {
      pendingCount: counts.pending_count,
      inFlightCount: counts.in_flight_count,
      retryCount: counts.retry_count,
      deliveredCount: counts.delivered_count,
      deadLetterCount: counts.dead_letter_count,
      cancelledCount: counts.cancelled_count,
      attempts: counts.attempts,
      ...(lastError ? { lastErrorKind: lastError.last_error_kind } : {}),
    };
  }

  listWatches(
    ownerContext: TrustedSourceWatchOwnerContext,
    input: { limit?: number; cursor?: string } = {},
  ): SourceWatchPage<PersistedSourceWatch> {
    requireOwnerContext(ownerContext);
    assertOnlyFields(input as Record<string, unknown>, new Set(['limit', 'cursor']), 'list watches');
    const limit = requirePageLimit(input.limit);
    const cursor = decodePageCursor(input.cursor);
    const rows = this.db.query(`
      SELECT * FROM source_watches
      WHERE owner_id = ?
        AND (? IS NULL OR created_at > ? OR (created_at = ? AND watch_id > ?))
      ORDER BY created_at, watch_id
      LIMIT ?
    `).all(
      ownerContext.ownerId,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      limit + 1,
    ) as WatchRow[];
    const pageRows = rows.slice(0, limit);
    const now = this.now();
    for (const row of pageRows) this.expireValidatedWatchIfDue(row, now);
    const currentRows = pageRows.map((row) => this.readWatchRow(row.watch_id) ?? row);
    return pageFromRows(currentRows, rows.length > limit, (row) => decodeWatch(row), (row) => ({
      at: row.created_at,
      id: row.watch_id,
    }));
  }

  listExecutableWatches(
    capability: SourceWatchExecutorCapability,
    input: { corpusId?: string; limit?: number; cursor?: string } = {},
  ): SourceWatchPage<PersistedSourceWatch> {
    requireExecutor(capability);
    assertOnlyFields(
      input as Record<string, unknown>,
      new Set(['corpusId', 'limit', 'cursor']),
      'list executable watches',
    );
    const corpusId = input.corpusId === undefined ? null : requireId(input.corpusId, 'corpusId');
    const limit = requirePageLimit(input.limit);
    const cursor = decodePageCursor(input.cursor);
    const now = this.now();
    const rows = this.db.query(`
      SELECT * FROM source_watches
      WHERE status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
        AND (? IS NULL OR corpus_id = ?)
        AND (? IS NULL OR created_at > ? OR (created_at = ? AND watch_id > ?))
      ORDER BY created_at, watch_id
      LIMIT ?
    `).all(
      now,
      corpusId,
      corpusId,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      limit + 1,
    ) as WatchRow[];
    const pageRows = rows.slice(0, limit);
    return pageFromRows(pageRows, rows.length > limit, decodeWatch, (row) => ({
      at: row.created_at,
      id: row.watch_id,
    }));
  }

  cancelWatch(
    ownerContext: TrustedSourceWatchOwnerContext,
    input: { watchId: string; reason?: string },
  ): PersistedSourceWatch {
    requireOwnerContext(ownerContext);
    assertOnlyFields(input as Record<string, unknown>, new Set(['watchId', 'reason']), 'cancel watch');
    const watchId = requireId(input.watchId, 'watchId');
    const reason = input.reason === undefined ? null : requireToken(input.reason, 'reason');
    const now = this.now();
    return this.db.transaction(() => {
      const row = this.requireOwnerWatchRow(ownerContext, watchId);
      requireNotBefore(now, row.created_at, 'cancellation');
      if (row.status === 'cancelled') return decodeWatch(row);
      this.db.query(`
        UPDATE source_watches
        SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
        WHERE watch_id = ? AND owner_id = ?
      `).run(now, reason, now, watchId, ownerContext.ownerId);
      this.db.query(`
        UPDATE source_watch_outbox
        SET status = 'cancelled', cancelled_at = ?, lease_expires_at = NULL, updated_at = ?
        WHERE watch_id = ? AND status IN ('pending', 'retry', 'leased')
      `).run(now, now, watchId);
      return decodeWatch(this.requireOwnerWatchRow(ownerContext, watchId));
    })();
  }

  recordWatermark(
    capability: SourceWatchExecutorCapability,
    input: {
      watchId: string;
      ref: SourceWatchCanonicalRef;
      sourceObservedAt: string;
    },
  ): SourceWatchWatermark {
    requireExecutor(capability);
    assertOnlyFields(
      input as unknown as Record<string, unknown>,
      new Set(['watchId', 'ref', 'sourceObservedAt']),
      'record watermark',
    );
    const watchId = requireId(input.watchId, 'watchId');
    const ref = requireCanonicalRef(input.ref);
    const now = this.now();
    const sourceObservedAt = requireSourceObservedAt(input.sourceObservedAt, now);
    // Validate this exact target before the target-scoped expiry mutation. The
    // expiry is deliberately outside the rejecting transaction so a late
    // update cannot roll it back.
    const validatedWatch = this.requireWatchCorpus(watchId, ref.corpusId);
    this.expireValidatedWatchIfDue(validatedWatch, now);
    return this.db.transaction(() => {
      const currentWatch = this.requireWatchCorpus(watchId, ref.corpusId);
      requireNotBefore(now, currentWatch.created_at, 'watermark recording');
      if (currentWatch.status !== 'active') {
        throw new Error(`Source watch is ${currentWatch.status} and cannot advance its watermark.`);
      }
      this.db.query(`
        INSERT INTO source_watch_watermarks (
          watch_id, corpus_id, local_item_id, source_version,
          source_observed_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(watch_id, corpus_id) DO UPDATE SET
          local_item_id = excluded.local_item_id,
          source_version = excluded.source_version,
          source_observed_at = excluded.source_observed_at,
          recorded_at = excluded.recorded_at
        WHERE excluded.source_observed_at > source_watch_watermarks.source_observed_at
           OR (
             excluded.source_observed_at = source_watch_watermarks.source_observed_at
             AND excluded.local_item_id > source_watch_watermarks.local_item_id
           )
           OR (
             excluded.source_observed_at = source_watch_watermarks.source_observed_at
             AND excluded.local_item_id = source_watch_watermarks.local_item_id
             AND excluded.source_version > source_watch_watermarks.source_version
           )
      `).run(
        watchId,
        ref.corpusId,
        ref.localItemId,
        ref.sourceVersion,
        sourceObservedAt,
        now,
      );
      return this.requireWatermark(watchId, ref.corpusId);
    })();
  }

  getWatermark(
    capability: SourceWatchExecutorCapability,
    watchIdInput: string,
    corpusIdInput: string,
  ): SourceWatchWatermark | undefined {
    requireExecutor(capability);
    const watchId = requireId(watchIdInput, 'watchId');
    const corpusId = requireId(corpusIdInput, 'corpusId');
    const row = this.db.query(`
      SELECT * FROM source_watch_watermarks
      WHERE watch_id = ? AND corpus_id = ?
    `).get(watchId, corpusId) as WatermarkRow | null;
    return row ? decodeWatermark(row) : undefined;
  }

  recordMatch(
    capability: SourceWatchExecutorCapability,
    input: {
      watchId: string;
      ref: SourceWatchCanonicalRef;
      availableAfterMs?: number;
    },
  ): SourceWatchMatch {
    requireExecutor(capability);
    assertOnlyFields(
      input as unknown as Record<string, unknown>,
      new Set(['watchId', 'ref', 'availableAfterMs']),
      'record match',
    );
    const watchId = requireId(input.watchId, 'watchId');
    const ref = requireCanonicalRef(input.ref);
    const availableAfterMs = requireAvailableDelay(input.availableAfterMs);
    const deliveryKey = sourceWatchDeliveryKey(watchId, ref);
    const now = this.now();
    const availableAt = addMilliseconds(now, availableAfterMs);
    // Validate this exact target before the target-scoped expiry mutation. The
    // expiry is deliberately outside the rejecting transaction so a late
    // match cannot roll it back.
    const validatedWatch = this.requireWatchCorpus(watchId, ref.corpusId);
    this.expireValidatedWatchIfDue(validatedWatch, now);

    return this.db.transaction(() => {
      const currentWatch = this.requireWatchCorpus(watchId, ref.corpusId);
      requireNotBefore(now, currentWatch.created_at, 'match recording');

      const existing = this.readMatch(deliveryKey);
      if (existing) return existing;
      if (currentWatch.status !== 'active') {
        throw new Error(`Source watch is ${currentWatch.status} and cannot accept a new match.`);
      }

      this.db.query(`
        INSERT INTO source_watch_matches (
          delivery_key, watch_id, corpus_id, local_item_id, source_version, matched_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        deliveryKey,
        watchId,
        ref.corpusId,
        ref.localItemId,
        ref.sourceVersion,
        now,
      );
      this.db.query(`
        INSERT INTO source_watch_outbox (
          delivery_key, watch_id, corpus_id, status, available_at,
          attempt_count, max_attempts, lease_generation, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, 0, ?, 0, ?, ?)
      `).run(
        deliveryKey,
        watchId,
        ref.corpusId,
        availableAt,
        currentWatch.max_delivery_attempts,
        now,
        now,
      );
      if (currentWatch.mode === 'one_shot') {
        this.db.query(`
          UPDATE source_watches
          SET status = 'completed', completed_at = ?, updated_at = ?
          WHERE watch_id = ? AND corpus_id = ? AND status = 'active'
        `).run(now, now, watchId, ref.corpusId);
      }
      const match = this.readMatch(deliveryKey);
      if (!match) throw new Error('Source watch match could not be read after creation.');
      return match;
    })();
  }

  listMatches(
    capability: SourceWatchExecutorCapability,
    input: { watchId?: string; limit?: number; cursor?: string } = {},
  ): SourceWatchPage<SourceWatchMatch> {
    requireExecutor(capability);
    assertOnlyFields(input as Record<string, unknown>, new Set(['watchId', 'limit', 'cursor']), 'list matches');
    const watchId = input.watchId === undefined ? null : requireId(input.watchId, 'watchId');
    const limit = requirePageLimit(input.limit);
    const cursor = decodePageCursor(input.cursor);
    const rows = this.db.query(`
      SELECT * FROM source_watch_matches
      WHERE (? IS NULL OR watch_id = ?)
        AND (? IS NULL OR matched_at > ? OR (matched_at = ? AND delivery_key > ?))
      ORDER BY matched_at, delivery_key
      LIMIT ?
    `).all(
      watchId,
      watchId,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      limit + 1,
    ) as MatchRow[];
    const pageRows = rows.slice(0, limit);
    return pageFromRows(pageRows, rows.length > limit, decodeMatch, (row) => ({
      at: row.matched_at,
      id: row.delivery_key,
    }));
  }

  getOutboxEntry(
    capability: SourceWatchExecutorCapability,
    deliveryKeyInput: string,
  ): SourceWatchOutboxEntry | undefined {
    requireExecutor(capability);
    const deliveryKey = requireHash(deliveryKeyInput, 'deliveryKey');
    const row = this.readOutboxRow(deliveryKey);
    return row ? decodeOutbox(row) : undefined;
  }

  listOutbox(
    capability: SourceWatchExecutorCapability,
    input: { status?: SourceWatchOutboxStatus; limit?: number; cursor?: string } = {},
  ): SourceWatchPage<SourceWatchOutboxEntry> {
    requireExecutor(capability);
    assertOnlyFields(input as Record<string, unknown>, new Set(['status', 'limit', 'cursor']), 'list outbox');
    const status = input.status === undefined ? null : requireOutboxStatus(input.status);
    const limit = requirePageLimit(input.limit);
    const cursor = decodePageCursor(input.cursor);
    const rows = this.db.query(`
      SELECT * FROM source_watch_outbox
      WHERE (? IS NULL OR status = ?)
        AND (? IS NULL OR created_at > ? OR (created_at = ? AND delivery_key > ?))
      ORDER BY created_at, delivery_key
      LIMIT ?
    `).all(
      status,
      status,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      limit + 1,
    ) as OutboxRow[];
    const pageRows = rows.slice(0, limit);
    return pageFromRows(pageRows, rows.length > limit, decodeOutbox, (row) => ({
      at: row.created_at,
      id: row.delivery_key,
    }));
  }

  leaseDeliveries(
    capability: SourceWatchExecutorCapability,
    input: { leaseDurationMs: number; limit?: number },
  ): SourceWatchDeliveryLease[] {
    requireExecutor(capability);
    assertOnlyFields(input as Record<string, unknown>, new Set(['leaseDurationMs', 'limit']), 'lease deliveries');
    const leaseDurationMs = requireBoundedInteger(
      input.leaseDurationMs,
      SOURCE_WATCH_MIN_LEASE_MS,
      SOURCE_WATCH_MAX_LEASE_MS,
      'leaseDurationMs',
    );
    const limit = requirePageLimit(input.limit);
    const now = this.now();
    const leaseExpiresAt = addMilliseconds(now, leaseDurationMs);

    return this.db.transaction(() => {
      this.recoverExpiredLeases(now, limit);
      const candidates = this.db.query(`
        SELECT o.delivery_key
        FROM source_watch_outbox o
        JOIN source_watches w
          ON w.watch_id = o.watch_id AND w.corpus_id = o.corpus_id
        WHERE o.status IN ('pending', 'retry')
          AND o.available_at <= ?
          AND w.status IN ('active', 'completed', 'expired')
        ORDER BY o.available_at, o.created_at, o.delivery_key
        LIMIT ?
      `).all(now, limit) as Array<{ delivery_key: string }>;
      const leases: SourceWatchDeliveryLease[] = [];
      for (const candidate of candidates) {
        const leaseToken = randomUUID();
        const result = this.db.query(`
          UPDATE source_watch_outbox
          SET status = 'leased', lease_owner = ?, lease_token = ?,
              lease_generation = lease_generation + 1, lease_expires_at = ?,
              attempt_count = attempt_count + 1, updated_at = ?
          WHERE delivery_key = ?
            AND status IN ('pending', 'retry')
            AND available_at <= ?
        `).run(
          capability.executorId,
          leaseToken,
          leaseExpiresAt,
          now,
          candidate.delivery_key,
          now,
        );
        if (result.changes !== 1) continue;
        const row = this.readDeliveryLease(candidate.delivery_key);
        if (!row) throw new Error('Source watch delivery lease could not be read after update.');
        leases.push(decodeDeliveryLease(row));
      }
      return leases;
    })();
  }

  recordDelivered(
    capability: SourceWatchExecutorCapability,
    input: { deliveryKey: string; leaseToken: string; leaseGeneration: number },
  ): SourceWatchOutboxEntry {
    requireExecutor(capability);
    assertOnlyFields(
      input as Record<string, unknown>,
      new Set(['deliveryKey', 'leaseToken', 'leaseGeneration']),
      'record delivered',
    );
    const deliveryKey = requireHash(input.deliveryKey, 'deliveryKey');
    const leaseToken = requireUuid(input.leaseToken, 'leaseToken');
    const leaseGeneration = requirePositiveInteger(input.leaseGeneration, 'leaseGeneration');
    const now = this.now();
    return this.db.transaction(() => {
      const row = this.requireOutboxRow(deliveryKey);
      if (row.status === 'delivered') {
        requireFence(row, capability, leaseToken, leaseGeneration, false, now);
        return decodeOutbox(row);
      }
      requireNotBefore(now, row.updated_at, 'delivery acknowledgement');
      requireFence(row, capability, leaseToken, leaseGeneration, true, now);
      const result = this.db.query(`
        UPDATE source_watch_outbox
        SET status = 'delivered', delivered_at = ?, lease_expires_at = NULL,
            last_error_kind = NULL, last_error_hash = NULL, updated_at = ?
        WHERE delivery_key = ?
          AND status = 'leased'
          AND lease_owner = ?
          AND lease_token = ?
          AND lease_generation = ?
      `).run(
        now,
        now,
        deliveryKey,
        capability.executorId,
        leaseToken,
        leaseGeneration,
      );
      if (result.changes !== 1) {
        throw new Error('Source watch delivery lease fence changed before delivery acknowledgement.');
      }
      return decodeOutbox(this.requireOutboxRow(deliveryKey));
    })();
  }

  recordDeliveryFailure(
    capability: SourceWatchExecutorCapability,
    input: {
      deliveryKey: string;
      leaseToken: string;
      leaseGeneration: number;
      retryAfterMs: number;
      errorKind: string;
      errorHash: string;
    },
  ): SourceWatchOutboxEntry {
    requireExecutor(capability);
    assertOnlyFields(
      input as Record<string, unknown>,
      new Set([
        'deliveryKey',
        'leaseToken',
        'leaseGeneration',
        'retryAfterMs',
        'errorKind',
        'errorHash',
      ]),
      'record delivery failure',
    );
    const deliveryKey = requireHash(input.deliveryKey, 'deliveryKey');
    const leaseToken = requireUuid(input.leaseToken, 'leaseToken');
    const leaseGeneration = requirePositiveInteger(input.leaseGeneration, 'leaseGeneration');
    const retryAfterMs = requireBoundedInteger(
      input.retryAfterMs,
      SOURCE_WATCH_MIN_RETRY_MS,
      SOURCE_WATCH_MAX_RETRY_MS,
      'retryAfterMs',
    );
    const errorKind = requireToken(input.errorKind, 'errorKind');
    const errorHash = requireHash(input.errorHash, 'errorHash');
    const now = this.now();
    const retryAt = addMilliseconds(now, retryAfterMs);
    return this.db.transaction(() => {
      const row = this.requireOutboxRow(deliveryKey);
      requireNotBefore(now, row.updated_at, 'delivery failure recording');
      requireFence(row, capability, leaseToken, leaseGeneration, true, now);
      const exhausted = row.attempt_count >= row.max_attempts;
      const result = this.db.query(`
        UPDATE source_watch_outbox
        SET status = ?, available_at = ?, lease_expires_at = NULL,
            last_error_kind = ?, last_error_hash = ?, dead_lettered_at = ?, updated_at = ?
        WHERE delivery_key = ?
          AND status = 'leased'
          AND lease_owner = ?
          AND lease_token = ?
          AND lease_generation = ?
      `).run(
        exhausted ? 'dead_letter' : 'retry',
        retryAt,
        errorKind,
        errorHash,
        exhausted ? now : null,
        now,
        deliveryKey,
        capability.executorId,
        leaseToken,
        leaseGeneration,
      );
      if (result.changes !== 1) {
        throw new Error('Source watch delivery lease fence changed before failure recording.');
      }
      return decodeOutbox(this.requireOutboxRow(deliveryKey));
    })();
  }

  /** Global watch-expiry maintenance; target-scoped calls never invoke it. */
  expireDueWatches(
    capability: SourceWatchExecutorCapability,
    input: { limit?: number } = {},
  ): number {
    requireExecutor(capability);
    assertOnlyFields(input as Record<string, unknown>, new Set(['limit']), 'expire watches');
    const limit = requireMaintenanceLimit(input.limit);
    const now = this.now();
    return this.db.transaction(() => {
      const rows = this.db.query(`
        SELECT watch_id, corpus_id FROM source_watches
        WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at, watch_id
        LIMIT ?
      `).all(now, limit) as Array<{ watch_id: string; corpus_id: string }>;
      for (const row of rows) {
        this.db.query(`
          UPDATE source_watches
          SET status = 'expired', updated_at = ?
          WHERE watch_id = ? AND corpus_id = ? AND status = 'active'
        `).run(now, row.watch_id, row.corpus_id);
      }
      return rows.length;
    })();
  }

  /**
   * Purges terminal delivery/match rows after the caller-selected bounded
   * retention horizon. That horizon is also the local replay-idempotency
   * horizon, so production policy must keep it longer than any source replay.
   */
  purgeTerminalDeliveries(
    capability: SourceWatchExecutorCapability,
    input: { retentionMs: number; limit?: number },
  ): { purged: number } {
    requireExecutor(capability);
    assertOnlyFields(
      input as Record<string, unknown>,
      new Set(['retentionMs', 'limit']),
      'purge terminal deliveries',
    );
    const retentionMs = requireBoundedInteger(
      input.retentionMs,
      SOURCE_WATCH_MIN_RETENTION_MS,
      SOURCE_WATCH_MAX_RETENTION_MS,
      'retentionMs',
    );
    const limit = requireMaintenanceLimit(input.limit);
    const now = this.now();
    const cutoff = addMilliseconds(now, -retentionMs);
    return this.db.transaction(() => {
      const rows = this.db.query(`
        SELECT delivery_key FROM source_watch_outbox
        WHERE status IN ('delivered', 'dead_letter', 'cancelled')
          AND COALESCE(delivered_at, dead_lettered_at, cancelled_at, updated_at) <= ?
        ORDER BY COALESCE(delivered_at, dead_lettered_at, cancelled_at, updated_at), delivery_key
        LIMIT ?
      `).all(cutoff, limit) as Array<{ delivery_key: string }>;
      for (const row of rows) {
        this.db.query('DELETE FROM source_watch_outbox WHERE delivery_key = ?').run(row.delivery_key);
        this.db.query('DELETE FROM source_watch_matches WHERE delivery_key = ?').run(row.delivery_key);
      }
      return { purged: rows.length };
    })();
  }

  /**
   * Removes inactive watch definitions only after their retained match/outbox
   * rows have been purged. This bounds retention of query text without
   * weakening the delivery idempotency horizon chosen above.
   */
  purgeTerminalWatches(
    capability: SourceWatchExecutorCapability,
    input: { retentionMs: number; limit?: number },
  ): { purged: number } {
    requireExecutor(capability);
    assertOnlyFields(
      input as Record<string, unknown>,
      new Set(['retentionMs', 'limit']),
      'purge terminal watches',
    );
    const retentionMs = requireBoundedInteger(
      input.retentionMs,
      SOURCE_WATCH_MIN_RETENTION_MS,
      SOURCE_WATCH_MAX_RETENTION_MS,
      'retentionMs',
    );
    const limit = requireMaintenanceLimit(input.limit);
    const now = this.now();
    const cutoff = addMilliseconds(now, -retentionMs);
    return this.db.transaction(() => {
      const rows = this.db.query(`
        SELECT watch_id, corpus_id FROM source_watches w
        WHERE w.status IN ('completed', 'cancelled', 'expired')
          AND COALESCE(w.cancelled_at, w.completed_at, w.updated_at) <= ?
          AND NOT EXISTS (
            SELECT 1 FROM source_watch_matches m
            WHERE m.watch_id = w.watch_id AND m.corpus_id = w.corpus_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM source_watch_outbox o
            WHERE o.watch_id = w.watch_id AND o.corpus_id = w.corpus_id
          )
        ORDER BY COALESCE(w.cancelled_at, w.completed_at, w.updated_at), w.watch_id
        LIMIT ?
      `).all(cutoff, limit) as Array<{ watch_id: string; corpus_id: string }>;
      for (const row of rows) {
        this.db.query(`
          DELETE FROM source_watches WHERE watch_id = ? AND corpus_id = ?
        `).run(row.watch_id, row.corpus_id);
      }
      return { purged: rows.length };
    })();
  }

  private now(): string {
    const date = this.clock.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new Error('Source watch store clock returned an invalid time.');
    }
    return date.toISOString();
  }

  private readWatchRow(watchId: string): WatchRow | null {
    return this.db.query('SELECT * FROM source_watches WHERE watch_id = ?').get(watchId) as WatchRow | null;
  }

  private readOwnerWatchRow(
    ownerContext: TrustedSourceWatchOwnerContext,
    watchId: string,
  ): WatchRow | null {
    return this.db.query(`
      SELECT * FROM source_watches WHERE watch_id = ? AND owner_id = ?
    `).get(watchId, ownerContext.ownerId) as WatchRow | null;
  }

  private requireOwnerWatchRow(
    ownerContext: TrustedSourceWatchOwnerContext,
    watchId: string,
  ): WatchRow {
    const row = this.readOwnerWatchRow(ownerContext, watchId);
    if (!row) throw new Error('Source watch does not exist in this owner scope.');
    return row;
  }

  private requireWatchCorpus(watchId: string, corpusId: string): WatchRow {
    const row = this.db.query(`
      SELECT * FROM source_watches WHERE watch_id = ? AND corpus_id = ?
    `).get(watchId, corpusId) as WatchRow | null;
    if (!row) throw new Error('Source watch target does not exist.');
    return row;
  }

  private expireValidatedWatchIfDue(row: WatchRow, now: string): void {
    if (row.status !== 'active' || row.expires_at === null || row.expires_at > now) return;
    this.db.query(`
      UPDATE source_watches
      SET status = 'expired', updated_at = ?
      WHERE watch_id = ? AND corpus_id = ? AND status = 'active' AND expires_at <= ?
    `).run(now, row.watch_id, row.corpus_id, now);
  }

  private requireWatermark(watchId: string, corpusId: string): SourceWatchWatermark {
    const row = this.db.query(`
      SELECT * FROM source_watch_watermarks WHERE watch_id = ? AND corpus_id = ?
    `).get(watchId, corpusId) as WatermarkRow | null;
    if (!row) throw new Error('Source watch watermark could not be read after update.');
    return decodeWatermark(row);
  }

  private readMatch(deliveryKey: string): SourceWatchMatch | undefined {
    const row = this.db.query(`
      SELECT * FROM source_watch_matches WHERE delivery_key = ?
    `).get(deliveryKey) as MatchRow | null;
    return row ? decodeMatch(row) : undefined;
  }

  private readOutboxRow(deliveryKey: string): OutboxRow | null {
    return this.db.query(`
      SELECT * FROM source_watch_outbox WHERE delivery_key = ?
    `).get(deliveryKey) as OutboxRow | null;
  }

  private requireOutboxRow(deliveryKey: string): OutboxRow {
    const row = this.readOutboxRow(deliveryKey);
    if (!row) throw new Error('Source watch outbox entry does not exist.');
    return row;
  }

  private readDeliveryLease(deliveryKey: string): DeliveryLeaseRow | null {
    return this.db.query(`
      SELECT o.*, m.local_item_id, m.source_version, m.matched_at,
             w.query_text, w.mode, w.owner_id, w.route_kind,
             w.route_target_id, w.route_account_id
      FROM source_watch_outbox o
      JOIN source_watch_matches m
        ON m.delivery_key = o.delivery_key
       AND m.watch_id = o.watch_id
       AND m.corpus_id = o.corpus_id
      JOIN source_watches w
        ON w.watch_id = o.watch_id AND w.corpus_id = o.corpus_id
      WHERE o.delivery_key = ? AND o.status = 'leased'
    `).get(deliveryKey) as DeliveryLeaseRow | null;
  }

  private recoverExpiredLeases(now: string, limit: number): void {
    const rows = this.db.query(`
      SELECT * FROM source_watch_outbox
      WHERE status = 'leased' AND lease_expires_at <= ?
      ORDER BY lease_expires_at, delivery_key
      LIMIT ?
    `).all(now, limit) as OutboxRow[];
    for (const row of rows) {
      const exhausted = row.attempt_count >= row.max_attempts;
      this.db.query(`
        UPDATE source_watch_outbox
        SET status = ?, available_at = ?, lease_expires_at = NULL,
            last_error_kind = 'lease_expired', last_error_hash = ?,
            dead_lettered_at = ?, updated_at = ?
        WHERE delivery_key = ?
          AND status = 'leased'
          AND lease_generation = ?
      `).run(
        exhausted ? 'dead_letter' : 'retry',
        now,
        sha256('lease_expired'),
        exhausted ? now : null,
        now,
        row.delivery_key,
        row.lease_generation,
      );
    }
  }
}

function sourceWatchMigrations(): SqliteMigration[] {
  return [{
    version: SOURCE_WATCH_SCHEMA_VERSION,
    name: 'create_source_watch_state',
    up(db) {
      db.exec(`
        CREATE TABLE source_watches (
          watch_id TEXT PRIMARY KEY,
          corpus_id TEXT NOT NULL,
          query_text TEXT NOT NULL,
          mode TEXT NOT NULL CHECK(mode IN ('continuous', 'one_shot')),
          status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled', 'expired')),
          owner_id TEXT NOT NULL,
          route_kind TEXT NOT NULL CHECK(route_kind IN ('openclaw_task', 'openclaw_channel')),
          route_target_id TEXT NOT NULL,
          route_account_id TEXT,
          max_delivery_attempts INTEGER NOT NULL CHECK(max_delivery_attempts > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT,
          cancelled_at TEXT,
          cancel_reason TEXT,
          completed_at TEXT,
          UNIQUE(watch_id, corpus_id)
        );

        CREATE TABLE source_watch_watermarks (
          watch_id TEXT NOT NULL,
          corpus_id TEXT NOT NULL,
          local_item_id TEXT NOT NULL,
          source_version TEXT NOT NULL,
          source_observed_at TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          PRIMARY KEY(watch_id, corpus_id),
          FOREIGN KEY(watch_id, corpus_id)
            REFERENCES source_watches(watch_id, corpus_id) ON DELETE CASCADE
        );

        CREATE TABLE source_watch_matches (
          delivery_key TEXT PRIMARY KEY,
          watch_id TEXT NOT NULL,
          corpus_id TEXT NOT NULL,
          local_item_id TEXT NOT NULL,
          source_version TEXT NOT NULL,
          matched_at TEXT NOT NULL,
          UNIQUE(delivery_key, watch_id, corpus_id),
          FOREIGN KEY(watch_id, corpus_id)
            REFERENCES source_watches(watch_id, corpus_id) ON DELETE CASCADE
        );
        CREATE INDEX source_watch_matches_watch_idx
          ON source_watch_matches(watch_id, corpus_id, matched_at);

        CREATE TABLE source_watch_outbox (
          delivery_key TEXT PRIMARY KEY,
          watch_id TEXT NOT NULL,
          corpus_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'pending', 'leased', 'retry', 'delivered', 'dead_letter', 'cancelled'
          )),
          available_at TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
          max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
          lease_owner TEXT,
          lease_token TEXT,
          lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
          lease_expires_at TEXT,
          last_error_kind TEXT,
          last_error_hash TEXT,
          delivered_at TEXT,
          dead_lettered_at TEXT,
          cancelled_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(watch_id, corpus_id)
            REFERENCES source_watches(watch_id, corpus_id) ON DELETE CASCADE,
          FOREIGN KEY(delivery_key, watch_id, corpus_id)
            REFERENCES source_watch_matches(delivery_key, watch_id, corpus_id) ON DELETE CASCADE
        );
        CREATE INDEX source_watch_outbox_ready_idx
          ON source_watch_outbox(status, available_at, created_at);
        CREATE INDEX source_watch_outbox_watch_idx
          ON source_watch_outbox(watch_id, corpus_id, created_at);
      `);
    },
  }];
}

function hardenPrivateDatabasePath(dbPath: string): void {
  if (!isAbsolute(dbPath)) {
    throw new TypeError('Source watch database path must be absolute.');
  }
  const leafDir = dirname(dbPath);
  const forbiddenLeafDirs = new Set([
    '/',
    '/tmp',
    '/private/tmp',
    '/var/tmp',
    '/private/var/tmp',
    homedir(),
  ]);
  if (forbiddenLeafDirs.has(leafDir)) {
    throw new Error('Source watch database must live inside a dedicated private leaf directory.');
  }
  mkdirSync(leafDir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(leafDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error('Source watch database leaf must be a real private directory.');
  }
  chmodSync(leafDir, 0o700);
  if (existsSync(dbPath)) {
    const dbStat = lstatSync(dbPath);
    if (dbStat.isSymbolicLink() || !dbStat.isFile()) {
      throw new Error('Source watch database must be a regular file, not a symlink.');
    }
  }
}

function refuseUnversionedOwnedSchema(db: Database): void {
  if (readSqliteSchemaVersion(db, SOURCE_WATCH_STORE_ID) !== 0) return;
  const placeholders = OWNED_SCHEMA_OBJECTS.map(() => '?').join(', ');
  const rows = db.query(`
    SELECT type, name FROM sqlite_master WHERE name IN (${placeholders}) ORDER BY name
  `).all(...OWNED_SCHEMA_OBJECTS) as Array<{ type: string; name: string }>;
  if (rows.length > 0) {
    throw new Error(
      `Source watch database has unversioned/colliding owned schema objects: ${rows.map((row) => row.name).join(', ')}.`,
    );
  }
}

function validateSourceWatchSchema(db: Database): void {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    const actual = columns.map((column) => column.name ?? '');
    if (actual.length !== required.length || actual.some((name, index) => name !== required[index])) {
      throw new Error(`Source watch schema table ${table} does not have the required v1 columns.`);
    }
  }
  const requiredIndexes: Record<string, string> = {
    source_watch_matches_watch_idx: 'source_watch_matches',
    source_watch_outbox_ready_idx: 'source_watch_outbox',
    source_watch_outbox_watch_idx: 'source_watch_outbox',
  };
  const missingIndexes = Object.entries(requiredIndexes)
    .filter(([name, expectedTable]) => {
      const row = db.query(`
        SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?
      `).get(name) as { name?: string; tbl_name?: string } | null;
      return row?.name !== name || row.tbl_name !== expectedTable;
    });
  if (missingIndexes.length > 0) {
    throw new Error(
      `Source watch schema is missing required indexes: ${missingIndexes.map(([name]) => name).join(', ')}.`,
    );
  }
  assertCompositeForeignKeys(db, 'source_watch_watermarks', [
    'source_watches:watch_id,corpus_id->watch_id,corpus_id',
  ]);
  assertCompositeForeignKeys(db, 'source_watch_matches', [
    'source_watches:watch_id,corpus_id->watch_id,corpus_id',
  ]);
  assertCompositeForeignKeys(db, 'source_watch_outbox', [
    'source_watch_matches:delivery_key,watch_id,corpus_id->delivery_key,watch_id,corpus_id',
    'source_watches:watch_id,corpus_id->watch_id,corpus_id',
  ]);
  const violation = db.query('PRAGMA foreign_key_check').get() as unknown;
  if (violation !== null) {
    throw new Error('Source watch database failed foreign_key_check.');
  }
}

function assertCompositeForeignKeys(
  db: Database,
  table: string,
  expected: string[],
): void {
  const rows = db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
  }>;
  const groups = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.id) ?? [];
    group.push(row);
    groups.set(row.id, group);
  }
  const actual = [...groups.values()].map((group) => {
    const ordered = [...group].sort((left, right) => left.seq - right.seq);
    return `${ordered[0]?.table ?? ''}:${ordered.map((row) => row.from).join(',')}->${ordered.map((row) => row.to).join(',')}`;
  }).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((value, index) => value !== required[index])) {
    throw new Error(`Source watch schema table ${table} does not have the required composite foreign keys.`);
  }
}

function requireOwnerContext(context: TrustedSourceWatchOwnerContext): void {
  if (typeof context !== 'object' || context === null || !ownedContexts.has(context)) {
    throw new TypeError(
      'Source watch management requires an authentic context from createTrustedSourceWatchOwnerContext().',
    );
  }
}

function requireExecutor(capability: SourceWatchExecutorCapability): void {
  if (typeof capability !== 'object' || capability === null || !executorCapabilities.has(capability)) {
    throw new TypeError(
      'Source watch execution requires an authentic capability from createSourceWatchExecutorCapability().',
    );
  }
}

function assertOnlyFields(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unsupported = Object.keys(input).find((key) => !allowed.has(key));
  if (unsupported) {
    throw new TypeError(`Source watch ${label} cannot accept field "${unsupported}".`);
  }
}

function requireCanonicalRef(input: SourceWatchCanonicalRef): SourceWatchCanonicalRef {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Source watch ref must be a canonical source reference.');
  }
  assertOnlyFields(input as unknown as Record<string, unknown>, CANONICAL_REF_FIELDS, 'canonical ref');
  return {
    corpusId: requireId(input.corpusId, 'ref.corpusId'),
    localItemId: requireCanonicalValue(
      input.localItemId,
      MAX_LOCAL_ITEM_ID_LENGTH,
      'ref.localItemId',
    ),
    sourceVersion: requireCanonicalValue(
      input.sourceVersion,
      MAX_SOURCE_VERSION_LENGTH,
      'ref.sourceVersion',
    ),
  };
}

function requireCanonicalValue(value: string, maxLength: number, field: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || !SAFE_CANONICAL_REF.test(value)
  ) {
    throw new TypeError(`Source watch ${field} must be a bounded canonical value without controls.`);
  }
  return value;
}

function requireRouteKind(value: string): SourceWatchRouteKind {
  if (value !== 'openclaw_task' && value !== 'openclaw_channel') {
    throw new TypeError('Source watch routeKind must be openclaw_task or openclaw_channel.');
  }
  return value;
}

function requireRouteTarget(kind: SourceWatchRouteKind, value: string): string {
  if (kind === 'openclaw_task') {
    if (typeof value !== 'string' || !SAFE_UUID.test(value)) {
      throw new TypeError('Source watch openclaw_task target must be a canonical lowercase task UUID.');
    }
    return value;
  }
  if (typeof value !== 'string' || !SAFE_CHANNEL_TARGET.test(value)) {
    throw new TypeError(
      'Source watch openclaw_channel target must be a supported channel-prefixed canonical id.',
    );
  }
  return value;
}

function requireMode(value: string): SourceWatchMode {
  if (value !== 'continuous' && value !== 'one_shot') {
    throw new TypeError('Source watch mode must be continuous or one_shot.');
  }
  return value;
}

function requireId(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`Source watch ${field} must be a safe identifier.`);
  }
  return value;
}

function requireUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_UUID.test(value)) {
    throw new TypeError(`Source watch ${field} must be a canonical lowercase UUID.`);
  }
  return value;
}

function requireToken(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) {
    throw new TypeError(`Source watch ${field} must be a safe categorical token.`);
  }
  return value;
}

function requireHash(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_HASH.test(value)) {
    throw new TypeError(`Source watch ${field} must be a SHA-256 hexadecimal digest.`);
  }
  return value;
}

function requireQuery(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > SOURCE_WATCH_MAX_QUERY_LENGTH) {
    throw new TypeError(`Source watch queryText must contain 1-${SOURCE_WATCH_MAX_QUERY_LENGTH} characters.`);
  }
  return value;
}

function requireFutureDeadline(value: string, now: string, field: string): string {
  const normalized = requireTimestamp(value, field);
  const delta = Date.parse(normalized) - Date.parse(now);
  if (delta <= 0 || delta > MAX_WATCH_LIFETIME_MS) {
    throw new TypeError(`Source watch ${field} must be in the future and within five years.`);
  }
  return normalized;
}

function requireSourceObservedAt(value: string, now: string): string {
  const normalized = requireTimestamp(value, 'sourceObservedAt');
  if (Date.parse(normalized) > Date.parse(now) + MAX_SOURCE_CLOCK_SKEW_MS) {
    throw new TypeError('Source watch sourceObservedAt is beyond the allowed future clock skew.');
  }
  return normalized;
}

function requireTimestamp(value: string, field: string): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Source watch ${field} must be a valid timestamp.`);
  }
  return new Date(value).toISOString();
}

function requireAvailableDelay(value: number | undefined): number {
  if (value === undefined) return 0;
  return requireBoundedInteger(value, 0, MAX_AVAILABLE_DELAY_MS, 'availableAfterMs');
}

function requireMaxAttempts(value: number): number {
  return requireBoundedInteger(value, 1, MAX_DELIVERY_ATTEMPTS, 'maxDeliveryAttempts');
}

function requirePageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  return requireBoundedInteger(value, 1, MAX_PAGE_SIZE, 'limit');
}

function requireMaintenanceLimit(value: number | undefined): number {
  if (value === undefined) return MAX_PAGE_SIZE;
  return requireBoundedInteger(value, 1, MAX_MAINTENANCE_BATCH, 'limit');
}

function requireBoundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Source watch ${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Source watch ${field} must be a positive safe integer.`);
  }
  return value;
}

function requireOutboxStatus(value: string): SourceWatchOutboxStatus {
  if (!OUTBOX_STATUS_VALUES.has(value)) {
    throw new TypeError('Source watch status filter is not a valid outbox status.');
  }
  return value as SourceWatchOutboxStatus;
}

function requireNotBefore(now: string, earlier: string, label: string): void {
  if (now < earlier) {
    throw new Error(`Source watch store clock moved backward before ${label}.`);
  }
}

function requireFence(
  row: OutboxRow,
  capability: SourceWatchExecutorCapability,
  leaseToken: string,
  leaseGeneration: number,
  requireLiveLease: boolean,
  now: string,
): void {
  if (
    row.lease_owner !== capability.executorId
    || row.lease_token !== leaseToken
    || row.lease_generation !== leaseGeneration
  ) {
    throw new Error('Source watch delivery lease fence is stale or belongs to another executor.');
  }
  if (requireLiveLease) {
    if (row.status !== 'leased') {
      throw new Error('Source watch delivery is not actively leased.');
    }
    if (row.lease_expires_at === null || row.lease_expires_at <= now) {
      throw new Error('Source watch delivery lease has expired.');
    }
  }
}

function decodeWatch(row: WatchRow): PersistedSourceWatch {
  if (!WATCH_STATUS_VALUES.has(row.status)) throw new Error('Source watch row has an invalid status.');
  return {
    watchId: row.watch_id,
    corpusId: row.corpus_id,
    queryText: row.query_text,
    mode: row.mode as SourceWatchMode,
    status: row.status as SourceWatchStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
    ...(row.cancel_reason === null ? {} : { cancelReason: row.cancel_reason }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    maxDeliveryAttempts: row.max_delivery_attempts,
  };
}

function decodeWatermark(row: WatermarkRow): SourceWatchWatermark {
  return {
    watchId: row.watch_id,
    ref: {
      corpusId: row.corpus_id,
      localItemId: row.local_item_id,
      sourceVersion: row.source_version,
    },
    sourceObservedAt: row.source_observed_at,
    recordedAt: row.recorded_at,
  };
}

function decodeMatch(row: MatchRow): SourceWatchMatch {
  return {
    deliveryKey: row.delivery_key,
    watchId: row.watch_id,
    ref: {
      corpusId: row.corpus_id,
      localItemId: row.local_item_id,
      sourceVersion: row.source_version,
    },
    matchedAt: row.matched_at,
  };
}

function decodeOutbox(row: OutboxRow): SourceWatchOutboxEntry {
  if (!OUTBOX_STATUS_VALUES.has(row.status)) throw new Error('Source watch outbox row has an invalid status.');
  return {
    deliveryKey: row.delivery_key,
    watchId: row.watch_id,
    corpusId: row.corpus_id,
    status: row.status as SourceWatchOutboxStatus,
    availableAt: row.available_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    leaseGeneration: row.lease_generation,
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.last_error_kind === null ? {} : { lastErrorKind: row.last_error_kind }),
    ...(row.last_error_hash === null ? {} : { lastErrorHash: row.last_error_hash }),
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    ...(row.dead_lettered_at === null ? {} : { deadLetteredAt: row.dead_lettered_at }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeDeliveryLease(row: DeliveryLeaseRow): SourceWatchDeliveryLease {
  const outbox = decodeOutbox(row);
  if (
    outbox.status !== 'leased'
    || row.lease_token === null
    || row.lease_expires_at === null
    || row.lease_owner === null
  ) {
    throw new Error('Source watch delivery row is not a valid lease.');
  }
  return {
    ...outbox,
    status: 'leased',
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    downstreamIdempotencyKey: row.delivery_key,
    matchedAt: row.matched_at,
    queryText: requireQuery(row.query_text),
    watchMode: requireMode(row.mode),
    ref: {
      corpusId: row.corpus_id,
      localItemId: row.local_item_id,
      sourceVersion: row.source_version,
    },
    route: {
      ownerId: row.owner_id,
      kind: requireRouteKind(row.route_kind),
      targetId: requireRouteTarget(requireRouteKind(row.route_kind), row.route_target_id),
      ...(row.route_account_id === null ? {} : { accountId: row.route_account_id }),
    },
  };
}

function pageFromRows<Row, Output>(
  rows: Row[],
  hasMore: boolean,
  decode: (row: Row) => Output,
  cursorFor: (row: Row) => { at: string; id: string },
): SourceWatchPage<Output> {
  const items = rows.map(decode);
  if (!hasMore || rows.length === 0) return { items };
  const last = rows.at(-1);
  if (!last) return { items };
  return { items, nextCursor: encodePageCursor(cursorFor(last)) };
}

function encodePageCursor(cursor: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), 'utf8').toString('base64url');
}

function decodePageCursor(value: string | undefined): { at: string; id: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new TypeError('Source watch pagination cursor is invalid.');
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error('shape');
    const at = requireTimestamp(decoded[0] as string, 'cursor timestamp');
    const id = decoded[1];
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) throw new Error('id');
    return { at, id };
  } catch {
    throw new TypeError('Source watch pagination cursor is invalid.');
  }
}

function addMilliseconds(timestamp: string, deltaMs: number): string {
  return new Date(Date.parse(timestamp) + deltaMs).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
