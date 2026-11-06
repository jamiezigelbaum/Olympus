// Push wake: a source that offers `subscribeChanges` wakes its own tasks when
// something changes, bursts coalesce, polling stays the backstop, and a wake
// keeps the cadence rules: no manual task and no task in a failure backoff runs.

import { describe, expect, test } from 'bun:test';
import {
  SourceScheduler,
  createTelegramSchedulerSource,
  createWhatsAppSchedulerSource,
  type SourceSchedulerSource,
  type SourceSchedulerTaskRunResult,
} from '../src/workers/source-scheduler.ts';

const DEBOUNCE = 123;

interface Harness {
  scheduler: SourceScheduler;
  /** Fires pending debounce timers by hand, then lets the woken tick settle. */
  fireDebounce(): Promise<void>;
  /** Fires every other pending timer (continuation wakes), then settles. */
  fireOther(): Promise<void>;
  pendingDebounce(): number;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function harness(sources: SourceSchedulerSource[]): Harness {
  let nextId = 1;
  const debounce = new Map<number, () => void>();
  const other = new Map<number, () => void>();
  const setTimeoutImpl = ((callback: () => void, ms: number) => {
    const id = nextId++;
    (ms === DEBOUNCE ? debounce : other).set(id, callback);
    return { id, unref() {} };
  }) as unknown as typeof setTimeout;
  const clearTimeoutImpl = ((timer: { id: number }) => {
    debounce.delete(timer.id);
    other.delete(timer.id);
  }) as unknown as typeof clearTimeout;
  const setIntervalImpl = (() => ({ unref() {} })) as unknown as typeof setInterval;
  const clearIntervalImpl = (() => {}) as unknown as typeof clearInterval;
  const scheduler = new SourceScheduler({
    enabled: true,
    tickMs: 60_000,
    errorBackoffMs: 60 * 60_000,
    maxTransientRetries: 1,
    sources,
    changeDebounceMs: DEBOUNCE,
    // A follow-up is due at once, so firing its continuation wake runs it.
    continueAfterMs: 0,
    setTimeoutImpl,
    clearTimeoutImpl,
    setIntervalImpl,
    clearIntervalImpl,
  });
  const fire = async (timers: Map<number, () => void>) => {
    const due = [...timers.entries()];
    for (const [id, callback] of due) {
      timers.delete(id);
      callback();
    }
    await settle();
  };
  return {
    scheduler,
    pendingDebounce: () => debounce.size,
    fireDebounce: () => fire(debounce),
    fireOther: () => fire(other),
  };
}

function watchedSource(options: {
  sourceId?: string;
  cadence?: SourceSchedulerSource['cadence'];
  run: () => Promise<SourceSchedulerTaskRunResult>;
}): { source: SourceSchedulerSource; wake(): void; subscriptions: () => number; unsubscribed: () => number } {
  const wakes = new Set<() => void>();
  let unsubscribed = 0;
  const source: SourceSchedulerSource = {
    sourceId: options.sourceId ?? 'files.watched',
    corpusId: `secure_local.${options.sourceId ?? 'files.watched'}`,
    cadence: options.cadence ?? 'continuous',
    // Long enough that only the first tick and wakes run it during a test.
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

describe('messaging scheduler wake wiring', () => {
  test('a capture signal wakes both source pulls and WhatsApp extraction', async () => {
    const config = { worker: { scheduler: { syncIntervalSeconds: 1800, freshnessThresholdHours: 26 } } } as any;
    let telegramRuns = 0, whatsappRuns = 0, extractRuns = 0;
    let telegramWake = () => {}, whatsappWake = () => {};
    const telegram = createTelegramSchedulerSource({ config,
      sync: { pull: async () => { telegramRuns++; return { status: 'idle', counts: {} }; }, lastStoreRunCompletedAt: () => undefined } as any,
      subscribeChanges: wake => { telegramWake = wake; return () => {}; },
    })!;
    const whatsapp = createWhatsAppSchedulerSource({ config,
      sync: { pull: async () => { whatsappRuns++; return { status: 'idle', counts: {} }; }, lastStoreRunCompletedAt: () => undefined } as any,
      fileExtraction: { plan: async () => ({ jobsQueued: 0, candidates: 0, jobsExisting: 0, jobsUnroutable: 0, jobsRefused: 0, done: true }),
        run: async () => { extractRuns++; return { processedJobs: 0, counts: {} }; } } as any,
      subscribeChanges: wake => { whatsappWake = wake; return () => {}; },
    })!;
    const h = harness([telegram, whatsapp]);
    h.scheduler.start();
    await settle();
    const before = [telegramRuns, whatsappRuns, extractRuns];
    telegramWake(); whatsappWake(); whatsappWake();
    expect(h.pendingDebounce()).toBe(2);
    await h.fireDebounce();
    expect([telegramRuns, whatsappRuns, extractRuns]).toEqual(before.map(n => n + 1));
    h.scheduler.stop();
  });
});

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
    await settle();
    const afterStart = runs;
    for (let i = 0; i < 25; i += 1) watched.wake();
    expect(runs).toBe(afterStart);
    expect(h.pendingDebounce()).toBe(1);
    await h.fireDebounce();
    expect(runs).toBe(afterStart + 1);
    // A later change wakes it again, well before its 30-minute interval.
    watched.wake();
    await h.fireDebounce();
    expect(runs).toBe(afterStart + 2);
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
    await settle();
    expect(runs).toBe(1);
    for (let i = 0; i < 10; i += 1) {
      watched.wake();
      await h.fireDebounce();
    }
    // Nothing starts a second concurrent run.
    expect(runs).toBe(1);
    release();
    await settle();
    await h.fireOther();
    expect(runs).toBe(2);
    await h.fireOther();
    expect(runs).toBe(2);
    h.scheduler.stop();
  });

  test('a wake never runs a manual-cadence task', async () => {
    let runs = 0;
    const watched = watchedSource({ cadence: 'manual', run: async () => { runs += 1; return { status: 'idle' }; } });
    const h = harness([watched.source]);
    h.scheduler.start();
    await settle();
    watched.wake();
    await h.fireDebounce();
    await h.fireOther();
    expect(runs).toBe(0);
    h.scheduler.stop();
  });

  test('a wake keeps a failure backoff', async () => {
    let runs = 0;
    const watched = watchedSource({ run: async () => { runs += 1; throw new Error('provider down'); } });
    const h = harness([watched.source]);
    h.scheduler.start();
    await settle();
    const afterFailure = runs;
    expect(afterFailure).toBeGreaterThan(0);
    for (let i = 0; i < 5; i += 1) {
      watched.wake();
      await h.fireDebounce();
    }
    expect(runs).toBe(afterFailure);
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
    await settle();
    const afterStart = runs;
    watched.wake();
    expect(h.pendingDebounce()).toBe(1);
    h.scheduler.updateSources([]);
    expect(h.pendingDebounce()).toBe(0);
    await h.fireDebounce();
    expect(runs).toBe(afterStart);
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

  test('a wake signalled during a subscribe that then throws leaves no live timer', () => {
    const broken: SourceSchedulerSource = {
      ...watchedSource({ sourceId: 'files.broken', run: async () => ({ status: 'idle' }) }).source,
      subscribeChanges(wake) {
        wake();
        throw new Error('no watcher');
      },
    };
    const h = harness([broken]);
    h.scheduler.start();
    expect(h.pendingDebounce()).toBe(0);
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
