// The background's checkpoints run on a worker, not inline on a loop commit
// (16 Nov 2026 gate: a 6 GB ledger WAL and 1-3 s keyed writes).
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { ENGINE_ROLE_ENV, engineRoleFromEnv } from '../src/core/engine-split.ts';
import { openStoreReadOnlyForClose } from '../src/core/source-storage.ts';
import { loopWalAutocheckpointPragma, setSqliteCheckpointsOffLoop, sqliteFilesForOffLoopCheckpoints } from '../src/core/sqlite-store.ts';
import { withLedgerAt } from '../src/workers/classification/tier-cli.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { ControlPathHeadroom } from '../src/workers/control-path-headroom.ts';
import { startSqliteCheckpointer } from '../src/workers/engine/sqlite-checkpointer.ts';
import { startSqliteWalSampler } from '../src/workers/engine/sqlite-wal-sampler.ts';
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

test('the background defers a transient ledger close to the worker, and the worker truncates an idle WAL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-checkpointer-'));
  roots.push(root);
  const path = join(root, 'unmounted.tier-ledger.sqlite');
  const limit = 64 * 1024 * 1024;
  const lines: string[] = [];
  const checkpointer = startSqliteCheckpointer({ hotMs: 25, idleMs: 25, log: (line) => lines.push(line) })!;
  const previousRole = process.env[ENGINE_ROLE_ENV];
  process.env[ENGINE_ROLE_ENV] = 'background';
  setSqliteCheckpointsOffLoop(engineRoleFromEnv() === 'background', openStoreReadOnlyForClose);
  const exec = spyOn(Database.prototype, 'exec');
  const walPath = `${path}-wal`;
  const walBytes = () => existsSync(walPath) ? statSync(walPath).size : 0;
  let sampler: ReturnType<typeof startSqliteWalSampler> | undefined;
  try {
    // No mounted store or open writer holds this WAL after withLedgerAt returns.
    withLedgerAt(path, undefined, (ledger) => ledger.writeMeta('test-sentinel', 'committed'));
    expect(exec.mock.calls.filter(([sql]) => /wal_checkpoint/i.test(sql))).toEqual([]);
    expect(walBytes()).toBeGreaterThan(0);
    // SQLite can retain allocated WAL space past its last valid frame.
    // Model that tail sparsely while keeping the ledger's committed frames real.
    truncateSync(walPath, limit + 4096);
    expect(walBytes()).toBeGreaterThan(limit);
    sampler = startSqliteWalSampler(() => [...sqliteFilesForOffLoopCheckpoints()], {
      intervalMs: 5, log: () => {}, afterSample: (files) => checkpointer.tick(files),
    });
    // The worker's reply can deliver the log line a moment after the stats move, so the line is part of the wait.
    await waitFor(() => walBytes() === 0 && checkpointer.roomStats().passes >= 2
      && lines.some((line) => line.includes('sqlite checkpoint: tier-ledger-open-1 wal_bytes=0 ')), {
      description: 'the worker truncated the unmounted ledger WAL without a subsequent write and logged it',
    });
    expect(exec.mock.calls.filter(([sql]) => /wal_checkpoint/i.test(sql))).toEqual([]);
    const reader = new TierLedger({ dbPath: path, readOnly: true });
    try {
      expect(reader.readMeta('test-sentinel')).toBe('committed');
    } finally {
      reader.close();
    }
  } finally {
    if (previousRole === undefined) delete process.env[ENGINE_ROLE_ENV];
    else process.env[ENGINE_ROLE_ENV] = previousRole;
    exec.mockRestore();
    sampler?.stop();
    checkpointer.stop();
  }
});

test('an explicit shutdown close checkpoints the ledger even when the worker owns routine checkpoints', () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-checkpointer-'));
  roots.push(root);
  const path = join(root, 'shutdown.tier-ledger.sqlite');
  setSqliteCheckpointsOffLoop(true, openStoreReadOnlyForClose);
  const ledger = new TierLedger({ dbPath: path });
  ledger.writeMeta('shutdown-test', 'committed');
  const exec = spyOn(Database.prototype, 'exec');
  try {
    ledger.close({ checkpoint: true });
    expect(exec.mock.calls).toContainEqual(['PRAGMA wal_checkpoint(TRUNCATE);']);
    expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);
  } finally {
    exec.mockRestore();
  }
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

// A writer that never pauses adds frames during every pass, so no pass ends
// level with it and SQLite never rewinds the WAL (gate on ced5a461: 134 to
// 379 MB against the 64 MB limit, every pass busy=0). About 100 MB of commits with a
// turn between them, as the engine's bulk lanes write.
async function writeSteadily(path: string, room: (() => Promise<void> | undefined) | undefined): Promise<{ peak: number; end: number }> {
  // The engine's own turn (a timer; Bun delivers no worker message between chained immediates), joined by the room wait as in the background.
  const headroom = new ControlPathHeadroom({ sliceMs: 0 });
  headroom.setRoomGate(room);
  const writer = new Database(path);
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0; PRAGMA journal_size_limit = 67108864; CREATE TABLE IF NOT EXISTS t (v BLOB)');
  const insert = writer.query('INSERT INTO t VALUES (randomblob(4000))');
  const commit = writer.transaction(() => { for (let n = 0; n < 16; n += 1) insert.run(); });
  let peak = 0;
  for (let round = 0; round < 1500; round += 1) {
    commit();
    if (round % 8 === 0) peak = Math.max(peak, statSync(`${path}-wal`).size);
    await headroom.ingestionTurn();
  }
  const end = statSync(`${path}-wal`).size;
  headroom.stop();
  writer.close();
  return { peak, end };
}

// The engine's files are open and have had a pass long before bulk writing
// starts; this test's writer would otherwise finish before a worker has started.
async function seedAndFirstPass(checkpointer: NonNullable<ReturnType<typeof startSqliteCheckpointer>>, label: string, path: string): Promise<void> {
  const seed = new Database(path);
  seed.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v BLOB); INSERT INTO t VALUES (randomblob(400000))');
  checkpointer.tick([{ label, dbPath: path }]);
  await waitFor(() => checkpointer.roomStats().passes > 0, { description: `${label} had its first pass` });
  seed.close();
}

test('a writer that never pauses: its WAL stays under the limit because its turns wait for room', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-checkpointer-'));
  roots.push(root);
  // Without the wait this writing leaves a WAL of about 115 MB on a quiet
  // machine (measured; on a loaded one a pass sometimes lands in a gap, so
  // that side is not asserted here).
  const gated = startSqliteCheckpointer({ log: () => {}, atBytes: 256 * 1024, roomBytes: 2 * 1024 * 1024, hotMs: 5, idleMs: 5 })!;
  const gatedPath = join(root, 'gated.sqlite');
  await seedAndFirstPass(gated, 'gated', gatedPath);
  const bounded = await writeSteadily(gatedPath, () => gated.room());
  const stats = gated.roomStats();
  gated.stop();
  // This writer is many times faster than the engine's, so the file overshoots the test's 2 MB mark; the limit is what counts.
  expect(bounded.peak).toBeLessThan(64 * 1024 * 1024);
  expect(stats.waits).toBeGreaterThan(2);
  expect(stats.rewinds).toBeGreaterThan(2);
}, 60_000);

test('a WAL a read holds is named, and no work waits on it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-checkpointer-'));
  roots.push(root);
  const path = join(root, 'held.sqlite');
  const writer = new Database(path);
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v BLOB)');
  const insert = writer.query('INSERT INTO t VALUES (randomblob(4000))');
  const commit = writer.transaction(() => { for (let n = 0; n < 200; n += 1) insert.run(); });
  commit();
  const reader = new Database(path, { readonly: true });
  reader.exec('BEGIN');
  reader.query('SELECT count(*) FROM t').get();
  commit();
  const lines: string[] = [];
  const checkpointer = startSqliteCheckpointer({ log: (line) => lines.push(line), atBytes: 256 * 1024, roomBytes: 512 * 1024, hotMs: 50, idleMs: 50 })!;
  checkpointer.tick([{ label: 'held-1', dbPath: path }]);
  await waitFor(() => lines.some((line) => line.startsWith('[olympus] sqlite wal held: held-1 ')), { description: 'the held WAL was named' });
  expect(checkpointer.room()).toBeUndefined();
  reader.exec('COMMIT');
  reader.close();
  // The read ended: passes move again, and work makes room as for any file.
  await waitFor(() => checkpointer.room() !== undefined, { description: 'the freed WAL asks for room' });
  checkpointer.stop();
  writer.close();
}, 60_000);
