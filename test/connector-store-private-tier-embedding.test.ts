// A row that is Private by its OWN tier (S4 and above) never reaches an
// embedder that is not approved for Private content, whatever the store's
// domain. Classification never pairs S4 with a Personal (internal) store, but
// a lane's declared placement, a corpus default or misplacement can; the
// store-level trust rule decided by domain alone, so such a row's title and
// text went to an ordinary cloud embedder. Real in-memory stores, a capturing
// provider, every document-embedding entry point.

import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity, type SourceTrustTier } from '../src/core/source-index/types.ts';
import {
  defineConnectorCorpus,
  embedPendingChunks,
  LocalConnectorStore,
  syncAndEmbedFromConnector,
} from '../src/workers/connector-store/index.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import type {
  SourceEmbeddingBackend,
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';
const S4_TITLE = 'orchid-ledger-title';
const S4_TEXT = 'orchid ledger body that is private by its own tier';
const INVALID_TITLE = 'quartz-unknown-title';
const INVALID_TEXT = 'quartz body whose stored tier is not one the store knows';

interface Fixture { id: string; text: string; tier: string; account?: string }

function rawItem(fixture: Fixture): RawItem {
  const account = fixture.account ?? ACCOUNT;
  return {
    identity: {
      family: 'file',
      provider: 'fixture',
      accountScope: account,
      providerItemId: fixture.id,
      localItemId: `${account}:${fixture.id}`,
      sourceVersion: `${fixture.id}:v1`,
    },
    mimeType: 'text/markdown',
    content: { kind: 'text', text: fixture.text },
    metadata: Object.freeze({ name: fixture.id }),
    fetchedAt: '2026-10-05T00:00:00.000Z',
  };
}

function connector(fixtures: readonly Fixture[]): SourceConnector {
  const items = fixtures.map(rawItem);
  return {
    id: 'fixture',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const found = items.find((item) => item.identity.localItemId === localItemId);
      if (!found) throw new Error(`missing fixture ${localItemId}`);
      return found;
    },
    classificationSignals() {
      return {};
    },
  };
}

const FIXTURES: Fixture[] = [
  { id: 'garden-a', text: 'garden tomatoes and basil', tier: 'S3' },
  { id: 'garden-b', text: 'garden peppers and beans', tier: 'S3' },
  { id: S4_TITLE, text: S4_TEXT, tier: 'S4' },
];

function placementFor(fixtures: readonly Fixture[]) {
  const tiers = new Map(fixtures.map((fixture) => [`${fixture.account ?? ACCOUNT}:${fixture.id}`, fixture.tier]));
  // A placement's tier is not checked on write (see analyst-source-answer's
  // invalid-tier test), which is how an unknown tier can reach a row.
  return (item: RawItem) => ({
    ...buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }),
    trustTier: (tiers.get(item.identity.localItemId) ?? 'S3') as SourceTrustTier,
  });
}

async function internalStore(fixtures: readonly Fixture[] = FIXTURES): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'internal.fixture.files',
    family: 'file',
    trustDomain: 'internal',
    tierLedger: null,
  });
  await store.syncFromConnector(connector(fixtures), { fetchContent: true, placement: placementFor(fixtures) });
  return store;
}

function capturingProvider(
  backend: SourceEmbeddingBackend,
  provider: string,
  modelId = `${provider}-${backend}-model`,
  onCall?: (call: number) => Promise<void>,
): SourceEmbeddingProvider & { captured: SourceEmbeddingInput[]; calls: SourceEmbeddingInput[][] } {
  const captured: SourceEmbeddingInput[] = [];
  const calls: SourceEmbeddingInput[][] = [];
  return {
    calls,
    captured,
    provider,
    modelId,
    dimension: 2,
    configHash: `${modelId}-config`,
    epochId: `${modelId}-epoch`,
    backend,
    async embed(inputs: SourceEmbeddingInput[]): Promise<number[][]> {
      captured.push(...inputs);
      calls.push([...inputs]);
      // The round trip is the window: another lane writes while a batch is out.
      await onCall?.(calls.length);
      return inputs.map(() => [1, 0]);
    },
  };
}

function capturedText(provider: { captured: SourceEmbeddingInput[] }): string {
  return JSON.stringify(provider.captured);
}

function embeddedChunks(store: LocalConnectorStore, modelId: string): number {
  return store.status().embeddingByModel.find((entry) => entry.modelId === modelId)?.embeddedChunks ?? 0;
}

describe('a row Private by its own tier is withheld from an embedder not approved for Private content', () => {
  test('a cloud embedder never receives the S4 row; S3 rows embed as before; the reason is reported', async () => {
    const store = await internalStore();
    const cloud = capturingProvider('cloud', 'gemini');
    try {
      const summary = await store.embedChunks({ provider: cloud });

      const sent = capturedText(cloud);
      expect(sent).not.toContain(S4_TITLE);
      expect(sent).not.toContain('orchid');
      expect(sent).toContain('garden tomatoes');
      expect(sent).toContain('garden peppers');
      expect(summary.chunksEmbedded).toBe(2);
      expect(summary.privateTierWithheld).toEqual({
        chunks: 1,
        reason: 'private_tier_requires_private_embedder',
      });
      expect(store.privateTierEmbeddingWithheld(cloud)).toMatchObject({ items: 1, chunks: 1 });
      // Not owed by this embedder: no backlog, no sweep pick-up.
      expect(store.embeddingBacklogEstimate(cloud.modelId, cloud).missingChunks).toBe(0);
      expect(store.missingEmbeddingItemIds(cloud, 10)).toEqual([]);
      // Lexical search of the withheld row is unaffected.
      expect(store.searchItems('orchid', 5).map((row) => row.title)).toContain(S4_TITLE);
    } finally {
      store.close();
    }
  });

  test('an approved local embedder, and the approved Venice lane, embed the same S4 row', async () => {
    for (const approved of [capturingProvider('local', 'llama-server'), capturingProvider('cloud', 'venice')]) {
      const store = await internalStore();
      try {
        const summary = await store.embedChunks({ provider: approved });
        expect(capturedText(approved)).toContain(S4_TITLE);
        expect(capturedText(approved)).toContain('orchid');
        expect(summary.chunksEmbedded).toBe(3);
        expect(summary.privateTierWithheld).toBeUndefined();
        expect(store.privateTierEmbeddingWithheld(approved)).toMatchObject({ items: 0, chunks: 0 });
      } finally {
        store.close();
      }
    }
  });

  test('a row with an unknown stored tier is not submitted to a cloud embedder', async () => {
    const fixtures = [...FIXTURES, { id: INVALID_TITLE, text: INVALID_TEXT, tier: 'S9' }];
    const store = await internalStore(fixtures);
    const cloud = capturingProvider('cloud', 'gemini');
    try {
      const summary = await store.embedChunks({ provider: cloud });
      expect(capturedText(cloud)).not.toContain('quartz');
      expect(capturedText(cloud)).not.toContain('orchid');
      expect(summary.chunksEmbedded).toBe(2);
      expect(summary.privateTierWithheld?.chunks).toBe(2);
    } finally {
      store.close();
    }
  });

  test('the sweep, the queue and sync-and-embed withhold it too, and never pick it up again', async () => {
    const store = await internalStore();
    const cloud = capturingProvider('cloud', 'gemini');
    try {
      // The queue path: a sync handed every item to the sweep.
      store.queueEmbedding(FIXTURES.map((fixture) => `${ACCOUNT}:${fixture.id}`), cloud);
      const first = await embedPendingChunks([{ store, provider: cloud, wholeStore: true }], { maxItems: 10 });
      expect(first[0]!.chunksEmbedded).toBe(2);
      expect(first[0]!.itemsFailed).toBe(0);
      // The whole-store sweep finds nothing owed, so a withheld row is not
      // retried pass after pass.
      const calls = cloud.captured.length;
      const second = await embedPendingChunks([{ store, provider: cloud, wholeStore: true }], { maxItems: 10 });
      expect(second[0]!.itemsAttempted).toBe(0);
      expect(cloud.captured.length).toBe(calls);

      const synced = await syncAndEmbedFromConnector({
        store,
        connector: connector(FIXTURES),
        embeddingProvider: cloud,
        sync: { fetchContent: true, placement: placementFor(FIXTURES) },
      });
      expect(synced.embed.privateTierWithheld?.chunks).toBe(1);
      expect(capturedText(cloud)).not.toContain('orchid');
      expect(capturedText(cloud)).not.toContain(S4_TITLE);
    } finally {
      store.close();
    }
  });

  test('a vector the row already holds is kept, not deleted and not re-submitted', async () => {
    // The row was embedded while it sat at S3, then re-placed at S4 with the
    // same content (the state a store could hold from before this rule).
    const before = FIXTURES.map((fixture) => ({ ...fixture, tier: 'S3' }));
    const store = await internalStore(before);
    const cloud = capturingProvider('cloud', 'gemini');
    try {
      await store.embedChunks({ provider: cloud });
      expect(embeddedChunks(store, cloud.modelId)).toBe(3);
      await store.syncFromConnector(connector(FIXTURES), { fetchContent: true, placement: placementFor(FIXTURES) });
      cloud.captured.length = 0;

      const summary = await store.embedChunks({ provider: cloud });
      expect(cloud.captured).toEqual([]);
      expect(summary.chunksEmbedded).toBe(0);
      expect(embeddedChunks(store, cloud.modelId)).toBe(3);
      expect(store.hasEmbeddings(cloud.modelId)).toBe(true);
      // Its current vector means it is not counted as withheld either, by the
      // run summary or by the status method.
      expect(summary.privateTierWithheld).toBeUndefined();
      expect(store.privateTierEmbeddingWithheld(cloud)).toMatchObject({ items: 0, chunks: 0 });
    } finally {
      store.close();
    }
  });

  test('status reports the withheld chunks under their reason, outside the priced backlog', async () => {
    const store = await internalStore();
    const cloud = capturingProvider('cloud', 'gemini');
    try {
      await store.embedChunks({ provider: cloud });
      const status = createSourceIndexStatusHandler({
        corpusDefinitions: [defineConnectorCorpus({
          corpusId: store.corpusId,
          family: 'file',
          trustDomain: 'internal',
          activationMode: 'hybrid_primary',
        })],
        connectorStores: [store],
        retrievalAvailability: {
          [store.corpusId]: {
            servable: true,
            modelId: cloud.modelId,
            embeddingEpoch: cloud.epochId,
            backend: cloud.backend,
            provider: cloud.provider,
          },
        },
      });
      const result = await status.status({ corpus_id: store.corpusId });
      const parity = result.corpora[0]!.embedding_parity!;
      expect(parity).toMatchObject({
        chunks: 3,
        embedded_chunks: 2,
        missing_chunks: 1,
        refresh_needed: false,
        private_tier_withheld: { chunks: 1, reason: 'private_tier_requires_private_embedder' },
        backlog_estimate: { missing_chunks: 0 },
      });
      expect(JSON.stringify(result)).not.toContain('orchid');
    } finally {
      store.close();
    }
  });

  test('a row that turns Private while an earlier batch is out is not sent in a later batch', async () => {
    // 33 rows: the store embeds in batches of 32, so row 33 is in the second.
    const rows: Fixture[] = Array.from({ length: 33 }, (_, index) => ({
      id: `row-${String(index + 1).padStart(2, '0')}`,
      text: index === 32 ? 'lilac late row that turns private' : `meadow row number ${index + 1}`,
      tier: 'S3',
    }));
    const store = await internalStore(rows);
    const turned = rows.map((row, index) => (index === 32 ? { ...row, tier: 'S4' } : row));
    const cloud = capturingProvider('cloud', 'gemini', 'gemini-cloud-model', async (call) => {
      if (call !== 1) return;
      // Re-placed at S4 (same content) during the first provider call.
      await store.syncFromConnector(connector([turned[32]!]), { fetchContent: true, placement: placementFor(turned) });
    });
    try {
      const summary = await store.embedChunks({ provider: cloud });
      expect(cloud.calls.map((call) => call.length)).toEqual([32]);
      expect(capturedText(cloud)).not.toContain('lilac');
      expect(summary.chunksEmbedded).toBe(32);
      expect(summary.privateTierWithheld).toEqual({ chunks: 1, reason: 'private_tier_requires_private_embedder' });
      expect(summary.chunksSeen).toBe(summary.chunksEmbedded + summary.chunksSkipped);
      expect(store.privateTierEmbeddingWithheld(cloud)).toMatchObject({ items: 1, chunks: 1 });
    } finally {
      store.close();
    }
  });

  test('journals: a run whose input changed fails closed, and a fresh journal completes without re-embedding', async () => {
    const rows: Fixture[] = Array.from({ length: 33 }, (_, index) => ({
      id: `row-${String(index + 1).padStart(2, '0')}`,
      text: `meadow row number ${index + 1}`,
      tier: 'S3',
    }));
    const store = await internalStore(rows);
    // The provider fails its second batch, leaving the first journal running.
    const failing = capturingProvider('cloud', 'gemini', 'gemini-cloud-model', async (call) => {
      if (call === 2) throw new Error('provider refused the batch');
    });
    try {
      await expect(store.embedChunks({ provider: failing, journalId: 'embedding-journal-one', journalLeaseGeneration: 1 }))
        .rejects.toThrow('provider refused the batch');
      expect(embeddedChunks(store, failing.modelId)).toBe(32);

      // An already-embedded row turns Private: the running journal's input
      // changed, so it refuses to resume.
      const turned = rows.map((row, index) => (index === 0 ? { ...row, tier: 'S4' } : row));
      await store.syncFromConnector(connector([turned[0]!]), { fetchContent: true, placement: placementFor(turned) });
      const cloud = capturingProvider('cloud', 'gemini', 'gemini-cloud-model');
      await expect(store.embedChunks({ provider: cloud, journalId: 'embedding-journal-one', journalLeaseGeneration: 2 }))
        .rejects.toThrow('journal input changed');
      expect(cloud.captured).toEqual([]);

      // A fresh journal finishes the remainder and nothing already done is sent again.
      const fresh = await store.embedChunks({ provider: cloud, journalId: 'embedding-journal-two', journalLeaseGeneration: 1 });
      expect(cloud.captured).toHaveLength(1);
      expect(capturedText(cloud)).toContain('meadow row number 33');
      expect(fresh.chunksEmbedded).toBe(1);
      expect(fresh.privateTierWithheld).toBeUndefined();
      // The Private row's earlier vector is kept.
      expect(embeddedChunks(store, cloud.modelId)).toBe(33);

      // Input is validated before a completed journal's result is replayed,
      // so the guard holds for completed journals too.
      const retiered = turned.map((row, index) => (index === 1 ? { ...row, tier: 'S4' } : row));
      await store.syncFromConnector(connector([retiered[1]!]), { fetchContent: true, placement: placementFor(retiered) });
      await expect(store.embedChunks({ provider: cloud, journalId: 'embedding-journal-two', journalLeaseGeneration: 2 }))
        .rejects.toThrow('journal input changed');
      expect(embeddedChunks(store, cloud.modelId)).toBe(33);
    } finally {
      store.close();
    }
  });

  test('status counts withheld chunks in the same scope as its parity', async () => {
    // One unembedded S3 row inside the selected account, one S4 row outside it.
    const store = await internalStore([
      { id: 'inside', text: 'garden row inside the scope', tier: 'S3', account: 'selected' },
      { id: 'outside', text: 'orchid row outside the scope', tier: 'S4', account: 'other' },
    ]);
    const cloud = capturingProvider('cloud', 'gemini');
    try {
      const status = createSourceIndexStatusHandler({
        corpusDefinitions: [defineConnectorCorpus({
          corpusId: store.corpusId,
          family: 'file',
          trustDomain: 'internal',
          activationMode: 'hybrid_primary',
        })],
        connectorStores: [store],
        connectorStoreStatusScope: () => ({ accountScope: 'selected' }),
        retrievalAvailability: {
          [store.corpusId]: {
            servable: false,
            reason: 'no_current_embedding_artifacts',
            modelId: cloud.modelId,
            embeddingEpoch: cloud.epochId,
            backend: cloud.backend,
            provider: cloud.provider,
          },
        },
      });
      const parity = (await status.status({ corpus_id: store.corpusId })).corpora[0]!.embedding_parity!;
      expect(parity).toMatchObject({ chunks: 1, missing_chunks: 1, refresh_needed: true });
      expect(parity.private_tier_withheld).toBeUndefined();
      expect(parity.backlog_estimate?.missing_chunks).toBe(1);
    } finally {
      store.close();
    }
  });
});
