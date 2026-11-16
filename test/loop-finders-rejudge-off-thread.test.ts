// Family 5 of the loop-thread rule (loop-stall step-back, 15 Nov 2026): the
// re-judge pass finds its candidate page on the ledger's read worker. A page
// found there can be older than the ledger by the time the loop judges a row,
// so each candidate is read again by key and judged only while it still is
// one: a verdict that settled it after the page was found (at the same
// generation) is never judged over.

import { afterEach, expect, test } from 'bun:test';
import { snifferId, snifferPromptVersions } from '../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { classifyItemTiers, TIER_CLASSIFIER_VERSION, type TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { ledgerReadOffThread } from '../src/workers/connector-store/child-visibility.ts';
import { setReadPoolObserverForTests, shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import { rejudgeRoutedItems, rejudgeRoutedItemsInTurns } from '../src/workers/connector-store/tier-rejudge.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const lane: SnifferLane = { kind: 'local', modelId: 'synthetic-judge', profileId: 'fixture',
  profile: { provider: 'local-openai-compatible', trust: 'local', model: 'synthetic-judge' } };
const prompt = snifferPromptVersions().cache;
const oldWords = snifferId(lane, `${prompt}.o11111111`);
const newWords = snifferId(lane, `${prompt}.o22222222`);
const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: newWords };
const IDS = ['note-a', 'note-b', 'note-c'];
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  setReadPoolObserverForTests();
  shutdownReadPool();
});

// The new owner words make every item Private (ledger tier 'secure').
const ownerWords: TierSniffer = { id: newWords, judge: () => ({ verdict: 'decided', tier: 'secure', code: 'owner_words_private' }) };

/** Items settled by a verdict under the old owner words: each is a candidate under the new ones. */
async function settledUnderOldWords() {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  await f.set.sync(fixtureConnector(() => IDS.map((id) => ({ id, name: `Orchard ${id}`, text: `Synthetic orchard notes ${id}.` }))),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  for (const id of IDS) {
    const decision = classifyItemTiers({ signals: {}, text: `Synthetic orchard notes ${id}.` });
    f.ledger.recordRoutedPlacement(identityOf(id), { ...decision, decidedBy: 'sniffer', reasons: [
      `metadata:sniffer:${oldWords}:ordinary:0.99`, `content:sniffer:${oldWords}:ordinary:0.99`,
    ] }, f.set.placementFor(decision));
    f.ledger.markJudged(identityOf(id), { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: oldWords });
  }
  (f.set as unknown as { classification(): unknown }).classification = () => ({ sniffer: ownerWords, rules: [] });
  return f;
}

type Fixture = Awaited<ReturnType<typeof settledUnderOldWords>>;

/** Whose decision the new owner words made. */
function rejudged(f: Fixture): string[] {
  return IDS.filter((id) => f.ledger.getCurrent(identityOf(id))!.reasons.some((reason) => reason.includes(`:sniffer:${newWords}:`)));
}

function observePage(): () => number {
  let reads = 0;
  setReadPoolObserverForTests((_path, read) => { if (read.sql.includes('rejudge_candidate')) reads += 1; }, { snapshots: true });
  return () => reads;
}

test('the candidate page is read on the read worker, and the pass decides what the pass here decides', async () => {
  const here = await settledUnderOldWords();
  const hereRun = rejudgeRoutedItems({ set: here.set, autoMoves: false });
  const loop = await settledUnderOldWords();
  const reads = observePage();
  const loopRun = await rejudgeRoutedItemsInTurns({ set: loop.set, autoMoves: false, turn: () => undefined });
  expect(reads()).toBe(1);
  expect(loopRun).toEqual(hereRun);
  expect(loopRun.report).toMatchObject({ seen: 3, causeOwnerWords: 3, failed: 0 });
  expect(rejudged(loop)).toEqual(rejudged(here));
  expect(rejudged(loop)).toEqual(IDS);
});

test('a candidate settled after the page was found, at the same generation, is not judged over', async () => {
  // Here: note-b's verdict under the new words lands before the pass looks.
  const here = await settledUnderOldWords();
  here.ledger.markJudged(identityOf('note-b'), key);
  const hereRun = rejudgeRoutedItems({ set: here.set, autoMoves: false });
  // On the loop: the worker's page still lists note-b; its verdict lands at the first turn.
  const loop = await settledUnderOldWords();
  const generation = loop.ledger.getCurrent(identityOf('note-b'))!.generation;
  let turns = 0;
  const loopRun = await rejudgeRoutedItemsInTurns({ set: loop.set, autoMoves: false, turn: () => {
    if (turns++ === 0) loop.ledger.markJudged(identityOf('note-b'), key);
    return undefined;
  } });
  expect(loop.ledger.getCurrent(identityOf('note-b'))!.generation).toBe(generation);
  expect(turns).toBe(3);
  expect(loopRun.report).toEqual(hereRun.report);
  expect(loopRun.report).toMatchObject({ seen: 2, causeOwnerWords: 2 });
  expect(rejudged(loop)).toEqual(rejudged(here));
  expect(rejudged(loop)).toEqual(['note-a', 'note-c']);
});

test('inside a ledger hold the page waits for the hold to end before it reads on the worker', async () => {
  const f = await settledUnderOldWords();
  const reads = observePage();
  let release!: () => void;
  const held = f.ledger.holdingWrites(() => new Promise<void>((resolve) => { release = resolve; }));
  const run = rejudgeRoutedItemsInTurns({ set: f.set, autoMoves: false, turn: () => undefined });
  // Two reads of the ledger on its worker while the hold is open: a page sent
  // without waiting would be seen first.
  for (let reads = 0; reads < 2; reads++) await ledgerReadOffThread(f.ledger, (function* () { yield { sql: 'SELECT 1 AS one', params: [], mode: 'get' as const }; })());
  expect(reads()).toBe(0);
  release();
  await held;
  expect((await run).report).toMatchObject({ seen: 3 });
  expect(reads()).toBe(1);
});
