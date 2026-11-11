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
import { recordSourceAnswerMainThreadSql, sourceAnswerTraceActive } from '../source-index/answer-latency-trace.ts';

// A plain key, not a Symbol: a module-level call would keep the plugin
// bundle from tree-shaking this module (test/plugin-bundle-no-bun-sqlite).
const TIMED = '__olympusMainThreadSqlTimed';
const STATEMENT_METHODS = ['all', 'get', 'run', 'values'] as const;
const SITE_FRAMES = 3;
let installed = false;

/** Instruments Database statements on this thread once; a no-op on a worker thread. */
export function installMainThreadSqlTrace(): void {
  if (installed || !isMainThread) return;
  installed = true;
  for (const name of ['query', 'prepare'] as const) {
    const original = Database.prototype[name] as (this: Database, ...args: unknown[]) => unknown;
    (Database.prototype as unknown as Record<string, unknown>)[name] = function (this: Database, ...args: unknown[]) {
      return timeStatement(original.apply(this, args));
    };
  }
}

function timeStatement<T>(statement: T): T {
  const held = statement as unknown as Record<string, unknown>;
  if (!statement || held[TIMED]) return statement;
  for (const method of STATEMENT_METHODS) {
    const call = held[method];
    if (typeof call !== 'function') continue;
    held[method] = function (this: unknown, ...args: unknown[]) {
      if (!sourceAnswerTraceActive()) return call.apply(this, args);
      const started = performance.now();
      try {
        return call.apply(this, args);
      } finally {
        recordSourceAnswerMainThreadSql(performance.now() - started, callSite);
      }
    };
  }
  held[TIMED] = true;
  return statement;
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
