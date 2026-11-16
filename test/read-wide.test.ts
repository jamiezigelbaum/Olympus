import { afterEach, expect, test } from 'bun:test';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { analystPromptBytes, createAnalyst, type AnalystModelRequest } from '../src/core/analyst.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { seatRoutedLanes } from '../src/core/source-index/router.ts';
import { scoresHaveNoLeader } from '../src/core/read-wide.ts';
import { fitPackToPromptBytes } from '../src/workers/source-index/analyst-answer.ts';
import { localAnalystPromptBudget } from '../src/workers/source-index/local-analyst-window.ts';
import { runPassageEval } from '../eval/run-passages.ts';

const saved = process.env.OLYMPUS_READ_WIDE;
afterEach(() => { if (saved === undefined) delete process.env.OLYMPUS_READ_WIDE; else process.env.OLYMPUS_READ_WIDE = saved; });
const corpusId = 'internal.fixture.files';
const sensitivity = buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' });
const registry = buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'internal', activationMode: 'lexical_only' })]);
const ids = Array.from({ length: 16 }, (_, i) => `report-${2000 + i}`);
const sourceItem = (id: string) => ({ family: 'file' as const, provider: 'fixture', accountScope: 'fixture', providerItemId: id, localItemId: id });
const report = 'Synthetic annual report records a measured output of forty units. ';
const build = (leader = false, rerank = false, total = 16, unreadId?: string, includeSemantic = false) => buildEvidencePackDetailed({
  question: 'Compare measured output across all annual reports.', maxResults: 4,
  registry, searchContext: { allowedTrustDomains: ['internal'] }, evidenceByteBudget: 24_000, maxCharsPerCandidate: 6_000,
  adapters: { [corpusId]: request => ({
    hits: ids.slice(0, request.maxResults).map((id, index) => ({ sourceItem: sourceItem(id),
      provenance: { sourceItem: sourceItem(id), citation: { title: id, authoredAt: `${2000 + index}-01-01` } },
      score: leader && index > 1 ? 0.1 : 1, rawExposed: false })),
    ...(includeSemantic ? { semanticRows: { bar: 0.5, hits: [{ sourceItem: sourceItem('neighbour'), score: 0.4, rawExposed: false as const }] } } : {}),
    latencyMs: 0, rawExposed: false,
    matchCount: { matchedItems: total, contentMatchedItems: total, saturated: false, secureMatchedItems: 0 },
  }) },
  contentProviders: { [corpusId]: { fetchLocalContent: async request => ({ sensitivity, chunks: request.provenance.sourceItem.providerItemId === unreadId ? [] : [report.repeat(70).slice(0, request.maxChars)] }) } },
  ...(includeSemantic ? { poolAllocation: { storeDepth: 10, semanticSeats: 1 } } : {}),
  ...(rerank ? { reranker: { id: 'fixture', localOnly: true as const, poolSize: 30, score: async ({ passages }: { passages: readonly string[] }) => passages.map((_, i) => leader && i > 1 ? 0.1 : 1) } } : {}),
});
const fit = (detail: Awaited<ReturnType<typeof build>>, budget = localAnalystPromptBudget(undefined, { windowTokens: 32_768, source: 'server' }, 2_048).bytes) =>
  fitPackToPromptBytes(detail.pack, budget, new Map(detail.pack.candidates.map(c => [c, corpusId])), { localOnly: false }, 0, 'compact');

test('sixteen equal dated reports are seated inside the served window with exact coverage', async () => {
  delete process.env.OLYMPUS_READ_WIDE;
  const old = await build();
  expect(old.pack.candidates).toHaveLength(4);
  process.env.OLYMPUS_READ_WIDE = '1';
  for (const rerank of [false, true]) {
    const detail = await build(false, rerank);
    const fitted = fit(detail);
    expect(fitted.candidates.map(c => c.provenance.sourceItem.providerItemId).sort()).toEqual([...ids].sort());
    expect(analystPromptBytes(fitted, { localOnly: false }, 'compact')).toBeLessThanOrEqual(27_000);
    expect(fitted.coverage.matchCounts![0]).toMatchObject({ matchedItems: 16, inEvidence: 16 });
    const smaller = fit(detail, 10_000);
    expect(smaller.candidates.length).toBeLessThan(16);
    expect(smaller.coverage.matchCounts![0]).toMatchObject({ matchedItems: 16, inEvidence: smaller.candidates.length });
  }
});

test('one or two clear leaders retain the ordinary deep seats', async () => {
  for (const rerank of [false, true]) {
    delete process.env.OLYMPUS_READ_WIDE;
    const old = await build(true, rerank);
    process.env.OLYMPUS_READ_WIDE = '1';
    const wide = await build(true, rerank);
    expect(wide.pack.candidates).toEqual(old.pack.candidates);
    expect(fit(wide).candidates).toEqual(fit(old).candidates);
  }
  expect(scoresHaveNoLeader([1, 0.1, 0.1])).toBe(false);
  expect(scoresHaveNoLeader([undefined, 1, 1])).toBe(false);
});

test('router semantic seats stay additive after the wide match draw', () => {
  const hit = (id: string) => ({ corpusId, trustDomain: 'internal' as const, sourceItem: sourceItem(id), score: 1, rawExposed: false as const });
  const result = seatRoutedLanes([{ name: corpusId, items: ids.map(hit), semantic: [{ hit: hit('semantic-only'), margin: 0.01 }] }],
    { maxResults: 4, poolAllocation: { storeDepth: 10, semanticSeats: 1 }, readWide: true });
  expect(result.hits.map(h => h.sourceItem.providerItemId)).toEqual([...ids, 'semantic-only']);
});

test('the Analyst receives read and omitted counts and the multi-item receipt counts every needed entry', async () => {
  process.env.OLYMPUS_READ_WIDE = '1';
  const detail = await build(false, false, 18);
  const pack = fit(detail);
  const calls: AnalystModelRequest[] = [];
  await createAnalyst({ complete: async request => { calls.push(request); return { text: JSON.stringify({ answer: 'Read 16 of 18 matching files; 2 left out.', citations: [], unanswered: [], sufficient: true }), modelId: 'fixture' }; } }, { evidenceFormat: 'compact' }).analyze(pack, { localOnly: false });
  expect(calls[0]!.prompt).toContain('16 in evidence');
  expect(calls[0]!.prompt).toContain('18 items');
  const receipt = await runPassageEval({ dataset: { version: '1', description: 'Synthetic wide retrieval.', questions: [{ id: 'wide-1', shape: 'trend_or_chronology', question: 'Compare annual measured output.',
    expectedEvidence: ids.map(id => ({ corpusId, providerItemId: id, hint: 'Synthetic annual report', quote: report.trim() })) }] },
    maxResults: 4, promptBytes: 27_000, gitSha: 'fixture', storeCounts: [], buildPack: async () => detail,
    answer: async () => ({ answer: 'Synthetic output.', citations: [pack.candidates[0]!, pack.candidates[0]!, pack.candidates[1]!].map(c => ({ provenance: c.provenance, claim: 'Synthetic output.' })), unanswered: [] }) });
  expect(receipt.questions![0]!.neededEvidence).toMatchObject({ needed: 16, packed: 16, seated: 16, cited: 2, citedIds: [1, 2] });
  expect(JSON.stringify(receipt)).not.toContain(report.trim());
});

test('wide draw caps matches at sixty and keeps semantic additions outside that cap', () => {
  const hit = (id: string) => ({ corpusId, trustDomain: 'internal' as const, sourceItem: sourceItem(id), score: 1, rawExposed: false as const });
  const matches = Array.from({ length: 80 }, (_, i) => hit(`match-${i}`));
  const result = seatRoutedLanes([{ name: corpusId, items: matches, semantic: [{ hit: hit('extra'), margin: -0.01 }] }],
    { maxResults: 4, readWide: true, poolAllocation: { storeDepth: 10, semanticSeats: 1 } });
  expect(result.hits).toHaveLength(61);
  expect(result.hits[60]!.sourceItem.providerItemId).toBe('extra');
});

test('unread names and below-bar semantic additions never inflate matching items read', async () => {
  process.env.OLYMPUS_READ_WIDE = '1';
  const detail = await build(false, true, 16, ids[0], true);
  expect(detail.pack.candidates).toHaveLength(17);
  expect(detail.pack.coverage.matchCounts![0]).toMatchObject({ matchedItems: 16, inEvidence: 15 });
  const fitted = fit(detail);
  expect(fitted.candidates).toHaveLength(17);
  expect(fitted.coverage.matchCounts![0]).toMatchObject({ matchedItems: 16, inEvidence: 15 });
});
