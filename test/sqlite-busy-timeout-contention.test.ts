import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { LocalXBookmarksReconcileStateStore } from '../src/workers/x-bookmarks/index.ts';

const LOCK_HOLD_MS = 1_000;

/**
 * bun:sqlite finalizes only a bounded number of cached prepared statements on
 * close(), so a store with many distinct queries stays open until GC reaps it.
 * That reap runs SQLite's close-time checkpoint under an exclusive lock, and any
 * process opening the same file inside that window gets SQLITE_BUSY. The retry
 * only happens if busy_timeout is set before the pragmas that take a lock.
 */
test('a store opens under a competing exclusive lock instead of failing instantly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-sqlite-busy-'));
  const statePath = join(dir, 'reconcile.sqlite');
  try {
    new LocalXBookmarksReconcileStateStore(statePath).close();

    const holder = Bun.spawn(
      [
        'bun',
        '-e',
        `const { Database } = require('bun:sqlite');
         const db = new Database(${JSON.stringify(statePath)});
         db.exec('PRAGMA busy_timeout = 10000; PRAGMA locking_mode = EXCLUSIVE;');
         db.exec('BEGIN IMMEDIATE');
         db.exec("UPDATE schema_version SET version = version");
         console.log('locked');
         await Bun.sleep(${LOCK_HOLD_MS});
         db.exec('COMMIT');`,
      ],
      { stdout: 'pipe' },
    );
    await holder.stdout.getReader().read();

    const startedAt = Bun.nanoseconds();
    const store = new LocalXBookmarksReconcileStateStore(statePath);
    const elapsedMs = (Bun.nanoseconds() - startedAt) / 1e6;
    store.close();
    await holder.exited;

    // Opening waited the lock out rather than returning SQLITE_BUSY in milliseconds.
    expect(elapsedMs).toBeGreaterThan(LOCK_HOLD_MS * 0.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
