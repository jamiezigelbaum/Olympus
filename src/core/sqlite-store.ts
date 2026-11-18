import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';

export interface SqliteCloseOptions {
  checkpoint?: boolean;
  readOnly?: boolean;
}

interface CheckpointFile {
  label: string;
  dbPath: string;
  truncateIdleWal: boolean;
}

/**
 * Close a SQLite store. Usually this also folds the WAL for handover. The
 * background delegates routine checkpoints to a worker and can explicitly
 * request a checkpoint for a handover.
 *
 * bun:sqlite finalizes only a bounded number of cached statements on close(),
 * so a store that ran many distinct queries leaves its connection alive and its
 * WAL uncheckpointed until GC reaps it. That reap takes an exclusive lock to
 * checkpoint, and any process that opens the file inside that window fails with
 * SQLITE_BUSY before its own busy_timeout can apply — the 2026-07-26 CI flake,
 * where recovery CLI subprocesses died against a 440KB residual WAL left by a
 * store the test had already close()d.
 *
 * Checkpointing under this connection subtracts the class instead of timing
 * around it: the handover file is complete and its -wal sidecar is empty the
 * moment close() returns, whether or not GC ever runs. busy_timeout stays in
 * force for the checkpoint, so a concurrent reader delays it rather than
 * failing it instantly.
 *
 * The checkpoint is a handover courtesy, never a close precondition: a store
 * that cannot checkpoint (readonly connection, a reader that outlasts the
 * timeout) must still close, and close() alone is exactly the old behaviour.
 */
export function closeSqliteStore(
  db: Database,
  options: SqliteCloseOptions = {},
): void {
  if (options.checkpoint ?? !checkpointsOffLoop) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // Deliberate: closing is the contract, checkpointing is the improvement.
    }
  } else if (openCloseReader && !options.readOnly && db.filename && existsSync(`${db.filename}-wal`)) {
    // SQLite can also checkpoint inside close when the last writable handle
    // leaves. A read-only connection with an initialized pager keeps it from
    // taking the exclusive lock. It holds no open read transaction.
    let reader: Database | undefined;
    try {
      reader = openCloseReader(db.filename);
    } catch {
      // A file that disappeared or cannot be read must still be closed.
    }
    try {
      db.close();
    } finally {
      reader?.close();
    }
    return;
  }
  db.close();
}

let checkpointsOffLoop = false;
let openCloseReader: ((dbPath: string) => Database) | undefined;
const checkpointFiles = new Map<string, CheckpointFile>();

/**
 * The engine's background turns SQLite's automatic checkpoint off on its
 * loop's writable connections, before any store opens: a worker checkpoints
 * instead (workers/engine/sqlite-checkpointer.ts).
 */
export function setSqliteCheckpointsOffLoop(on: boolean, readForClose?: (dbPath: string) => Database): void {
  checkpointsOffLoop = on;
  openCloseReader = on ? readForClose : undefined;
  if (!on) checkpointFiles.clear();
}

/** Appended to a loop store's open pragmas: the automatic checkpoint off when the worker does it. */
export function loopWalAutocheckpointPragma(dbPath?: string, kind: 'store' | 'tier-ledger' = 'store'): string {
  if (!checkpointsOffLoop) return '';
  if (dbPath && dbPath !== ':memory:' && !checkpointFiles.has(dbPath)) {
    checkpointFiles.set(dbPath, { label: `${kind}-open-${checkpointFiles.size + 1}`, dbPath, truncateIdleWal: kind === 'tier-ledger' });
  }
  return ' PRAGMA wal_autocheckpoint = 0;';
}

/** Includes transient writable opens that the engine's mounted-store roster never sees. */
export function sqliteFilesForOffLoopCheckpoints(): Iterable<CheckpointFile> {
  return checkpointFiles.values();
}
