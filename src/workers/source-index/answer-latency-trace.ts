import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AnalystBackend, SourceIndexAnswerPhaseTimings } from './answer-types.ts';

export type SourceAnswerTraceOutcome =
  | 'success'
  | 'error'
  | 'timeout'
  | 'route_exhausted'
  | 'cancelled'
  | 'parse_error';

export type SourceAnswerRetrievalAttemptKind =
  | 'keyword'
  | 'hybrid'
  | 'selected'
  | 'self_heal_rebuild';

// What the evidence build did with the query planner, recorded as counts only.
// 'awaited' and 'ignored_after_strong_literal' are the WAIT disposition and are
// mutually exclusive per planner call: the planner completion races the literal
// retrieval, so either the build paid its remaining time ('awaited') or walked
// away from it once the literal run came back strong. 'failed' is an outcome
// flag, not a wait disposition — it can accompany 'awaited' when the build
// waited on a planner leg that then errored and failed open.
export type SourceAnswerQueryPlannerDisposition =
  | 'awaited'
  | 'ignored_after_strong_literal'
  | 'failed';

export interface SourceAnswerTraceCorpusTiming {
  corpus_id: string;
  elapsed_ms: number;
  adapter_reported_ms?: number;
  outcome: 'success' | 'timeout' | 'error';
  error_class?: string;
  // The lane's reads on the store read pool (#1305), present only when it
  // made any: how many, how long they waited for a pool thread and ran on
  // one, and how many ended without rows, by cause. Counts and times only.
  pool?: SourceAnswerTracePoolReads;
}

export interface SourceAnswerTracePoolReads {
  reads: number;
  queue_wait_ms: number;
  queue_wait_max_ms: number;
  run_ms: number;
  run_max_ms: number;
  // Refused at once: the store's queue was full, or the deadline had passed.
  refused: number;
  // Still waiting for a thread at the deadline.
  dropped_queued: number;
  // Still running at the deadline (its thread terminated) or back too late.
  past_deadline_running: number;
  errors: number;
}

/** How one pool read ended, for the trace. */
export type SourceAnswerPoolReadOutcome = 'rows' | 'refused' | 'dropped_queued' | 'past_deadline_running' | 'error';

export interface SourceAnswerTraceQueryTiming {
  ordinal: number;
  elapsed_ms: number;
  corpus_timings: SourceAnswerTraceCorpusTiming[];
}

export interface SourceAnswerTraceRetrievalAttempt {
  kind: SourceAnswerRetrievalAttemptKind;
  elapsed_ms: number;
  hydration_ms: number;
  queries: SourceAnswerTraceQueryTiming[];
}

export interface SourceAnswerTraceRouteStep {
  profile_id: string;
  backend: AnalystBackend;
  model_id: string;
}

export interface SourceAnswerTraceAnalystLeg extends SourceAnswerTraceRouteStep {
  budget_ms: number;
  elapsed_ms: number;
  outcome: 'success' | 'error' | 'timeout' | 'policy_skipped' | 'breaker_skipped' | 'unavailable';
  error_class?: string;
}

// The evidence pack's seat order (#1354): the store id at each seat, how many
// seats were recency seats, and, per prompt fit an Analyst leg made, the seat
// numbers (1-based) it kept. Store ids and counts only.
export interface SourceAnswerTraceEvidenceSeats {
  packCorpora: string[];
  recencySeats: number;
  fits: SourceAnswerTraceAnalystFit[];
}

export interface SourceAnswerTraceAnalystFit {
  lane: 'local' | 'cloud';
  keptSeats: number[];
}

export interface SourceAnswerTraceSnapshot {
  correlationId: string;
  receivedAt: string;
  receivedAtMs: number;
  sqliteRetryCount: number;
  sqliteBackoffMs: number;
  // Planner wall time, whether or not the build waited for it: an abandoned
  // completion still reports its own elapsed time when it eventually settles.
  // The disposition counters below are what say whether that time was ON the
  // answer's critical path.
  queryPlannerMs: number;
  queryFormulationCount: number;
  queryPlannerAwaitedCount: number;
  queryPlannerIgnoredAfterStrongLiteralCount: number;
  queryPlannerFailedCount: number;
  retrievalAttempts: SourceAnswerTraceRetrievalAttempt[];
  routeResolutionMs: number;
  orderedRoute: SourceAnswerTraceRouteStep[];
  analystLegs: SourceAnswerTraceAnalystLeg[];
  residualAnalystOrphanCount: number;
  phaseTimings?: SourceIndexAnswerPhaseTimings;
  selfHealRebuildMs: number;
  recordBuildMs: number;
  appendMs: number;
  releaseDecision?: string;
  evidenceSeats?: SourceAnswerTraceEvidenceSeats;
}

interface MutableTrace extends SourceAnswerTraceSnapshot {
  activeAttempt?: {
    kind: SourceAnswerRetrievalAttemptKind;
    startedAtMs: number;
    hydrationMs: number;
    queries: SourceAnswerTraceQueryTiming[];
  };
  activeQuery?: ActiveQuery;
}

interface ActiveQuery {
  ordinal: number;
  startedAtMs: number;
  corpusTimings: SourceAnswerTraceCorpusTiming[];
  poolByCorpus: Map<string, SourceAnswerTracePoolReads>;
}

const storage = new AsyncLocalStorage<MutableTrace>();
// The corpus lane a search adapter is running for, so a pool read made deep
// inside the adapter is counted against its lane.
const laneStorage = new AsyncLocalStorage<string>();

/** Runs one corpus lane's search, so the pool reads it makes are traced against that corpus. */
export function runInSourceAnswerLane<T>(corpusId: string, run: () => T): T {
  return laneStorage.run(corpusId, run);
}

/**
 * Called by the read pool when a read is asked for. Returns how to report
 * its end, or undefined when no traced Ask lane made it. The lane and query
 * are captured now: the read ends in a pool callback outside their context.
 */
export function beginSourceAnswerPoolRead():
  | ((report: { queueWaitMs: number; runMs: number; outcome: SourceAnswerPoolReadOutcome }) => void)
  | undefined {
  const query = currentSourceAnswerTrace()?.activeQuery;
  const corpusId = laneStorage.getStore();
  if (!query || corpusId === undefined) return undefined;
  return ({ queueWaitMs, runMs, outcome }) => {
    let reads = query.poolByCorpus.get(corpusId);
    if (!reads) {
      reads = {
        reads: 0,
        queue_wait_ms: 0,
        queue_wait_max_ms: 0,
        run_ms: 0,
        run_max_ms: 0,
        refused: 0,
        dropped_queued: 0,
        past_deadline_running: 0,
        errors: 0,
      };
      query.poolByCorpus.set(corpusId, reads);
    }
    const wait = nonNegativeMs(queueWaitMs);
    const ran = nonNegativeMs(runMs);
    reads.reads += 1;
    reads.queue_wait_ms += wait;
    reads.queue_wait_max_ms = Math.max(reads.queue_wait_max_ms, wait);
    reads.run_ms += ran;
    reads.run_max_ms = Math.max(reads.run_max_ms, ran);
    if (outcome === 'refused') reads.refused += 1;
    else if (outcome === 'dropped_queued') reads.dropped_queued += 1;
    else if (outcome === 'past_deadline_running') reads.past_deadline_running += 1;
    else if (outcome === 'error') reads.errors += 1;
  };
}
const CONTENT_FREE_ERROR_CLASSES = new Set([
  'AbortError',
  'AnalystUnavailable',
  'AnalystCircuitOpen',
  'EmailSourceWorkerError',
  'Error',
  'LocalTrustProviderMismatch',
  'OperationError',
  'RangeError',
  'SourceModelPolicyDeniedError',
  'SecureEvidencePolicySkip',
  'SecureAnalystPoolE2EEGateError',
  'SyntaxError',
  'TrustedAnalystTimeoutError',
  'TypeError',
]);

export function createSourceAnswerTrace(now: () => Date = () => new Date()): MutableTrace {
  const received = now();
  return {
    correlationId: randomUUID(),
    receivedAt: received.toISOString(),
    receivedAtMs: received.getTime(),
    sqliteRetryCount: 0,
    sqliteBackoffMs: 0,
    queryPlannerMs: 0,
    queryFormulationCount: 0,
    queryPlannerAwaitedCount: 0,
    queryPlannerIgnoredAfterStrongLiteralCount: 0,
    queryPlannerFailedCount: 0,
    retrievalAttempts: [],
    routeResolutionMs: 0,
    orderedRoute: [],
    analystLegs: [],
    residualAnalystOrphanCount: 0,
    selfHealRebuildMs: 0,
    recordBuildMs: 0,
    appendMs: 0,
  };
}

export function runWithSourceAnswerTrace<T>(
  trace: MutableTrace,
  run: () => T | Promise<T>,
): Promise<T> {
  return Promise.resolve(storage.run(trace, run));
}

export function currentSourceAnswerTrace(): MutableTrace | undefined {
  return storage.getStore();
}

export function recordSourceAnswerPhaseTimings(timings: SourceIndexAnswerPhaseTimings): void {
  const trace = currentSourceAnswerTrace();
  if (trace) trace.phaseTimings = { ...timings };
}

export function recordSourceAnswerSqliteRetry(backoffMs: number): void {
  const trace = currentSourceAnswerTrace();
  if (!trace) return;
  trace.sqliteRetryCount += 1;
  trace.sqliteBackoffMs += nonNegativeMs(backoffMs);
}

export function recordSourceAnswerQueryPlanner(elapsedMs: number, formulationCount: number): void {
  const trace = currentSourceAnswerTrace();
  if (!trace) return;
  trace.queryPlannerMs += nonNegativeMs(elapsedMs);
  trace.queryFormulationCount += Math.max(0, Math.floor(formulationCount));
}

// Counts only — no query text, no planner output, ever.
export function recordSourceAnswerQueryPlannerDisposition(
  disposition: SourceAnswerQueryPlannerDisposition,
): void {
  const trace = currentSourceAnswerTrace();
  if (!trace) return;
  if (disposition === 'awaited') trace.queryPlannerAwaitedCount += 1;
  else if (disposition === 'ignored_after_strong_literal') {
    trace.queryPlannerIgnoredAfterStrongLiteralCount += 1;
  } else trace.queryPlannerFailedCount += 1;
}

export async function observeSourceAnswerRetrievalAttempt<T>(
  kind: SourceAnswerRetrievalAttemptKind,
  run: () => Promise<T>,
): Promise<T> {
  const trace = currentSourceAnswerTrace();
  if (!trace) return run();
  const previous = trace.activeAttempt;
  const attempt = {
    kind,
    startedAtMs: Date.now(),
    hydrationMs: 0,
    queries: [] as SourceAnswerTraceQueryTiming[],
  };
  trace.activeAttempt = attempt;
  try {
    return await run();
  } finally {
    const elapsedMs = nonNegativeMs(Date.now() - attempt.startedAtMs);
    trace.retrievalAttempts.push({
      kind,
      elapsed_ms: elapsedMs,
      hydration_ms: attempt.hydrationMs,
      queries: attempt.queries,
    });
    if (kind === 'self_heal_rebuild') trace.selfHealRebuildMs += elapsedMs;
    if (previous) trace.activeAttempt = previous;
    else delete trace.activeAttempt;
  }
}

export function recordSourceAnswerHydration(elapsedMs: number): void {
  const attempt = currentSourceAnswerTrace()?.activeAttempt;
  if (attempt) attempt.hydrationMs += nonNegativeMs(elapsedMs);
}

export async function observeSourceAnswerRoutedQuery<T>(
  ordinal: number,
  run: () => Promise<T>,
): Promise<T> {
  const trace = currentSourceAnswerTrace();
  const attempt = trace?.activeAttempt;
  if (!trace || !attempt) return run();
  const previous = trace.activeQuery;
  const query: ActiveQuery = {
    ordinal: Math.max(1, Math.floor(ordinal)),
    startedAtMs: Date.now(),
    corpusTimings: [],
    poolByCorpus: new Map(),
  };
  trace.activeQuery = query;
  try {
    return await run();
  } finally {
    attempt.queries.push({
      ordinal: query.ordinal,
      elapsed_ms: nonNegativeMs(Date.now() - query.startedAtMs),
      corpus_timings: query.corpusTimings.map((timing) => ({
        corpus_id: timing.corpus_id,
        elapsed_ms: nonNegativeMs(timing.elapsed_ms),
        ...(timing.adapter_reported_ms !== undefined
          ? { adapter_reported_ms: nonNegativeMs(timing.adapter_reported_ms) }
          : {}),
        outcome: timing.outcome,
        ...(timing.error_class ? { error_class: sanitizeErrorClass(timing.error_class) } : {}),
        ...(query.poolByCorpus.has(timing.corpus_id) ? { pool: { ...query.poolByCorpus.get(timing.corpus_id)! } } : {}),
      })),
    });
    if (previous) trace.activeQuery = previous;
    else delete trace.activeQuery;
  }
}

export function recordSourceAnswerCorpusTiming(timing: SourceAnswerTraceCorpusTiming): void {
  const query = currentSourceAnswerTrace()?.activeQuery;
  if (!query) return;
  query.corpusTimings.push({
      corpus_id: timing.corpus_id,
      elapsed_ms: nonNegativeMs(timing.elapsed_ms),
      ...(timing.adapter_reported_ms !== undefined
        ? { adapter_reported_ms: nonNegativeMs(timing.adapter_reported_ms) }
        : {}),
      outcome: timing.outcome,
      ...(timing.error_class ? { error_class: sanitizeErrorClass(timing.error_class) } : {}),
  });
}

export function recordSourceAnswerRoute(
  elapsedMs: number,
  route: readonly SourceAnswerTraceRouteStep[],
): void {
  const trace = currentSourceAnswerTrace();
  if (!trace) return;
  trace.routeResolutionMs += nonNegativeMs(elapsedMs);
  trace.orderedRoute = route.map((step) => ({
    profile_id: step.profile_id,
    backend: step.backend,
    model_id: step.model_id,
  }));
}

export async function observeSourceAnswerAnalystLeg<T>(
  input: SourceAnswerTraceRouteStep & { budgetMs: number },
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    recordAnalystLeg(input, startedAt, 'success');
    return result;
  } catch (error) {
    recordAnalystLeg(
      input,
      startedAt,
      errorClass(error) === 'TrustedAnalystTimeoutError' ? 'timeout' : 'error',
      error,
    );
    throw error;
  }
}

export function recordSourceAnswerSkippedAnalystLeg(
  input: SourceAnswerTraceRouteStep & {
    budgetMs: number;
    errorClass: string;
    outcome?: 'policy_skipped' | 'breaker_skipped' | 'unavailable';
  },
): void {
  const trace = currentSourceAnswerTrace();
  if (!trace) return;
  trace.analystLegs.push({
    profile_id: input.profile_id,
    backend: input.backend,
    model_id: input.model_id,
    budget_ms: nonNegativeMs(input.budgetMs),
    elapsed_ms: 0,
    outcome: input.outcome ?? 'policy_skipped',
    error_class: sanitizeErrorClass(input.errorClass),
  });
}

// A rebuilt pack (the private-outage fallback) replaces the earlier one and
// starts its own list of fits.
export function recordSourceAnswerPackSeats(corpusIds: readonly string[], recencySeats = 0): void {
  const trace = currentSourceAnswerTrace();
  if (!trace) return;
  trace.evidenceSeats = {
    packCorpora: [...corpusIds],
    recencySeats: nonNegativeCount(recencySeats),
    fits: [],
  };
}

export function recordSourceAnswerAnalystFit(lane: SourceAnswerTraceAnalystFit['lane'], keptSeats: readonly number[]): void {
  const seats = currentSourceAnswerTrace()?.evidenceSeats;
  if (!seats) return;
  seats.fits.push({ lane, keptSeats: keptSeats.map(nonNegativeCount) });
}

export function recordSourceAnswerResidualAnalystOrphan(): void {
  const trace = currentSourceAnswerTrace();
  if (trace) trace.residualAnalystOrphanCount += 1;
}

export function recordSourceAnswerReleaseDecision(decision: string): void {
  const trace = currentSourceAnswerTrace();
  if (trace) trace.releaseDecision = decision;
}

export function recordSourceAnswerLedgerBuild(elapsedMs: number): void {
  const trace = currentSourceAnswerTrace();
  if (trace) trace.recordBuildMs += nonNegativeMs(elapsedMs);
}

export function recordSourceAnswerLedgerAppend(elapsedMs: number): void {
  const trace = currentSourceAnswerTrace();
  if (trace) trace.appendMs += nonNegativeMs(elapsedMs);
}

export function snapshotSourceAnswerTrace(trace: MutableTrace): SourceAnswerTraceSnapshot {
  return {
    correlationId: trace.correlationId,
    receivedAt: trace.receivedAt,
    receivedAtMs: trace.receivedAtMs,
    sqliteRetryCount: trace.sqliteRetryCount,
    sqliteBackoffMs: trace.sqliteBackoffMs,
    queryPlannerMs: trace.queryPlannerMs,
    queryFormulationCount: trace.queryFormulationCount,
    queryPlannerAwaitedCount: trace.queryPlannerAwaitedCount,
    queryPlannerIgnoredAfterStrongLiteralCount: trace.queryPlannerIgnoredAfterStrongLiteralCount,
    queryPlannerFailedCount: trace.queryPlannerFailedCount,
    retrievalAttempts: trace.retrievalAttempts.map((attempt) => ({
      ...attempt,
      queries: attempt.queries.map((query) => ({
        ...query,
        corpus_timings: query.corpus_timings.map((timing) => ({ ...timing, ...(timing.pool ? { pool: { ...timing.pool } } : {}) })),
      })),
    })),
    routeResolutionMs: trace.routeResolutionMs,
    orderedRoute: trace.orderedRoute.map((step) => ({ ...step })),
    analystLegs: trace.analystLegs.map((leg) => ({ ...leg })),
    residualAnalystOrphanCount: Math.max(0, Math.floor(trace.residualAnalystOrphanCount)),
    ...(trace.phaseTimings ? { phaseTimings: { ...trace.phaseTimings } } : {}),
    selfHealRebuildMs: trace.selfHealRebuildMs,
    recordBuildMs: trace.recordBuildMs,
    appendMs: trace.appendMs,
    ...(trace.releaseDecision ? { releaseDecision: trace.releaseDecision } : {}),
    ...(trace.evidenceSeats
      ? {
        evidenceSeats: {
          packCorpora: [...trace.evidenceSeats.packCorpora],
          recencySeats: trace.evidenceSeats.recencySeats,
          fits: trace.evidenceSeats.fits.map((fit) => ({ lane: fit.lane, keptSeats: [...fit.keptSeats] })),
        },
      }
      : {}),
  };
}

export function sourceAnswerTraceErrorClass(error: unknown): string {
  return sanitizeErrorClass(errorClass(error));
}

function recordAnalystLeg(
  input: SourceAnswerTraceRouteStep & { budgetMs: number },
  startedAt: number,
  outcome: SourceAnswerTraceAnalystLeg['outcome'],
  error?: unknown,
): void {
  const trace = currentSourceAnswerTrace();
  if (!trace) return;
  trace.analystLegs.push({
    profile_id: input.profile_id,
    backend: input.backend,
    model_id: input.model_id,
    budget_ms: nonNegativeMs(input.budgetMs),
    elapsed_ms: nonNegativeMs(Date.now() - startedAt),
    outcome,
    ...(error !== undefined ? { error_class: sourceAnswerTraceErrorClass(error) } : {}),
  });
}

function errorClass(error: unknown): string {
  const candidate = error as { name?: unknown; constructor?: { name?: unknown } } | null | undefined;
  if (typeof candidate?.name === 'string' && candidate.name.trim()) return candidate.name;
  if (typeof candidate?.constructor?.name === 'string' && candidate.constructor.name.trim()) {
    return candidate.constructor.name;
  }
  return 'UnknownError';
}

function sanitizeErrorClass(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64);
  return CONTENT_FREE_ERROR_CLASSES.has(normalized) ? normalized : 'Error';
}

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function nonNegativeMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
