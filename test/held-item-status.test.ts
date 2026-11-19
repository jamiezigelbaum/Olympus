import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BOOT_PROGRESS_SCHEMA } from '../src/core/boot-progress.ts';
import { frontLoopSqlHealth, resetFrontLoopSqlGuardForTests, watchFrontLoopSql } from '../src/core/front-loop-sql-guard.ts';
import { sharedDataPath } from '../src/core/olympus-layout.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { createChatGptHandoffs } from '../src/workers/chatgpt/handoff.ts';
import { copyDashboardViewModel, privacyToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { createChatGptSetupBackend, readChatGptPrivacySettings } from '../src/workers/chatgpt/setup-backend.ts';
import { installMainThreadSqlTrace } from '../src/workers/connector-store/main-thread-sql-trace.ts';
import type { SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { heldCountFileIdentity } from '../src/workers/classification/tier-ledger.ts';
import { createEngineFront, engineStatusSnapshotPath } from '../src/workers/engine-split/runtime.ts';
import { ENGINE_STATUS_SNAPSHOT_SCHEMA, engineStatusAge, readEngineStatusSnapshot, writeEngineStatusSnapshot, type EngineStatusSnapshot } from '../src/workers/engine-split/snapshot.ts';
import { frontHeldItems, heldCountPlan, measureHeldItems, startHeldItemStatus, type HeldCountPlan } from '../src/workers/engine/held-item-status.ts';
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
  return { scope: { selection, ledgers: [] }, paths: [] };
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
  expect(frontHeldItems(engineStatusAge(snapshot(started), clock.now()), () => plan)).toBeUndefined();

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
    expect(frontHeldItems(read, () => plan)).toEqual({ pendingCount: 0, pendingCountObservedAt: started });
  }
  const stale = readEngineStatusSnapshot(path, () => clock.now() + 31_000);
  expect(frontHeldItems(stale, () => plan)).toBeUndefined();
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
    () => clockPlan('old'))).toBeUndefined();
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

  const ledger = { dbPath, statusMount: { file: heldCountFileIdentity(dbPath)!, ledgerId: 'fixture' } };
  const corpus = (corpusId: string) => ({ corpusId, mount: null, accountScope: 'selected' });
  const lanes = [{ ledger, corpusIds: new Set(['secure']) }, { ledger: { ...ledger }, corpusIds: new Set(['internal', 'secure']) }];
  const plan = heldCountPlan(lanes, corpus, 'selection')!;
  expect(plan.scope.ledgers).toHaveLength(1);
  expect(plan.scope.ledgers[0]?.ledgerId).toBe('fixture');
  expect(await measureHeldItems(plan)).toBe(1);
  const missingPath = join(root, 'missing.sqlite');
  const failedPlan = {
    scope: { ...plan.scope, ledgers: [...plan.scope.ledgers, { ...plan.scope.ledgers[0]!, ledgerId: 'missing' }] },
    paths: [...plan.paths, missingPath],
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
}, 20_000);

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
  const front = createEngineFront({ env, socketPath: join(root, 'unused.sock'), authToken: 'fixture', now: clock.now });
  cleanup.push(front.stop);
  await front.refreshStatus();
  expect(front.status()?.stale).toBe(false);
  expect(frontHeldItems(front.status(), () => plan)).toBeUndefined();
});

function emptyView(): SourceDashboardViewModel {
  return { kind: 'source_dashboard', generated_at: '2026-11-18T00:00:00.000Z', sources: [] } as unknown as SourceDashboardViewModel;
}

test('a stopped judge still needs the owner when the count is unknown or its zero is older', () => {
  const stopped = { configured: true, ruleCount: 0, judgeStopped: 'failed', judgeStoppedAt: '2026-11-18T00:01:00.000Z' } as const;
  const unknown = copyDashboardViewModel(buildChatGptDashboardViewModel(emptyView(), { privacy: stopped }));
  expect(unknown.privacy).toEqual({ configured: true, ruleCount: 0 });
  expect(unknown.needsYou.find(item => item.id === 'privacy:judge_stopped')?.fix.label).toBe('Check the private model');

  const older = { pendingCount: 0, pendingCountObservedAt: '2026-11-18T00:00:00.000Z' };
  const newer = { pendingCount: 0, pendingCountObservedAt: '2026-11-18T00:02:00.000Z' };
  const olderZero = copyDashboardViewModel(buildChatGptDashboardViewModel(emptyView(), { privacy: { ...stopped, ...older } }));
  expect(olderZero.privacy).toMatchObject(older);
  expect(olderZero.needsYou.some(item => item.id === 'privacy:judge_stopped')).toBe(true);
  const newerZero = buildChatGptDashboardViewModel(emptyView(), { privacy: { ...stopped, ...newer } });
  expect(newerZero.needsYou.some(item => item.id === 'privacy:judge_stopped')).toBe(false);
});


test('front dashboard and setup reads use the same observation without a loop SQL statement', () => {
  const plan = clockPlan('selected');
  const observed = '2026-11-18T00:00:00.000Z';
  const current = snapshot(observed);
  const count = () => frontHeldItems(engineStatusAge(current, Date.parse(observed)), () => plan);
  const backend = createChatGptSetupBackend({
    heldItemCount: count,
    workerFetch: async () => new Response(),
    handoffs: createChatGptHandoffs(),
    publicUrls: () => undefined,
    sovereignty: { source: 'inline_config', config: { schemaVersion: 1, modelProfiles: {}, routes: {}, retrieval: { trustDomains: {} } } },
    credentialPresent: () => false,
    requestReload: () => false,
  });

  installMainThreadSqlTrace();
  watchFrontLoopSql({ mode: 'record' });
  try {
    expect(readChatGptPrivacySettings(process.env, count()).pendingCount).toBeUndefined();
    expect(privacyToolResult(backend.privacySettings(), 'current').structuredContent?.pendingCount).toBeUndefined();
    current.held_items = { count: 5, observed_at: observed, writer_pid: process.pid, scope: plan.scope };
    const expected = { pendingCount: 5, pendingCountObservedAt: observed };
    expect(readChatGptPrivacySettings(process.env, count())).toMatchObject(expected);
    expect(privacyToolResult(backend.privacySettings(), 'current').structuredContent).toMatchObject(expected);
    expect(frontLoopSqlHealth()?.statements).toBe(0);
  } finally {
    resetFrontLoopSqlGuardForTests();
  }
});
