/**
 * B11b — the batch loop: lease, fetch, extract, gate, record, sink.
 *
 * Everything the factory owns already existed as tested parts before this
 * module; none of it ran, because nothing connected them. This is the
 * connection, and almost all of its content is DISPOSITION — deciding, for each
 * of the many ways one item can go wrong, whether the job is settled, retried,
 * or refused, and making sure none of those answers is "abandon the batch".
 *
 * Four properties are load-bearing, and each of them is a live incident:
 *
 *   1. ONE BAD ITEM NEVER ABORTS A RUN. Every per-item outcome, including a
 *      source that will not serve bytes and an extractor that throws, is
 *      recorded against that job and the loop continues. Only `failed_retryable`
 *      feeds the consecutive-failure counter, because a terminal failure is a
 *      SETTLED job, not a symptom of the lane being unwell. When the counter
 *      trips, the lane PAUSES — the batch returns with what it finished and a
 *      pause reason — and nothing is thrown from inside the loop.
 *   2. THE EGRESS GATE IS A BOUNDARY. An extractor whose work crosses the
 *      approved-remote boundary is unreachable unless the corpus's own policy
 *      permits it, the job's policy decision permits it, and a live trust-tier
 *      read permits it. The gate fails CLOSED on every unknown, and it runs
 *      before bytes are even fetched.
 *   3. EMPTY OUTPUT NEVER REACHES THE SINK. Empty or whitespace text read as a
 *      representation DELETES an item's existing chunks, so an empty extraction
 *      settles as metadata-only without a write. The landed types make this
 *      nearly unrepresentable; this module preserves that rather than defeating
 *      it.
 *   4. A LEASE THAT EXPIRED MID-EXTRACTION DOES NOT WRITE. The produced text is
 *      dropped, deliberately: another worker may already hold the job, and
 *      writing under a lease that is no longer ours is the one outcome that
 *      cannot be undone. Dropping costs one re-extraction.
 *
 * A fifth is carried from the wave that landed the extractors: the deterministic
 * OCR refusal is REOPENED against the vision lane, because a failure output can
 * no longer carry the artifact that used to tell an operator to move it. See
 * `reclassifyTerminal`.
 *
 * Nothing here names a connector family and nothing here reads the environment.
 * Doc comments are always multi-line blocks: the architecture guard's
 * regex-literal heuristic reads a one-line block comment as a regex. There are
 * no regular expressions in this module.
 */

import { createHash } from 'node:crypto';
import {
  SOURCE_TRUST_TIERS,
  type SourceTrustDomain,
  type SourceTrustTier,
} from '../../core/source-index/types.ts';
import { isFileExtractionSourceError } from '../../core/file-extraction-source.ts';
import {
  ExtractionCommandTimeoutError,
} from './extractors/command-runner.ts';
import type {
  ExtractionLaneKey,
  ExtractionStatusCount,
  JanitorRequeueExtractionJobsResult,
  LeasedExtractionJob,
  LocalFileExtractionJobStore,
  RecycleExtractionLeasesResult,
} from './job-store.ts';
import type { ExtractionReclassificationRule, ExtractionHealthProbeMap } from './registry.ts';
import {
  EXTRACTION_SINK_SKIPPED_CLAIM_SUPERSEDED,
  EXTRACTION_SINK_SKIPPED_EMPTY_TEXT,
  EXTRACTION_SINK_SKIPPED_METADATA_ONLY,
  EXTRACTION_SINK_SKIPPED_IDENTITY_AMBIGUOUS,
  EXTRACTION_SINK_SKIPPED_ITEM_MISSING,
  EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE,
  EXTRACTION_SINK_SKIPPED_OWNED_ELSEWHERE,
} from './store-sink.ts';
import type {
  ExtractionEgress,
  ExtractionEgressPolicy,
  ExtractionApprovedRemoteDestination,
  ExtractionItemRef,
  ExtractionPolicyDecision,
  ExtractionSink,
  ExtractionTerminalStatus,
  Extractor,
  ExtractorInput,
  ExtractorOutput,
  ExtractorRegistry,
  FetchedBytes,
  FileExtractionSource,
} from './types.ts';

export const DEFAULT_EXTRACTION_WORKER_ID = 'olympus-file-extraction-worker';
export const DEFAULT_MAX_CONSECUTIVE_RETRYABLE_FAILURES = 5;
export const DEFAULT_RECLASSIFICATION_LIMIT = 100;

/**
 * Error kinds this module stamps, all of them bounded categorical tokens. Raw
 * error text never enters the job store, so anything derived from an exception
 * is a hexadecimal digest and nothing else.
 */
export const EXTRACTION_ERROR_KIND_UNKNOWN_EXTRACTOR = 'extractor_kind_unknown';
export const EXTRACTION_ERROR_KIND_EXTRACTOR_THREW = 'extractor_threw';
export const EXTRACTION_ERROR_KIND_EXTRACTOR_TIMEOUT = 'extractor_command_timeout';
export const EXTRACTION_ERROR_KIND_SOURCE_FETCH_FAILED = 'source_fetch_failed';
export const EXTRACTION_ERROR_KIND_BYTES_UNVERIFIED = 'source_bytes_hash_mismatch';
export const EXTRACTION_ERROR_KIND_EMPTY_OUTPUT = 'extractor_empty_output';
export const EXTRACTION_ERROR_KIND_SINK_FAILED = 'sink_write_failed';
export const EXTRACTION_ERROR_KIND_LEASE_LOST = 'lease_lost';

/**
 * Egress refusals, split by WHY rather than collapsed into one token. An
 * operator reading a lane's counts has to be able to tell "this corpus is not
 * approved for remote extraction at all" from "this item is above the tier" —
 * the first is a configuration answer, the second is a per-item one.
 */
export const EXTRACTION_EGRESS_REFUSED_NO_POLICY = 'egress_remote_not_permitted';
export const EXTRACTION_EGRESS_REFUSED_DECISION = 'egress_policy_decision_forbids';
export const EXTRACTION_EGRESS_REFUSED_DEFERRED = 'egress_policy_default_deferred';
export const EXTRACTION_EGRESS_REFUSED_TRUST_TIER = 'egress_policy_trust_tier';
export const EXTRACTION_EGRESS_REFUSED_TIER_UNKNOWN = 'egress_trust_tier_unknown';

export const EXTRACTION_PAUSE_CONSECUTIVE_FAILURES = 'consecutive_retryable_failures';
export const EXTRACTION_PAUSE_HEALTH_PROBE = 'extractor_health_probe_failed';

const ERROR_HASH_CHARS = 32;

/**
 * How a sink refusal settles. None of these is retryable, which is the point:
 * a store that will not take this item is a decided outcome about the item, so
 * it must not push the lane toward its breaker.
 */
const SINK_SKIP_SETTLEMENTS: Readonly<Record<string, ExtractionTerminalStatus>> = Object.freeze({
  [EXTRACTION_SINK_SKIPPED_ITEM_MISSING]: 'failed_terminal',
  [EXTRACTION_SINK_SKIPPED_IDENTITY_AMBIGUOUS]: 'failed_terminal',
  [EXTRACTION_SINK_SKIPPED_NOT_ELIGIBLE]: 'blocked_policy',
  [EXTRACTION_SINK_SKIPPED_OWNED_ELSEWHERE]: 'blocked_policy',
  [EXTRACTION_SINK_SKIPPED_EMPTY_TEXT]: 'metadata_only',
  // Settled as metadata-only rather than blocked: the item IS indexed and the
  // absence of content is the configured, correct end state, not a policy
  // refusal to be investigated or a failure to be retried.
  [EXTRACTION_SINK_SKIPPED_METADATA_ONLY]: 'metadata_only',
});

// --- the egress gate -------------------------------------------------------

/**
 * A live read of the item's authoritative trust tier.
 *
 * Declared as a narrow port rather than as a store class so that the gate is
 * testable as a boundary — the interesting cases are "the tier is too high" and
 * "the tier could not be read at all", and neither should need a database to
 * demonstrate.
 */
export interface ExtractionTrustTierReader {
  itemTrustTier(
    ref: ExtractionItemRef,
  ): SourceTrustTier | undefined | Promise<SourceTrustTier | undefined>;
}

export type ExtractionEgressDecision =
  | { allowed: true }
  | { allowed: false; errorKind: string };

/**
 * The whole remote-egress boundary, as one pure function.
 *
 * Local work is allowed without consulting anything: there is no boundary to
 * cross, and making a local lane depend on egress configuration would give an
 * operator a way to break extraction entirely by mis-editing a policy.
 *
 * Everything else fails CLOSED. A corpus with no egress policy cannot reach the
 * remote lane, whatever its registry contains — which is the property that
 * matters, because the registry registers the remote kinds unconditionally. An
 * unreadable trust tier is a refusal too: the tier is the authoritative signal
 * and "we could not tell" is not permission.
 */
export function evaluateExtractionEgress(input: {
  egress: ExtractionEgress;
  policy?: ExtractionEgressPolicy;
  policyDecision: ExtractionPolicyDecision;
  trustTier?: SourceTrustTier;
}): ExtractionEgressDecision {
  if (input.egress === 'local') return { allowed: true };
  if (!input.policy) return { allowed: false, errorKind: EXTRACTION_EGRESS_REFUSED_NO_POLICY };
  if (input.policyDecision === 'needs_review') {
    if (!input.policy.allowDefaultDeferred) {
      return { allowed: false, errorKind: EXTRACTION_EGRESS_REFUSED_DEFERRED };
    }
  } else if (input.policyDecision !== 'index_allowed') {
    return { allowed: false, errorKind: EXTRACTION_EGRESS_REFUSED_DECISION };
  }
  if (input.trustTier === undefined) {
    return { allowed: false, errorKind: EXTRACTION_EGRESS_REFUSED_TIER_UNKNOWN };
  }
  const itemRank = SOURCE_TRUST_TIERS.indexOf(input.trustTier);
  const maxRank = SOURCE_TRUST_TIERS.indexOf(input.policy.maxTrustTierForRemote);
  if (itemRank < 0 || maxRank < 0 || itemRank > maxRank) {
    return { allowed: false, errorKind: EXTRACTION_EGRESS_REFUSED_TRUST_TIER };
  }
  return { allowed: true };
}

// --- corpora ---------------------------------------------------------------

/**
 * One corpus the runner can serve.
 *
 * `source` may be a resolver rather than an instance. Extraction runs are long
 * and some families hold a credential that expires inside one, so the wiring
 * layer is given a place to rebuild the source without this module knowing that
 * credentials exist.
 */
export interface ExtractionRunnerCorpus {
  corpusId: string;
  trustDomain: SourceTrustDomain;
  source: FileExtractionSource | (() => FileExtractionSource | Promise<FileExtractionSource>);
  sink: ExtractionSink;
  /**
   * Absent means this corpus may not reach an approved-remote extractor at all.
   * That is the safe default and it is not a placeholder: a corpus is opted IN
   * to remote extraction by carrying a policy, never opted out by omitting one.
   */
  egressPolicy?: ExtractionEgressPolicy;
  trustTiers?: ExtractionTrustTierReader;
}

export interface FileExtractionRunnerOptions {
  jobs: LocalFileExtractionJobStore;
  registry: ExtractorRegistry;
  corpora: readonly ExtractionRunnerCorpus[];
  workerId?: string;
  healthProbes?: ExtractionHealthProbeMap;
  /**
   * Pause the lane when a probe rejects, rather than running the batch anyway.
   *
   * This knob exists because of the incident that motivated the probe: a
   * backend that rejected a MALFORMED probe payload starved the lane
   * indefinitely. The default is the cautious answer, and this is the lever
   * that recovers from the probe itself being wrong without a code change.
   */
  probeFailurePolicy?: 'pause_lane' | 'ignore';
  reclassificationRules?: readonly ExtractionReclassificationRule[];
  maxConsecutiveRetryableFailures?: number;
  now?: () => Date;
}

// --- requests and results --------------------------------------------------

export interface ExtractionPlanRequest extends ExtractionLaneKey {
  limit: number;
  cursor?: string;
  mimeTypes?: readonly string[];
  extractorKind?: string;
  policyDecision?: ExtractionPolicyDecision;
  priority?: number;
  maxBytesPerFile?: number;
  force?: boolean;
}

export interface ExtractionPlanResult {
  kind: 'file_extraction_plan';
  corpusId: string;
  candidates: number;
  jobsQueued: number;
  jobsExisting: number;
  jobsForced: number;
  jobsSkippedTooLarge: number;
  jobsUnroutable: number;
  extractorKinds: readonly string[];
  nextCursor?: string;
  done: boolean;
  policy: {
    workerPrivateSurface: true;
    rawSourceExposed: false;
    sourceTextReturned: false;
    fileBytesDownloaded: false;
    localOnly: boolean;
    trustDomain: SourceTrustDomain;
    egressDestination?: ExtractionApprovedRemoteDestination;
  };
}

export interface ExtractionRunRequest extends ExtractionLaneKey {
  limit?: number;
  leaseSeconds?: number;
  extractorKind?: string;
  // Extractor kinds selected by the preceding plan whose probes gate this batch.
  preflightExtractorKinds?: readonly string[];
  extractorVersion?: string;
  providerItemIds?: readonly string[];
  /**
   * Run the terminal-reclassification pass before leasing. On by default: a
   * reopening that has to be remembered separately is one that stops happening.
   */
  reclassify?: boolean;
  reclassifyLimit?: number;
}

export interface ExtractionRunRecord {
  jobId: string;
  status: ExtractionTerminalStatus;
  extractorKind: string;
  extractorVersion: string;
  attempts: number;
  errorKind?: string;
  nextRetryAt?: string;
  chunksIndexed?: number;
  chunksAwaitingEmbedding?: number;
  artifactsRecorded?: number;
  egressDestination?: ExtractionApprovedRemoteDestination;
  /**
   * True when the lease was gone by the time the outcome was recorded. The job
   * belongs to whoever holds it now; this run's text was dropped unwritten.
   */
  leaseLost?: boolean;
}

export type ExtractionRunCounts = Readonly<Record<ExtractionTerminalStatus, number>>;

export interface ExtractionRunResult {
  kind: 'file_extraction_run';
  corpusId: string;
  provider: string;
  accountScope: string;
  scopeKeyHash: string;
  workerIdHash: string;
  leasedJobs: number;
  processedJobs: number;
  abandonedLeases: number;
  records: readonly ExtractionRunRecord[];
  counts: ExtractionRunCounts;
  paused: boolean;
  pauseReason?: string;
  // Bounded categorical reason for a pre-lease health refusal.
  preflightErrorKind?: string;
  consecutiveRetryableFailures: number;
  reclassification?: ExtractionReclassificationResult;
  policy: {
    workerPrivateSurface: true;
    rawSourceExposed: false;
    sourceTextReturned: false;
    fileBytesPersisted: false;
    tempBytesCleaned: true;
    localOnly: boolean;
    trustDomain: SourceTrustDomain;
    egressDestination?: ExtractionApprovedRemoteDestination;
  };
}

export interface ExtractionReclassificationRuleResult {
  fromExtractorKind: string;
  lastErrorKind: string;
  toExtractorKind: string;
  matchedJobs: number;
  jobsEscalated: number;
  skippedTargetExists: number;
}

export interface ExtractionReclassificationResult {
  kind: 'file_extraction_terminal_reclassification';
  corpusId: string;
  rules: readonly ExtractionReclassificationRuleResult[];
  jobsEscalated: number;
  dryRun: boolean;
}

export interface ExtractionReclassifyRequest extends ExtractionLaneKey {
  limit?: number;
  dryRun?: boolean;
  rules?: readonly ExtractionReclassificationRule[];
}

export interface FileExtractionRunner {
  plan(request: ExtractionPlanRequest): Promise<ExtractionPlanResult>;
  run(request: ExtractionRunRequest): Promise<ExtractionRunResult>;
  reclassifyTerminal(request: ExtractionReclassifyRequest): ExtractionReclassificationResult;
  recycleLeases(request: Parameters<LocalFileExtractionJobStore['recycleLeases']>[0]): RecycleExtractionLeasesResult;
  janitorRequeue(
    request: Parameters<LocalFileExtractionJobStore['janitorRequeue']>[0],
  ): JanitorRequeueExtractionJobsResult;
  counts(lane: ExtractionLaneKey): readonly ExtractionStatusCount[];
  corpusIds(): readonly string[];
}

// --- the runner ------------------------------------------------------------

export function createFileExtractionRunner(
  options: FileExtractionRunnerOptions,
): FileExtractionRunner {
  const jobs = options.jobs;
  const registry = options.registry;
  const workerId = options.workerId ?? DEFAULT_EXTRACTION_WORKER_ID;
  const probes = options.healthProbes ?? new Map<string, () => Promise<void>>();
  const probeFailurePolicy = options.probeFailurePolicy ?? 'pause_lane';
  const reclassificationRules = options.reclassificationRules ?? [];
  const maxConsecutiveRetryableFailures = Math.max(
    1,
    Math.floor(options.maxConsecutiveRetryableFailures ?? DEFAULT_MAX_CONSECUTIVE_RETRYABLE_FAILURES),
  );
  const now = options.now ?? (() => new Date());
  const corporaById = new Map<string, ExtractionRunnerCorpus>();
  for (const corpus of options.corpora) {
    if (corporaById.has(corpus.corpusId)) {
      throw new Error(`Extraction corpus ${corpus.corpusId} is configured twice.`);
    }
    corporaById.set(corpus.corpusId, corpus);
  }

  function requireCorpus(corpusId: string): ExtractionRunnerCorpus {
    const corpus = corporaById.get(corpusId);
    if (!corpus) throw new Error(`Extraction corpus ${corpusId} is not configured.`);
    return corpus;
  }

  async function resolveSource(corpus: ExtractionRunnerCorpus): Promise<FileExtractionSource> {
    return typeof corpus.source === 'function' ? corpus.source() : corpus.source;
  }

  /**
   * Reopen terminally-failed jobs against a different extractor.
   *
   * The job store does the guarding: it will not create a second target job for
   * an item that already has one, so running this on every batch is idempotent
   * rather than a source of duplicates.
   */
  function reclassifyTerminal(request: ExtractionReclassifyRequest): ExtractionReclassificationResult {
    const rules = request.rules ?? reclassificationRules;
    const limit = request.limit ?? DEFAULT_RECLASSIFICATION_LIMIT;
    const dryRun = request.dryRun === true;
    const ruleResults: ExtractionReclassificationRuleResult[] = [];
    let jobsEscalated = 0;
    for (const rule of rules) {
      const result = jobs.janitorRequeue({
        corpusId: request.corpusId,
        provider: request.provider,
        accountScope: request.accountScope,
        approvedScopeKey: request.approvedScopeKey,
        mode: 'terminal_reclassification',
        reason: rule.reason,
        extractorKind: rule.fromExtractorKind,
        lastErrorKind: rule.lastErrorKind,
        targetExtractorKind: rule.toExtractorKind,
        targetExtractorVersion: rule.toExtractorVersion,
        limit,
        dryRun,
      });
      jobsEscalated += result.jobsEscalated;
      ruleResults.push({
        fromExtractorKind: rule.fromExtractorKind,
        lastErrorKind: rule.lastErrorKind,
        toExtractorKind: rule.toExtractorKind,
        matchedJobs: result.matchedJobs,
        jobsEscalated: result.jobsEscalated,
        skippedTargetExists: result.skippedTargetExists,
      });
    }
    return {
      kind: 'file_extraction_terminal_reclassification',
      corpusId: request.corpusId,
      rules: ruleResults,
      jobsEscalated,
      dryRun,
    };
  }

  return {
    reclassifyTerminal,

    corpusIds(): readonly string[] {
      return [...corporaById.keys()];
    },

    counts(lane: ExtractionLaneKey): readonly ExtractionStatusCount[] {
      return jobs.counts(lane);
    },

    recycleLeases(request) {
      return jobs.recycleLeases(request);
    },

    janitorRequeue(request) {
      return jobs.janitorRequeue(request);
    },

    /**
     * Enumerate candidates through the source and queue them.
     *
     * A candidate the registry cannot route is COUNTED, never thrown on: an
     * unroutable media type in one row is a fact about that row, and a plan
     * pass that died on it would keep an entire corpus from ever being queued.
     */
    async plan(request: ExtractionPlanRequest): Promise<ExtractionPlanResult> {
      const corpus = requireCorpus(request.corpusId);
      const source = await resolveSource(corpus);
      const page = await source.listCandidates({
        limit: request.limit,
        ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
        ...(request.mimeTypes !== undefined ? { mimeTypes: request.mimeTypes } : {}),
        approvedScopeKeys: [request.approvedScopeKey],
      });

      const byKind = new Map<string, ExtractionItemRef[]>();
      let jobsUnroutable = 0;
      for (const ref of page.candidates) {
        const extractor = registry.select(ref, request.extractorKind);
        if (!extractor) {
          jobsUnroutable += 1;
          continue;
        }
        const bucket = byKind.get(extractor.kind);
        if (bucket) bucket.push(ref);
        else byKind.set(extractor.kind, [ref]);
      }

      let jobsQueued = 0;
      let jobsExisting = 0;
      let jobsForced = 0;
      let jobsSkippedTooLarge = 0;
      for (const [extractorKind, refs] of byKind) {
        const extractor = registry.get(extractorKind)!;
        const result = jobs.enqueue({
          refs,
          extractorKind,
          extractorVersion: extractor.version,
          // Omitted means "this pass has nothing to say about policy", which the
          // store keeps distinct from asserting the permissive value: a re-plan
          // that names no decision must not rewrite a stored needs_review.
          ...(request.policyDecision !== undefined ? { policyDecision: request.policyDecision } : {}),
          ...(request.priority !== undefined ? { priority: request.priority } : {}),
          ...(request.maxBytesPerFile !== undefined ? { maxBytesPerFile: request.maxBytesPerFile } : {}),
          ...(request.force !== undefined ? { force: request.force } : {}),
        });
        jobsQueued += result.jobsQueued;
        jobsExisting += result.jobsExisting;
        jobsForced += result.jobsForced;
        jobsSkippedTooLarge += result.jobsSkippedTooLarge;
      }

      return {
        kind: 'file_extraction_plan',
        corpusId: request.corpusId,
        candidates: page.candidates.length,
        jobsQueued,
        jobsExisting,
        jobsForced,
        jobsSkippedTooLarge,
        jobsUnroutable,
        extractorKinds: [...byKind.keys()],
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        done: page.done,
        policy: extractionPlanPolicy(
          corpus,
          request.extractorKind !== undefined
            ? [registry.get(request.extractorKind)].filter(
                (extractor): extractor is Extractor => extractor !== undefined,
              )
            : [...byKind.keys()].map((kind) => registry.get(kind)!),
        ),
      };
    },

    async run(request: ExtractionRunRequest): Promise<ExtractionRunResult> {
      const corpus = requireCorpus(request.corpusId);
      const lane: ExtractionLaneKey = {
        corpusId: request.corpusId,
        provider: request.provider,
        accountScope: request.accountScope,
        approvedScopeKey: request.approvedScopeKey,
      };

      const reclassification = request.reclassify === false || reclassificationRules.length === 0
        ? undefined
        : reclassifyTerminal({
          ...lane,
          ...(request.reclassifyLimit !== undefined ? { limit: request.reclassifyLimit } : {}),
        });

      // The probe runs BEFORE the lease on purpose. A probe failure must cost
      // throughput and nothing else: leasing first would charge an attempt
      // against every job in the batch for a backend problem none of them
      // caused, which is how a bad probe turned into terminal jobs once already.
      const probeFailure = await runHealthProbes(
        probes,
        request.extractorKind,
        request.preflightExtractorKinds,
      );
      if (probeFailure && probeFailurePolicy === 'pause_lane') {
        return pausedResult({
          lane,
          corpus,
          workerId,
          reason: EXTRACTION_PAUSE_HEALTH_PROBE,
          preflightErrorKind: probeFailure,
          ...(reclassification ? { reclassification } : {}),
        });
      }

      const lease = jobs.lease({
        ...lane,
        workerId,
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
        ...(request.leaseSeconds !== undefined ? { leaseSeconds: request.leaseSeconds } : {}),
        ...(request.extractorKind !== undefined ? { extractorKind: request.extractorKind } : {}),
        ...(request.extractorVersion !== undefined ? { extractorVersion: request.extractorVersion } : {}),
        ...(request.providerItemIds !== undefined ? { providerItemIds: request.providerItemIds } : {}),
      });

      const records: ExtractionRunRecord[] = [];
      let consecutiveRetryableFailures = 0;
      let paused = false;
      let processedJobs = 0;
      let localOnly = true;
      let source: FileExtractionSource | undefined;

      for (const job of lease.leasedJobs) {
        if (paused) break;
        processedJobs += 1;
        const extractor = registry.get(job.extractorKind);
        // Read off the extractor's declared egress rather than off what the
        // gate then decided, matching the lane this ports. A batch that reached
        // for the remote lane and was refused still reports `localOnly: false`,
        // which overstates the exposure rather than understating it — the only
        // direction a privacy flag may be wrong in.
        if (extractor && extractor.egress !== 'local') localOnly = false;

        // Every branch below produces an outcome. None of them throws: a throw
        // here is the defect that stopped a live migration mid-run.
        const outcome = await settleOneJob({
          job,
          extractor,
          corpus,
          resolveSource: async () => {
            source ??= await resolveSource(corpus);
            return source;
          },
          now,
        });

        const record = await recordOutcome(jobs, job, workerId, outcome);
        records.push(record);

        if (record.status === 'failed_retryable') {
          consecutiveRetryableFailures += 1;
          if (consecutiveRetryableFailures >= maxConsecutiveRetryableFailures) paused = true;
        } else {
          consecutiveRetryableFailures = 0;
        }
      }

      // A pause abandons the rest of the lease. Leasing already charged those
      // jobs an attempt, so hand them back and refund it — otherwise repeated
      // pauses walk documents the runner never touched to their terminal budget.
      const abandoned = lease.leasedJobs.slice(processedJobs);
      if (abandoned.length > 0) {
        jobs.releaseLeasesWithoutAttempt({
          jobIds: abandoned.map((job) => job.jobId),
          workerId,
          // The fleet shares one worker id, so the grant token is the only thing
          // separating this batch's claim from one that superseded it.
          leaseToken: abandoned[0]!.leaseToken,
        });
      }

      return {
        kind: 'file_extraction_run',
        corpusId: lease.corpusId,
        provider: lease.provider,
        accountScope: lease.accountScope,
        scopeKeyHash: lease.scopeKeyHash,
        workerIdHash: lease.workerIdHash,
        leasedJobs: lease.leasedJobs.length,
        processedJobs,
        abandonedLeases: lease.leasedJobs.length - processedJobs,
        records,
        counts: countRecords(records),
        paused,
        ...(paused ? { pauseReason: EXTRACTION_PAUSE_CONSECUTIVE_FAILURES } : {}),
        consecutiveRetryableFailures,
        ...(reclassification ? { reclassification } : {}),
        policy: {
          workerPrivateSurface: true,
          rawSourceExposed: false,
          sourceTextReturned: false,
          fileBytesPersisted: false,
          tempBytesCleaned: true,
          localOnly,
          trustDomain: corpus.trustDomain,
          ...summarizeEgressDestinations(records.map((record) => record.egressDestination)),
        },
      };
    },
  };
}

// --- one job ---------------------------------------------------------------

/**
 * What the loop decided about one job, before the store is told.
 *
 * Separated from the write so the disposition is a pure value: every case in
 * the table above can be asserted without a database, and the write path has
 * exactly one shape to get right.
 */
interface JobOutcome {
  status: ExtractionTerminalStatus;
  errorKind?: string;
  errorHash?: string;
  derivations?: ExtractorOutput['derivations'];
  chunksIndexed?: number;
  chunksAwaitingEmbedding?: number;
  egressDestination?: ExtractionApprovedRemoteDestination;
  /**
   * Set when the lease was already gone before the sink would have run. The
   * text is dropped and no write is attempted.
   */
  leaseExpired?: boolean;
}

async function settleOneJob(input: {
  job: LeasedExtractionJob;
  extractor: Extractor | undefined;
  corpus: ExtractionRunnerCorpus;
  resolveSource: () => Promise<FileExtractionSource>;
  now: () => Date;
}): Promise<JobOutcome> {
  const { job, extractor, corpus } = input;
  if (!extractor) {
    return { status: 'failed_terminal', errorKind: EXTRACTION_ERROR_KIND_UNKNOWN_EXTRACTOR };
  }

  // The gate runs before the bytes are fetched. Doing it here rather than at
  // the call site inside the extractor is what makes it a boundary: the remote
  // extractor cannot be reached at all, so it cannot be reached by mistake.
  const trustTier = extractor.egress === 'approved_remote'
    ? await readTrustTier(corpus, job.ref)
    : undefined;
  const egress = evaluateExtractionEgress({
    egress: extractor.egress,
    ...(corpus.egressPolicy ? { policy: corpus.egressPolicy } : {}),
    policyDecision: job.policyDecision,
    ...(trustTier !== undefined ? { trustTier } : {}),
  });
  if (!egress.allowed) {
    return { status: 'blocked_policy', errorKind: egress.errorKind };
  }

  let fetched: FetchedBytes | undefined;
  if (extractor.needsBytes) {
    let source: FileExtractionSource;
    try {
      source = await input.resolveSource();
    } catch (error) {
      return retryable(EXTRACTION_ERROR_KIND_SOURCE_FETCH_FAILED, error);
    }
    try {
      fetched = await source.fetch(job.ref, {
        ...(job.maxBytesPerFile !== undefined ? { maxBytes: job.maxBytesPerFile } : {}),
      });
    } catch (error) {
      // The settlement is the SOURCE'S, read off the typed rejection, never
      // re-derived here from a status code this module never saw. That is the
      // whole reason the seam carries a precomputed disposition.
      if (isFileExtractionSourceError(error)) {
        return {
          status: error.settleAs,
          errorKind: error.errorKind,
          ...(error.errorHash ? { errorHash: error.errorHash } : {}),
        };
      }
      return retryable(EXTRACTION_ERROR_KIND_SOURCE_FETCH_FAILED, error);
    }
    if (job.ref.contentHash !== undefined && source.verifyBytes) {
      let verified = true;
      try {
        verified = source.verifyBytes(job.ref, fetched.bytes);
      } catch {
        verified = false;
      }
      if (!verified) {
        return { status: 'failed_retryable', errorKind: EXTRACTION_ERROR_KIND_BYTES_UNVERIFIED };
      }
    }
  }

  const resolvedMimeType = fetched?.mimeType ?? job.ref.mimeType;
  const resolvedSizeBytes = fetched?.sizeBytes ?? job.ref.sizeBytes;
  const extractorInput: ExtractorInput = {
    ref: job.ref,
    job: {
      jobId: job.jobId,
      extractorKind: job.extractorKind,
      extractorVersion: job.extractorVersion,
      policyDecision: job.policyDecision,
      attempts: job.attempts,
      ...(job.maxBytesPerFile !== undefined ? { maxBytesPerFile: job.maxBytesPerFile } : {}),
      leaseExpiresAt: job.leaseExpiresAt,
    },
    ...(fetched ? { bytes: fetched.bytes } : {}),
    ...(resolvedMimeType !== undefined ? { mimeType: resolvedMimeType } : {}),
    ...(resolvedSizeBytes !== undefined ? { sizeBytes: resolvedSizeBytes } : {}),
  };

  // Three paths still throw out of `extract()` — the text lane's PDF command
  // path and both raster paths — and a test in the extractor wave pins that, so
  // it is deliberate rather than an oversight. This is the catch that turns
  // those into settled jobs.
  let output: ExtractorOutput;
  try {
    output = await extractor.extract(extractorInput);
  } catch (error) {
    return error instanceof ExtractionCommandTimeoutError
      ? retryable(EXTRACTION_ERROR_KIND_EXTRACTOR_TIMEOUT, error)
      : retryable(EXTRACTION_ERROR_KIND_EXTRACTOR_THREW, error);
  }

  if (output.status !== 'indexed') {
    if (output.status === 'empty_output') {
      // Anti-clobber. The sink is never called, so the store is never asked to
      // decide whether an empty representation should replace a real one.
      return {
        status: 'metadata_only',
        errorKind: EXTRACTION_ERROR_KIND_EMPTY_OUTPUT,
        ...(output.derivations ? { derivations: output.derivations } : {}),
        ...(output.egressDestination ? { egressDestination: output.egressDestination } : {}),
      };
    }
    return {
      status: output.status,
      ...(output.status === 'failed_retryable' || output.status === 'failed_terminal'
        ? { errorKind: output.errorKind }
        : {}),
      ...(output.derivations ? { derivations: output.derivations } : {}),
      ...(output.egressDestination ? { egressDestination: output.egressDestination } : {}),
    };
  }

  // Second half of the anti-clobber rule: an indexed output whose text is
  // whitespace is empty in every way that matters to the store's chunker.
  if (output.text.trim() === '') {
    return {
      status: 'metadata_only',
      errorKind: EXTRACTION_ERROR_KIND_EMPTY_OUTPUT,
      ...(output.derivations ? { derivations: output.derivations } : {}),
      ...(output.egressDestination ? { egressDestination: output.egressDestination } : {}),
    };
  }

  // Lost-lease check before the write, not after. The text is dropped rather
  // than written under a lease this worker may no longer hold.
  if (leaseHasExpired(job.leaseExpiresAt, input.now())) {
    return {
      status: 'failed_retryable',
      errorKind: EXTRACTION_ERROR_KIND_LEASE_LOST,
      leaseExpired: true,
      ...(output.egressDestination ? { egressDestination: output.egressDestination } : {}),
    };
  }

  let accepted;
  try {
    accepted = await corpus.sink.accept({
      ref: job.ref,
      text: output.text,
      extractorKind: job.extractorKind,
      extractorVersion: job.extractorVersion,
      fetchedAt: input.now().toISOString(),
      // The claim travels WITH the text, all the way to the write. The check
      // above is a cached expiry and cannot see a recycle that reclaimed a
      // still-unexpired lease; the sink re-asks the job database immediately
      // before it mutates the corpus, and carries the grant into the corpus
      // mutation itself so a recycle landing in that last gap is refused by
      // the store rather than discovered afterwards.
      claim: {
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        grantAuthority: job.grantAuthority,
        grantOrdinal: job.grantOrdinal,
      },
      ...(output.derivations ? { derivations: output.derivations } : {}),
    });
  } catch (error) {
    // The sink rethrows programming errors on purpose, and they are worth
    // surfacing — but not by abandoning a batch. Settling this job retryable
    // both preserves the work already recorded and walks the lane toward its
    // breaker, which pauses and reports instead of failing silently.
    return {
      ...retryable(EXTRACTION_ERROR_KIND_SINK_FAILED, error),
      ...(output.egressDestination ? { egressDestination: output.egressDestination } : {}),
    };
  }

  if (!accepted.accepted) {
    const reason = accepted.skippedReason;
    // Checked ahead of the skip table because it is the one refusal that is not
    // a decision about the item. The sink found the job in somebody else's
    // hands and refused to write; the work is still owed and the current holder
    // is doing it, so this settles exactly like the expiry branch above rather
    // than terminating a job that is perfectly healthy.
    if (reason === EXTRACTION_SINK_SKIPPED_CLAIM_SUPERSEDED) {
      return {
        status: 'failed_retryable',
        errorKind: EXTRACTION_ERROR_KIND_LEASE_LOST,
        leaseExpired: true,
        ...(output.egressDestination ? { egressDestination: output.egressDestination } : {}),
      };
    }
    const status = (reason !== undefined ? SINK_SKIP_SETTLEMENTS[reason] : undefined) ?? 'failed_terminal';
    return {
      status,
      ...(reason !== undefined ? { errorKind: reason } : {}),
      ...(output.derivations ? { derivations: output.derivations } : {}),
      ...(output.egressDestination ? { egressDestination: output.egressDestination } : {}),
    };
  }

  return {
    status: 'indexed',
    chunksIndexed: accepted.chunksIndexed,
    chunksAwaitingEmbedding: accepted.chunksAwaitingEmbedding,
    ...(output.derivations ? { derivations: output.derivations } : {}),
    ...(output.egressDestination ? { egressDestination: output.egressDestination } : {}),
  };
}

/**
 * Write the outcome, translating a refused write into the synthetic lost-lease
 * result rather than touching the database a second time.
 */
async function recordOutcome(
  jobs: LocalFileExtractionJobStore,
  job: LeasedExtractionJob,
  workerId: string,
  outcome: JobOutcome,
): Promise<ExtractionRunRecord> {
  const base = {
    jobId: job.jobId,
    extractorKind: job.extractorKind,
    extractorVersion: job.extractorVersion,
  };
  try {
    const result = jobs.record({
      jobId: job.jobId,
      workerId,
      // The whole fleet runs under one worker id, so the claim token is the
      // only thing separating this run from the one that superseded it.
      leaseToken: job.leaseToken,
      status: outcome.status,
      ...(outcome.errorKind !== undefined ? { errorKind: outcome.errorKind } : {}),
      ...(outcome.errorHash !== undefined ? { errorHash: outcome.errorHash } : {}),
      ...(outcome.derivations !== undefined ? { derivations: outcome.derivations } : {}),
      tempBytesCleaned: true,
    });
    return {
      ...base,
      status: result.status,
      attempts: result.attempts,
      ...(outcome.errorKind !== undefined ? { errorKind: outcome.errorKind } : {}),
      ...(result.nextRetryAt !== undefined ? { nextRetryAt: result.nextRetryAt } : {}),
      ...(outcome.chunksIndexed !== undefined ? { chunksIndexed: outcome.chunksIndexed } : {}),
      ...(outcome.chunksAwaitingEmbedding !== undefined
        ? { chunksAwaitingEmbedding: outcome.chunksAwaitingEmbedding }
        : {}),
      artifactsRecorded: result.artifactsRecorded,
      ...(outcome.egressDestination ? { egressDestination: outcome.egressDestination } : {}),
      ...(outcome.leaseExpired ? { leaseLost: true } : {}),
    };
  } catch (error) {
    if (!isLostLeaseRecordError(error)) throw error;
    // Somebody else holds this job now. Report it as retryable WITHOUT another
    // write: the current holder owns the row, and a second attempt here would
    // overwrite their result with ours.
    return {
      ...base,
      status: 'failed_retryable',
      attempts: job.attempts,
      errorKind: EXTRACTION_ERROR_KIND_LEASE_LOST,
      leaseLost: true,
    };
  }
}

// --- helpers ---------------------------------------------------------------

function retryable(errorKind: string, error: unknown): JobOutcome {
  return { status: 'failed_retryable', errorKind, errorHash: hashError(error) };
}

/**
 * A content-free digest of a failure, so identical failures group without any
 * provider prose, filename or path reaching the queue.
 */
function hashError(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return createHash('sha256').update(detail).digest('hex').slice(0, ERROR_HASH_CHARS);
}

/**
 * The store signals both halves of a lost lease with plain Errors. Matching the
 * message is not lovely; the alternative is treating every write failure as a
 * lost lease, which would hide a real defect behind an orderly retry.
 */
export function isLostLeaseRecordError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message.includes('does not hold the job lease')
    || message.includes('requires a leased job');
}

function leaseHasExpired(leaseExpiresAt: string, at: Date): boolean {
  const expiry = Date.parse(leaseExpiresAt);
  if (!Number.isFinite(expiry)) return false;
  return at.getTime() > expiry;
}

async function readTrustTier(
  corpus: ExtractionRunnerCorpus,
  ref: ExtractionItemRef,
): Promise<SourceTrustTier | undefined> {
  if (!corpus.trustTiers) return undefined;
  try {
    return await corpus.trustTiers.itemTrustTier(ref);
  } catch {
    // An unreadable tier is not permission. Returning undefined lands on the
    // gate's fail-closed branch.
    return undefined;
  }
}

async function runHealthProbe(
  probes: ExtractionHealthProbeMap,
  extractorKind: string | undefined,
): Promise<string | undefined> {
  if (extractorKind === undefined) return undefined;
  const probe = probes.get(extractorKind);
  if (!probe) return undefined;
  try {
    await probe();
    return undefined;
  } catch (error) {
    return healthProbeErrorKind(error);
  }
}

async function runHealthProbes(
  probes: ExtractionHealthProbeMap,
  extractorKind: string | undefined,
  preflightExtractorKinds: readonly string[] | undefined,
): Promise<string | undefined> {
  const kinds = extractorKind === undefined
    ? [...new Set(preflightExtractorKinds ?? [])]
    : [extractorKind];
  for (const kind of kinds) {
    const failure = await runHealthProbe(probes, kind);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

function healthProbeErrorKind(error: unknown): string {
  const value = error && typeof error === 'object' && 'errorKind' in error
    ? (error as { errorKind?: unknown }).errorKind
    : undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    return EXTRACTION_PAUSE_HEALTH_PROBE;
  }
  const valid = [...value].every((character) => (
    (character >= 'a' && character <= 'z')
    || (character >= '0' && character <= '9')
    || character === '_'
  ));
  return valid ? value : EXTRACTION_PAUSE_HEALTH_PROBE;
}

function countRecords(records: readonly ExtractionRunRecord[]): ExtractionRunCounts {
  const counts: Record<ExtractionTerminalStatus, number> = {
    indexed: 0,
    metadata_only: 0,
    skipped_unsupported: 0,
    skipped_too_large: 0,
    blocked_policy: 0,
    failed_retryable: 0,
    failed_terminal: 0,
  };
  for (const record of records) counts[record.status] += 1;
  return counts;
}

function pausedResult(input: {
  lane: ExtractionLaneKey;
  corpus: ExtractionRunnerCorpus;
  workerId: string;
  reason: string;
  preflightErrorKind: string;
  reclassification?: ExtractionReclassificationResult;
}): ExtractionRunResult {
  return {
    kind: 'file_extraction_run',
    corpusId: input.lane.corpusId,
    provider: input.lane.provider,
    accountScope: input.lane.accountScope,
    scopeKeyHash: hashToken(input.lane.approvedScopeKey),
    workerIdHash: hashToken(input.workerId),
    leasedJobs: 0,
    processedJobs: 0,
    abandonedLeases: 0,
    records: [],
    counts: countRecords([]),
    paused: true,
    pauseReason: input.reason,
    preflightErrorKind: input.preflightErrorKind,
    consecutiveRetryableFailures: 0,
    ...(input.reclassification ? { reclassification: input.reclassification } : {}),
    policy: {
      workerPrivateSurface: true,
      rawSourceExposed: false,
      sourceTextReturned: false,
      fileBytesPersisted: false,
      tempBytesCleaned: true,
      localOnly: true,
      trustDomain: input.corpus.trustDomain,
    },
  };
}

function extractionPlanPolicy(
  corpus: ExtractionRunnerCorpus,
  extractors: readonly Extractor[],
): ExtractionPlanResult['policy'] {
  const localOnly = extractors.every((extractor) => extractor.egress === 'local');
  return {
    workerPrivateSurface: true,
    rawSourceExposed: false,
    sourceTextReturned: false,
    fileBytesDownloaded: false,
    localOnly,
    trustDomain: corpus.trustDomain,
    ...summarizeEgressDestinations(
      extractors.map((extractor) => extractor.approvedRemoteDestination),
    ),
  };
}

function summarizeEgressDestinations(
  values: readonly (ExtractionApprovedRemoteDestination | undefined)[],
): { egressDestination?: ExtractionApprovedRemoteDestination } {
  const destinations = [...new Set(values.filter(
    (value): value is ExtractionApprovedRemoteDestination => value !== undefined,
  ))];
  if (destinations.length === 0) return {};
  if (destinations.length === 1) return { egressDestination: destinations[0]! };
  return { egressDestination: 'venice_mixed_approved' };
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
