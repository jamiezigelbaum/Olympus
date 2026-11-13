import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { EvidencePackBuildDetail } from '../src/core/evidence-pack.ts';
import type { AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import { comparePassageReceipts, evalWindowPlacement, runPassageEval } from '../eval/run-passages.ts';
import { fitPackToPromptBytes } from '../src/workers/source-index/analyst-answer.ts';
import type { EvalDataset } from '../eval/types.ts';
import { createTestClock } from './helpers/test-clock.ts';
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
  // A fake clock: only the probe and the judge move it.
  let now = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const receipt = await runPassageEval({ dataset: one, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail(),
      probeLanes: async () => { now += 1_000; return { keyword: 1, vector: null }; },
      judgeQuestion: async () => { now += 1_000; return { answers: true, specific: true }; } });
    expect(receipt.questions![0]!.judge).toEqual({ answers: true, specific: true });
    expect(receipt.questions![0]!.timings.totalMs).toBe(0);
  } finally { clock.mockRestore(); }
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
test('each question reports its steps in order, by number only', async () => {
  const steps: string[] = [];
  await runPassageEval({ dataset: { ...dataset, questions: [dataset.questions[0]!, dataset.questions[1]!] }, maxResults: 5, storeCounts: counts, gitSha: 'abc',
    buildPack: async () => detail(), probeLanes: async () => ({ keyword: 1, vector: null }), judgeQuestion: async () => ({ answers: true, specific: true }),
    onProgress: (index, total, step) => { steps.push(`${index}/${total} ${step}`); } });
  expect(steps).toEqual(['1/2 build_pack', '1/2 fit', '1/2 probe_lanes', '1/2 judge', '2/2 build_pack', '2/2 fit']);
});
test('rows carry the expected item chunk count; summaries count each funnel reach and group by item length', async () => {
  const two = { ...dataset, questions: [dataset.questions[0]!, { ...dataset.questions[0]!, id: 'q9', expectedEvidence: [{ corpusId: 'internal.fixture.file', providerItemId: 'missing', quote, hint: '' }] }] };
  const receipt = await runPassageEval({ dataset: two, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => ({ ...detail(), storeSearches: [] }),
    itemChunks: (_corpusId, providerItemId) => (providerItemId === 'missing' ? 6 : 1) });
  // q1's alternate 'copy' is seated with the passage; q9's item is nowhere.
  expect(receipt.questions![0]!.funnel!.chunks).toBe(1);
  expect(receipt.questions![1]!.funnel!.chunks).toBe(6);
  expect(receipt.summary.overall.reach).toEqual({ found: 1, returned: 1, seated: 1, fitted: 1, passage: 1 });
  expect(Object.keys(receipt.summary.byLength).sort()).toEqual(['1_chunk', '4+_chunks']);
  expect(receipt.summary.byLength['4+_chunks']!.answerable).toBe(1);
});

test('a store left without a seat by the seat budget is not a degraded search', async () => {
  const one = { ...dataset, questions: [dataset.questions[0]!] };
  const receipt = await runPassageEval({ dataset: one, maxResults: 5, storeCounts: counts, gitSha: 'abc',
    buildPack: async () => ({ ...detail(), degradations: [{ laneName: 'internal.other.mail', laneType: 'keyword', reason: 'lane_budget_cut', occurrences: 1 }] }) });
  expect(receipt.questions![0]!.degraded).toBeUndefined();
  expect(receipt.degradedIds).toEqual([]);
});

const answerQuote = 'The café amber violet silver cedar'; // Five content words.
const answerDataset: EvalDataset = { ...dataset, questions: [{ ...dataset.questions[0]!,
  expectedEvidence: [{ ...dataset.questions[0]!.expectedEvidence![0]!, quote: answerQuote }] }] };
function answered(text: string, cited = true): AnalystResult {
  return { answer: text, citations: cited ? [{ provenance: structuredClone(detail().pack.candidates[0]!.provenance), claim: 'Synthetic claim sentinel' }] : [], unanswered: [] };
}

test('answer grading requires an expected citation and at least four of five content words', async () => {
  const clock = createTestClock(0);
  const now = spyOn(performance, 'now').mockImplementation(clock.now);
  try {
    for (const [text, cited, coverage, right] of [
      ['CAFÉ, amber violet silver', true, 0.8, true],
      ['cafe amber violet', true, 0.6, false],
      ['cafe amber violet silver cedar', false, 1, false],
    ] as const) {
      const receipt = await runPassageEval({ dataset: answerDataset, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail(),
        answer: async () => { await clock.advance(17); return answered(text, cited); } });
      expect(receipt.questions![0]!.answer).toEqual({ outcome: 'answered', cited, coverage, right, answerMs: 17 });
    }
  } finally { now.mockRestore(); }
});

test('answer coverage ignores stop words, short words and numbers, and uses passage normalization', async () => {
  for (const [quote, text, coverage] of [
    ['The and with from this that is an of to 12 123 café amber violet silver cedar', 'cafe amber violet silver', 0.8],
    ['The and with from this that is an of to 12 123', 'The and with from this that is an of to 12 123', 0],
    ['The café am-\nber violet silver cedar', 'cafe amber violet silver', 0.8],
  ] as const) {
    const one = { ...answerDataset, questions: [{ ...answerDataset.questions[0]!, expectedEvidence: [{ ...answerDataset.questions[0]!.expectedEvidence![0]!, quote }] }] };
    const receipt = await runPassageEval({ dataset: one, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail(), answer: async () => answered(text) });
    expect(receipt.questions![0]!.answer!.coverage).toBe(coverage);
  }
});

test('answer citations match corpus and item identity including alternates', async () => {
  for (const [corpusId, providerItemId, cited] of [
    ['internal.fixture.file', 'original', true], ['internal.fixture.file', 'copy', true],
    ['internal.other.file', 'copy', false], ['internal.fixture.file', 'wrong', false],
  ] as const) {
    const result = answered('cafe amber violet silver cedar');
    const provenance = { ...result.citations[0]!.provenance, localIds: { corpus_id: corpusId }, sourceItem: { ...result.citations[0]!.provenance.sourceItem, providerItemId } };
    const receipt = await runPassageEval({ dataset: answerDataset, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail(),
      answer: async () => ({ ...result, citations: [{ provenance, claim: 'Synthetic claim sentinel' }] }) });
    expect(receipt.questions![0]!.answer).toMatchObject({ cited, coverage: 1, right: cited });
  }
});

test('the answer sees the fitted pack immediately after fit and its time is separate', async () => {
  const clock = createTestClock(0);
  const now = spyOn(performance, 'now').mockImplementation(clock.now);
  const steps: string[] = [];
  const built = detail(`${'unrelated filler '.repeat(2000)} ${quote}`);
  try {
    const receipt = await runPassageEval({ dataset: answerDataset, maxResults: 5, promptBytes: 5000, storeCounts: counts, gitSha: 'abc',
      buildPack: async () => built, onProgress: (_index, _total, step) => { steps.push(step); },
      probeLanes: async () => ({ keyword: 1, vector: null }), judgeQuestion: async () => ({ answers: true, specific: true }),
      answer: async (question, pack) => {
        expect(question).toBe(answerDataset.questions[0]!);
        expect(pack.candidates).toHaveLength(1);
        expect(pack.candidates[0]!.chunks.join('')).not.toContain(quote);
        expect(pack.candidates[0]!.chunks.join('').length).toBeLessThan(built.pack.candidates[0]!.chunks.join('').length);
        await clock.advance(31);
        return answered('cafe amber violet silver');
      } });
    expect(steps).toEqual(['build_pack', 'fit', 'answer', 'probe_lanes', 'judge']);
    expect(receipt.questions![0]!.answer!.answerMs).toBe(31);
    expect(receipt.questions![0]!.timings.totalMs).toBe(0);
  } finally { now.mockRestore(); }
});

test('answer failures keep only safe codes, continue the run, and receipts contain no content', async () => {
  const sentinel = 'Synthetic private sentinel never written';
  const many = { ...answerDataset, questions: Array.from({ length: 4 }, (_, i) => ({ ...answerDataset.questions[0]!, id: `a${i}` })) };
  const calls: string[] = [];
  const receipt = await runPassageEval({ dataset: many, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail(),
    answer: async q => {
      calls.push(q.id);
      if (q.id === 'a0') throw Object.assign(new Error(sentinel), { code: 'ECONNREFUSED' });
      if (q.id === 'a1') throw Object.assign(new Error(sentinel), { code: sentinel });
      if (q.id === 'a2') throw sentinel;
      return answered(`${sentinel} cafe amber violet silver cedar`);
    } });
  expect(calls).toEqual(['a0', 'a1', 'a2', 'a3']);
  expect(receipt.questions![0]!.answer).toEqual({ outcome: 'failed', code: 'ECONNREFUSED' });
  expect(receipt.questions![1]!.answer).toEqual({ outcome: 'failed', code: 'UNKNOWN' });
  expect(receipt.questions![2]!.answer).toEqual({ outcome: 'failed', code: 'UNKNOWN' });
  expect(receipt.questions![3]!.answer!.right).toBe(true);
  const json = JSON.stringify(receipt);
  for (const text of [sentinel, answerQuote, 'Synthetic claim sentinel', question, passage]) expect(json).not.toContain(text);
});

test('answer summaries count attempts and successful-call percentiles by family and length, including sealed runs', async () => {
  const clock = createTestClock(0);
  const now = spyOn(performance, 'now').mockImplementation(clock.now);
  const many: EvalDataset = { ...answerDataset, questions: Array.from({ length: 5 }, (_, i) => ({ ...answerDataset.questions[0]!, id: `a${i}`,
    expectedEvidence: [{ ...answerDataset.questions[0]!.expectedEvidence![0]!, corpusId: i < 3 ? 'internal.fixture.file' : 'internal.fixture.mail', providerItemId: `item${i}`, alternates: [] }] })) };
  try {
    for (const split of ['open', 'sealed'] as const) {
      const receipt = await runPassageEval({ dataset: { ...many, questions: many.questions.map(q => ({ ...q, split })) }, split,
        maxResults: 5, storeCounts: [...counts, { ...counts[0]!, corpusId: 'internal.fixture.mail', family: 'email' }], gitSha: 'abc', buildPack: async () => detail(),
        itemChunks: (_corpus, item) => Number(item.slice(-1)) < 3 ? 1 : 7,
        answer: async q => {
          const n = Number(q.id.slice(1));
          await clock.advance([10, 30, 900, 70, 50][n]!);
          if (n === 2) throw new Error('Synthetic failure sentinel');
          const result = answered(n === 1 ? 'cafe amber violet' : 'cafe amber violet silver cedar', n !== 4);
          return { ...result, citations: result.citations.map(citation => ({ ...citation, provenance: { ...citation.provenance,
            localIds: { corpus_id: q.expectedEvidence![0]!.corpusId }, sourceItem: { ...citation.provenance.sourceItem, providerItemId: q.expectedEvidence![0]!.providerItemId! } } })) };
        } });
      expect(receipt.summary.overall.answer).toEqual({ asked: 5, right: 2, cited: 3, failed: 1, medianMs: 40, p90Ms: 70 });
      const file = { asked: 3, right: 1, cited: 2, failed: 1, medianMs: 20, p90Ms: 30 };
      const mail = { asked: 2, right: 1, cited: 1, failed: 0, medianMs: 60, p90Ms: 70 };
      expect(receipt.summary.byFamily.file!.answer).toEqual(file);
      expect(receipt.summary.byLength['1_chunk']!.answer).toEqual(file);
      expect(receipt.summary.byFamily.email!.answer).toEqual(mail);
      expect(receipt.summary.byLength['4+_chunks']!.answer).toEqual(mail);
      if (split === 'sealed') expect(receipt.questions).toBeUndefined();
    }
    const failed = await runPassageEval({ dataset: answerDataset, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail(), answer: async () => { throw new Error('Synthetic failure'); } });
    expect(failed.summary.overall.answer).toEqual({ asked: 1, right: 0, cited: 0, failed: 1, medianMs: 0, p90Ms: 0 });
  } finally { now.mockRestore(); }
});

test('without an answer callback the serialized receipt is byte-identical to the retrieval-only baseline', async () => {
  const now = spyOn(performance, 'now').mockReturnValue(0);
  try {
    const receipt = await runPassageEval({ dataset, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail() });
    expect(createHash('sha256').update(JSON.stringify(receipt)).digest('hex')).toBe('56f12eb867b6dce832872531b0387a32ff5b3955e45b415f184184e307ec6ead');
  } finally { now.mockRestore(); }
});


test('every passage row carries the full placement audit and summaries count placement work including degraded questions', async () => {
  const audits: NonNullable<EvidencePackBuildDetail['windowPlacement']>[] = [
    { seats: 3, scorer: 'reranker', windowsSubmitted: 24, windowsScored: 24, elapsedMs: 40, timedOut: false,
      calls: [{ windows: 24, ms: 40, outcome: 'scored' }] },
    { seats: 1, scorer: 'embedding', windowsSubmitted: 8, windowsScored: 0, elapsedMs: 1500, timedOut: true,
      calls: [{ windows: 8, ms: 1500, outcome: 'timed_out' }] },
    { seats: 0, scorer: 'embedding', windowsSubmitted: 0, windowsScored: 0, elapsedMs: 0, timedOut: false,
      skipped: 'slow_scorer', calls: [] },
  ];
  const three = { ...dataset, questions: audits.map((_, i) => ({ ...dataset.questions[0]!, id: `placement${i}` })) };
  let call = 0;
  const receipt = await runPassageEval({ dataset: three, maxResults: 5, storeCounts: counts, gitSha: 'abc',
    buildPack: async () => ({ ...detail(), windowPlacement: audits[call++]!,
      ...(call === 2 ? { corpusTimings: [{ corpusId: 'internal.fixture.file', elapsedMs: 9, outcome: 'timeout' as const }] } : {}) }) });
  expect(receipt.questions!.map(row => row.windowPlacement)).toEqual(audits);
  expect(receipt.summary.overall.windowPlacement).toEqual({ placed: 1, timedOut: 1, skipped: 1, elapsedMs: 1540, maxElapsedMs: 1500 });
});

test('window placement ceiling switches are eval-only, off by default, and refuse bad values', () => {
  expect(evalWindowPlacement({})).toBeUndefined();
  expect(evalWindowPlacement({ OLYMPUS_EVAL_WINDOW_PLACEMENT_BUDGET_MS: '10000', OLYMPUS_EVAL_WINDOW_PLACEMENT_SLOW_SKIP: 'off' })).toEqual({ budgetMs: 10_000, slowSkip: false });
  expect(evalWindowPlacement({ OLYMPUS_EVAL_WINDOW_PLACEMENT_SLOW_SKIP: 'on' })).toBeUndefined();
  expect(() => evalWindowPlacement({ OLYMPUS_EVAL_WINDOW_PLACEMENT_BUDGET_MS: '0' })).toThrow();
  expect(() => evalWindowPlacement({ OLYMPUS_EVAL_WINDOW_PLACEMENT_SLOW_SKIP: 'maybe' })).toThrow();
});
