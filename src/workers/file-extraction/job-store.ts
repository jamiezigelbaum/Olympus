/**
 * The generic extraction job side database.
 *
 * The queue lives here, in its own file, and not inside any content store: a
 * job is keyed by corpus plus item identity, so it can outlive the store that
 * happens to hold the item today and can serve any file-storage family. That
 * is also why there is no foreign key anywhere in this schema — there is no
 * local table to point at.
 *
 * Two constraints shape this module and are not negotiable:
 *
 *   - `busy_timeout` is the FIRST pragma on every connection. Anything ahead
 *     of it runs with timeout 0, so an open that lands inside another
 *     process's close-time checkpoint fails instantly instead of waiting.
 *   - Closing goes through `closeSqliteStore`, never a bare `db.close()`, so
 *     the file is completely checkpointed the moment `close()` returns.
 *
 * Privacy posture, copied from the scheduler state store: there is no
 * free-form error column. Callers persist a categorical error kind and a
 * hexadecimal digest, never raw error text, so private content cannot leak
 * into the queue by way of an exception message.
 *
 * Lease, retry and janitor semantics are a straight port of the queue that
 * runs in production today, deliberately preserved rather than improved:
 * eligibility predicate, atomic conditional claim, attempt accounting, linear
 * backoff, terminal escalation at three attempts, one-terminal-requeue-ever
 * with a network-error override, and the escalate-to-another-extractor pass.
 *
 * Doc comments in this directory are always multi-line: the architecture
 * guard's regex-literal heuristic reads a one-line block comment as a regex.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  assertSqliteSchemaCanOpen,
  runSqliteMigrations,
  type SqliteMigration,
} from '../../core/sqlite-migrations.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import type {
  ExtractionClaim,
  ExtractionDerivation,
  ExtractionItemRef,
  ExtractionJobStatus,
  ExtractionPolicyDecision,
  ExtractionTerminalStatus,
} from './types.ts';

export const FILE_EXTRACTION_JOBS_STORE_ID = 'file-extraction-jobs';
export const FILE_EXTRACTION_JOBS_SCHEMA_VERSION = 3;
export const FILE_EXTRACTION_JOBS_DB_PATH_ENV = 'OLYMPUS_FILE_EXTRACTION_JOBS_DB_PATH';

/**
 * Lease, retry and janitor constants, ported verbatim from the queue running
 * in production today. Changing one of these is a behaviour change to a live
 * lane, not a tuning knob.
 */
export const DEFAULT_EXTRACTION_LEASE_LIMIT = 10;
export const MAX_EXTRACTION_LEASE_LIMIT = 500;
export const DEFAULT_EXTRACTION_LEASE_SECONDS = 900;
export const MAX_EXTRACTION_LEASE_SECONDS = 3_600;
export const DEFAULT_EXTRACTION_RETRY_BACKOFF_SECONDS = 300;
export const MAX_EXTRACTION_RETRY_BACKOFF_SECONDS = 3_600;
export const MAX_EXTRACTION_RETRY_ATTEMPTS = 3;

/**
 * The transcription lane keeps its own lease defaults: its units are minutes
 * of audio, not kilobytes of text, so it leases fewer jobs for far longer.
 * Folding it into this queue is what gains it the janitor, the backoff and the
 * atomic claim that its own table never had.
 */
export const DEFAULT_TRANSCRIPTION_LEASE_LIMIT = 2;
export const MAX_TRANSCRIPTION_LEASE_LIMIT = 100;
export const DEFAULT_TRANSCRIPTION_LEASE_SECONDS = 1_800;
export const MAX_TRANSCRIPTION_LEASE_SECONDS = 14_400;

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 10_000;
const DEFAULT_READ_ONLY_SQLITE_BUSY_TIMEOUT_MS = 250;
const DEFAULT_JANITOR_LIMIT = 100;
const MAX_JANITOR_LIMIT = 5_000;
const DEFAULT_RECYCLE_LIMIT = 50;
const MAX_RECYCLE_LIMIT = 500;
const MAX_REASON_LENGTH = 256;

/**
 * Error kind stamped by the recycle pass, and the one value that resets the
 * attempt counter to 1 on the next claim: a lease recycled because the backend
 * was paused is not the job's fault and must not burn its retry budget.
 */
const RECYCLED_ERROR_KIND = 'provider_pause_recycled';
const JANITOR_RETRYABLE_ERROR_KIND = 'janitor_retryable_requeued';
const JANITOR_TERMINAL_ERROR_KIND = 'janitor_terminal_requeued';

/**
 * Error kinds that describe the transport rather than the item. A job that
 * died on one of these may be requeued past the one-terminal-requeue-ever
 * guard, because the failure says nothing about whether the item is
 * extractable.
 */
const NETWORK_ERROR_KINDS: ReadonlySet<string> = new Set([
  'network_unreachable',
  'network_socket_closed',
]);

const SAFE_TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SAFE_KEY_PART = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SAFE_HASH = /^[a-f0-9]{16,128}$/;

const POLICY_DECISIONS: ReadonlySet<string> = new Set([
  'index_allowed',
  'index_redacted',
  'metadata_only',
  'blocked_sensitive',
  'needs_review',
]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'indexed',
  'metadata_only',
  'skipped_unsupported',
  'skipped_too_large',
  'blocked_policy',
  'failed_retryable',
  'failed_terminal',
]);

// --- Request and result shapes --------------------------------------------

export interface FileExtractionJobStoreOptions {
  readonly?: boolean;
  busyTimeoutMs?: number;
}

/**
 * Lane coordinates. Every read and write in this store is scoped to one lane,
 * so a pass over one corpus can never touch another's jobs.
 */
export interface ExtractionLaneKey {
  corpusId: string;
  provider: string;
  accountScope: string;
  approvedScopeKey: string;
}

export interface EnqueueExtractionJobsRequest {
  refs: readonly ExtractionItemRef[];
  extractorKind: string;
  extractorVersion: string;
  /**
   * Absent means "this pass has nothing to say about policy", which leaves an
   * existing job's stored decision untouched. It is not a way to assert the
   * permissive decision: that leg of the egress gate may only be relaxed by a
   * caller that names the decision it wants.
   */
  policyDecision?: ExtractionPolicyDecision;
  priority?: number;
  maxBytesPerFile?: number;
  /**
   * Reset an existing job back to queued, clearing its lease, attempts and
   * error state. Used by the requalify passes, never by ordinary enqueue.
   */
  force?: boolean;
}

export interface EnqueueExtractionJobRef {
  jobId: string;
  status: ExtractionJobStatus;
}

export interface EnqueueExtractionJobsResult {
  jobsQueued: number;
  jobsExisting: number;
  jobsForced: number;
  jobsSkippedTooLarge: number;
  jobRefs: readonly EnqueueExtractionJobRef[];
}

export interface LeaseExtractionJobsRequest extends ExtractionLaneKey {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  extractorKind?: string;
  extractorVersion?: string;
  providerItemIds?: readonly string[];
}

export interface LeasedExtractionJob {
  jobId: string;
  ref: ExtractionItemRef;
  extractorKind: string;
  extractorVersion: string;
  policyDecision: ExtractionPolicyDecision;
  maxBytesPerFile?: number;
  attempts: number;
  leaseExpiresAt: string;
  leaseToken: string;
  /**
   * The sequence space `grantOrdinal` counts in: this database, as minted at
   * migration time. Two ordinals may only be compared when their authorities
   * are equal.
   */
  grantAuthority: string;
  /**
   * Strictly increasing across every claim this database has ever granted. The
   * token says WHICH claim call; this says WHEN, in an order a second database
   * — the corpus this job's text lands in — can compare without holding a
   * transaction over the queue.
   */
  grantOrdinal: number;
}

export interface LeaseExtractionJobsResult {
  corpusId: string;
  provider: string;
  accountScope: string;
  scopeKeyHash: string;
  workerIdHash: string;
  leasedJobs: readonly LeasedExtractionJob[];
}

export interface RecordExtractionJobRequest {
  jobId: string;
  /**
   * The worker that holds the lease. When supplied it must match, which is how
   * a worker whose lease expired and was re-claimed elsewhere is refused
   * instead of overwriting the newer holder's result.
   */
  workerId?: string;
  /**
   * The token the claim minted, which is what actually separates two
   * overlapping runs: a whole process shares one worker id, so the identity
   * check alone cannot tell a superseded run from the current holder. A
   * re-claim mints a fresh token — and unlike an expiry timestamp, two
   * claims granted in the same millisecond can never mint the same token.
   */
  leaseToken?: string;
  status: ExtractionTerminalStatus;
  /**
   * Categorical token only. Raw error text never enters this store.
   */
  errorKind?: string;
  errorHash?: string;
  derivations?: readonly ExtractionDerivation[];
  tempBytesCleaned?: boolean;
}

export interface RecordExtractionJobResult {
  jobId: string;
  status: ExtractionTerminalStatus;
  attempts: number;
  nextRetryAt?: string;
  artifactsRecorded: number;
}

export interface RecycleExtractionLeasesRequest extends ExtractionLaneKey {
  extractorKindPrefix: string;
  limit?: number;
  /**
   * Recycle only leases whose expiry has already passed. False reclaims live
   * leases too, which is what a paused backend needs.
   */
  staleOnly?: boolean;
  dryRun?: boolean;
}

export interface RecycleExtractionLeasesResult {
  extractorKindPrefix: string;
  matchedJobs: number;
  jobsRequeued: number;
  dryRun: boolean;
  staleOnly: boolean;
}

export type ExtractionJanitorMode = 'expired_retryable' | 'terminal_reclassification';

export interface JanitorRequeueExtractionJobsRequest extends ExtractionLaneKey {
  mode: ExtractionJanitorMode;
  reason: string;
  extractorKind?: string;
  extractorKindPrefix?: string;
  lastErrorKind?: string;
  /**
   * Present only for escalation: requeue the matched jobs under a DIFFERENT
   * extractor rather than retrying the one that already failed terminally.
   */
  targetExtractorKind?: string;
  targetExtractorVersion?: string;
  // Maximum new target jobs this pass may create; zero is a valid dry gate.
  escalationBudget?: number;
  limit?: number;
  dryRun?: boolean;
  /**
   * Allow a second terminal requeue when the recorded failure was a network
   * error. Ignored for any other error kind.
   */
  allowNetworkTerminalRequeueAfterPriorJanitor?: boolean;
}

export interface JanitorRequeueExtractionJobsResult {
  mode: ExtractionJanitorMode;
  matchedJobs: number;
  jobsRequeued: number;
  jobsEscalated: number;
  skippedAttemptBudget: number;
  skippedAlreadyJanitorRequeued: number;
  skippedPolicyExcluded: number;
  skippedEscalationBudget: number;
  skippedTargetExists: number;
  networkGuardOverrideUsed: boolean;
  dryRun: boolean;
  reason: string;
}

export interface ExtractionJobRecord {
  jobId: string;
  ref: ExtractionItemRef;
  extractorKind: string;
  extractorVersion: string;
  policyDecision: ExtractionPolicyDecision;
  status: ExtractionJobStatus;
  priority: number;
  attempts: number;
  maxBytesPerFile?: number;
  leasedByHash?: string;
  leasedUntil?: string;
  lastErrorKind?: string;
  lastErrorHash?: string;
  nextRetryAt?: string;
  janitorRequeueCount: number;
  janitorTerminalRequeueCount: number;
  janitorRequeuedAt?: string;
  janitorRequeueReason?: string;
  tempBytesCleaned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionArtifactRecord {
  corpusId: string;
  localItemId: string;
  artifactIndex: number;
  jobId: string;
  extractorKind: string;
  extractorVersion: string;
  derivation: ExtractionDerivation;
  derivedAt: string;
}

export interface ExtractionStatusCount {
  status: ExtractionJobStatus;
  extractorKind: string;
  jobs: number;
}

/**
 * What the shared extraction queue knows about one corpus's readiness, in the
 * factory's own vocabulary and for every lane of that corpus at once.
 *
 * Deliberately corpus-scoped rather than lane-scoped: a status caller asks
 * about a corpus, and which account scopes and approved-scope keys that corpus
 * happens to be enumerated under is a detail of how it was connected.
 *
 * The item counts are DISTINCT items, not jobs, because they answer a question
 * about the corpus's contents. Both exclude any item that also has an
 * `indexed` job: a policy exit explains an ABSENCE of text, so an item
 * something did extract keeps the reading its extraction earned rather than
 * being subtracted out of the denominator while it sits in the numerator.
 */
export interface ExtractionCorpusReadiness {
  /**
   * Items the sensitivity rules refused to extract.
   */
  blockedByPolicyItems: number;
  /**
   * Items the factory is not asked to read: unsupported, oversized, deferred.
   */
  metadataOnlyExpectedItems: number;
  queuedJobs: number;
  leasedJobs: number;
  failedRetryableJobs: number;
  failedTerminalJobs: number;
  /**
   * Failed jobs whose item nothing else has read successfully — the ones that
   * actually cost content. A failure superseded by another extractor's
   * `indexed` job against the same item is history, not homework.
   */
  failedActionableJobs: number;
  retryableDueJobs: number;
  oldestActionableAt?: string;
  newestTerminalProgressAt?: string;
}

interface ExtractionJobSqlRow {
  job_id: string;
  corpus_id: string;
  provider: string;
  account_scope: string;
  approved_scope_key: string;
  provider_item_id: string;
  local_item_id: string;
  source_version: string | null;
  content_hash: string | null;
  name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  extractor_kind: string;
  extractor_version: string;
  policy_decision: string;
  status: string;
  priority: number;
  max_bytes_per_file: number | null;
  attempts: number;
  leased_by_hash: string | null;
  leased_until: string | null;
  lease_token: string | null;
  lease_grant_ordinal: number | null;
  last_error_hash: string | null;
  last_error_kind: string | null;
  next_retry_at: string | null;
  janitor_requeue_count: number;
  janitor_terminal_requeue_count: number;
  janitor_requeued_at: string | null;
  janitor_requeue_reason: string | null;
  temp_bytes_cleaned: number;
  created_at: string;
  updated_at: string;
}

interface ExtractionArtifactSqlRow {
  corpus_id: string;
  local_item_id: string;
  artifact_index: number;
  job_id: string;
  extractor_kind: string;
  extractor_version: string;
  artifact_kind: string;
  structural_ref_json: string | null;
  confidence: number | null;
  warnings_json: string | null;
  chars: number;
  derived_at: string;
}

export function defaultFileExtractionJobsDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[FILE_EXTRACTION_JOBS_DB_PATH_ENV]?.trim();
  if (override) return override;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'file-extraction-jobs.sqlite');
}

/**
 * The generic extraction queue.
 *
 * Exactly one process opens this writable: the private source worker that owns
 * the extraction runtime. The status lane and any offline proof script open it
 * with `readonly: true`, which keeps the single-writer discipline the overnight
 * drain guard arbitrates.
 */
export class LocalFileExtractionJobStore {
  readonly dbPath: string;
  readonly readonly: boolean;
  private readonly db: Database;
  private grantAuthorityId: string | undefined;

  constructor(dbPath = defaultFileExtractionJobsDbPath(), options: FileExtractionJobStoreOptions = {}) {
    this.dbPath = dbPath;
    this.readonly = options.readonly === true;
    const inMemory = dbPath === ':memory:';
    if (!inMemory && !this.readonly) {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = this.readonly
      ? new Database(dbPath, { readonly: true })
      : new Database(dbPath, { create: true });
    if (!inMemory && !this.readonly) chmodSync(dbPath, 0o600);

    const busyTimeoutMs = options.busyTimeoutMs
      ?? (this.readonly ? DEFAULT_READ_ONLY_SQLITE_BUSY_TIMEOUT_MS : DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    // busy_timeout leads. journal_mode takes a lock on the file, so a reader
    // that arrives during another connection's checkpoint must wait rather
    // than fail, and it can only wait if its timeout is already in force.
    if (this.readonly) {
      this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    } else {
      this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;`);
    }

    assertSqliteSchemaCanOpen(this.db, FILE_EXTRACTION_JOBS_STORE_ID, FILE_EXTRACTION_JOBS_SCHEMA_VERSION);
    if (!this.readonly) {
      runSqliteMigrations(this.db, FILE_EXTRACTION_JOBS_STORE_ID, fileExtractionJobMigrations());
    }
  }

  close(): void {
    closeSqliteStore(this.db);
  }

  /**
   * Create or refresh jobs for a batch of refs.
   *
   * There is no "missing item" outcome here, unlike the queue this ports: the
   * enumerating source produced these refs, so there is no local table to look
   * them up in and nothing to fail to find.
   */
  enqueue(request: EnqueueExtractionJobsRequest): EnqueueExtractionJobsResult {
    this.assertWritable('enqueue');
    const extractorKind = requireToken(request.extractorKind, 'extractorKind');
    const extractorVersion = requireKeyPart(request.extractorVersion, 'extractorVersion');
    const policyDecision = requirePolicyDecision(request.policyDecision ?? 'index_allowed');
    const policyDecisionSupplied = request.policyDecision === undefined ? 0 : 1;
    const priority = request.priority === undefined ? 0 : requireSafeInteger(request.priority, 'priority');
    const maxBytesPerFile = request.maxBytesPerFile === undefined
      ? undefined
      : requirePositiveSafeInteger(request.maxBytesPerFile, 'maxBytesPerFile');
    const force = request.force === true;
    const now = nowIso();

    let jobsQueued = 0;
    let jobsExisting = 0;
    let jobsForced = 0;
    let jobsSkippedTooLarge = 0;
    const jobRefs: EnqueueExtractionJobRef[] = [];

    this.db.transaction(() => {
      for (const rawRef of request.refs) {
        const ref = requireItemRef(rawRef);
        const status: ExtractionJobStatus = maxBytesPerFile !== undefined
          && ref.sizeBytes !== undefined
          && ref.sizeBytes > maxBytesPerFile
          ? 'skipped_too_large'
          : 'queued';
        const existing = this.existingJob(ref, extractorKind, extractorVersion);
        const jobId = existing?.job_id ?? makeJobId();
        const forceExisting = Boolean(existing) && force && status === 'queued';
        const reset = forceExisting ? 1 : 0;

        this.db.query(`
          INSERT INTO extraction_jobs (
            job_id, corpus_id, provider, account_scope, approved_scope_key,
            provider_item_id, local_item_id, source_version, content_hash,
            name, mime_type, size_bytes, extractor_kind, extractor_version,
            policy_decision, status, priority, max_bytes_per_file, attempts,
            temp_bytes_cleaned, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
          ON CONFLICT(corpus_id, provider, account_scope, provider_item_id,
                      source_version, content_hash, extractor_kind, extractor_version)
          DO UPDATE SET
            approved_scope_key = excluded.approved_scope_key,
            local_item_id = excluded.local_item_id,
            name = excluded.name,
            mime_type = excluded.mime_type,
            size_bytes = excluded.size_bytes,
            policy_decision = CASE WHEN ? THEN excluded.policy_decision
              ELSE extraction_jobs.policy_decision END,
            status = CASE WHEN ? THEN excluded.status ELSE extraction_jobs.status END,
            priority = MAX(extraction_jobs.priority, excluded.priority),
            max_bytes_per_file = excluded.max_bytes_per_file,
            attempts = CASE WHEN ? THEN 0 ELSE extraction_jobs.attempts END,
            leased_by_hash = CASE WHEN ? THEN NULL ELSE extraction_jobs.leased_by_hash END,
            leased_until = CASE WHEN ? THEN NULL ELSE extraction_jobs.leased_until END,
            lease_token = CASE WHEN ? THEN NULL ELSE extraction_jobs.lease_token END,
            lease_grant_ordinal = CASE WHEN ? THEN NULL
              ELSE extraction_jobs.lease_grant_ordinal END,
            last_error_hash = CASE WHEN ? THEN NULL ELSE extraction_jobs.last_error_hash END,
            last_error_kind = CASE WHEN ? THEN NULL ELSE extraction_jobs.last_error_kind END,
            next_retry_at = CASE WHEN ? THEN NULL ELSE extraction_jobs.next_retry_at END,
            temp_bytes_cleaned = CASE WHEN ? THEN 1 ELSE extraction_jobs.temp_bytes_cleaned END,
            updated_at = excluded.updated_at
        `).run(
          jobId,
          ref.corpusId,
          ref.provider,
          ref.accountScope,
          ref.approvedScopeKey,
          ref.providerItemId,
          ref.localItemId,
          ref.sourceVersion ?? '',
          ref.contentHash ?? '',
          ref.name ?? null,
          ref.mimeType ?? null,
          ref.sizeBytes ?? null,
          extractorKind,
          extractorVersion,
          policyDecision,
          status,
          priority,
          maxBytesPerFile ?? null,
          now,
          now,
          policyDecisionSupplied,
          reset,
          reset,
          reset,
          reset,
          reset,
          reset,
          reset,
          reset,
          reset,
          reset,
        );

        if (forceExisting) {
          jobsForced += 1;
        } else if (existing) {
          jobsExisting += 1;
        } else if (status === 'skipped_too_large') {
          jobsSkippedTooLarge += 1;
        } else {
          jobsQueued += 1;
        }
        jobRefs.push({
          jobId,
          status: forceExisting ? status : jobStatus(existing?.status) ?? status,
        });
      }
    })();

    return { jobsQueued, jobsExisting, jobsForced, jobsSkippedTooLarge, jobRefs };
  }

  /**
   * Claim up to `limit` eligible jobs for one worker.
   *
   * Eligibility, unchanged from the live queue: queued, or leased with an
   * expired lease, or retryable with its backoff elapsed. The claim itself is
   * a conditional UPDATE that re-checks that same predicate, and only rows the
   * UPDATE actually changed are returned, so two workers racing on the same
   * candidate cannot both win it.
   */
  lease(request: LeaseExtractionJobsRequest): LeaseExtractionJobsResult {
    this.assertWritable('lease');
    const lane = requireLaneKey(request);
    const workerId = requireBoundedString(request.workerId, 'workerId');
    const limit = clampInteger(
      request.limit ?? DEFAULT_EXTRACTION_LEASE_LIMIT,
      1,
      MAX_EXTRACTION_LEASE_LIMIT,
    );
    const leaseSeconds = clampInteger(
      request.leaseSeconds ?? DEFAULT_EXTRACTION_LEASE_SECONDS,
      1,
      MAX_EXTRACTION_LEASE_SECONDS,
    );
    const now = nowIso();
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1_000).toISOString();
    // One token per claim call: the fence key record() checks. An expiry
    // timestamp cannot serve — two claims in the same millisecond coincide.
    const leaseToken = randomUUID();
    const workerHash = hashString(workerId);
    const claimed: Array<{ row: ExtractionJobSqlRow; grant: { authority: string; ordinal: number } }> = [];

    this.db.transaction(() => {
      for (const row of this.leaseCandidateRows(lane, request, now, limit)) {
        // One grant PER JOB, not per call. The token is per call because it
        // names the call; the grant is what a corpus compares against the last
        // write it accepted for an item, and two jobs in one batch can target
        // the same item under the same extractor — a shared ordinal would make
        // the second write look like a replay of the first. Minted inside the
        // loop, so an empty poll stays a read.
        const claimGrant = this.mintClaimGrant();
        const claim = this.db.query(`
          UPDATE extraction_jobs
          SET status = 'leased',
              attempts = CASE
                WHEN last_error_kind = ? THEN 1
                ELSE attempts + 1
              END,
              -- The marker is a one-claim grant, so the claim that takes it
              -- clears it. Left in place it re-grants on every later reclaim
              -- and the retry budget never advances past 1.
              last_error_kind = CASE
                WHEN last_error_kind = ? THEN NULL
                ELSE last_error_kind
              END,
              leased_by_hash = ?,
              leased_until = ?,
              lease_token = ?,
              lease_grant_ordinal = ?,
              updated_at = ?
          WHERE job_id = ?
            AND corpus_id = ?
            AND provider = ?
            AND account_scope = ?
            AND approved_scope_key = ?
            AND (
              status = 'queued'
              OR (status = 'leased' AND leased_until IS NOT NULL AND leased_until < ?)
              OR (status = 'failed_retryable' AND (next_retry_at IS NULL OR next_retry_at <= ?))
            )
        `).run(
          RECYCLED_ERROR_KIND,
          RECYCLED_ERROR_KIND,
          workerHash,
          leaseExpiresAt,
          leaseToken,
          claimGrant.ordinal,
          now,
          row.job_id,
          lane.corpusId,
          lane.provider,
          lane.accountScope,
          lane.approvedScopeKey,
          now,
          now,
        );
        if (claim.changes > 0) claimed.push({ row, grant: claimGrant });
      }
    })();

    return {
      corpusId: lane.corpusId,
      provider: lane.provider,
      accountScope: lane.accountScope,
      scopeKeyHash: hashString(lane.approvedScopeKey),
      workerIdHash: workerHash,
      leasedJobs: claimed.map(({ row, grant }) => ({
        jobId: row.job_id,
        ref: refFromRow(row),
        extractorKind: row.extractor_kind,
        extractorVersion: row.extractor_version,
        policyDecision: row.policy_decision as ExtractionPolicyDecision,
        ...(row.max_bytes_per_file === null ? {} : { maxBytesPerFile: row.max_bytes_per_file }),
        attempts: row.last_error_kind === RECYCLED_ERROR_KIND ? 1 : row.attempts + 1,
        leaseExpiresAt,
        leaseToken,
        grantAuthority: grant.authority,
        grantOrdinal: grant.ordinal,
      })),
    };
  }

  /**
   * The next grant in this database's sequence, taken and stamped in one
   * statement so two claims can never share an ordinal.
   *
   * The floor is the wall clock, which the counter alone cannot supply. This
   * file restored from a backup keeps its authority id — it IS the same
   * sequence space — but its counter has gone backwards, and a consumer that
   * already recorded the higher ordinals would refuse every write until the
   * count caught up, burning each job's retry budget on the way. Taking the
   * larger of "one past the counter" and "now in milliseconds" keeps the
   * sequence strictly increasing whichever way the file arrived.
   */
  private mintClaimGrant(): { authority: string; ordinal: number } {
    const row = this.db.query(`
      UPDATE extraction_claim_grants
      SET last_ordinal = MAX(last_ordinal + 1, ?)
      WHERE grant_id = 1
      RETURNING authority_id, last_ordinal
    `).get(Date.now()) as { authority_id: string; last_ordinal: number } | null;
    if (!row) throw new Error('Extraction job store claim grant sequence is missing.');
    return { authority: row.authority_id, ordinal: row.last_ordinal };
  }

  /**
   * This database's grant sequence id. Read once and kept: it is written at
   * migration time and never changes for the life of the file.
   */
  private claimGrantAuthority(): string {
    if (this.grantAuthorityId === undefined) {
      const row = this.db.query(
        'SELECT authority_id FROM extraction_claim_grants WHERE grant_id = 1',
      ).get() as { authority_id: string } | null;
      if (!row) throw new Error('Extraction job store claim grant sequence is missing.');
      this.grantAuthorityId = row.authority_id;
    }
    return this.grantAuthorityId;
  }

  /**
   * Record the outcome of one leased job.
   *
   * The lease is checked twice: the job must still be leased, and the worker
   * recording must be the one holding it. That second check is the store's
   * half of lost-lease handling — a worker whose lease expired and was
   * re-claimed elsewhere is refused here rather than silently overwriting the
   * newer holder's work. The worker's half is to translate that refusal into a
   * retryable outcome without touching the database again.
   */
  record(request: RecordExtractionJobRequest): RecordExtractionJobResult {
    this.assertWritable('record');
    const jobId = requireKeyPart(request.jobId, 'jobId');
    const status = requireTerminalStatus(request.status);
    const errorKind = request.errorKind === undefined ? undefined : requireToken(request.errorKind, 'errorKind');
    const errorHash = request.errorHash === undefined ? undefined : requireHash(request.errorHash);
    const tempBytesCleaned = request.tempBytesCleaned !== false;
    const now = nowIso();

    return this.db.transaction((): RecordExtractionJobResult => {
      const row = this.jobRow(jobId);
      if (!row) throw new Error('Extraction record references an unknown job.');
      if (row.status !== 'leased') throw new Error('Extraction record requires a leased job.');
      if (request.workerId !== undefined && row.leased_by_hash !== null
        && row.leased_by_hash !== hashString(requireBoundedString(request.workerId, 'workerId'))) {
        throw new Error('Extraction record worker does not hold the job lease.');
      }
      if (request.leaseToken !== undefined && row.lease_token !== request.leaseToken) {
        throw new Error('Extraction record worker does not hold the job lease.');
      }

      // Three attempts is the whole retry budget. A retryable failure recorded
      // against an exhausted budget comes to rest as terminal instead of
      // cycling forever.
      const effectiveStatus: ExtractionTerminalStatus =
        status === 'failed_retryable' && row.attempts >= MAX_EXTRACTION_RETRY_ATTEMPTS
          ? 'failed_terminal'
          : status;
      const nextRetryAt = nextRetryTimestamp(effectiveStatus, row.attempts, now);

      this.db.query(`
        UPDATE extraction_jobs
        SET status = ?,
            leased_by_hash = NULL,
            leased_until = NULL,
            lease_token = NULL,
            lease_grant_ordinal = NULL,
            last_error_kind = ?,
            last_error_hash = ?,
            next_retry_at = ?,
            temp_bytes_cleaned = ?,
            updated_at = ?
        WHERE job_id = ?
      `).run(
        effectiveStatus,
        errorKind ?? null,
        errorHash ?? null,
        nextRetryAt,
        tempBytesCleaned ? 1 : 0,
        now,
        jobId,
      );

      const artifactsRecorded = this.replaceArtifacts(row, request.derivations, now);
      return {
        jobId,
        status: effectiveStatus,
        attempts: row.attempts,
        ...(nextRetryAt === null ? {} : { nextRetryAt }),
        artifactsRecorded,
      };
    })();
  }

  /**
   * Return leases to the queue by extractor-kind prefix.
   *
   * This is the paused-backend pass: the jobs are fine, the backend went away.
   * Requeued jobs are stamped with the recycle error kind, which the next
   * claim reads as "do not charge this attempt".
   */
  /**
   * Hand back leases for jobs the runner never attempted, refunding the attempt
   * the lease itself charged.
   *
   * Leasing increments `attempts` up front. That is right for a job about to be
   * tried and wrong for one abandoned because the lane paused mid-batch — three
   * such rounds would otherwise walk an untouched document to its terminal
   * budget without it ever having been sent anywhere.
   *
   * Distinct from `recycleLeases`, which stamps the recycle marker and flattens
   * attempts to 1 on the next claim. Nothing happened to these jobs, so nothing
   * is recorded against them.
   */
  releaseLeasesWithoutAttempt(request: {
    jobIds: readonly string[];
    workerId?: string;
    /**
     * The token of the grant being handed back. Required and checked, the same
     * fence `record` uses: the fleet shares one worker id, so the hash cannot
     * tell this claim from the one that superseded it after a lease expired.
     * Unfenced, a batch that lost its lease releases the live claimant's job
     * and refunds an attempt that claimant is actively spending.
     */
    leaseToken: string;
  }): { releasedJobs: number } {
    this.assertWritable('lease release');
    const leaseToken = requireBoundedString(request.leaseToken, 'leaseToken');
    const jobIds = [...new Set(request.jobIds.map((jobId) => jobId?.trim()).filter(Boolean))] as string[];
    if (jobIds.length === 0) return { releasedJobs: 0 };
    const workerHash = request.workerId === undefined
      ? null
      : hashString(requireBoundedString(request.workerId, 'workerId'));
    const now = nowIso();
    let released = 0;
    this.db.transaction(() => {
      const update = this.db.query(`
        UPDATE extraction_jobs
        SET status = 'queued',
            leased_by_hash = NULL,
            leased_until = NULL,
            lease_token = NULL,
            lease_grant_ordinal = NULL,
            attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
            updated_at = ?
        WHERE job_id = ?
          AND status = 'leased'
          AND lease_token = ?
          AND (? IS NULL OR leased_by_hash IS NULL OR leased_by_hash = ?)
      `);
      for (const jobId of jobIds) {
        released += update.run(now, jobId, leaseToken, workerHash, workerHash).changes;
      }
    })();
    return { releasedJobs: released };
  }

  recycleLeases(request: RecycleExtractionLeasesRequest): RecycleExtractionLeasesResult {
    this.assertWritable('lease recycle');
    const lane = requireLaneKey(request);
    const prefix = requireToken(request.extractorKindPrefix, 'extractorKindPrefix');
    const limit = clampInteger(request.limit ?? DEFAULT_RECYCLE_LIMIT, 1, MAX_RECYCLE_LIMIT);
    const staleOnly = request.staleOnly === true;
    const dryRun = request.dryRun === true;
    const now = nowIso();
    let matched: Array<{ job_id: string }> = [];

    this.db.transaction(() => {
      const params: Array<string | number> = [
        lane.corpusId,
        lane.provider,
        lane.accountScope,
        lane.approvedScopeKey,
        prefix.length,
        prefix,
      ];
      if (staleOnly) params.push(now);
      params.push(limit);
      matched = this.db.query(`
        SELECT job_id
        FROM extraction_jobs
        WHERE corpus_id = ?
          AND provider = ?
          AND account_scope = ?
          AND approved_scope_key = ?
          AND status = 'leased'
          AND substr(extractor_kind, 1, ?) = ?
          ${staleOnly ? 'AND leased_until IS NOT NULL AND leased_until <= ?' : ''}
        ORDER BY updated_at ASC, job_id ASC
        LIMIT ?
      `).all(...params) as Array<{ job_id: string }>;

      if (dryRun || matched.length === 0) return;
      const update = this.db.query(`
        UPDATE extraction_jobs
        SET status = 'queued',
            leased_by_hash = NULL,
            leased_until = NULL,
            lease_token = NULL,
            lease_grant_ordinal = NULL,
            last_error_kind = ?,
            next_retry_at = NULL,
            updated_at = ?
        WHERE job_id = ?
      `);
      for (const row of matched) update.run(RECYCLED_ERROR_KIND, now, row.job_id);
    })();

    return {
      extractorKindPrefix: prefix,
      matchedJobs: matched.length,
      jobsRequeued: dryRun ? 0 : matched.length,
      dryRun,
      staleOnly,
    };
  }

  /**
   * The two janitor passes.
   *
   * `expired_retryable` sweeps jobs whose backoff has elapsed, filtered by the
   * attempt budget so an exhausted job is counted rather than cycled.
   *
   * `terminal_reclassification` reopens terminally-failed jobs whose failure
   * has since been understood, matched on exact extractor kind AND exact error
   * kind, and allowed only once per job ever — unless the failure was a
   * network error, which says nothing about the item. Supplying a target
   * extractor kind escalates to a different extractor instead of retrying the
   * same one.
   */
  janitorRequeue(request: JanitorRequeueExtractionJobsRequest): JanitorRequeueExtractionJobsResult {
    this.assertWritable('janitor requeue');
    const lane = requireLaneKey(request);
    const reason = requireReason(request.reason);
    const limit = clampInteger(request.limit ?? DEFAULT_JANITOR_LIMIT, 1, MAX_JANITOR_LIMIT);
    const dryRun = request.dryRun === true;

    if (request.mode === 'terminal_reclassification' && request.targetExtractorKind !== undefined) {
      return this.janitorEscalate(lane, request, reason, limit, dryRun);
    }

    const lastErrorKind = request.lastErrorKind === undefined
      ? undefined
      : requireToken(request.lastErrorKind, 'lastErrorKind');
    const extractorKind = request.extractorKind === undefined
      ? undefined
      : requireToken(request.extractorKind, 'extractorKind');
    const extractorKindPrefix = request.extractorKindPrefix === undefined
      ? undefined
      : requireToken(request.extractorKindPrefix, 'extractorKindPrefix');
    if (request.mode === 'terminal_reclassification' && (!extractorKind || !lastErrorKind)) {
      throw new TypeError('Terminal reclassification requires both extractorKind and lastErrorKind.');
    }

    const networkOverride = request.allowNetworkTerminalRequeueAfterPriorJanitor === true
      && lastErrorKind !== undefined
      && NETWORK_ERROR_KINDS.has(lastErrorKind);
    const now = nowIso();
    let matched: Array<{ job_id: string; attempts: number }> = [];
    let skippedAttemptBudget = 0;
    let skippedAlreadyJanitorRequeued = 0;

    this.db.transaction(() => {
      const filters = [
        'corpus_id = ?',
        'provider = ?',
        'account_scope = ?',
        'approved_scope_key = ?',
      ];
      const params: Array<string | number> = [
        lane.corpusId,
        lane.provider,
        lane.accountScope,
        lane.approvedScopeKey,
      ];
      if (request.mode === 'expired_retryable') {
        filters.push("status = 'failed_retryable'");
        filters.push('(next_retry_at IS NULL OR next_retry_at <= ?)');
        params.push(now);
        if (extractorKindPrefix) {
          filters.push('substr(extractor_kind, 1, ?) = ?');
          params.push(extractorKindPrefix.length, extractorKindPrefix);
        }
      } else {
        filters.push("status = 'failed_terminal'");
        filters.push('extractor_kind = ?');
        filters.push('COALESCE(last_error_kind, ?) = ?');
        params.push(extractorKind!, lastErrorKind!, lastErrorKind!);
        if (!networkOverride) {
          filters.push('COALESCE(janitor_terminal_requeue_count, 0) < 1');
        }
      }

      matched = this.db.query(`
        SELECT job_id, attempts
        FROM extraction_jobs
        WHERE ${filters.join(' AND ')}
        ORDER BY updated_at ASC, job_id ASC
        LIMIT ?
      `).all(...params, limit) as Array<{ job_id: string; attempts: number }>;

      if (request.mode === 'terminal_reclassification' && !networkOverride) {
        const skipped = this.db.query(`
          SELECT COUNT(*) AS count
          FROM extraction_jobs
          WHERE corpus_id = ?
            AND provider = ?
            AND account_scope = ?
            AND approved_scope_key = ?
            AND status = 'failed_terminal'
            AND extractor_kind = ?
            AND COALESCE(last_error_kind, ?) = ?
            AND COALESCE(janitor_terminal_requeue_count, 0) >= 1
        `).get(
          lane.corpusId,
          lane.provider,
          lane.accountScope,
          lane.approvedScopeKey,
          extractorKind!,
          lastErrorKind!,
          lastErrorKind!,
        ) as { count: number };
        skippedAlreadyJanitorRequeued = skipped.count;
      }

      const eligible = request.mode === 'expired_retryable'
        ? matched.filter((row) => row.attempts < MAX_EXTRACTION_RETRY_ATTEMPTS)
        : matched;
      skippedAttemptBudget = matched.length - eligible.length;
      if (dryRun || eligible.length === 0) return;

      const terminal = request.mode === 'terminal_reclassification' ? 1 : 0;
      const stampedErrorKind = request.mode === 'terminal_reclassification'
        ? JANITOR_TERMINAL_ERROR_KIND
        : JANITOR_RETRYABLE_ERROR_KIND;
      const update = this.db.query(`
        UPDATE extraction_jobs
        SET status = 'queued',
            leased_by_hash = NULL,
            leased_until = NULL,
            lease_token = NULL,
            lease_grant_ordinal = NULL,
            last_error_kind = ?,
            next_retry_at = NULL,
            janitor_requeue_count = COALESCE(janitor_requeue_count, 0) + 1,
            janitor_terminal_requeue_count = CASE
              WHEN ? THEN COALESCE(janitor_terminal_requeue_count, 0) + 1
              ELSE COALESCE(janitor_terminal_requeue_count, 0)
            END,
            janitor_requeued_at = ?,
            janitor_requeue_reason = ?,
            updated_at = ?
        WHERE job_id = ?
      `);
      for (const row of eligible) update.run(stampedErrorKind, terminal, now, reason, now, row.job_id);
    })();

    return {
      mode: request.mode,
      matchedJobs: matched.length,
      jobsRequeued: dryRun ? 0 : Math.max(0, matched.length - skippedAttemptBudget),
      jobsEscalated: 0,
      skippedAttemptBudget,
      skippedAlreadyJanitorRequeued,
      skippedPolicyExcluded: 0,
      skippedEscalationBudget: 0,
      skippedTargetExists: 0,
      networkGuardOverrideUsed: networkOverride,
      dryRun,
      reason,
    };
  }

  get(jobId: string): ExtractionJobRecord | undefined {
    const row = this.jobRow(requireKeyPart(jobId, 'jobId'));
    return row ? recordFromRow(row) : undefined;
  }

  /**
   * Does this claim still hold its job, RIGHT NOW?
   *
   * The same two conditions `record()` enforces — still leased, still this
   * token — read without settling anything, so a caller can ask before it does
   * something it cannot undo. `record()` is the only other place that can
   * answer this and it answers by writing, which is too late for the corpus.
   *
   * Deliberately not exposed through `get()`: `ExtractionJobRecord` does not
   * carry `lease_token`, and it should not start to. The token is a capability,
   * not a status field, and handing it back out would let a caller forge the
   * comparison this method exists to make on its behalf.
   *
   * An unknown job answers false. This is one connection's view of a database
   * another process may be writing, so a true answer means the claim held at
   * the moment of the read — which is why the caller must do the irreversible
   * thing immediately after, and why the store's own fence stays in place.
   */
  holdsExtractionClaim(claim: ExtractionClaim): boolean {
    const row = this.jobRow(requireKeyPart(claim.jobId, 'jobId'));
    if (!row) return false;
    // The grant is checked as well as the token, and against THIS database's
    // sequence: a claim minted by another queue names a job this store never
    // granted, whatever its token happens to say.
    return row.status === 'leased'
      && row.lease_token !== null
      && row.lease_token === requireBoundedString(claim.leaseToken, 'leaseToken')
      && row.lease_grant_ordinal !== null
      && row.lease_grant_ordinal === claim.grantOrdinal
      && claim.grantAuthority === this.claimGrantAuthority();
  }

  /**
   * Job counts per status and extractor kind, for the status lane.
   */
  counts(lane: ExtractionLaneKey): ExtractionStatusCount[] {
    const key = requireLaneKey(lane);
    const rows = this.db.query(`
      SELECT status, extractor_kind, COUNT(*) AS jobs
      FROM extraction_jobs
      WHERE corpus_id = ? AND provider = ? AND account_scope = ? AND approved_scope_key = ?
      GROUP BY status, extractor_kind
      ORDER BY status ASC, extractor_kind ASC
    `).all(
      key.corpusId,
      key.provider,
      key.accountScope,
      key.approvedScopeKey,
    ) as Array<{ status: string; extractor_kind: string; jobs: number }>;
    return rows.flatMap((row) => {
      const status = jobStatus(row.status);
      return status ? [{ status, extractorKind: row.extractor_kind, jobs: row.jobs }] : [];
    });
  }

  /**
   * One corpus's readiness, across every lane it is enumerated under.
   *
   * Two statements, one pass each, both served by
   * `idx_extraction_jobs_item(corpus_id, local_item_id, status)`: the per-item
   * roll-up that decides the policy exits, and the per-status job tally the
   * queue ladder reads.
   */
  corpusReadiness(corpusId: string, now: Date = new Date()): ExtractionCorpusReadiness {
    const corpus = requireKeyPart(corpusId, 'corpusId');
    const items = this.db.query(`
      WITH item_state AS (
        SELECT
          MAX(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) AS indexed_jobs,
          MAX(CASE WHEN status = 'blocked_policy' THEN 1 ELSE 0 END) AS blocked_jobs,
          MAX(CASE WHEN status IN ('metadata_only', 'skipped_unsupported', 'skipped_too_large')
              THEN 1 ELSE 0 END) AS metadata_only_jobs
        FROM extraction_jobs
        WHERE corpus_id = ?
        GROUP BY local_item_id
      )
      SELECT
        SUM(CASE WHEN indexed_jobs = 0 AND blocked_jobs = 1 THEN 1 ELSE 0 END) AS blocked_items,
        SUM(CASE WHEN indexed_jobs = 0 AND blocked_jobs = 0 AND metadata_only_jobs = 1
            THEN 1 ELSE 0 END) AS metadata_only_items
      FROM item_state
    `).get(corpus) as { blocked_items: number | null; metadata_only_items: number | null } | null;
    const jobs = this.db.query(`
      SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_jobs,
        SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased_jobs,
        SUM(CASE WHEN status = 'failed_retryable' THEN 1 ELSE 0 END) AS failed_retryable_jobs,
        SUM(CASE WHEN status = 'failed_terminal' THEN 1 ELSE 0 END) AS failed_terminal_jobs,
        SUM(CASE WHEN status = 'failed_retryable'
          AND (next_retry_at IS NULL OR next_retry_at <= ?) THEN 1 ELSE 0 END) AS retryable_due_jobs,
        MIN(CASE WHEN status = 'queued'
          OR (status = 'failed_retryable' AND (next_retry_at IS NULL OR next_retry_at <= ?))
          THEN created_at END) AS oldest_actionable_at,
        MAX(CASE WHEN status IN (
          'indexed', 'metadata_only', 'skipped_unsupported', 'skipped_too_large',
          'blocked_policy', 'failed_terminal'
        ) THEN updated_at END) AS newest_terminal_progress_at,
        SUM(CASE
          WHEN status IN ('failed_retryable', 'failed_terminal')
            AND NOT EXISTS (
              SELECT 1 FROM extraction_jobs superseding
              WHERE superseding.corpus_id = j.corpus_id
                AND superseding.local_item_id = j.local_item_id
                AND superseding.job_id <> j.job_id
                AND superseding.status = 'indexed'
            )
          THEN 1 ELSE 0 END) AS failed_actionable_jobs
      FROM extraction_jobs j
      WHERE corpus_id = ?
    `).get(now.toISOString(), now.toISOString(), corpus) as Record<string, number | string | null> | null;
    const count = (value: number | null | undefined): number => Math.max(0, Math.trunc(value ?? 0));
    const jobCount = (key: string): number => count(typeof jobs?.[key] === 'number' ? jobs[key] : undefined);
    return {
      blockedByPolicyItems: count(items?.blocked_items),
      metadataOnlyExpectedItems: count(items?.metadata_only_items),
      queuedJobs: jobCount('queued_jobs'),
      leasedJobs: jobCount('leased_jobs'),
      failedRetryableJobs: jobCount('failed_retryable_jobs'),
      failedTerminalJobs: jobCount('failed_terminal_jobs'),
      failedActionableJobs: jobCount('failed_actionable_jobs'),
      retryableDueJobs: jobCount('retryable_due_jobs'),
      ...(typeof jobs?.oldest_actionable_at === 'string' ? { oldestActionableAt: jobs.oldest_actionable_at } : {}),
      ...(typeof jobs?.newest_terminal_progress_at === 'string'
        ? { newestTerminalProgressAt: jobs.newest_terminal_progress_at }
        : {}),
    };
  }

  /**
   * Structural provenance for one item: which pages, sheets or slides the text
   * came from, and how confident the extractor was about each.
   */
  artifacts(corpusId: string, localItemId: string): ExtractionArtifactRecord[] {
    const rows = this.db.query(`
      SELECT *
      FROM extraction_artifacts
      WHERE corpus_id = ? AND local_item_id = ?
      ORDER BY artifact_index ASC
    `).all(
      requireKeyPart(corpusId, 'corpusId'),
      requireBoundedString(localItemId, 'localItemId'),
    ) as ExtractionArtifactSqlRow[];
    return rows.map((row) => artifactFromRow(row));
  }

  private janitorEscalate(
    lane: ExtractionLaneKey,
    request: JanitorRequeueExtractionJobsRequest,
    reason: string,
    limit: number,
    dryRun: boolean,
  ): JanitorRequeueExtractionJobsResult {
    const extractorKind = requireToken(request.extractorKind ?? '', 'extractorKind');
    const lastErrorKind = requireToken(request.lastErrorKind ?? '', 'lastErrorKind');
    const targetKind = requireToken(request.targetExtractorKind ?? '', 'targetExtractorKind');
    const targetVersion = requireKeyPart(request.targetExtractorVersion ?? '', 'targetExtractorVersion');
    const escalationBudget = clampInteger(request.escalationBudget ?? limit, 0, limit);
    const now = nowIso();
    let matched: Array<ExtractionJobSqlRow & { target_job_exists: number }> = [];
    let escalated = 0;
    let skippedPolicyExcluded = 0;
    let skippedEscalationBudget = 0;
    let skippedTargetExists = 0;

    this.db.transaction(() => {
      matched = this.db.query(`
        SELECT
          j.*,
          EXISTS (
            SELECT 1
            FROM extraction_jobs target
            WHERE target.corpus_id = j.corpus_id
              AND target.provider = j.provider
              AND target.account_scope = j.account_scope
              AND target.provider_item_id = j.provider_item_id
              AND target.source_version IS j.source_version
              AND target.content_hash IS j.content_hash
              AND target.extractor_kind = ?
              AND target.extractor_version = ?
          ) AS target_job_exists
        FROM extraction_jobs j
        WHERE j.corpus_id = ?
          AND j.provider = ?
          AND j.account_scope = ?
          AND j.approved_scope_key = ?
          AND j.status = 'failed_terminal'
          AND j.extractor_kind = ?
          AND COALESCE(j.last_error_kind, ?) = ?
        ORDER BY j.updated_at ASC, j.job_id ASC
        LIMIT ?
      `).all(
        targetKind,
        targetVersion,
        lane.corpusId,
        lane.provider,
        lane.accountScope,
        lane.approvedScopeKey,
        extractorKind,
        lastErrorKind,
        lastErrorKind,
        limit,
      ) as Array<ExtractionJobSqlRow & { target_job_exists: number }>;

      const policyAllowed = matched.filter((row) => (
        row.policy_decision !== 'blocked_sensitive' && row.policy_decision !== 'metadata_only'
      ));
      skippedPolicyExcluded = matched.length - policyAllowed.length;
      const targetMissing = policyAllowed.filter((row) => row.target_job_exists !== 1);
      skippedTargetExists = policyAllowed.length - targetMissing.length;
      const rowsToEscalate = targetMissing.slice(0, escalationBudget);
      skippedEscalationBudget = targetMissing.length - rowsToEscalate.length;
      if (dryRun) return;

      const insert = this.db.query(`
        INSERT INTO extraction_jobs (
          job_id, corpus_id, provider, account_scope, approved_scope_key,
          provider_item_id, local_item_id, source_version, content_hash,
          name, mime_type, size_bytes, extractor_kind, extractor_version,
          policy_decision, status, priority, max_bytes_per_file, attempts,
          janitor_requeue_reason, temp_bytes_cleaned, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, 1, ?, ?)
      `);
      const markSource = this.db.query(`
        UPDATE extraction_jobs
        SET janitor_terminal_requeue_count = COALESCE(janitor_terminal_requeue_count, 0) + 1,
            janitor_requeued_at = ?,
            janitor_requeue_reason = ?,
            updated_at = ?
        WHERE job_id = ?
      `);
      for (const row of rowsToEscalate) {
        insert.run(
          makeJobId(),
          row.corpus_id,
          row.provider,
          row.account_scope,
          row.approved_scope_key,
          row.provider_item_id,
          row.local_item_id,
          row.source_version,
          row.content_hash,
          row.name,
          row.mime_type,
          row.size_bytes,
          targetKind,
          targetVersion,
          row.policy_decision,
          row.priority,
          row.max_bytes_per_file,
          reason,
          now,
          now,
        );
        markSource.run(now, reason, now, row.job_id);
        escalated += 1;
      }
    })();

    return {
      mode: 'terminal_reclassification',
      matchedJobs: matched.length,
      jobsRequeued: 0,
      jobsEscalated: escalated,
      skippedAttemptBudget: 0,
      skippedAlreadyJanitorRequeued: skippedTargetExists,
      skippedPolicyExcluded,
      skippedEscalationBudget,
      skippedTargetExists,
      networkGuardOverrideUsed: false,
      dryRun,
      reason,
    };
  }

  private leaseCandidateRows(
    lane: ExtractionLaneKey,
    request: LeaseExtractionJobsRequest,
    now: string,
    limit: number,
  ): ExtractionJobSqlRow[] {
    const filters: string[] = [];
    const params: Array<string | number> = [
      lane.corpusId,
      lane.provider,
      lane.accountScope,
      lane.approvedScopeKey,
      now,
      now,
    ];
    if (request.extractorKind !== undefined) {
      filters.push('extractor_kind = ?');
      params.push(requireToken(request.extractorKind, 'extractorKind'));
    }
    if (request.extractorVersion !== undefined) {
      filters.push('extractor_version = ?');
      params.push(requireKeyPart(request.extractorVersion, 'extractorVersion'));
    }
    if (request.providerItemIds !== undefined && request.providerItemIds.length > 0) {
      filters.push(`provider_item_id IN (${request.providerItemIds.map(() => '?').join(', ')})`);
      params.push(...request.providerItemIds.map((id) => requireBoundedString(id, 'providerItemId')));
    }
    params.push(limit);
    const filterSql = filters.length > 0 ? `\n        AND ${filters.join('\n        AND ')}` : '';
    return this.db.query(`
      SELECT *
      FROM extraction_jobs
      WHERE corpus_id = ?
        AND provider = ?
        AND account_scope = ?
        AND approved_scope_key = ?
        AND (
          status = 'queued'
          OR (status = 'leased' AND leased_until IS NOT NULL AND leased_until < ?)
          OR (status = 'failed_retryable' AND (next_retry_at IS NULL OR next_retry_at <= ?))
        )${filterSql}
      ORDER BY priority DESC, updated_at ASC, job_id ASC
      LIMIT ?
    `).all(...params) as ExtractionJobSqlRow[];
  }

  private replaceArtifacts(
    row: ExtractionJobSqlRow,
    derivations: readonly ExtractionDerivation[] | undefined,
    now: string,
  ): number {
    if (derivations === undefined) return 0;
    this.db.query('DELETE FROM extraction_artifacts WHERE corpus_id = ? AND local_item_id = ?')
      .run(row.corpus_id, row.local_item_id);
    if (derivations.length === 0) return 0;
    const insert = this.db.query(`
      INSERT INTO extraction_artifacts (
        corpus_id, local_item_id, artifact_index, job_id, extractor_kind,
        extractor_version, artifact_kind, structural_ref_json, confidence,
        warnings_json, chars, derived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    derivations.forEach((derivation, index) => {
      insert.run(
        row.corpus_id,
        row.local_item_id,
        index,
        row.job_id,
        row.extractor_kind,
        row.extractor_version,
        derivation.artifactKind,
        derivation.structuralRef === undefined ? null : JSON.stringify(derivation.structuralRef),
        derivation.confidence ?? null,
        derivation.warnings === undefined ? null : JSON.stringify([...derivation.warnings]),
        requireSafeInteger(derivation.chars, 'chars'),
        now,
      );
    });
    return derivations.length;
  }

  private existingJob(
    ref: ExtractionItemRef,
    extractorKind: string,
    extractorVersion: string,
  ): ExtractionJobSqlRow | undefined {
    const row = this.db.query(`
      SELECT *
      FROM extraction_jobs
      WHERE corpus_id = ?
        AND provider = ?
        AND account_scope = ?
        AND provider_item_id = ?
        AND source_version = ?
        AND content_hash = ?
        AND extractor_kind = ?
        AND extractor_version = ?
      LIMIT 1
    `).get(
      ref.corpusId,
      ref.provider,
      ref.accountScope,
      ref.providerItemId,
      ref.sourceVersion ?? '',
      ref.contentHash ?? '',
      extractorKind,
      extractorVersion,
    ) as ExtractionJobSqlRow | null;
    return row ?? undefined;
  }

  private jobRow(jobId: string): ExtractionJobSqlRow | undefined {
    const row = this.db.query('SELECT * FROM extraction_jobs WHERE job_id = ? LIMIT 1')
      .get(jobId) as ExtractionJobSqlRow | null;
    return row ?? undefined;
  }

  private assertWritable(operation: string): void {
    if (this.readonly) {
      throw new Error(`Extraction job store is read-only; ${operation} is not permitted.`);
    }
  }
}

function fileExtractionJobMigrations(): SqliteMigration[] {
  return [{
    version: 1,
    name: 'create_extraction_jobs',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS extraction_jobs (
          job_id TEXT PRIMARY KEY,
          corpus_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          account_scope TEXT NOT NULL,
          approved_scope_key TEXT NOT NULL,
          provider_item_id TEXT NOT NULL,
          local_item_id TEXT NOT NULL,
          source_version TEXT,
          content_hash TEXT,
          name TEXT,
          mime_type TEXT,
          size_bytes INTEGER,
          extractor_kind TEXT NOT NULL,
          extractor_version TEXT NOT NULL,
          policy_decision TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          max_bytes_per_file INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0,
          leased_by_hash TEXT,
          leased_until TEXT,
          last_error_hash TEXT,
          last_error_kind TEXT,
          next_retry_at TEXT,
          janitor_requeue_count INTEGER NOT NULL DEFAULT 0,
          janitor_terminal_requeue_count INTEGER NOT NULL DEFAULT 0,
          janitor_requeued_at TEXT,
          janitor_requeue_reason TEXT,
          temp_bytes_cleaned INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(corpus_id, provider, account_scope, provider_item_id,
                 source_version, content_hash, extractor_kind, extractor_version)
        );
        CREATE INDEX IF NOT EXISTS idx_extraction_jobs_lane
          ON extraction_jobs(corpus_id, provider, account_scope, approved_scope_key,
                             status, priority, updated_at);
        CREATE INDEX IF NOT EXISTS idx_extraction_jobs_item
          ON extraction_jobs(corpus_id, local_item_id, status);

        CREATE TABLE IF NOT EXISTS extraction_artifacts (
          corpus_id TEXT NOT NULL,
          local_item_id TEXT NOT NULL,
          artifact_index INTEGER NOT NULL,
          job_id TEXT NOT NULL,
          extractor_kind TEXT NOT NULL,
          extractor_version TEXT NOT NULL,
          artifact_kind TEXT NOT NULL,
          structural_ref_json TEXT,
          confidence REAL,
          warnings_json TEXT,
          chars INTEGER NOT NULL DEFAULT 0,
          derived_at TEXT NOT NULL,
          PRIMARY KEY (corpus_id, local_item_id, artifact_index)
        );
        CREATE INDEX IF NOT EXISTS idx_extraction_artifacts_job ON extraction_artifacts(job_id);
      `);
    },
  }, {
    version: 2,
    name: 'add_lease_token',
    up(db) {
      db.exec('ALTER TABLE extraction_jobs ADD COLUMN lease_token TEXT;');
    },
  }, {
    version: 3,
    name: 'add_claim_grant_sequence',
    up(db) {
      // One row, minted once per database. The authority id names the sequence
      // SPACE, which is what lets a consumer of these grants tell "an older
      // generation of the same queue" (comparable, and the thing a fence must
      // refuse) from "a different queue, or this queue rebuilt from scratch"
      // (not comparable, and refusing it would be a permanent outage the day
      // somebody legitimately recreates this file).
      db.exec(`
        ALTER TABLE extraction_jobs ADD COLUMN lease_grant_ordinal INTEGER;
        CREATE TABLE IF NOT EXISTS extraction_claim_grants (
          grant_id INTEGER PRIMARY KEY CHECK (grant_id = 1),
          authority_id TEXT NOT NULL,
          last_ordinal INTEGER NOT NULL
        );
      `);
      db.query(`
        INSERT OR IGNORE INTO extraction_claim_grants (grant_id, authority_id, last_ordinal)
        VALUES (1, ?, 0)
      `).run(randomUUID());
    },
  }];
}

/**
 * Linear backoff, not exponential, and only for retryable failures. Ported
 * exactly: five minutes times the attempt count, capped at one hour.
 */
function nextRetryTimestamp(
  status: ExtractionTerminalStatus,
  attempts: number,
  now: string,
): string | null {
  if (status !== 'failed_retryable') return null;
  const delaySeconds = Math.min(
    MAX_EXTRACTION_RETRY_BACKOFF_SECONDS,
    DEFAULT_EXTRACTION_RETRY_BACKOFF_SECONDS * Math.max(1, attempts),
  );
  return new Date(new Date(now).getTime() + delaySeconds * 1_000).toISOString();
}

function refFromRow(row: ExtractionJobSqlRow): ExtractionItemRef {
  return {
    corpusId: row.corpus_id,
    provider: row.provider,
    accountScope: row.account_scope,
    approvedScopeKey: row.approved_scope_key,
    providerItemId: row.provider_item_id,
    localItemId: row.local_item_id,
    ...(row.source_version ? { sourceVersion: row.source_version } : {}),
    ...(row.content_hash ? { contentHash: row.content_hash } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
  };
}

function recordFromRow(row: ExtractionJobSqlRow): ExtractionJobRecord {
  return {
    jobId: row.job_id,
    ref: refFromRow(row),
    extractorKind: row.extractor_kind,
    extractorVersion: row.extractor_version,
    policyDecision: row.policy_decision as ExtractionPolicyDecision,
    status: (jobStatus(row.status) ?? 'queued'),
    priority: row.priority,
    attempts: row.attempts,
    ...(row.max_bytes_per_file === null ? {} : { maxBytesPerFile: row.max_bytes_per_file }),
    ...(row.leased_by_hash ? { leasedByHash: row.leased_by_hash } : {}),
    ...(row.leased_until ? { leasedUntil: row.leased_until } : {}),
    ...(row.last_error_kind ? { lastErrorKind: row.last_error_kind } : {}),
    ...(row.last_error_hash ? { lastErrorHash: row.last_error_hash } : {}),
    ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
    janitorRequeueCount: row.janitor_requeue_count,
    janitorTerminalRequeueCount: row.janitor_terminal_requeue_count,
    ...(row.janitor_requeued_at ? { janitorRequeuedAt: row.janitor_requeued_at } : {}),
    ...(row.janitor_requeue_reason ? { janitorRequeueReason: row.janitor_requeue_reason } : {}),
    tempBytesCleaned: row.temp_bytes_cleaned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function artifactFromRow(row: ExtractionArtifactSqlRow): ExtractionArtifactRecord {
  const structuralRef = parseJsonObject(row.structural_ref_json);
  const warnings = parseJsonStringArray(row.warnings_json);
  return {
    corpusId: row.corpus_id,
    localItemId: row.local_item_id,
    artifactIndex: row.artifact_index,
    jobId: row.job_id,
    extractorKind: row.extractor_kind,
    extractorVersion: row.extractor_version,
    derivation: {
      artifactKind: row.artifact_kind as ExtractionDerivation['artifactKind'],
      ...(structuralRef ? { structuralRef } : {}),
      ...(row.confidence === null ? {} : { confidence: row.confidence }),
      ...(warnings ? { warnings } : {}),
      chars: row.chars,
    },
    derivedAt: row.derived_at,
  };
}

function parseJsonObject(value: string | null): Readonly<Record<string, unknown>> | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}

function parseJsonStringArray(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) return undefined;
    return parsed as string[];
  } catch {
    return undefined;
  }
}

function jobStatus(value: string | undefined): ExtractionJobStatus | undefined {
  if (value === undefined) return undefined;
  if (value === 'queued' || value === 'leased') return value;
  return TERMINAL_STATUSES.has(value) ? (value as ExtractionJobStatus) : undefined;
}

function requireItemRef(ref: ExtractionItemRef): ExtractionItemRef {
  const normalized: ExtractionItemRef = {
    corpusId: requireKeyPart(ref.corpusId, 'corpusId'),
    provider: requireKeyPart(ref.provider, 'provider'),
    accountScope: requireBoundedString(ref.accountScope, 'accountScope'),
    approvedScopeKey: requireBoundedString(ref.approvedScopeKey, 'approvedScopeKey'),
    providerItemId: requireBoundedString(ref.providerItemId, 'providerItemId'),
    localItemId: requireBoundedString(ref.localItemId, 'localItemId'),
    ...(ref.sourceVersion === undefined ? {} : { sourceVersion: requireBoundedString(ref.sourceVersion, 'sourceVersion') }),
    ...(ref.contentHash === undefined ? {} : { contentHash: requireBoundedString(ref.contentHash, 'contentHash') }),
    ...(ref.name === undefined ? {} : { name: requireBoundedString(ref.name, 'name') }),
    ...(ref.mimeType === undefined ? {} : { mimeType: requireBoundedString(ref.mimeType, 'mimeType') }),
    ...(ref.sizeBytes === undefined ? {} : { sizeBytes: requireSafeInteger(ref.sizeBytes, 'sizeBytes') }),
  };
  return normalized;
}

function requireLaneKey(lane: ExtractionLaneKey): ExtractionLaneKey {
  return {
    corpusId: requireKeyPart(lane.corpusId, 'corpusId'),
    provider: requireKeyPart(lane.provider, 'provider'),
    accountScope: requireBoundedString(lane.accountScope, 'accountScope'),
    approvedScopeKey: requireBoundedString(lane.approvedScopeKey, 'approvedScopeKey'),
  };
}

function requireKeyPart(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_KEY_PART.test(value)) {
    throw new TypeError(`Extraction job ${field} must be a safe identifier.`);
  }
  return value;
}

function requireToken(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) {
    throw new TypeError(`Extraction job ${field} must be a safe categorical token.`);
  }
  return value;
}

function requireHash(value: string): string {
  if (typeof value !== 'string' || !SAFE_HASH.test(value)) {
    throw new TypeError('Extraction job errorHash must be a lowercase hexadecimal digest.');
  }
  return value;
}

function requireBoundedString(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) {
    throw new TypeError(`Extraction job ${field} must be a bounded non-empty string.`);
  }
  return value;
}

function requireReason(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_REASON_LENGTH) {
    throw new TypeError('Extraction janitor reason must be a bounded non-empty string.');
  }
  return value.trim();
}

function requirePolicyDecision(value: ExtractionPolicyDecision): ExtractionPolicyDecision {
  if (!POLICY_DECISIONS.has(value)) {
    throw new TypeError('Extraction job policyDecision is not a recognised decision.');
  }
  return value;
}

function requireTerminalStatus(value: ExtractionTerminalStatus): ExtractionTerminalStatus {
  if (!TERMINAL_STATUSES.has(value)) {
    throw new TypeError('Extraction record status must be a terminal job status.');
  }
  return value;
}

function requireSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Extraction job ${field} must be a non-negative safe integer.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Extraction job ${field} must be a positive safe integer.`);
  }
  return value;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError('Extraction job limit must be a safe integer.');
  }
  return Math.min(max, Math.max(min, value));
}

function makeJobId(): string {
  return `fx_${randomUUID()}`;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}
