/**
 * The engine split's front runs no SQLite on its loop thread (freeze-proof
 * design, 16 Nov 2026, item 2). How long a statement takes is set by the
 * disk, the page cache and locks, not by the code, so the thread the owner
 * waits on must only ever await: reads go through the read pool
 * (connector-store/off-thread-reads.ts) and the front's own stores through
 * its stores thread.
 *
 * Until every statement has moved this records: each statement the front's
 * loop runs is counted, and, when the engine runs from source (the gate and
 * the tests), named by call site and checked against the shrink-only list
 * in config/front-loop-sql-allowance.json. A site that is not on the list is
 * logged once and reported in health, and the gate and
 * test/engine-split-boot.test.ts fail on it. The product only records. A
 * `throw` mode exists (a statement on the loop throws at the call, as a
 * writable open does in store-write-guard.ts) and nothing starts it: whether
 * the front ever holds no handle is decided with the database review after
 * 1.5 (plan thread, 16 Nov 2026).
 *
 * A `:memory:` database is private to its caller and waits on no disk; it is
 * neither counted nor refused. Worker threads are not watched: the trace
 * that calls this is installed on the main thread only.
 */

export class FrontLoopSqlError extends Error {
  readonly code = 'front_loop_sql';
  constructor(site: string) {
    super(`The engine front ran SQLite on its loop${site ? ` (${site})` : ''}; the front reads through the read pool and writes through its stores thread.`);
    this.name = 'FrontLoopSqlError';
  }
}

export interface FrontLoopSqlHealth {
  mode: 'record' | 'throw';
  /** Statements the loop has run since start. */
  statements: number;
  /** Distinct call sites seen, when sites are named (a run from source). */
  sites?: number;
  /** Call sites seen that the list does not hold, first seen first; at most 50. */
  unlisted?: string[];
  /** The unlisted sites with the statements each has run so far. */
  unlisted_sites?: Array<{ site: string; statements: number }>;
}

interface Watch {
  mode: 'record' | 'throw';
  statements: number;
  allowed?: ReadonlySet<string>;
  seen: Map<string, number>;
  unlisted: string[];
  log: (line: string) => void;
}

const UNLISTED_KEPT = 50;
let watch: Watch | undefined;

/**
 * Called once by the front process, before any store opens. `allowed` is the
 * list of call sites still permitted; without it sites are not named and
 * statements are only counted (a packaged engine has no source frames).
 */
export function watchFrontLoopSql(options: { mode: 'record' | 'throw'; allowed?: readonly string[]; log?: (line: string) => void }): void {
  watch = {
    mode: options.mode, statements: 0, seen: new Map(), unlisted: [],
    ...(options.allowed ? { allowed: new Set(options.allowed) } : {}),
    log: options.log ?? ((line) => console.warn(line)),
  };
}

/** Whether statements on this thread are being watched: the trace asks before it pays for anything. */
export function frontLoopSqlWatched(): boolean {
  return watch !== undefined;
}

/** One statement on the front's loop. `site` is asked for only when sites are named or the statement is refused. */
export function noteFrontLoopStatement(dbPath: string | undefined, site: () => string): void {
  const state = watch;
  if (!state || dbPath === ':memory:' || dbPath === '' || dbPath?.startsWith('file::memory:')) return;
  if (state.mode === 'throw') throw new FrontLoopSqlError(site());
  state.statements += 1;
  if (!state.allowed) return;
  const at = site() || '(no source frame)';
  const count = state.seen.get(at);
  state.seen.set(at, (count ?? 0) + 1);
  if (count !== undefined || state.allowed.has(at)) return;
  if (state.unlisted.length < UNLISTED_KEPT) state.unlisted.push(at);
  state.log(`[olympus] front loop sql: unlisted site ${at}`);
}

/** What the watch has seen, for health; undefined when this process is not a front. */
export function frontLoopSqlHealth(): FrontLoopSqlHealth | undefined {
  if (!watch) return undefined;
  return {
    mode: watch.mode, statements: watch.statements,
    ...(watch.allowed ? { sites: watch.seen.size, unlisted: watch.unlisted.slice(),
      ...(watch.unlisted.length ? { unlisted_sites: watch.unlisted.map(site => ({ site, statements: watch!.seen.get(site) ?? 0 })) } : {}) } : {}),
  };
}

/** The sites seen so far with their counts, busiest first (a measuring run writes them out). */
export function frontLoopSqlSites(): Array<{ site: string; statements: number }> {
  return [...(watch?.seen.entries() ?? [])].map(([site, statements]) => ({ site, statements })).sort((a, b) => b.statements - a.statements);
}

/** Test seam: the watch is process-wide. */
export function resetFrontLoopSqlGuardForTests(): void {
  watch = undefined;
}
