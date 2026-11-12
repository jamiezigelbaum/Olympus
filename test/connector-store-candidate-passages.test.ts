import { afterEach, expect, test } from 'bun:test';
import type { SourceIndexProvenance } from '../src/core/source-index/types.ts';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { LocalConnectorStore, createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, fixtureItem, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';
import { createTestClock } from './helpers/test-clock.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const CHUNK_SIZE = 1_000;
// Fixed-width chunks make the synthetic document's lexical and vector ranks explicit.
const texts = Array.from({ length: 9 }, (_, i) => {
  const prefix = i === 1 ? 'needle alpha beta gamma. ' : i === 2 ? 'needle alpha beta. ' : i === 3 ? 'needle alpha. ' : `Section ${i}. `;
  const answer = i === 5 ? 'Payment must arrive on the third of March. ' : '';
  return (prefix + answer + 'Background. '.repeat(100)).slice(0, CHUNK_SIZE);
});
const spec = { id: 'long', name: 'Manual', text: texts.join(''), legacyDomain: 'secure_local' as const };
const provenance: SourceIndexProvenance = { sourceItem: fixtureItem(spec).identity, chunk: { sourceItem: fixtureItem(spec).identity, chunkIndex: 8, chunkId: 'fixture:8', contentHash: 'fixture-hash' } };
const request = { provenance, trustDomain: 'secure_local' as const, maxChars: 400, query: 'needle alpha beta gamma', candidatePassages: 6 };

async function fixture() {
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPORA.secure_local, family: 'file', trustDomain: 'secure_local' });
  cleanups.push(() => store.close());
  await store.syncFromConnector(fixtureConnector(() => [spec]), { fetchContent: true, placement: FIXTURE_PLACEMENT, maxChunkChars: CHUNK_SIZE });
  const embeddingProvider: SourceEmbeddingProvider = {
    provider: 'fixture', modelId: 'fixture-similarity', backend: 'local', dimension: 2,
    epochId: 'fixture-v1', configHash: 'fixture',
    async embed(inputs, options) {
      return inputs.map(input => options.taskType === 'RETRIEVAL_QUERY' || /Section [456]/.test(input.text) ? [1, 0] : [0, 1]);
    },
  };
  await store.embedChunks({ provider: embeddingProvider });
  return { store, provider: createConnectorStoreContentProvider({ store, embeddingProvider }) };
}

test('long items supply whole anchor, lexical and semantic chunks, capped and in document order', async () => {
  const { provider } = await fixture();
  const content = await provider.fetchLocalContent(request);
  expect(content?.candidatePassages).toEqual([1, 2, 3, 4, 5, 8].map(i => texts[i]!));
  expect(content?.chunks.join('')).not.toContain('third of March');
  const fewer = await provider.fetchLocalContent({ ...request, candidatePassages: 2 });
  expect(fewer?.candidatePassages).toEqual([texts[1]!, texts[8]!]);
  expect((await provider.fetchLocalContent({ ...request, candidatePassages: 100 }))?.candidatePassages).toHaveLength(6);
  expect((await provider.fetchLocalContent({ ...request, maxChars: 20_000 }))?.candidatePassages).toBeUndefined();
  const { candidatePassages: _omit, ...ordinary } = request;
  expect((await provider.fetchLocalContent(ordinary))?.candidatePassages).toBeUndefined();
});

test('without word or vector discrimination, candidate ties use document order beside the anchor', async () => {
  const { store } = await fixture();
  const provider = createConnectorStoreContentProvider({ store });
  const block = await provider.fetchLocalContent({ ...request, query: 'Manual' });
  expect(block?.candidatePassages).toEqual([0, 1, 2, 8].map(i => texts[i]!));
});

test('overlapping ranks deduplicate candidates without changing their document order', async () => {
  const { provider } = await fixture();
  const content = await provider.fetchLocalContent({ ...request, provenance: { ...provenance, chunk: { ...provenance.chunk!, chunkIndex: 4, chunkId: 'fixture:4' } } });
  expect(content?.candidatePassages).toEqual([1, 2, 3, 4, 5, 6].map(i => texts[i]!));
});

test('store candidates recover an answer the initial passages missed, within the same budget', async () => {
  const { store, provider } = await fixture();
  const fake = createTestClock();
  const result = await buildEvidencePackDetailed({
    question: request.query, maxResults: 1, maxCharsPerCandidate: 600,
    registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId: store.corpusId, family: 'file', trustDomain: 'secure_local' })]),
    searchContext: { allowedTrustDomains: ['secure_local'] },
    adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword' }) },
    contentProviders: { [store.corpusId]: provider },
    reranker: { id: 'fixture', localOnly: true, poolSize: 1, async score({ passages }) {
      return passages.map(text => text.includes('third of March') ? 10 : 0);
    } },
    rerankTimers: { now: fake.now, setTimeout: fake.setTimeout, clearTimeout: handle => fake.clearTimeout(handle as Parameters<typeof fake.clearTimeout>[0]) },
  });
  expect(result.pack.candidates[0]?.chunks[0]).toContain('third of March');
  expect(result.pack.candidates[0]?.chunks.join('').length).toBeLessThanOrEqual(600);
});

test('scope, names-only and trust-domain gates also gate candidates', async () => {
  const { store } = await fixture();
  const names = createConnectorStoreContentProvider({ store, contentAllowed: false, metadataFilters: {} });
  const result = await names.fetchLocalContent(request);
  expect(result?.chunks).toEqual([]);
  expect(result?.candidatePassages).toBeUndefined();
  expect(result?.namesOnly).toBe(true);
  const outside = createConnectorStoreContentProvider({ store, accountScope: 'another-account' });
  expect(await outside.fetchLocalContent(request)).toBeUndefined();
  await expect(names.fetchLocalContent({ ...request, trustDomain: 'internal' })).rejects.toThrow('refused');
});

test('unjudged text supplies candidates only in its Private copy', async () => {
  const tmp = tempDir('olympus-window-held-');
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanups.push(() => { f.close(); tmp.cleanup(); });
  const set = new TieredStoreSet({ setId: 'window-held', ledger: f.ledger, secretLocations: f.secrets,
    tierClassification: { sniffer: { id: 'waiting', judge: () => ({ verdict: 'undecided', queued: true }) } },
    legs: ['internal', 'secure_local'].map(domain => ({ trustDomain: domain as 'internal' | 'secure_local', corpusId: CORPORA[domain as 'internal' | 'secure_local'], store: f.stores[domain as 'internal' | 'secure_local']! })),
  });
  await set.sync(fixtureConnector(() => [{ ...spec, legacyDomain: 'internal' }]), { fetchContent: true, maxChunkChars: CHUNK_SIZE, placement: FIXTURE_PLACEMENT }, { embed: false });
  for (const domain of ['internal', 'secure_local'] as const) {
    const block = await createConnectorStoreContentProvider({ store: f.stores[domain]! }).fetchLocalContent({ ...request, trustDomain: domain });
    if (domain === 'internal') {
      expect(block?.chunks ?? []).toEqual([]);
      expect(block?.candidatePassages).toBeUndefined();
    } else {
      expect(block?.candidatePassages?.length).toBeGreaterThan(0);
      expect(block?.chunks.length).toBeGreaterThan(0);
    }
  }
});
