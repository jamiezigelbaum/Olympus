// Times the synchronous SQLite an Ask runs on the request thread (#1305).
//
// Every bun:sqlite statement made on this thread is timed while a traced Ask
// is running in the caller's async context. The Ask's trace then carries the
// count and total, and the call site of each statement that held the thread
// past SLOW_MAIN_THREAD_SQL_MS, so the next slow read on the Ask path shows in
// the latency trace instead of only in a CPU profile. Outside an Ask a
// statement pays one async-context lookup. Pool threads are not instrumented:
// their time is in the pool fields of the lane trace.

import { Database } from 'bun:sqlite';
import { isMainThread } from 'node:worker_threads';
import { frontLoopSqlWatched, noteFrontLoopStatement } from '../../core/front-loop-sql-guard.ts';
import { recordSourceAnswerMainThreadSql, sourceAnswerTraceActive } from '../source-index/answer-latency-trace.ts';
import type { createAskBenchSqlRecorder } from './ask-bench-sql.ts';

// A plain key, not a Symbol: a module-level call would keep the plugin
// bundle from tree-shaking this module (test/plugin-bundle-no-bun-sqlite).
const TIMED = '__olympusMainThreadSqlTimed';
const STATEMENT_METHODS = ['all', 'get', 'run', 'values'] as const;
const SITE_FRAMES = 3;
let installed = false;
// One UPDATE, DELETE or INSERT ... SELECT, with no second statement after it.
const SINGLE_WRITE = /^\s*(UPDATE|DELETE|INSERT)\b[^;]*;?\s*$/i;
let sliceTiming: { maxStatementMs: number } | undefined;
let benchSql: ReturnType<typeof createAskBenchSqlRecorder> | undefined;

/** Enabled by the engine's Ask benchmark gate, alongside the slow SQL log. */
export function setAskBenchLoopSqlRecorder(recorder: ReturnType<typeof createAskBenchSqlRecorder>): void {
  benchSql = recorder;
}

/** Synchronous scope: also measures ledger, proof reads and store commits in a sweep. */
export function withMainThreadSqlTiming<T>(timing: { maxStatementMs: number }, work: () => T): T {
  installMainThreadSqlTrace();
  const previous = sliceTiming;
  sliceTiming = timing;
  try { return work(); }
  finally { sliceTiming = previous; }
}

/** Instruments Database statements on this thread once; a no-op on a worker thread. */
export function installMainThreadSqlTrace(): void {
  if (installed || !isMainThread) return;
  installed = true;
  const exec = Database.prototype.exec;
  Database.prototype.exec = function (...args: Parameters<typeof exec>) {
    // A write run as text is planned too: an UPDATE or DELETE that has to
    // search is a finder plus a keyed write, wherever it is run from.
    if (planRecorder && !planRecorder.explaining && typeof args[0] === 'string' && SINGLE_WRITE.test(args[0])) {
      recordPlan({ [SQL]: args[0], [DB]: this });
    }
    if (frontLoopSqlWatched()) noteFrontLoopStatement(this.filename, sourceSite);
    if (siteCounts) countSite();
    if (!sliceTiming && !slowLog) return exec.apply(this, args);
    const before = benchSql?.sample();
    const started = performance.now();
    try { return exec.apply(this, args); }
    finally {
      const ms = performance.now() - started;
      if (before) benchSql?.record(before, ms, this.filename, slowSite);
      if (sliceTiming) sliceTiming.maxStatementMs = Math.max(sliceTiming.maxStatementMs, ms);
      if (slowLog && ms >= slowLog.thresholdMs) noteSlowStatement(ms, typeof args[0] === 'string' ? args[0] : undefined);
    }
  };
  for (const name of ['query', 'prepare'] as const) {
    const original = Database.prototype[name] as (this: Database, ...args: unknown[]) => unknown;
    (Database.prototype as unknown as Record<string, unknown>)[name] = function (this: Database, ...args: unknown[]) {
      const statement = timeStatement(original.apply(this, args));
      // What the plan recorder and the slow log need: the text and its connection.
      if (statement && typeof args[0] === 'string') {
        const held = statement as unknown as Record<string, unknown>;
        held[SQL] = args[0];
        held[DB] = this;
      }
      return statement;
    };
  }
}

/** A busy error says how long SQLite waited: 0 ms means the busy handler never ran (lane 1, 20 Nov 2026). */
function busyAfter(error: unknown, started: number): unknown {
  if (error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message) && !/ after \d+ ms$/.test(error.message)) {
    error.message += ` after ${Math.round(performance.now() - started)} ms`;
  }
  return error;
}

function timeStatement<T>(statement: T): T {
  const held = statement as unknown as Record<string, unknown>;
  if (!statement || held[TIMED]) return statement;
  for (const method of STATEMENT_METHODS) {
    const call = held[method];
    if (typeof call !== 'function') continue;
    held[method] = function (this: unknown, ...args: unknown[]) {
      if (planRecorder && !planRecorder.explaining) recordPlan(held);
      if (frontLoopSqlWatched()) noteFrontLoopStatement((held[DB] as Database | undefined)?.filename, sourceSite);
      if (siteCounts) countSite();
      const answer = sourceAnswerTraceActive();
      if (!answer && !sliceTiming && !slowLog) {
        const at = performance.now();
        try { return call.apply(this, args); } catch (error) { throw busyAfter(error, at); }
      }
      const before = benchSql?.sample();
      const started = performance.now();
      try {
        return call.apply(this, args);
      } catch (error) {
        throw busyAfter(error, started);
      } finally {
        const ms = performance.now() - started;
        if (before) benchSql?.record(before, ms, (held[DB] as Database | undefined)?.filename ?? '', slowSite);
        if (sliceTiming) sliceTiming.maxStatementMs = Math.max(sliceTiming.maxStatementMs, ms);
        if (answer) recordSourceAnswerMainThreadSql(ms, callSite);
        if (slowLog && ms >= slowLog.thresholdMs) noteSlowStatement(ms, typeof held[SQL] === 'string' ? held[SQL] as string : undefined);
      }
    };
  }
  // A scan read row by row holds the loop one step at a time: each step is timed.
  const iterate = held.iterate;
  if (typeof iterate === 'function') held.iterate = function (this: unknown, ...args: unknown[]) {
    const iterator = iterate.apply(this, args) as IterableIterator<unknown>;
    if (!sliceTiming && !slowLog) return iterator;
    return (function* () {
      let count = 1;
      try {
        for (;;) {
          const before = benchSql?.sample();
          const started = performance.now();
          let next: IteratorResult<unknown>;
          try { next = iterator.next(); }
          finally {
            const ms = performance.now() - started;
            if (before) {
              benchSql?.record(before, ms, (held[DB] as Database | undefined)?.filename ?? '', slowSite, count);
              count = 0;
            }
            if (sliceTiming) sliceTiming.maxStatementMs = Math.max(sliceTiming.maxStatementMs, ms);
            if (slowLog && ms >= slowLog.thresholdMs) noteSlowStatement(ms, typeof held[SQL] === 'string' ? held[SQL] as string : undefined);
          }
          if (next.done) return;
          yield next.value;
        }
      } finally { iterator.return?.(); }
    })();
  };
  held[TIMED] = true;
  return statement;
}

const SQL = '__olympusMainThreadSql';
const DB = '__olympusMainThreadSqlDb';

// ---------------------------------------------------------------------------
// The loop-thread rule (loop-stall step-back, 15 Nov 2026): on a loop thread
// a statement only writes, or reads by key with a bounded row count. A scan
// of a large table is a finder, which belongs on the store's read worker.
// The recorder below asks SQLite's own plan of every distinct statement this
// thread runs, so a test can name each finder by its call site; the slow log
// names any statement that holds this thread past its threshold, in
// production.

/** Tables whose size grows with the owner's data. A scan of one on a loop thread is a finder. */
export const LOOP_SQL_LARGE_TABLES: readonly string[] = [
  'items', 'chunks', 'chunk_embeddings', 'item_owners', 'sync_runs', 'connector_store_fts_rows', 'chunk_vector_digest',
  'item_visibility_feed', 'tier_visibility_members', 'item_text_versions', 'item_locator_identities',
  'tier_items', 'tier_copies', 'tier_history', 'tier_overrides', 'tier_visibility_changes',
  'sniffer_questions', 'sniffer_verdicts', 'extraction_jobs', 'extraction_artifacts',
];

export interface LoopSqlFinder {
  /** The large table the plan scans. */
  table: string;
  /** The plan line (SCAN, or a temp b-tree over the table). */
  plan: string;
  /** The first source frames that ran it: function and file, no line numbers. */
  site: string;
  /** The statement's text, shortened. */
  sql: string;
}

interface PlanRecorder {
  explaining: boolean;
  plans: Map<string, Array<{ table: string; plan: string }>>;
  finders: Map<string, LoopSqlFinder>;
  large: Set<string>;
}
let planRecorder: PlanRecorder | undefined;

/** Records every finder this thread runs until stop(), which returns them (one per site and table). */
export function startMainThreadSqlPlanRecording(large: readonly string[] = LOOP_SQL_LARGE_TABLES): { stop(): LoopSqlFinder[] } {
  installMainThreadSqlTrace();
  const recorder: PlanRecorder = { explaining: false, plans: new Map(), finders: new Map(), large: new Set(large) };
  planRecorder = recorder;
  return {
    stop() {
      if (planRecorder === recorder) planRecorder = undefined;
      return [...recorder.finders.values()].sort((a, b) => `${a.site}|${a.table}`.localeCompare(`${b.site}|${b.table}`));
    },
  };
}

function recordPlan(held: Record<string, unknown>): void {
  const recorder = planRecorder!;
  const sql = held[SQL];
  const db = held[DB] as Database | undefined;
  if (typeof sql !== 'string' || !db) return;
  let scans = recorder.plans.get(sql);
  if (!scans) {
    scans = [];
    recorder.explaining = true;
    try {
      scans = largeTableScans(db, sql, recorder.large);
    } finally {
      recorder.explaining = false;
    }
    recorder.plans.set(sql, scans);
  }
  if (scans.length === 0) return;
  const site = sourceSite();
  // A statement no source frame ran (a test's own query) is not the engine's.
  if (site === '') return;
  // An off-thread finder's fallback on an in-memory store (tests only: the
  // read worker can't open one, and the engine's stores are all files) is
  // not a loop finder. Only that case: any other in-memory statement counts.
  if (inMemory(db) && /OffThread\b/.test(site)) return;
  for (const scan of scans) {
    const key = `${site}|${scan.table}`;
    if (!recorder.finders.has(key)) recorder.finders.set(key, { ...scan, site, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 160) });
  }
}

/** The plan lines of `sql` that scan one of the `large` tables (SCAN, not a SEARCH by key or index range). */
export function largeTableScans(db: Database, sql: string, large: ReadonlySet<string>): Array<{ table: string; plan: string }> {
  const scans: Array<{ table: string; plan: string }> = [];
  try {
    // Prepared and finalized here, never left in the connection's statement
    // cache, where an unfinished one would block the caller's commit.
    const explain = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    let rows: Array<{ detail: string }>;
    try { rows = explain.all() as Array<{ detail: string }>; } finally { explain.finalize(); }
    const aliases = tableAliases(sql);
    for (const { detail } of rows) {
      const scan = /^SCAN (\S+)/.exec(detail);
      if (!scan) continue;
      const name = aliases.get(scan[1]!) ?? scan[1]!;
      if (large.has(name)) scans.push({ table: name, plan: detail });
    }
  } catch {
    // Not a plannable statement (a pragma, a transaction): nothing to record.
  }
  return scans;
}

function inMemory(db: Database): boolean {
  const name = (db as unknown as { filename?: string }).filename;
  return name === undefined || name === '' || name === ':memory:';
}

/** alias -> table for each FROM or JOIN in the text. */
function tableAliases(sql: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const keywords = new Set(['WHERE', 'ON', 'JOIN', 'LEFT', 'INNER', 'CROSS', 'GROUP', 'ORDER', 'LIMIT', 'INDEXED', 'NOT', 'USING', 'UNION', 'SET', 'AND']);
  for (const match of sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:\w+\.)?(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    const table = match[1]!;
    aliases.set(table, table);
    const alias = match[2];
    if (alias && !keywords.has(alias.toUpperCase())) aliases.set(alias, table);
  }
  return aliases;
}

// The innermost frames under src/ outside this module: function and file.
function sourceSite(depth = 2): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1).map((line) => line.trim().replace(/^at /, ''));
  const mine = frames.filter((frame) => /\/src\//.test(frame) && !frame.includes('main-thread-sql-trace') && !frame.includes('front-loop-sql-guard'));
  return mine.slice(0, depth).map((frame) => shortFrame(frame).replace(/:\d+$/, '')).join(' < ');
}

// ---------------------------------------------------------------------------
// Every call site that runs a statement on this thread at all, with a count
// (freeze-proof design, 16 Nov 2026: the front's loop should run none). A
// measuring run only: each statement pays for a stack. OLYMPUS_MAIN_THREAD_SQL_SITES
// names a directory; `<role>.sql-sites.json` is rewritten there every 10 s.
// OLYMPUS_MAIN_THREAD_SQL_SITE_FRAMES (1 to 8, default 2) is how many caller frames name a site.

let siteCounts: Map<string, number> | undefined;
let siteDepth = 2;

function countSite(): void {
  const site = sourceSite(siteDepth) || '(no source frame)';
  siteCounts!.set(site, (siteCounts!.get(site) ?? 0) + 1);
}

/** Starts counting statement call sites on this thread; `sites()` is the list so far, busiest first. */
export function startMainThreadSqlSiteCount(frames = 2): { sites(): Array<{ site: string; statements: number }>; stop(): void } {
  installMainThreadSqlTrace();
  // More frames tell a shared helper's callers apart (a lease, a store open).
  siteDepth = Math.max(1, Math.min(8, Math.floor(frames) || 2));
  const counts = new Map<string, number>();
  siteCounts = counts;
  return {
    sites: () => [...counts.entries()].map(([site, statements]) => ({ site, statements })).sort((a, b) => b.statements - a.statements),
    stop() { if (siteCounts === counts) siteCounts = undefined; },
  };
}

// ---------------------------------------------------------------------------
// Production: every statement on this thread that held it past the threshold.

export interface SlowMainThreadSqlHealth {
  threshold_ms: number;
  count: number;
  max_ms: number;
  /** The last few, newest last: call site and a short id of the statement's text. */
  recent: Array<{ at: string; ms: number; site: string; sql_id: string }>;
}

/** The engine's slow-log threshold: a statement holding a loop this long is named in the log and in health. */
export const LOOP_SLOW_SQL_MS = 100;

type SlowEntry = SlowMainThreadSqlHealth['recent'][number];
let slowLog: { thresholdMs: number; count: number; maxMs: number; recent: SlowEntry[]; log: (line: string, entry: SlowEntry) => void } | undefined;
const SLOW_RECENT = 10;

/** Times every statement on this thread from now on and names each one at or past `thresholdMs`. */
export function startSlowMainThreadSqlLog(thresholdMs: number, log: (line: string, entry: SlowEntry) => void = (line) => console.warn(line)): void {
  installMainThreadSqlTrace();
  if (!isMainThread) return;
  slowLog = { thresholdMs, count: 0, maxMs: 0, recent: [], log };
}

/** What the slow log has counted, for health; undefined when it is off. */
export function slowMainThreadSqlHealth(): SlowMainThreadSqlHealth | undefined {
  if (!slowLog) return undefined;
  return { threshold_ms: slowLog.thresholdMs, count: slowLog.count, max_ms: Math.round(slowLog.maxMs), recent: slowLog.recent.slice() };
}

export function stopSlowMainThreadSqlLog(): void { slowLog = undefined; }

function noteSlowStatement(ms: number, sql: string | undefined): void {
  const log = slowLog!;
  log.count += 1;
  log.maxMs = Math.max(log.maxMs, ms);
  const site = slowSite();
  const sqlId = sql === undefined ? 'exec' : shortHash(sql.replace(/\s+/g, ' ').trim());
  const entry = { at: new Date().toISOString(), ms: Math.round(ms), site, sql_id: sqlId };
  log.recent.push(entry);
  if (log.recent.length > SLOW_RECENT) log.recent.shift();
  log.log(`[olympus] slow loop sql: ${Math.round(ms)} ms at ${site} (sql ${sqlId})`, entry);
}

// The caller's frames past this module's own wrappers. Bun may name a frame
// <anonymous>; its file and line still place it.
function slowSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1).map((line) => line.trim().replace(/^at /, ''))
    .filter((frame) => frame.length > 0 && !frame.includes('main-thread-sql-trace') && !frame.includes('ask-bench-sql'));
  return frames.slice(0, SITE_FRAMES).map(shortFrame).join(' < ');
}

function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// The caller's innermost frames: function name and file:line, no directory
// and no SQL. The frames above them are this trace's own (callSite, the
// recorder, the statement wrapper), named or not in a bundle.
function callSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1)
    .map((line) => line.trim())
    .map((line) => (line.startsWith('at ') ? line.slice(3) : line))
    .filter((line) => line.length > 0);
  const recorder = frames.findIndex((frame) => frame.startsWith('recordSourceAnswerMainThreadSql'));
  const caller = recorder >= 0 ? recorder + 2 : 3;
  return frames.slice(caller, caller + SITE_FRAMES).map(shortFrame).join(' < ');
}

function shortFrame(frame: string): string {
  const open = frame.lastIndexOf('(');
  const name = open > 0 ? frame.slice(0, open).trim() : '<anonymous>';
  const where = (open > 0 ? frame.slice(open + 1, frame.lastIndexOf(')')) : frame).split('/').at(-1) ?? '';
  const [file, line] = where.split(':');
  return `${name} ${file}${line ? `:${line}` : ''}`;
}
