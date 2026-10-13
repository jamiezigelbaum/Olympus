import { expect, test } from 'bun:test';
import type { EvidencePack } from '../src/core/contracts.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';

const corpus = defineSourceIndexCorpus({ corpusId: 'internal.fixture', family: 'file', trustDomain: 'internal' });
const item = (id: string) => ({ family: 'file' as const, provider: 'fixture', accountScope: 'synthetic', localItemId: id, providerItemId: id });
const pack: EvidencePack = { question: 'Review annual invented statements', builtAt: '2026-10-13T00:00:00Z', coverage: { searchedCorpora: [corpus.corpusId], skippedCorpora: [], extractionGaps: [] }, candidates: [1, 2].map(i => ({ provenance: { sourceItem: item(String(i)) }, trustTier: 'S3' as const, trustDomain: 'internal' as const, chunks: [JSON.stringify([{ category: 'groceries', amount: String(i * 20) }])] })) };
function handler(current: () => boolean, seen: EvidencePack[], digestPack = pack) {
  return createAnalystSourceIndexAnswerHandler({
    analyst: { analyze: async () => ({ answer: 'Local fallback', citations: [], unanswered: [] }) },
    veniceAnalyst: () => ({ analyze: async received => { seen.push(received); return { answer: 'The invented spending changed.', citations: [], unanswered: [] }; } }),
    documentDigest: async () => ({ kind: 'digest' as const, pack: digestPack, snapshot: digestPack, current, refs: digestPack.candidates.map(candidate => ({ corpusId: corpus.corpusId, document: { sourceItem: candidate.provenance.sourceItem, provenance: candidate.provenance, revision: 'fixture-revision' } })) }),
    lanes: () => ({ registry: buildSourceIndexCorpusRegistry([corpus]), adapters: { [corpus.corpusId]: async () => ({ hits: [{ sourceItem: item('1'), rawExposed: false as const }], latencyMs: 0, rawExposed: false as const }) }, contentProviders: { [corpus.corpusId]: { fetchLocalContent: async () => ({ sensitivity: { trustTier: 'S3' as const, trustDomain: 'internal' as const, localOnly: false, cloudEmbeddingEligible: false }, chunks: ['Invented excerpt'] }) } } }),
  });
}
test('Venice receives the shared digest when it covers more documents than the excerpt pack', async () => {
  const seen: EvidencePack[] = [];
  await handler(() => true, seen).answer({ question: pack.question, analyst_provider: 'venice' });
  expect(seen[0]?.candidates).toHaveLength(2);
  expect(seen[0]?.candidates[1]?.chunks).toEqual(['[{"category":"groceries","amount":"40"}]']);
});
test('a revoked digest cannot reach Venice or be published through local fallback', async () => {
  const seen: EvidencePack[] = [];
  await expect(handler(() => false, seen).answer({ question: pack.question, analyst_provider: 'venice' })).rejects.toThrow('Document authorization changed');
  expect(seen).toEqual([]);
});
test('a successful digest is used even when its JSON is larger than one raw excerpt', async () => {
  const seen: EvidencePack[] = [];
  await handler(() => true, seen, { ...pack, candidates: [pack.candidates[0]!] }).answer({ question: pack.question, analyst_provider: 'venice' });
  expect(seen[0]?.candidates[0]?.chunks).toEqual(['[{"category":"groceries","amount":"20"}]']);
  expect(JSON.stringify(seen)).not.toContain('Invented excerpt');
});
