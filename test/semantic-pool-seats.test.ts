import { describe, expect, test } from 'bun:test';
import { buildEvidencePackDetailed, type LocalContentProvider } from '../src/core/evidence-pack.ts';
import { rerankPoolSemanticSeats, semanticRowsPerStore, type EvidenceReranker } from '../src/core/evidence-reranker.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { withSemanticPoolSeats, type SourceIndexCorpusSearchAdapter, type SourceIndexRoutedSearchHit } from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { createTestClock } from './helpers/test-clock.ts';

// RECALL GROUPS (olympus-ops#151, 13 Nov): 13 of 75 answerable items were
// found by a lane of their store, often the vector lane's first row, yet the
// store never returned them: their cosine sat under the bar and the store's
// keyword matches filled its list. Semantic seats put each store's nearest
// rows in the reranked pool by margin over the bar; the reranker decides.

const item = (id: string) => ({ family: 'chat' as const, provider: 'fixture', accountScope: 'personal', providerItemId: id, localItemId: id });
const routed = (corpusId: string, id: string): SourceIndexRoutedSearchHit => ({
  sourceItem: item(id), provenance: { sourceItem: item(id), citation: { title: id } }, rawExposed: false, corpusId, trustDomain: 'internal',
});

describe('withSemanticPoolSeats', () => {
  const lanes = [
    { name: 'a', items: [], semantic: [{ hit: routed('a', 'a1'), margin: 0.05 }, { hit: routed('a', 'a2'), margin: 0.04 }, { hit: routed('a', 'a3'), margin: 0.03 }] },
    { name: 'b', items: [], semantic: [{ hit: routed('b', 'b1'), margin: -0.02 }, { hit: routed('b', 'b2'), margin: -0.2 }] },
  ];

  test('best margin first, at most two per store, after the drawn pool', () => {
    const { hits, seated } = withSemanticPoolSeats([routed('c', 'c1')], lanes, 4);
    expect(hits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['c1', 'a1', 'a2', 'b1', 'b2']);
    expect(seated.map((seat) => seat.margin)).toEqual([0.05, 0.04, -0.02, -0.2]);
  });

  test('skips what the pool already holds and stops at the seat count', () => {
    const { hits } = withSemanticPoolSeats([routed('a', 'a1')], lanes, 2);
    expect(hits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['a1', 'a2', 'a3']);
  });

  test('no seats leaves the pool as drawn', () => {
    expect(withSemanticPoolSeats([routed('c', 'c1')], lanes, 0).seated).toEqual([]);
  });
});

describe('rerankPoolSemanticSeats', () => {
  test('reads the eval switch and ignores nonsense', () => {
    expect(rerankPoolSemanticSeats({})).toBe(0);
    expect(rerankPoolSemanticSeats({ OLYMPUS_SEMANTIC_POOL_SEATS: '6' })).toBe(6);
    expect(rerankPoolSemanticSeats({ OLYMPUS_SEMANTIC_POOL_SEATS: '-1' })).toBe(0);
    expect(rerankPoolSemanticSeats({ OLYMPUS_SEMANTIC_POOL_SEATS: 'x' })).toBe(0);
  });

  test('rows offered per store: 3 by default, the eval switch from 1 to 50', () => {
    expect(semanticRowsPerStore({})).toBe(3);
    expect(semanticRowsPerStore({ OLYMPUS_SEMANTIC_ROWS_PER_STORE: '10' })).toBe(10);
    expect(semanticRowsPerStore({ OLYMPUS_SEMANTIC_ROWS_PER_STORE: '0' })).toBe(3);
  });
});

// A strong file store fills the pool; a chat store's keyword matches fill its
// own list, and its nearest vector row (under the bar) is the answer.
function input() {
  const files = ['internal.a', 'internal.b'];
  const hit = (id: string) => ({ sourceItem: item(id), provenance: { sourceItem: item(id), citation: { title: id } }, rawExposed: false as const });
  const fileAdapter = (corpusId: string): SourceIndexCorpusSearchAdapter => (request) => ({
    hits: Array.from({ length: 10 }, (_, index) => hit(`${corpusId}-${index + 1}`)).slice(0, request.maxResults),
    storeRelevance: { conceptShare: 0.9 },
    latencyMs: 1, rawExposed: false as const,
  });
  const chat: SourceIndexCorpusSearchAdapter = (request) => ({
    hits: Array.from({ length: 10 }, (_, index) => hit(`chat-${index + 1}`)).slice(0, request.maxResults),
    storeRelevance: { conceptShare: 0 },
    semanticRows: { hits: [{ ...hit('chat-answer'), score: 0.7 }, { ...hit('chat-1'), score: 0.6 }], bar: 0.73 },
    latencyMs: 1, rawExposed: false as const,
  });
  const provider: LocalContentProvider = {
    async fetchLocalContent(request) {
      const id = request.provenance.sourceItem.providerItemId;
      return { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: [id === 'chat-answer' ? 'The invoice total is due on 3 March.' : `Unrelated note ${id}.`] };
    },
  };
  const reranker: EvidenceReranker = {
    id: 'fixture-overlap', localOnly: true, poolSize: 8,
    async score({ query, passages }) {
      const words = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
      return passages.map((passage) => passage.toLowerCase().split(/\W+/).filter((word) => words.has(word)).length);
    },
  };
  const clock = createTestClock();
  const stores = [...files, 'internal.chat'];
  return {
    question: 'When is the invoice total due?',
    maxResults: 3,
    searchContext: { allowedTrustDomains: ['internal' as const] },
    registry: buildSourceIndexCorpusRegistry([
      ...files.map((corpusId) => defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'internal' })),
      defineSourceIndexCorpus({ corpusId: 'internal.chat', family: 'chat', trustDomain: 'internal' }),
    ]),
    adapters: { ...Object.fromEntries(files.map((corpusId) => [corpusId, fileAdapter(corpusId)])), 'internal.chat': chat },
    contentProviders: Object.fromEntries(stores.map((corpusId) => [corpusId, provider])),
    reranker,
    rerankTimers: {
      now: () => clock.now(),
      setTimeout: (callback: () => void, ms: number) => clock.setTimeout(callback, ms),
      clearTimeout: (handle: unknown) => clock.clearTimeout(handle as Parameters<typeof clock.clearTimeout>[0]),
    },
  };
}
const packIds = (detail: Awaited<ReturnType<typeof buildEvidencePackDetailed>>) =>
  detail.pack.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId);

describe('a reranked pack with semantic seats', () => {
  test('a store\'s nearest row under the bar reaches the reranker and the pack', async () => {
    const detail = await buildEvidencePackDetailed({ ...input(), poolAllocation: { storeDepth: 10, semanticSeats: 2 } });
    expect(packIds(detail)[0]).toBe('chat-answer');
  });

  test('without seats it is crowded out', async () => {
    const detail = await buildEvidencePackDetailed({ ...input(), poolAllocation: { storeDepth: 10 } });
    expect(packIds(detail)).not.toContain('chat-answer');
  });
});
