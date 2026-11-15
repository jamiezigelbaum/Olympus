/** Cold engine-loop regression gate; only the Sparta release runner seeds it. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { gate } from '../scripts/loop-stall-test.ts';
import { join } from 'node:path';
import { waitFor } from './helpers/test-clock.ts';

const enabled = process.env.CJ_JOB === 'test-focus';
const script = join(import.meta.dir, '../scripts/loop-stall-test.ts');
const dir = join(userInfo().homedir, 'olympus-prof/loop-stall');
function invoke(args: string[], timeout = 10 * 60_000) {
  const result = spawnSync(args[0]!, args.slice(1), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (result.error) throw result.error;
  return result.status;
}
test.skipIf(!enabled)('cold split engine stays within loop and main-thread SQLite budgets', () => {
  expect(invoke(['bun', script, 'build', '--dir', dir], 60 * 60_000)).toBe(0);
  expect(invoke(['systemd-run', '--user', '--scope', '--quiet', '-p', 'MemoryMax=2G', '-p', 'MemorySwapMax=0', '--', 'bun', script, 'run', '--dir', dir, '--seconds', '300'])).toBe(0);
}, 70 * 60_000);

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
