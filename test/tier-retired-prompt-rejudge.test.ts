// #1244: items the #995 built-in prompt settled Personal are judged once more
// under the next built-in prompt, at the lowest priority. Private and Secrets
// decisions are never reopened, and other built-in wording changes still
// leave settled items alone (the 2026-11-07 rule). Synthetic items only.
import { afterEach, expect, test } from 'bun:test';
import { snifferId } from '../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { classifyItemTiers, HELD_UNTIL_JUDGED_PRIORITY, TIER_CLASSIFIER_VERSION, type TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { RETIRED_SNIFFER_PROMPT_VERSIONS, TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { rejudgeRoutedItems } from '../src/workers/connector-store/tier-rejudge.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const lane: SnifferLane = { kind: 'local', modelId: 'synthetic-judge', profileId: 'fixture',
  profile: { provider: 'local-openai-compatible', trust: 'local', model: 'synthetic-judge' } };
const nextPrompt = 'p-aaaaaaaaaaaa';
const [retiredPlain, retiredOwner] = RETIRED_SNIFFER_PROMPT_VERSIONS as [string, string];
const key = (prompt = nextPrompt) => ({ engineVersion: TIER_CLASSIFIER_VERSION, snifferId: snifferId(lane, prompt) });
const subject = (id = 'note') => ({ provider: 'fixture', accountScope: 'synthetic', providerItemId: id });
const placement = { copies: [{ corpusId: 'fixture', trustDomain: 'internal' as const, layers: 'both' as const }], embedHold: false };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function settled(prompt: string, contentTier?: 'secure', itemId = 'note', existing?: TierLedger) {
  const ledger = existing ?? new TierLedger({ dbPath: ':memory:' });
  if (!existing) cleanup.push(() => ledger.close());
  const id = snifferId(lane, prompt);
  const decision = classifyItemTiers({ signals: {}, text: 'Bring apples to the picnic.' });
  ledger.recordRoutedPlacement(subject(itemId), { ...decision, decidedBy: 'sniffer', reasons: [
    `metadata:sniffer:${id}:ordinary:0.99`, `content:sniffer:${id}:${contentTier ? 'health' : 'ordinary'}:0.99`,
  ], ...(contentTier ? { contentTier } : {}) }, placement);
  return ledger;
}

test('the retired versions are the ones #995 shipped', () => {
  expect(RETIRED_SNIFFER_PROMPT_VERSIONS).toEqual(['p-b1bcbbfd93eb', 'p-8ba2d5840a74']);
});

for (const [before, after] of [[retiredPlain, nextPrompt], [`${retiredOwner}.o11111111`, `${nextPrompt}.o11111111`]] as const) {
  test(`a Personal item settled under a retired prompt is picked once (${before})`, () => {
    const ledger = settled(before);
    const page = ledger.rejudgeCandidatePage(key(after));
    expect(page.causes).toEqual(['retired_prompt']);
    ledger.markRejudged(subject(), key(after));
    expect(ledger.rejudgeCandidatePage(key(after))).toMatchObject({ records: [], builtinPromptSkipped: 0 });
  });
}

test('a Private item settled under a retired prompt is left alone', () => {
  expect(settled(retiredPlain, 'secure').rejudgeCandidatePage(key())).toMatchObject({ records: [], builtinPromptSkipped: 1 });
});

test('the sweep waits for a new built-in prompt: under a retired prompt nothing is picked', () => {
  expect(settled(retiredPlain).rejudgeCandidatePage(key(retiredOwner))).toMatchObject({ records: [], builtinPromptSkipped: 1 });
});

test('other built-in wording changes still leave settled items alone', () => {
  expect(settled('p-000000000000').rejudgeCandidatePage(key())).toMatchObject({ records: [], builtinPromptSkipped: 1 });
});

test('owner words and judge changes keep their own causes', () => {
  expect(settled(retiredPlain).rejudgeCandidatePage(key(`${nextPrompt}.o22222222`)).causes).toEqual(['owner_words']);
  expect(settled(retiredPlain).rejudgeCandidatePage({ ...key(), snifferId: snifferId({ ...lane, modelId: 'replacement' }, nextPrompt) }).causes)
    .toEqual(['judge_model']);
});

test('the sweep asks its questions behind every other question', async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  const priorities: Array<number | undefined> = [];
  const sniffer: TierSniffer = { id: snifferId(lane, nextPrompt), judge(request) {
    priorities.push(request.priority);
    return { verdict: 'undecided', queued: true };
  } };
  const set = new TieredStoreSet({ setId: 'retired-prompt', ledger: f.ledger, secretLocations: f.secrets,
    tierClassification: { sniffer, rules: [] },
    legs: (['internal', 'secure_local'] as const).map(domain => ({ trustDomain: domain, corpusId: CORPORA[domain], store: f.stores[domain]! })),
  });
  await set.sync(fixtureConnector(() => [{ id: 'note', name: 'Picnic note', text: 'Bring apples to the picnic.' }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const id = snifferId(lane, retiredPlain);
  const decision = classifyItemTiers({ signals: {}, text: 'Bring apples to the picnic.' });
  f.ledger.recordRoutedPlacement(identityOf('note'), { ...decision, decidedBy: 'sniffer', reasons: [
    `metadata:sniffer:${id}:ordinary:0.99`, `content:sniffer:${id}:ordinary:0.99`,
  ] }, set.placementFor(decision));
  priorities.length = 0;
  const { report } = rejudgeRoutedItems({ set, autoMoves: true });
  expect(report).toMatchObject({ seen: 1, causeRetiredPrompt: 1, asked: 1, failed: 0 });
  expect(priorities.length).toBeGreaterThan(0);
  expect(priorities.every(priority => priority === HELD_UNTIL_JUDGED_PRIORITY)).toBe(true);
});
