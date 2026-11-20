import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BOOT_PROGRESS_SCHEMA } from '../src/core/boot-progress.ts';
import { frontLoopSqlHealth, resetFrontLoopSqlGuardForTests, watchFrontLoopSql } from '../src/core/front-loop-sql-guard.ts';
import { sourceRegistryPath } from '../src/core/source-registry.ts';
import { sharedDataPath } from '../src/core/olympus-layout.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { createChatGptHandoffs } from '../src/workers/chatgpt/handoff.ts';
import { copyDashboardViewModel, privacyToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { createChatGptSetupBackend, readChatGptPrivacySettings } from '../src/workers/chatgpt/setup-backend.ts';
import { installMainThreadSqlTrace } from '../src/workers/connector-store/main-thread-sql-trace.ts';
import type { SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { heldCountFileIdentity, TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { createEngineFront, engineStatusSnapshotPath } from '../src/workers/engine-split/runtime.ts';
import { ENGINE_STATUS_SNAPSHOT_SCHEMA, engineStatusAge, readEngineStatusSnapshot, writeEngineStatusSnapshot, type EngineStatusSnapshot } from '../src/workers/engine-split/snapshot.ts';
import { gmailItemAccountScope } from '../src/workers/google-connectors/gmail-archive-target.ts';
import { selectCredentialHandle, sourceIndexLaneAccountDecision, SOURCE_REGISTRY_LANE_DECISION } from '../src/workers/engine/runtime/source-lanes.ts';
import { frontHeldItems, heldCountPlan, heldGoogleAccount, heldSourceMountsComplete, measureHeldItems, startHeldItemStatus, type HeldCountPlan } from '../src/workers/engine/held-item-status.ts';
import { STATUS_RECOUNT_MIN_GAP_MS } from '../src/workers/engine/status-recount.ts';
import { createTestClock, flushMicrotasks, waitFor } from './helpers/test-clock.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-held-test-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function snapshot(at: string): EngineStatusSnapshot {
  return {
    schema: ENGINE_STATUS_SNAPSHOT_SCHEMA, instance_id: 'fixture', written_at: at,
    scheduler: null, judge: { backlog: null, pending: null, spending: null }, captures: null,
  };
}
function clockPlan(selection: string): HeldCountPlan {
  return {
    scope: { view: selection, generation: selection }, jobs: [], ledgers: [], files: new Map(),
    cursors: () => '[]', mountsCurrent: () => true, current: () => true,
  };
}

test('held items are absent until one complete pass and keep their own age across heartbeats', async () => {
  const clock = createTestClock();
  const started = clock.date().toISOString();
  const pending = Promise.withResolvers<number>();
  const plan = clockPlan('first');
  const measure = startHeldItemStatus({ plan: () => plan, holds: () => false, now: clock.now, sleep: clock.sleep, measure: () => pending.promise });
  cleanup.push(measure.stop);
  const path = join(scratch(), 'status.json');
  expect(measure.observation()).toBeUndefined();
  expect(frontHeldItems(engineStatusAge(snapshot(started), clock.now()), plan.scope)).toBeUndefined();

  await clock.advance(91_000);
  expect(measure.observation()).toBeUndefined();
  pending.resolve(0);
  await flushMicrotasks();
  const held = measure.observation()!;
  expect(held).toMatchObject({ count: 0, observed_at: started });

  writeEngineStatusSnapshot(path, { ...snapshot(clock.date().toISOString()), heartbeat: 'mtime', held_items: held });
  for (let beat = 0; beat < 3; beat++) {
    await clock.advance(3_000);
    utimesSync(path, clock.date(), clock.date());
    const read = readEngineStatusSnapshot(path, clock.now);
    expect(read?.age_ms).toBe(0);
    expect(frontHeldItems(read, plan.scope)).toEqual({ pendingCount: 0, pendingCountObservedAt: started });
  }
  const stale = readEngineStatusSnapshot(path, () => clock.now() + 31_000);
  expect(frontHeldItems(stale, plan.scope)).toBeUndefined();
});

test('a changed scope drops late work, and a failed start admits the next paced pass', async () => {
  const clock = createTestClock();
  const slow = Promise.withResolvers<number>();
  let plan = clockPlan('old');
  let calls = 0;
  const measurement = startHeldItemStatus({
    plan: () => plan, holds: () => false, now: clock.now, sleep: clock.sleep,
    measure: () => {
      calls += 1;
      if (calls === 1) return slow.promise;
      if (calls === 2) throw new Error('worker did not start');
      return Promise.resolve(7);
    },
  });
  cleanup.push(measurement.stop);
  plan = clockPlan('new');
  slow.resolve(88);
  await flushMicrotasks();
  expect(measurement.observation()).toBeUndefined();
  await clock.advance(STATUS_RECOUNT_MIN_GAP_MS);
  expect(calls).toBe(2);
  expect(measurement.observation()).toBeUndefined();
  await clock.advance(STATUS_RECOUNT_MIN_GAP_MS);
  expect(measurement.observation()).toMatchObject({ count: 7, scope: plan.scope, observed_at: clock.date().toISOString() });
  expect(frontHeldItems(engineStatusAge({ ...snapshot(clock.date().toISOString()), held_items: measurement.observation()! }, clock.now()),
    clockPlan('old').scope)).toBeUndefined();
});

test('the counting handle deduplicates corpora, enforces the selected account and rejects a failed ledger', async () => {
  const root = scratch();
  const dbPath = join(root, 'held.sqlite');
  // A minimal ledger image keeps this read-path test independent of disk fsync
  // during migrations. The split boot fixture also uses the full schema.
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE tier_ledger_meta (key TEXT, value TEXT);
      INSERT INTO tier_ledger_meta VALUES ('ledger_id', 'fixture');
      CREATE TABLE tier_items (provider TEXT, account_scope TEXT, conversation_key TEXT, provider_item_id TEXT,
        state TEXT, metadata_pending INTEGER, content_pending INTEGER, content_read INTEGER);
      CREATE TABLE tier_copies (provider TEXT, account_scope TEXT, conversation_key TEXT, provider_item_id TEXT, corpus_id TEXT);
      INSERT INTO tier_items VALUES ('source', 'selected', '', 'item', 'moving', 0, 1, 1),
        ('source', 'other', '', 'item', 'pending', 1, 0, 0), ('source', 'selected', '', 'unread', 'pending', 0, 1, 0);
      INSERT INTO tier_copies VALUES ('source', 'selected', '', 'item', 'secure'), ('source', 'selected', '', 'item', 'internal'),
        ('source', 'other', '', 'item', 'secure'), ('source', 'selected', '', 'unread', 'secure');
    `);
    writeFileSync(dbPath, db.serialize());
  } finally {
    db.close();
  }

  const ledger = {
    dbPath, statusMount: { file: heldCountFileIdentity(dbPath)!, ledgerId: 'fixture', generation: 'first mount' },
    onClose: () => () => {}, visibilityChangesSince: () => ({ cursor: 1 }),
  };
  const corpus = (corpusId: string) => ({
    corpusId, file: null, generation: null, accountScope: 'selected', current: () => true, mounted: () => true,
  });
  const lanes = [{ ledger, corpusIds: new Set(['secure']) }, { ledger: { ...ledger }, corpusIds: new Set(['internal', 'secure']) }];
  const plan = heldCountPlan(lanes, corpus, 'selection')!;
  expect(plan.jobs).toHaveLength(1);
  expect(plan.jobs[0]?.ledgerId).toBe('fixture');
  expect(await measureHeldItems(plan)).toBe(1);
  // The import wrote `selected` before the account connected as `work`.
  const handle = { handle: 'gmail:account', accountRole: 'work' };
  const retained = heldGoogleAccount(handle, choice => gmailItemAccountScope(
    [{ itemAccountScopes: () => ['selected'] }], choice.accountRole!));
  expect(retained).toBe('selected');
  const planForScope = (accountScope: string) => heldCountPlan(lanes, id => ({ ...corpus(id), accountScope }), 'selection')!;
  expect(await measureHeldItems(planForScope(heldGoogleAccount(handle)!))).toBe(0);
  expect(await measureHeldItems(planForScope(retained!))).toBe(1);
  // With no eligible handle there is no account predicate we can attest.
  const choice = selectCredentialHandle([], { provider: 'google_drive', capability: 'google_drive.docs.sync' });
  const missing = heldGoogleAccount(choice.handle);
  expect(missing).toBeUndefined();
  expect(heldCountPlan(lanes, id => missing === undefined ? undefined : { ...corpus(id), accountScope: missing }, 'selection'))
    .toBeUndefined();
  const missingPath = join(root, 'missing.sqlite');
  const failedPlan = {
    ...plan, jobs: [...plan.jobs, { ...plan.jobs[0]!, path: missingPath }],
  };
  expect(heldCountPlan([{ ledger: { ...ledger, dbPath: missingPath }, corpusIds: new Set(['unreadable']) }], corpus, 'selection')).toBeUndefined();
  const logs: string[] = [];
  const measurement = startHeldItemStatus({ plan: () => failedPlan, holds: () => false, log: line => logs.push(line) });
  cleanup.push(measurement.stop);
  await waitFor(() => logs.some(line => line.includes('status recount failed')));
  expect(measurement.observation()).toBeUndefined();
  renameSync(dbPath, join(root, 'removed.sqlite'));
  // A restored copy has the same ledger ID and a different file generation.
  copyFileSync(join(root, 'removed.sqlite'), dbPath);
  expect(heldCountPlan(lanes, corpus, 'selection')).toBeUndefined();
});

test('a fresh heartbeat from an earlier background boot supplies no held count', async () => {
  const root = scratch();
  const env = { HOME: root, XDG_DATA_HOME: join(root, 'data') };
  const clock = createTestClock();
  const observed_at = clock.date().toISOString();
  const plan = clockPlan('scope');
  const path = engineStatusSnapshotPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const held_items = { count: 17, observed_at, writer_pid: process.pid, scope: plan.scope };
  await clock.advance(2_000);
  const boot = sharedDataPath('boot-progress', env);
  mkdirSync(dirname(boot), { recursive: true });
  writeFileSync(boot, JSON.stringify({
    schema: BOOT_PROGRESS_SCHEMA, phase: 'done', pid: process.pid,
    startedAt: clock.date().toISOString(), updatedAt: clock.date().toISOString(),
  }));
  writeEngineStatusSnapshot(path, { ...snapshot(clock.date().toISOString()), held_items });
  const front = createEngineFront({ env, socketPath: join(root, 'unused.sock'), authToken: 'fixture', now: clock.now, heldView: () => ({ scope: plan.scope }) });
  cleanup.push(front.stop);
  await front.refreshStatus();
  expect(front.status()?.stale).toBe(false);
  expect(front.heldItems()).toBeUndefined();
});

function emptyView(): SourceDashboardViewModel {
  return { kind: 'source_dashboard', generated_at: '2026-11-18T00:00:00.000Z', sources: [] } as unknown as SourceDashboardViewModel;
}

test('a stopped judge still needs the owner when the count is unknown or its zero is older', () => {
  const stopped = { configured: true, ruleCount: 0, judgeStopped: 'failed', judgeStoppedAt: '2026-11-18T00:01:00.000Z' } as const;
  const unknown = copyDashboardViewModel(buildChatGptDashboardViewModel(emptyView(), { privacy: stopped }));
  expect(unknown.privacy).toEqual({ configured: true, ruleCount: 0, judgeStopped: 'failed', judgeStoppedAt: stopped.judgeStoppedAt });
  expect(unknown.needsYou.find(item => item.id === 'privacy:judge_stopped')?.sentence)
    .toContain('not known while judging is stopped (its last pass failed)');
  expect(unknown.needsYou.find(item => item.id === 'privacy:judge_stopped')?.fix.label).toBe('Check the private model');

  const older = { pendingCount: 0, pendingCountObservedAt: '2026-11-18T00:00:00.000Z' };
  const newer = { pendingCount: 0, pendingCountObservedAt: '2026-11-18T00:02:00.000Z' };
  const olderZero = copyDashboardViewModel(buildChatGptDashboardViewModel(emptyView(), {
    now: new Date('2026-11-18T00:03:00.000Z'), privacy: { ...stopped, ...older },
  }));
  expect(olderZero.privacy).toMatchObject(older);
  expect(olderZero.needsYou.find(item => item.id === 'privacy:judge_stopped')?.sentence)
    .toBe('0 items are waiting (as of 3 min ago) because the privacy check stopped: its last pass failed');
  const newerZero = buildChatGptDashboardViewModel(emptyView(), { privacy: { ...stopped, ...newer } });
  expect(newerZero.needsYou.some(item => item.id === 'privacy:judge_stopped')).toBe(false);
});


test('requests read an already bound count without filesystem or SQL work for the count', async () => {
  const root = scratch();
  const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config') };
  const path = engineStatusSnapshotPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const plan = clockPlan('selected');
  let view: { scope: HeldCountPlan['scope']; changedAt?: number } = { scope: plan.scope };
  let alive = true;
  const now = Date.now();
  const observed = new Date(now - 180_000).toISOString();
  const current = snapshot(new Date(now).toISOString());
  const boot = sharedDataPath('boot-progress', env);
  writeFileSync(boot, JSON.stringify({
    schema: BOOT_PROGRESS_SCHEMA, phase: 'done', pid: process.pid, instanceId: current.instance_id,
    startedAt: observed, updatedAt: observed,
  }));
  let time = now;
  const front = createEngineFront({
    env, socketPath: join(root, 'unused.sock'), authToken: 'fixture', now: () => time,
    heldView: () => view, alive: () => alive,
  });
  cleanup.push(front.stop);
  const backend = createChatGptSetupBackend({
    env,
    heldItemCount: front.heldItems,
    workerFetch: async () => new Response(),
    handoffs: createChatGptHandoffs(),
    publicUrls: () => undefined,
    sovereignty: { source: 'inline_config', config: { schemaVersion: 1, modelProfiles: {}, routes: {}, retrieval: { trustDomains: {} } } },
    credentialPresent: () => false,
    requestReload: () => false,
  });
  const unknown = privacyToolResult(backend.privacySettings(), 'current');
  expect(unknown.structuredContent?.pendingCount).toBeUndefined();
  expect(unknown.content[0]?.text).toContain('counting.');
  current.held_items = { count: 0, observed_at: observed, writer_pid: process.pid, scope: plan.scope };
  writeEngineStatusSnapshot(path, current);
  await front.refreshStatus();

  // Profile settings have their own file read; isolate the count read in the
  // two request paths and verify the cached observation does no fs work.
  const count = () => {
    const stats = spyOn(fs, 'statSync');
    const exists = spyOn(fs, 'existsSync');
    const reads = spyOn(fs, 'readFileSync');
    const opens = spyOn(fs, 'openSync');
    try {
      const value = front.heldItems();
      for (const spy of [stats, exists, reads, opens]) expect(spy).not.toHaveBeenCalled();
      return value;
    } finally {
      for (const spy of [stats, exists, reads, opens]) spy.mockRestore();
    }
  };
  installMainThreadSqlTrace();
  watchFrontLoopSql({ mode: 'record' });
  try {
    const expected = { pendingCount: 0, pendingCountObservedAt: observed };
    expect(readChatGptPrivacySettings(env, count())).toMatchObject(expected);
    const result = privacyToolResult(backend.privacySettings(), 'current');
    expect(result.structuredContent).toMatchObject(expected);
    expect(result.content[0]?.text).toContain('0 items wait for the privacy check on the computer (as of 3 min ago).');
    expect(frontLoopSqlHealth()?.statements).toBe(0);

    // A local reopen of the same file cannot keep the cached binding.
    time += 2_000;
    view = { scope: { ...view.scope, generation: 'reopened' }, changedAt: time };
    expect(count()).toBeUndefined();
    await front.refreshStatus();
    expect(count()).toBeUndefined();
    time += 2_000;
    writeEngineStatusSnapshot(path, { ...current, state_at: new Date(time).toISOString() });
    await front.refreshStatus();
    expect(count()).toEqual(expected);
    // The previous instance just died, before the poll can read a new snapshot.
    alive = false;
    expect(front.status()?.snapshot.held_items).toBeUndefined();
    expect(count()).toBeUndefined();
  } finally {
    resetFrontLoopSqlGuardForTests();
  }
});

test('a lane disabled by an unreadable registry still makes a repaired inventory incomplete', () => {
  const env = { HOME: scratch() };
  const path = sourceRegistryPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'unreadable');
  const decision = sourceIndexLaneAccountDecision({ enabled: true, envName: 'fixture', decidedBy: 'fixture' },
    { sourceId: 'local.files' }, env, () => {});
  expect(decision).toMatchObject({ enabled: false, decidedBy: SOURCE_REGISTRY_LANE_DECISION });
  rmSync(path);
  const lanes = [{ id: 'local.files', ...decision, mountBlocked: decision.decidedBy === SOURCE_REGISTRY_LANE_DECISION }];
  const complete = heldSourceMountsComplete(lanes, new Set(), () => true, () => true);
  expect(complete).toBe(false);
  expect(heldCountPlan([], () => undefined, 'selection', complete)).toBeUndefined();
  expect(heldCountPlan([], () => undefined, 'selection', true)?.jobs).toEqual([]);
});

test('an unchanged visibility cursor keeps the original observation without a second COUNT', async () => {
  const clock = createTestClock();
  const plan = clockPlan('scope');
  let cursor = 4;
  plan.cursors = () => String(cursor);
  let calls = 0;
  const job = startHeldItemStatus({
    plan: () => plan, holds: () => false, now: clock.now, sleep: clock.sleep,
    measure: async () => ++calls,
  });
  cleanup.push(job.stop);
  await flushMicrotasks();
  const first = job.observation();
  expect(first?.count).toBe(1);
  await clock.advance(STATUS_RECOUNT_MIN_GAP_MS);
  expect(calls).toBe(1);
  expect(job.observation()).toBe(first);
  cursor++;
  job.check();
  await flushMicrotasks();
  expect(calls).toBe(2);
  expect(job.observation()).toMatchObject({ count: 2, observed_at: clock.date().toISOString() });
});

test('closing or stopping the ledger owner terminates a silent worker and drops the observation', async () => {
  const dbPath = join(scratch(), 'owned.sqlite');
  const oldRole = process.env.OLYMPUS_WORKER_ENGINE_ROLE;
  process.env.OLYMPUS_WORKER_ENGINE_ROLE = 'background';
  cleanup.push(() => {
    if (oldRole === undefined) delete process.env.OLYMPUS_WORKER_ENGINE_ROLE;
    else process.env.OLYMPUS_WORKER_ENGINE_ROLE = oldRole;
  });
  let made = 0;
  let terminated = 0;
  class SilentWorker extends EventTarget {
    onmessage?: (event: { data: number }) => void;
    constructor() { super(); made++; }
    postMessage() {}
    terminate() { terminated++; this.onmessage?.({ data: 98 }); }
  }
  const ledger = new TierLedger({ dbPath });
  const lanes = [{ ledger, corpusIds: new Set(['fixture']) }];
  const corpus = (corpusId: string) => ({
    corpusId, accountScope: null, file: null, generation: null, current: () => true, mounted: () => true,
  });
  const first = heldCountPlan(lanes, corpus, 'selection')!;
  const job = startHeldItemStatus({
    plan: () => heldCountPlan(lanes, corpus, 'selection'), holds: () => false,
    measure: (plan, signal) => measureHeldItems(plan, signal, SilentWorker as unknown as typeof Worker),
  });
  cleanup.push(job.stop);
  expect(made).toBe(1);
  ledger.close();
  expect(first.mountsCurrent()).toBe(false);
  expect(terminated).toBe(1);
  expect(job.observation()).toBeUndefined();
  const reopened = new TierLedger({ dbPath });
  cleanup.push(() => reopened.close());
  const after = heldCountPlan([{ ...lanes[0]!, ledger: reopened }], corpus, 'selection')!;
  expect(after.scope.view).toBe(first.scope.view);
  expect(after.scope.generation).not.toBe(first.scope.generation);
  const second = startHeldItemStatus({
    plan: () => after, holds: () => false,
    measure: (plan, signal) => measureHeldItems(plan, signal, SilentWorker as unknown as typeof Worker),
  });
  second.stop();
  await flushMicrotasks();
  expect(made).toBe(2);
  expect(terminated).toBe(2);
  expect(second.observation()).toBeUndefined();
});
