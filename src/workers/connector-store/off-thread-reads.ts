// Read-only SQLite work uses one warm Bun Worker per open store (#1305).
// Search statements and status snapshots share that store's executor. Its
// connection stays open until releaseOffThreadReads: subsequent Asks do not
// repeatedly pay a cold store open. Inline worker source also works in the CLI.
//
// bun:sqlite cannot interrupt a statement. At a search deadline we abandon
// the result, retaining BOTH its job and worker until SQLite answers. Nothing
// else for that store is sent meanwhile. Later reads wait in a bounded queue
// or fail busy at their own deadline; another store has its own executor.
// Even a crashed/terminated worker retains its store slot until its close
// event, since terminate() can leave SQLite running. Thus repeated Asks can
// never accumulate more than one executing statement per store.
//
// A snapshot opens only on a worker no search statement is running on. While
// it is open, searches still take turns with it: a search statement is sent
// whenever none of the snapshot's reads is in flight, so a long snapshot (the
// exact-vector scan reads a big store's pages for tens of seconds) never makes
// a keyword read wait for all of it (#1305). The worker runs one statement at
// a time either way; the snapshot's transaction is on its own connection.

import { SOURCE_INDEX_LANE_BUSY_CODE } from '../../core/source-index/lane-busy.ts';
import { beginSourceAnswerPoolRead, type SourceAnswerPoolReadOutcome } from '../source-index/answer-latency-trace.ts';

/** One query: its SQL, bound values, and whether one row or all are wanted. */
export interface StoreRead {
  sql: string;
  params: readonly unknown[];
  mode: 'get' | 'all';
}

/** Workers per store, including a terminated worker until it has stopped. */
export const READ_POOL_SIZE = 1;

/** Queries one store may have waiting at once; more are refused as busy. */
export const READ_POOL_QUEUE_PER_STORE = 8;

// Longer than any count has taken (Sparta's slowest status was about 20 s);
// past it the thread is presumed stuck and replaced. Also the deadline of a
// pool query whose caller gives none.
const OFF_THREAD_READ_TIMEOUT_MS = 120_000;

/** A pool query that missed its deadline or found no room: the lane is busy, not empty. */
export class OffThreadReadBusyError extends Error {
  readonly code = SOURCE_INDEX_LANE_BUSY_CODE;
  constructor() {
    super('The store is busy; try again.');
    this.name = 'OffThreadReadBusyError';
  }
}

/** The pool's time seam: query deadlines are read and armed through it. */
export interface ReadPoolClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const REAL_CLOCK: ReadPoolClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
let clock: ReadPoolClock = REAL_CLOCK;
let observer: ((dbPath: string, read: StoreRead) => void) | undefined;
let observeSnapshots = false;
let workerFactory: (url: string) => Worker = (url) => new Worker(url);

/** Tests only: the clock that query deadlines use. Left out, the real one. */
export function setReadPoolClockForTests(testClock?: ReadPoolClock): void {
  clock = testClock ?? REAL_CLOCK;
}

/** Tests only: sees each pool query as it is sent to a thread, and with `snapshots`, each snapshot read too. */
export function setReadPoolObserverForTests(observe?: (dbPath: string, read: StoreRead) => void, options: { snapshots?: boolean } = {}): void {
  observer = observe;
  observeSnapshots = options.snapshots === true;
}

/** Tests only: how a thread is made (to fail a start). Left out, a Bun Worker. */
export function setReadPoolWorkerFactoryForTests(factory?: (url: string) => Worker): void {
  workerFactory = factory ?? ((url) => new Worker(url));
}

// A snapshot is its own read-only connection inside one read transaction, so
// every count in one status describes the same database state, as they did
// when status() ran them back to back with no write in between. A single
// query uses the thread's one connection to that file and opens no
// transaction: SQLite reads it in one that ends with the statement. That
// connection is reopened when the path names a different file, and closed
// when the store releases it.
const WORKER_SOURCE = `
import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
const snapshots = new Map();
const connections = new Map();
const open = (path) => {
  const started = performance.now();
  const db = new Database(path, { readonly: true });
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON');
  postMessage({ diagnostic: 'open', path, ms: performance.now() - started });
  return db;
};
const connection = (path) => {
  const stat = statSync(path);
  const file = stat.dev + ':' + stat.ino;
  const held = connections.get(path);
  if (held && held.file === file) return held.db;
  if (held) held.db.close();
  const db = open(path);
  connections.set(path, { db, file });
  return db;
};
self.onmessage = (event) => {
  const { id, op, snapshot, path, sql, params, mode } = event.data;
  if (op === 'release') {
    const held = connections.get(path);
    connections.delete(path);
    try { held?.db.close(); } catch {}
    return;
  }
  try {
    if (op === 'open') {
      const db = open(path);
      db.exec('BEGIN');
      snapshots.set(snapshot, db);
      postMessage({ id, ok: true, rows: null });
    } else if (op === 'close') {
      const db = snapshots.get(snapshot);
      snapshots.delete(snapshot);
      if (db) {
        try { db.exec('COMMIT'); } finally { db.close(); }
      }
      postMessage({ id, ok: true, rows: null });
    } else {
      const db = op === 'query' ? connection(path) : snapshots.get(snapshot);
      if (!db) throw new Error('unknown snapshot');
      const started = performance.now();
      const query = db.query(sql);
      const rows = mode === 'all' ? query.all(...params) : query.get(...params);
      postMessage({ id, ok: true, rows, ms: performance.now() - started });
    }
  } catch (error) {
    postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
`;

// sqlMs: how long the statement ran on the thread, as the thread measured it.
type Pending = { resolve: (rows: unknown) => void; reject: (error: Error) => void; timer?: unknown; sqlMs?: (ms: number) => void };

interface ReaderThread {
  store: string;
  releaseWhenIdle?: boolean;
  worker: Worker;
  pending: Map<number, Pending>;
  /** Snapshots open on this thread. */
  snapshots: number;
  /** The pool query running here, if any. */
  job?: PoolJob | undefined;
  /** Terminated, and still counted until its "close" event says it stopped. */
  retired?: boolean;
  /** Actual SQL, retained even after the caller abandons or terminates it. */
  executingStore?: string | undefined;
}

interface PoolJob {
  store: string;
  read: StoreRead;
  deadlineAtMs: number;
  resolve: (rows: unknown) => void;
  reject: (error: Error) => void;
  timer: unknown;
  thread?: ReaderThread;
  settled?: boolean;
  // For the Ask trace (#1305): when the query was asked for and sent, and
  // how to report its end (undefined outside a traced Ask lane).
  enqueuedAtMs: number;
  sentAtMs?: number;
  report?: ((report: { queueWaitMs: number; runMs: number; sqlMs: number; outcome: SourceAnswerPoolReadOutcome }) => void) | undefined;
  // The statement's own time on the thread; runMs less this is the trip back
  // (row copy, and the wait for the request thread to take the reply).
  sqlMs?: number;
}

// Every thread the pool started that has not stopped, retired ones included.
const threads: ReaderThread[] = [];
let nextId = 1;
const counters = { starts: 0, terminations: 0, restarts: 0, opens: 0, openMs: 0 };
const startedStores = new Set<string>();
const storeOpens = new Map<string, { opens: number; openMs: number }>();

/** Counts only; actual executing statements include callers that have given up. */
export function readPoolDiagnostics() {
  const stores: Record<string, { inFlight: number; abandoned: number; queued: number; opens: number; openMs: number }> = {};
  for (const path of new Set([...storeOpens.keys(), ...queues.keys(), ...threads.flatMap(t => t.executingStore ? [t.executingStore] : [])])) {
    const running = threads.filter(t => t.executingStore === path);
    stores[path] = { inFlight: running.length, abandoned: running.filter(t => t.retired || t.job?.settled).length,
      queued: queues.get(path)?.length ?? 0, opens: storeOpens.get(path)?.opens ?? 0, openMs: storeOpens.get(path)?.openMs ?? 0 };
  }
  return { ...counters, threads: threads.length, stores };
}

// Waiting pool queries by store, and the order the stores are served in.
const queues = new Map<string, PoolJob[]>();
const turns: string[] = [];

function live(): ReaderThread[] {
  return threads.filter((reader) => !reader.retired);
}

function busy(reader: ReaderThread): number {
  return reader.pending.size + reader.snapshots + (reader.job ? 1 : 0);
}

function runtimeHasWorkers(): boolean {
  return typeof Worker === 'function' && typeof Blob === 'function' && Boolean((globalThis as { Bun?: unknown }).Bun);
}

// A failed start is not remembered: the next request tries again.
function startThread(store: string): ReaderThread | undefined {
  if (threads.filter(reader => reader.store === store).length >= READ_POOL_SIZE || !runtimeHasWorkers()) return undefined;
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
    const worker = workerFactory(url);
    // The reader never keeps a finished command alive.
    (worker as Worker & { unref?: () => void }).unref?.();
    counters.starts += 1;
    if (startedStores.has(store)) counters.restarts += 1;
    startedStores.add(store);
    const started: ReaderThread = { store, worker, pending: new Map(), snapshots: 0 };
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; rows?: unknown; error?: string; ms?: number }>) => {
      const message = event.data;
      const diagnostic = message as unknown as { diagnostic?: string; path: string; ms: number };
      if (diagnostic.diagnostic === 'open') {
        counters.opens += 1;
        counters.openMs += diagnostic.ms;
        const held = storeOpens.get(diagnostic.path) ?? { opens: 0, openMs: 0 };
        held.opens += 1;
        held.openMs += diagnostic.ms;
        storeOpens.set(diagnostic.path, held);
        return;
      }
      started.executingStore = undefined;
      const waiting = started.pending.get(message.id);
      if (!waiting) return;
      started.pending.delete(message.id);
      if (waiting.timer !== undefined) clock.clearTimeout(waiting.timer);
      if (typeof message.ms === 'number') waiting.sqlMs?.(message.ms);
      if (message.ok) waiting.resolve(message.rows ?? null);
      else waiting.reject(new Error(message.error ?? 'off-thread read failed'));
    };
    worker.onerror = (event: ErrorEvent) => {
      retire(started, new Error(event.message || 'off-thread reader stopped'));
    };
    worker.addEventListener('close', () => {
      // Stopped: its place in the pool is free.
      const at = threads.indexOf(started);
      if (at >= 0) threads.splice(at, 1);
      if (!started.retired) retire(started, new Error('off-thread reader stopped'));
      dispatch();
    });
    threads.push(started);
    return started;
  } catch {
    return undefined;
  }
}

function retire(stopped: ReaderThread, error: Error): void {
  if (stopped.retired) return;
  stopped.retired = true;
  counters.terminations += 1;
  for (const waiting of stopped.pending.values()) {
    if (waiting.timer !== undefined) clock.clearTimeout(waiting.timer);
    waiting.reject(error);
  }
  stopped.pending.clear();
  try {
    stopped.worker.terminate();
  } catch {
    // Already gone.
  }
}

/**
 * Whether `dbPath` is a store the pool reads at all: a file, in a runtime
 * with Bun's Worker. A search of such a store never reads on its caller's
 * thread, even when no thread can start right now.
 */
export function offThreadReadsSupported(dbPath: string): boolean {
  return dbPath !== ':memory:' && !dbPath.startsWith('file::memory:') && runtimeHasWorkers();
}

// `timeoutMs` null: the caller owns the deadline (a pool query).
// Passing undefined would silently restore the 120 s default in JavaScript.
function send(
  reader: ReaderThread,
  message: Record<string, unknown>,
  timeoutMs: number | null = OFF_THREAD_READ_TIMEOUT_MS,
  sqlMs?: (ms: number) => void,
): Promise<unknown> {
  // A retired thread answers nothing: fail at once rather than wait out the timeout.
  if (reader.retired) return Promise.reject(new Error('off-thread reader stopped'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    // Left referenced: a one-shot command waiting on a count must not exit first.
    const timer = timeoutMs === null ? undefined : clock.setTimeout(() => {
      retire(reader, new Error('off-thread read timed out'));
    }, timeoutMs);
    reader.pending.set(id, { resolve, reject, ...(timer !== undefined ? { timer } : {}), ...(sqlMs ? { sqlMs } : {}) });
    try {
      reader.worker.postMessage({ ...message, id });
    } catch (error) {
      reader.pending.delete(id);
      if (timer !== undefined) clock.clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Runs `work` with a reader over one snapshot of `dbPath` on one thread of
 * the pool: every query it makes sees the same committed state.
 */
export async function withOffThreadSnapshot<T>(
  dbPath: string,
  work: (read: (query: StoreRead) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  if (!runtimeHasWorkers()) throw new Error('off-thread reads are unavailable');
  // Tied to the store's lifetime: a release while the snapshot waits for a
  // thread, or between its reservation and its open, cancels it.
  const generation = releases.get(dbPath) ?? 0;
  const reader = await snapshotThread(dbPath);
  if ((releases.get(dbPath) ?? 0) !== generation) {
    reader.snapshots -= 1;
    dispatch();
    throw new OffThreadReadBusyError();
  }
  const snapshot = nextId++;
  try {
    await send(reader, { op: 'open', snapshot, path: dbPath });
    try {
      return await work(async (query) => {
        if (observeSnapshots) observer?.(dbPath, query);
        // A snapshot read made by a traced Ask lane counts in its pool reads.
        const report = beginSourceAnswerPoolRead();
        const sentAtMs = clock.now();
        let sqlMs = 0;
        try {
          const rows = await send(reader, { op: 'read', snapshot, sql: query.sql, params: query.params, mode: query.mode }, undefined, (ms) => {
            sqlMs = ms;
          });
          report?.({ queueWaitMs: 0, runMs: clock.now() - sentAtMs, sqlMs, outcome: 'rows' });
          return rows;
        } catch (error) {
          report?.({ queueWaitMs: 0, runMs: clock.now() - sentAtMs, sqlMs, outcome: 'error' });
          throw error;
        } finally {
          // A search waiting for this thread takes its turn before the next read.
          dispatch();
        }
      });
    } finally {
      await send(reader, { op: 'close', snapshot }).catch(() => undefined);
    }
  } finally {
    reader.snapshots -= 1;
    dispatch();
  }
}

// Snapshots waiting for a thread that no pool query is running on.
const snapshotWaiters: Array<{ store: string; resolve: (reader: ReaderThread) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
// How many times each store's pool connections were released.
const releases = new Map<string, number>();

/** A snapshot shares only its store's executor, once no search is executing. */
function snapshotThreadNow(store: string): ReaderThread | undefined {
  return live().find(reader => reader.store === store && !reader.releaseWhenIdle && !reader.job) ?? startThread(store);
}

/** Reserves the store worker, waiting while its current search is executing. */
function snapshotThread(store: string): Promise<ReaderThread> {
  const reader = snapshotThreadNow(store);
  if (reader) {
    reader.snapshots += 1;
    return Promise.resolve(reader);
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      store,
      resolve,
      reject,
      timer: setTimeout(() => {
        const at = snapshotWaiters.indexOf(waiter);
        if (at >= 0) snapshotWaiters.splice(at, 1);
        reject(new Error('off-thread reads are busy'));
      }, OFF_THREAD_READ_TIMEOUT_MS),
    };
    snapshotWaiters.push(waiter);
  });
}

function serveSnapshotWaiters(): void {
  // A busy store must not hold up another store's snapshot.
  for (const waiter of [...snapshotWaiters]) {
    const reader = snapshotThreadNow(waiter.store);
    if (!reader) continue;
    snapshotWaiters.splice(snapshotWaiters.indexOf(waiter), 1);
    clearTimeout(waiter.timer);
    reader.snapshots += 1;
    waiter.resolve(reader);
  }
}

/**
 * Reads one query of `dbPath` on the pool, in its own read transaction.
 * Rejects with OffThreadReadBusyError when the store's queue is full, or
 * when `deadlineAtMs` (on the pool's clock) passes before the rows are back.
 * The caller checks offThreadReadsSupported first.
 */
export function readOnPool(dbPath: string, read: StoreRead, options: { deadlineAtMs?: number } = {}): Promise<unknown> {
  const deadlineAtMs = options.deadlineAtMs ?? clock.now() + OFF_THREAD_READ_TIMEOUT_MS;
  const waiting = queues.get(dbPath) ?? [];
  const report = beginSourceAnswerPoolRead();
  if (waiting.length >= READ_POOL_QUEUE_PER_STORE || clock.now() >= deadlineAtMs) {
    report?.({ queueWaitMs: 0, runMs: 0, sqlMs: 0, outcome: 'refused' });
    return Promise.reject(new OffThreadReadBusyError());
  }
  return new Promise((resolve, reject) => {
    const job: PoolJob = { store: dbPath, read, deadlineAtMs, resolve, reject, timer: undefined, enqueuedAtMs: clock.now(), report };
    job.timer = clock.setTimeout(() => missedDeadline(job), deadlineAtMs - clock.now());
    waiting.push(job);
    if (!queues.has(dbPath)) {
      queues.set(dbPath, waiting);
      turns.push(dbPath);
    }
    dispatch();
  });
}

/** Closes every pool connection to `dbPath` and drops its waiting queries (its store is closing). */
export function releaseOffThreadReads(dbPath: string): void {
  // Its waiting queries and snapshots go too: sent after the release, one
  // would open a connection that nothing releases again.
  releases.set(dbPath, (releases.get(dbPath) ?? 0) + 1);
  for (const waiter of snapshotWaiters.filter((entry) => entry.store === dbPath)) {
    snapshotWaiters.splice(snapshotWaiters.indexOf(waiter), 1);
    clearTimeout(waiter.timer);
    waiter.reject(new OffThreadReadBusyError());
  }
  const waiting = queues.get(dbPath);
  if (waiting) {
    queues.delete(dbPath);
    const turn = turns.indexOf(dbPath);
    if (turn >= 0) turns.splice(turn, 1);
    for (const job of waiting) settle(job, { error: new OffThreadReadBusyError() });
  }
  for (const reader of live().filter(reader => reader.store === dbPath)) {
    reader.releaseWhenIdle = true;
    if (reader.job) settle(reader.job, { error: new OffThreadReadBusyError() });
  }
  dispatch();
}

/** Stops the pool: waiting queries fail busy, and every thread (with its connections) is terminated. */
export function shutdownReadPool(): void {
  for (const waiter of snapshotWaiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('off-thread reads stopped'));
  }
  for (const store of turns.splice(0)) {
    for (const job of queues.get(store) ?? []) settle(job, { error: new OffThreadReadBusyError() });
    queues.delete(store);
  }
  for (const reader of live()) retire(reader, new OffThreadReadBusyError());
}

function settle(job: PoolJob, outcome: { rows: unknown } | { error: Error }): void {
  if (job.settled) return;
  job.settled = true;
  clock.clearTimeout(job.timer);
  if (job.report) {
    const now = clock.now();
    const sentAtMs = job.sentAtMs;
    let ended: SourceAnswerPoolReadOutcome;
    if ('rows' in outcome) ended = 'rows';
    else if (sentAtMs === undefined) ended = 'dropped_queued';
    else if (outcome.error instanceof OffThreadReadBusyError) ended = 'past_deadline_running';
    else ended = 'error';
    job.report({
      queueWaitMs: (sentAtMs ?? now) - job.enqueuedAtMs,
      runMs: sentAtMs === undefined ? 0 : now - sentAtMs,
      sqlMs: job.sqlMs ?? 0,
      outcome: ended,
    });
  }
  if ('rows' in outcome) job.resolve(outcome.rows);
  else job.reject(outcome.error);
}

function missedDeadline(job: PoolJob): void {
  if (job.settled) return;
  settle(job, { error: new OffThreadReadBusyError() });
  if (job.thread) {
    // Keep the executing job installed until its actual reply, including
    // after its caller has given up. Never terminate or reuse this executor.
    return;
  }
  const waiting = queues.get(job.store);
  const at = waiting?.indexOf(job) ?? -1;
  if (waiting && at >= 0) waiting.splice(at, 1);
}

/** A free executor of this store, or its first worker. Retired workers still occupy the slot. */
// Free for a pool query: nothing in flight on it. An open snapshot between
// its reads does not hold the thread.
function freeThread(store: string): ReaderThread | undefined {
  return live().find(reader => reader.store === store && !reader.releaseWhenIdle && !reader.job && reader.pending.size === 0)
    ?? startThread(store);
}

function dispatch(): void {
  for (const reader of live()) {
    if (reader.releaseWhenIdle && busy(reader) === 0) retire(reader, new OffThreadReadBusyError());
  }
  serveSnapshotWaiters();
  // Try every store once: a busy/abandoned store cannot block a ready one.
  for (let remaining = turns.length; remaining > 0; remaining -= 1) {
    const store = turns.shift()!;
    const waiting = queues.get(store)!;
    while (waiting.length && clock.now() >= waiting[0]!.deadlineAtMs) {
      settle(waiting.shift()!, { error: new OffThreadReadBusyError() });
    }
    if (!waiting.length) { queues.delete(store); continue; }
    const reader = freeThread(store);
    if (!reader) { turns.push(store); continue; }
    const job = waiting.shift()!;
    if (waiting.length) turns.push(store);
    else queues.delete(store);
    job.thread = reader;
    job.sentAtMs = clock.now();
    reader.job = job;
    reader.executingStore = job.store;
    observer?.(job.store, job.read);
    send(reader, { op: 'query', path: job.store, sql: job.read.sql, params: job.read.params, mode: job.read.mode }, null, (ms) => {
      job.sqlMs = ms;
    })
      .then(
        (rows) => settle(job, clock.now() >= job.deadlineAtMs ? { error: new OffThreadReadBusyError() } : { rows }),
        (error: Error) => settle(job, { error: reader.retired ? new OffThreadReadBusyError() : error }),
      )
      .finally(() => {
        if (reader.job === job) reader.job = undefined;
        dispatch();
      });
  }
}

/** Tests only: the pool's threads, live and terminated-but-still-running. */
export function readPoolThreadsForTests(): { live: number; stopping: number } {
  const running = live().length;
  return { live: running, stopping: threads.length - running };
}
