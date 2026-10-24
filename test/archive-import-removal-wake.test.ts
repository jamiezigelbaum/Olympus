// A removal starts within seconds of being asked for, whatever the archive's
// import left in the scheduler. Import and removal are one scheduler task, so
// a removal inherits the import's last pass plus the sync interval (30 minutes
// by default) unless the source wakes the scheduler: when the dashboard asks
// for a removal, and when the scheduler starts with one waiting. Tested on a
// real scheduler with its durable state, an injected clock and injected timers,
// so a restart is a second scheduler over the same state. Synthetic mail only.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import { createArchiveImportDashboard, type ArchiveImportDashboard } from '../src/workers/archive-import/dashboard.ts';
import { requestArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import {
  ARCHIVE_IMPORTS_CONCURRENCY_KEY,
  archiveImportTaskId,
  createArchiveImportsSchedulerSource,
} from '../src/workers/archive-import/scheduler-source.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { MacPermissions } from '../src/workers/local-files/mac-permissions.ts';
import { createLocalFilesArchiveBrowser } from '../src/workers/local-files/scope-browser.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { SourceScheduler, type SourceSchedulerSource } from '../src/workers/source-scheduler.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const TICK_MS = 60_000;
const DEBOUNCE_MS = 123;
const T0 = Date.parse('2026-10-24T12:00:00.000Z');

function mail(index: number, tag: string): string {
  return [
    'From: Sam Example <sam@example.invalid>',
    'To: Alex Example <alex@example.invalid>',
    `Subject: Synthetic ${tag} note ${index}`,
    `Date: Mon, ${String(5 + index).padStart(2, '0')} Jan 2015 10:00:00 +0000`,
    `Message-ID: <${tag}-${index}@example.invalid>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `The synthetic ${tag} harbour log, entry ${index}.`,
  ].join('\n');
}

function mbox(messages: readonly string[]): string {
  return messages.map((message) => `From sender@example.invalid Mon Jan  5 10:00:00 2015\n${message}\n\n`).join('');
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-removal-wake-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const exports = join(home, 'Mail exports');
  mkdirSync(exports, { recursive: true });
  const env = { HOME: home, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') };
  const runtime = createArchiveImportRuntime({
    env,
    statePath: join(base, 'xdg', 'archive-imports.json'),
    waitingQuestionsDbPath: join(base, 'waiting-private-questions.sqlite'),
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
  });
  cleanups.push(() => {
    for (const lane of runtime.existingLanes()) {
      for (const store of lane.set.openStores()) store.close();
      lane.secretLocations?.close();
      lane.ledger.close();
    }
  });
  const volumes = new VolumeResolver({
    platform: 'darwin',
    home,
    readMounts: () => '/dev/disk3s1s1 on / (apfs, local)',
    diskutilPlist: () => undefined,
  });
  const permissions = new MacPermissions({ home, memoryPath: join(base, 'folder-access.json'), platform: 'linux' });
  const browser = createLocalFilesArchiveBrowser({ volumes, home, permissions });
  const stateStore = new LocalSourceSchedulerStateStore(':memory:');
  cleanups.push(() => stateStore.close());
  const start = (name: string, text: string): string => {
    const path = join(exports, name);
    writeFileSync(path, text);
    const started = runtime.start(path);
    if (started.kind !== 'started') throw new Error(`expected a start, got ${started.kind}`);
    return started.archive.archive_id;
  };
  return { home, exports, runtime, browser, stateStore, start };
}

type Fixture = ReturnType<typeof fixture>;
interface Clock { now: number }

/** What the engine builds on every roster change (email-source/server.ts). */
function roster(runtime: ArchiveImportRuntime): SourceSchedulerSource[] {
  const source = createArchiveImportsSchedulerSource({ runtime, config: defaultConfig() });
  return source ? [source] : [];
}

/**
 * A scheduler over the fixture's durable state, with a clock and timers the
 * test drives, and the dashboard that refreshes it. Two of them over one
 * fixture are an engine and its restart.
 */
function engine(f: Fixture, clock: Clock) {
  let nextTimer = 1;
  const timers = new Map<number, { ms: number; callback: () => void }>();
  const setTimeoutImpl = ((callback: () => void, ms: number) => {
    const id = nextTimer++;
    timers.set(id, { ms, callback });
    return { id, unref() {} };
  }) as unknown as typeof setTimeout;
  const clearTimeoutImpl = ((timer: { id: number }) => { timers.delete(timer.id); }) as unknown as typeof clearTimeout;
  const scheduler = new SourceScheduler({
    enabled: true,
    tickMs: TICK_MS,
    errorBackoffMs: 60_000,
    maxTransientRetries: 1,
    sources: roster(f.runtime),
    now: () => new Date(clock.now),
    stateStore: f.stateStore,
    changeDebounceMs: DEBOUNCE_MS,
    setTimeoutImpl,
    clearTimeoutImpl,
    setIntervalImpl: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
  });
  cleanups.push(() => scheduler.stop());
  const dashboard: ArchiveImportDashboard = createArchiveImportDashboard({
    runtime: f.runtime,
    browser: f.browser,
    refreshScheduler: () => scheduler.updateSources(roster(f.runtime), new Date(clock.now)),
    privateModel: () => 'ready',
    home: f.home,
  });
  cleanups.push(() => dashboard.close());
  return {
    scheduler,
    dashboard,
    /** Push wakes waiting out their debounce. */
    pendingWakes: () => [...timers.values()].filter((timer) => timer.ms === DEBOUNCE_MS).length,
    /** Fires every waiting timer, as the clock reaching them would. */
    fireTimers: () => {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

type Engine = ReturnType<typeof engine>;

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 500; tries += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

/** Runs the scheduler's due tasks until the archive's import is over, one tick apart. */
async function importThrough(e: Engine, f: Fixture, archiveId: string, clock: Clock): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    await e.scheduler.runDueTasks(new Date(clock.now));
    if (f.runtime.state.get(archiveId)?.status !== 'importing') return;
    clock.now += TICK_MS;
  }
  throw new Error('the import did not finish');
}

/** How long until the durable schedule runs the archive's task again. */
function durableNextPassMs(f: Fixture, archiveId: string, clock: Clock): number {
  const rows = f.stateStore.list().filter((row) => row.taskId === archiveImportTaskId(archiveId));
  if (rows.length !== 1 || !rows[0]!.notBeforeAt) throw new Error('the archive has no durable schedule');
  return Date.parse(rows[0]!.notBeforeAt) - clock.now;
}

/** The debounce passes (a second at most), and the removal has run, all inside one tick of the request. */
async function removedWithinOneTick(f: Fixture, archiveId: string, e: Engine, clock: Clock): Promise<void> {
  const askedAt = clock.now;
  clock.now += 1_000;
  e.fireTimers();
  await until(() => f.runtime.state.get(archiveId) === undefined);
  expect(clock.now - askedAt).toBeLessThanOrEqual(TICK_MS);
}

describe('removing an archive starts within one scheduler tick', () => {
  test('an archive that finished importing, on the engine that imported it', async () => {
    const f = fixture();
    const clock: Clock = { now: T0 };
    const id = f.start('Done.mbox', mbox([mail(0, 'd'), mail(1, 'd'), mail(2, 'd')]));
    const e = engine(f, clock);
    await importThrough(e, f, id, clock);
    expect(f.runtime.state.get(id)?.status).toBe('imported');
    e.scheduler.start();
    // Ten quiet minutes later the import's next pass is still 20 minutes away.
    clock.now += 10 * 60_000;
    expect(durableNextPassMs(f, id, clock)).toBeGreaterThan(TICK_MS);

    expect(e.dashboard.remove(id)).toEqual({ ok: true });
    expect(f.runtime.state.get(id)?.status).toBe('removing');
    expect(e.pendingWakes()).toBe(1);
    await removedWithinOneTick(f, id, e, clock);
  });

  test('an archive that finished importing, on an engine started since', async () => {
    const f = fixture();
    const clock: Clock = { now: T0 };
    const id = f.start('Done.mbox', mbox([mail(0, 'd'), mail(1, 'd')]));
    const first = engine(f, clock);
    await importThrough(first, f, id, clock);
    first.scheduler.stop();
    clock.now += 10 * 60_000;

    // Nothing of the import is in memory now; the durable schedule says 20 minutes.
    const second = engine(f, clock);
    second.scheduler.start();
    expect(second.pendingWakes()).toBe(0);
    expect(durableNextPassMs(f, id, clock)).toBeGreaterThan(TICK_MS);

    expect(second.dashboard.remove(id)).toEqual({ ok: true });
    await removedWithinOneTick(f, id, second, clock);
  });

  test('an archive whose import stopped because its file went missing', async () => {
    const f = fixture();
    const clock: Clock = { now: T0 };
    const id = f.start('Gone.mbox', mbox([mail(0, 'g'), mail(1, 'g')]));
    unlinkSync(join(f.exports, 'Gone.mbox'));
    const e = engine(f, clock);
    await importThrough(e, f, id, clock);
    expect(f.runtime.state.get(id)).toMatchObject({ status: 'stopped', stop: { code: 'file_missing' } });
    e.scheduler.start();
    clock.now += 5 * 60_000;
    expect(durableNextPassMs(f, id, clock)).toBeGreaterThan(TICK_MS);

    expect(e.dashboard.remove(id)).toEqual({ ok: true });
    await removedWithinOneTick(f, id, e, clock);
  });

  test('the person approving an agent\'s request to remove an archive', async () => {
    const f = fixture();
    const clock: Clock = { now: T0 };
    const id = f.start('Done.mbox', mbox([mail(0, 'a'), mail(1, 'a')]));
    const e = engine(f, clock);
    await importThrough(e, f, id, clock);
    e.scheduler.start();
    clock.now += 10 * 60_000;

    const asked = e.dashboard.agent.remove(id);
    if (asked.ok || asked.code !== 'needs_approval') throw new Error('expected a request waiting for approval');
    // Asking removes nothing and wakes nothing.
    expect(f.runtime.state.get(id)?.status).toBe('imported');
    expect(e.pendingWakes()).toBe(0);

    expect(e.dashboard.approveRemoval(asked.request_id)).toEqual({ ok: true });
    await removedWithinOneTick(f, id, e, clock);
  });

  test('an engine that restarts while the record says removing', async () => {
    const f = fixture();
    const clock: Clock = { now: T0 };
    const id = f.start('Done.mbox', mbox([mail(0, 'r'), mail(1, 'r')]));
    const first = engine(f, clock);
    await importThrough(first, f, id, clock);
    // The removal is asked for, and the engine goes down before a pass of it runs.
    requestArchiveRemoval(f.runtime.state, id, () => new Date(clock.now));
    first.scheduler.stop();
    clock.now += 2 * 60_000;

    const second = engine(f, clock);
    expect(f.runtime.state.get(id)?.status).toBe('removing');
    expect(durableNextPassMs(f, id, clock)).toBeGreaterThan(TICK_MS);
    // Starting subscribes the archive source, and a removal is waiting.
    second.scheduler.start();
    expect(second.pendingWakes()).toBe(1);
    await removedWithinOneTick(f, id, second, clock);
  });

  test('a removal asked for while another archive imports waits for no interval, and the import is not harmed', async () => {
    const f = fixture();
    const clock: Clock = { now: T0 };
    const done = f.start('Done.mbox', mbox([mail(0, 'x'), mail(1, 'x')]));
    const e = engine(f, clock);
    await importThrough(e, f, done, clock);
    e.scheduler.start();
    const importing = f.start('Later.mbox', mbox([mail(0, 'y'), mail(1, 'y'), mail(2, 'y')]));
    e.scheduler.updateSources(roster(f.runtime), new Date(clock.now));
    clock.now += 10 * 60_000;

    expect(e.dashboard.remove(done)).toEqual({ ok: true });
    await removedWithinOneTick(f, done, e, clock);
    // The two share one concurrency key, so they ran one after the other.
    await until(() => f.runtime.state.get(importing)?.status === 'imported');
  });
});

describe('the wake leaves the ordinary cadence alone', () => {
  test('nothing is woken while no removal waits, on starting or on a new import', async () => {
    const f = fixture();
    const clock: Clock = { now: T0 };
    const id = f.start('Quiet.mbox', mbox([mail(0, 'q')]));
    const e = engine(f, clock);
    await importThrough(e, f, id, clock);
    e.scheduler.start();
    expect(e.pendingWakes()).toBe(0);
    // A new import refreshes the roster; it is due at the next tick like any new task.
    f.start('Next.mbox', mbox([mail(0, 'n')]));
    e.scheduler.updateSources(roster(f.runtime), new Date(clock.now));
    expect(e.pendingWakes()).toBe(0);
  });

  test('a subscriber hears a removal asked for and not after it unsubscribes, and a failing one does not silence the rest', () => {
    const f = fixture();
    const id = f.start('Done.mbox', mbox([mail(0, 'u')]));
    const heard: string[] = [];
    const stopFirst = f.runtime.subscribeWork(() => { heard.push('first'); });
    f.runtime.subscribeWork(() => { throw new Error('a subscriber that fails'); });
    f.runtime.subscribeWork(() => { heard.push('third'); });
    expect(heard).toEqual([]);
    f.runtime.notifyWork();
    expect(heard).toEqual(['first', 'third']);
    stopFirst();
    f.runtime.notifyWork();
    expect(heard).toEqual(['first', 'third', 'third']);

    // Subscribing while a removal waits wakes at once.
    requestArchiveRemoval(f.runtime.state, id);
    const late: string[] = [];
    f.runtime.subscribeWork(() => { late.push('woken'); });
    expect(late).toEqual(['woken']);
  });

  test('a removal is still on the archives\' one concurrency key, and rebuilding the source keeps one subscription', () => {
    const f = fixture();
    const first = f.start('A.mbox', mbox([mail(0, 'k')]));
    f.start('B.mbox', mbox([mail(0, 'l')]));
    requestArchiveRemoval(f.runtime.state, first);
    const source = createArchiveImportsSchedulerSource({ runtime: f.runtime, config: defaultConfig() })!;
    expect(source.tasks.map((task) => task.concurrencyKey)).toEqual([ARCHIVE_IMPORTS_CONCURRENCY_KEY, ARCHIVE_IMPORTS_CONCURRENCY_KEY]);
    const rebuilt = createArchiveImportsSchedulerSource({ runtime: f.runtime, config: defaultConfig() })!;
    expect(rebuilt.subscribeChanges).toBe(source.subscribeChanges);
  });
});
