// A worker restart stops the scheduler, then the built-in search model; a pass
// still running then fails ("The built-in search model stopped (SIGTERM)").
// That is a restart, not evidence the source is unhealthy: the task must stay
// due again with no failure counted and no backoff (#803).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { SourceScheduler, type SourceSchedulerTask } from '../src/workers/source-scheduler.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';

const T0 = Date.parse('2026-11-03T10:00:00.000Z');
const BACKOFF_MS = 15 * 60_000;
const KEY = { sourceId: 'standin.mail', corpusId: 'secure_local.standin.mail', taskId: 'store_reconcile' };

function source(task: SourceSchedulerTask) {
  return {
    sourceId: KEY.sourceId,
    corpusId: KEY.corpusId,
    cadence: 'continuous' as const,
    intervalMs: 30 * 60_000,
    freshnessThresholdHours: 26,
    tasks: [task],
  };
}

function scheduler(task: SourceSchedulerTask, now: () => number, stateStore?: LocalSourceSchedulerStateStore) {
  return new SourceScheduler({
    enabled: true,
    tickMs: 60_000,
    errorBackoffMs: BACKOFF_MS,
    maxTransientRetries: 3,
    now: () => new Date(now()),
    ...(stateStore ? { stateStore } : {}),
    sources: [source(task)],
  });
}

/** A pass that runs until the test fails it, the way a killed model fails its batch. */
function interruptiblePass() {
  let fail!: (error: Error) => void;
  let calls = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const task: SourceSchedulerTask = {
    id: KEY.taskId,
    kind: 'sync',
    writer: true,
    run: () => { calls += 1; return new Promise((_, reject) => { fail = reject; markStarted(); }); },
  };
  return { task, started, fail: (error: Error) => fail(error), calls: () => calls };
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try { return await run(); } finally { console.error = original; }
}

describe('a pass interrupted by worker shutdown', () => {
  test('is not counted as a failure and leaves the task due again (persisted)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-scheduler-interrupt-'));
    let clock = T0;
    try {
      const store = new LocalSourceSchedulerStateStore(join(dir, 'state.sqlite'));
      // Two real failures before this pass: the restart must not add a third.
      store.recordFailure({ ...KEY, completedAt: new Date(T0 - 120_000).toISOString(), notBeforeAt: new Date(T0 - 60_000).toISOString(), errorKind: 'task_failed', errorHash: 'a'.repeat(16) });
      store.recordFailure({ ...KEY, completedAt: new Date(T0 - 60_000).toISOString(), notBeforeAt: new Date(T0).toISOString(), errorKind: 'task_failed', errorHash: 'b'.repeat(16) });
      const pass = interruptiblePass();
      const running = scheduler(pass.task, () => clock, store);
      const tick = quietly(() => running.runDueTasks(new Date(T0)));
      await pass.started;
      clock = T0 + 5_000;
      running.stop();
      pass.fail(new Error('The built-in search model stopped (SIGTERM).'));
      const status = await tick;

      const task = status.sources[0]!.tasks[0]!;
      expect(task.consecutive_failures).toBe(2);
      expect(task.last_error_hash).toBe('b'.repeat(16));
      expect(task.next_run_at).toBe(new Date(T0 + 5_000).toISOString());
      // The shutdown is not retried in-process.
      expect(pass.calls()).toBe(1);

      const persisted = store.get(KEY)!;
      expect(persisted.consecutiveFailures).toBe(2);
      expect(persisted.attemptPending).toBe(false);
      expect(persisted.lastResultStatus).toBe('failed');
      expect(persisted.lastErrorHash).toBe('b'.repeat(16));

      // The next worker finds the task due at once, not behind the backoff.
      clock = T0 + 60_000;
      const next = scheduler(interruptiblePass().task, () => clock, store);
      const due = Date.parse(next.status(new Date(clock)).sources[0]!.tasks[0]!.next_run_at!);
      expect(due).toBeLessThanOrEqual(clock);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is not counted as a failure without a state store', async () => {
    let clock = T0;
    const pass = interruptiblePass();
    const running = scheduler(pass.task, () => clock);
    const tick = quietly(() => running.runDueTasks(new Date(T0)));
    await pass.started;
    clock = T0 + 5_000;
    running.stop();
    pass.fail(new Error('The built-in search model stopped (SIGTERM).'));
    const task = (await tick).sources[0]!.tasks[0]!;
    expect(task.consecutive_failures).toBe(0);
    expect(task.last_error_kind).toBeUndefined();
    expect(task.next_run_at).toBe(new Date(T0 + 5_000).toISOString());
  });

  test('a failure while the scheduler runs still counts', async () => {
    let clock = T0;
    const pass = interruptiblePass();
    const running = scheduler(pass.task, () => clock);
    const tick = quietly(() => running.runDueTasks(new Date(T0)));
    await pass.started;
    clock = T0 + 5_000;
    pass.fail(new Error('Stand-in pull returned HTTP 500.'));
    const task = (await tick).sources[0]!.tasks[0]!;
    expect(task.consecutive_failures).toBe(1);
    expect(task.next_run_at).toBe(new Date(T0 + 5_000 + BACKOFF_MS).toISOString());
  });
});

describe('a pass still running when the process exits to restart itself', () => {
  // A self-restart (a model change, the background's memory restart) exits
  // without waiting for the pass to throw. Without a settle the attempt stays
  // pending, and the next process reads it as a failure and backs off.
  test('is recorded as interrupted, so the next process runs it at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-scheduler-interrupt-'));
    let clock = T0;
    try {
      const store = new LocalSourceSchedulerStateStore(join(dir, 'state.sqlite'));
      const pass = interruptiblePass();
      const running = scheduler(pass.task, () => clock, store);
      void quietly(() => running.runDueTasks(new Date(T0)));
      await pass.started;
      expect(running.anyTaskRunning).toBe(true);
      clock = T0 + 5_000;
      running.stop();
      // The process exits here; the pass never settles itself.
      expect(running.settleInterruptedAttempts()).toBe(1);

      const persisted = store.get(KEY)!;
      expect(persisted.attemptPending).toBe(false);
      expect(persisted.consecutiveFailures).toBe(0);
      clock = T0 + 60_000;
      const next = scheduler(interruptiblePass().task, () => clock, store);
      const due = Date.parse(next.status(new Date(clock)).sources[0]!.tasks[0]!.next_run_at!);
      expect(due).toBeLessThanOrEqual(clock);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('settles nothing when no pass is running', () => {
    const running = scheduler(interruptiblePass().task, () => T0);
    expect(running.anyTaskRunning).toBe(false);
    expect(running.settleInterruptedAttempts()).toBe(0);
  });
});

describe('a pass whose source left the roster while it ran', () => {
  test('still counts as running, and is settled as interrupted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-scheduler-interrupt-'));
    let clock = T0;
    try {
      const store = new LocalSourceSchedulerStateStore(join(dir, 'state.sqlite'));
      const pass = interruptiblePass();
      const running = scheduler(pass.task, () => clock, store);
      void quietly(() => running.runDueTasks(new Date(T0)));
      await pass.started;
      // The source is removed (disconnected) while its pass is still running.
      running.updateSources([]);
      expect(running.anyTaskRunning).toBe(true);
      clock = T0 + 5_000;
      running.stop();
      expect(running.settleInterruptedAttempts()).toBe(1);
      expect(store.get(KEY)!.attemptPending).toBe(false);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
