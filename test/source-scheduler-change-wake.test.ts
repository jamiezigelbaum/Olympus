// Push wake: a source that offers `subscribeChanges` wakes its own tasks when
// something changes, bursts coalesce, and polling stays the backstop.

import { describe, expect, test } from 'bun:test';
import {
  SourceScheduler,
  type SourceSchedulerSource,
  type SourceSchedulerTaskRunResult,
} from '../src/workers/source-scheduler.ts';

const DEBOUNCE = 123;

interface Harness {
  scheduler: SourceScheduler;
  /** Pending debounce timers, fired by hand. */
  fireDebounce(): Promise<void>;
  pendingDebounce(): number;
}

function harness(sources: SourceSchedulerSource[]): Harness {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  const setTimeoutImpl = ((callback: () => void, ms: number) => {
    const id = nextId++;
    if (ms === DEBOUNCE) timers.set(id, callback);
    return { id, unref() {} };
  }) as unknown as typeof setTimeout;
  const clearTimeoutImpl = ((timer: { id: number }) => {
    timers.delete(timer.id);
  }) as unknown as typeof clearTimeout;
  const setIntervalImpl = (() => ({ unref() {} })) as unknown as typeof setInterval;
  const clearIntervalImpl = (() => {}) as unknown as typeof clearInterval;
  const scheduler = new SourceScheduler({
    enabled: true,
    tickMs: 60_000,
    errorBackoffMs: 60_000,
    maxTransientRetries: 1,
    sources,
    changeDebounceMs: DEBOUNCE,
    setTimeoutImpl,
    clearTimeoutImpl,
    setIntervalImpl,
    clearIntervalImpl,
  });
  return {
    scheduler,
    pendingDebounce: () => timers.size,
    async fireDebounce() {
      const due = [...timers.entries()];
      for (const [id, callback] of due) {
        timers.delete(id);
        callback();
      }
      // Let the woken run (and any follow-up) settle.
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function watchedSource(options: {
  sourceId?: string;
  run: () => Promise<SourceSchedulerTaskRunResult>;
}): { source: SourceSchedulerSource; wake(): void; subscriptions: () => number; unsubscribed: () => number } {
  const wakes = new Set<() => void>();
  let unsubscribed = 0;
  const source: SourceSchedulerSource = {
    sourceId: options.sourceId ?? 'files.watched',
    corpusId: `secure_local.${options.sourceId ?? 'files.watched'}`,
    // Manual: only a wake (or an owner run) starts it, so the tests see wake runs alone.
    cadence: 'manual',
    intervalMs: 30 * 60_000,
    freshnessThresholdHours: 26,
    tasks: [{ id: 'sync', kind: 'sync', writer: true, run: options.run }],
    subscribeChanges(wake) {
      wakes.add(wake);
      return () => {
        wakes.delete(wake);
        unsubscribed += 1;
      };
    },
  };
  return {
    source,
    wake: () => { for (const wake of [...wakes]) wake(); },
    subscriptions: () => wakes.size,
    unsubscribed: () => unsubscribed,
  };
}

describe('scheduler push wake', () => {
  test('subscribes on start, never before, and unsubscribes on stop', () => {
    const watched = watchedSource({ run: async () => ({ status: 'idle' }) });
    const h = harness([watched.source]);
    expect(watched.subscriptions()).toBe(0);
    h.scheduler.start();
    expect(watched.subscriptions()).toBe(1);
    h.scheduler.stop();
    expect(watched.subscriptions()).toBe(0);
    expect(watched.unsubscribed()).toBe(1);
    // A signal after stop is ignored.
    watched.wake();
    expect(h.pendingDebounce()).toBe(0);
  });

  test('a burst of signals runs the source once after the debounce window', async () => {
    let runs = 0;
    const watched = watchedSource({ run: async () => { runs += 1; return { status: 'idle' }; } });
    const h = harness([watched.source]);
    h.scheduler.start();
    for (let i = 0; i < 25; i += 1) watched.wake();
    expect(runs).toBe(0);
    expect(h.pendingDebounce()).toBe(1);
    await h.fireDebounce();
    expect(runs).toBe(1);
    // A later change wakes it again.
    watched.wake();
    await h.fireDebounce();
    expect(runs).toBe(2);
    h.scheduler.stop();
  });

  test('signals during a run coalesce into exactly one follow-up run', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const watched = watchedSource({
      run: async () => {
        runs += 1;
        if (runs === 1) await gate;
        return { status: 'idle' };
      },
    });
    const h = harness([watched.source]);
    h.scheduler.start();
    watched.wake();
    await h.fireDebounce();
    expect(runs).toBe(1);
    for (let i = 0; i < 10; i += 1) watched.wake();
    // Nothing starts a second concurrent run.
    expect(h.pendingDebounce()).toBe(0);
    expect(runs).toBe(1);
    release();
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toBe(2);
    h.scheduler.stop();
  });

  test('removing or replacing a source unsubscribes it; a new one subscribes', () => {
    const first = watchedSource({ sourceId: 'files.one', run: async () => ({ status: 'idle' }) });
    const second = watchedSource({ sourceId: 'files.two', run: async () => ({ status: 'idle' }) });
    const h = harness([first.source]);
    h.scheduler.start();
    expect(first.subscriptions()).toBe(1);
    h.scheduler.updateSources([first.source, second.source]);
    // The unchanged source keeps its one subscription.
    expect(first.subscriptions()).toBe(1);
    expect(first.unsubscribed()).toBe(0);
    expect(second.subscriptions()).toBe(1);
    h.scheduler.updateSources([second.source]);
    expect(first.subscriptions()).toBe(0);
    expect(first.unsubscribed()).toBe(1);
    expect(second.subscriptions()).toBe(1);
    h.scheduler.stop();
    expect(second.subscriptions()).toBe(0);
  });

  test('a pending debounce is cancelled when its source is removed', async () => {
    let runs = 0;
    const watched = watchedSource({ run: async () => { runs += 1; return { status: 'idle' }; } });
    const h = harness([watched.source]);
    h.scheduler.start();
    watched.wake();
    expect(h.pendingDebounce()).toBe(1);
    h.scheduler.updateSources([]);
    expect(h.pendingDebounce()).toBe(0);
    await h.fireDebounce();
    expect(runs).toBe(0);
    h.scheduler.stop();
  });

  test('a source that throws on subscribe does not stop the scheduler or other sources', () => {
    const broken: SourceSchedulerSource = {
      ...watchedSource({ sourceId: 'files.broken', run: async () => ({ status: 'idle' }) }).source,
      subscribeChanges() { throw new Error('no watcher'); },
    };
    const ok = watchedSource({ sourceId: 'files.ok', run: async () => ({ status: 'idle' }) });
    const h = harness([broken, ok.source]);
    h.scheduler.start();
    expect(ok.subscriptions()).toBe(1);
    h.scheduler.stop();
  });

  test('a source without subscribeChanges is polled exactly as before', () => {
    const plain: SourceSchedulerSource = {
      sourceId: 'files.plain',
      corpusId: 'secure_local.files.plain',
      cadence: 'manual',
      intervalMs: 60_000,
      freshnessThresholdHours: 26,
      tasks: [{ id: 'sync', kind: 'sync', writer: true, run: async () => ({ status: 'idle' }) }],
    };
    const h = harness([plain]);
    h.scheduler.start();
    h.scheduler.stop();
    expect(h.pendingDebounce()).toBe(0);
  });
});
