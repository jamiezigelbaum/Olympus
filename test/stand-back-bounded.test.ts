// Background work stands back for the owner's Ask with a bound, never for a
// background holder of the read-priority lease, and never silently (lane 6
// archive-scale leg, 15 Nov 2026: imports held for most of an hour).

import { describe, expect, test } from 'bun:test';
import { storeReadHasPriority, withStoreReadPriority } from '../src/core/store-reclaim-admission.ts';
import { createStandBack, ownerAskReason, STAND_BACK_MAX_MS, STAND_BACK_SHARE_MS } from '../src/workers/engine/stand-back.ts';
import { waitFor } from './helpers/test-clock.ts';

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

test('a pending unit keeps its deadline when it misses a share opened by another unit', () => {
  let at = 0;
  const gate = createStandBack({ now: () => at, reason: () => 'question in the front', log: () => {} });
  expect(gate.holds('status', 'snapshot')).toBe(true);
  at = 1;
  expect(gate.holds('status', 'store')).toBe(true);
  expect(gate.holds('status', 'store')).toBe(true);
  expect(gate.counts().status).toMatchObject({ holds: 2, held_count: 2, wait_reason: 'owner_ask' });
  at = STAND_BACK_MAX_MS;
  expect(gate.holds('status', 'snapshot')).toBe(false);
  at += STAND_BACK_SHARE_MS;
  expect(gate.holds('status', 'snapshot')).toBe(true);
  expect(gate.holds('status', 'store')).toBe(false);
  expect(gate.counts().status).toMatchObject({ holds: 3, held_count: 1, bound_reached: 2, held_ms: at });
  gate.clear('status', 'snapshot');
  expect(gate.counts().status).toMatchObject({ holding: false, held_count: 0 });
  expect(gate.counts().status?.wait_reason).toBeUndefined();
});

test('a pending physical reclaim is counted and can only start at idle', () => {
  let at = 0;
  let busy = true;
  const gate = createStandBack({ now: () => at, reason: () => busy ? 'question in the front' : undefined, log: () => {} });
  expect(gate.holds('reclaim', 'store')).toBe(true);
  at += STAND_BACK_MAX_MS;
  expect(gate.holds('reclaim', 'store')).toBe(true);
  expect(gate.counts().reclaim).toMatchObject({ holds: 1, held_count: 1, bound_reached: 0 });
  busy = false;
  expect(gate.holds('reclaim', 'store')).toBe(false);
  expect(gate.counts().reclaim).toMatchObject({ held_count: 0, held_ms: at });
});
