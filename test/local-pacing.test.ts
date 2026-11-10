// Go easy on this computer (#922): local judging and embedding trickle while
// the owner works, run at full speed when they're away or the computer is
// plugged in overnight, and cloud judging is never held back. Synthetic data
// only; time comes from an injected clock, never a real sleep.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import type { AnalystModel } from '../src/core/analyst.ts';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { appendClassificationLedgerEntry } from '../src/workers/classification-ledger.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { CachedTierSniffer, SNIFFER_PROMPT_VERSION } from '../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { TierSnifferService, type TierSnifferTick } from '../src/workers/classification/sniffer-service.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  GO_EASY_LOCAL_WORK_RECENT_MS,
  GO_EASY_REFRESH_MS,
  embedsOnThisComputer,
  LocalWorkPacer,
  parseLogindIdleSeconds,
  parseMacIdleSeconds,
  parseMacLidOpen,
  parseMacPower,
  readGoEasySetting,
  readLinuxPower,
  systemIdlePowerProbe,
  type IdlePowerReading,
} from '../src/workers/local-pacing.ts';
import { renderJudgeChoice } from '../src/workers/dashboard/pages/local.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { withEmbeddingSweep } from '../src/workers/source-scheduler.ts';
import { BUILT_IN_EMBEDDING_REMOTE_URL_ENV, BuiltInSourceEmbeddingProvider } from '../src/workers/source-index/built-in-embedding/provider.ts';
import { scopeBoundEmbeddingProvider } from '../src/workers/source-scope-runtime.ts';
import { buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-go-easy-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A probe whose reading the test sets; counts reads. */
function fakeProbe(initial: IdlePowerReading) {
  const probe = { reading: initial, reads: 0, async read() { probe.reads += 1; return probe.reading; } };
  return probe;
}

// A weekday afternoon and a night, in the machine's local time.
const AFTERNOON = new Date(2026, 10, 10, 14, 0, 0).getTime();
const NIGHT = new Date(2026, 10, 10, 23, 30, 0).getTime();

async function pacerAt(startMs: number, reading: IdlePowerReading, extra: Partial<ConstructorParameters<typeof LocalWorkPacer>[0]> = {}) {
  const clock = createTestClock(startMs);
  const probe = fakeProbe(reading);
  const pacer = new LocalWorkPacer({ probe, now: () => clock.date(), platform: 'linux', ...extra });
  await pacer.refresh();
  return { clock, probe, pacer };
}

test('a laptop in use trickles; away for five minutes or on AC overnight runs at full speed', async () => {
  const { clock, probe, pacer } = await pacerAt(AFTERNOON, { idleSeconds: 3, power: 'battery' });
  expect(pacer.goEasy()).toBe(true);
  expect(pacer.pace()).toBe('trickle');
  // Plugged in during the day, still in use: still easy.
  probe.reading = { idleSeconds: 3, power: 'ac' };
  await pacer.refresh();
  expect(pacer.pace()).toBe('trickle');
  // Away for five minutes.
  probe.reading = { idleSeconds: 5 * 60, power: 'battery' };
  await pacer.refresh();
  expect(pacer.pace()).toBe('full');
  // Overnight on AC, even with recent input.
  clock.set(NIGHT);
  probe.reading = { idleSeconds: 1, power: 'ac' };
  await pacer.refresh();
  expect(pacer.pace()).toBe('full');
  // Overnight on battery: easy.
  probe.reading = { idleSeconds: 1, power: 'battery' };
  await pacer.refresh();
  expect(pacer.pace()).toBe('trickle');
});

test('a desktop or server with no battery runs at full speed unless the owner turns it on', async () => {
  const dir = tmp();
  const settingPath = join(dir, 'go-easy.json');
  const { pacer, probe } = await pacerAt(AFTERNOON, { power: 'no_battery' }, { settingPath });
  expect(pacer.goEasy()).toBe(false);
  expect(pacer.pace()).toBe('full');
  // Turned on with an idle reading: in use trickles.
  pacer.save(true);
  expect(readGoEasySetting(settingPath)).toBe(true);
  probe.reading = { power: 'no_battery', idleSeconds: 2 };
  await pacer.refresh();
  expect(pacer.pace()).toBe('trickle');
  // Without one nothing says anyone is there.
  probe.reading = { power: 'no_battery' };
  await pacer.refresh();
  expect(pacer.pace()).toBe('full');
  // The choice survives a restart; turning it off is full speed on a laptop too.
  const restarted = new LocalWorkPacer({ probe: fakeProbe({ idleSeconds: 1, power: 'battery' }), settingPath, now: () => new Date(AFTERNOON), platform: 'linux' });
  await restarted.refresh();
  expect(restarted.pace()).toBe('trickle');
  restarted.save(false);
  expect(restarted.pace()).toBe('full');
  expect(readGoEasySetting(settingPath)).toBe(false);
});

test('in the engine split the background reads a choice the front saved', async () => {
  const dir = tmp();
  const settingPath = join(dir, 'go-easy.json');
  const background = new LocalWorkPacer({ probe: fakeProbe({ idleSeconds: 1, power: 'no_battery' }), settingPath, now: () => new Date(AFTERNOON), platform: 'linux' });
  const front = new LocalWorkPacer({ probe: fakeProbe({ idleSeconds: 1, power: 'no_battery' }), settingPath, now: () => new Date(AFTERNOON), platform: 'linux' });
  await background.refresh();
  expect(background.pace()).toBe('full');
  front.save(true);
  expect(background.goEasy()).toBe(false);
  background.reloadSetting();
  expect(background.goEasy()).toBe(true);
  await background.refresh();
  expect(background.pace()).toBe('trickle');
  const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');
  expect(server).toMatch(/if \(engineFront\) void engineFront\.client\.post\(\{ kind: 'reload', target: 'pacing' \}\)/);
  expect(server).toMatch(/if \(target === 'pacing'\) \{ localPacer\.reloadSetting\(\);/);
});

test('the reading is cached for about 30 s, read off the hot path, and a failing probe never throws', async () => {
  const { clock, probe, pacer } = await pacerAt(AFTERNOON, { idleSeconds: 2, power: 'battery' });
  expect(probe.reads).toBe(1);
  for (let i = 0; i < 100; i++) pacer.trickle();
  expect(probe.reads).toBe(1);
  await clock.advance(GO_EASY_REFRESH_MS);
  probe.reading = { idleSeconds: 600, power: 'battery' };
  // The stale reading answers at once; the new one lands in the background.
  expect(pacer.trickle()).toBe(true);
  await flushMicrotasks();
  expect(probe.reads).toBe(2);
  expect(pacer.trickle()).toBe(false);
  const broken = new LocalWorkPacer({ probe: { read: async () => { throw new Error('probe failed'); } }, now: () => clock.date(), platform: 'linux' });
  await broken.refresh();
  expect(broken.pace()).toBe('full');
  // Before any reading: full speed, never a stall.
  expect(new LocalWorkPacer({ probe: fakeProbe({}), now: () => clock.date(), platform: 'linux' }).pace()).toBe('full');
});

test('a Mac on AC with its lid open holds a power assertion only while local work waits', async () => {
  let pending = true;
  let spawned = 0;
  let killed = 0;
  const spawnAssertion = () => { spawned += 1; return { kill() { killed += 1; }, once() { return undefined; } }; };
  const { probe, pacer } = await pacerAt(AFTERNOON, { idleSeconds: 1, power: 'ac', lidOpen: true }, { platform: 'darwin', pendingLocalWork: () => pending, spawnAssertion });
  expect(pacer.holdingAssertion()).toBe(true);
  await pacer.refresh();
  expect(spawned).toBe(1);
  // On battery, lid closed, or no work: released.
  probe.reading = { idleSeconds: 1, power: 'battery', lidOpen: true };
  await pacer.refresh();
  expect(pacer.holdingAssertion()).toBe(false);
  expect(killed).toBe(1);
  probe.reading = { idleSeconds: 1, power: 'ac', lidOpen: false };
  await pacer.refresh();
  expect(pacer.holdingAssertion()).toBe(false);
  probe.reading = { idleSeconds: 1, power: 'ac', lidOpen: true };
  pending = false;
  await pacer.refresh();
  expect(pacer.holdingAssertion()).toBe(false);
  pending = true;
  await pacer.refresh();
  expect(pacer.holdingAssertion()).toBe(true);
  pacer.stop();
  expect(pacer.holdingAssertion()).toBe(false);
  expect(spawned).toBe(2);
  expect(killed).toBe(2);
  // Never on Linux.
  const linux = await pacerAt(AFTERNOON, { idleSeconds: 1, power: 'ac', lidOpen: true }, { platform: 'linux', pendingLocalWork: () => true, spawnAssertion });
  expect(linux.pacer.holdingAssertion()).toBe(false);
});

test('a desktop Mac on mains power holds the power assertion while local work waits (#1126 review)', async () => {
  const spawnAssertion = () => ({ kill() {}, once() { return undefined; } });
  const { pacer } = await pacerAt(AFTERNOON, { idleSeconds: 1, power: 'no_battery' }, { platform: 'darwin', pendingLocalWork: () => true, spawnAssertion });
  expect(pacer.holdingAssertion()).toBe(true);
  pacer.stop();
});

test('embedding a backlog the queue does not list still holds the power assertion, until it goes quiet', async () => {
  // After a restart, missing vectors are found by the sweep, not the in-memory queue (#1126 review).
  let spawned = 0;
  let killed = 0;
  const spawnAssertion = () => { spawned += 1; return { kill() { killed += 1; }, once() { return undefined; } }; };
  const { clock, pacer } = await pacerAt(AFTERNOON, { idleSeconds: 1, power: 'ac', lidOpen: true }, { platform: 'darwin', pendingLocalWork: () => false, spawnAssertion });
  expect(pacer.holdingAssertion()).toBe(false);
  pacer.noteLocalWork();
  expect(pacer.holdingAssertion()).toBe(true);
  await clock.advance(GO_EASY_LOCAL_WORK_RECENT_MS - 1);
  await pacer.refresh();
  expect(pacer.holdingAssertion()).toBe(true);
  await clock.advance(1);
  await pacer.refresh();
  expect(pacer.holdingAssertion()).toBe(false);
  expect([spawned, killed]).toEqual([1, 1]);
});

test('probe parsers read macOS and Linux output, and unknowns stay unknown', async () => {
  expect(parseMacIdleSeconds('|   "HIDIdleTime" = 7500000000')).toBe(7.5);
  expect(parseMacIdleSeconds('nothing here')).toBeUndefined();
  expect(parseMacPower("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;")).toBe('ac');
  expect(parseMacPower("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging;")).toBe('battery');
  expect(parseMacPower("Now drawing from 'AC Power'\n")).toBe('no_battery');
  expect(parseMacPower(undefined)).toBeUndefined();
  expect(parseMacLidOpen('"AppleClamshellState" = No')).toBe(true);
  expect(parseMacLidOpen('"AppleClamshellState" = Yes')).toBe(false);
  expect(parseMacLidOpen('')).toBeUndefined();
  const now = Date.UTC(2026, 10, 10, 12);
  expect(parseLogindIdleSeconds('IdleHint=no\nIdleSinceHint=0\n', now)).toBe(0);
  expect(parseLogindIdleSeconds(`IdleHint=yes\nIdleSinceHint=${(now - 600_000) * 1000}\n`, now)).toBe(600);
  expect(parseLogindIdleSeconds('', now)).toBeUndefined();
  const dir = tmp();
  expect(readLinuxPower(join(dir, 'missing'))).toBe('no_battery');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  for (const [name, type, online] of [['AC', 'Mains', '0'], ['BAT0', 'Battery', undefined]] as const) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'type'), `${type}\n`);
    if (online) writeFileSync(join(dir, name, 'online'), `${online}\n`);
  }
  expect(readLinuxPower(dir)).toBe('battery');
  writeFileSync(join(dir, 'AC', 'online'), '1\n');
  expect(readLinuxPower(dir)).toBe('ac');
  // A probe whose commands fail answers with nothing, never a throw.
  const mac = systemIdlePowerProbe({ platform: 'darwin', exec: async () => undefined });
  expect(await mac.read()).toEqual({});
  const linux = systemIdlePowerProbe({ platform: 'linux', exec: async () => { throw new Error('no loginctl'); }, env: { XDG_SESSION_ID: '3' }, powerSupplyRoot: dir });
  expect(await linux.read()).toEqual({});
});

// --- The judge ----------------------------------------------------------------

const VENICE_LANE: SnifferLane = {
  kind: 'venice', modelId: 'fixture-venice-judge', profileId: 'venice-judge',
  profile: { provider: 'venice', trust: 'encrypted_cloud', model: 'fixture-venice-judge' },
};

function answeringModel(): AnalystModel & { calls: number } {
  const model = {
    calls: 0,
    async complete(request: { prompt: string }) {
      model.calls += 1;
      const items = request.prompt.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { i: number });
      return { text: JSON.stringify({ verdicts: items.map(item => ({ i: item.i, tier: 'private', category: 'health', confidence: 0.9, ownRecord: true, privateKind: 'health' })) }), modelId: 'fixture' };
    },
  };
  return model as unknown as AnalystModel & { calls: number };
}

function flagged(ledger: TierLedger, store: TierSnifferStore, lane: SnifferLane, count: number): void {
  for (let n = 1; n <= count; n++) {
    const subject = { provider: 'fixture', accountScope: 'personal', providerItemId: `item-${n}` };
    ledger.recordDecision(subject, classifyItemTiers({ signals: { title: `lab results ${n}`, labels: ['SSN 123-45-6789'] }, subject }, { sniffer: new CachedTierSniffer(store, lane) }));
  }
}

test('a judge pass makes one call while trickling, and every call otherwise', async () => {
  const dir = tmp();
  const ledger = new TierLedger({ dbPath: join(dir, 'tier.sqlite') });
  const store = new TierSnifferStore({ dbPath: join(dir, 'sniffer.sqlite') });
  cleanup.push(() => { store.close(); ledger.close(); });
  flagged(ledger, store, BUILT_IN_SNIFFER_LANE, 4);
  const model = answeringModel();
  let trickle = true;
  const slow = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: BUILT_IN_SNIFFER_LANE, model, trickle: () => trickle });
  expect(slow).toMatchObject({ calls: 1, stoppedBy: 'pass_budget' });
  trickle = false;
  const full = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: BUILT_IN_SNIFFER_LANE, model, trickle: () => trickle });
  expect(full.calls).toBe(3);
  expect(full.stoppedBy).toBeUndefined();
});

async function serviceFixture(lane: SnifferLane, trickle: () => boolean) {
  const dir = tmp();
  const installed = new InstalledTierClassification({ env: {}, lane });
  const ledger = new TierLedger({ dbPath: join(dir, 'store.tier-ledger.sqlite') });
  cleanup.push(() => { installed.close(); ledger.close(); });
  flagged(ledger, installed.snifferStoreForLedger(ledger.dbPath), lane, 6);
  const classificationLedgerPath = join(dir, 'classification-ledger.jsonl');
  if (lane.kind === 'venice') {
    await appendClassificationLedgerEntry(classificationLedgerPath, {
      recorded_at: new Date(AFTERNOON).toISOString(), kind: 'classifier_model_decision', what: 'Owner approved the fixture judge.',
      model_id: lane.modelId, prompt_version: SNIFFER_PROMPT_VERSION, lane: lane.kind, profile_id: lane.profileId, approved_by: 'owner', status: 'complete',
    });
  }
  const clock = createTestClock(AFTERNOON);
  const model = answeringModel();
  const service = new TierSnifferService({
    installed, lane, model, stores: () => [{ dbPath: join(dir, 'store.sqlite') }], classificationLedgerPath,
    now: () => clock.date(), autoApproveBuiltIn: true, rejudgePerPass: 0,
    pacing: { trickle, trickleGapMs: 20_000 },
  });
  cleanup.push(() => service.stop());
  const scheduled = () => (service as unknown as { scheduledRun(): Promise<TierSnifferTick> }).scheduledRun();
  return { clock, model, service, scheduled };
}

test('the built-in judge trickles while the computer is in use: one call, then a pause', async () => {
  let trickle = true;
  const { clock, model, service, scheduled } = await serviceFixture(BUILT_IN_SNIFFER_LANE, () => trickle);
  expect(await service.runOnce()).toMatchObject({ state: 'ran', report: { calls: 1 } });
  // The next scheduled pass waits out the pause.
  expect(await scheduled()).toEqual({ state: 'skipped_running' });
  await clock.advance(19_000);
  expect(await scheduled()).toEqual({ state: 'skipped_running' });
  expect(model.calls).toBe(1);
  await clock.advance(1_000);
  expect(await scheduled()).toMatchObject({ state: 'ran', report: { calls: 1 } });
  expect(model.calls).toBe(2);
  // The owner walks away: no pause, every waiting item in one pass.
  trickle = false;
  expect(await scheduled()).toMatchObject({ state: 'ran', report: { calls: 4 } });
  expect(model.calls).toBe(6);
});

test('the Venice judge is never paced, even while the computer is in use', async () => {
  const { model, service, scheduled } = await serviceFixture(VENICE_LANE, () => true);
  expect(await service.runOnce()).toMatchObject({ state: 'ran', report: { calls: 6 } });
  expect(model.calls).toBe(6);
  expect((await scheduled()).state).toBe('ran');
});

// --- Embedding ----------------------------------------------------------------

function rawItem(id: string): RawItem {
  return {
    identity: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}`, sourceVersion: `${id}:v1` },
    mimeType: 'text/markdown', content: { kind: 'text', text: `short note ${id}` }, metadata: Object.freeze({ name: id }), fetchedAt: '2026-11-10T00:00:00.000Z',
  };
}

function connector(items: RawItem[]): SourceConnector {
  return {
    id: 'fixture', family: 'file', async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> { return (async function* () { yield { items, done: true }; })(); },
    async fetchItem(localItemId: string) { return items.find(item => item.identity.localItemId === localItemId)!; },
    classificationSignals() { return {}; },
  };
}

test('local embedding embeds one item a pass while trickling, and drains at full speed', async () => {
  const items = Array.from({ length: 5 }, (_, n) => rawItem(`note-${n}`));
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal', tierLedger: null });
  cleanup.push(() => store.close());
  await store.syncFromConnector(connector(items), { fetchContent: true, placement: () => buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }) });
  const provider: SourceEmbeddingProvider = {
    provider: 'built-in', backend: 'local', modelId: 'fixture-embedder', dimension: 2, configHash: 'fixture', epochId: 'fixture',
    async embed(inputs: SourceEmbeddingInput[]) { return inputs.map(() => [1, 0]); },
  };
  store.queueEmbedding(items.map(item => item.identity.localItemId), provider);
  let trickle = true;
  const progress: SourceEmbeddingProvider[] = [];
  const [swept] = withEmbeddingSweep([{ sourceId: 'fixture.files', corpusId: store.corpusId, cadence: 'continuous', intervalMs: 60_000, freshnessThresholdHours: 24, tasks: [] }],
    () => () => [{ store, provider }], { trickle: () => trickle, onProgress: target => { progress.push(target.provider); } });
  const sweep = swept!.tasks.find(task => task.kind === 'embed')!;
  const slow = await sweep.run();
  expect(slow.counts).toMatchObject({ chunks_embedded: 1, items_queued: 4 });
  expect(progress).toEqual([provider]);
  expect(slow.continueSoon).toBeUndefined();
  trickle = false;
  const full = await sweep.run();
  expect(full.counts).toMatchObject({ chunks_embedded: 4, items_queued: 0 });
});

test('a scope-bound built-in embedder is still local work; a remote helper or a cloud embedder is not', () => {
  const local = new BuiltInSourceEmbeddingProvider({ env: {} });
  const remote = new BuiltInSourceEmbeddingProvider({ env: { [BUILT_IN_EMBEDDING_REMOTE_URL_ENV]: 'http://127.0.0.1:9/embed' } });
  const authority = { assertRefCurrent() {} } as unknown as Parameters<typeof scopeBoundEmbeddingProvider>[1];
  const ref = {} as Parameters<typeof scopeBoundEmbeddingProvider>[2];
  expect(embedsOnThisComputer(local)).toBe(true);
  // Approved Gmail and file scopes wrap the provider in a plain object (#1126 review).
  expect(embedsOnThisComputer(scopeBoundEmbeddingProvider(local, authority, ref))).toBe(true);
  expect(embedsOnThisComputer(remote)).toBe(false);
  expect(embedsOnThisComputer(scopeBoundEmbeddingProvider(remote, authority, ref))).toBe(false);
  expect(embedsOnThisComputer({ provider: 'gemini' } as never)).toBe(false);
  expect(embedsOnThisComputer(undefined)).toBe(false);
});

// --- The checkbox -------------------------------------------------------------

test('the checkbox sits under the choice cards, only where the setting exists', () => {
  const judgeSetup = { choice: 'local' as const, capDollars: 0, spentDollars: 0, remainingDollars: 0, stop: null, cloudModel: 'kimi-k3', cloudAvailable: true };
  const view = buildDashboardPreviewView('ready');
  const on = renderJudgeChoice(view, { controlSessionCsrfToken: 'synthetic', judgeSetup, goEasy: true });
  expect(on).toContain('<input type="checkbox" data-go-easy checked> <b>Go easy on this computer</b>');
  expect(on).toContain("Sort at full speed only when you're away or it's plugged in overnight, and slowly while you work. Leave it plugged in and open overnight.");
  expect(on.indexOf('data-go-easy')).toBeGreaterThan(on.indexOf('class="judgeopts"'));
  // Box 3 of the approved mock: straight above the spending limit, below the choices and the Venice note.
  expect(on).toContain('<p class="pnote" data-go-easy-message role="status"></p></div><div class="judgecapbox">');
  expect(renderJudgeChoice(view, { controlSessionCsrfToken: 'synthetic', judgeSetup, goEasy: false })).toContain('<input type="checkbox" data-go-easy> ');
  expect(renderJudgeChoice(view, { controlSessionCsrfToken: 'synthetic', judgeSetup })).not.toContain('data-go-easy');
});

test('ticking the box saves it by itself, and a refused save puts it back', async () => {
  const { Window } = await import('happy-dom');
  const { mountDashboardController } = await import('../src/control-ui/browser-controller.ts');
  const browser = new Window({ url: 'http://localhost/dashboard?keys' });
  const keys = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS', 'HTMLDialogElement'] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: browser[key] });
  cleanup.push(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; } });
  const judgeSetup = { choice: 'local' as const, capDollars: 0, spentDollars: 0, remainingDollars: 0, stop: null, cloudModel: 'kimi-k3', cloudAvailable: true };
  const html = renderJudgeChoice(buildDashboardPreviewView('ready'), { controlSessionCsrfToken: 'synthetic', judgeSetup, goEasy: true });
  const root = document.createElement('div'); root.innerHTML = html; document.body.append(root);
  const calls: unknown[] = [];
  let answer = { status: 200, body: { ok: true, status_message: 'Saved. Olympus sorts at full speed whenever it has work.' } as Record<string, unknown> };
  const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, pollIntervalMs: -1, returnUrl: 'http://localhost/dashboard?keys', navigate() {},
    refresh: async () => ({ status: 200, title: 'Keys', body: html, controller: 'dashboard', can_write: true, signature: 'same', poll_interval_ms: -1 }),
    transport: { control: async params => { calls.push(params); return answer; } },
  });
  cleanup.push(() => controller.dispose());
  const box = root.querySelector<HTMLInputElement>('input[data-go-easy]')!;
  const line = root.querySelector<HTMLElement>('[data-go-easy-message]')!;
  box.click();
  await browser.happyDOM.waitUntilComplete();
  await flushMicrotasks();
  expect(calls).toEqual([{ action: 'set_go_easy', on: false }]);
  expect(box.checked).toBe(false);
  expect(line.textContent).toBe('Saved. Olympus sorts at full speed whenever it has work.');
  answer = { status: 409, body: { ok: false, error: { code: 'go_easy_failed', message: 'The setting could not be saved. Try again.' } } };
  box.click();
  await browser.happyDOM.waitUntilComplete();
  await flushMicrotasks();
  expect(calls.at(-1)).toEqual({ action: 'set_go_easy', on: true });
  expect(box.checked).toBe(false);
  expect(line.textContent).toBe('The setting could not be saved. Try again.');
});
