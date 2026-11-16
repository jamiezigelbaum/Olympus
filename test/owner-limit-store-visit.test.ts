import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withOwnerLimitStore } from '../src/core/owner-limit-state.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import { registerLimit } from '../src/core/limit-stops.ts';

registerLimit({ id: 'test.visit_a', kind: 'calls', scope: 'judge', label: 'Test stop A', unit: 'calls', continue: 'raise' });
registerLimit({ id: 'test.visit_b', kind: 'calls', scope: 'judge', label: 'Test stop B', unit: 'calls', continue: 'raise' });

// The front reports and clears limit stops on its own loop, in a file the
// background's scheduler writes. Its visit must not wait on the scheduler's
// write lock for work that is the scheduler's (the backfill, the closing
// checkpoint), and must not fail on it.
test('a limit-stop visit reads while another process holds the write lock, and leaves the checkpoint to the owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-limit-visit-'));
  const dbPath = join(dir, 'scheduler.sqlite');
  const owner = new LocalSourceSchedulerStateStore(dbPath);
  const writer = new Database(dbPath);
  try {
    owner.reportLimitStop({ id: 'test.visit_a', subject: 'judge', since: '2026-11-16T00:00:00.000Z', limit: 1, used: 1 });
    writer.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
    const started = performance.now();
    const stops = withOwnerLimitStore(store => store.openLimitStops(), dbPath);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(stops.map(stop => stop.id)).toEqual(['test.visit_a']);
    writer.exec('COMMIT;');
    // The visit's own write lands, and its close leaves the WAL as it is.
    withOwnerLimitStore(store => store.reportLimitStop({ id: 'test.visit_b', subject: 'judge', since: '2026-11-16T00:00:00.000Z', limit: 1, used: 1 }), dbPath);
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    expect(owner.openLimitStops().map(stop => stop.id).sort()).toEqual(['test.visit_a', 'test.visit_b']);
  } finally {
    writer.close();
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
