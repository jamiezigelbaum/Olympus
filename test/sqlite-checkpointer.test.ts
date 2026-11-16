// The background's checkpoints run on a worker, not inline on a loop commit
// (16 Nov 2026 gate: a 6 GB ledger WAL and 1-3 s keyed writes).
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { loopWalAutocheckpointPragma, setSqliteCheckpointsOffLoop } from '../src/core/sqlite-store.ts';
import { startSqliteCheckpointer } from '../src/workers/engine/sqlite-checkpointer.ts';
import { waitFor } from './helpers/test-clock.ts';

const roots: string[] = [];
afterEach(() => {
  setSqliteCheckpointsOffLoop(false);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('loop connections turn the automatic checkpoint off only while the worker checkpoints', () => {
  expect(loopWalAutocheckpointPragma()).toBe('');
  setSqliteCheckpointsOffLoop(true);
  expect(loopWalAutocheckpointPragma()).toContain('wal_autocheckpoint = 0');
});

test('a large WAL is checkpointed by the worker without the writer lock, and the writer\'s next commit cuts it back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-checkpointer-'));
  roots.push(root);
  const path = join(root, 'store.sqlite');
  const writer = new Database(path);
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA journal_size_limit = 67108864; CREATE TABLE t (v BLOB)');
  const insert = writer.query('INSERT INTO t VALUES (randomblob(4096))');
  writer.transaction(() => { for (let n = 0; n < 20_000; n += 1) insert.run(); })();
  const before = statSync(`${path}-wal`).size;
  expect(before).toBeGreaterThan(64 * 1024 * 1024);
  const lines: string[] = [];
  const checkpointer = startSqliteCheckpointer({ log: (line) => lines.push(line) })!;
  expect(checkpointer).toBeDefined();
  checkpointer.tick([{ label: 'store-1', dbPath: path }]);
  await waitFor(() => lines.length > 0, { description: 'the checkpoint reported' });
  expect(lines.some((line) => /^\[olympus\] sqlite checkpoint: store-1 wal_bytes=\d+ ms=\d+ busy=0 frames=(\d+) checkpointed=\1$/.test(line))).toBe(true);
  // PASSIVE never takes the writer lock: the writer commits at once, with no busy wait.
  writer.exec('PRAGMA busy_timeout = 0');
  insert.run();
  expect(statSync(`${path}-wal`).size).toBeLessThan(before);
  checkpointer.stop();
  writer.close();
}, 60_000);
