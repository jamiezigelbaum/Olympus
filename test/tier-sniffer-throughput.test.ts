// Where the sniffer's time goes between verdicts (#893): live judging reached
// about half the verdicts a minute of a sequential replay on the same model
// server. Each pass and each tick now say how their time divides between
// waiting for a pass, yielding, dispatch work and the model, and the parts
// must add up to the time that passed. Every clock here is the test clock.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import type { AnalystModel, AnalystModelRequest } from '../src/core/analyst.ts';
import { appendClassificationLedgerEntry } from '../src/workers/classification-ledger.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { CachedTierSniffer, SNIFFER_PROMPT_VERSION } from '../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { completeAfterSlot, runSnifferPass, slotWaitOf } from '../src/workers/classification/sniffer-resolver.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

const LANE: SnifferLane = {
  kind: 'local',
  modelId: 'fixture-local-sniffer',
  profileId: 'local-sniffer',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-local-sniffer' },
};

const MODEL_MS = 200;
const SLOT_WAIT_MS = 30;
const SCREEN_MS = 7;

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function subject(n: number) {
  return { provider: 'fixture', accountScope: 'personal', providerItemId: `item-${n}` };
}

/** A flagged item whose names and excerpt are both asked: Personal names leave the excerpt open. */
function recordNamesAndExcerpt(ledger: TierLedger, store: TierSnifferStore, n: number): void {
  const decision = classifyItemTiers({ signals: { title: `bank ${n}`, labels: ['SSN 123-45-6789'] }, text: `Lunch plans ${n} for Saturday.`, subject: subject(n) },
    { sniffer: new CachedTierSniffer(store, LANE) });
  ledger.recordDecision(subject(n), decision);
}

/** Answers every item Personal (names) or Private (excerpt); each call waits for the slot, then runs, on the test clock. */
function timedModel(clock: ReturnType<typeof createTestClock>): AnalystModel & { calls: number } {
  const model = {
    calls: 0,
    async complete(request: AnalystModelRequest) {
      model.calls += 1;
      clock.set(clock.now() + SLOT_WAIT_MS + MODEL_MS);
      const items = request.prompt.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { i: number });
      const excerpt = request.prompt.includes('EXCERPT');
      const verdict = excerpt ? { tier: 'private', category: 'financial', confidence: 0.8, ownRecord: true, privateKind: 'financial' }
        : { tier: 'personal', category: 'ordinary', confidence: 0.96, ownRecord: false, privateKind: 'none' };
      return { text: JSON.stringify({ verdicts: items.map(item => ({ i: item.i, ...verdict })) }), modelId: LANE.modelId, slotWaitMs: SLOT_WAIT_MS };
    },
  };
  return model;
}

test('a pass divides its time into setup, dispatch, slot wait and model, and they add up', async () => {
  const clock = createTestClock();
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  cleanup.push(() => { store.close(); ledger.close(); });
  for (let n = 1; n <= 3; n++) recordNamesAndExcerpt(ledger, store, n);
  expect(store.counts().byPass).toEqual({ metadata: 3, content: 3 });
  const model = timedModel(clock);
  let screens = 0;
  const report = await runSnifferPass({
    // Each stored-copy screen costs time on the worker's thread.
    targets: [{ ledger, sniffer: store, screenStoredQuestion: () => { screens++; clock.set(clock.now() + SCREEN_MS); return 'clean'; } }],
    lane: LANE, model, monotonicNow: () => clock.now(), passTimeMs: 60_000,
  });
  expect(report.calls).toBe(6);
  expect(model.calls).toBe(6);
  const { timing } = report;
  expect(timing.slotWaitMs).toBe(6 * SLOT_WAIT_MS);
  expect(timing.modelMs).toBe(6 * MODEL_MS);
  expect(report.callMs).toBe(timing.slotWaitMs + timing.modelMs);
  // Names then excerpt for each item, in turn: every dispatch after the first switches.
  expect(timing.passSwitches).toBe(5);
  // Screens before the first dispatch are setup; the rest are dispatch work.
  expect(timing.setupMs).toBeGreaterThan(0);
  expect(timing.dispatchMs).toBeGreaterThan(0);
  expect(timing.setupMs + timing.dispatchMs).toBe(screens * SCREEN_MS);
  expect(timing.setupMs + timing.dispatchMs + timing.slotWaitMs + timing.modelMs).toBe(timing.passMs);
});

test('a completion through a shared slot says how long it waited there', async () => {
  const clock = createTestClock();
  const model: AnalystModel = { async complete() { clock.set(clock.now() + MODEL_MS); return { text: 'answer', modelId: LANE.modelId }; } };
  const completion = await completeAfterSlot(model, async (timed) => {
    clock.set(clock.now() + 45); // another caller's call holds the slot
    return timed.complete({ system: 's', prompt: 'p', localOnly: true });
  }, () => clock.now());
  expect(completion).toMatchObject({ text: 'answer', slotWaitMs: 45 });
});

/** A service over one store with `items` flagged items, on the test clock. */
async function serviceFixture(items: number, model: AnalystModel, extra: { answersInFlight?: () => boolean; concurrentCalls?: number } = {}) {
  const clock = createTestClock();
  const dir = mkdtempSync(join(tmpdir(), 'olympus-sniffer-throughput-'));
  const installed = new InstalledTierClassification({ env: {}, lane: LANE });
  const storePath = join(dir, 'items.sqlite');
  const ledgerPath = tierLedgerPathForStore(storePath);
  const ledger = new TierLedger({ dbPath: ledgerPath });
  cleanup.push(() => { installed.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  for (let n = 1; n <= items; n++) recordNamesAndExcerpt(ledger, installed.snifferStoreForLedger(ledgerPath), n);
  const classificationLedgerPath = join(dir, 'classification.jsonl');
  await appendClassificationLedgerEntry(classificationLedgerPath, {
    recorded_at: new Date().toISOString(), kind: 'classifier_model_decision', what: 'Synthetic fixture approval',
    approved_by: 'owner', status: 'complete', model_id: LANE.modelId, lane: LANE.kind,
    profile_id: LANE.profileId, prompt_version: SNIFFER_PROMPT_VERSION,
  });
  // The store the excerpts are read from for their secret screen; each read costs time.
  const store = { dbPath: storePath, tierSetBinding: () => ({ ledgerPath }),
    exportItemCopy: (() => { clock.set(clock.now() + SCREEN_MS); return { chunks: [{ boundedText: 'Lunch plans for Saturday.' }] }; }) as never };
  const lines: string[] = [];
  const service = new TierSnifferService({ installed, lane: LANE, model, classificationLedgerPath,
    // Each read of the stores costs the tick time around its pass.
    stores: () => { clock.set(clock.now() + 3); return [store]; },
    log: line => lines.push(line), rejudgePerPass: 0, monotonicNow: () => clock.now(), ...extra,
  });
  cleanup.push(() => service.stop());
  return { clock, service, lines };
}

test('the service breaks time between verdicts into waiting, yielding, steps, dispatch and model, and it adds up', async () => {
  let answering = true;
  let clockRef: ReturnType<typeof createTestClock> | undefined;
  const model: AnalystModel = { complete: request => timedModel(clockRef!).complete(request) };
  const { clock, service, lines } = await serviceFixture(2, model, { answersInFlight: () => answering });
  clockRef = clock;

  // 1. An answer holds the model: the pass yields before asking anything.
  const yielded = await service.runOnce();
  expect(yielded).toMatchObject({ state: 'ran', report: { calls: 0, stoppedBy: 'yield' } });
  // 2. The answer ends 5 s later; the next pass asks everything.
  clock.set(clock.now() + 5_000);
  answering = false;
  const ran = await service.runOnce();
  expect(ran.state === 'ran' && ran.report.calls).toBe(4);
  // 3. Idle for 2 s, with nothing left to ask.
  clock.set(clock.now() + 2_000);
  await service.runOnce();

  const { last, total } = service.status().throughput!;
  expect(last.idleMs).toBe(2_000);
  expect(last.verdicts).toBe(0);
  expect(total.cycles).toBe(3);
  expect(total.calls).toBe(4);
  expect(total.verdicts).toBe(ran.state === 'ran' ? ran.report.verdictsApplied : -1);
  expect(total.verdicts).toBeGreaterThan(0);
  // The wait after the yield is yielding; the calls' own slot wait is counted beside it.
  expect(total.slotWaitMs).toBe(4 * SLOT_WAIT_MS);
  expect(total.yieldedMs).toBe(5_000);
  expect(total.idleMs).toBe(2_000);
  expect(total.modelMs).toBe(4 * MODEL_MS);
  expect(total.stepsMs).toBeGreaterThan(0);
  expect(total.passSwitches).toBe(3);
  // Wall time is waiting, steps and the pass; with one call in flight the pass is its parts.
  expect(total.idleMs + total.yieldedMs + total.stepsMs + total.passMs).toBe(total.wallMs);
  expect(total.setupMs + total.dispatchMs + total.slotWaitMs + total.modelMs).toBe(total.passMs);
  expect(total.verdictsPerMinute).toBeCloseTo(total.verdicts * 60_000 / total.wallMs);
  // The pass's log line carries the same breakdown.
  const passLine = lines.find(line => line.includes(' call(s), '))!;
  expect(passLine).toContain('wait_before=yield');
  expect(passLine).toContain(`slot_wait_ms=${4 * SLOT_WAIT_MS} model_ms=${4 * MODEL_MS} pass_switches=3`);
});

test('a call that fails or is preempted after waiting for the slot still counts that wait as waiting', async () => {
  const clock = createTestClock();
  // The queue holds the call 45 ms, then the call is aborted once it has the slot.
  const aborted: AnalystModel = { async complete() { clock.set(clock.now() + 5); throw new Error('aborted'); } };
  const failure = await completeAfterSlot(aborted, async (timed) => {
    clock.set(clock.now() + 45);
    return timed.complete({ system: 's', prompt: 'p', localOnly: true });
  }, () => clock.now()).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(slotWaitOf(failure)).toBe(45);
  // Rejected before it ever got the slot: the whole time was waiting.
  const refused = await completeAfterSlot(aborted, async () => { clock.set(clock.now() + 30); throw new Error('aborted in queue'); }, () => clock.now())
    .catch((error: unknown) => error);
  expect(slotWaitOf(refused)).toBe(30);

  // The pass counts a failed call's wait as slot wait, not model time.
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  cleanup.push(() => { store.close(); ledger.close(); });
  recordNamesAndExcerpt(ledger, store, 1);
  const model: AnalystModel = { complete: (request) => completeAfterSlot<AnalystModel>(
    { async complete() { clock.set(clock.now() + MODEL_MS); throw new Error('transport'); } },
    async (timed) => { clock.set(clock.now() + SLOT_WAIT_MS); return timed.complete(request); }, () => clock.now()) };
  const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane: LANE, model, monotonicNow: () => clock.now() });
  expect(report.failedCalls).toBeGreaterThan(0);
  expect(report.timing.slotWaitMs).toBe(report.calls * SLOT_WAIT_MS);
  expect(report.timing.modelMs).toBe(report.calls * MODEL_MS);
});

test('with several calls in flight, wall time stays the time that passed and summed call time is reported beside it', async () => {
  let clockRef: ReturnType<typeof createTestClock> | undefined;
  let inFlight = 0;
  let peak = 0;
  const model: AnalystModel = { async complete(request) {
    // Calls dispatched together start together and each ends MODEL_MS after its start.
    const start = clockRef!.now();
    inFlight++; peak = Math.max(peak, inFlight);
    await flushMicrotasks();
    inFlight--;
    clockRef!.set(Math.max(clockRef!.now(), start + MODEL_MS));
    const items = request.prompt.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { i: number });
    return { text: JSON.stringify({ verdicts: items.map(item => ({ i: item.i, tier: 'personal', category: 'ordinary', confidence: 0.96, ownRecord: false, privateKind: 'none' })) }), modelId: LANE.modelId };
  } };
  // Four items with their names questions alone in flight two at a time.
  const { clock, service } = await serviceFixture(4, model, { concurrentCalls: 2 });
  clockRef = clock;
  const started = clock.now();
  const tick = await service.runOnce();
  const elapsed = clock.now() - started;
  expect(peak).toBe(2);
  expect(tick.state === 'ran' && tick.report.calls).toBeGreaterThanOrEqual(4);
  const { last } = service.status().throughput!;
  // Summed call time is longer than the pass that held the calls...
  expect(last.modelMs).toBeGreaterThan(last.passMs);
  // ...but wall time is what passed, and the verdict rate is taken over it.
  expect(last.wallMs).toBe(elapsed);
  expect(last.idleMs + last.yieldedMs + last.stepsMs + last.passMs).toBe(last.wallMs);
  expect(last.verdictsPerMinute).toBeCloseTo(last.verdicts * 60_000 / elapsed);
});
