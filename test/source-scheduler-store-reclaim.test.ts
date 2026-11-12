import { expect, spyOn, test } from 'bun:test';
import { SourceScheduler } from '../src/workers/source-scheduler.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

test('executing sources exclude reclaim; a hold waits only its sources and releases queued operator work at once', async () => {
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
    expect(await scheduler.withIdleSources(new Set(['store']), async () => { throw new Error('must skip'); })).toBeUndefined();
    finishTask(); await running;
    const reclaim = scheduler.withIdleSources(new Set(['source']), () => held);
    const waiting = scheduler.runSource('source', undefined, 'operator');
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(scheduler.status().sources[0]!.tasks[0]!.wait_reason).toBe('store_reclaim');
    expect(scheduler.hasExecutingTask(new Set(['source']))).toBe(false);
    await scheduler.runDueTasks();
    expect(otherCalls).toBe(1);
    finishReclaim(); await reclaim; await waiting;
    expect(calls).toBe(2);
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
  const reclaim = scheduler.withIdleSources(new Set(['source']), () => held);
  const rejected = reclaim.catch(error => error);
  const waiting = scheduler.runDueTasks();
  expect(ran).toBe(false);
  fail(new Error('conversion interrupted'));
  expect((await rejected).message).toBe('conversion interrupted'); await waiting;
  expect(ran).toBe(true);
  expect(scheduler.status().sources[0]!.tasks[0]).toMatchObject({ consecutive_failures: 0, interval_seconds: 60 });
  scheduler.stop();
});
