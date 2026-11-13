import { expect, spyOn, test } from 'bun:test';
import { SourceScheduler } from '../src/workers/source-scheduler.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

test('any executing task excludes reclaim; a hold waits every source, including writers from other sources, and releases them at once', async () => {
  const clock = createTestClock();
  const stateStore = new LocalSourceSchedulerStateStore(':memory:');
  const failures = spyOn(stateStore, 'recordFailure');
  let finishTask!: () => void;
  const task = new Promise<void>(resolve => { finishTask = resolve; });
  let calls = 0, otherCalls = 0;
  const scheduler = new SourceScheduler({ enabled: true, tickMs: 60_000, errorBackoffMs: 5_000, maxTransientRetries: 1,
    now: clock.date, stateStore, sources: [
      { sourceId: 'source', corpusId: 'store', cadence: 'manual', intervalMs: 60_000, freshnessThresholdHours: 1,
        tasks: [{ id: 'ingest', kind: 'sync', writer: true, async run() { calls++; await task; return { status: 'progress' }; } }] },
      { sourceId: 'other', corpusId: 'other-store', cadence: 'continuous', intervalMs: 60_000, freshnessThresholdHours: 1,
        tasks: [{ id: 'other-ingest', kind: 'sync', writer: true, async run() { otherCalls++; return { status: 'idle' }; } }] },
    ] });
  let finishReclaim!: () => void;
  const held = new Promise<void>(resolve => { finishReclaim = resolve; });
  try {
    const running = scheduler.runSource('source');
    expect(scheduler.hasExecutingTask(new Set(['source']))).toBe(true);
    expect(await scheduler.withIdleTasks(async () => { throw new Error('must skip'); })).toBeUndefined();
    finishTask(); await running;
    const reclaim = scheduler.withIdleTasks(() => held);
    expect(await scheduler.withIdleTasks(async () => { throw new Error('one hold at a time'); })).toBeUndefined();
    const waiting = scheduler.runSource('source', undefined, 'operator');
    // A writer filed under another source (an archive import into this
    // store) waits as well.
    const otherWaiting = scheduler.runDueTasks();
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(otherCalls).toBe(0);
    expect(scheduler.status().sources[0]!.tasks[0]!.wait_reason).toBe('store_reclaim');
    expect(scheduler.status().sources[1]!.tasks[0]!.wait_reason).toBe('store_reclaim');
    expect(scheduler.anyTaskRunning).toBe(false);
    finishReclaim(); await reclaim; await waiting; await otherWaiting;
    expect(calls).toBe(2);
    expect(otherCalls).toBe(1);
    expect(failures).not.toHaveBeenCalled();
    expect(scheduler.status().sources[0]!.tasks[0]!.wait_reason).toBeUndefined();
  } finally { finishTask(); finishReclaim?.(); scheduler.stop(); failures.mockRestore(); stateStore.close(); }
});

test('a failed reclaim releases waiting scheduled work without changing its cadence or recording a failure', async () => {
  let ran = false, fail!: (error: Error) => void;
  const held = new Promise<void>((_resolve, reject) => { fail = reject; });
  const scheduler = new SourceScheduler({ enabled: true, tickMs: 60_000, errorBackoffMs: 5_000, maxTransientRetries: 1,
    sources: [{ sourceId: 'source', corpusId: 'store', cadence: 'continuous', intervalMs: 60_000, freshnessThresholdHours: 1,
      tasks: [{ id: 'ingest', kind: 'sync', writer: true, async run() { ran = true; return { status: 'idle' }; } }] }] });
  const reclaim = scheduler.withIdleTasks(() => held);
  const rejected = reclaim.catch(error => error);
  const waiting = scheduler.runDueTasks();
  expect(ran).toBe(false);
  fail(new Error('conversion interrupted'));
  expect((await rejected).message).toBe('conversion interrupted'); await waiting;
  expect(ran).toBe(true);
  expect(scheduler.status().sources[0]!.tasks[0]).toMatchObject({ consecutive_failures: 0, interval_seconds: 60 });
  scheduler.stop();
});

test('ingest comes first: a conversion starts only in a quiet window, and a task that comes due preempts it', async () => {
  const clock = createTestClock();
  let ran = 0;
  const scheduler = new SourceScheduler({ enabled: true, tickMs: 60_000, errorBackoffMs: 5_000, maxTransientRetries: 1,
    now: clock.date, sources: [{ sourceId: 'source', corpusId: 'store', cadence: 'continuous', intervalMs: 60_000, freshnessThresholdHours: 1,
      tasks: [{ id: 'ingest', kind: 'sync', writer: true, async run() { ran++; return { status: 'idle' }; } }] }] });
  try {
    // A continuous task is due now: no window long enough for a conversion.
    expect(await scheduler.withIdleTasks(async () => { throw new Error('must not start'); }, { quietForMs: 30_000 })).toBeUndefined();
    await scheduler.runDueTasks();
    expect(ran).toBe(1);
    // Next run is a minute away: a 30 s conversion fits, a 2 min one does not.
    expect(await scheduler.withIdleTasks(async () => { throw new Error('must not start'); }, { quietForMs: 120_000 })).toBeUndefined();
    let preempted = 0, finish!: () => void;
    const conversion = new Promise<void>(resolve => { finish = resolve; });
    const reclaim = scheduler.withIdleTasks(() => conversion, { quietForMs: 30_000, preempt: () => { preempted++; finish(); } });
    await clock.advance(60_000);
    const due = scheduler.runDueTasks();
    await flushMicrotasks();
    expect(preempted).toBe(1);
    await reclaim; await due;
    expect(ran).toBe(2);
    expect(scheduler.status().sources[0]!.tasks[0]).toMatchObject({ consecutive_failures: 0 });
  } finally { scheduler.stop(); }
});
