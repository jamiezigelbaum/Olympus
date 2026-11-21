// Restart the archive components as the split wires them: separate front and
// background runtimes, shared files, only the background owning a scheduler.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import { SourceScheduler } from '../src/workers/source-scheduler.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import { archiveImportTaskId, createArchiveImportsSchedulerSource } from '../src/workers/archive-import/scheduler-source.ts';
import { createArchiveImportDashboard } from '../src/workers/archive-import/dashboard.ts';
import { requestArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { createArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { archiveConnectorId } from '../src/workers/archive-import/state.ts';
import { pullArchiveImport } from '../src/workers/archive-import/sync.ts';
import { createArchivePathResolver } from '../src/workers/local-files/scope-browser.ts';
import { createTestClock } from './helpers/test-clock.ts';
import { archiveStateSiblingPath } from '../src/core/olympus-layout.ts';
import { approveStaged } from './support/stage-upload.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function mail(tag: string, count = 3): string {
  return Array.from({ length: count }, (_, i) => `From sam@example.invalid Mon Jan 5 10:00:00 2015\nFrom: Sam <sam@example.invalid>\nTo: Alex <alex@example.invalid>\nSubject: Harbour ${tag} ${i}\nMessage-ID: <${tag}-${i}@example.invalid>\n\nThe synthetic harbour log ${tag} ${i}.\n\n`).join('');
}

test.each(['resume', 'remove', 'backoff_remove', 'backoff_removing', 'uploading'] as const)('restart with %s: the old work resumes or is removed, and a later upload completes', async (action) => {
  const home = mkdtempSync('/tmp/air-');
  roots.push(home);
  const env = { HOME: home, XDG_DATA_HOME: join(home, 'd') };
  const runtime = createArchiveImportRuntime({ env });
  const dashboard = createArchiveImportDashboard({ runtime, resolver: createArchivePathResolver(), refreshScheduler() {}, privateModel: () => 'off' });
  const path = join(home, 'rc-front-gmail.mbox');
  writeFileSync(path, mail('first'));
  let id = '';
  let uploadId = '';
  if (action === 'uploading') {
    uploadId = dashboard.upload.start().uploadId;
    await dashboard.upload.receive(uploadId, 'rc-front-gmail.mbox', Bun.file(path).stream(), { final: false });
    dashboard.close();
  } else {
    const started = await approveStaged(dashboard, path, { keepApart: true });
    if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
    id = started.archive_id;
    const lane = runtime.lane('email');
    try {
      // Stop after the store commits a page, while the import pass is still
      // in flight and has not updated its archive record. No graceful settle.
      const sync = lane.set.sync.bind(lane.set);
      const interrupted = new Error('runtime stopped after committing a page');
      lane.set.sync = async (...args) => {
        await sync(...args);
        dashboard.close();
        throw interrupted;
      };
      await expect(pullArchiveImport({ state: runtime.state, lane, archiveId: id, maxItems: 1, pageSize: 1 })).rejects.toBe(interrupted);
      expect(runtime.state.get(id)?.status).toBe('importing');
      expect(lane.set.committedCursor(archiveConnectorId(id))?.cursor).toBeString();
    } finally {
      dashboard.close();
      for (const store of lane.set.openStores()) store.close();
      lane.ledger.close();
    }
  }
  if (action === 'backoff_removing') requestArchiveRemoval(runtime.state, id);
  // v1.4.4 writes exactly this record/request shape (no migration or PID field).
  const clock = createTestClock();
  const bootAt = clock.now();
  const background = createArchiveImportRuntime({ env });
  const front = createArchiveImportRuntime({ env });
  const schedule = new LocalSourceSchedulerStateStore(join(home, 'scheduler.sqlite'));
  const runs = new Set<Promise<unknown>>();
  const roster = () => {
    const source = createArchiveImportsSchedulerSource({ runtime: background, config: defaultConfig() });
    return source ? [{ ...source, tasks: source.tasks.map(task => ({ ...task, run: async (context: Parameters<typeof task.run>[0]) => {
      const running = task.run(context);
      runs.add(running);
      try { return await running; } finally { runs.delete(running); }
    } })) }] : [];
  };
  if (action === 'backoff_remove' || action === 'backoff_removing') {
    const source = roster()[0]!;
    const key = { sourceId: source.sourceId, corpusId: source.corpusId, taskId: archiveImportTaskId(id) };
    schedule.recordAttempt({ ...key, attemptedAt: clock.date().toISOString() });
    schedule.recordFailure({ ...key, completedAt: clock.date().toISOString(),
      notBeforeAt: new Date(clock.now() + 60 * 60_000).toISOString(), errorKind: 'interrupted_import', errorHash: 'a'.repeat(64) });
  }
  const scheduler = new SourceScheduler({
    enabled: true, tickMs: 60_000, errorBackoffMs: 60_000, maxTransientRetries: 1,
    sources: roster(), stateStore: schedule, now: clock.date,
    setTimeoutImpl: clock.setTimeout as unknown as typeof setTimeout,
    clearTimeoutImpl: clock.clearTimeout as unknown as typeof clearTimeout,
    setIntervalImpl: clock.setInterval as unknown as typeof setInterval,
    clearIntervalImpl: clock.clearInterval as unknown as typeof clearInterval,
  });
  const writer = createArchiveImportDashboard({
    runtime: background, resolver: createArchivePathResolver(), ownsUploads: false,
    refreshScheduler: () => scheduler.updateSources(roster()), privateModel: () => 'off',
  });
  const reader = createArchiveImportDashboard({
    runtime: front, resolver: createArchivePathResolver(), ownsUploads: true,
    refreshScheduler: () => writer.frontChanged(), checksElsewhere: () => writer.frontChanged(), privateModel: () => 'off',
  });
  try {
    writer.resume();
    scheduler.start();
    if (action === 'uploading') {
      expect(reader.upload.cancel(uploadId)).toEqual({ cancelled: true });
      expect(existsSync(join(archiveStateSiblingPath(runtime.state.path, 'archive-staging'), uploadId))).toBe(false);
    }
    if (action === 'remove' || action === 'backoff_remove') expect(await reader.remove(id)).toEqual({ ok: true });
    const drain = async (finished: () => boolean) => {
      for (let pass = 0; pass < 20; pass++) {
        await clock.advance(60_000);
        await Promise.all([...runs]);
        await scheduler.runDueTasks(clock.date());
        if (finished()) return;
      }
      expect(finished()).toBe(true);
    };
    await drain(() => action === 'resume' ? runtime.state.get(id)?.status === 'imported' : runtime.state.get(id) === undefined);
    if (action === 'backoff_remove' || action === 'backoff_removing') {
      expect(clock.now() - bootAt).toBeLessThanOrEqual(60_000);
      expect(schedule.list().find(row => row.taskId === archiveImportTaskId(id))?.consecutiveFailures).toBe(1);
    }
    writeFileSync(join(home, 'later.mbox'), mail('later', 1));
    const second = await approveStaged(reader, join(home, 'later.mbox'), { keepApart: true });
    if (!second.ok || second.status !== 'started') throw new Error(JSON.stringify(second));
    await drain(() => runtime.state.get(second.archive_id)?.status === 'imported');
  } finally {
    reader.close(); writer.close(); scheduler.stop(); schedule.close();
    for (const opened of background.existingLanes()) {
      for (const store of opened.set.openStores()) store.close();
      opened.ledger.close();
    }
  }
}, 120_000);

// The front's cancellation must reach a check that the background resumed.
// Its cancelled set is process-local; checking only that set keeps reading
// the abandoned file and holds the queue of later checks behind it.
test('a check interrupted by restart stops reading when the front dismisses it, and a later import completes', async () => {
  const home = mkdtempSync('/tmp/air-check-');
  roots.push(home);
  const env = { HOME: home, XDG_DATA_HOME: join(home, 'd') };
  const runtime = createArchiveImportRuntime({ env });
  const resolver = createArchivePathResolver();
  let releaseOld!: () => void;
  const oldPause = new Promise<void>(resolve => { releaseOld = resolve; });
  let oldStarted!: () => void;
  const oldReady = new Promise<void>(resolve => { oldStarted = resolve; });
  const old = createArchiveImportDashboard({ runtime, resolver, refreshScheduler() {}, privateModel: () => 'off', pause: async () => { oldStarted(); await oldPause; } });
  // Three digest ranges. This seed is only used to force a sliced check.
  const large = [
    'From sam@example.invalid Mon Jan 5 10:00:00 2015',
    'From: Sam <sam@example.invalid>', 'To: Alex <alex@example.invalid>',
    'Subject: Harbour attachment', 'Message-ID: <large@example.invalid>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=harbour', '',
    '--harbour', 'Content-Type: text/plain', '', 'Short harbour log.',
    '--harbour', 'Content-Type: application/octet-stream; name=filler.bin',
    'Content-Disposition: attachment; filename=filler.bin', 'Content-Transfer-Encoding: base64', '',
    'A'.repeat(17 * 1024 * 1024), '--harbour--', '',
  ].join('\n');
  const firstPath = join(home, 'first.mbox');
  const copyPath = join(home, 'copy.mbox');
  writeFileSync(firstPath, large);
  writeFileSync(copyPath, large);
  const first = await approveStaged(old, firstPath, { keepApart: true });
  if (!first.ok || first.status !== 'started') throw new Error(JSON.stringify(first));
  const seedLane = runtime.lane('email');
  await pullArchiveImport({ state: runtime.state, lane: seedLane, archiveId: first.archive_id });
  expect(runtime.state.get(first.archive_id)?.status).toBe('imported');
  const checking = await approveStaged(old, copyPath, { keepApart: true });
  if (!checking.ok || checking.status !== 'checking') throw new Error(JSON.stringify(checking));
  await oldReady;
  old.close(); releaseOld(); await old.idle();
  for (const store of seedLane.set.openStores()) store.close();
  seedLane.ledger.close();

  const background = createArchiveImportRuntime({ env });
  const front = createArchiveImportRuntime({ env });
  let releaseCheck!: () => void;
  const blocked = new Promise<void>(resolve => { releaseCheck = resolve; });
  let checkStarted!: () => void;
  const checkReady = new Promise<void>(resolve => { checkStarted = resolve; });
  let resumedSlices = 0;
  const writer = createArchiveImportDashboard({
    runtime: background, resolver, ownsUploads: false, refreshScheduler() {}, privateModel: () => 'off',
    pause: async () => { resumedSlices++; if (resumedSlices === 1) { checkStarted(); await blocked; } },
  });
  const reader = createArchiveImportDashboard({ runtime: front, resolver, ownsUploads: true,
    refreshScheduler: () => writer.frontChanged(), checksElsewhere: () => writer.frontChanged(), privateModel: () => 'off' });
  try {
    writer.resume();
    await checkReady;
    expect(reader.decline(checking.request_id)).toEqual({ ok: true });
    // Queue another probable copy while the cancelled check is still in
    // flight. Same ends and size, different middle: this must become a new
    // import, rather than an already-imported answer.
    const laterPath = join(home, 'later.mbox');
    const middle = Math.floor(large.length / 2);
    writeFileSync(laterPath, `${large.slice(0, middle)}B${large.slice(middle + 1)}`);
    expect(await approveStaged(reader, laterPath, { keepApart: true })).toMatchObject({ ok: true, status: 'checking' });
    releaseCheck();
    await writer.idle();
    // Before the fix this is six: all three ranges of the abandoned file,
    // then all three of the queued check. Only the queued check may go on.
    expect(resumedSlices).toBe(4);
    expect(runtime.state.list().some(record => record.label === 'copy.mbox')).toBe(false);
    const later = runtime.state.list().find(record => record.label === 'later.mbox');
    expect(later).toBeDefined();
    if (!later) throw new Error('the queued check did not start its import');
    // The cancelled request is gone and the new archive has its own task.
    const source = createArchiveImportsSchedulerSource({ runtime: background, config: defaultConfig() })!;
    const clock = createTestClock();
    const scheduler = new SourceScheduler({ enabled: true, sources: [source], tickMs: 60_000, errorBackoffMs: 60_000, maxTransientRetries: 1, now: clock.date });
    for (let pass = 0; pass < 20 && runtime.state.get(later.archive_id)?.status === 'importing'; pass++) {
      await scheduler.runDueTasks(clock.date());
      await clock.advance(60_000);
    }
    expect(runtime.state.get(later.archive_id)?.status).toBe('imported');
  } finally {
    releaseCheck(); reader.close(); writer.close(); await writer.idle();
    for (const lane of background.existingLanes()) { for (const store of lane.set.openStores()) store.close(); lane.ledger.close(); }
  }
}, 120_000);
