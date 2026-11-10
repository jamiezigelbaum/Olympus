// This computer, then Venice double-checks (#891). The local judge sorts
// everything; Venice re-reads only what it held Private and frees an item only
// on its own Personal verdict. Items the local judge cleared never reach
// Venice; a cap or 402 keeps the local Private. Synthetic data only.

import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalystModel, AnalystModelRequest } from '../src/core/analyst.ts';
import { JudgeObservations, SecondRoundSweep, observedJudge, secondRoundJudge, OBSERVED_MIN_CALLS, OBSERVED_MIN_VERDICTS } from '../src/workers/classification/judge-second-round.ts';
import { createJudgeSetup } from '../src/workers/classification/judge-setup.ts';
import { JudgeCloudStopped, JudgeSpending, judgeArchiveEstimate, judgeDefaultCapDollars, SECOND_ROUND_HELD_ASSUMPTION } from '../src/workers/classification/judge-spending.ts';
import { resolveJudgeChoiceRuntime } from '../src/workers/classification/built-in-sniffer.ts';
import { readClassificationLedger, isClassifierApproved } from '../src/workers/classification-ledger.ts';
import { CachedTierSniffer, snifferPromptVersions } from '../src/workers/classification/sniffer.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { renderJudgeChoice } from '../src/workers/dashboard/pages/local.ts';
import { buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';
import { createTestClock } from './helpers/test-clock.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

const LOCAL: SnifferLane = { kind: 'local', modelId: 'synthetic-4b', profileId: 'synthetic-4b',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:9/v1', model: 'synthetic-4b' } };
const verdict = (tier: 'personal' | 'private') => JSON.stringify({ verdicts: [tier === 'private'
  ? { i: 1, tier: 'private', category: 'health', confidence: 1, ownRecord: true, privateKind: 'health' }
  : { i: 1, tier: 'personal', category: 'ordinary', confidence: 0.97, ownRecord: false, privateKind: 'none' }] });
/** Holds anything carrying a marker word Private; clears the rest. */
const localJudge = (held: RegExp, prompts: string[] = []): AnalystModel => ({ complete: async (request: AnalystModelRequest) => {
  prompts.push(request.prompt); return { text: verdict(held.test(request.prompt) ? 'private' : 'personal'), modelId: 'synthetic-4b' };
} });
const veniceJudge = (prompts: string[], tier: 'personal' | 'private' = 'personal'): AnalystModel => ({ complete: async (request: AnalystModelRequest) => {
  prompts.push(request.prompt); return { text: verdict(tier), modelId: 'synthetic-venice' };
} });

function lane() {
  const tmp = tempDir('olympus-second-round-');
  const fixture = openTierFixture(tmp.dir, { embed: false });
  const queue = new TierSnifferStore({ dbPath: join(tmp.dir, 'sniffer.sqlite') });
  const set = new TieredStoreSet({ setId: 'second-round', ledger: fixture.ledger, secretLocations: fixture.secrets,
    tierClassification: { sniffer: new CachedTierSniffer(queue, LOCAL) },
    legs: (['internal', 'secure_local'] as const).map(domain => ({ trustDomain: domain, corpusId: CORPORA[domain], store: fixture.stores[domain]! })),
  });
  cleanups.push(() => { queue.close(); fixture.close(); tmp.cleanup(); });
  const pass = (model: AnalystModel) => runSnifferPass({ targets: [{ ledger: fixture.ledger, sniffer: queue, placementFor: decision => set.placementFor(decision) }], lane: LOCAL, model });
  // The decision, whether its move is still queued or already done.
  const tier = (id: string) => { const row = fixture.ledger.getCurrent(identityOf(id)); return row?.state === 'moving' ? row.targetContentTier : row?.contentTier; };
  /** Carries out queued moves, as the service's automatic moves do. */
  const settle = async (...ids: string[]) => {
    for (const id of ids) {
      const row = fixture.ledger.getCurrent(identityOf(id))!;
      if (row.state === 'moving') await moveTieredItem({ set, identity: identityOf(id), target: { metadataTier: row.targetMetadataTier!, contentTier: row.targetContentTier! }, expectedGeneration: row.generation });
    }
  };
  return { ...fixture, set, queue, pass, tier, settle, dir: tmp.dir };
}

test('Venice re-judges only what the local judge held, and frees it only on its own Personal verdict', async () => {
  const f = lane();
  await f.set.sync(fixtureConnector(() => [
    { id: 'held', name: 'Orchid notes', text: 'Heldmarker: patient follow-up and glucose results.' },
    { id: 'cleared', name: 'Fruit reminder', text: 'Clearmarker: please remember bananas for Saturday.' },
  ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const sent: string[] = []; const counts = { asked: 0, released: 0, kept: 0, failed: 0, stopped: 0 };
  await f.pass(secondRoundJudge(localJudge(/Heldmarker/), veniceJudge(sent), counts));
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every(prompt => !prompt.includes('Clearmarker'))).toBe(true);
  expect(sent.some(prompt => prompt.includes('Heldmarker'))).toBe(true);
  expect(f.tier('held')).toBe('private');
  expect(f.tier('cleared')).toBe('private');
  expect(counts.released).toBeGreaterThan(0);
});

test('a Venice Private verdict, a cap stop or a 402 keeps what the local judge held', async () => {
  for (const venice of [
    veniceJudge([], 'private'),
    { complete: async () => { throw new JudgeCloudStopped('cap'); } },
    { complete: async () => { throw new JudgeCloudStopped('payment'); } },
    { complete: async () => { throw new Error('synthetic transport failure'); } },
  ] as AnalystModel[]) {
    const f = lane();
    await f.set.sync(fixtureConnector(() => [{ id: 'held', name: 'Orchid notes', text: 'Heldmarker: patient follow-up.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const report = await f.pass(secondRoundJudge(localJudge(/Heldmarker/), venice));
    expect(report.failedCalls).toBe(0);
    expect(f.tier('held')).toBe('secure');
  }
});

test('choosing the second round later picks up what the local judge already held, once', async () => {
  const f = lane();
  await f.set.sync(fixtureConnector(() => [
    { id: 'earlier', name: 'Orchid notes', text: 'Laterheld: patient follow-up and glucose results.' },
    { id: 'cleared', name: 'Fruit reminder', text: 'Clearmarker: please remember bananas for Saturday.' },
  ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await f.pass(localJudge(/Laterheld/));
  await f.settle('earlier', 'cleared');
  expect(f.tier('earlier')).toBe('secure');
  expect(f.tier('cleared')).toBe('private');
  expect(f.ledger.getCurrent(identityOf('earlier'))?.state).toBe('current');
  const statePath = join(f.dir, 'judge-second-round.json');
  const sweep = new SecondRoundSweep({ statePath, setFor: () => f.set, unanswered: () => 0 });
  expect(await sweep.run(['ledger'], () => true)).toBe(1);
  // Re-opened, not hidden or lowered: it stays exactly where it was until an answer.
  expect(f.tier('earlier')).toBe('secure');
  const sent: string[] = [];
  await f.pass(secondRoundJudge(localJudge(/Laterheld/), veniceJudge(sent)));
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain('Laterheld');
  expect(f.tier('earlier')).toBe('private');
  // The cursor persists: nothing is re-opened again for this choice.
  expect(JSON.parse(readFileSync(statePath, 'utf8')).cursors.ledger).toBe('done');
  expect(await sweep.run(['ledger'], () => true)).toBe(0);
  SecondRoundSweep.reset(statePath);
  expect(existsSync(statePath)).toBe(false);
});

test('the sweep waits while the judge already has enough open questions', async () => {
  const f = lane();
  await f.set.sync(fixtureConnector(() => [{ id: 'earlier', name: 'Orchid notes', text: 'Laterheld: patient follow-up.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await f.pass(localJudge(/Laterheld/));
  await f.settle('earlier');
  const sweep = new SecondRoundSweep({ statePath: join(f.dir, 'state.json'), setFor: () => f.set, unanswered: () => 500 });
  expect(await sweep.run(['ledger'], () => true)).toBe(0);
  expect(f.ledger.secondRoundCandidatePage().records.map(row => row.providerItemId)).toEqual(['earlier']);
});

test('observed speed and held share replace the reference figures only with enough samples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-observed-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = createTestClock();
  const path = join(dir, 'observed.json');
  const observations = new JudgeObservations(path, () => clock.now());
  for (let i = 0; i < OBSERVED_MIN_CALLS - 1; i++) { observations.started(); clock.set(clock.now() + 2_000); observations.finished(i % 4 === 0 ? 'held' : 'personal'); }
  expect(observations.observed()).toEqual({});
  observations.started(); clock.set(clock.now() + 2_000); observations.finished('personal');
  expect(observations.observed().localItemsPerMinute).toBeCloseTo(30);
  expect(observations.observed().heldFraction).toBeUndefined();
  for (let i = OBSERVED_MIN_CALLS; i < OBSERVED_MIN_VERDICTS; i++) { observations.started(); clock.set(clock.now() + 2_000); observations.finished(i % 4 === 0 ? 'held' : 'personal'); }
  expect(observations.observed().heldFraction).toBeCloseTo(0.25, 2);
  observations.save();
  expect(new JudgeObservations(path, () => clock.now()).observed()).toEqual(observations.observed());
});

test('the observing wrapper counts local answers without changing them', async () => {
  const observations = new JudgeObservations();
  const model = observedJudge(localJudge(/Heldmarker/), observations);
  for (let i = 0; i < OBSERVED_MIN_VERDICTS; i++) {
    const reply = await model.complete({ system: 's', prompt: i % 5 === 0 ? 'Heldmarker' : 'ordinary', localOnly: true });
    expect(reply.text).toBe(verdict(i % 5 === 0 ? 'private' : 'personal'));
  }
  expect(observations.observed().heldFraction).toBeCloseTo(0.2, 2);
});

test('estimates use the observed held share or the stated assumption, priced like Venice, with a limit of estimate plus 25%', () => {
  const assumed = judgeArchiveEstimate(54_600, 'qwen3-6-35b-a3b');
  expect(assumed.secondRound.heldFraction).toBe(SECOND_ROUND_HELD_ASSUMPTION);
  expect(assumed.secondRound.observed).toBe(false);
  expect(assumed.secondRound.items).toBe(Math.ceil(54_600 * 0.16));
  expect(assumed.secondRound.dollars!).toBeCloseTo(assumed.cloudDollars! * assumed.secondRound.items / 54_600, 6);
  const observed = judgeArchiveEstimate(54_600, 'qwen3-6-35b-a3b', { heldFraction: 0.08, localItemsPerMinute: 22 });
  expect(observed.secondRound).toMatchObject({ heldFraction: 0.08, observed: true, items: Math.ceil(54_600 * 0.08) });
  expect(observed.measuredHours).toBeCloseTo(54_600 / 22 / 60);
  expect(judgeDefaultCapDollars(8.736)).toBe(11);
  expect(judgeDefaultCapDollars(0.70)).toBe(1);
  expect(judgeDefaultCapDollars(null)).toBe(5);
});

test('the second round spends under the same cap and stops the same way', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-second-cap-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new JudgeSpending(join(dir, 'budget.json'));
  const request = { method: 'POST', body: JSON.stringify({ model: 'qwen3-6-35b-a3b', messages: [{ role: 'user', content: 'synthetic' }], max_completion_tokens: 256 }) };
  let calls = 0;
  const send = budget.fetch(async () => { calls++; return Response.json({ choices: [{ message: { content: 'x' } }] }); });
  budget.choose('local-then-venice', 0.0005);
  await send('https://api.venice.ai/api/v1/chat/completions', request);
  await expect(send('https://api.venice.ai/api/v1/chat/completions', request)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(calls).toBe(1); expect(budget.status().stop).toBe('cap');
  // The primary lane stays local; Venice is only the second round.
  const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
  const runtime = resolveJudgeChoiceRuntime({ engine }, { choice: 'local-then-venice', stop: null, remainingDollars: 5 });
  expect(runtime.source !== 'off' && runtime.lane.kind).toBe('local');
  budget.choose('local', 0);
  await expect(send('https://api.venice.ai/api/v1/chat/completions', request)).rejects.toBeInstanceOf(JudgeCloudStopped);
  expect(calls).toBe(1);
});

test('choosing the second round records consent for both judges and starts its sweep over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-second-setup-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const budget = new JudgeSpending(join(dir, 'budget.json'));
  const engine = createSovereigntyEngine(loadSovereigntyPreset('local-first'));
  const cloud = resolveJudgeChoiceRuntime({ engine }, { choice: 'venice', stop: null, remainingDollars: 1 });
  const local = () => resolveJudgeChoiceRuntime({ engine }, { choice: 'local', stop: null, remainingDollars: 0 });
  const statePath = join(dir, 'judge-second-round.json');
  Bun.write(statePath, JSON.stringify({ v: 1, cursors: { ledger: 'done' } }));
  const ledgerPath = join(dir, 'classification.ledger');
  const setup = createJudgeSetup({ spending: budget, cloud, local, ledgerPath, promptVersion: () => snifferPromptVersions().approval,
    credentialReady: () => true, requestReload: () => true, secondRoundStatePath: statePath, observed: () => ({ heldFraction: 0.1 }) });
  await setup.save('local-then-venice', 2);
  expect(budget.status()).toMatchObject({ choice: 'local-then-venice', capDollars: 2 });
  expect(existsSync(statePath)).toBe(false);
  expect(setup.status().observed).toEqual({ heldFraction: 0.1 });
  const { entries } = await readClassificationLedger(ledgerPath);
  for (const runtime of [cloud, local()]) {
    if (runtime.source === 'off') throw new Error('fixture lanes must resolve');
    expect(isClassifierApproved(entries, { lane: runtime.lane.kind, profileId: runtime.lane.profileId, modelId: runtime.lane.modelId, promptVersion: snifferPromptVersions().approval })).toBe(true);
  }
  // A new limit under the same choice continues the sweep where it was.
  Bun.write(statePath, JSON.stringify({ v: 1, cursors: { ledger: 'done' } }));
  await setup.save('local-then-venice', 1);
  expect(existsSync(statePath)).toBe(true);
  expect(budget.status().capDollars).toBe(1);
  // Without a judge on this computer there is nothing to double-check.
  const noLocal = createJudgeSetup({ spending: budget, cloud, local: () => ({ source: 'off', reason: 'no_private_lane' }), ledgerPath,
    promptVersion: () => snifferPromptVersions().approval, credentialReady: () => true, requestReload: () => true });
  await expect(noLocal.save('local-then-venice', 2)).rejects.toThrow('judge on this computer');
});

test('the screen offers three choices with cents, measured speed, the default limit and the order line', () => {
  const view = buildDashboardPreviewView('ready');
  const base = { choice: 'local' as const, capDollars: 0, spentDollars: 0, remainingDollars: 0, stop: null, cloudModel: 'qwen3-6-35b-a3b', cloudAvailable: true };
  const html = renderJudgeChoice(view, { controlSessionCsrfToken: 'synthetic', judgeSetup: { ...base, observed: { localItemsPerMinute: 22 } } });
  expect(html).toContain('value="local-then-venice"');
  expect(html).toContain('This computer, then Venice double-checks');
  expect(html).toContain('Venice sorts everything');
  expect(html).toContain('Measured on this computer: 22 items a minute');
  expect(html).toContain('items most likely to be Private');
  expect(html).toContain('Items you ask about are sorted first, so a question finds them within minutes. Then the newest items, taking turns between your sources.');
  expect(html).toContain('Set to the estimate plus 25%.');
  expect(html).toMatch(/data-cap-local-then-venice="\d+" data-cap-venice="\d+"/);
  // Money to the cent, never fractions of one.
  expect(html).not.toMatch(/\$\d+\.\d{3}/);
  // Without enough samples the reference machine is named as such.
  const unmeasured = renderJudgeChoice(view, { controlSessionCsrfToken: 'synthetic', judgeSetup: base });
  expect(unmeasured).toContain('not on this computer yet');
  expect(unmeasured).toContain('a test on labelled items');
  // The owner's own limit wins over the default once a Venice choice is in use.
  const own = renderJudgeChoice(view, { controlSessionCsrfToken: 'synthetic', judgeSetup: { ...base, choice: 'local-then-venice', capDollars: 3, remainingDollars: 3 } });
  expect(own).toContain('name="cap_dollars" min="0" step="0.01" value="3"');
  expect(own).not.toContain('data-cap-auto');
  expect(own).toContain('Spent or reserved: $0.00. Remaining: $3.00.');
});

test('a fresh install with no items still has a usable limit for the double-check (#1136 review)', () => {
  const view = buildDashboardPreviewView('ready'); view.sources.forEach(source => { source.coverage.stored_items = 0; source.coverage.indexed_items = 0; });
  const html = renderJudgeChoice(view, { controlSessionCsrfToken: 'synthetic', judgeSetup: { choice: 'local', capDollars: 0, spentDollars: 0, remainingDollars: 0, stop: null, cloudModel: 'qwen3-6-35b-a3b', cloudAvailable: true } });
  const value = html.match(/name="cap_dollars" min="0" step="0.01" value="([^"]*)"/)?.[1];
  expect(Number(value)).toBeGreaterThan(0);
  expect(html).toMatch(/data-cap-local-then-venice="[1-9]\d*"/);
  expect(html).toMatch(/data-judge-dialog="local-then-venice"[\s\S]*data-judge-cap-echo/);
  // A price-less estimate falls back to a small stated floor, never an empty limit.
  expect(judgeDefaultCapDollars(null)).toBe(5);
});

test('the confirmation states the limit the owner typed, not the saved one (#1136 review)', async () => {
  const { Window } = await import('happy-dom');
  const { mountDashboardController } = await import('../src/control-ui/browser-controller.ts');
  const browser = new Window({ url: 'http://localhost/dashboard?keys' });
  const keys = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS', 'HTMLDialogElement'] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: browser[key] });
  let dispose = () => {};
  try {
    const html = renderJudgeChoice(buildDashboardPreviewView('ready'), { controlSessionCsrfToken: 'synthetic', judgeSetup: { choice: 'local-then-venice', capDollars: 3, spentDollars: 0, remainingDollars: 3, stop: null, cloudModel: 'qwen3-6-35b-a3b', cloudAvailable: true } });
    const root = document.createElement('div'); root.innerHTML = html; document.body.append(root);
    const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, pollIntervalMs: -1, returnUrl: 'http://localhost/dashboard?keys', navigate() {},
      refresh: async () => ({ status: 200, title: 'Keys', body: html, controller: 'dashboard', can_write: true, signature: html, poll_interval_ms: -1 }),
      transport: { control: async () => ({ status: 200, body: { ok: true, status_message: 'Saved' } }) },
    }); dispose = () => controller.dispose();
    const cap = root.querySelector<HTMLInputElement>('input[name="cap_dollars"]')!;
    cap.value = '300'; cap.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLInputElement>('input[value="venice"]')!.click();
    const confirm = root.querySelector<HTMLDialogElement>('dialog[data-judge-dialog="venice"]')!;
    expect(confirm.open).toBe(true);
    expect(confirm.querySelector('[data-judge-cap-echo]')!.textContent).toBe('$300.00');
  } finally {
    dispose(); browser.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
  }
});
