/** Cold engine-loop regression gate; only the Sparta release runner seeds it. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { beatP95, gate, memoryMaxBytes, sampledBeatSite, sqliteGuards, summarizeBeats } from '../scripts/loop-stall-test.ts';
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
  // Two cases, each scored on its own line: a box in use, and the first boot after an upgrade left a large WAL.
  // Exit 3 is "host busy" (the IO floor was never reached): not a product result.
  // Each case starts from the pristine fixture, copied outside the memory cap.
  const results = Object.fromEntries((['steady', 'boot-after-upgrade'] as const).map(runCase => [runCase,
    invoke(['bun', script, 'restore', '--dir', dir], 30 * 60_000, onDisk) || invoke(['systemd-run', '--user', '--scope', '--quiet', '-p', 'MemoryMax=8G', '-p', 'MemorySwapMax=0', '--', 'bun', script, 'run', '--dir', dir, '--seconds', '300', '--memory-max', '8G', '--case', runCase], 25 * 60_000, onDisk)]));
  console.log(JSON.stringify({ phase: 'cases', results }));
  expect(results).toEqual({ steady: 0, 'boot-after-upgrade': 0 });
}, 235 * 60_000);

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
    // Each run starts from this copy, so every run has judging to do.
    expect(existsSync(join(fixture, `pristine-v${receipt.shape.version}`, 'set.tier-ledger.sqlite'))).toBe(true);
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

// A red engine may never become green by losing a sampler or a workload.
test('loop-stall gate uses after-ready limits with the workload complete and no WAL over the limit', () => {
  const healthy = {
    background: { max_ms: 29_999, over_budget: 1, beats: 1, pre_ready_ms: 107_372 },
    front: { max_ms: 999, over_budget: 1, beats: 1, pre_ready_ms: 50_000 },
    workload_ok: true, wal_ok: true, ack_ok: true,
  };
  expect(gate(healthy)).toBe(true);
  expect(gate({ ...healthy, background: { ...healthy.background, max_ms: 30_000 } })).toBe(false);
  expect(gate({ ...healthy, ack_ok: false })).toBe(false);
  expect(gate({ ...healthy, front: { ...healthy.front, max_ms: 3_700 }, runCase: 'boot-after-upgrade' })).toBe(true);
  expect(gate({ ...healthy, front: { ...healthy.front, max_ms: 30_000 }, runCase: 'boot-after-upgrade' })).toBe(false);
  expect(gate({ ...healthy, front: { ...healthy.front, max_ms: 3_700 }, runCase: 'steady' })).toBe(false);
  expect(beatP95({ max_ms: 1, over_budget: 0, beats: 100, buckets: [90, 4, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0] })).toBe(50);
  expect(beatP95({ max_ms: 1, over_budget: 0, beats: 0 })).toBeUndefined();
  expect(gate({ ...healthy, front: { ...healthy.front, max_ms: 1000 } })).toBe(false);
  expect(gate({ ...healthy, background: { ...healthy.background, beats: 0 } })).toBe(false);
  expect(gate({ ...healthy, workload_ok: false })).toBe(false);
  expect(gate({ ...healthy, wal_ok: false })).toBe(false);
});

test('beat reporting splits at readiness and attributes each worst hold to its own samples', () => {
  const startup = { startMs: 25, endMs: 107_397 };
  const worst = { startMs: 107_422, endMs: 109_422 };
  const later = { startMs: 109_447, endMs: 110_947 };
  const timing = { spawnedAt: 0, readyAt: startup.endMs, stoppedAt: later.endMs };
  const traces = [
    { timestamp: 1110, frames: [{ name: 'readItemPages' }] },
    { timestamp: 1000.002, frames: [{ name: 'spawn' }] },
  ];
  const sampledLater = sampledBeatSite(later, traces, 1000)!;
  expect(sampledLater.site).toBe('readItemPages');
  expect(sampledBeatSite(startup, traces, 1000)).toBeUndefined();
  expect(sampledBeatSite(worst, traces, 1000)).toBeUndefined();
  for (const role of ['background', 'front'] as const) {
    const result = summarizeBeats(role, [startup, worst, later], [sampledLater], timing);
    expect(result.loop).toMatchObject({
      max_ms: 2000, worst_site: 'unsampled', beats: 2, over_1s: 2,
      pre_ready_ms: 107_372, pre_ready_site: 'unsampled', spawn_to_ready_ms: 107_397,
    });
    expect(beatP95(result.loop)).toBe(5000);
    expect(result.sites).toEqual([
      { site: 'unsampled', count: 1, total_s: 2, worst_ms: 2000 },
      { site: 'readItemPages', count: 1, total_s: 1.5, worst_ms: 1500 },
    ]);
  }
  const sampledStartup = sampledBeatSite(startup, [{ timestamp: 1050, frames: [{ name: 'openStore' }] }], 1000)!;
  const bootOnly = summarizeBeats('background', [startup], [sampledStartup], { ...timing, stoppedAt: timing.readyAt });
  expect(bootOnly.loop).toMatchObject({ max_ms: 0, beats: 0, over_1s: 0, pre_ready_site: 'openStore' });
  expect(beatP95(bootOnly.loop)).toBeUndefined();
});

test('an unfinished hold belongs to its readiness phase', () => {
  const beat = { startMs: 25, endMs: 30 };
  const timing = { spawnedAt: 0, stoppedAt: 40_000 };
  const boot = summarizeBeats('front', [beat], [], timing).loop;
  expect(boot).toMatchObject({ pre_ready_ms: 39_945, max_ms: 0, over_1s: 0, spawn_to_ready_ms: null });
  const ready = summarizeBeats('front', [beat], [], { ...timing, readyAt: 20 }).loop;
  expect(ready).toMatchObject({ pre_ready_ms: 0, max_ms: 39_945, worst_site: 'unsampled', beats: 1, over_1s: 1 });
  expect(beatP95(ready)).toBe(10);
});

test('loop-stall gate fails on a WAL over 64 MB at the end and lists reads held over 2 s', () => {
  const line = (label: string, ms: number, lane: string) => `[olympus] sqlite wal: ${label} wal_bytes=1 oldest_read_ms=${ms} oldest_read_lane=${lane} oldest_read_site=async`;
  expect(sqliteGuards({ 'a.sqlite': 64 * 1024 * 1024 }, [line('a', 2000, 'background'), line('a', 9000, 'shared')])).toMatchObject({ wal_ok: true, other_reads_over_2s: [{ ms: 9000, lane: 'shared' }] });
  expect(sqliteGuards({ 'a.sqlite': 64 * 1024 * 1024 + 1 }, []).wal_ok).toBe(false);
  const cp = (at: string, bytes: number) => ({ at, line: `[olympus] sqlite checkpoint: ledger wal_bytes=${bytes} ms=1 busy=0 frames=1 checkpointed=1` });
  expect(sqliteGuards({}, [cp('2026-11-16T00:00:00Z', 67108865), cp('2026-11-16T00:00:30Z', 1)])).toMatchObject({ wal_ok: true, wal_peak_over: [{ label: 'ledger', bytes: 67108865, crossings: 1, longest_s: 30 }] });
  expect(sqliteGuards({}, [cp('2026-11-16T00:00:00Z', 67108865), cp('2026-11-16T00:01:01Z', 1)]).wal_ok).toBe(false);
  expect(sqliteGuards({}, [cp('2026-11-16T00:00:00Z', 67108865), cp('2026-11-16T00:01:01Z', 67108865)]).wal_ok).toBe(false);
  expect(sqliteGuards({}, [cp('2026-11-16T00:00:00Z', 1024 * 1024 * 1024 + 1), cp('2026-11-16T00:00:05Z', 1)]).wal_ok).toBe(false);
  const padded = ['[olympus] sqlite wal: ledger wal_bytes=2296000000 oldest_read_ms=0', '[olympus] sqlite checkpoint: ledger wal_bytes=67108864 ms=1 busy=0 frames=1 checkpointed=1'];
  expect(sqliteGuards({}, padded).wal_over_1gb).toHaveLength(1);
  expect(sqliteGuards({}, padded, { fromFirstLevel: true })).toMatchObject({ wal_ok: true, wal_peak: { ledger: 67108864 } });
  expect(sqliteGuards({}, [line('internal', 2001, 'background'), line('internal', 4000, 'background')])).toMatchObject({ wal_ok: true, background_reads_over_2s: [{ label: 'internal', ms: 4000 }] });
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
