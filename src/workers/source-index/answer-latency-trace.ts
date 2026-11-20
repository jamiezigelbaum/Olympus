import type { KeywordPreparation } from '../../core/source-index/keyword-expansion.ts';
import type { EvidenceRerankAudit } from '../../core/evidence-reranker.ts';
import type { AnalystEvidenceFormat } from '../../core/analyst.ts';
import type { LocalAnalystPromptBudget } from './local-analyst-window.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { noteSourceAnswerProgress } from '../../core/source-answer-jobs.ts';
import { withStoreReadPriority } from '../../core/store-reclaim-admission.ts';
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
  | 'failed'
  | 'search_budget_spent';

export interface SourceAnswerTraceCorpusTiming {
  corpus_id: string;
  elapsed_ms: number;
  adapter_reported_ms?: number;
  outcome: 'success' | 'timeout' | 'error';
  error_class?: string;
  adapter_stages?: SourceAnswerTraceAdapterStages;
  // Store read-pool timings, outcomes and retrieval work counts.
  pool?: SourceAnswerTracePoolReads;
}

export interface SourceAnswerTraceAdapterStages {
  adapter_elapsed_ms: number;
  keyword_lane_ms: number;
  vector_lane_ms?: number;
  // Includes the concurrent lanes. Count this once in the adapter's wall time.
  join_wait_ms?: number;
  post_join_setup_ms?: number;
  keyword_relaxation_ms: number;
  keyword_revalidation_ms: number;
  vector_revalidation_ms?: number;
  vector_summary_ms?: number;
  recency_read_ms: number;
  fusion_ms: number;
  finalize_ms: number;
  unattributed_ms: number;
}

interface SourceAnswerTraceVectorWork {
  digest_pages_read: number;
  digest_rows_scanned: number;
  full_vectors_rescored: number;
  digest_unpack_score_ms: number;
}

interface SourceAnswerTraceConceptCount {
  matched_items: number;
  memo_hit: boolean;
}

export interface SourceAnswerTracePoolReads {
  reads: number;
  queue_wait_ms: number;
  queue_wait_max_ms: number;
  run_ms: number;
  run_max_ms: number;
  // The statements' own time on the pool thread, inside run_ms. The rest of
  // run_ms is the trip back: the row copy and the wait for the request thread.
  sql_ms: number;
  sql_max_ms: number;
  // The part of reads and sql_ms read inside one snapshot (the exact-vector
  // scan's pages); the rest are single queries (keyword search, recency).
  snapshot_reads: number;
  snapshot_sql_ms: number;
  // Refused at once: the store's queue was full, or the deadline had passed.
  refused: number;
  // Still waiting for a thread at the deadline.
  dropped_queued: number;
  // Still running at the deadline (result abandoned) or back too late.
  past_deadline_running: number;
  errors: number;
  thread_cpu_available?: boolean;
  vector_work?: SourceAnswerTraceVectorWork;
  // One array per concept-weighting pass, in concept order.
  keyword_concept_counts?: SourceAnswerTraceConceptCount[][];
  // The statements that took the most SQL time, by statement shape (the SQL
  // prefix and a hash of the full normalized shape), slowest first.
  slowest_sql?: SourceAnswerTracePoolSqlSite[];
}

export interface SourceAnswerTracePoolSqlSite {
  site: string;
  label?: string;
  reads: number;
  sql_ms: number;
  sql_max_ms: number;
  sql_cpu_ms?: number;
  sql_cpu_max_ms?: number;
}

const POOL_SQL_SITE_CHARS = 120;
const POOL_SQL_SITES_KEPT = 5;
const poolSqlSites = new WeakMap<SourceAnswerTracePoolReads, Map<string, SourceAnswerTracePoolSqlSite>>();

/** A readable prefix and a stable hash of the full redacted SQL shape. */
export function poolSqlSite(sql: string): string {
  // Literals go: a statement that inlined a value (a quoted term, an id list)
  // must not carry it into the trace, which holds counts and code only.
  const shape = sql
    .replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\//g, (token) =>
      token.startsWith('--') || token.startsWith('/*') ? ' ' : '?')
    .replace(/\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi, 'N')
    .replace(/\s+/g, ' ')
    .trim();
  const hash = createHash('sha256').update(shape).digest('hex').slice(0, 16);
  const prefix = shape.replace(/\(\s*(?:\?|N)(?:\s*,\s*(?:\?|N))+\s*\)/g, '(…)');
  return `${prefix.slice(0, POOL_SQL_SITE_CHARS)} #${hash}`;
}

function withSlowestSql(reads: SourceAnswerTracePoolReads): SourceAnswerTracePoolReads {
  const sites = poolSqlSites.get(reads);
  const slowest = sites?.size ? [...sites.values()].sort((left, right) => right.sql_ms - left.sql_ms).slice(0, POOL_SQL_SITES_KEPT)
    .map((site) => ({
      ...site,
      sql_ms: preciseMs(site.sql_ms),
      sql_max_ms: preciseMs(site.sql_max_ms),
      ...(site.sql_cpu_ms !== undefined ? { sql_cpu_ms: preciseMs(site.sql_cpu_ms), sql_cpu_max_ms: preciseMs(site.sql_cpu_max_ms!) } : {}),
    })) : undefined;
  return copyPoolDetail({ ...reads, ...(slowest ? { slowest_sql: slowest } : {}) });
}

function copyPoolDetail(pool: SourceAnswerTracePoolReads): SourceAnswerTracePoolReads {
  return {
    ...pool,
    ...(pool.slowest_sql ? { slowest_sql: pool.slowest_sql.map((site) => ({ ...site })) } : {}),
    ...(pool.vector_work ? { vector_work: { ...pool.vector_work, digest_unpack_score_ms: preciseMs(pool.vector_work.digest_unpack_score_ms) } } : {}),
    ...(pool.keyword_concept_counts ? { keyword_concept_counts: pool.keyword_concept_counts.map((pass) => pass.map((count) => ({ ...count }))) } : {}),
  };
}

export function preciseMs(ms: number): number {
  return Math.round(unroundedMs(ms) * 1000) / 1000;
}

/** How one pool read ended, for the trace. */
export type SourceAnswerPoolReadOutcome = 'rows' | 'refused' | 'dropped_queued' | 'past_deadline_running' | 'error';

export interface SourceAnswerTraceQueryTiming {
  ordinal: number;
  elapsed_ms: number;
  corpus_timings: SourceAnswerTraceCorpusTiming[];
  stages?: SourceAnswerTraceQueryStages;
}

/**
 * Where a routed query's time went outside its lanes (#1305): the query
 * preparation every lane waits for (the slowest corpus's keyword translation
 * and query embedding), the lanes themselves, and the merge after the last
 * lane settles.
 */
export interface SourceAnswerTraceQueryStages {
  prepare_ms: number;
  prepare_keywords_max_ms: number;
  keyword_model?: KeywordPreparation['keyword_model'];
  prepare_semantic_max_ms: number;
  lanes_ms: number;
  after_lanes_ms: number;
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

/**
 * The Ask's synchronous SQLite on the request thread (#1305): every statement
 * it ran there, their total and longest time, and the call site of each that
 * held the thread past SLOW_MAIN_THREAD_SQL_MS. Sites are function names and
 * file:line only, never SQL or data.
 */
export interface SourceAnswerTraceMainThreadSql {
  statements: number;
  total_ms: number;
  max_ms: number;
  slow: Array<{ ms: number; site: string }>;
  // Statements of SITE_TALLY_MS or more, summed by call site, longest total
  // first: where the time went when no one statement was slow.
  by_site: Array<{ site: string; statements: number; ms: number }>;
}

/** A request-thread statement this long is named in the trace with its call site. */
export const SLOW_MAIN_THREAD_SQL_MS = 250;
// The slow list keeps the longest this many.
const SLOW_MAIN_THREAD_SQL_KEPT = 20;
// A statement this long is tallied by call site (one stack capture each).
const SITE_TALLY_MS = 25;
const SITE_TALLY_KEPT = 10;

// The evidence pack's seat order (#1354): the store id at each seat, how many
// seats were recency seats, and, per prompt fit an Analyst leg made, the seat
// numbers (1-based) it kept and the bytes of the prompt it built. Store ids,
// counts, and per seat a short one-way hash of store and item, so two Asks
// can be compared seat by seat without the trace naming an item.
export interface SourceAnswerTraceEvidenceSeats {
  packCorpora: string[];
  itemHashes?: string[];
  recencySeats: number;
  fits: SourceAnswerTraceAnalystFit[];
}

interface SourceAnswerAnalystFitMeasurement {
  promptBytes: number;
  packCandidates: number;
  keptCandidates: number;
  packGapEntries: number;
  packGapBytes: number;
  sentGapBytes: number;
  overheadBytes: number;
  evidenceFormat: AnalystEvidenceFormat;
}

export interface SourceAnswerTraceAnalystFit extends SourceAnswerAnalystFitMeasurement {
  lane: 'local' | 'cloud';
  keptSeats: number[];
  promptBudgetBytes?: number;
  promptBudgetSource?: LocalAnalystPromptBudget['source'];
}

const SEAT_ITEM_HASH_HEX = 12;

function seatItemHash(corpusId: string, itemKey: string): string {
  return createHash('sha256').update(`${corpusId}\u0000${itemKey}`).digest('hex').slice(0, SEAT_ITEM_HASH_HEX);
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
  mainThreadSql: SourceAnswerTraceMainThreadSql;
  evidenceSeats?: SourceAnswerTraceEvidenceSeats;
  // Counts only: whether the reranker ran for this answer and what it did.
  rerank?: EvidenceRerankAudit;
}

interface MutableTrace extends SourceAnswerTraceSnapshot {
  activeAttempt?: {
    kind: SourceAnswerRetrievalAttemptKind;
    startedAtMs: number;
    hydrationMs: number;
    queries: SourceAnswerTraceQueryTiming[];
  };
}

interface ActiveQuery {
  ordinal: number;
  startedAtMs: number;
  corpusTimings: SourceAnswerTraceCorpusTiming[];
  poolByCorpus: Map<string, SourceAnswerTracePoolReads>;
  adapterStages: Map<string, SourceAnswerTraceAdapterStages>;
  sqlShapes: Map<string, string>;
  stages?: SourceAnswerTraceQueryStages;
}

const storage = new AsyncLocalStorage<MutableTrace>();
const queryStorage = new AsyncLocalStorage<ActiveQuery>();
// The corpus lane a search adapter is running for, so a pool read made deep
// inside the adapter is counted against its lane.
const laneStorage = new AsyncLocalStorage<string>();

/** Runs one corpus lane's search, so the pool reads it makes are traced against that corpus. */
export function runInSourceAnswerLane<T>(corpusId: string, run: () => T): T {
  return laneStorage.run(corpusId, run);
}

function poolReads(query: ActiveQuery, corpusId: string): SourceAnswerTracePoolReads {
  let reads = query.poolByCorpus.get(corpusId);
  if (!reads) {
    reads = {
      reads: 0,
      queue_wait_ms: 0,
      queue_wait_max_ms: 0,
      run_ms: 0,
      run_max_ms: 0,
      sql_ms: 0,
      sql_max_ms: 0,
      snapshot_reads: 0,
      snapshot_sql_ms: 0,
      refused: 0,
      dropped_queued: 0,
      past_deadline_running: 0,
      errors: 0,
    };
    query.poolByCorpus.set(corpusId, reads);
  }
  return reads;
}

export function sourceAnswerVectorWork(): SourceAnswerTraceVectorWork | undefined {
  const query = queryStorage.getStore();
  const corpusId = laneStorage.getStore();
  if (!query || corpusId === undefined) return undefined;
  return poolReads(query, corpusId).vector_work ??= {
    digest_pages_read: 0, digest_rows_scanned: 0, full_vectors_rescored: 0, digest_unpack_score_ms: 0,
  };
}

export function beginSourceAnswerConceptCounts(): SourceAnswerTraceConceptCount[] | undefined {
  const query = queryStorage.getStore();
  const corpusId = laneStorage.getStore();
  if (!query || corpusId === undefined) return undefined;
  const passes = poolReads(query, corpusId).keyword_concept_counts ??= [];
  const pass: SourceAnswerTraceConceptCount[] = [];
  passes.push(pass);
  return pass;
}

export function beginSourceAnswerStoreTiming(): {
  stages: SourceAnswerTraceAdapterStages;
  finish: () => void;
} | undefined {
  const query = queryStorage.getStore();
  const corpusId = laneStorage.getStore();
  if (!query || corpusId === undefined) return undefined;
  const startedAt = performance.now();
  const stages: SourceAnswerTraceAdapterStages = {
    adapter_elapsed_ms: 0, keyword_lane_ms: 0, keyword_relaxation_ms: 0, keyword_revalidation_ms: 0,
    recency_read_ms: 0, fusion_ms: 0, finalize_ms: 0, unattributed_ms: 0,
  };
  return { stages, finish: () => {
    stages.adapter_elapsed_ms = performance.now() - startedAt;
    const attributed = (stages.join_wait_ms ?? stages.keyword_lane_ms) + (stages.post_join_setup_ms ?? 0)
      + stages.keyword_relaxation_ms + stages.keyword_revalidation_ms + (stages.vector_revalidation_ms ?? 0) + (stages.vector_summary_ms ?? 0)
      + stages.recency_read_ms + stages.fusion_ms + stages.finalize_ms;
    stages.unattributed_ms = Math.max(0, stages.adapter_elapsed_ms - attributed);
    query.adapterStages.set(corpusId, stages);
  } };
}

/**
 * Called by the read pool when a read is asked for. Returns how to report
 * its end, or undefined when no traced Ask lane made it. The lane and query
 * are captured now: the read ends in a pool callback outside their context.
 */
export function beginSourceAnswerPoolRead(statement: string, label?: string):
  | ((report: { queueWaitMs: number; runMs: number; sqlMs?: number | undefined; cpuMs?: number | undefined; outcome: SourceAnswerPoolReadOutcome; snapshot?: boolean }) => void)
  | undefined {
  const query = queryStorage.getStore();
  const corpusId = laneStorage.getStore();
  if (!query || corpusId === undefined) return undefined;
  let site = query.sqlShapes.get(statement);
  if (site === undefined) {
    site = poolSqlSite(statement);
    query.sqlShapes.set(statement, site);
  }
  const key = label ? `${label}\0${site}` : site;
  return ({ queueWaitMs, runMs, sqlMs, cpuMs, outcome, snapshot }) => {
    const reads = poolReads(query, corpusId);
    if (sqlMs !== undefined) {
      reads.thread_cpu_available = reads.thread_cpu_available === true || cpuMs !== undefined;
    }
    // Summed unrounded: most reads take under a millisecond, and rounding
    // each one first would report a lane of a thousand of them as zero.
    const wait = unroundedMs(queueWaitMs);
    const ran = unroundedMs(runMs);
    reads.reads += 1;
    reads.queue_wait_ms += wait;
    reads.queue_wait_max_ms = Math.max(reads.queue_wait_max_ms, wait);
    reads.run_ms += ran;
    reads.run_max_ms = Math.max(reads.run_max_ms, ran);
    const sql = unroundedMs(sqlMs ?? 0);
    reads.sql_ms += sql;
    reads.sql_max_ms = Math.max(reads.sql_max_ms, sql);
    if (snapshot) {
      reads.snapshot_reads += 1;
      reads.snapshot_sql_ms += sql;
    }
    let sites = poolSqlSites.get(reads);
    if (!sites) poolSqlSites.set(reads, sites = new Map());
    const entry = sites.get(key) ?? { site, ...(label ? { label } : {}), reads: 0, sql_ms: 0, sql_max_ms: 0 };
    entry.reads += 1;
    entry.sql_ms += sql;
    entry.sql_max_ms = Math.max(entry.sql_max_ms, sql);
    if (cpuMs !== undefined) {
      const cpu = unroundedMs(cpuMs);
      entry.sql_cpu_ms = (entry.sql_cpu_ms ?? 0) + cpu;
      entry.sql_cpu_max_ms = Math.max(entry.sql_cpu_max_ms ?? 0, cpu);
    }
    sites.set(key, entry);
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
    mainThreadSql: { statements: 0, total_ms: 0, max_ms: 0, slow: [], by_site: [] },
  };
}

export function runWithSourceAnswerTrace<T>(
  trace: MutableTrace,
  run: () => T | Promise<T>,
): Promise<T> {
  return withStoreReadPriority(() => storage.run(trace, run));
}

export function currentSourceAnswerTrace(): MutableTrace | undefined {
  return storage.getStore();
}

/** Whether a traced Ask is running in the current async context. */
export function sourceAnswerTraceActive(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * One synchronous statement the Ask ran on the request thread. `site` is
 * called only for a slow one, so ordinary statements never capture a stack.
 */
export function recordSourceAnswerMainThreadSql(elapsedMs: number, site: () => string): void {
  const trace = currentSourceAnswerTrace();
  if (!trace) return;
  const ms = unroundedMs(elapsedMs);
  const sql = trace.mainThreadSql;
  sql.statements += 1;
  sql.total_ms += ms;
  sql.max_ms = Math.max(sql.max_ms, ms);
  if (ms < SITE_TALLY_MS) return;
  const where = site();
  const tally = sql.by_site.find((entry) => entry.site === where);
  if (tally) {
    tally.statements += 1;
    tally.ms += ms;
  } else {
    sql.by_site.push({ site: where, statements: 1, ms });
  }
  if (ms < SLOW_MAIN_THREAD_SQL_MS) return;
  sql.slow.push({ ms: nonNegativeMs(ms), site: where });
  if (sql.slow.length > SLOW_MAIN_THREAD_SQL_KEPT) {
    sql.slow.sort((left, right) => right.ms - left.ms);
    sql.slow.length = SLOW_MAIN_THREAD_SQL_KEPT;
  }
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
  if (!trace) return run().finally(() => noteSourceAnswerProgress('searching'));
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
    noteSourceAnswerProgress('searching');
    if (previous) trace.activeAttempt = previous;
    else delete trace.activeAttempt;
  }
}

export function recordSourceAnswerHydration(elapsedMs: number): void {
  noteSourceAnswerProgress('reading evidence');
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
  const query: ActiveQuery = {
    ordinal: Math.max(1, Math.floor(ordinal)),
    startedAtMs: Date.now(),
    corpusTimings: [],
    poolByCorpus: new Map(),
    adapterStages: new Map(),
    sqlShapes: new Map(),
  };
  try {
    return await queryStorage.run(query, run);
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
        ...(query.adapterStages.has(timing.corpus_id) ? { adapter_stages: query.adapterStages.get(timing.corpus_id)! } : {}),
        ...(query.poolByCorpus.has(timing.corpus_id) ? { pool: withSlowestSql(query.poolByCorpus.get(timing.corpus_id)!) } : {}),
      })),
      ...(query.stages ? { stages: { ...query.stages } } : {}),
    });
  }
}

/** The active routed query's stage times; the router reports them once per query. */
export function recordSourceAnswerQueryStages(stages: SourceAnswerTraceQueryStages): void {
  const query = queryStorage.getStore();
  if (!query) return;
  query.stages = copyQueryStages(stages);
}

export function copyQueryStages(stages: SourceAnswerTraceQueryStages): SourceAnswerTraceQueryStages {
  return {
    prepare_ms: nonNegativeMs(stages.prepare_ms),
    prepare_keywords_max_ms: nonNegativeMs(stages.prepare_keywords_max_ms),
    ...(stages.keyword_model && { keyword_model: stages.keyword_model }),
    prepare_semantic_max_ms: nonNegativeMs(stages.prepare_semantic_max_ms),
    lanes_ms: nonNegativeMs(stages.lanes_ms),
    after_lanes_ms: nonNegativeMs(stages.after_lanes_ms),
  };
}

export function recordSourceAnswerCorpusTiming(timing: SourceAnswerTraceCorpusTiming): void {
  noteSourceAnswerProgress('searching');
  const query = queryStorage.getStore();
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
  noteSourceAnswerProgress('writing the answer');
  try {
    const result = await run();
    noteSourceAnswerProgress('writing the answer');
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
export function recordSourceAnswerPackSeats(corpusIds: readonly string[], recencySeats = 0, itemKeys?: readonly string[]): void {
  const trace = currentSourceAnswerTrace();
  if (!trace) return;
  trace.evidenceSeats = {
    packCorpora: [...corpusIds],
    ...(itemKeys ? { itemHashes: corpusIds.map((corpusId, index) => seatItemHash(corpusId, itemKeys[index] ?? '')) } : {}),
    recencySeats: nonNegativeCount(recencySeats),
    fits: [],
  };
}

export function recordSourceAnswerAnalystFit(
  lane: SourceAnswerTraceAnalystFit['lane'],
  keptSeats: readonly number[],
  measurement: SourceAnswerAnalystFitMeasurement,
  budget?: LocalAnalystPromptBudget,
): void {
  const seats = currentSourceAnswerTrace()?.evidenceSeats;
  if (!seats) return;
  seats.fits.push({
    lane,
    keptSeats: keptSeats.map(nonNegativeCount),
    ...(budget ? { promptBudgetBytes: budget.bytes, promptBudgetSource: budget.source } : {}),
    promptBytes: nonNegativeCount(measurement.promptBytes),
    packCandidates: nonNegativeCount(measurement.packCandidates),
    keptCandidates: nonNegativeCount(measurement.keptCandidates),
    packGapEntries: nonNegativeCount(measurement.packGapEntries),
    packGapBytes: nonNegativeCount(measurement.packGapBytes),
    sentGapBytes: nonNegativeCount(measurement.sentGapBytes),
    overheadBytes: nonNegativeCount(measurement.overheadBytes),
    evidenceFormat: measurement.evidenceFormat,
  });
}

export function recordSourceAnswerRerank(audit: EvidenceRerankAudit | undefined): void {
  noteSourceAnswerProgress('ranking evidence');
  const trace = currentSourceAnswerTrace();
  if (trace && audit) trace.rerank = { ...audit };
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
        corpus_timings: query.corpus_timings.map((timing) => ({
          ...timing,
          ...(timing.adapter_stages ? { adapter_stages: { ...timing.adapter_stages } } : {}),
          ...(timing.pool ? { pool: copyPoolDetail(timing.pool) } : {}),
        })),
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
    mainThreadSql: {
      statements: trace.mainThreadSql.statements,
      total_ms: nonNegativeMs(trace.mainThreadSql.total_ms),
      max_ms: nonNegativeMs(trace.mainThreadSql.max_ms),
      slow: trace.mainThreadSql.slow.map((entry) => ({ ...entry })),
      by_site: [...trace.mainThreadSql.by_site]
        .sort((left, right) => right.ms - left.ms)
        .slice(0, SITE_TALLY_KEPT)
        .map((entry) => ({ site: entry.site, statements: entry.statements, ms: nonNegativeMs(entry.ms) })),
    },
    ...(trace.evidenceSeats
      ? {
        evidenceSeats: {
          packCorpora: [...trace.evidenceSeats.packCorpora],
          ...(trace.evidenceSeats.itemHashes ? { itemHashes: [...trace.evidenceSeats.itemHashes] } : {}),
          recencySeats: trace.evidenceSeats.recencySeats,
          fits: trace.evidenceSeats.fits.map((fit) => ({ ...fit, keptSeats: [...fit.keptSeats] })),
        },
      }
      : {}),
    ...(trace.rerank ? { rerank: { ...trace.rerank } } : {}),
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

function unroundedMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function nonNegativeMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
