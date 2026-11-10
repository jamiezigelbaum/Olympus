import { describe, expect, test } from 'bun:test';
import { createTestClock, waitFor } from './helpers/test-clock.ts';

describe('shared test clock', () => {
  test('advance fires due timers in order and lets their promise chains run', async () => {
    const clock = createTestClock(1_000);
    const seen: string[] = [];
    const chain = (async () => {
      await clock.sleep(30_000);
      seen.push(`first at ${clock.now()}`);
      await clock.sleep(60_000);
      seen.push(`second at ${clock.now()}`);
    })();
    clock.setTimeout(() => seen.push(`timer at ${clock.now()}`), 45_000);

    await clock.advance(29_999);
    expect(seen).toEqual([]);
    await clock.advance(90_001);
    await chain;
    expect(seen).toEqual(['first at 31000', 'timer at 46000', 'second at 91000']);
    expect(clock.now()).toBe(121_000);
    expect(clock.pendingTimers()).toBe(0);
  });

  test('cleared timers never fire and advanceToNext jumps to the next one', async () => {
    const clock = createTestClock(0);
    const fired: number[] = [];
    const cancelled = clock.setTimeout(() => fired.push(1), 10);
    clock.setTimeout(() => fired.push(2), 500).unref();
    clock.clearTimeout(cancelled);
    expect(await clock.advanceToNext()).toBe(true);
    expect(fired).toEqual([2]);
    expect(clock.now()).toBe(500);
    expect(await clock.advanceToNext()).toBe(false);
    expect(clock.date().toISOString()).toBe('1970-01-01T00:00:00.500Z');
  });
});

test('an interval repeats on fake time until cleared, even from its own callback', async () => {
  const clock = createTestClock(0);
  const ticks: number[] = [];
  const interval = clock.setInterval(() => {
    ticks.push(clock.now());
    if (ticks.length === 3) clock.clearInterval(interval);
  }, 1_000);
  await clock.advance(10_000);
  expect(ticks).toEqual([1_000, 2_000, 3_000]);
  expect(clock.pendingTimers()).toBe(0);
});

describe('waitFor', () => {
  test('returns the first truthy value without a fixed sleep', async () => {
    let checks = 0;
    const value = await waitFor(() => { checks += 1; return checks >= 3 ? { ready: true } : undefined; }, { intervalMs: 1 });
    expect(value).toEqual({ ready: true });
    expect(checks).toBe(3);
  });

  test('fails with the description and the last error once the ceiling passes', async () => {
    await expect(waitFor(() => { throw new Error('still reading'); }, { timeoutMs: 20, intervalMs: 5, description: 'the questions step' }))
      .rejects.toThrow('waitFor: the questions step did not hold within 20 ms (last error: still reading)');
  });

  test('a check that never settles still fails at the ceiling', async () => {
    await expect(waitFor(() => new Promise<boolean>(() => {}), { timeoutMs: 20, description: 'a reply that never comes' }))
      .rejects.toThrow('waitFor: a reply that never comes did not hold within 20 ms (the last check was still running)');
  });
});
