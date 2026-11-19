/**
 * One persistent read-only connection for a front's people reloads. Like
 * connector-store/off-thread-reads.ts, inline source travels in both bundles
 * without a separately installed worker entrypoint. Unlike the pool's rotating
 * snapshot connections, this connection owns its data_version baseline.
 * Requests have no deadline: a slow SQLite read is allowed to finish.
 */
const WORKER_SOURCE = `
import { Database } from 'bun:sqlite';
let db;
let loadedVersion;
let snapshotVersion;
self.onmessage = (event) => {
  const { path, op, sql, params } = event.data;
  try {
    if (op === 'close') {
      try {
        if (db?.inTransaction) db.exec('ROLLBACK');
        db?.close();
      } finally {
        process.exit(0);
      }
      return;
    }
    if (!db) {
      db = new Database(path, { readonly: true, create: false, strict: true });
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA query_only = ON');
    }
    let result;
    if (op === 'beginIfChanged') {
      // Read BEFORE BEGIN: data_version inside the snapshot can stay pinned
      // while a writer commits. Only this pre-snapshot version is marked read.
      const version = db.query('PRAGMA data_version').get().data_version;
      result = version !== loadedVersion;
      if (result) {
        db.exec('BEGIN');
        snapshotVersion = version;
      }
    } else if (op === 'finish') {
      db.exec('COMMIT');
      loadedVersion = snapshotVersion;
      result = null;
    } else if (op === 'read') {
      result = db.query(sql).all(...params);
    } else {
      throw new Error('Unknown people reader request');
    }
    postMessage({ ok: true, result });
  } catch (error) {
    // The caller retires this worker on any failure. Its connection and any
    // unfinished transaction go with it; a retry starts without a baseline.
    postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
`;

export class PeopleReadWorker {
  private readonly worker: Worker & { ref?: () => void; unref?: () => void };
  private pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  private stopped: Error | undefined;
  private readonly closed: Promise<void>;
  private resolveClosed!: () => void;

  constructor(private readonly dbPath: string) {
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
    try {
      this.worker = new Worker(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    this.worker.unref?.();
    this.worker.onmessage = (event: MessageEvent<{ ok: boolean; result?: unknown; error?: string }>) => {
      const waiting = this.pending;
      if (!waiting) return;
      this.pending = undefined;
      this.worker.unref?.();
      if (event.data.ok) waiting.resolve(event.data.result);
      else {
        const error = new Error(event.data.error ?? 'People reader failed');
        this.close(error);
        waiting.reject(error);
      }
    };
    this.worker.onerror = (event: ErrorEvent) => {
      void this.close(new Error(event.message || 'People reader failed'));
      this.worker.terminate();
    };
    this.worker.addEventListener('close', () => {
      URL.revokeObjectURL(url);
      this.stopped ??= new Error('People reader stopped');
      this.pending?.reject(this.stopped);
      this.pending = undefined;
      this.resolveClosed();
    });
  }

  beginIfChanged(): Promise<boolean> {
    return this.request({ op: 'beginIfChanged' }) as Promise<boolean>;
  }

  read<T>(sql: string, params: readonly (string | number)[] = []): Promise<T[]> {
    return this.request({ op: 'read', sql, params }) as Promise<T[]>;
  }

  finish(): Promise<void> {
    return this.request({ op: 'finish' }) as Promise<void>;
  }

  close(error = new Error('People reader closed')): Promise<void> {
    if (this.stopped) return this.closed;
    this.stopped = error;
    this.pending?.reject(error);
    this.pending = undefined;
    // Let SQLite release its transaction before the thread exits. Terminating
    // an idle thread with an open snapshot can leave WAL cleanup to GC.
    this.worker.ref?.();
    try {
      this.worker.postMessage({ op: 'close' });
    } catch (error) {
      // The thread cannot accept shutdown; termination releases its resources.
      this.worker.terminate();
    }
    return this.closed;
  }

  private request(message: Record<string, unknown>): Promise<unknown> {
    if (this.stopped) return Promise.reject(this.stopped);
    if (this.pending) return Promise.reject(new Error('People reader already has a request'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.ref?.();
      try {
        this.worker.postMessage({ ...message, path: this.dbPath });
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
