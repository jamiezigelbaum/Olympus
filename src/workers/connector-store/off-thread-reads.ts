// Read-only SQLite queries run on a second thread, over the store's own file.
//
// A connector store's status counts are passes over the whole store, and on
// the main thread each one held every request behind it: a third of the
// worker's freeze time on Sparta (#870, 2026-11-05), even read once every five
// minutes. The main thread still decides WHAT to count (the scope SQL and the
// hidden and held lists); this only runs the finished queries elsewhere, so
// the counts are the same SQL either way. SQLite's WAL mode lets a second,
// read-only connection read while the store writes.
//
// The thread is one Bun Worker for the whole process, made from inline source
// so the bundled CLI needs no extra file. Where none can run (an in-memory
// store, a runtime without Bun's Worker, a failed start), callers read on
// their own connection as before.

/** One query: its SQL, bound values, and whether one row or all are wanted. */
export interface StoreRead {
  sql: string;
  params: readonly unknown[];
  mode: 'get' | 'all';
}

// Longer than any count has taken (Sparta's slowest status was about 20 s);
// past it the thread is presumed stuck, replaced, and the caller reads itself.
const OFF_THREAD_READ_TIMEOUT_MS = 120_000;

// Each snapshot is its own read-only connection inside one read transaction,
// so every count in one status describes the same database state, as they did
// when status() ran them back to back with no write in between.
const WORKER_SOURCE = `
import { Database } from 'bun:sqlite';
const snapshots = new Map();
self.onmessage = (event) => {
  const { id, op, snapshot, path, sql, params, mode } = event.data;
  try {
    if (op === 'open') {
      const db = new Database(path, { readonly: true });
      db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON; BEGIN');
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
      const db = snapshots.get(snapshot);
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

type Pending = { resolve: (rows: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

interface ReaderThread {
  worker: Worker;
  pending: Map<number, Pending>;
  retired?: boolean;
}

let thread: ReaderThread | undefined;
let unavailable = false;
let nextId = 1;

function readerThread(): ReaderThread | undefined {
  if (thread) return thread;
  if (unavailable) return undefined;
  try {
    if (typeof Worker !== 'function' || typeof Blob !== 'function' || !(globalThis as { Bun?: unknown }).Bun) {
      unavailable = true;
      return undefined;
    }
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
    const worker = new Worker(url);
    // The reader never keeps a finished command alive.
    (worker as Worker & { unref?: () => void }).unref?.();
    const started: ReaderThread = { worker, pending: new Map() };
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; rows?: unknown; error?: string }>) => {
      const message = event.data;
      const waiting = started.pending.get(message.id);
      if (!waiting) return;
      started.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.rows ?? null);
      else waiting.reject(new Error(message.error ?? 'off-thread read failed'));
    };
    worker.onerror = (event: ErrorEvent) => {
      retire(started, new Error(event.message || 'off-thread reader stopped'));
    };
    thread = started;
    return started;
  } catch {
    unavailable = true;
    return undefined;
  }
}

function retire(stopped: ReaderThread, error: Error): void {
  stopped.retired = true;
  if (thread === stopped) thread = undefined;
  for (const waiting of stopped.pending.values()) {
    clearTimeout(waiting.timer);
    waiting.reject(error);
  }
  stopped.pending.clear();
  try {
    stopped.worker.terminate();
  } catch {
    // Already gone.
  }
}

/** Whether `dbPath` can be read on the second thread (a file, and a thread that can start). */
export function offThreadReadsAvailable(dbPath: string): boolean {
  return dbPath !== ':memory:' && !dbPath.startsWith('file::memory:') && readerThread() !== undefined;
}

function send(reader: ReaderThread, message: Record<string, unknown>): Promise<unknown> {
  // A retired thread answers nothing: fail at once rather than wait out the timeout.
  if (reader.retired) return Promise.reject(new Error('off-thread reader stopped'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      retire(reader, new Error('off-thread read timed out'));
    }, OFF_THREAD_READ_TIMEOUT_MS);
    // Left referenced: a one-shot command waiting on a count must not exit first.
    reader.pending.set(id, { resolve, reject, timer });
    try {
      reader.worker.postMessage({ ...message, id });
    } catch (error) {
      reader.pending.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Runs `work` with a reader over one snapshot of `dbPath` on the second
 * thread: every query it makes sees the same committed state.
 */
export async function withOffThreadSnapshot<T>(
  dbPath: string,
  work: (read: (query: StoreRead) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const reader = readerThread();
  if (!reader) throw new Error('off-thread reads are unavailable');
  const snapshot = nextId++;
  await send(reader, { op: 'open', snapshot, path: dbPath });
  try {
    return await work((query) => send(reader, { op: 'read', snapshot, sql: query.sql, params: query.params, mode: query.mode }));
  } finally {
    await send(reader, { op: 'close', snapshot }).catch(() => undefined);
  }
}
