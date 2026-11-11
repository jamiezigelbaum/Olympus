import { expect, test } from 'bun:test';
import type { EvidencePackBuildDetail } from '../src/core/evidence-pack.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import { comparePassageReceipts, runPassageEval } from '../eval/run-passages.ts';
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
  const base = await runPassageEval({ dataset, maxResults: 5, storeCounts: counts, gitSha: 'abc', buildPack: async () => detail() });
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
