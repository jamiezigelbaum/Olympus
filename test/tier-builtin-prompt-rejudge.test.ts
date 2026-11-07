// Synthetic decisions: built-in wording is not a settled-item invalidation key.
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import { CachedTierSniffer, snifferId, snifferPromptVersions } from '../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { classifyItemTiers, TIER_CLASSIFIER_VERSION } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const lane: SnifferLane = { kind: 'local', modelId: 'synthetic-judge', profileId: 'fixture',
  profile: { provider: 'local-openai-compatible', trust: 'local', model: 'synthetic-judge' } };
const oldPrompt = 'p-000000000000';
const currentPrompt = snifferPromptVersions().cache;
const oldId = snifferId(lane, oldPrompt);
const currentId = snifferId(lane, currentPrompt);
const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: currentId };
const subject = (id = 'note') => ({ provider: 'fixture', accountScope: 'synthetic', providerItemId: id });
const placement = { copies: [{ corpusId: 'fixture', trustDomain: 'internal' as const, layers: 'both' as const }], embedHold: false };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture(id = oldId, pass: 'metadata' | 'content' | 'both' = 'both', itemId = 'note', existing?: TierLedger) {
  const ledger = existing ?? new TierLedger({ dbPath: ':memory:' });
  if (!existing) cleanup.push(() => ledger.close());
  const decision = classifyItemTiers({ signals: {}, text: 'Bring apples to the picnic.' });
  ledger.recordRoutedPlacement(subject(itemId), { ...decision, decidedBy: 'sniffer', reasons: [
    ...(pass !== 'content' ? [`metadata:sniffer:${id}:ordinary:0.99`] : []),
    ...(pass !== 'metadata' ? [`content:sniffer:${id}:ordinary:0.99`] : []),
  ], ...(pass === 'metadata' ? { contentTier: 'secure' as const } : {}) }, placement);
  return ledger;
}

for (const pass of ['metadata', 'content', 'both'] as const) test(`built-in-only change skips settled ${pass} verdicts`, () => {
  const page = fixture(oldId, pass).rejudgeCandidatePage(key);
  expect(page.records).toEqual([]);
  expect(page).toMatchObject({ builtinPromptSkipped: 1 });
});

for (const stamp of ['markJudged', 'markRejudged'] as const) test(`built-in-only change preserves a ${stamp} settlement`, () => {
  const ledger = fixture();
  ledger[stamp](subject(), { ...key, snifferId: oldId });
  expect(ledger.rejudgeCandidatePage(key)).toMatchObject({ records: [], builtinPromptSkipped: 1 });
});

for (const [before, after] of [
  ['p-000000000000.o11111111', `${currentPrompt}.o22222222`],
  [oldPrompt, `${currentPrompt}.o22222222`],
  ['p-000000000000.o11111111', currentPrompt],
]) test(`owner words change selects settled items (${before} -> ${after})`, () => {
  const ledger = fixture(snifferId(lane, before));
  expect(ledger.rejudgeCandidatePage({ ...key, snifferId: snifferId(lane, after) }).causes).toEqual(['owner_words']);
});

test('built-in-only change also skips with unchanged owner words', () => {
  const ledger = fixture(snifferId(lane, `${oldPrompt}.o11111111`));
  expect(ledger.rejudgeCandidatePage({ ...key, snifferId: snifferId(lane, `${currentPrompt}.o11111111`) }))
    .toMatchObject({ records: [], builtinPromptSkipped: 1 });
});

test('classifier version change still selects a settled item', () => {
  expect(fixture().rejudgeCandidatePage({ ...key, engineVersion: 'synthetic-next-classifier' }).causes).toEqual(['classifier']);
});

test('model change still selects a settled item', () => {
  const ledger = fixture();
  expect(ledger.rejudgeCandidatePage({ ...key, snifferId: snifferId({ ...lane, modelId: 'replacement-judge' }, currentPrompt) }).causes)
    .toEqual(['judge_model']);
});

test('held content is still selected after a built-in change', () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  cleanup.push(() => ledger.close());
  const decision = classifyItemTiers({ signals: {}, text: 'Bring apples to the picnic.' });
  ledger.recordRoutedPlacement(subject(), { ...decision, state: 'pending', contentPending: true, metadataPending: false }, placement);
  ledger.markHeldRejudged(ledger.getCurrent(subject())!, { ...key, snifferId: oldId });
  expect(ledger.rejudgeCandidatePage(key).causes).toEqual(['held']);
});

test('built-in-only change skips a settled content rule with its sniffer receipt', () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  cleanup.push(() => ledger.close());
  const decision = classifyItemTiers({ signals: {}, text: 'ok' });
  ledger.recordRoutedPlacement(subject(), { ...decision, decidedBy: 'content_rule',
    reasons: ['content:rule:trivial_message', `content:rule_sniffer:${oldId}`] }, placement);
  expect(ledger.rejudgeCandidatePage(key)).toMatchObject({ records: [], builtinPromptSkipped: 1 });
  expect(ledger.rejudgeCandidatePage({ ...key, snifferId: snifferId(lane, `${currentPrompt}.o22222222`) }).causes).toEqual(['owner_words']);
});

test('old built-in names do not suppress a content judgment still owed', () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  cleanup.push(() => ledger.close());
  const decision = classifyItemTiers({ signals: {}, text: 'Bring apples to the picnic.' });
  ledger.recordRoutedPlacement(subject(), { ...decision, reasons: [`metadata:sniffer:${oldId}:ordinary:0.99`, 'content:no_raise'] }, placement);
  expect(ledger.rejudgeCandidatePage(key)).toMatchObject({ causes: ['names_prompt'], builtinPromptSkipped: 0 });
});

test('a finalized fail-safe decision stays settled across a built-in-only change', () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  cleanup.push(() => ledger.close());
  const decision = classifyItemTiers({ signals: {}, text: 'Bring apples to the picnic.' });
  ledger.recordRoutedPlacement(subject(), { ...decision, decidedBy: 'sniffer', contentTier: 'secure',
    reasons: [`content:sniffer:${oldId}:unresolved:0.00`] }, placement);
  expect(ledger.getCurrent(subject())).toMatchObject({ state: 'current', contentPending: false, metadataPending: false });
  expect(ledger.rejudgeCandidatePage(key)).toMatchObject({ records: [], builtinPromptSkipped: 1 });
  expect(ledger.rejudgeCandidatePage({ ...key, snifferId: snifferId(lane, `${currentPrompt}.o22222222`) }).causes).toEqual(['owner_words']);
});

test('a built-in content change cannot hide an owner-words change on the names', () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  cleanup.push(() => ledger.close());
  const decision = classifyItemTiers({ signals: {}, text: 'Bring apples to the picnic.' });
  ledger.recordRoutedPlacement(subject(), { ...decision, reasons: [
    `metadata:sniffer:${snifferId(lane, `${oldPrompt}.o11111111`)}:ordinary:0.99`, `content:sniffer:${oldId}:ordinary:0.99`,
  ] }, placement);
  expect(ledger.rejudgeCandidatePage(key)).toMatchObject({ causes: ['owner_words'], builtinPromptSkipped: 0 });
});

test('a bounded scan counts skipped items without crowding out candidates or losing the cursor', () => {
  const ledger = fixture(oldId, 'both', 'a');
  fixture(oldId, 'both', 'b', ledger);
  fixture(snifferId(lane, `${oldPrompt}.o11111111`), 'both', 'c', ledger);
  const first = ledger.rejudgeCandidatePage({ ...key, limit: 1, scanLimit: 2 });
  expect(first).toMatchObject({ records: [], builtinPromptSkipped: 2 });
  expect(first.next?.providerItemId).toBe('b');
  const second = ledger.rejudgeCandidatePage({ ...key, limit: 1, scanLimit: 2, after: first.next! });
  expect(second.records.map(row => row.providerItemId)).toEqual(['c']);
  expect(second.causes).toEqual(['owner_words']);
});

test('a new item uses the current prompt for inference, cache and decision', async () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  cleanup.push(() => { store.close(); ledger.close(); });
  const material = 'Bring apples to the picnic.';
  const sniffer = new CachedTierSniffer(store, lane);
  const decision = classifyItemTiers({ signals: {}, text: material, subject: subject() }, { sniffer });
  ledger.recordDecision(subject(), decision);
  const materialHash = store.listQuestions()[0]!.materialHash;
  store.putVerdict({ materialHash, modelId: lane.modelId, promptVersion: oldPrompt, mapRevision: 'none' },
    { tier: 'private', category: 'other', confidence: 1, failSafe: false });
  let calls = 0;
  const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane, model: { async complete() {
    calls++;
    return { text: JSON.stringify({ verdicts: [{ i: 1, tier: 'personal', ownRecord: false, privateKind: 'none', category: 'ordinary', confidence: 1 }] }), modelId: lane.modelId };
  } } });
  expect(calls).toBe(1);
  expect(report).toMatchObject({ calls: 1, resolvedPersonal: 1 });
  expect(ledger.getCurrent(subject())?.reasons.some(reason => reason.startsWith(`content:sniffer:${currentId}:`))).toBe(true);
  expect(store.getVerdict({ materialHash, modelId: lane.modelId,
    promptVersion: currentPrompt, mapRevision: 'none' })?.tier).toBe('personal');
});

for (const ownerChanged of [false, true]) test(`service reports counts for owner words and built-in-only skips (ownerChanged=${ownerChanged})`, async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  const installed = new InstalledTierClassification({ env: {}, lane: BUILT_IN_SNIFFER_LANE });
  const logs: string[] = [];
  let nowMs = Date.now();
  const service = new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE,
    now: () => new Date(nowMs),
    classificationLedgerPath: join(tmp.dir, 'classification.jsonl'), stores: () => f.set.openStores(),
    autoApproveBuiltIn: true, log: line => logs.push(line), model: { async complete() {
      return { modelId: BUILT_IN_SNIFFER_LANE.modelId, text: JSON.stringify({ verdicts: [
        { i: 1, tier: 'personal', ownRecord: false, privateKind: 'none', category: 'ordinary', confidence: 1 },
      ] }) };
    } },
  });
  cleanup.push(() => { service.stop(); registerInstalledTierClassification(undefined); installed.close(); f.close(); tmp.cleanup(); });
  await f.set.sync(fixtureConnector(() => [{ id: 'note', name: 'Picnic note', text: 'Bring apples to the picnic.' }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const id = snifferId(BUILT_IN_SNIFFER_LANE, ownerChanged ? `${oldPrompt}.o11111111` : oldPrompt);
  const decision = classifyItemTiers({ signals: {}, text: 'Bring apples to the picnic.' });
  f.ledger.recordRoutedPlacement(identityOf('note'), { ...decision, decidedBy: 'sniffer', reasons: [
    `metadata:sniffer:${id}:ordinary:0.99`, `content:sniffer:${id}:ordinary:0.99`,
  ] }, f.set.placementFor(decision));
  registerInstalledTierClassification(installed);
  expect(await service.runOnce()).toMatchObject({ state: 'ran', rejudged: {
    seen: ownerChanged ? 1 : 0, causeOwnerWords: ownerChanged ? 1 : 0, builtinPromptSkipped: ownerChanged ? 0 : 1,
  } });
  const picked = logs.filter(line => line.includes('; picked for:'));
  expect(picked).toHaveLength(1);
  expect(picked[0]).toContain(`owner_words=${ownerChanged ? 1 : 0}`);
  expect(picked[0]).toContain(`builtin_prompt_skipped=${ownerChanged ? 0 : 1}`);
  expect(picked[0]).not.toContain('Picnic');
  expect(picked[0]).not.toContain('apples');
  if (!ownerChanged) {
    expect(await service.runOnce()).toMatchObject({ state: 'ran', rejudged: { builtinPromptSkipped: 1 } });
    expect(logs.filter(line => line.includes('; picked for:'))).toHaveLength(1);
    nowMs += 60_000;
    await service.runOnce();
    expect(logs.filter(line => line.includes('; picked for:'))).toHaveLength(2);
  }
});
