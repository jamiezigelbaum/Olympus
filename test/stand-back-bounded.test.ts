// Background work stands back for the owner's Ask with a bound, never for a
// background holder of the read-priority lease, and never silently (lane 6
// archive-scale leg, 15 Nov 2026: imports held for most of an hour).

import { describe, expect, test } from 'bun:test';
import { storeReadHasPriority, withStoreReadPriority } from '../src/core/store-reclaim-admission.ts';
import { createStandBack, ownerAskReason, STAND_BACK_MAX_MS, STAND_BACK_SHARE_MS } from '../src/workers/engine/stand-back.ts';
import { createTestClock, waitFor } from './helpers/test-clock.ts';

describe('stand-back for the owner\'s Ask', () => {
  test('a ten-minute background lease plus an owner asking every 10 s still leaves imports their share', async () => {
    let releaseLease!: () => void;
    const lease = withStoreReadPriority(() => new Promise<void>(resolve => { releaseLease = resolve; }));
    try {
      await waitFor(() => storeReadHasPriority(), { description: 'the background lease held' });
      expect(storeReadHasPriority()).toBe(true);
      let at = 0;
      // The owner's question runs 4 s of every 10 s, and once for 3 minutes straight.
      const owner = { get busy() { return at % 10_000 < 4_000 || (at >= 120_000 && at < 300_000); } };
      const lines: string[] = [];
      const standBack = createStandBack({ reason: () => ownerAskReason(owner, () => false), now: () => at, log: line => lines.push(line) });
      let ranMs = 0;
      let longestHeldMs = 0;
      let heldFor = 0;
      for (at = 0; at < 600_000; at += 1_000) {
        if (standBack.holds('import')) { heldFor += 1_000; longestHeldMs = Math.max(longestHeldMs, heldFor); }
        else { ranMs += 1_000; heldFor = 0; }
      }
      // Never held past the bound, and at least one share per bound plus share.
      expect(longestHeldMs).toBeLessThanOrEqual(STAND_BACK_MAX_MS);
      expect(ranMs).toBeGreaterThanOrEqual(Math.floor(600_000 / (STAND_BACK_MAX_MS + STAND_BACK_SHARE_MS)) * STAND_BACK_SHARE_MS);
      // The lease alone holds nothing.
      const leaseOnly = createStandBack({ reason: () => ownerAskReason({ busy: false }, () => false), now: () => at, log: () => {} });
      expect(leaseOnly.holds('import')).toBe(false);
      // Never silent: logged and counted.
      const counts = standBack.counts().import!;
      expect(counts.holds).toBeGreaterThan(0);
      expect(counts.bound_reached).toBeGreaterThan(0);
      expect(lines.some(line => line.includes('stands back'))).toBe(true);
      expect(lines.some(line => line.includes('resumes after'))).toBe(true);
      expect(lines.some(line => line.includes('before standing back again'))).toBe(true);
    } finally {
      releaseLease?.();
      await lease;
    }
  });

  test('each kind gets a full uninterrupted share every 75 s across five minutes of short idle gaps', () => {
    const clock = createTestClock(0);
    const standBack = createStandBack({
      now: clock.now, reason: () => clock.now() % 1_800 < 1_500 ? 'question in the front' : undefined, log: () => {},
    });
    const window = STAND_BACK_MAX_MS + STAND_BACK_SHARE_MS;
    for (let start = 0; start < 300_000; start += window) {
      const kinds = ['import', 'embed', 'judge', 'digest', 'status'] as const;
      const run = new Map<string, number>();
      const longest = new Map<string, number>();
      for (let at = start; at < start + window; at += 100) {
        clock.set(at);
        for (const kind of kinds) {
          const duration = standBack.holds(kind) ? 0 : (run.get(kind) ?? 0) + 100;
          run.set(kind, duration);
          longest.set(kind, Math.max(longest.get(kind) ?? 0, duration));
        }
      }
      for (const kind of kinds) expect(longest.get(kind)).toBeGreaterThanOrEqual(STAND_BACK_SHARE_MS);
    }
  });

  test('idle resumes immediately and a full idle share gives the next Ask its full bound', () => {
    const clock = createTestClock(0);
    let busy = false;
    const standBack = createStandBack({ now: clock.now, reason: () => busy ? 'question in the front' : undefined, log: () => {} });
    expect(standBack.holds('judge')).toBe(false);
    busy = true;
    expect(standBack.holds('judge')).toBe(true);
    clock.set(STAND_BACK_MAX_MS - 1);
    busy = false;
    expect(standBack.holds('judge')).toBe(false);
    expect(standBack.counts().judge).toMatchObject({ holding: false, held_ms: STAND_BACK_MAX_MS - 1 });
    const nextAsk = clock.now() + STAND_BACK_SHARE_MS;
    clock.set(nextAsk);
    busy = true;
    expect(standBack.holds('judge')).toBe(true);
    clock.set(nextAsk + STAND_BACK_MAX_MS - 1);
    expect(standBack.holds('judge')).toBe(true);
    clock.set(nextAsk + STAND_BACK_MAX_MS);
    expect(standBack.holds('judge')).toBe(false);
    expect(standBack.counts().judge).toMatchObject({ holds: 2, bound_reached: 1 });
  });

  test('each kind of work keeps its own bound', () => {
    let at = 0;
    const standBack = createStandBack({ reason: () => 'question in the front', now: () => at, log: () => {} });
    expect(standBack.holds('judge')).toBe(true);
    at = STAND_BACK_MAX_MS - 1_000;
    expect(standBack.holds('embed')).toBe(true);
    at = STAND_BACK_MAX_MS;
    expect(standBack.holds('judge')).toBe(false);
    expect(standBack.holds('embed')).toBe(true);
  });
});
