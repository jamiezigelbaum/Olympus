// Synthetic items (#1002): a re-judge that cannot read an item's serving text
// does not settle it, so an owner-words change is applied once the text is back.
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { snifferId, snifferPromptVersions } from '../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { classifyItemTiers, TIER_CLASSIFIER_VERSION, type TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { REJUDGE_UNAVAILABLE_MAX_RETRY_MS, REJUDGE_UNAVAILABLE_RETRY_MS } from '../src/workers/classification/tier-ledger.ts';
import { emptyTierRejudgeReport, rejudgeStoredContent } from '../src/workers/connector-store/tier-rejudge.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';
import { createTestClock } from './helpers/test-clock.ts';

const lane: SnifferLane = { kind: 'local', modelId: 'synthetic-judge', profileId: 'fixture',
  profile: { provider: 'local-openai-compatible', trust: 'local', model: 'synthetic-judge' } };
const prompt = snifferPromptVersions().cache;
const oldWords = snifferId(lane, `${prompt}.o11111111`);
const newWords = snifferId(lane, `${prompt}.o22222222`);
const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: newWords };
const identity = identityOf('note');
const text = 'Synthetic orchard planning notes.';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

// The new owner words make this item Private (ledger tier 'secure').
const ownerWords: TierSniffer = { id: newWords, judge: () => ({ verdict: 'decided', tier: 'secure', code: 'owner_words_private' }) };

async function settledUnderOldWords() {
  const clock = createTestClock(Date.parse('2026-11-10T00:00:00.000Z'));
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false, now: () => clock.date() });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  await f.set.sync(fixtureConnector(() => [{ id: 'note', name: 'Orchard', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const decision = classifyItemTiers({ signals: {}, text });
  f.ledger.recordRoutedPlacement(identity, { ...decision, decidedBy: 'sniffer', reasons: [
    `metadata:sniffer:${oldWords}:ordinary:0.99`, `content:sniffer:${oldWords}:ordinary:0.99`,
  ] }, f.set.placementFor(decision));
  // Under the old words the item was settled by a verdict (a model-settlement stamp).
  f.ledger.markJudged(identity, { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: oldWords });
  return { f, clock };
}

function withExport<T>(f: Awaited<ReturnType<typeof settledUnderOldWords>>['f'], missing: boolean, run: () => T): T {
  const originals = Object.values(f.stores).map(store => [store!, store!.exportItemCopy] as const);
  if (missing) for (const [store] of originals) store.exportItemCopy = () => undefined;
  try { return run(); } finally { for (const [store, original] of originals) store.exportItemCopy = original; }
}

function rejudgeCandidates(f: Awaited<ReturnType<typeof settledUnderOldWords>>['f'], missing: boolean) {
  const page = f.ledger.rejudgeCandidatePage(key);
  const report = emptyTierRejudgeReport();
  withExport(f, missing, () => {
    for (const record of page.records) rejudgeStoredContent(f.set, record, { sniffer: ownerWords, report, key, autoMoves: false });
  });
  return { page, report };
}

test('missing export, then restored export: the changed owner words are applied', async () => {
  const { f, clock } = await settledUnderOldWords();
  const first = rejudgeCandidates(f, true);
  expect(first.page.causes).toEqual(['owner_words']);
  expect(first.report).toMatchObject({ skipped: 1, updated: 0, movesQueued: 0 });
  expect(f.ledger.getCurrent(identity)!.reasons).toContain(`content:sniffer:${oldWords}:ordinary:0.99`);

  // Not re-read on every tick while the text may still be missing.
  expect(rejudgeCandidates(f, false).page.records).toEqual([]);

  await clock.advance(REJUDGE_UNAVAILABLE_RETRY_MS);
  const retried = rejudgeCandidates(f, false);
  expect(retried.page.causes).toEqual(['owner_words']);
  expect(retried.report).toMatchObject({ skipped: 0, failed: 0 });
  expect(retried.report.updated + retried.report.movesQueued).toBe(1);
  const current = f.ledger.getCurrent(identity)!;
  expect(current.reasons.some(reason => reason.includes(`:sniffer:${newWords}:owner_words_private`))).toBe(true);
  expect(current.reasons.some(reason => reason.includes(`:sniffer:${oldWords}:`))).toBe(false);
  // Settled now: no further re-read under the same inputs.
  expect(f.ledger.rejudgeCandidatePage(key).records).toEqual([]);
});

test('a text that stays missing is retried on a doubling backoff, never every tick', async () => {
  const { f, clock } = await settledUnderOldWords();
  const reads: number[] = [];
  for (let minute = 0; minute <= 4 * 24 * 60; minute += 30) {
    if (rejudgeCandidates(f, true).page.records.length) reads.push(minute);
    await clock.advance(30 * 60 * 1000);
  }
  const hour = REJUDGE_UNAVAILABLE_RETRY_MS / 60_000;
  const cap = REJUDGE_UNAVAILABLE_MAX_RETRY_MS / 60_000;
  expect(reads.slice(0, 6)).toEqual([0, hour, 3 * hour, 7 * hour, 15 * hour, 31 * hour]);
  expect(reads.slice(6).every((minute, i) => minute - reads[5 + i]! === cap)).toBe(true);
});

test('a newer decision of the row makes it a candidate at once', async () => {
  const { f, clock } = await settledUnderOldWords();
  rejudgeCandidates(f, true);
  expect(f.ledger.rejudgeCandidatePage(key).records).toEqual([]);
  await clock.advance(60_000);
  const decision = classifyItemTiers({ signals: {}, text });
  f.ledger.recordRoutedPlacement(identity, { ...decision, decidedBy: 'sniffer', reasons: [
    `metadata:sniffer:${oldWords}:ordinary:0.98`, `content:sniffer:${oldWords}:ordinary:0.98`,
  ] }, f.set.placementFor(decision));
  expect(f.ledger.rejudgeCandidatePage(key).causes).toEqual(['owner_words']);
});

test('the marker keeps a valid model-settlement stamp: the old words still count as settled', async () => {
  const { f } = await settledUnderOldWords();
  rejudgeCandidates(f, true);
  const db = new Database(f.ledger.dbPath, { readonly: true });
  const stamp = (db.query('SELECT rejudged_key FROM tier_items').get() as { rejudged_key: string }).rejudged_key;
  db.close();
  expect(stamp.startsWith(`${TIER_CLASSIFIER_VERSION}\u0000${oldWords}\u0000judged\u0001`)).toBe(true);
  // Back under the words the item was judged with, it is settled, not re-read.
  expect(f.ledger.rejudgeCandidatePage({ ...key, snifferId: oldWords }).records).toEqual([]);
});
