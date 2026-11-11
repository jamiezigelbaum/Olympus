import type { ExtractionLaneKey } from '../../file-extraction/job-store.ts';
import type { ExtractionPolicyDecision } from '../../file-extraction/types.ts';
import type {
  FileExtractionRunner,
  ExtractionRunResult,
  ExtractionPlanResult,
  ExtractionReclassificationResult,
} from '../../file-extraction/runner.ts';
import { DROPBOX_FILES_CORPUS_ID } from '../../dropbox-files/index.ts';
import { EmailSourceWorkerError } from './worker-responses.ts';
import { canonicalRequestCorpusId, asOptionalString, asOptionalNumber } from './request-fields.ts';

const DEFAULT_DROPBOX_CONTENT_EXTRACTION_LEASE_LIMIT = 10;

const MAX_DROPBOX_CONTENT_EXTRACTION_LEASE_LIMIT = 500;

const MAX_DROPBOX_CONTENT_EXTRACTION_LEASE_SECONDS = 3_600;

const MAX_DROPBOX_SYNC_JOB_MAX_ENTRIES_PER_PASS = 25_000;

const MAX_DROPBOX_SYNC_JOB_MAX_PAGES_PER_PASS = 1_000;

const MAX_DROPBOX_SYNC_JOB_LEASE_SECONDS = 3_600;

// --- the source-neutral extraction factory's HTTP surface -------------------

export const DEFAULT_FILE_EXTRACTION_PLAN_LIMIT = 100;

/**
 * The lane provider the Dropbox extraction source stamps on every ref it
 * enumerates. The aliased paths never carried it in their bodies, so the alias
 * supplies it the same way it supplies the corpus id.
 */
const DROPBOX_FILE_EXTRACTION_PROVIDER = 'dropbox';

type FileExtractionAliasOperation =
  | 'extract'
  | 'plan'
  | 'transcribe'
  | 'recycle_leases'
  | 'janitor_requeue';

interface FileExtractionRouteAlias {
  operation: FileExtractionAliasOperation;
  genericPath: string;
  corpusId: string;
  provider: string;
}

/**
 * The family-scoped extraction paths, and the generic path each one aliases.
 *
 * These are the URLs the running supervisor fleet already speaks to, so they
 * keep working unchanged. The alias injects the corpus id AND the provider the
 * caller never had to name — the two things the generic route needs that the
 * family-scoped one carried in its path instead of its body.
 *
 * Four family-scoped extraction paths have NO generic twin here on purpose:
 * `retarget-queued`, `requalify-terminal` and `retire-jobs` are operations the
 * factory's job store does not implement, and `on-demand-media`,
 * `apply-tier-overrides`, `export-eval-shard` and the promotion routes were
 * already out of scope for the factory. Aliasing a path onto an operation that
 * does not exist would be worse than leaving it legacy.
 */
const FILE_EXTRACTION_ROUTE_ALIASES: ReadonlyMap<string, FileExtractionRouteAlias> = new Map([
  ['/source/index/dropbox/content/extract', {
    operation: 'extract' as const,
    genericPath: '/source/index/files/extract',
    corpusId: DROPBOX_FILES_CORPUS_ID,
    provider: DROPBOX_FILE_EXTRACTION_PROVIDER,
  }],
  ['/source/index/dropbox/content/plan', {
    operation: 'plan' as const,
    genericPath: '/source/index/files/plan',
    corpusId: DROPBOX_FILES_CORPUS_ID,
    provider: DROPBOX_FILE_EXTRACTION_PROVIDER,
  }],
  ['/source/index/dropbox/content/recycle-leases', {
    operation: 'recycle_leases' as const,
    genericPath: '/source/index/files/recycle-leases',
    corpusId: DROPBOX_FILES_CORPUS_ID,
    provider: DROPBOX_FILE_EXTRACTION_PROVIDER,
  }],
  ['/source/index/dropbox/content/janitor-requeue', {
    operation: 'janitor_requeue' as const,
    genericPath: '/source/index/files/janitor-requeue',
    corpusId: DROPBOX_FILES_CORPUS_ID,
    provider: DROPBOX_FILE_EXTRACTION_PROVIDER,
  }],
  ['/source/index/dropbox/transcribe', {
    operation: 'transcribe' as const,
    genericPath: '/source/index/files/transcribe',
    corpusId: DROPBOX_FILES_CORPUS_ID,
    provider: DROPBOX_FILE_EXTRACTION_PROVIDER,
  }],
]);

export function fileExtractionAliasFor(pathname: string, basePath: string): FileExtractionRouteAlias | undefined {
  if (!pathname.startsWith(basePath)) return undefined;
  return FILE_EXTRACTION_ROUTE_ALIASES.get(pathname.slice(basePath.length));
}

export function requireFileExtractionRunner(runner: FileExtractionRunner | undefined): FileExtractionRunner {
  if (!runner) {
    throw new EmailSourceWorkerError(
      501,
      'file_extraction_not_supported',
      'Private source worker does not have the file-extraction factory configured.',
    );
  }
  return runner;
}

/**
 * The lane every factory route is scoped to.
 *
 * The corpus id goes through the shared canonicaliser, so a documented input
 * alias reaches dispatch as its canonical id rather than as an unknown corpus.
 * A family-scoped path supplies the id and the provider itself, which is what
 * makes it an alias rather than a second implementation.
 */
export function parseFileExtractionLaneRecord(
  record: Record<string, unknown>,
  alias: FileExtractionRouteAlias | undefined,
  runner: FileExtractionRunner,
): ExtractionLaneKey {
  const corpusId = canonicalRequestCorpusId(record) ?? alias?.corpusId;
  if (corpusId === undefined) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'corpus_id is required for file extraction.');
  }
  if (!runner.corpusIds().includes(corpusId)) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'corpus_id must name a corpus the file-extraction factory serves.',
    );
  }
  const provider = asOptionalString(record.provider) ?? alias?.provider;
  if (!provider) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'provider is required for file extraction.');
  }
  const accountScope = asOptionalString(record.account_scope) ?? asOptionalString(record.account);
  if (!accountScope) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'account is required for file extraction.');
  }
  const approvedScopeKey = asOptionalString(record.approved_scope_key);
  if (!approvedScopeKey) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'approved_scope_key is required for file extraction.');
  }
  return { corpusId, provider, accountScope, approvedScopeKey };
}

export function parseExtractionPolicyDecision(value: unknown): ExtractionPolicyDecision {
  const decision = asOptionalString(value);
  if (
    decision !== 'index_allowed'
    && decision !== 'index_redacted'
    && decision !== 'metadata_only'
    && decision !== 'blocked_sensitive'
    && decision !== 'needs_review'
  ) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'policy_decision is not a recognised decision.');
  }
  return decision;
}

export function optionalStringField<K extends string>(value: unknown, key: K): { [P in K]?: string } {
  const parsed = asOptionalString(value);
  return (parsed === undefined ? {} : { [key]: parsed }) as { [P in K]?: string };
}

export function optionalNumberField<K extends string>(
  value: unknown,
  name: string,
  key: K,
): { [P in K]?: number } {
  const parsed = asOptionalNumber(value, name);
  return (parsed === undefined ? {} : { [key]: parsed }) as { [P in K]?: number };
}

export function fileExtractionRunBody(result: ExtractionRunResult): Record<string, unknown> {
  return {
    kind: result.kind,
    corpus_id: result.corpusId,
    provider: result.provider,
    account: result.accountScope,
    scope_key_hash: result.scopeKeyHash,
    worker_id_hash: result.workerIdHash,
    leased_jobs: result.leasedJobs,
    processed_jobs: result.processedJobs,
    abandoned_leases: result.abandonedLeases,
    paused: result.paused,
    ...(result.pauseReason !== undefined ? { pause_reason: result.pauseReason } : {}),
    ...(result.preflightErrorKind !== undefined
      ? { preflight_error_kind: result.preflightErrorKind }
      : {}),
    consecutive_retryable_failures: result.consecutiveRetryableFailures,
    counts: result.counts,
    records: result.records.map((record) => ({
      job_id: record.jobId,
      status: record.status,
      extractor_kind: record.extractorKind,
      extractor_version: record.extractorVersion,
      attempts: record.attempts,
      ...(record.errorKind !== undefined ? { error_kind: record.errorKind } : {}),
      ...(record.nextRetryAt !== undefined ? { next_retry_at: record.nextRetryAt } : {}),
      ...(record.chunksIndexed !== undefined ? { chunks_indexed: record.chunksIndexed } : {}),
      ...(record.chunksAwaitingEmbedding !== undefined
        ? { chunks_awaiting_embedding: record.chunksAwaitingEmbedding }
        : {}),
      ...(record.artifactsRecorded !== undefined ? { artifacts_recorded: record.artifactsRecorded } : {}),
      ...(record.egressDestination !== undefined
        ? { egress_destination: record.egressDestination }
        : {}),
      ...(record.leaseLost === true ? { lease_lost: true } : {}),
    })),
    ...(result.reclassification !== undefined
      ? { reclassification: fileExtractionReclassificationBody(result.reclassification) }
      : {}),
    policy: {
      worker_private_surface: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_bytes_persisted: false,
      temp_bytes_cleaned: true,
      local_only: result.policy.localOnly,
      trust_domain: result.policy.trustDomain,
      ...(result.policy.egressDestination !== undefined
        ? { egress_destination: result.policy.egressDestination }
        : {}),
    },
  };
}

export function fileExtractionPlanBody(result: ExtractionPlanResult): Record<string, unknown> {
  return {
    kind: result.kind,
    corpus_id: result.corpusId,
    candidates: result.candidates,
    jobs_queued: result.jobsQueued,
    jobs_existing: result.jobsExisting,
    jobs_forced: result.jobsForced,
    jobs_skipped_too_large: result.jobsSkippedTooLarge,
    jobs_unroutable: result.jobsUnroutable,
    jobs_refused: result.jobsRefused,
    extractor_kinds: result.extractorKinds,
    ...(result.nextCursor !== undefined ? { next_cursor: result.nextCursor } : {}),
    done: result.done,
    policy: {
      worker_private_surface: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_bytes_downloaded: false,
      local_only: result.policy.localOnly,
      trust_domain: result.policy.trustDomain,
      ...(result.policy.egressDestination !== undefined
        ? { egress_destination: result.policy.egressDestination }
        : {}),
    },
  };
}

export function fileExtractionReclassificationBody(
  result: ExtractionReclassificationResult,
): Record<string, unknown> {
  return {
    kind: result.kind,
    corpus_id: result.corpusId,
    jobs_escalated: result.jobsEscalated,
    dry_run: result.dryRun,
    rules: result.rules.map((rule) => ({
      from_extractor_kind: rule.fromExtractorKind,
      last_error_kind: rule.lastErrorKind,
      to_extractor_kind: rule.toExtractorKind,
      matched_jobs: rule.matchedJobs,
      jobs_escalated: rule.jobsEscalated,
      skipped_target_exists: rule.skippedTargetExists,
    })),
  };
}
