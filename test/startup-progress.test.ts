import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginStartupProgress, startupProgress, startupWaitingLine } from '../src/core/startup-progress.ts';
import { createTestClock } from './helpers/test-clock.ts';

test('startup reports aggregate progress and estimates remaining work by database size', async () => {
  const dir = mkdtempSync('/tmp/olympus-startup-');
  const small = join(dir, 'small.db');
  const large = join(dir, 'large.db');
  writeFileSync(small, Buffer.alloc(1_000));
  writeFileSync(large, Buffer.alloc(6_000));
  const clock = createTestClock();
  const startedAt = clock.now();
  const progress = beginStartupProgress([small, large], clock.now);
  try {
    expect(startupProgress()).toEqual({ stores_done: 0, stores_total: 2 });
    expect(startupWaitingLine(startupProgress(), clock.now())).toContain('0 of 2 sources ready)');
    await clock.advance(30_000);
    progress.storeReady(0);
    expect(startupProgress()).toEqual({
      stores_done: 1,
      stores_total: 2,
      estimated_ready_at: new Date(startedAt + 210_000).toISOString(),
    });
    expect(startupWaitingLine(startupProgress(), clock.now())).toBe(
      'Olympus is still starting (1 of 2 sources ready, about 3 min left). Your answer will arrive by itself.',
    );
    // Past the estimate the line says so and promises nothing.
    await clock.advance(400_000);
    expect(startupWaitingLine(startupProgress(), clock.now())).toBe(
      'Olympus is still starting (1 of 2 sources ready, taking longer than estimated and still working). Your answer will arrive by itself.',
    );
  } finally {
    progress.finish();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(startupProgress()).toBeUndefined();
});

test('a missing database still counts, and an empty build has no waiting line', () => {
  const empty = beginStartupProgress([]);
  expect(startupProgress()).toBeUndefined();
  empty.finish();
  const progress = beginStartupProgress(['/tmp/olympus-missing-startup-store.db']);
  try {
    expect(startupProgress()).toEqual({ stores_done: 0, stores_total: 1 });
  } finally {
    progress.finish();
  }
  expect(startupWaitingLine(startupProgress())).toBe('');
});
