// Preloaded into a `bun test` run by test/pool-sql-finders-guard.test.ts:
// asks SQLite's plan of every distinct statement read on a store's read
// workers inside a snapshot (the background lane's finders, and the shared
// lane's snapshot reads), and writes each scan of a large table to
// POOL_SQL_PLAN_OUT after the run, by lane and the function that opened the
// snapshot.

import { afterAll } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { setReadPoolObserverForTests } from '../../src/workers/connector-store/off-thread-reads.ts';
import { LOOP_SQL_LARGE_TABLES, largeTableScans } from '../../src/workers/connector-store/main-thread-sql-trace.ts';

export interface PoolSqlFinder { lane: string; site: string; table: string; plan: string; sql: string }

const out = process.env.POOL_SQL_PLAN_OUT;
if (out) {
  const large = new Set(LOOP_SQL_LARGE_TABLES);
  const plans = new Map<string, Array<{ table: string; plan: string }>>();
  const finders = new Map<string, PoolSqlFinder>();
  setReadPoolObserverForTests((dbPath, read, seen) => {
    // A test's own read (the snapshot opened from a test file) is not the engine's.
    if (!seen || /^(?:<anonymous>|[\w.$]+)@[\w.-]+\.test\.ts/.test(seen.site)) return;
    const key = `${dbPath}\u0000${read.sql}`;
    let scans = plans.get(key);
    if (!scans) {
      scans = [];
      try {
        const db = new Database(dbPath, { readonly: true });
        try { scans = largeTableScans(db, read.sql, large); } finally { db.close(); }
      } catch { /* the file went away: nothing to plan */ }
      plans.set(key, scans);
    }
    // Line numbers move with every edit; the function and file name the site.
    const site = seen.site.replace(/:\d+/g, '');
    for (const scan of scans) {
      const id = `${seen.lane}|${site}|${scan.table}`;
      if (!finders.has(id)) finders.set(id, { lane: seen.lane, site, ...scan, sql: read.sql.replace(/\s+/g, ' ').trim().slice(0, 160) });
    }
  }, { snapshots: true });
  // A hook in a preload runs once, after every file's tests.
  afterAll(() => {
    writeFileSync(out, JSON.stringify([...finders.values()].sort((a, b) => `${a.lane}|${a.site}|${a.table}`.localeCompare(`${b.lane}|${b.site}|${b.table}`)), null, 2));
  });
}
