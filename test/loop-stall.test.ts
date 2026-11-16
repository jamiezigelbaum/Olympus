/** Cold engine-loop regression gate; only the Sparta release runner seeds it. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { gate, memoryMaxBytes, sqliteGuards } from '../scripts/loop-stall-test.ts';
import { join } from 'node:path';
import { waitFor } from './helpers/test-clock.ts';

const enabled = process.env.CJ_JOB === 'test-focus';
const script = join(import.meta.dir, '../scripts/loop-stall-test.ts');
// The account's real home from the password database: test:focus sets HOME to a temporary folder, which a cloud job puts
// in /dev/shm, and an 8-10 GB fixture there is shared memory inside the job's 6G cap (memory-cgroup OOM at 6.18 GB of shmem,
// cloud-job 43781010883, 16 Nov 2026). On disk the fixture also survives between runs and is reused by its shape.
const passwdHome = spawnSync('getent', ['passwd', String(process.getuid?.() ?? '')], { encoding: 'utf8' }).stdout?.split(':')[5]?.trim();
const dir = join(passwdHome || userInfo().homedir, 'olympus-prof/loop-stall');
// SQLite's temporary files (index builds and sorts on a store of several GB) go to TMPDIR, which a cloud job points at
// /dev/shm: there they are shared memory inside the job's 6G cap, and the cgroup OOM killer stopped the first build at
// 6.0 GB of shmem (cloud-job 43775223716, 15 Nov 2026). The gate's processes keep them on disk, beside the fixture.
const diskTmp = join(dir, 'tmp');
function invoke(args: string[], timeout = 10 * 60_000, env: NodeJS.ProcessEnv = process.env) {
  // Progress goes straight to the job's log, so a run stopped part way still shows how far it got.
  const result = spawnSync(args[0]!, args.slice(1), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout, env, stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(result.stdout);
  if (result.error) throw result.error;
  return result.status;
}
test.skipIf(!enabled)('split engine with an 8G cap stays within loop and main-thread SQLite budgets', () => {
  expect(dir.startsWith('/dev/shm') || dir.startsWith(tmpdir())).toBe(false);
  mkdirSync(diskTmp, { recursive: true });
  const onDisk = { ...process.env, TMPDIR: diskTmp, SQLITE_TMPDIR: diskTmp };
  expect(invoke(['bun', script, 'build', '--dir', dir], 180 * 60_000, onDisk)).toBe(0);
  // More RAM must not hide repeated scans through SQLite's small connection caches.
  expect(invoke(['systemd-run', '--user', '--scope', '--quiet', '-p', 'MemoryMax=8G', '-p', 'MemorySwapMax=0', '--', 'bun', script, 'run', '--dir', dir, '--seconds', '300', '--memory-max', '8G'], 10 * 60_000, onDisk)).toBe(0);
}, 195 * 60_000);

test('memory cap accepts the default and warm-cache sizes and rejects invalid caps', () => {
  expect(memoryMaxBytes('2G')).toBe(2 * 1024 ** 3);
  expect(memoryMaxBytes('8G')).toBe(8 * 1024 ** 3);
  expect(memoryMaxBytes('8192M')).toBe(8 * 1024 ** 3);
  expect(memoryMaxBytes('2048')).toBe(2048);
  for (const value of ['0', '-1G', 'max', '2GB', 'bogus', '9007199254740992']) expect(() => memoryMaxBytes(value)).toThrow();
});

test('fixture rebuilds an old shape with substantial embedded Personal and Private legs and ledger history', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'loop-stall-shape-'));
  try {
    // An old version is retained, while build creates the current version's home.
    mkdirSync(join(fixture, 'home'));
    const old = join(fixture, 'home', 'old-synthetic-store');
    writeFileSync(old, 'previous fixture');
    writeFileSync(join(fixture, 'shape.json'), JSON.stringify({ shape: { version: 4 } }));
    const args = ['bun', script, 'build', '--dir', fixture, '--items', '200'];
    expect(invoke(args)).toBe(0);
    const receipt = JSON.parse(readFileSync(join(fixture, 'shape.json'), 'utf8'));
    expect(receipt.shape.version).toBeGreaterThan(4);
    expect(receipt.shape.chunksPerItem).toBe(1);
    expect(readFileSync(old, 'utf8')).toBe('previous fixture');
    const database = (name: string) => new Database(join(fixture, receipt.files.find((path: string) => path.endsWith(`/${name}.sqlite`))), { readonly: true });
    for (const [name, count] of [['internal', 120], ['secure_local', 80]] as const) {
      const store = database(name);
      try {
        expect(store.query('SELECT COUNT(*) AS n FROM items WHERE tombstoned = 0').get()).toEqual({ n: count });
        expect((store.query('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n).toBeGreaterThanOrEqual(count);
        expect((store.query('SELECT COUNT(*) AS n FROM chunk_embeddings').get() as { n: number }).n).toBeGreaterThanOrEqual(count);
      } finally { store.close(); }
    }
    const ledgerPath = receipt.files.find((path: string) => path.endsWith('/set.tier-ledger.sqlite'));
    expect(receipt.file_bytes[ledgerPath]).toBeGreaterThan(200 * 7000);
    const ledger = database('set.tier-ledger');
    try {
      expect((ledger.query('SELECT COUNT(*) AS n FROM tier_items').get() as { n: number }).n).toBeGreaterThanOrEqual(200);
      expect((ledger.query('SELECT COUNT(*) AS n FROM tier_history').get() as { n: number }).n).toBeGreaterThanOrEqual(800);
      expect((ledger.query('SELECT length(reasons_json) AS n FROM tier_items WHERE provider_item_id = ?').get('6') as { n: number }).n).toBeGreaterThan(1024);
    } finally { ledger.close(); }
    // Same-version builds reuse their complete seed rather than duplicating it.
    expect(invoke(args)).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture, 'shape.json'), 'utf8'))).toEqual(receipt);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}, 60_000);

// A red engine may never become green by adding an allowance or losing a
// sampler/workload. The allowance was introduced empty and can only shrink.
test('loop-stall gate enforces both strict budgets and fails closed', () => {
  const allowed = JSON.parse(readFileSync(join(import.meta.dir, '../scripts/loop-stall-allowlist.json'), 'utf8'));
  expect(allowed).toEqual([]);
  const healthy = { background: { max_ms: 249, over_budget: 0, beats: 1 }, front: { max_ms: 99, over_budget: 0, beats: 1 }, slow_sql: [], workload_ok: true };
  expect(gate(healthy, allowed)).toBe(true);
  expect(gate({ ...healthy, background: { ...healthy.background, max_ms: 250 } }, allowed)).toBe(false);
  expect(gate({ ...healthy, front: { ...healthy.front, max_ms: 100 } }, allowed)).toBe(false);
  expect(gate({ ...healthy, background: { ...healthy.background, beats: 0 } }, allowed)).toBe(false);
  expect(gate({ ...healthy, workload_ok: false }, allowed)).toBe(false);
  expect(gate({ ...healthy, slow_sql: [{ sql_id: 'unexpected' }] }, allowed)).toBe(false);
});

test('loop-stall gate fails on a WAL over 64 MB at the end or a background read held over 2 s, and only lists shared reads', () => {
  const line = (label: string, ms: number, lane: string) => `[olympus] sqlite wal: ${label} wal_bytes=1 oldest_read_ms=${ms} oldest_read_lane=${lane} oldest_read_site=async`;
  expect(sqliteGuards({ 'a.sqlite': 64 * 1024 * 1024 }, [line('a', 2000, 'background'), line('a', 9000, 'shared')])).toMatchObject({ ok: true, other_reads_over_2s: [{ ms: 9000, lane: 'shared' }] });
  expect(sqliteGuards({ 'a.sqlite': 64 * 1024 * 1024 + 1 }, []).ok).toBe(false);
  expect(sqliteGuards({}, [line('internal', 2001, 'background'), line('internal', 4000, 'background')])).toMatchObject({ ok: false, background_reads_over_2s: [{ label: 'internal', ms: 4000 }] });
});

// A completed tick alone misses a freeze still in progress at shutdown.
test('heartbeat reports a front that has not resumed from its freeze', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-stall-beat-'));
  const module = join(import.meta.dir, '../src/core/engine-heartbeat.ts');
  const child = Bun.spawn([process.execPath, '-e', `
    import { startEngineHeartbeat } from ${JSON.stringify(module)};
    import { writeFileSync } from 'node:fs';
    startEngineHeartbeat({ HOME: ${JSON.stringify(dir)}, OLYMPUS_ENGINE_LOOP_METRICS_DIR: ${JSON.stringify(dir)} }, 'front');
    setTimeout(() => {
      writeFileSync(${JSON.stringify(join(dir, 'blocked'))}, '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
    }, 100);
    setInterval(() => {}, 1000);
  `], { stdout: 'ignore', stderr: 'pipe' });
  try {
    const beat = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(join(dir, 'front.json'), 'utf8'));
        return existsSync(join(dir, 'blocked')) && value.loop_lag.max_ms >= 300 ? value : undefined;
      } catch { return undefined; }
    }, { timeoutMs: 3_000 });
    expect(beat.loop_lag.over_budget).toBeGreaterThan(0);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
