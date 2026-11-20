import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { BOOT_PROGRESS_SCHEMA } from '../src/core/boot-progress.ts';
import { sharedDataPath } from '../src/core/olympus-layout.ts';
import { sourceRegistryPath } from '../src/core/source-registry.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { createChatGptHandoffs } from '../src/workers/chatgpt/handoff.ts';
import { copyDashboardViewModel, privacyToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { createChatGptSetupBackend } from '../src/workers/chatgpt/setup-backend.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { createEngineFront, engineStatusSnapshotPath } from '../src/workers/engine-split/runtime.ts';
import { ENGINE_STATUS_SNAPSHOT_SCHEMA, readEngineStatusSnapshot, writeEngineStatusSnapshot, type EngineStatusSnapshot } from '../src/workers/engine-split/snapshot.ts';
import { countHeldItems } from '../src/workers/engine/held-item-count.ts';
import { measureHeldItems, startHeldItemStatus, type HeldInventory, type HeldSample } from '../src/workers/engine/held-item-status.ts';
import { STATUS_RECOUNT_MIN_GAP_MS } from '../src/workers/engine/status-recount.ts';
import { sourceIndexLaneAccountDecision, SOURCE_REGISTRY_LANE_DECISION } from '../src/workers/engine/runtime/source-lanes.ts';
import type { SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { seedHeldLedger } from './helpers/held-item-fixture.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function scratch() {
  const root = fs.mkdtempSync('/tmp/olympus-held-test-');
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function environment(root: string) {
  const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: join(root, 'handles.json') };
  for (const [key, value] of Object.entries(env)) {
    const before = process.env[key];
    cleanup.push(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
    process.env[key] = value;
  }
  return env;
}
const emptyInventory = (): HeldInventory => ({ stores: [], pending: [], mountProblems: [], gmailStores: [] });
const date = '2026-11-18T00:16:00.000Z';
const observed = (count: number, observed_at: string, counted_scope: HeldSample['observation']['counted_scope'] = []): HeldSample =>
  ({ observation: { count, observed_at, counted_scope }, groups: [] });
const measure = (inventory: HeldInventory, previous?: HeldSample) => measureHeldItems(
  { inventory, observed_at: date, ...(previous ? { previous } : {}) }, new AbortController().signal, () => {},
);
function snapshot(at: string): EngineStatusSnapshot {
  return { schema: ENGINE_STATUS_SNAPSHOT_SCHEMA, instance_id: 'fixture', written_at: at,
    scheduler: null, judge: { backlog: null, pending: null, spending: null }, captures: null };
}
function storeAt(path: string) {
  const db = new Database(path);
  db.exec('CREATE TABLE items (provider TEXT, account_scope TEXT); CREATE TABLE sync_runs (sync_run_id TEXT, connector_id TEXT, cursor TEXT)');
  cleanup.push(() => db.close());
  return db;
}

test('the same Gmail handle counts its single retained account across both corpora once and Dropbox excludes its ingestion fallback', async () => {
  const root = scratch();
  const env = environment(root);
  fs.writeFileSync(env.OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH, JSON.stringify({
    version: 1, handles: [{ handle: 'gmail.work.delegated', provider: 'gmail', connectedAt: date,
      accountRole: 'work', allowedCapabilities: ['gmail.email.sync'] }],
  }));
  const path = join(root, 'count.sqlite');
  const ledger = seedHeldLedger(path, ['gmail.a', 'gmail.b', 'dropbox'], ['first', 'second', 'fallback', 'work']);
  cleanup.push(() => ledger.close());
  // The retained second account has already left the backlog.
  const db = new Database(path);
  db.exec("UPDATE tier_items SET metadata_pending = 0 WHERE account_scope = 'second'");
  db.close();

  const inventory = emptyInventory();
  const gmail = { credential: { provider: 'gmail', capability: 'gmail.email.sync', pin: 'UNUSED' }, gmail: true } as const;
  const a = join(root, 'a.sqlite');
  const b = join(root, 'b.sqlite');
  const mailA = storeAt(a);
  const mailB = storeAt(b);
  inventory.gmailStores = [a, b];
  inventory.stores.push(
    { corpusId: 'gmail.a', sourceId: 'gmail.email', dbPath: a, ledgerPath: path, read: gmail },
    { corpusId: 'gmail.b', sourceId: 'gmail.email', dbPath: b, ledgerPath: path, read: gmail },
    { corpusId: 'dropbox', sourceId: 'dropbox.files', dbPath: join(root, 'dropbox.sqlite'), ledgerPath: path,
      read: { credential: { provider: 'dropbox', capability: 'dropbox.files.sync', pin: 'UNUSED' } } },
  );
  storeAt(inventory.stores[2]!.dbPath);
  const fallback = process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_ACCOUNT;
  cleanup.push(() => { if (fallback === undefined) delete process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_ACCOUNT; else process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_ACCOUNT = fallback; });
  process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_ACCOUNT = 'fallback';
  mailA.exec("INSERT INTO items VALUES ('gmail', 'first')");
  const first = await measure(inventory);
  expect(first?.observation).toEqual(observed(1, date, ['gmail.a', 'gmail.b'].map(corpusId => ({ corpusId, accountScope: 'first' }))).observation);
  mailA.exec('DELETE FROM items');
  mailB.exec("INSERT INTO items VALUES ('gmail', 'second')");
  expect((await measure(inventory, first))?.observation)
    .toEqual(observed(0, date, ['gmail.a', 'gmail.b'].map(corpusId => ({ corpusId, accountScope: 'second' }))).observation);
  mailA.exec("INSERT INTO items VALUES ('gmail', 'first')");
  expect((await measure(inventory))?.observation)
    .toEqual(observed(1, date, ['gmail.a', 'gmail.b'].map(corpusId => ({ corpusId, accountScope: 'work' }))).observation);
});

test('legacy contributes zero, a missing bound ledger makes the whole sample absent, and recovery measures the same corpus', async () => {
  const root = scratch();
  environment(root);
  const inventory = emptyInventory();
  expect((await measure(inventory))?.observation).toEqual(observed(0, date).observation);
  const dbPath = join(root, 'store.sqlite');
  const db = storeAt(dbPath);
  const corpus = { corpusId: 'fixture.corpus', accountScope: null };
  inventory.stores.push({ corpusId: corpus.corpusId, sourceId: 'fixture', dbPath, read: { accountScope: null } });
  const legacy = await measure(inventory);
  expect(legacy?.observation).toEqual(observed(0, date).observation);
  const fallbackPath = tierLedgerPathForStore(dbPath);
  const ledger = seedHeldLedger(fallbackPath, [corpus.corpusId], ['personal']);
  cleanup.push(() => ledger.close());
  expect((await measure(inventory, legacy))?.observation).toEqual(observed(1, date, [corpus]).observation);
  const future = join(root, 'future.sqlite');
  db.query('INSERT INTO sync_runs VALUES (?, ?, ?)').run('tiered-store-set-binding', 'tiered_store_set_binding',
    JSON.stringify({ ledgerPath: future, ledgerId: ledger.ledgerId() }));
  expect(await measure(inventory)).toBeUndefined();
  ledger.close();
  fs.renameSync(fallbackPath, future);
  expect((await measure(inventory))?.observation).toEqual(observed(1, date, [corpus]).observation);
});

test('an unreadable registry cannot look like a positively empty disabled inventory', async () => {
  const env = environment(scratch());
  const path = sourceRegistryPath(env);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, 'unreadable');
  const lane = sourceIndexLaneAccountDecision({ enabled: true, envName: 'fixture', decidedBy: 'fixture' },
    { sourceId: 'local.files' }, env, () => {});
  expect(lane).toMatchObject({ enabled: false, decidedBy: SOURCE_REGISTRY_LANE_DECISION });
  expect(await measure(emptyInventory())).toBeUndefined();
  fs.rmSync(path);
  expect(await measure({ ...emptyInventory(), pending: [{ id: 'local.files', stores: [], mountBlocked: true }] })).toBeUndefined();
  expect((await measure(emptyInventory()))?.observation).toEqual(observed(0, date).observation);
});

test('a delayed count keeps the original date and remains the only job while heartbeats continue', async () => {
  const clock = createTestClock();
  const started = clock.date().toISOString();
  const pending = Promise.withResolvers<HeldSample>();
  const path = join(scratch(), 'status.json');
  let calls = 0;
  let signal!: AbortSignal;
  const job = startHeldItemStatus({ inventory: emptyInventory, holds: () => false, now: clock.now, sleep: clock.sleep,
    measure: (pass, running) => {
      calls++; signal = running;
      expect(pass.observed_at).toBe(started);
      return pending.promise;
    },
  });
  cleanup.push(job.stop);
  for (let beat = 0; beat < 31; beat++) {
    await clock.advance(3_000);
    job.soon();
    writeEngineStatusSnapshot(path, { ...snapshot(clock.date().toISOString()), heartbeat: 'mtime' });
    fs.utimesSync(path, clock.date(), clock.date());
    expect(readEngineStatusSnapshot(path, clock.now)?.snapshot.held_items).toBeUndefined();
    expect(job.observation()).toBeUndefined();
  }
  expect(calls).toBe(1);
  expect(signal.aborted).toBe(false);
  pending.resolve(observed(0, started));
  await flushMicrotasks();
  const held = job.observation()!;
  expect(held).toEqual(observed(0, started).observation);
  writeEngineStatusSnapshot(path, { ...snapshot(clock.date().toISOString()), heartbeat: 'mtime', held_items: held });
  await clock.advance(3_000);
  fs.utimesSync(path, clock.date(), clock.date());
  expect(readEngineStatusSnapshot(path, clock.now)).toMatchObject({ age_ms: 0, snapshot: { held_items: held } });
});

test('an invalidated scope discards late work, and failure can recover on the next paced pass', async () => {
  const clock = createTestClock();
  const slow = Promise.withResolvers<HeldSample>();
  const inventory = emptyInventory();
  let calls = 0;
  const job = startHeldItemStatus({ inventory: () => inventory, holds: () => false, now: clock.now, sleep: clock.sleep,
    measure: async (pass) => {
      calls++;
      if (calls === 1) return slow.promise;
      if (calls === 2) throw new Error('fixture worker failure');
      expect(pass.inventory.stores[0]?.read).toEqual({ accountScope: 'new' });
      return observed(7, pass.observed_at);
    },
  });
  cleanup.push(job.stop);
  inventory.stores.push({ corpusId: 'fixture', sourceId: 'fixture', dbPath: 'fixture', read: { accountScope: 'new' } });
  job.invalidate();
  slow.resolve(observed(9, date));
  await flushMicrotasks();
  expect(job.observation()).toBeUndefined();
  await clock.advance(STATUS_RECOUNT_MIN_GAP_MS);
  expect(calls).toBe(3);
  expect(job.observation()?.count).toBe(7);
});

test('an unchanged scope and visibility cursor do not issue a second COUNT or restamp the observation', () => {
  const root = scratch();
  environment(root);
  const dbPath = join(root, 'store.sqlite');
  storeAt(dbPath);
  const path = tierLedgerPathForStore(dbPath);
  const ledger = seedHeldLedger(path, ['fixture'], ['personal']);
  cleanup.push(() => ledger.close());
  const inventory = emptyInventory();
  inventory.stores.push({ corpusId: 'fixture', sourceId: 'fixture', dbPath, read: { accountScope: null } });
  const sql = spyOn(Database.prototype, 'query');
  try {
    const pass = { inventory, observed_at: date };
    const first = countHeldItems(pass, () => {})!;
    expect(first.observation).toEqual(observed(1, date, [{ corpusId: 'fixture', accountScope: null }]).observation);
    const countCalls = () => sql.mock.calls.filter(([query]) => /COUNT\(\*\) AS n FROM tier_items t/.test(query)).length;
    expect(countCalls()).toBe(1);
    expect(countHeldItems({ ...pass, previous: first, observed_at: '2026-11-18T00:17:00Z' }, () => {})).toBe(first);
    expect(countCalls()).toBe(1);
    const db = new Database(path);
    try { db.exec("UPDATE tier_items SET state = 'current'"); } finally { db.close(); }
    expect(countHeldItems({ ...pass, previous: first, observed_at: '2026-11-18T00:18:00Z' }, () => {})?.observation)
      .toMatchObject({ count: 0, observed_at: '2026-11-18T00:18:00Z' });
    expect(countCalls()).toBe(2);
  } finally { sql.mockRestore(); }
});

test('closing the owner or shutting the writer down cancels its one worker and drops late work', async () => {
  const path = join(scratch(), 'owned.sqlite');
  let made = 0;
  let terminated = 0;
  class SilentWorker extends EventTarget {
    onmessage?: (event: { data: HeldSample }) => void;
    constructor() { super(); made++; }
    postMessage() {}
    terminate() { terminated++; this.onmessage?.({ data: observed(98, date) }); }
  }
  const ledger = new TierLedger({ dbPath: path });
  const run = () => startHeldItemStatus({ inventory: emptyInventory, holds: () => false,
    measure: (pass, signal, changed) => measureHeldItems(pass, signal, changed, SilentWorker as unknown as typeof Worker),
  });
  const job = run();
  cleanup.push(job.stop);
  ledger.onClose(job.closed);
  expect(made).toBe(1);
  ledger.close();
  expect(terminated).toBe(1);
  expect(job.observation()).toBeUndefined();
  const second = run();
  second.stop();
  await flushMicrotasks();
  expect(made).toBe(2);
  expect(terminated).toBe(2);
  expect(second.observation()).toBeUndefined();
});

test('the front serves only a valid observation from the current ready writer, with no request-side file read', async () => {
  const root = scratch();
  const env = { HOME: root, XDG_DATA_HOME: join(root, 'data') };
  const clock = createTestClock(Date.parse(date));
  const path = engineStatusSnapshotPath(env);
  const boot = sharedDataPath('boot-progress', env);
  fs.mkdirSync(dirname(boot), { recursive: true });
  fs.mkdirSync(dirname(path), { recursive: true });
  let alive = true;
  const front = createEngineFront({ env, socketPath: join(root, 'unused.sock'), authToken: 'fixture', now: clock.now, alive: () => alive });
  cleanup.push(front.stop);
  const backend = createChatGptSetupBackend({
    env, heldItemCount: front.heldItems, workerFetch: async () => new Response(),
    handoffs: createChatGptHandoffs(), publicUrls: () => undefined,
    sovereignty: { source: 'inline_config', config: { schemaVersion: 1, modelProfiles: {}, routes: {}, retrieval: { trustDomains: {} } } },
    credentialPresent: () => false, requestReload: () => false,
  });
  const publish = async (value: Partial<HeldSample['observation']>, writer = 'fixture', startedAt = date) => {
    await clock.advance(2_000);
    fs.writeFileSync(boot, JSON.stringify({ schema: BOOT_PROGRESS_SCHEMA, phase: 'done', pid: process.pid,
      instanceId: writer, startedAt, updatedAt: clock.date().toISOString() }));
    writeEngineStatusSnapshot(path, { ...snapshot(clock.date().toISOString()), held_items: value as HeldSample['observation'] });
    await front.refreshStatus();
  };
  const current = observed(0, date).observation;
  await publish(current, 'successor');
  expect(front.heldItems()).toBeUndefined();
  await publish(current, 'fixture', new Date(Date.parse(date) + 1_000).toISOString());
  expect(front.heldItems()).toBeUndefined();
  await publish({ count: 0 });
  expect(front.heldItems()).toBeUndefined();
  await publish({ ...current, count: -1 });
  expect(front.heldItems()).toBeUndefined();
  expect(privacyToolResult(backend.privacySettings(), 'current').content[0]?.text).toContain('counting.');
  await publish(current);
  const fsSpies = [spyOn(fs, 'statSync'), spyOn(fs, 'existsSync'), spyOn(fs, 'readFileSync'), spyOn(fs, 'openSync')];
  try {
    expect(front.heldItems()).toEqual({ pendingCount: 0, pendingCountObservedAt: date });
    for (const spy of fsSpies) expect(spy).not.toHaveBeenCalled();
  } finally { for (const spy of fsSpies) spy.mockRestore(); }
  expect(backend.privacySettings()).toMatchObject({ pendingCount: 0, pendingCountObservedAt: date });
  alive = false;
  expect(front.heldItems()).toBeUndefined();
});

test('the judge action survives a zero sniffer backlog and absent, zero and positive held counts', async () => {
  const root = scratch();
  const installed = new InstalledTierClassification({ env: {}, lane: BUILT_IN_SNIFFER_LANE });
  cleanup.push(() => installed.close());
  let fail = true;
  const judge = new TierSnifferService({
    installed, lane: BUILT_IN_SNIFFER_LANE, autoApproveBuiltIn: true, classificationLedgerPath: join(root, 'judge.jsonl'),
    model: { async complete() { throw new Error('an empty backlog must not infer'); } },
    stores: () => { if (fail) throw new Error('fixture pass failure'); return []; },
  });
  cleanup.push(() => judge.stop());
  expect(await judge.runOnce()).toMatchObject({ state: 'failed' });
  fail = false;
  expect(judge.backlog()).toMatchObject({ checkingItems: 0 });
  expect(judge.backlog().waiting).toBeUndefined();
  expect(judge.actionableStop()).toBe('failed');
  const view = { generated_at: date, sources: [] } as unknown as SourceDashboardViewModel;
  const running = { configured: true, ruleCount: 0 };
  for (const counts of [{}, { pendingCount: 0 }, { pendingCount: 17 }]) {
    const privacy = { ...running, ...counts, judgeStopped: judge.actionableStop()! };
    const dashboard = copyDashboardViewModel(buildChatGptDashboardViewModel(view, { privacy }));
    expect(dashboard.privacy).toMatchObject(privacy);
    expect(dashboard.needsYou.find(item => item.id === 'privacy:judge_stopped')).toMatchObject({
      sentence: 'its last pass failed', fix: { label: 'Check the private model' },
    });
  }
  expect(await judge.runOnce()).toMatchObject({ state: 'ran' });
  expect(judge.actionableStop()).toBeUndefined();
  const recovered = buildChatGptDashboardViewModel(view, { privacy: running });
  expect(recovered.needsYou.some(item => item.id === 'privacy:judge_stopped')).toBe(false);
});
