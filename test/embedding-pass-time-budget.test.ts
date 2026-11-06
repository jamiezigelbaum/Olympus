// An embedding pass is bounded by time, not only by items: one long file can
// hold more chunks than a pass has time for. On Sparta (2026-11-06) 32-item
// passes over long Dropbox and Gmail items ran past the sweep's deadline 94
// times; each overrun read as a provider outage and backed the store off for up
// to 30 minutes. A pass now stops starting batches at its budget, keeps what it
// embedded, and the next pass finishes the item.

import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { embedPendingChunks, LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { EMBEDDING_SWEEP_MAX_ITEMS, EMBEDDING_SWEEP_MAX_ITEMS_ENV, embeddingSweepMaxItems, withEmbeddingSweep, type SourceSchedulerSource } from '../src/workers/source-scheduler.ts';

const ACCOUNT = 'personal';
// About 4,000 characters a chunk: 100 chunks, four batches of 32 and one of 4.
const LONG_TEXT = Array.from({ length: 100 }, (_, index) => `section ${index} ${'word '.repeat(790)}`).join('\n\n');

function rawItem(id: string, text: string): RawItem {
  return {
    identity: {
      family: 'file',
      provider: 'fixture',
      accountScope: ACCOUNT,
      providerItemId: id,
      localItemId: `${ACCOUNT}:${id}`,
      sourceVersion: `${id}:v1`,
    },
    mimeType: 'text/markdown',
    content: { kind: 'text', text },
    metadata: Object.freeze({ name: id }),
    fetchedAt: '2026-11-06T00:00:00.000Z',
  };
}

function connector(items: RawItem[]): SourceConnector {
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

async function storeWith(items: RawItem[]): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'internal.fixture.files',
    family: 'file',
    trustDomain: 'internal',
    tierLedger: null,
  });
  await store.syncFromConnector(connector(items), {
    fetchContent: true,
    placement: () => buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }),
  });
  return store;
}

/** A local provider whose every call takes `callMs`, the way a CPU embedder does. */
function slowProvider(callMs: number): SourceEmbeddingProvider & { calls: number } {
  const provider = {
    calls: 0,
    provider: 'built-in',
    backend: 'local' as const,
    modelId: 'slow-model',
    dimension: 2,
    configHash: 'slow-config',
    epochId: 'slow-epoch',
    async embed(inputs: SourceEmbeddingInput[]): Promise<number[][]> {
      provider.calls += 1;
      await new Promise((resolve) => setTimeout(resolve, callMs));
      return inputs.map(() => [1, 0]);
    },
  };
  return provider;
}

function lane(): SourceSchedulerSource {
  return {
    sourceId: 'fixture.files',
    corpusId: 'internal.fixture.files',
    cadence: 'continuous',
    intervalMs: 60_000,
    freshnessThresholdHours: 24,
    tasks: [{ id: 'fixture_sync', kind: 'sync', writer: true, async run() { return { status: 'idle' }; } }],
  };
}

describe('embedding pass time budget', () => {
  test('the sweep bound rises only for a valid setting, and stays capped', () => {
    const read = (value?: string) => embeddingSweepMaxItems({ [EMBEDDING_SWEEP_MAX_ITEMS_ENV]: value });
    expect(read()).toBe(EMBEDDING_SWEEP_MAX_ITEMS);
    expect(read('0')).toBe(EMBEDDING_SWEEP_MAX_ITEMS);
    expect(read('many')).toBe(EMBEDDING_SWEEP_MAX_ITEMS);
    expect(read('1024')).toBe(1024);
    expect(read('999999')).toBe(4096);
  });

  test('a pass past its budget keeps what it embedded, leaves the item queued, and the next pass finishes it', async () => {
    const store = await storeWith([rawItem('long', LONG_TEXT)]);
    const provider = slowProvider(25);
    try {
      expect(store.embeddingBacklogEstimate(provider.modelId).missingChunks).toBe(100);
      store.queueEmbedding([`${ACCOUNT}:long`], provider);
      // The first batch always runs, so a budget already spent still makes progress.
      const [first] = await embedPendingChunks([{ store, provider }], { maxItems: 32, stopAtMs: Date.now() });
      expect(first).toMatchObject({ chunksEmbedded: 32, stoppedAtDeadline: true, itemsFailed: 0 });
      expect(first!.deferredReason).toBeUndefined();
      expect(store.queuedEmbeddingItemIds()).toEqual([`${ACCOUNT}:long`]);
      expect(store.embeddingBacklogEstimate(provider.modelId).missingChunks).toBe(68);
      // No budget: the rest, and only the rest, is embedded.
      const callsBefore = provider.calls;
      const [rest] = await embedPendingChunks([{ store, provider }], { maxItems: 32 });
      expect(rest).toMatchObject({ chunksEmbedded: 68 });
      expect(rest!.stoppedAtDeadline).toBeUndefined();
      expect(provider.calls - callsBefore).toBe(3);
      expect(store.queuedEmbeddingItemIds()).toEqual([]);
      expect(store.embeddingBacklogEstimate(provider.modelId).missingChunks).toBe(0);
    } finally {
      store.close();
    }
  });

  test('retrying a failed group one item at a time stops at the same budget', async () => {
    const items = Array.from({ length: 5 }, (_, index) => rawItem(`short-${index}`, `short note ${index}`));
    const store = await storeWith(items);
    const provider = slowProvider(25);
    const embed = provider.embed.bind(provider);
    let calls = 0;
    // The group's call fails for a reason no retry fixes, so each item is tried alone.
    provider.embed = async (inputs, options) => {
      calls += 1;
      if (calls === 1) throw new Error('bad input');
      return embed(inputs, options);
    };
    try {
      const ids = items.map((item) => item.identity.localItemId);
      store.queueEmbedding(ids, provider);
      const [run] = await embedPendingChunks([{ store, provider }], { maxItems: 32, stopAtMs: Date.now() + 5 });
      // The first item alone always runs; the budget is spent by then.
      expect(run).toMatchObject({ chunksEmbedded: 1, stoppedAtDeadline: true, itemsFailed: 0 });
      expect(store.queuedEmbeddingItemIds()).toEqual(ids.slice(1));
    } finally {
      store.close();
    }
  });

  test('the sweep ends a long pass in time and asks to continue, without reading as an outage', async () => {
    const store = await storeWith([rawItem('long', LONG_TEXT)]);
    // Five calls of 40 ms take 200 ms; the deadline is 120 ms, so a pass that
    // ran every batch would overrun. Its budget is half the deadline.
    const provider = slowProvider(40);
    try {
      const [swept] = withEmbeddingSweep([lane()], () => () => [{ store, provider, wholeStore: true }], { storeDeadlineMs: 120 });
      const sweep = swept!.tasks.find((task) => task.id === 'fixture.files_embeddings')!;
      const first = await sweep.run();
      expect(first.counts).toMatchObject({ stores_deferred: 0 });
      expect(first.counts?.chunks_embedded).toBeGreaterThan(0);
      expect(first.counts?.chunks_embedded).toBeLessThan(100);
      expect(first.continueSoon).toBe(true);
      expect(first.retryAt).toBeUndefined();
      expect(store.embeddingDeferredReason()).toBeUndefined();
      let embedded = first.counts!.chunks_embedded as number;
      for (let pass = 0; pass < 10 && embedded < 100; pass += 1) {
        const next = await sweep.run();
        expect(next.counts).toMatchObject({ stores_deferred: 0 });
        embedded += next.counts!.chunks_embedded as number;
      }
      expect(embedded).toBe(100);
      expect(store.embeddingBacklogEstimate(provider.modelId).missingChunks).toBe(0);
    } finally {
      store.close();
    }
  });
});
