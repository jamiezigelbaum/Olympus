import { expect, test } from 'bun:test';
import type { EvidencePackBuildDetail } from '../src/core/evidence-pack.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import { comparePassageReceipts, runPassageEval } from '../eval/run-passages.ts';
import { fitPackToPromptBytes } from '../src/workers/source-index/analyst-answer.ts';
import type { EvalDataset } from '../eval/types.ts';
const quote = 'Kestrel invoices total forty seven dollars this month';
const question = 'Confidential fixture question that must never appear';
const passage = `Confidential fixture passage. ${quote}`;
const dataset: EvalDataset = { version: '2', description: 'private description', questions: [
  { id: 'q1', shape: 'value_lookup', question, split: 'open', expectedEvidence: [{ corpusId: 'internal.fixture.file', providerItemId: 'original', quote, hint: 'private title', alternates: [{ corpusId: 'internal.fixture.file', providerItemId: 'copy' }] }] },
  { id: 'q2', shape: 'coverage_negative', question: 'Unanswerable confidential question', split: 'open' },
  { id: 'q3', shape: 'locator', question: 'Sealed confidential question', split: 'sealed', expectedEvidence: [{ corpusId: 'internal.fixture.file', providerItemId: 'copy', quote, hint: '' }] },
] };
function detail(text = passage): EvidencePackBuildDetail {
  return { pack: { question, candidates: [{ chunks: [text], trustTier: 'S3', trustDomain: 'internal', provenance: { sourceItem: { providerItemId: 'copy', family: 'file', provider: 'fixture', accountScope: 'personal', localItemId: 'local' }, } }], coverage: { searchedCorpora: [], skippedCorpora: [], extractionGaps: [] }, builtAt: '2026-01-01' } as unknown as EvidencePack,
    candidateCorpusIds: ['internal.fixture.file'], encounteredSecureLocal: false, laneAudits: [], secureLaneAudits: [], skippedCorpora: [], degradations: [], corpusTimings: [{ corpusId: 'internal.fixture.file', elapsedMs: 2, outcome: 'success' }] };
}
const counts = [{ corpusId: 'internal.fixture.file', family: 'file' as const, tier: 'internal' as const, rows: 2 }];
test('scores object alternates and fitted passage text; receipt never includes fixture content', async () => {
  const receipt = await runPassageEval({ dataset, maxResults: 12, promptBytes: 100_000, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail() });
  expect(receipt.questions).toHaveLength(2);
  expect(receipt.questions![0]!.object.firstHitRank).toBe(1);
  expect(receipt.summary.overall.passage.hitsAtK['12']).toBe(1);
  expect(receipt.summary.overall.negativeSeats).toBe(1);
  expect(receipt.summary.byFamily.file!.passage.mrr).toBe(1);
  const json = JSON.stringify(receipt);
  for (const secret of [...dataset.questions.map(q => q.question), ...dataset.questions.flatMap(q => (q.expectedEvidence ?? []).map(e => e.quote!)), passage, 'private title', 'private description']) expect(json).not.toContain(secret);
  const missed = await runPassageEval({ dataset, maxResults: 12, promptBytes: 100_000, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail('unrelated text') });
  expect(missed.summary.overall.object.hitsAtK['12']).toBe(1);
  expect(missed.summary.overall.passage.hitsAtK['12']).toBe(0);
});
test('sealed mode runs only sealed questions and omits all per-question rows', async () => {
  const calls: string[] = [];
  const receipt = await runPassageEval({ dataset, split: 'sealed', maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async q => { calls.push(q.id); return detail(); } });
  expect(calls).toEqual(['q3']); expect(receipt.questions).toBeUndefined();
  expect(JSON.stringify(receipt)).not.toContain('q3');
  expect(receipt.summary.overall.answerable).toBe(1);
});
test('keep rule requires two more passage hits and limits losses per shape and family', async () => {
  // Without rows (as in a sealed receipt) the verdict reads the summaries.
  const { questions: _rows, ...base } = await runPassageEval({ dataset, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail() });
  const next = structuredClone(base);
  next.summary.overall.passage.hitsAtK['5']! += 2;
  expect(comparePassageReceipts(next, base).kept).toBe(true);
  next.summary.byFamily.file!.passage.hitsAtK['5']! -= 2;
  expect(comparePassageReceipts(next, base).kept).toBe(false);
  expect(() => comparePassageReceipts({ ...next, split: 'sealed' }, base)).toThrow('compatible');
});
test('scores only the clipped text and seats actually sent by prompt fitting', async () => {
  const long = detail(`${'unrelated filler '.repeat(2000)} ${quote}`);
  const receipt = await runPassageEval({ dataset, maxResults: 5, promptBytes: 5000, storeCounts: counts, gitSha: 'abc', buildPack: async () => long });
  expect(receipt.questions![0]!.object.firstHitRank).toBe(1);
  expect(receipt.questions![0]!.passage.firstHitRank).toBeNull();
});
test('first-hit ranks and k cutoffs retain seat order', async () => {
  const many = detail();
  const target = many.pack.candidates[0]!;
  const candidates = Array.from({ length: 7 }, (_, i) => ({ ...target, provenance: { ...target.provenance, sourceItem: { ...target.provenance.sourceItem, providerItemId: i === 6 ? 'copy' : `wrong${i}` } } }));
  const receipt = await runPassageEval({ dataset, maxResults: 12, storeCounts: counts, gitSha: 'abc', buildPack: async () => ({ ...many, pack: { ...many.pack, candidates }, candidateCorpusIds: candidates.map(() => 'internal.fixture.file') }) });
  expect(receipt.questions![0]!.passage.firstHitRank).toBe(7);
  expect(receipt.summary.overall.passage.mrr).toBeCloseTo(1 / 7);
  expect(receipt.summary.overall.passage.hitsAtK).toEqual({ '1': 0, '3': 0, '5': 0, '10': 1, '12': 1 });
});
test('fits the pack in the compact format the local Analyst is sent', async () => {
  const base = detail(`${'unrelated filler '.repeat(400)} ${quote}`);
  const target = base.pack.candidates[0]!;
  const candidates = Array.from({ length: 5 }, (_, i) => ({ ...target, provenance: { ...target.provenance, sourceItem: { ...target.provenance.sourceItem, providerItemId: i === 0 ? 'copy' : `other${i}` } } }));
  const many = { ...base, pack: { ...base.pack, candidates }, candidateCorpusIds: candidates.map(() => 'internal.fixture.file') };
  const sees = (format: 'full' | 'compact', bytes: number) => fitPackToPromptBytes(many.pack, bytes,
    new Map(candidates.map(candidate => [candidate, 'internal.fixture.file'])), { localOnly: false }, many.recencySeats, format)
    .candidates.find(candidate => candidate.provenance.sourceItem.providerItemId === 'copy')?.chunks.join('\n').includes(quote) ?? false;
  // A budget where only the compact rendering leaves room for the quote.
  let budget: number | undefined;
  for (let bytes = 2_000; bytes <= 40_000 && budget === undefined; bytes += 250) if (sees('compact', bytes) && !sees('full', bytes)) budget = bytes;
  expect(budget).toBeDefined();
  const receipt = await runPassageEval({ dataset, maxResults: 5, promptBytes: budget!, storeCounts: counts, gitSha: 'abc', buildPack: async () => many });
  expect(receipt.questions![0]!.passage.firstHitRank).toBe(1);
});
test('a degraded question is recorded by store and lane, left out of recall, and the run goes on', async () => {
  const cut = (): EvidencePackBuildDetail => ({ ...detail(), degradations: [{ laneName: 'internal.fixture.file:connector_store_vector', reason: 'semantic_lane_skipped', detail: 'Confidential degradation detail', occurrences: 1 }] } as unknown as EvidencePackBuildDetail);
  const late = (): EvidencePackBuildDetail => ({ ...detail(), corpusTimings: [{ corpusId: 'internal.fixture.file', elapsedMs: 9, outcome: 'timeout' }] } as unknown as EvidencePackBuildDetail);
  for (const broken of [cut, late]) {
    const receipt = await runPassageEval({ dataset, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async q => q.id === 'q1' ? broken() : detail() });
    expect(receipt.summary.overall.degraded).toBe(1);
    expect(receipt.summary.overall.questions).toBe(1);
    expect(receipt.summary.overall.answerable).toBe(0);
    const row = receipt.questions!.find(q => q.questionId === 'q1')!;
    expect(row.degraded!.length).toBeGreaterThan(0);
    expect(row.degraded![0]!.corpusId).toBe('internal.fixture.file');
    expect(JSON.stringify(receipt)).not.toContain('Confidential degradation detail');
  }
});
test('compare scores the questions both runs completed and says how many were left out', async () => {
  const base = await runPassageEval({ dataset, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail() });
  const cut = { ...detail(), degradations: [{ laneName: 'internal.fixture.file:connector_store_vector', reason: 'semantic_lane_skipped', occurrences: 1 }] } as unknown as EvidencePackBuildDetail;
  const current = await runPassageEval({ dataset, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async q => q.id === 'q1' ? cut : detail() });
  const verdict = comparePassageReceipts(current, base);
  expect(verdict.leftOut).toBe(1);
  expect(verdict.gained).toBe(0);
  // Sealed receipts carry no per-question rows, so the two runs must have left out the same questions.
  const sealedBase = await runPassageEval({ dataset, split: 'sealed', maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail() });
  const sealedCut = await runPassageEval({ dataset, split: 'sealed', maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => cut });
  expect(() => comparePassageReceipts(sealedCut, sealedBase)).toThrow('degraded');
  expect(comparePassageReceipts(sealedBase, sealedBase).leftOut).toBe(0);
});
// Where each answerable question's expected item was lost (2026-11-12
// baseline: 3 of 18 hit, and the receipt could not say whether the other 15
// were never found or found and cut).
test('each answerable question records where its expected item was lost, by stage, counts only', async () => {
  const base = detail();
  const target = base.pack.candidates[0]!;
  const seat = (id: string) => ({ ...target, provenance: { ...target.provenance, sourceItem: { ...target.provenance.sourceItem, providerItemId: id } } });
  const packOf = (ids: string[]) => ({ ...base, pack: { ...base.pack, candidates: ids.map(seat) }, candidateCorpusIds: ids.map(() => 'internal.fixture.file') });
  const one = { ...dataset, questions: [dataset.questions[0]!] };
  const run = async (built: EvidencePackBuildDetail, storeSearches: Array<{ corpusId: string; providerItemIds: string[] }>, lanes?: { keyword: number | null; vector: number | null }, promptBytes?: number) =>
    (await runPassageEval({ dataset: one, maxResults: 12, storeCounts: counts, gitSha: 'abc', ...(promptBytes ? { promptBytes } : {}),
      buildPack: async () => ({ ...built, storeSearches }), ...(lanes ? { probeLanes: async () => lanes } : {}) }));
  const hit = await run(packOf(['copy']), [{ corpusId: 'internal.fixture.file', providerItemIds: ['copy'] }], { keyword: 3, vector: null });
  expect(hit.questions![0]!.funnel).toEqual({ stage: 'hit', storeRank: 1, storeHits: 1, packRank: 1, packSize: 1, fitRank: 1, keywordRank: 3, vectorRank: null });
  // In the pack at seat 9, but the prompt fit kept fewer seats.
  const long = `${'unrelated filler '.repeat(300)} ${quote}`;
  const nine = { ...packOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'copy']), pack: { ...packOf([]).pack, candidates: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'copy'].map(id => ({ ...seat(id), chunks: [long] })) } };
  const cut = await run(nine, [{ corpusId: 'internal.fixture.file', providerItemIds: ['copy'] }], undefined, 6_000);
  expect(cut.questions![0]!.funnel).toMatchObject({ stage: 'packed_not_fitted', packRank: 9, fitRank: null });
  const notPacked = await run(packOf(['a']), [{ corpusId: 'internal.fixture.file', providerItemIds: ['a', 'b', 'original'] }]);
  expect(notPacked.questions![0]!.funnel).toMatchObject({ stage: 'returned_not_packed', storeRank: 3, storeHits: 3, packRank: null });
  const notReturned = await run(packOf(['a']), [{ corpusId: 'internal.fixture.file', providerItemIds: ['a'] }], { keyword: 40, vector: null });
  expect(notReturned.questions![0]!.funnel).toMatchObject({ stage: 'found_not_returned', storeRank: null, keywordRank: 40 });
  const lost = await run(packOf(['a']), [{ corpusId: 'internal.fixture.file', providerItemIds: ['a'] }], { keyword: null, vector: null });
  expect(lost.questions![0]!.funnel!.stage).toBe('not_found');
  // Without a lane probe, a miss the store never returned is only "not returned".
  expect((await run(packOf(['a']), [{ corpusId: 'internal.fixture.file', providerItemIds: ['a'] }])).questions![0]!.funnel!.stage).toBe('not_returned');
  const noPassage = await run(packOf(['copy']).pack.candidates.length ? { ...packOf(['copy']), pack: { ...packOf(['copy']).pack, candidates: [{ ...seat('copy'), chunks: ['unrelated text'] }] } } : base, [{ corpusId: 'internal.fixture.file', providerItemIds: ['copy'] }]);
  expect(noPassage.questions![0]!.funnel!.stage).toBe('fitted_no_passage');
  // The summary counts stages, overall and per family.
  expect(lost.summary.overall.funnel).toEqual({ not_found: 1 });
  expect(lost.summary.byFamily.file!.funnel).toEqual({ not_found: 1 });
  expect(JSON.stringify(lost)).not.toContain(question);
});
test('the question judge records whether each quote answers its question and the question is specific, counts only', async () => {
  const one = { ...dataset, questions: [dataset.questions[0]!, dataset.questions[1]!] };
  const asked: string[] = [];
  const receipt = await runPassageEval({ dataset: one, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail(),
    judgeQuestion: async (q, quoted) => { asked.push(`${q}|${quoted}`); return { answers: true, specific: false }; } });
  // Only answerable questions are judged, against their pinned quote.
  expect(asked).toEqual([`${question}|${quote}`]);
  expect(receipt.questions![0]!.judge).toEqual({ answers: true, specific: false });
  expect(receipt.questions![1]!.judge).toBeUndefined();
  expect(receipt.summary.overall.judged).toEqual({ answers: 1, notAnswers: 0, specific: 0, generic: 1, unclear: 0 });
  expect(JSON.stringify(receipt)).not.toContain(quote);
});
test('the lane probe and question judge are not counted in retrieval timings', async () => {
  const one = { ...dataset, questions: [dataset.questions[0]!] };
  const slow = <T>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 300));
  const receipt = await runPassageEval({ dataset: one, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail(),
    probeLanes: () => slow({ keyword: 1, vector: null }), judgeQuestion: () => slow({ answers: true, specific: true }) });
  expect(receipt.questions![0]!.judge).toEqual({ answers: true, specific: true });
  expect(receipt.questions![0]!.timings.totalMs).toBeLessThan(250);
});
test('each row records what the reranker did, and the summary counts outcomes and time', async () => {
  const one = { ...dataset, questions: [dataset.questions[0]!, dataset.questions[1]!] };
  let call = 0;
  const receipt = await runPassageEval({ dataset: one, maxResults: 5, storeCounts: counts, gitSha: 'abc',
    buildPack: async () => ({ ...detail(), rerank: call++ === 0
      ? { rerankerId: 'cross-encoder:model', outcome: 'applied', scored: 24, kept: 5, promoted: 2, elapsedMs: 900 }
      : { rerankerId: 'cross-encoder:model', outcome: 'timed_out', scored: 0, kept: 5, promoted: 0, elapsedMs: 5000 } }) });
  expect(receipt.questions![0]!.rerank).toEqual({ outcome: 'applied', scored: 24, promoted: 2, elapsedMs: 900 });
  expect(receipt.questions![1]!.rerank).toEqual({ outcome: 'timed_out', scored: 0, promoted: 0, elapsedMs: 5000 });
  expect(receipt.summary.overall.rerank).toEqual({ applied: 1, timedOut: 1, failed: 0, elapsedMs: 5900, maxElapsedMs: 5000 });
  expect(receipt.reranker).toBe('cross-encoder:model');
});
