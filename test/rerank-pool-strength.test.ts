import { describe, expect, test } from 'bun:test';
import { buildEvidencePackDetailed, type LocalContentProvider } from '../src/core/evidence-pack.ts';
import type { EvidenceReranker } from '../src/core/evidence-reranker.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import {
  applyPerCorpusResultBudget,
  applyStrengthPoolBudget,
  fuseRankedCandidateLanes,
} from '../src/core/source-index/retrieval.ts';
import type { SourceIndexCorpusSearchAdapter } from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { createTestClock } from './helpers/test-clock.ts';

// Stores a, b, c with six ranked items each, fused the way the router fuses
// them: one lane per store, so each rank tier is a full tie across stores.
function fused(stores: readonly string[], depth = 6) {
  return fuseRankedCandidateLanes({
    lanes: stores.map((corpusId) => ({
      name: corpusId,
      items: Array.from({ length: depth }, (_, index) => ({ corpusId, id: `${corpusId}${index + 1}` })),
    })),
    getId: (item) => item.id as never,
    limit: stores.length * depth,
    tieBreaker: (left, right) => stores.indexOf(left.item.corpusId) - stores.indexOf(right.item.corpusId),
  });
}
const ids = (hits: ReadonlyArray<{ id: string }>) => hits.map((hit) => hit.id).sort();

describe('applyStrengthPoolBudget', () => {
  test('seats every store leader, then goes deep in the strongest store first', () => {
    const order = new Map([['c', 0], ['a', 1], ['b', 2]]);
    const { hits, degradations } = applyStrengthPoolBudget(fused(['a', 'b', 'c']), 8, order, 5);
    expect(ids(hits)).toEqual(['a1', 'a2', 'b1', 'c1', 'c2', 'c3', 'c4', 'c5']);
    expect(degradations).toEqual([]);
  });

  test('keeps fused order in what it returns', () => {
    const order = new Map([['c', 0], ['a', 1], ['b', 2]]);
    const { hits } = applyStrengthPoolBudget(fused(['a', 'b', 'c']), 5, order, 5);
    expect(hits.map((hit) => hit.id)).toEqual(['a1', 'b1', 'c1', 'c2', 'c3']);
  });

  test('when every store is at its depth, the rest are seated in turns, strongest store first', () => {
    const order = new Map([['c', 0], ['a', 1], ['b', 2]]);
    const { hits } = applyStrengthPoolBudget(fused(['a', 'b', 'c']), 8, order, 2);
    expect(ids(hits)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'c1', 'c2', 'c3']);
  });

  test('more stores than seats, or a pool that fits, is the even budget', () => {
    const stores = ['a', 'b', 'c'];
    const order = new Map([['c', 0], ['a', 1], ['b', 2]]);
    expect(applyStrengthPoolBudget(fused(stores), 2, order, 5)).toEqual(applyPerCorpusResultBudget(fused(stores), 2));
    expect(applyStrengthPoolBudget(fused(stores, 2), 10, order, 5)).toEqual(applyPerCorpusResultBudget(fused(stores, 2), 10));
  });
});

// Four stores; the strongest by concept share holds the answer at its rank 6.
function packInput() {
  const stores = ['internal.a', 'internal.b', 'internal.c', 'internal.d'];
  const answerStore = 'internal.c';
  const item = (id: string) => ({ family: 'file' as const, provider: 'fixture', accountScope: 'personal', providerItemId: id, localItemId: id });
  const adapter = (corpusId: string): SourceIndexCorpusSearchAdapter => (request) => ({
    hits: Array.from({ length: 8 }, (_, index) => `${corpusId}-${index + 1}`).slice(0, request.maxResults).map((id) => ({
      sourceItem: item(id), provenance: { sourceItem: item(id), citation: { title: id } }, rawExposed: false as const,
    })),
    storeRelevance: { conceptShare: corpusId === answerStore ? 0.75 : 0 },
    latencyMs: 1,
    rawExposed: false as const,
  });
  const provider: LocalContentProvider = {
    async fetchLocalContent(request) {
      const id = request.provenance.sourceItem.providerItemId;
      return {
        sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }),
        chunks: [id === `${answerStore}-6` ? 'The invoice total is due on 3 March.' : `Unrelated note ${id}.`],
      };
    },
  };
  const scored: string[][] = [];
  const reranker: EvidenceReranker = {
    id: 'fixture-overlap', localOnly: true, poolSize: 9,
    async score({ query, passages }) {
      scored.push([...passages]);
      const words = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
      return passages.map((passage) => passage.toLowerCase().split(/\W+/).filter((word) => words.has(word)).length);
    },
  };
  const clock = createTestClock();
  return {
    scored,
    input: {
      question: 'When is the invoice total due?',
      maxResults: 3,
      searchContext: { allowedTrustDomains: ['internal' as const] },
      registry: buildSourceIndexCorpusRegistry(stores.map((corpusId) => defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'internal' }))),
      adapters: Object.fromEntries(stores.map((corpusId) => [corpusId, adapter(corpusId)])),
      contentProviders: Object.fromEntries(stores.map((corpusId) => [corpusId, provider])),
      reranker,
      rerankTimers: {
        now: () => clock.now(),
        setTimeout: (callback: () => void, ms: number) => clock.setTimeout(callback, ms),
        clearTimeout: (handle: unknown) => clock.clearTimeout(handle as Parameters<typeof clock.clearTimeout>[0]),
      },
    },
  };
}

const packIds = (detail: Awaited<ReturnType<typeof buildEvidencePackDetailed>>) =>
  detail.pack.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId);

describe('buildEvidencePackDetailed draws the rerank pool by store strength', () => {
  test('the strong store goes deep, every store keeps its leader, and the reranker finds the answer', async () => {
    const { input, scored } = packInput();
    const detail = await buildEvidencePackDetailed(input);
    expect(scored[0]).toHaveLength(9);
    expect(packIds(detail)[0]).toBe('internal.c-6');
    for (const store of ['a', 'b', 'd']) expect(scored[0]!.some((passage) => passage.includes(`internal.${store}-1`))).toBe(true);
  });

  test('without a reranker the even cut stands', async () => {
    const { reranker: _reranker, ...plain } = packInput().input;
    const ids = packIds(await buildEvidencePackDetailed(plain));
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain('internal.c-6');
  });
});
