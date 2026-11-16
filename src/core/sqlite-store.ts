import type { Database } from 'bun:sqlite';

/**
 * Close a sqlite store so its file is immediately safe to hand to another
 * process.
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
  options: { checkpoint?: boolean } = {},
): void {
  if (options.checkpoint !== false) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // Deliberate: closing is the contract, checkpointing is the improvement.
    }
  }
  db.close();
}

let checkpointsOffLoop = false;

/**
 * The engine's background turns SQLite's automatic checkpoint off on its
 * loop's writable connections, before any store opens: a worker checkpoints
 * instead (workers/engine/sqlite-checkpointer.ts).
 */
export function setSqliteCheckpointsOffLoop(on: boolean): void {
  checkpointsOffLoop = on;
}

/** Appended to a loop store's open pragmas: the automatic checkpoint off when the worker does it. */
export function loopWalAutocheckpointPragma(): string {
  return checkpointsOffLoop ? ' PRAGMA wal_autocheckpoint = 0;' : '';
}
