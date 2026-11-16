// The read-worker rule (plan thread, 16 Nov 2026): a finder never scans a
// table to find work. Each page is a seek: keyset paging on an index, a
// partial index over the rows that need work, or a queue table. A read on a
// store's read worker that SCANs a large table holds a read transaction for
// as long as the scan takes, and no checkpoint can reset the WAL meanwhile.
//
// This runs the background's workload tests with every snapshot read's plan
// recorded (SQLite's EXPLAIN QUERY PLAN, once per distinct text), and holds
// the scans it sees equal to the allowlist: a new scan fails with its lane and
// call site, and one that has become a seek must leave the list, so the list
// only shrinks. To rewrite the list after turning one into a seek:
//   POOL_SQL_PLAN_WRITE=1 bun test test/pool-sql-finders-guard.test.ts

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BACKGROUND_WORKLOAD_TESTS } from './helpers/background-workload-tests.ts';
import type { PoolSqlFinder } from './helpers/pool-sql-plan-preload.ts';

const ROOT = resolve(import.meta.dir, '..');
const ALLOWLIST = join(ROOT, 'test/fixtures/pool-sql-finders-allowlist.json');

interface AllowlistEntry { lane: string; site: string; table: string; reason: string }
const key = (entry: { lane: string; site: string; table: string }) => `${entry.lane} | ${entry.site} | ${entry.table}`;

describe('scans on the read workers', () => {
  test('are exactly the allowlisted ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pool-sql-plan-'));
    try {
      const out = join(dir, 'finders.json');
      const run = Bun.spawnSync(['bun', 'test', '--preload', './test/helpers/pool-sql-plan-preload.ts', ...BACKGROUND_WORKLOAD_TESTS], {
        cwd: ROOT,
        env: { ...process.env, POOL_SQL_PLAN_OUT: out, HOME: dir },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(run.exitCode, `the workload tests failed:\n${run.stderr.toString().slice(-4000)}`).toBe(0);
      const seen = JSON.parse(readFileSync(out, 'utf8')) as PoolSqlFinder[];
      if (process.env.POOL_SQL_PLAN_WRITE === '1') {
        const previous = new Map(readAllowlist().map((entry) => [key(entry), entry.reason]));
        writeFileSync(ALLOWLIST, `${JSON.stringify({
          note: 'Scans still on a store\'s read workers (test/pool-sql-finders-guard.test.ts). Shrink only: make one a seek, then rewrite.',
          entries: seen.map((finder) => ({ lane: finder.lane, site: finder.site, table: finder.table, reason: previous.get(key(finder)) ?? `to page by key (${finder.plan}: ${finder.sql})` })),
        }, null, 2)}\n`);
        return;
      }
      const allowed = new Set(readAllowlist().map(key));
      const found = new Set(seen.map(key));
      const added = seen.filter((finder) => !allowed.has(key(finder))).map((finder) => `${key(finder)}: ${finder.plan} in ${finder.sql}`);
      const moved = [...allowed].filter((entry) => !found.has(entry));
      expect(added, 'a new scan of a large table on a read worker: page it by key instead').toEqual([]);
      expect(moved, 'no longer a scan: take it off the allowlist').toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 600_000);
});

function readAllowlist(): AllowlistEntry[] {
  try { return (JSON.parse(readFileSync(ALLOWLIST, 'utf8')) as { entries: AllowlistEntry[] }).entries; } catch { return []; }
}
