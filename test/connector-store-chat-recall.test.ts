// #710: the existing canary's neighbouring messages split a question's words.
// Exercise the same shared adapter as source index search. The deterministic
// semantic lane holds embeddings but contributes no above-bar neighbours.
import { expect, test } from 'bun:test';
import fixtures from '../eval/classification/fixtures/chat-canary.json';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { LocalConnectorStore, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { ARCTIC_EMBED_M_V1_5 } from '../src/workers/source-index/built-in-embedding/manifest.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

test('the frozen chat fixture finds each one-word answer with keyword and hybrid retrieval', async () => {
  const corpusId = 'internal.fixture.messages';
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId, family: 'chat', trustDomain: 'internal', tierLedger: null });
  try {
    const messages = fixtures.items.filter(item => /^tg-\d+-bare$/.test(item.id));
    expect(messages).toHaveLength(12);
    const items: RawItem[] = messages.map((item, index) => ({
      identity: { provider: 'fixture', family: 'chat', accountScope: 'fixture', providerItemId: item.id, localItemId: item.id, sourceVersion: '1' },
      content: { kind: 'text', text: item.material }, mimeType: 'text/plain',
      metadata: { title: 'Tiago Ferreira', sentAt: new Date(Date.UTC(2026, 6, 1, 10, index)).toISOString() }, fetchedAt: '2026-07-01T10:00:00Z',
    }));
    const connector: SourceConnector = { id: 'fixture', family: 'chat', async authenticate() {}, async *listItems() { yield { items, done: true }; }, async fetchItem(id) { return items.find(item => item.identity.localItemId === id)!; }, classificationSignals() { return {}; } };
    await store.syncFromConnector(connector, { fetchContent: true, placement: { trustTier: 'S3', trustDomain: 'internal' } });
    const provider: SourceEmbeddingProvider = { provider: 'built-in', backend: 'local', modelId: ARCTIC_EMBED_M_V1_5.modelId, epochId: '1', configHash: '1', dimension: 2,
      async embed(inputs, options) { return inputs.map(() => options?.taskType === 'RETRIEVAL_QUERY' ? [0.39, Math.sqrt(1 - 0.39 ** 2)] : [1, 0]); } };
    expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(12);
    for (const retrievalMode of ['keyword', 'hybrid'] as const) {
      const adapter = createConnectorStoreCorpusAdapter({ store, retrievalMode, embeddingProvider: provider, semanticRelevanceBar: 0.4 });
      for (const [question, expected, rank] of [
        ['What time is my demo night slot?', 'tg-02-bare', 2],
        ['Where are we having drinks after demo night?', 'tg-05-bare', 1],
      ] as const) {
        const response = await adapter({ query: question, maxResults: 9, corpus: defineConnectorCorpus({ corpusId, family: 'chat', trustDomain: 'internal' }), context: { allowedTrustDomains: ['internal'] } });
        expect(response.hits.map(hit => hit.sourceItem.providerItemId).indexOf(expected) + 1).toBe(rank);
        expect(response.laneAudits?.find(lane => lane.laneType === 'keyword')?.candidateCount).toBe(2);
        if (retrievalMode === 'hybrid') expect(response.laneAudits?.find(lane => lane.laneType === 'semantic')).toMatchObject({ candidateCount: 12, returnedCount: 0, suppressedBelowBar: 12 });
      }
    }
    // The CLI operation posts to this worker route without a retrieval_mode.
    // Current embeddings must select hybrid automatically, not merely exist.
    const worker = createEmailSourceWorker({ connectorStores: [store], connectorStoreEmbeddingProviders: new Map([[corpusId, provider]]) });
    try {
      const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corpus_id: corpusId, query: 'What time is my demo night slot?', max_results: 9 }),
      }));
      expect(response.status).toBe(200);
      const result = await response.json() as { hits: Array<{ sourceItem: { providerItemId: string } }>; audit: { lane_audits: Array<{ laneType: string; candidateCount: number; returnedCount: number }> } };
      expect(result.hits.map(hit => hit.sourceItem.providerItemId).indexOf('tg-02-bare') + 1).toBe(2);
      expect(result.audit.lane_audits.find(lane => lane.laneType === 'semantic')).toMatchObject({ candidateCount: 12, returnedCount: 0 });
    } finally { worker.close(); }
  } finally { store.close(); }
});
