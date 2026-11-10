/**
 * The shared test clock and `waitFor` (#1066).
 *
 * Tests must not wait on the real clock. A test that sleeps 475 ms and then
 * asserts passes on a quiet laptop and fails on a loaded CI shard, which is
 * where most of the flaky-test issues came from. Two tools replace the sleep:
 *
 * - `createTestClock()` for code that takes a time seam (`now`, `sleep`,
 *   `setTimeoutImpl`, `schedule`). The test moves time forward with
 *   `advance(ms)`; nothing waits on the wall clock, so a busy machine cannot
 *   change the outcome.
 * - `waitFor(condition)` for the cases that really are asynchronous (a worker,
 *   a subprocess, a page). It checks the condition until it holds, with a
 *   generous ceiling, instead of guessing how long the work takes.
 *
 * `test/raw-sleep-guard.test.ts` rejects new raw sleeps in `test/`; this file
 * is the one place allowed to touch real timers, because `waitFor` has to.
 */

export interface TestClock {
  /** Current fake time in epoch milliseconds. Pass as a `now: () => number` seam. */
  now(): number;
  /** Current fake time as a Date. Pass as a `now: () => Date` seam. */
  date(): Date;
  /** Resolves when the fake clock reaches now + ms. Pass as a `sleep` seam. */
  sleep(ms: number): Promise<void>;
  /** Calls `callback` when the fake clock reaches now + ms. Pass as a `setTimeout` seam. */
  setTimeout(callback: () => void, ms?: number): TestTimer;
  /** Cancels a timer from `setTimeout`. Pass as a `clearTimeout` seam. */
  clearTimeout(timer: TestTimer | undefined): void;
  /** Calls `callback` every `ms` of fake time until cleared. Pass as a `setInterval` seam. */
  setInterval(callback: () => void, ms?: number): TestTimer;
  /** Cancels a timer from `setInterval`. Pass as a `clearInterval` seam. */
  clearInterval(timer: TestTimer | undefined): void;
  /**
   * Moves time forward by `ms`, firing every timer that falls due in order of
   * its due time. Promise callbacks queued by each timer run before the next
   * one fires, so a chain like `await sleep(30_000); await sleep(60_000)`
   * completes within one `advance(90_000)`.
   */
  advance(ms: number): Promise<void>;
  /** Moves time to the next pending timer and fires it. Returns false when none is pending. */
  advanceToNext(): Promise<boolean>;
  /** Sets the time without firing anything, for tests that only read `now()`. */
  set(epochMs: number): void;
  /** Number of timers that have not fired or been cancelled. */
  pendingTimers(): number;
}

export interface TestTimer {
  readonly id: number;
  readonly dueAt: number;
  /** Mirrors Node's Timeout so code that calls `unref()` still works. */
  unref(): TestTimer;
  ref(): TestTimer;
  hasRef(): boolean;
}

interface Scheduled {
  timer: TestTimer;
  callback: () => void;
  order: number;
  /** Set for an interval: the gap before it fires again. */
  every?: number;
}

export const DEFAULT_TEST_CLOCK_START = Date.UTC(2026, 0, 1, 12, 0, 0);

/** Lets every promise callback that is already queued run before the next step. */
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
}

export function createTestClock(startMs: number = DEFAULT_TEST_CLOCK_START): TestClock {
  let current = startMs;
  let nextId = 1;
  let order = 0;
  const scheduled = new Map<number, Scheduled>();

  const makeTimer = (dueAt: number, id = nextId++): TestTimer => {
    let referenced = true;
    const timer: TestTimer = {
      id,
      dueAt,
      unref: () => { referenced = false; return timer; },
      ref: () => { referenced = true; return timer; },
      hasRef: () => referenced,
    };
    return timer;
  };

  const due = (limit: number): Scheduled | undefined => {
    let earliest: Scheduled | undefined;
    for (const entry of scheduled.values()) {
      if (entry.timer.dueAt > limit) continue;
      if (!earliest
        || entry.timer.dueAt < earliest.timer.dueAt
        || (entry.timer.dueAt === earliest.timer.dueAt && entry.order < earliest.order)) {
        earliest = entry;
      }
    }
    return earliest;
  };

  const fire = async (entry: Scheduled): Promise<void> => {
    scheduled.delete(entry.timer.id);
    current = Math.max(current, entry.timer.dueAt);
    if (entry.every !== undefined) {
      // Same id, so clearInterval from inside the callback still cancels it.
      order += 1;
      const next = makeTimer(current + entry.every, entry.timer.id);
      if (!entry.timer.hasRef()) next.unref();
      scheduled.set(next.id, { ...entry, timer: next, order });
    }
    entry.callback();
    await flushMicrotasks();
  };

  const clock: TestClock = {
    now: () => current,
    date: () => new Date(current),
    sleep: (ms) => new Promise<void>((resolveSleep) => {
      clock.setTimeout(resolveSleep, ms);
    }),
    setTimeout: (callback, ms = 0) => {
      const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
      const timer = makeTimer(current + delay);
      order += 1;
      scheduled.set(timer.id, { timer, callback, order });
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) scheduled.delete(timer.id);
    },
    setInterval: (callback, ms = 0) => {
      // A zero interval would never let time move; real timers clamp it too.
      const every = Number.isFinite(ms) && ms >= 1 ? ms : 1;
      const timer = makeTimer(current + every);
      order += 1;
      scheduled.set(timer.id, { timer, callback, order, every });
      return timer;
    },
    clearInterval: (timer) => {
      if (timer) scheduled.delete(timer.id);
    },
    advance: async (ms) => {
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`advance needs a non-negative duration, got ${ms}`);
      const target = current + ms;
      await flushMicrotasks();
      for (let entry = due(target); entry; entry = due(target)) await fire(entry);
      current = target;
      await flushMicrotasks();
    },
    advanceToNext: async () => {
      await flushMicrotasks();
      const entry = due(Number.POSITIVE_INFINITY);
      if (!entry) return false;
      await fire(entry);
      return true;
    },
    set: (epochMs) => { current = epochMs; },
    pendingTimers: () => scheduled.size,
  };
  return clock;
}

export interface WaitForOptions {
  /** Ceiling before the wait fails. Generous on purpose: it is a hang detector, not a budget. */
  timeoutMs?: number;
  /** Gap between checks. */
  intervalMs?: number;
  /** Named in the failure so the test output says what never happened. */
  description?: string;
}

export const WAIT_FOR_DEFAULT_TIMEOUT_MS = 20_000;

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const EXPIRED: unique symbol = Symbol('waitFor expired');

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolvePause) => { realSetTimeout(resolvePause, ms); });
}

/**
 * Waits until `condition` returns a truthy value (or a promise of one) and
 * returns that value. Throws with the description and the last error if the
 * ceiling passes first. An exception from `condition` counts as "not yet".
 */
export async function waitFor<T>(
  condition: () => T | Promise<T>,
  options: WaitForOptions = {},
): Promise<NonNullable<T>> {
  const timeoutMs = options.timeoutMs ?? WAIT_FOR_DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  let lastValue: unknown;
  let expired = false;
  for (;;) {
    // A check that never settles (a reply that never comes) must not outlast
    // the ceiling, and a value that arrives after it does not count.
    const remaining = Math.max(0, deadline - performance.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ceiling = new Promise<typeof EXPIRED>((resolveCeiling) => {
      timer = realSetTimeout(() => resolveCeiling(EXPIRED), remaining);
    });
    try {
      const value = await Promise.race([Promise.resolve().then(condition), ceiling]);
      if (value === EXPIRED) {
        expired = true;
      } else if (value) {
        return value as NonNullable<T>;
      } else {
        lastValue = value;
        lastError = undefined;
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (expired || performance.now() >= deadline) break;
    await pause(Math.min(intervalMs, Math.max(0, deadline - performance.now())));
  }
  const what = options.description ?? 'condition';
  const detail = expired
    ? 'the last check was still running'
    : lastError instanceof Error
      ? `last error: ${lastError.message}`
      : `last value: ${String(lastValue)}`;
  throw new Error(`waitFor: ${what} did not hold within ${timeoutMs} ms (${detail})`);
}
