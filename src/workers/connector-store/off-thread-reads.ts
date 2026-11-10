// Read-only SQLite queries run on a small pool of threads, over the store's own file.
//
// A connector store's status counts are passes over the whole store, and on
// the main thread each one held every request behind it: a third of the
// worker's freeze time on Sparta (#870, 2026-11-05), even read once every five
// minutes. The main thread still decides WHAT to count (the scope SQL and the
// hidden and held lists); this only runs the finished queries elsewhere, so
// the counts are the same SQL either way. SQLite's WAL mode lets a second,
// read-only connection read while the store writes.
//
// The keyword search behind every Ask lane runs here too (#1079): on Sparta
// its synchronous FTS was 38-67% of the 45-58 s freezes during which no
// lane's timer could fire. The main thread still builds each query and
// filters the rows it gets back by the current tier ledger.
//
// The pool is at most READ_POOL_SIZE Bun Workers for the whole process,
// started as they are needed and made from inline source so the bundled CLI
// needs no extra file. Only a store the pool can never read (an in-memory
// store, a runtime without Bun's Worker) is read on its caller's connection.
//
// Two kinds of work share the pool:
//
// - A status snapshot (withOffThreadSnapshot): several queries inside one
//   read transaction on one thread, so every count describes one state.
// - A single query with a deadline (readOnPool), for searches. Each runs in
//   its own short read transaction, so no search holds a snapshot open
//   between queries (a long-lived reader stops WAL checkpoints). Queries wait
//   in one bounded queue per store and are taken from the stores in turn, so
//   one slow store cannot starve the others. A query still queued at its
//   deadline is dropped; one still running is given up by terminating its
//   thread. Either way the caller gets OffThreadReadBusyError and reports
//   the lane busy: it never falls back to reading on the request thread.
//
// bun:sqlite has no interrupt (no sqlite3_interrupt binding, checked on Bun
// 1.3.14 and 1.4.4), so a terminated thread keeps running its statement until
// the statement ends; its "close" event fires then (measured: CPU use stops
// when "close" fires). Until then it still counts against READ_POOL_SIZE, so
// stuck statements can never add up to more than READ_POOL_SIZE threads.
// While every place is taken, new queries wait and fail busy at their
// deadline. Only single queries run on a thread that can be terminated: a
// status snapshot's thread never takes a pool query, so terminating it never
// cuts a snapshot short.

import { SOURCE_INDEX_LANE_BUSY_CODE } from '../../core/source-index/lane-busy.ts';

/** One query: its SQL, bound values, and whether one row or all are wanted. */
export interface StoreRead {
  sql: string;
  params: readonly unknown[];
  mode: 'get' | 'all';
}

/** Threads in the read pool, counting a terminated thread until it has stopped. */
export const READ_POOL_SIZE = 2;

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
let workerFactory: (url: string) => Worker = (url) => new Worker(url);

/** Tests only: the clock that query deadlines use. Left out, the real one. */
export function setReadPoolClockForTests(testClock?: ReadPoolClock): void {
  clock = testClock ?? REAL_CLOCK;
}

/** Tests only: sees each pool query as it is sent to a thread. */
export function setReadPoolObserverForTests(observe?: (dbPath: string, read: StoreRead) => void): void {
  observer = observe;
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
  const db = new Database(path, { readonly: true });
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON');
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
      const query = db.query(sql);
      const rows = mode === 'all' ? query.all(...params) : query.get(...params);
      postMessage({ id, ok: true, rows });
    }
  } catch (error) {
    postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
`;

type Pending = { resolve: (rows: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };

interface ReaderThread {
  worker: Worker;
  pending: Map<number, Pending>;
  /** Snapshots open on this thread. */
  snapshots: number;
  /** The pool query running here, if any. */
  job?: PoolJob | undefined;
  /** Terminated, and still counted until its "close" event says it stopped. */
  retired?: boolean;
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
}

// Every thread the pool started that has not stopped, retired ones included.
const threads: ReaderThread[] = [];
let nextId = 1;
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

/** The least busy live thread, starting another while the pool has room and every thread is busy. */
function readerThread(): ReaderThread | undefined {
  if (!runtimeHasWorkers()) return undefined;
  const idle = live().reduce<ReaderThread | undefined>((best, reader) => (!best || busy(reader) < busy(best) ? reader : best), undefined);
  if (idle && busy(idle) === 0) return idle;
  return startThread() ?? idle;
}

// A failed start is not remembered: the next request tries again.
function startThread(): ReaderThread | undefined {
  if (threads.length >= READ_POOL_SIZE || !runtimeHasWorkers()) return undefined;
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
    const worker = workerFactory(url);
    // The reader never keeps a finished command alive.
    (worker as Worker & { unref?: () => void }).unref?.();
    const started: ReaderThread = { worker, pending: new Map(), snapshots: 0 };
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; rows?: unknown; error?: string }>) => {
      const message = event.data;
      const waiting = started.pending.get(message.id);
      if (!waiting) return;
      started.pending.delete(message.id);
      if (waiting.timer !== undefined) clearTimeout(waiting.timer);
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
  for (const waiting of stopped.pending.values()) {
    if (waiting.timer !== undefined) clearTimeout(waiting.timer);
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

/** Whether `dbPath` can be read on the pool now (a supported store, and a thread to read it). */
export function offThreadReadsAvailable(dbPath: string): boolean {
  return offThreadReadsSupported(dbPath) && readerThread() !== undefined;
}

// `timeoutMs` undefined: the caller owns the deadline (a pool query).
function send(reader: ReaderThread, message: Record<string, unknown>, timeoutMs: number | undefined = OFF_THREAD_READ_TIMEOUT_MS): Promise<unknown> {
  // A retired thread answers nothing: fail at once rather than wait out the timeout.
  if (reader.retired) return Promise.reject(new Error('off-thread reader stopped'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    // Left referenced: a one-shot command waiting on a count must not exit first.
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      retire(reader, new Error('off-thread read timed out'));
    }, timeoutMs);
    reader.pending.set(id, { resolve, reject, ...(timer !== undefined ? { timer } : {}) });
    try {
      reader.worker.postMessage({ ...message, id });
    } catch (error) {
      reader.pending.delete(id);
      if (timer !== undefined) clearTimeout(timer);
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
  const reader = readerThread();
  if (!reader) throw new Error('off-thread reads are unavailable');
  const snapshot = nextId++;
  reader.snapshots += 1;
  try {
    await send(reader, { op: 'open', snapshot, path: dbPath });
    try {
      return await work((query) => send(reader, { op: 'read', snapshot, sql: query.sql, params: query.params, mode: query.mode }));
    } finally {
      await send(reader, { op: 'close', snapshot }).catch(() => undefined);
    }
  } finally {
    reader.snapshots -= 1;
    dispatch();
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
  if (waiting.length >= READ_POOL_QUEUE_PER_STORE || clock.now() >= deadlineAtMs) {
    return Promise.reject(new OffThreadReadBusyError());
  }
  return new Promise((resolve, reject) => {
    const job: PoolJob = { store: dbPath, read, deadlineAtMs, resolve, reject, timer: undefined };
    job.timer = clock.setTimeout(() => missedDeadline(job), deadlineAtMs - clock.now());
    waiting.push(job);
    if (!queues.has(dbPath)) {
      queues.set(dbPath, waiting);
      turns.push(dbPath);
    }
    dispatch();
  });
}

/** Closes every pool connection to `dbPath` (its store is closing). */
export function releaseOffThreadReads(dbPath: string): void {
  for (const reader of live()) {
    try {
      reader.worker.postMessage({ op: 'release', path: dbPath });
    } catch {
      // A thread that cannot take the message is stopping anyway.
    }
  }
}

/** Stops the pool: waiting queries fail busy, and every thread (with its connections) is terminated. */
export function shutdownReadPool(): void {
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
  if ('rows' in outcome) job.resolve(outcome.rows);
  else job.reject(outcome.error);
}

function missedDeadline(job: PoolJob): void {
  if (job.settled) return;
  settle(job, { error: new OffThreadReadBusyError() });
  if (job.thread) {
    // bun:sqlite cannot interrupt the statement: the thread is terminated,
    // and it keeps its place in the pool until it has stopped.
    retire(job.thread, new OffThreadReadBusyError());
    return;
  }
  const waiting = queues.get(job.store);
  const at = waiting?.indexOf(job) ?? -1;
  if (waiting && at >= 0) waiting.splice(at, 1);
}

/** A live thread free for a pool query: nothing running or waiting on it and no open snapshot. */
function freeThread(): ReaderThread | undefined {
  return live().find((reader) => !reader.job && reader.pending.size === 0 && reader.snapshots === 0) ?? startThread();
}

/** The next waiting query, taking the stores in turn. Drops any whose deadline has passed. */
function nextJob(): PoolJob | undefined {
  while (turns.length > 0) {
    const store = turns.shift()!;
    const waiting = queues.get(store);
    let job = waiting?.shift();
    while (job && clock.now() >= job.deadlineAtMs) {
      settle(job, { error: new OffThreadReadBusyError() });
      job = waiting?.shift();
    }
    if (waiting && waiting.length > 0) turns.push(store);
    else queues.delete(store);
    if (job) return job;
  }
  return undefined;
}

function dispatch(): void {
  while (turns.length > 0) {
    const reader = freeThread();
    if (!reader) return;
    const job = nextJob();
    if (!job) return;
    job.thread = reader;
    reader.job = job;
    observer?.(job.store, job.read);
    send(reader, { op: 'query', path: job.store, sql: job.read.sql, params: job.read.params, mode: job.read.mode }, undefined)
      .then(
        // Rows that come back after the deadline are too late, however the timer fared.
        (rows) => settle(job, clock.now() >= job.deadlineAtMs ? { error: new OffThreadReadBusyError() } : { rows }),
        // A thread that stopped under the query (terminated, or crashed) leaves the lane busy, not broken.
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
