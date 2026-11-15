/**
 * Vector-lane timing on a 200k-chunk synthetic store, under a memory cap below the store's size (olympus-ops#151).
 * A measurement, not a check: it runs only as a cloud-job test-focus on the release runner (CJ_JOB=test-focus), where
 * the store lives on disk under ~/olympus-prof and systemd can cap the measuring process. Everywhere else it skips.
 * scripts/vector-lane-timing.ts has the store's shape and the pass rule (under 3 s, no deadline cut).
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const enabled = process.env.CJ_JOB === 'test-focus';
const CHUNKS = Number(process.env.VLT_CHUNKS ?? 200_000);
const dir = join(userInfo().homedir, 'olympus-prof', 'vector-lane-timing', `c${CHUNKS}`);
const script = join(import.meta.dir, '..', 'scripts', 'vector-lane-timing.ts');

function run(command: string[], label: string): string {
  const result = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${out.slice(-2000)}`);
  return out;
}

test.skipIf(!enabled)('vector lane on a 200k-chunk store with Dropbox\'s held and out-of-scope share, pages from disk', () => {
  console.log(run(['bun', script, 'build', '--dir', dir, '--chunks', String(CHUNKS), '--dimension', '768'], 'build').trim());
  const bytes = statSync(join(dir, 'store.sqlite')).size;
  // Below the store's size, so the scan cannot keep it in page cache and reads come from disk.
  const capMb = Math.max(512, Math.floor(bytes / 1024 / 1024 / 2));
  const lines: string[] = [];
  let failed = 0;
  // The four shapes alone, then Dropbox's shape (both) with the load lane 2 suspects: keyword searches sharing the
  // store's one read-pool thread, a writer committing judged batches, and the two together.
  const runs: Array<[string, string]> = [['none', ''], ['held', ''], ['scope', ''], ['both', ''], ['both', 'keyword'], ['both', 'writer'], ['both', 'keyword,writer'],
    // The owner's folder scope (lane 2, 15 Nov): the shape that cut the live lane at 54 s.
    ['folders', ''], ['folders-held', ''], ['folders-held', 'keyword,writer']];
  for (const [scenario, contend] of runs) {
    // Drop the file's cached pages first: the build (or the last scenario) left them in memory.
    for (const suffix of ['', '-wal']) spawnSync('dd', [`if=${join(dir, `store.sqlite${suffix}`)}`, 'iflag=nocache', 'count=0', 'status=none']);
    const out = run(['systemd-run', '--user', '--scope', '--quiet', '-p', `MemoryMax=${capMb}M`, '-p', 'MemorySwapMax=0', '--',
      'bun', script, 'measure', '--dir', dir, '--scenario', scenario, '--trials', '5', ...(contend ? ['--contend', contend] : [])], `measure ${scenario} ${contend}`);
    const line = out.trim().split('\n').filter((l) => l.startsWith('{"phase":"measure"')).at(-1);
    if (!line) throw new Error(`measure ${scenario} ${contend} printed no result: ${out.slice(-2000)}`);
    const parsed = JSON.parse(line) as { pass: boolean };
    if (!parsed.pass) failed += 1;
    lines.push(line);
  }
  console.log(`vector-lane-timing: store ${Math.round(bytes / 1024 / 1024)} MB, measured under MemoryMax=${capMb}M, MemorySwapMax=0`);
  for (const line of lines) console.log(`vector-lane-timing: ${line}`);
  expect(failed).toBe(0);
}, 3 * 60 * 60_000);
