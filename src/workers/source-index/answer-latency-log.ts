// Content-free source_answer latency ledger.
//
// Schema v1 remains additive for one release. Schema v2 records request-scoped
// timing and failure outcomes, but both schemas use strict field-by-field
// construction: no question, answer, document content, paths, or citations.

import {
  chmod,
  mkdir,
  open,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AnalystBackend,
  SourceIndexAnalystFallback,
  SourceIndexAnswerPhaseTimings,
  SourceIndexAnswerResult,
} from './answer-types.ts';
import type {
  SourceAnswerTraceAnalystLeg,
  SourceAnswerTraceOutcome,
  SourceAnswerTraceRetrievalAttempt,
  SourceAnswerTraceRouteStep,
  SourceAnswerTraceSnapshot,
} from './answer-latency-trace.ts';
import { sourceAnswerTraceErrorClass } from './answer-latency-trace.ts';

export interface SourceAnswerLatencyRecord {
  kind: 'source_answer_latency';
  logged_at: string;
  latency_ms: number;
  phase_timings?: SourceIndexAnswerPhaseTimings;
  searched_corpora: string[];
  skipped_corpora: Array<{ corpus_id: string; reason: string }>;
  lane_timeouts: string[];
  analyst_backend: AnalystBackend;
  analyst_fallback?: {
    from: SourceIndexAnalystFallback['from'];
    to: SourceIndexAnalystFallback['to'];
    reason: SourceIndexAnalystFallback['reason'];
    elapsed_ms?: number;
    timeout_ms?: number;
  };
  release_decision: string;
  released: boolean;
}

export interface SourceAnswerLatencyTraceRecord {
  kind: 'source_answer_latency_trace';
  schema_version: 2;
  correlation_id: string;
  compat_v1_logged_at?: string;
  logged_at: string;
  sample_kind: 'natural' | 'probe';
  outcome: SourceAnswerTraceOutcome;
  error_class?: string;
  latency_ms: number;
  sqlite: {
    retry_count: number;
    backoff_ms: number;
  };
  // elapsed_ms is the planner's own wall time even when the build abandoned it.
  // awaited_count is the one that answers "did the planner tax this answer?" —
  // it counts planner completions the evidence build actually waited on, while
  // ignored_after_strong_literal_count counts the ones a strong literal run
  // walked away from. failed_count is an outcome flag and may co-occur with
  // awaited_count (waited, then the leg errored and failed open).
  query_planner: {
    elapsed_ms: number;
    formulation_count: number;
    awaited_count: number;
    ignored_after_strong_literal_count: number;
    failed_count: number;
  };
  retrieval_attempts: SourceAnswerTraceRetrievalAttempt[];
  analyst_route: {
    resolution_ms: number;
    ordered_route: SourceAnswerTraceRouteStep[];
  };
  analyst_legs: SourceAnswerTraceAnalystLeg[];
  residual_analyst_orphan_count?: number;
  release_decision?: string;
  phase_ms: {
    lane_setup_ms: number;
    bulk_gate_ms: number;
    keyword_retrieval_ms: number;
    hybrid_retrieval_ms: number;
    selected_retrieval_ms: number;
    self_heal_ms: number;
    self_heal_rebuild_ms: number;
    analyst_ms: number;
    release_gate_ms: number;
    sqlite_backoff_ms: number;
    record_build_ms: number;
    append_ms: number;
    unattributed_ms: number;
  };
}

export type SourceAnswerLatencyLedgerRecord =
  | SourceAnswerLatencyRecord
  | SourceAnswerLatencyTraceRecord;

export interface SourceAnswerLatencyLedgerHealth {
  write_failure_count: number;
  last_failure_class?: string;
}

export interface SourceAnswerLatencyLog {
  record(entry: SourceAnswerLatencyLedgerRecord): void | Promise<void>;
  health?(): SourceAnswerLatencyLedgerHealth;
  recordFailure?(error: unknown): void;
}

export interface SourceAnswerLatencyFileLogOptions {
  maxBytes?: number;
}

export const DEFAULT_SOURCE_ANSWER_LATENCY_MAX_BYTES = 32 * 1024 * 1024;

// Strictly allowlisted v1 compatibility record.
export function buildSourceAnswerLatencyRecord(
  result: SourceIndexAnswerResult,
  now: () => Date = () => new Date(),
): SourceAnswerLatencyRecord {
  const audit = result.audit;
  const skipped = audit.skipped_corpora.map((skip) => ({
    corpus_id: skip.corpus_id,
    reason: skip.reason,
  }));
  const fallback = audit.answer_synthesis.analyst_fallback;
  const decision = result.opsec.release_decision.decision;
  return {
    kind: 'source_answer_latency',
    logged_at: now().toISOString(),
    latency_ms: audit.latency_ms,
    ...(audit.phase_timings ? { phase_timings: audit.phase_timings } : {}),
    searched_corpora: [...audit.searched_corpora],
    skipped_corpora: skipped,
    lane_timeouts: skipped.filter((skip) => skip.reason === 'lane_timeout').map((skip) => skip.corpus_id),
    analyst_backend: audit.answer_synthesis.analyst_backend,
    ...(fallback
      ? {
          analyst_fallback: {
            from: fallback.from,
            to: fallback.to,
            reason: fallback.reason,
            ...(fallback.elapsed_ms !== undefined ? { elapsed_ms: fallback.elapsed_ms } : {}),
            ...(fallback.timeout_ms !== undefined ? { timeout_ms: fallback.timeout_ms } : {}),
          },
        }
      : {}),
    release_decision: decision,
    released: decision === 'allow' || decision === 'redact',
  };
}

// Strictly allowlisted v2 trace. Detailed timings are nested diagnostics; the
// phase_ms buckets are the non-overlapping wall-time assignment.
export function buildSourceAnswerLatencyTraceRecord(input: {
  trace: SourceAnswerTraceSnapshot;
  outcome: SourceAnswerTraceOutcome;
  error?: unknown;
  now?: () => Date;
  sampleKind?: 'natural' | 'probe';
  compatV1LoggedAt?: string;
}): SourceAnswerLatencyTraceRecord {
  const now = (input.now ?? (() => new Date()))();
  const latencyMs = nonNegativeMs(now.getTime() - input.trace.receivedAtMs);
  const attempts = input.trace.retrievalAttempts.map(copyRetrievalAttempt);
  const evidenceBudget = nonNegativeMs(input.trace.phaseTimings?.evidence_pack_ms ?? sumAttemptMs(attempts));
  const retrievalBuckets = fitRetrievalAttemptsToBudget(attempts, evidenceBudget);
  const rawPhases = {
    lane_setup_ms: nonNegativeMs(input.trace.phaseTimings?.lane_setup_ms ?? 0),
    bulk_gate_ms: nonNegativeMs(input.trace.phaseTimings?.bulk_gate_ms ?? 0),
    keyword_retrieval_ms: retrievalBuckets.keyword,
    hybrid_retrieval_ms: retrievalBuckets.hybrid,
    selected_retrieval_ms: retrievalBuckets.selected,
    self_heal_ms: nonNegativeMs(input.trace.phaseTimings?.self_heal_ms ?? 0),
    self_heal_rebuild_ms: retrievalBuckets.selfHealRebuild,
    analyst_ms: nonNegativeMs(
      input.trace.phaseTimings?.analyst_ms
        ?? input.trace.routeResolutionMs + input.trace.analystLegs.reduce((sum, leg) => sum + leg.elapsed_ms, 0),
    ),
    release_gate_ms: nonNegativeMs(input.trace.phaseTimings?.release_gate_ms ?? 0),
    sqlite_backoff_ms: nonNegativeMs(input.trace.sqliteBackoffMs),
    record_build_ms: nonNegativeMs(input.trace.recordBuildMs),
    append_ms: nonNegativeMs(input.trace.appendMs),
  };
  const fittedPhases = fitPhaseBucketsToWall(rawPhases, latencyMs);
  const assignedMs = Object.values(fittedPhases).reduce((sum, value) => sum + value, 0);
  const unattributedMs = Math.max(0, latencyMs - assignedMs);

  return {
    kind: 'source_answer_latency_trace',
    schema_version: 2,
    correlation_id: input.trace.correlationId,
    ...(input.compatV1LoggedAt ? { compat_v1_logged_at: input.compatV1LoggedAt } : {}),
    logged_at: now.toISOString(),
    sample_kind: input.sampleKind ?? 'natural',
    outcome: input.outcome,
    ...(input.error !== undefined
      ? { error_class: sourceAnswerTraceErrorClass(input.error) }
      : {}),
    latency_ms: latencyMs,
    sqlite: {
      retry_count: Math.max(0, Math.floor(input.trace.sqliteRetryCount)),
      backoff_ms: nonNegativeMs(input.trace.sqliteBackoffMs),
    },
    query_planner: {
      elapsed_ms: nonNegativeMs(input.trace.queryPlannerMs),
      formulation_count: Math.max(0, Math.floor(input.trace.queryFormulationCount)),
      awaited_count: Math.max(0, Math.floor(input.trace.queryPlannerAwaitedCount)),
      ignored_after_strong_literal_count: Math.max(
        0,
        Math.floor(input.trace.queryPlannerIgnoredAfterStrongLiteralCount),
      ),
      failed_count: Math.max(0, Math.floor(input.trace.queryPlannerFailedCount)),
    },
    retrieval_attempts: attempts,
    analyst_route: {
      resolution_ms: nonNegativeMs(input.trace.routeResolutionMs),
      ordered_route: input.trace.orderedRoute.map((step) => ({
        profile_id: step.profile_id,
        backend: step.backend,
        model_id: step.model_id,
      })),
    },
    analyst_legs: input.trace.analystLegs.map((leg) => ({
      profile_id: leg.profile_id,
      backend: leg.backend,
      model_id: leg.model_id,
      budget_ms: nonNegativeMs(leg.budget_ms),
      elapsed_ms: nonNegativeMs(leg.elapsed_ms),
      outcome: leg.outcome,
      ...(leg.error_class ? { error_class: leg.error_class } : {}),
    })),
    residual_analyst_orphan_count: Math.max(
      0,
      Math.floor(input.trace.residualAnalystOrphanCount),
    ),
    ...(input.trace.releaseDecision ? { release_decision: input.trace.releaseDecision } : {}),
    phase_ms: {
      ...fittedPhases,
      unattributed_ms: unattributedMs,
    },
  };
}

// Low-level append with owner-only permissions and size-based one-predecessor
// rotation. chmod handles ledgers created previously with broader modes.
export async function appendSourceAnswerLatencyLine(
  path: string,
  record: SourceAnswerLatencyLedgerRecord,
  options: SourceAnswerLatencyFileLogOptions = {},
): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const maxBytes = options.maxBytes ?? DEFAULT_SOURCE_ANSWER_LATENCY_MAX_BYTES;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await makeExistingLedgerPrivate(path);
  if (Number.isFinite(maxBytes) && maxBytes > 0) {
    await rotateLatencyLedgerIfNeeded(path, Buffer.byteLength(line), maxBytes);
  }
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.appendFile(line, 'utf8');
  } finally {
    await handle.close();
  }
}

export function createFileSourceAnswerLatencyLog(
  path: string,
  options: SourceAnswerLatencyFileLogOptions = {},
): SourceAnswerLatencyLog {
  let writeFailureCount = 0;
  let lastFailureClass: string | undefined;
  let queue = Promise.resolve();

  const noteFailure = (error: unknown): void => {
    writeFailureCount += 1;
    lastFailureClass = sourceAnswerTraceErrorClass(error);
    console.error(
      `[source-answer-latency] write failed error_class=${lastFailureClass}`,
    );
  };

  return {
    record(entry: SourceAnswerLatencyLedgerRecord): Promise<void> {
      queue = queue.then(async () => {
        try {
          await appendSourceAnswerLatencyLine(path, entry, options);
        } catch (error) {
          noteFailure(error);
        }
      });
      return queue;
    },
    health(): SourceAnswerLatencyLedgerHealth {
      return {
        write_failure_count: writeFailureCount,
        ...(lastFailureClass ? { last_failure_class: lastFailureClass } : {}),
      };
    },
    recordFailure(error: unknown): void {
      noteFailure(error);
    },
  };
}

export function resolveSourceAnswerLatencyLogPath(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env.OLYMPUS_SOURCE_ANSWER_LATENCY_LOG_PATH?.trim();
  if (raw) {
    const lowered = raw.toLowerCase();
    if (lowered === 'off' || lowered === 'none' || lowered === 'disabled' || lowered === 'false' || lowered === '0') {
      return undefined;
    }
    return raw;
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'source-answer-latency.jsonl');
}

async function makeExistingLedgerPrivate(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

async function rotateLatencyLedgerIfNeeded(
  path: string,
  incomingBytes: number,
  maxBytes: number,
): Promise<void> {
  let currentBytes = 0;
  try {
    currentBytes = (await stat(path)).size;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return;
  }
  if (currentBytes + incomingBytes <= maxBytes) return;

  const predecessor = `${path}.1`;
  try {
    await unlink(predecessor);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  await rename(path, predecessor);
  await chmod(predecessor, 0o600);
}

function isMissingFileError(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === 'ENOENT';
}

function copyRetrievalAttempt(
  attempt: SourceAnswerTraceRetrievalAttempt,
): SourceAnswerTraceRetrievalAttempt {
  return {
    kind: attempt.kind,
    elapsed_ms: nonNegativeMs(attempt.elapsed_ms),
    hydration_ms: nonNegativeMs(attempt.hydration_ms),
    queries: attempt.queries.map((query) => ({
      ordinal: Math.max(1, Math.floor(query.ordinal)),
      elapsed_ms: nonNegativeMs(query.elapsed_ms),
      corpus_timings: query.corpus_timings.map((timing) => ({
        corpus_id: timing.corpus_id,
        elapsed_ms: nonNegativeMs(timing.elapsed_ms),
        ...(timing.adapter_reported_ms !== undefined
          ? { adapter_reported_ms: nonNegativeMs(timing.adapter_reported_ms) }
          : {}),
        outcome: timing.outcome,
        ...(timing.error_class ? { error_class: timing.error_class } : {}),
      })),
    })),
  };
}

function sumAttemptMs(attempts: readonly SourceAnswerTraceRetrievalAttempt[]): number {
  return attempts.reduce((sum, attempt) => sum + nonNegativeMs(attempt.elapsed_ms), 0);
}

function fitRetrievalAttemptsToBudget(
  attempts: readonly SourceAnswerTraceRetrievalAttempt[],
  budgetMs: number,
): { keyword: number; hybrid: number; selected: number; selfHealRebuild: number } {
  const raw = {
    keyword: attempts.filter((attempt) => attempt.kind === 'keyword').reduce((sum, attempt) => sum + attempt.elapsed_ms, 0),
    hybrid: attempts.filter((attempt) => attempt.kind === 'hybrid').reduce((sum, attempt) => sum + attempt.elapsed_ms, 0),
    selected: attempts.filter((attempt) => attempt.kind === 'selected').reduce((sum, attempt) => sum + attempt.elapsed_ms, 0),
    selfHealRebuild: attempts.filter((attempt) => attempt.kind === 'self_heal_rebuild').reduce((sum, attempt) => sum + attempt.elapsed_ms, 0),
  };
  const rawTotal = raw.keyword + raw.hybrid + raw.selected + raw.selfHealRebuild;
  if (rawTotal === 0 || rawTotal <= budgetMs) return raw;
  const ratio = budgetMs / rawTotal;
  const fitted = {
    keyword: Math.floor(raw.keyword * ratio),
    hybrid: Math.floor(raw.hybrid * ratio),
    selected: Math.floor(raw.selected * ratio),
    selfHealRebuild: Math.floor(raw.selfHealRebuild * ratio),
  };
  const fittedTotal = fitted.keyword + fitted.hybrid + fitted.selected + fitted.selfHealRebuild;
  fitted.keyword += Math.max(0, budgetMs - fittedTotal);
  return fitted;
}

function fitPhaseBucketsToWall<T extends Record<string, number>>(
  phases: T,
  wallMs: number,
): T {
  const total = Object.values(phases).reduce((sum, value) => sum + value, 0);
  if (total <= wallMs || total === 0) return phases;
  const ratio = wallMs / total;
  const entries = Object.entries(phases);
  const fitted: Record<string, number> = Object.fromEntries(entries.map(([key, value]) => [
    key,
    Math.floor(value * ratio),
  ]));
  const fittedTotal = Object.values(fitted).reduce((sum, value) => sum + value, 0);
  const firstNonZero = entries.find(([, value]) => value > 0)?.[0];
  if (firstNonZero) fitted[firstNonZero] = (fitted[firstNonZero] ?? 0) + Math.max(0, wallMs - fittedTotal);
  return fitted as T;
}

function nonNegativeMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
