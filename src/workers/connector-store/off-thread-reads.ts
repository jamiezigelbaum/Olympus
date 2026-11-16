import { currentSourceIndexReadProgress, noteSourceIndexReadProgress } from '../../core/source-index/read-progress.ts';
// Read-only SQLite work uses one warm Bun Worker per open store (#1305).
// The owner's search statements use that store's shared executor; a scan
// snapshot (the vector lane) takes a second worker of the store, and the
// engine's own finders and counts a third, each started on its first use, so
// an owner read never waits behind them (see ReadPoolLane). Its
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

import { SQLITE_MMAP_BYTES, sqliteMmapEnabled } from './sqlite-mmap.ts';
import { errorFromBoundary } from '../../core/log-redaction.ts';
import { SOURCE_INDEX_LANE_BUSY_CODE } from '../../core/source-index/lane-busy.ts';
import { beginSourceAnswerPoolRead, poolSqlSite, type SourceAnswerPoolReadOutcome } from '../source-index/answer-latency-trace.ts';

/** One query: its SQL, bound values, and whether one row or all are wanted. */
export interface StoreRead {
  sql: string;
  params: readonly unknown[];
  mode: 'get' | 'all';
}

/** Workers per store, including a terminated worker until it has stopped. */
export const READ_POOL_SIZE = 1;

/**
 * A long scan snapshot (the vector lane reading a big store's pages) takes a
 * second worker of its store, started on first use, so it never queues
 * behind that store's keyword and status reads on the shared one (lane 6
 * leg, 15 Nov: 29 to 54 s behind keyword reads on one thread). Every store
 * gets the same treatment; nothing is chosen by source.
 */
export type ReadPoolLane = 'shared' | 'scan' | 'rescore' | 'background';

/**
 * The lane of the engine's own reads: loop finders, sweeps, the status
 * count, backlog estimates. It has one worker per store, so an owner's
 * keyword read on the shared worker never waits behind a finder's statement
 * (plan thread, 16 Nov: an owner read never waits behind background work).
 */
export const BACKGROUND_READS = { lane: 'background' } as const satisfies { lane: ReadPoolLane };

/** One query on the store's background worker, in its own snapshot. */
export function readInBackground(dbPath: string, query: StoreRead): Promise<unknown> {
  return withOffThreadSnapshot(dbPath, async (read) => read(query), BACKGROUND_READS);
}

/**
 * Workers a store may give the vector re-score beside its scan worker. The
 * re-score reads a few thousand vectors scattered over the file; a cold
 * disk serves several such reads at once about as fast as one, so its pages
 * are read side by side on these (his Dropbox store copy, 15 Nov: 22 cold
 * reads took 3.2 s one at a time). Each holds only its own read snapshot.
 */
export const READ_POOL_RESCORE_READERS = 3;

/** Queries one store may have waiting at once; more are refused as busy. */
export const READ_POOL_QUEUE_PER_STORE = 8;

// A Bun Worker can lose a reply: the reader posts it and this thread never
// receives it (traced 16 Nov: reply 145 posted after its open, never
// delivered; 3 of 40 runs of one test). Elapsed time cannot tell that from a
// slow statement on a busy disk, and a read still running must never be cut
// (Jamie, 16 Nov: "as long as the answer is in progress, it shouldn't
// cancel for no reason"). So each reader says, in memory shared with this
// thread, which request it is running and the last one it finished. A
// request is lost only when its reader says it finished and two checks in a
// row, LOST_REPLY_CHECK_MS apart, still find no reply: only then is the
// reader retired and the request run again, once, on a fresh one. A reader
// still running the request, or not yet at it, is left to finish however
// long it takes; a reader that dies says so with its error and close events.
let lostReplyCheckMs = 2_000;

/** A request its reader finished whose reply never arrived: the reader is retired. */
export class OffThreadReadLostError extends Error {
  constructor() {
    super('off-thread read reply was lost');
    this.name = 'OffThreadReadLostError';
  }
}

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
/** What the observer learns of a snapshot read besides its text: its lane and the function that opened the snapshot. */
export interface ObservedRead { lane: ReadPoolLane; site: string }
let observer: ((dbPath: string, read: StoreRead, seen?: ObservedRead) => void) | undefined;
let observeSnapshots = false;
let workerFactory: (url: string) => Worker = (url) => new Worker(url);

/** Tests only: the clock that query deadlines use. Left out, the real one. */
export function setReadPoolClockForTests(testClock?: ReadPoolClock): void {
  clock = testClock ?? REAL_CLOCK;
  // A check armed on the old clock would never fire on the new one.
  lostReplyCheck = undefined;
}

/** Tests only: sees each pool query as it is sent to a thread, and with `snapshots`, each snapshot read too. */
export function setReadPoolObserverForTests(observe?: (dbPath: string, read: StoreRead, seen?: ObservedRead) => void, options: { snapshots?: boolean } = {}): void {
  observer = observe;
  observeSnapshots = options.snapshots === true;
}

/** Tests only: how often waiting requests are checked for a lost reply. Left out, the default. */
export function setReadPoolLostReplyCheckForTests(ms?: number): void {
  lostReplyCheckMs = ms ?? 2_000;
}

/** Tests only: how a thread is made (to fail a start). Left out, a Bun Worker. */
export function setReadPoolWorkerFactoryForTests(factory?: (url: string) => Worker): void {
  workerFactory = factory ?? ((url) => new Worker(url));
}

// A snapshot is its own read-only connection inside one read transaction (a
// connection kept from an earlier snapshot on this thread when one is idle), so
// every count in one status describes the same database state, as they did
// when status() ran them back to back with no write in between. A single
// query uses the thread's one connection to that file and opens no
// transaction: SQLite reads it in one that ends with the statement. That
// connection is reopened when the path names a different file, and closed
// when the store releases it.
// The worker's connections map their file as the engine's do (sqlite-mmap.ts).
// Filled in when a thread starts, not at load, and written into the source as
// plain text: a call or an interpolation there would keep the plugin bundle
// from dropping the source (plugin-bundle-no-bun-sqlite).
const MMAP_PRAGMA_SLOT = '/*olympus-mmap-pragma*/';
const mmapPragma = (): string => (sqliteMmapEnabled() ? `try { db.exec('PRAGMA mmap_size = ${SQLITE_MMAP_BYTES}'); } catch {}` : '');
const WORKER_SOURCE = `
import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
const snapshots = new Map();
const connections = new Map();
// [request running, last request finished], read by the request thread.
let progress;
const open = (path) => {
  const started = performance.now();
  const db = new Database(path, { readonly: true });
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON');
  /*olympus-mmap-pragma*/
  postMessage({ diagnostic: 'open', path, ms: performance.now() - started });
  return db;
};
// Snapshot connections are kept for the next snapshot instead of closed:
// Bun 1.3.x corrupts its heap when pool threads open and close SQLite
// connections concurrently (olympus-ops#151), and a store's searches would
// otherwise open one connection per snapshot.
const IDLE_SNAPSHOT_CONNECTIONS = 8;
const idleSnapshots = new Map();
const snapshotConnection = (path) => {
  const stat = statSync(path);
  const file = stat.dev + ':' + stat.ino;
  const idle = idleSnapshots.get(path) ?? [];
  while (idle.length > 0) {
    const held = idle.pop();
    if (held.file === file) {
      // A snapshot may have changed its connection's settings; the next starts from the defaults.
      held.db.exec('PRAGMA busy_timeout = 10000');
      return held;
    }
    try { held.db.close(); } catch {}
  }
  return { db: open(path), file, path };
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
  const { id, op, snapshot, path, sql, params, mode, perRead } = event.data;
  if (op === 'progress') { progress = new Int32Array(event.data.buffer); return; }
  if (op === 'release') {
    const held = connections.get(path);
    connections.delete(path);
    try { held?.db.close(); } catch {}
    for (const idle of idleSnapshots.get(path) ?? []) { try { idle.db.close(); } catch {} }
    idleSnapshots.delete(path);
    // A snapshot still open on the released store closes, rather than idles, when it ends.
    for (const open of snapshots.values()) if (open.path === path) open.discard = true;
    return;
  }
  if (progress) Atomics.store(progress, 0, id);
  try {
    if (op === 'open') {
      const held = snapshotConnection(path);
      // perRead: no transaction is held between reads, so each read is its
      // own short one and a checkpoint can pass it between reads.
      if (!perRead) { try { held.db.exec('BEGIN'); } catch (error) { held.db.close(); throw error; } }
      held.perRead = perRead === true;
      snapshots.set(snapshot, held);
      postMessage({ id, ok: true, rows: null });
    } else if (op === 'close') {
      const held = snapshots.get(snapshot);
      snapshots.delete(snapshot);
      if (held) {
        let reusable = false;
        try { if (!held.perRead) held.db.exec('COMMIT'); reusable = true; } finally {
          const idle = idleSnapshots.get(held.path) ?? [];
          if (reusable && !held.discard && idle.length < IDLE_SNAPSHOT_CONNECTIONS) { idle.push(held); idleSnapshots.set(held.path, idle); } else held.db.close();
        }
      }
      postMessage({ id, ok: true, rows: null });
    } else {
      const db = op === 'query' ? connection(path) : snapshots.get(snapshot)?.db;
      if (!db) throw new Error('unknown snapshot');
      const started = performance.now();
      const query = db.query(sql);
      const rows = mode === 'all' ? query.all(...params) : query.get(...params);
      postMessage({ id, ok: true, rows, ms: performance.now() - started });
    }
  } catch (error) {
    const frame = error instanceof Error && error.stack ? error.stack.split('\\n').map((line) => line.trim()).find((line) => line.startsWith('at ')) : undefined;
    postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error), errorName: error instanceof Error ? error.name : undefined, errorFrame: frame ? frame.slice(3) : undefined, op, sqlHead: typeof sql === 'string' ? sql.replace(/\\s+/g, ' ').trim().slice(0, 80) : undefined });
  } finally {
    // After the reply is posted: finished, so a reply missing past here was lost.
    if (progress) { Atomics.store(progress, 1, id); Atomics.store(progress, 0, 0); }
  }
};
`;

// sqlMs: how long the statement ran on the thread, as the thread measured it.
// finishedSeen: a check already found the reader finished with it and no reply here.
type Pending = { resolve: (rows: unknown) => void; reject: (error: Error) => void; sqlMs?: (ms: number) => void; finishedSeen?: boolean };

interface ReaderThread {
  store: string;
  /** Which of its store's workers this is: the shared one, or the one scan snapshots take. */
  lane: ReadPoolLane;
  releaseWhenIdle?: boolean;
  worker: Worker;
  /** What the reader says it is doing: [request running, last request finished]. */
  progress?: Int32Array;
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
  /** Tells the asking lane its read left the queue: a wait behind other reads is not silence. */
  started?: (() => void) | undefined;
  thread?: ReaderThread | undefined;
  settled?: boolean;
  /** Already run again once after a lost reply. */
  retried?: boolean;
  // For the Ask trace (#1305): when the query was asked for and sent, and
  // how to report its end (undefined outside a traced Ask lane).
  enqueuedAtMs: number;
  sentAtMs?: number | undefined;
  report?: ReturnType<typeof beginSourceAnswerPoolRead>;
  // The statement's own time on the thread; runMs less this is the trip back
  // (row copy, and the wait for the request thread to take the reply).
  sqlMs?: number;
}

// Every thread the pool started that has not stopped, retired ones included.
const threads: ReaderThread[] = [];
let nextId = 1;
// lostReplies: readers retired because a request they finished never got
// its reply here; retries: requests run again on a fresh reader after one;
// lateReplies: replies that came for no waiting request.
const counters = { starts: 0, terminations: 0, restarts: 0, opens: 0, openMs: 0, lostReplies: 0, retries: 0, lateReplies: 0 };
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
function startThread(store: string, lane: ReadPoolLane = 'shared'): ReaderThread | undefined {
  const limit = lane === 'shared' ? READ_POOL_SIZE : lane === 'rescore' ? READ_POOL_RESCORE_READERS : 1;
  if (threads.filter(reader => reader.store === store && reader.lane === lane).length >= limit || !runtimeHasWorkers()) return undefined;
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE.replace(MMAP_PRAGMA_SLOT, mmapPragma())], { type: 'application/javascript' }));
    const worker = workerFactory(url);
    // The reader never keeps a finished command alive.
    (worker as Worker & { unref?: () => void }).unref?.();
    counters.starts += 1;
    if (startedStores.has(store)) counters.restarts += 1;
    startedStores.add(store);
    const started: ReaderThread = { store, lane, worker, pending: new Map(), snapshots: 0 };
    if (typeof SharedArrayBuffer === 'function') {
      const buffer = new SharedArrayBuffer(8);
      started.progress = new Int32Array(buffer);
      worker.postMessage({ op: 'progress', buffer });
    }
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; rows?: unknown; error?: string; errorName?: string; errorFrame?: string; op?: string; sqlHead?: string; ms?: number }>) => {
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
      if (!waiting) {
        counters.lateReplies += 1;
        return;
      }
      started.pending.delete(message.id);
      if (typeof message.ms === 'number') waiting.sqlMs?.(message.ms);
      if (message.ok) waiting.resolve(message.rows ?? null);
      // The class and frame from the reader thread, and what it ran (SQL text only, never its values): #1502.
      else waiting.reject(errorFromBoundary(message.error ?? 'off-thread read failed', message.errorName, message.errorFrame, `read pool ${message.op ?? 'read'}${message.sqlHead ? `: ${message.sqlHead}` : ''}`));
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
  for (const waiting of stopped.pending.values()) waiting.reject(error);
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

// No deadline: a request waits for its reply however long its statement
// runs. Only a lost reply (checkLostReplies) or a dead reader fails it.
function send(
  reader: ReaderThread,
  message: Record<string, unknown>,
  sqlMs?: (ms: number) => void,
): Promise<unknown> {
  // A retired thread answers nothing: fail at once.
  if (reader.retired) return Promise.reject(new Error('off-thread reader stopped'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    reader.pending.set(id, { resolve, reject, ...(sqlMs ? { sqlMs } : {}) });
    armLostReplyCheck();
    try {
      reader.worker.postMessage({ ...message, id });
    } catch (error) {
      reader.pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

let lostReplyCheck: unknown;
function armLostReplyCheck(): void {
  if (lostReplyCheck !== undefined) return;
  // Left referenced: a one-shot command waiting on a count must not exit first.
  lostReplyCheck = clock.setTimeout(checkLostReplies, lostReplyCheckMs);
}

function checkLostReplies(): void {
  lostReplyCheck = undefined;
  for (const reader of live()) {
    if (!reader.progress) continue;
    const finished = Atomics.load(reader.progress, 1);
    for (const [id, waiting] of reader.pending) {
      // Requests run in the order sent, so one at or before the last
      // finished has been answered by the reader.
      if (id > finished) continue;
      if (!waiting.finishedSeen) { waiting.finishedSeen = true; continue; }
      counters.lostReplies += 1;
      retire(reader, new OffThreadReadLostError());
      break;
    }
  }
  if (threads.some((reader) => !reader.retired && reader.pending.size > 0)) armLostReplyCheck();
}

/**
 * Runs `work` with a reader over one snapshot of `dbPath` on one thread of
 * the pool: every query it makes sees the same committed state.
 */
export async function withOffThreadSnapshot<T>(
  dbPath: string,
  work: (read: (query: StoreRead) => Promise<unknown>) => Promise<T>,
  options: { lane?: ReadPoolLane; noWait?: boolean; perRead?: boolean } = {},
): Promise<T> {
  const lane = options.lane ?? 'shared';
  // Before the first await, while the caller's frames are still on the stack.
  const site = callerSite();
  if (!runtimeHasWorkers()) throw new Error('off-thread reads are unavailable');
  // Tied to the store's lifetime: a release while the snapshot waits for a
  // thread, or between its reservation and its open, cancels it.
  const generation = releases.get(dbPath) ?? 0;
  // noWait: a helper that is only worth having now (a re-score reader)
  // takes a free worker or none.
  const askedAtMs = clock.now();
  const free = options.noWait ? snapshotThreadNow(dbPath, lane) : undefined;
  if (options.noWait && !free) throw new OffThreadReadBusyError();
  if (free) free.snapshots += 1;
  // The reserved worker; undefined only while a fresh one is being taken.
  let reader: ReaderThread | undefined = free ?? await snapshotThread(dbPath, lane);
  try {
    if ((releases.get(dbPath) ?? 0) !== generation) throw new OffThreadReadBusyError();
    let snapshot = nextId++;
    // The wait for the store's worker, counted once, on the snapshot's first
    // read: a lane's time behind other snapshots shows in its queue wait.
    let reserveWaitMs = clock.now() - askedAtMs;
    // The background lane's readers are finders: what they find is written by
    // key and checked again there, so they need no one snapshot across their
    // reads. Each of their reads is its own read transaction. A snapshot held
    // across a whole walk pinned the WAL: no checkpoint could reset it, and
    // tier-ledger-1's WAL stood at 6 GB through a gate run (16 Nov). A caller
    // that checks for writes across the whole read itself asks for the same.
    const perRead = lane === 'background' || options.perRead === true;
    const open = async (): Promise<void> => {
      await send(reader!, { op: 'open', snapshot, path: dbPath, perRead });
    };
    // One retry on a fresh worker per snapshot, after a reply that was lost:
    // before the first read, or between reads of a per-read walk,
    // where no read depends on the one before it. A held snapshot's reads
    // must see one state, so they never move.
    let retryLeft = true;
    let moving: Promise<void> | undefined;
    const moveToFreshWorker = (): Promise<void> => {
      if (moving) return moving;
      retryLeft = false;
      counters.retries += 1;
      moving = (async () => {
        reader!.snapshots -= 1;
        reader = undefined;
        dispatch();
        reader = await snapshotThread(dbPath, lane);
        if ((releases.get(dbPath) ?? 0) !== generation) throw new OffThreadReadBusyError();
        snapshot = nextId++;
        await open();
      })();
      return moving;
    };
    try {
      await open();
    } catch (error) {
      if (!(error instanceof OffThreadReadLostError) || !retryLeft) throw error;
      await moveToFreshWorker();
    }
    if (!perRead) markRead(dbPath, snapshot, { atMs: clock.now(), lane, site });
    try {
      return await work(async (query) => {
        const readId = perRead ? -(nextId++) : 0;
        if (perRead) markRead(dbPath, readId, { atMs: clock.now(), lane, site });
        if (observeSnapshots) observer?.(dbPath, query, { lane, site });
        // A snapshot read made by a traced Ask lane counts in its pool reads.
        const report = beginSourceAnswerPoolRead(poolSqlSite(query.sql));
        const sentAtMs = clock.now();
        const queueWaitMs = reserveWaitMs;
        reserveWaitMs = 0;
        let sqlMs = 0;
        const once = async (): Promise<unknown> => {
          if (moving) await moving;
          return send(reader!, { op: 'read', snapshot, sql: query.sql, params: query.params, mode: query.mode }, (ms) => {
            sqlMs = ms;
          });
        };
        try {
          let rows: unknown;
          try {
            rows = await once();
          } catch (error) {
            if (!perRead || !(error instanceof OffThreadReadLostError) || (!retryLeft && !moving)) throw error;
            await moveToFreshWorker();
            rows = await once();
          }
          noteSourceIndexReadProgress();
          report?.({ queueWaitMs, runMs: clock.now() - sentAtMs, sqlMs, outcome: 'rows', snapshot: true });
          return rows;
        } catch (error) {
          report?.({ queueWaitMs, runMs: clock.now() - sentAtMs, sqlMs, outcome: 'error', snapshot: true });
          throw error;
        } finally {
          if (perRead) unmarkRead(dbPath, readId);
          // A search waiting for this thread takes its turn before the next read.
          dispatch();
        }
      });
    } finally {
      await moving?.catch(() => undefined);
      if (reader) await send(reader, { op: 'close', snapshot }).catch(() => undefined);
      unmarkRead(dbPath, snapshot);
    }
  } finally {
    if (reader) reader.snapshots -= 1;
    dispatch();
  }
}

// Every read transaction open on a store's read workers: while one is open,
// no checkpoint can move the WAL past the frames it may still read.
interface OpenRead { atMs: number; lane: ReadPoolLane; site: string }
const openSnapshots = new Map<string, Map<number, OpenRead>>();
function markRead(dbPath: string, id: number, read: OpenRead): void {
  const open = openSnapshots.get(dbPath) ?? new Map<number, OpenRead>();
  open.set(id, read);
  openSnapshots.set(dbPath, open);
}
function unmarkRead(dbPath: string, id: number): void {
  const open = openSnapshots.get(dbPath);
  if (!open) return;
  open.delete(id);
  if (open.size === 0) openSnapshots.delete(dbPath);
}

// The function that asked for the snapshot (code names only, never data).
function callerSite(): string {
  const frames = (new Error().stack ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('at '));
  // "at async name (file:line)": the name, with its file's base name, for the
  // first two frames past the pool's own (minified builds keep file names).
  const names = frames.filter((line) => !/off-thread-reads|withOffThreadSnapshot|readInBackground|ledgerReadOffThread|readStepsInBackground|processTicksAndRejections/.test(line))
    .map((line) => {
      const match = /^at (?:async )?([\w.$<>]+)?\s*\(?(?:.*[\\/])?([\w.-]+\.(?:ts|js)):(\d+)/.exec(line);
      return match ? `${match[1] ?? '<anonymous>'}@${match[2]}:${match[3]}` : undefined;
    })
    .filter((name): name is string => name !== undefined)
    .slice(0, 2);
  return names.length > 0 ? names.join('<') : 'unknown';
}

/** The longest-open read on this store's workers: its age, lane and the function that opened it, or undefined. */
export function oldestOffThreadSnapshot(dbPath: string): { ageMs: number; lane: ReadPoolLane; site: string } | undefined {
  const open = openSnapshots.get(dbPath);
  if (!open || open.size === 0) return undefined;
  let oldest: OpenRead | undefined;
  for (const entry of open.values()) if (!oldest || entry.atMs < oldest.atMs) oldest = entry;
  return oldest ? { ageMs: clock.now() - oldest.atMs, lane: oldest.lane, site: oldest.site } : undefined;
}

// Snapshots waiting for a thread that no pool query is running on.
const snapshotWaiters: Array<{ store: string; lane: ReadPoolLane; resolve: (reader: ReaderThread) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | undefined }> = [];
// How many times each store's pool connections were released.
const releases = new Map<string, number>();

/** A snapshot shares only its store's executor of its lane, once no search is executing. */
function snapshotThreadNow(store: string, lane: ReadPoolLane): ReaderThread | undefined {
  // A re-score reader is worth having only on a worker of its own.
  return live().find(reader => reader.store === store && reader.lane === lane && !reader.releaseWhenIdle && !reader.job
    && (lane !== 'rescore' || reader.snapshots === 0))
    ?? startThread(store, lane);
}

/**
 * A snapshot held open until `close`: withOffThreadSnapshot for a reader
 * whose work is not one callback (the re-score's side readers).
 */
export function openOffThreadSnapshot(
  dbPath: string,
  options: { lane?: ReadPoolLane; noWait?: boolean } = {},
): Promise<{ read: (query: StoreRead) => Promise<unknown>; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    let opened = false;
    const done = withOffThreadSnapshot(dbPath, (read) => new Promise<void>((release) => {
      opened = true;
      resolve({ read, close: async () => { release(); await done.catch(() => undefined); } });
    }), options);
    done.catch((error: unknown) => { if (!opened) reject(error); });
  });
}

/** Reserves the store worker, waiting while its current search is executing. */
function snapshotThread(store: string, lane: ReadPoolLane): Promise<ReaderThread> {
  const reader = snapshotThreadNow(store, lane);
  if (reader) {
    reader.snapshots += 1;
    return Promise.resolve(reader);
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      store,
      lane,
      resolve,
      reject,
      // No deadline: the worker it waits for is busy with work in progress.
      // A release or shutdown of the store cancels the wait.
      timer: undefined,
    };
    snapshotWaiters.push(waiter);
  });
}

function serveSnapshotWaiters(): void {
  // A busy store must not hold up another store's snapshot.
  for (const waiter of [...snapshotWaiters]) {
    const reader = snapshotThreadNow(waiter.store, waiter.lane);
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
  // A caller that gives no deadline waits for its rows however long they take.
  const deadlineAtMs = options.deadlineAtMs ?? Number.POSITIVE_INFINITY;
  const waiting = queues.get(dbPath) ?? [];
  const report = beginSourceAnswerPoolRead(poolSqlSite(read.sql));
  if (waiting.length >= READ_POOL_QUEUE_PER_STORE || clock.now() >= deadlineAtMs) {
    report?.({ queueWaitMs: 0, runMs: 0, sqlMs: 0, outcome: 'refused' });
    return Promise.reject(new OffThreadReadBusyError());
  }
  return new Promise<unknown>((resolve, reject) => {
    const job: PoolJob = { store: dbPath, read, deadlineAtMs, resolve, reject, timer: undefined, started: currentSourceIndexReadProgress(), enqueuedAtMs: clock.now(), report };
    if (Number.isFinite(deadlineAtMs)) job.timer = clock.setTimeout(() => missedDeadline(job), deadlineAtMs - clock.now());
    waiting.push(job);
    if (!queues.has(dbPath)) {
      queues.set(dbPath, waiting);
      turns.push(dbPath);
    }
    dispatch();
  }).then((rows) => { noteSourceIndexReadProgress(); return rows; });
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
  return live().find(reader => reader.store === store && reader.lane === 'shared' && !reader.releaseWhenIdle && !reader.job && reader.pending.size === 0)
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
    job.started?.();
    reader.job = job;
    reader.executingStore = job.store;
    observer?.(job.store, job.read);
    // The caller gives up at its own deadline; the executor is kept until
    // SQLite answers. A reply lost on its way back would hold it for good,
    // so a lost one retires the worker (it keeps its slot until it has
    // stopped) and, if the caller still waits, the query runs again once.
    send(reader, { op: 'query', path: job.store, sql: job.read.sql, params: job.read.params, mode: job.read.mode }, (ms) => {
      job.sqlMs = ms;
    })
      .then(
        (rows) => settle(job, clock.now() >= job.deadlineAtMs ? { error: new OffThreadReadBusyError() } : { rows }),
        (error: Error) => {
          if (error instanceof OffThreadReadLostError && !job.settled && !job.retried) {
            job.retried = true;
            counters.retries += 1;
            job.thread = undefined;
            job.sentAtMs = undefined;
            const waiting = queues.get(job.store) ?? [];
            waiting.unshift(job);
            if (!queues.has(job.store)) { queues.set(job.store, waiting); turns.push(job.store); }
            return;
          }
          settle(job, { error: reader.retired ? new OffThreadReadBusyError() : error });
        },
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
