// The loop-thread rule (loop-stall step-back, 15 Nov 2026): on a loop thread a
// statement only writes, or reads by key with a bounded row count. Anything
// whose plan scans a large table is a finder, and finders belong on the
// store's read worker, which hands the writer ids.
//
// This runs the background's workload tests with every main-thread statement's
// plan recorded (SQLite's EXPLAIN QUERY PLAN, once per distinct text), and
// holds the finders it sees equal to the allowlist: a new finder on the loop
// fails with its call site, and a finder that has moved off it must leave the
// list, so the list only shrinks. To rewrite the list after moving one:
//   LOOP_SQL_PLAN_WRITE=1 bun test test/loop-sql-finders-guard.test.ts

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  slowMainThreadSqlHealth, startSlowMainThreadSqlLog, stopSlowMainThreadSqlLog, type LoopSqlFinder,
} from '../src/workers/connector-store/main-thread-sql-trace.ts';

const ROOT = resolve(import.meta.dir, '..');
const ALLOWLIST = join(ROOT, 'test/fixtures/loop-sql-finders-allowlist.json');

/** The background's work: sync, embed, judge and settle, visibility, the status recount. */
export const LOOP_WORKLOAD_TESTS = [
  'test/background-loop-named-calls.test.ts',
  'test/status-snapshot-never-waits.test.ts',
  'test/source-index-status-readiness-cache.test.ts',
  'test/store-totals-drift.test.ts',
  'test/embedding-hidden-set-in-turns.test.ts',
  'test/hidden-child-incremental.test.ts',
  'test/tier-visibility-incremental.test.ts',
  'test/tier-ledger-cleared-override-paging.test.ts',
  'test/tier-sniffer-recovery.test.ts',
  'test/tier-sniffer-unread-not-missing.test.ts',
  'test/sniffer-new-arrivals.test.ts',
  'test/unreadable-files.test.ts',
] as const;

interface AllowlistEntry { site: string; table: string; reason: string }

describe('finders on the loop thread', () => {
  test('are exactly the allowlisted ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-sql-plan-'));
    try {
      const out = join(dir, 'finders.json');
      const run = Bun.spawnSync(['bun', 'test', '--preload', './test/helpers/loop-sql-plan-preload.ts', ...LOOP_WORKLOAD_TESTS], {
        cwd: ROOT,
        env: { ...process.env, LOOP_SQL_PLAN_OUT: out, HOME: dir },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(run.exitCode, `the workload tests failed:\n${run.stderr.toString().slice(-4000)}`).toBe(0);
      const seen = JSON.parse(readFileSync(out, 'utf8')) as LoopSqlFinder[];
      const key = (entry: { site: string; table: string }) => `${entry.site} | ${entry.table}`;
      if (process.env.LOOP_SQL_PLAN_WRITE === '1') {
        const previous = new Map((readAllowlist()).map((entry) => [key(entry), entry.reason]));
        writeFileSync(ALLOWLIST, `${JSON.stringify({
          note: 'Finders still on a loop thread (test/loop-sql-finders-guard.test.ts). Shrink only: move one to the read worker, then rewrite.',
          entries: seen.map((finder) => ({ site: finder.site, table: finder.table, reason: previous.get(key(finder)) ?? `to move to the read worker (${finder.plan}: ${finder.sql})` })),
        }, null, 2)}\n`);
        return;
      }
      const allowed = new Set(readAllowlist().map(key));
      const found = new Set(seen.map(key));
      const added = seen.filter((finder) => !allowed.has(key(finder))).map((finder) => `${key(finder)}: ${finder.plan} in ${finder.sql}`);
      const moved = [...allowed].filter((entry) => !found.has(entry));
      expect(added, 'a new scan of a large table on the loop thread: find it on the read worker instead').toEqual([]);
      expect(moved, 'no longer on the loop thread: take it off the allowlist').toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 600_000);
});

function readAllowlist(): AllowlistEntry[] {
  try { return (JSON.parse(readFileSync(ALLOWLIST, 'utf8')) as { entries: AllowlistEntry[] }).entries; } catch { return []; }
}

describe('the slow-statement log', () => {
  test('names a statement that held the loop past the threshold, by call site, and counts it for health', () => {
    const lines: string[] = [];
    startSlowMainThreadSqlLog(5, (line) => lines.push(line));
    const db = new Database(':memory:');
    try {
      function countToMillions() {
        const row = db.query('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000000) SELECT COUNT(*) AS c FROM n').get();
        return row;
      }
      countToMillions();
      db.query('SELECT 1').get();
      const health = slowMainThreadSqlHealth()!;
      expect(health.count).toBe(1);
      expect(health.max_ms).toBeGreaterThanOrEqual(5);
      expect(health.recent[0]!.site).toContain('loop-sql-finders-guard.test.ts');
      expect(lines[0]).toMatch(/^\[olympus\] slow loop sql: \d+ ms at .*loop-sql-finders-guard\.test\.ts/);
      // The text itself never reaches the log: only a short id.
      expect(lines[0]).not.toContain('RECURSIVE');
    } finally { db.close(); stopSlowMainThreadSqlLog(); }
  });
});
