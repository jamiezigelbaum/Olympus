// Preloaded into a `bun test` run by test/loop-sql-finders-guard.test.ts:
// records every finder (a statement whose plan scans a large table) the run's
// main thread executes, and writes them to LOOP_SQL_PLAN_OUT after the run
// (not an OLYMPUS_ name: the isolated-home preload clears those).

import { afterAll } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { startMainThreadSqlPlanRecording } from '../../src/workers/connector-store/main-thread-sql-trace.ts';

const out = process.env.LOOP_SQL_PLAN_OUT;
if (out) {
  const recording = startMainThreadSqlPlanRecording();
  // A hook in a preload runs once, after every file's tests.
  afterAll(() => {
    writeFileSync(out, JSON.stringify(recording.stop(), null, 2));
  });
}
