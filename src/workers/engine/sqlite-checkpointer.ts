// Checkpoints off the loop (16 Nov 2026 gate: a 6 GB ledger WAL, and every
// commit past 1000 pages ran SQLite's automatic checkpoint inline on the
// committing thread, so keyed writes on the loop took 1 to 3 s on a busy
// disk). In the engine's background the loop's writable connections turn the
// automatic checkpoint off (core/sqlite-store.ts, loopWalAutocheckpointPragma) and this worker
// checkpoints each file PASSIVE once its WAL passes a size: PASSIVE never
// waits on a reader or the writer, never takes the writer lock, and copies
// what no reader still needs. The WAL then rewinds at the writer's next
// commit, and journal_size_limit cuts a grown file back. A WAL already large at an upgrade is caught up here, a
// pass at a time, never on the first loop commit.

import { statSync } from 'node:fs';

/** WAL size at which a file is checkpointed (SQLite's own default is 1000 pages, about 4 MB). */
export const SQLITE_CHECKPOINT_AT_BYTES = 4 * 1024 * 1024;
/** A checkpoint is logged when it ran this long or the WAL was this large. */
const CHECKPOINT_NOTABLE_MS = 1_000;
const CHECKPOINT_NOTABLE_BYTES = 32 * 1024 * 1024;

// One writable connection per file, kept for the next pass (opening and
// closing SQLite connections on worker threads is what Bun 1.3 crashed on),
// reopened when the path names a different file.
const WORKER_SOURCE = `
import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
const connections = new Map();
self.onmessage = ({ data }) => {
  const { id, path } = data;
  try {
    const stat = statSync(path);
    const file = stat.dev + ':' + stat.ino;
    let held = connections.get(path);
    if (held && held.file !== file) { try { held.db.close(); } catch {} held = undefined; }
    if (!held) {
      const db = new Database(path, { create: false });
      db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_size_limit = 67108864; PRAGMA wal_autocheckpoint = 0;');
      held = { db, file };
      connections.set(path, held);
    }
    const started = performance.now();
    // PASSIVE only. TRUNCATE takes the writer lock and holds it through its
    // fsync and truncate, which on a busy disk outlasted a loop writer's 10 s
    // busy wait: syncs failed with "database is locked" on the lane 6 gate
    // (16 Nov). After a complete PASSIVE pass the writer's next commit
    // rewinds the WAL, and journal_size_limit cuts the file back to 64 MB.
    const row = held.db.query('PRAGMA wal_checkpoint(PASSIVE)').get();
    postMessage({ id, ok: true, ms: performance.now() - started, busy: row.busy, log: row.log, checkpointed: row.checkpointed });
  } catch (error) {
    postMessage({ id, ok: false, error: error && error.name ? error.name : 'Error' });
  }
};`;

export interface SqliteCheckpointFile { label: string; dbPath: string }

export interface SqliteCheckpointer {
  /** Checkpoints each file whose WAL is past the size, one at a time, skipping any already in a pass. */
  tick(files: readonly SqliteCheckpointFile[]): void;
  stop(): void;
}

export function startSqliteCheckpointer(options: { log?: (line: string) => void; atBytes?: number } = {}): SqliteCheckpointer | undefined {
  if (typeof Worker === 'undefined') return undefined;
  let worker: Worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })));
  } catch {
    return undefined;
  }
  (worker as unknown as { unref?: () => void }).unref?.();
  const log = options.log ?? ((line: string) => console.warn(line));
  const atBytes = options.atBytes ?? SQLITE_CHECKPOINT_AT_BYTES;
  const queue: Array<SqliteCheckpointFile & { walBytes: number }> = [];
  const queued = new Set<string>();
  const lastCheckpointed = new Map<string, number | undefined>();
  let running = false;
  let nextId = 1;
  let stopped = false;
  const pending = new Map<number, (reply: { ok: boolean; ms?: number; busy?: number; log?: number; checkpointed?: number; error?: string }) => void>();
  worker.onmessage = ({ data }) => {
    const reply = data as { id: number };
    const done = pending.get(reply.id);
    pending.delete(reply.id);
    done?.(data);
  };
  const runNext = (): void => {
    if (running || stopped) return;
    const file = queue.shift();
    if (!file) return;
    running = true;
    const id = nextId++;
    pending.set(id, (reply) => {
      running = false;
      queued.delete(file.dbPath);
      if (!reply.ok) {
        log(`[olympus] sqlite checkpoint: ${file.label} failed (${reply.error ?? 'Error'}); tried again at the next sample.`);
      } else if ((reply.ms ?? 0) >= CHECKPOINT_NOTABLE_MS
        || (file.walBytes >= CHECKPOINT_NOTABLE_BYTES && lastCheckpointed.get(file.dbPath) !== reply.checkpointed)) {
        log(`[olympus] sqlite checkpoint: ${file.label} wal_bytes=${file.walBytes} ms=${Math.round(reply.ms ?? 0)} busy=${reply.busy} frames=${reply.log} checkpointed=${reply.checkpointed}`);
      }
      if (reply.ok) lastCheckpointed.set(file.dbPath, reply.checkpointed);
      runNext();
    });
    worker.postMessage({ id, path: file.dbPath, walBytes: file.walBytes });
  };
  return {
    tick(files) {
      if (stopped) return;
      for (const file of files) {
        if (queued.has(file.dbPath)) continue;
        let walBytes = 0;
        try { walBytes = statSync(`${file.dbPath}-wal`).size; } catch { continue; }
        if (walBytes < atBytes) continue;
        queued.add(file.dbPath);
        queue.push({ ...file, walBytes });
      }
      runNext();
    },
    stop() {
      stopped = true;
      queue.length = 0;
      try { worker.terminate(); } catch { /* already gone */ }
    },
  };
}
