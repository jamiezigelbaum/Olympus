import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { LocalConnectorStore, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import { gmailCursorConnectorId } from '../src/workers/google-connectors/index.ts';
import { withLocalPrivateEmbeddingBackfill, type SourceSchedulerSource } from '../src/workers/source-scheduler.ts';
import { TransientSourceEmbeddingError, type SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

function item(id: string, date = '2026-10-14T12:00:00Z'): RawItem {
  return { identity: { family: 'email', provider: 'gmail', accountScope: 'personal', providerItemId: id, localItemId: id, sourceVersion: 'v1' }, mimeType: 'text/plain', content: { kind: 'text', text: `${id} private body` }, metadata: { name: id, authoredAt: date }, fetchedAt: '2026-10-14T12:00:00Z' };
}
function connector(id: string, items: RawItem[]): SourceConnector {
  return { id, family: 'email', async authenticate() {}, async *listItems() { yield { items, done: true }; }, async fetchItem(id) { return items.find(item => item.identity.localItemId === id)!; }, classificationSignals() { return {}; } };
}
function store() { return new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'secure_local.fixture.mail', family: 'email', trustDomain: 'secure_local', tierLedger: null }); }
function source(corpusId: string): SourceSchedulerSource {
  return { sourceId: 'gmail.email', corpusId, cadence: 'continuous', intervalMs: 1_000, freshnessThresholdHours: 1, tasks: [] };
}
function provider(captured: string[]): SourceEmbeddingProvider {
  return { provider: 'built-in', backend: 'local', modelId: 'fixture-local', configHash: 'fixture', epochId: 'fixture-epoch', dimension: 2, async embed(inputs) { captured.push(...inputs.map(input => input.text)); return inputs.map(() => [1, 0]); } };
}

describe('Private meaning backfill follows current provider observations', () => {
  test('mail from an old scope/account generation or outside the current content date is never submitted', async () => {
    const s = store(); const captured: string[] = []; const local = provider(captured);
    const prior = gmailCursorConnectorId('personal', { generation: 'old-account', revision: 'wide-scope' });
    const current = gmailCursorConnectorId('personal', { generation: 'current-account', revision: 'narrow-scope' });
    expect(prior).not.toBe(current);
    const oldDate = item('metadata-only-now', '2025-01-01T00:00:00Z');
    try {
      await s.syncFromConnector(connector(prior, [item('old-scope'), oldDate]), { fetchContent: true });
      await s.syncFromConnector(connector(current, [item('allowed-now'), oldDate]), { fetchContent: true });
      const itemFilters = { provider: 'gmail', observedConnectorId: current };
      const filters = { ...itemFilters, authoredAfter: '2026-01-01T00:00:00Z' };
      const status = createSourceIndexStatusHandler({
        corpusDefinitions: [defineConnectorCorpus({ corpusId: s.corpusId, family: 'email', trustDomain: 'secure_local', activationMode: 'hybrid_shadow' })], connectorStores: [s],
        connectorStoreStatusScope: () => ({ accountScope: 'personal', itemFilters, contentFilters: filters }),
        retrievalAvailability: { [s.corpusId]: () => ({ servable: s.hasEmbeddings(local.modelId), modelId: local.modelId, embeddingEpoch: local.epochId, backend: local.backend, provider: local.provider }) },
      });
      expect((await status.status()).corpora[0]!.embedding_parity).toMatchObject({ chunks: 1, missing_chunks: 1 });
      const task = withLocalPrivateEmbeddingBackfill([source(s.corpusId)], () => [{ store: s, provider: local, accountScope: 'personal', filters }])[0]!.tasks[0]!;
      expect(await task.run()).toMatchObject({ counts: { chunks_embedded: 1 } });
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain('allowed-now private body');
      expect(captured.join('')).not.toContain('old-scope');
      expect(captured.join('')).not.toContain('metadata-only-now');
      expect(await task.run()).toMatchObject({ status: 'idle', counts: { chunks_embedded: 0 } });
      expect((await status.status()).corpora[0]!.embedding_parity).toMatchObject({ chunks: 1, embedded_chunks: 1, missing_chunks: 0 });
    } finally { s.close(); }
  });

  test('a temporarily unavailable model backs off, other stores progress, and historical cloud queue providers are never used', async () => {
    const first = store(), second = store(); const captured: string[] = []; const local = provider(captured);
    let calls = 0;
    const intermittent = { ...local, async embed(inputs: Parameters<SourceEmbeddingProvider['embed']>[0], options: Parameters<SourceEmbeddingProvider['embed']>[1]) {
      if (++calls === 1) throw new TransientSourceEmbeddingError('built-in', 'timeout', 1, 1_000);
      return local.embed(inputs, options);
    } };
    let cloudCalls = 0;
    const cloud: SourceEmbeddingProvider = { ...local, provider: 'venice', backend: 'cloud', async embed() { cloudCalls++; throw new Error('must not be called'); } };
    try {
      await first.syncFromConnector(connector('first', [item('first')]), { fetchContent: true });
      await second.syncFromConnector(connector('second', [item('second')]), { fetchContent: true });
      first.queueEmbedding(['first'], cloud);
      const task = withLocalPrivateEmbeddingBackfill([source(first.corpusId)], () => [{ store: first, provider: intermittent }, { store: second, provider: local }])[0]!.tasks[0]!;
      expect(await task.run({ sourceId: 'gmail.email', corpusId: first.corpusId, taskId: task.id, attemptedAt: '2026-10-14T12:00:00Z', consecutiveFailures: 0, effectiveIntervalMs: 60_000 })).toMatchObject({ counts: { chunks_embedded: 1, stores_deferred: 1 }, retryAt: { effectiveIntervalMs: 120_000, degradedReason: 'embedding_provider_unavailable' } });
      expect(cloudCalls).toBe(0);
      expect(await task.run()).toMatchObject({ counts: { chunks_embedded: 1, stores_deferred: 0 } });
      expect(captured.join('')).toContain('first private body');
      expect(captured.join('')).toContain('second private body');
      expect(cloudCalls).toBe(0);
    } finally { first.close(); second.close(); }
  });
});
