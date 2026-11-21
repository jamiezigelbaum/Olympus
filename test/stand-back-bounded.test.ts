// Background work stands back for the owner's Ask with a bound, never for a
// background holder of the read-priority lease, and never silently (lane 6
// archive-scale leg, 15 Nov 2026: imports held for most of an hour).

import { describe, expect, test } from 'bun:test';
import { storeReadHasPriority, withStoreReadPriority } from '../src/core/store-reclaim-admission.ts';
import { createStandBack, ownerAskReason, ownerIdleWindow, STAND_BACK_MAX_MS, STAND_BACK_SHARE_MS } from '../src/workers/engine/stand-back.ts';
import { createOwnerQuestionActivity, OWNER_QUESTION_RESOURCE } from '../src/workers/engine/runtime/source-answer-lanes.ts';
import { OwnerBusyMarks } from '../src/workers/engine-split/runtime.ts';
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

  for (const source of ['local', 'front']) test(`16 s worker checks get a share during 1.5 s busy / 0.3 s idle (${source} Ask)`, () => {
    const clock = createTestClock(0);
    const local = createOwnerQuestionActivity(undefined, clock.now);
    const front = new OwnerBusyMarks({ now: clock.now });
    const resource = OWNER_QUESTION_RESOURCE;
    const standBack = createStandBack({
      now: clock.now, reason: () => ownerAskReason(local, () => front.busy(resource)),
      idleWindow: () => ownerIdleWindow(local, front.busySince(resource), front.lastEndedAt(resource)),
      log: () => {},
    });
    let release: (() => void) | undefined;
    const turns: string[] = [];
    for (let at = 0; at <= STAND_BACK_MAX_MS + STAND_BACK_SHARE_MS; at += 100) {
      clock.set(at);
      if (at % 1_800 === 0) {
        if (source === 'local') release = local.begin();
        else front.apply({ kind: 'owner_busy', resource, front: 'front', seq: at });
      } else if (at % 1_800 === 1_500) {
        if (source === 'local') release!();
        else front.apply({ kind: 'owner_idle', resource, front: 'front', seq: at });
      }
      if (at % 16_000 === 0) turns.push(standBack.turn('import'));
    }
    expect(turns).toEqual(['hold', 'idle', 'hold', 'hold', 'share']);
    release?.();
  });

  test('idle resumes immediately and a full idle share gives the next Ask its full bound', () => {
    const clock = createTestClock(0);
    const owner = createOwnerQuestionActivity(undefined, clock.now);
    const standBack = createStandBack({ now: clock.now, reason: () => ownerAskReason(owner, () => false),
      idleWindow: () => ownerIdleWindow(owner, undefined, undefined), log: () => {} });
    expect(standBack.holds('judge')).toBe(false);
    const release = owner.begin();
    expect(standBack.holds('judge')).toBe(true);
    clock.set(STAND_BACK_MAX_MS - 1);
    release();
    expect(standBack.holds('judge')).toBe(false);
    expect(standBack.counts().judge).toMatchObject({ holding: false, held_ms: STAND_BACK_MAX_MS - 1 });
    const nextAsk = clock.now() + STAND_BACK_SHARE_MS;
    clock.set(nextAsk);
    const releaseNext = owner.begin();
    expect(standBack.holds('judge')).toBe(true);
    clock.set(nextAsk + STAND_BACK_MAX_MS - 1);
    expect(standBack.holds('judge')).toBe(true);
    clock.set(nextAsk + STAND_BACK_MAX_MS);
    expect(standBack.holds('judge')).toBe(false);
    expect(standBack.counts().judge).toMatchObject({ holds: 2, bound_reached: 1 });
    releaseNext();
  });

  test('overlapping Asks and a renewed front lease give no idle credit until the last Ask ends', () => {
    const clock = createTestClock(0);
    const local = createOwnerQuestionActivity(undefined, clock.now);
    const front = new OwnerBusyMarks({ now: clock.now, lapseMs: STAND_BACK_MAX_MS });
    const resource = OWNER_QUESTION_RESOURCE;
    const window = () => ownerIdleWindow(local, front.busySince(resource), front.lastEndedAt(resource));
    const release = local.begin();
    clock.set(1_000);
    front.apply({ kind: 'owner_busy', resource, front: 'front', seq: 1 });
    clock.set(2_000);
    release();
    clock.set(STAND_BACK_MAX_MS);
    front.apply({ kind: 'owner_busy', resource, front: 'front', seq: 2 });
    expect(window().until).toBeLessThan(window().since);
    clock.set(2 * STAND_BACK_MAX_MS + STAND_BACK_SHARE_MS);
    front.apply({ kind: 'owner_busy', resource, front: 'front', seq: 3 });
    expect(window()).toEqual({ since: 2 * STAND_BACK_MAX_MS, until: clock.now() });
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
