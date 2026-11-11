// One lane cannot spend another lane's budget (#1242).
//
// On Sparta (2026-11-10, rerun 7) a store's keyword lane took 7.3 to 8.5 s of
// the 10 s lane deadline, and only then did the vector lane start: it got the
// 1.5 to 2.4 s left, missed its deadline, and every store lost its vector
// hits. The two lanes read different things (the FTS index on the read pool,
// the embeddings on this store), so each now runs for the whole budget.
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  LocalConnectorStore,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { DROPBOX_TIER_CORPUS_IDS } from '../src/workers/dropbox-files/connector-store.ts';
import type { SourceEmbeddingInput } from '../src/workers/source-index/embeddings.ts';
import { waitFor } from './helpers/test-clock.ts';
import { fixtureConnector, RecordingProvider, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

test('the vector lane starts while the keyword lane is still searching', async () => {
  const { dir, cleanup } = tempDir('olympus-lane-concurrency-');
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'internal.sqlite'),
    corpusId: DROPBOX_TIER_CORPUS_IDS.internal!,
    family: 'file',
    trustDomain: 'internal',
    tierLedger: null,
  });
  cleanups.push(cleanup, () => store.close());
  const events: string[] = [];
  class TimedProvider extends RecordingProvider {
    override async embed(inputs: SourceEmbeddingInput[], options?: { taskType?: string }): Promise<number[][]> {
      if (options?.taskType === 'RETRIEVAL_QUERY') events.push('vector:start');
      return super.embed(inputs);
    }
  }
  const provider = new TimedProvider('built-in', 'concurrency-model', 'local');
  await store.syncFromConnector(fixtureConnector(() => [
    { id: 'k1', name: 'kestrel-invoice.txt', text: 'The Kestrel boatyard invoice total is 4182 dollars.' },
    { id: 'k2', name: 'garden.txt', text: 'Tomatoes along the south fence.' },
  ]), { fetchContent: true });
  await store.embedChunks({ provider });

  const search = store.searchItemsDetailedOffThread;
  store.searchItemsDetailedOffThread = async function (...args: Parameters<typeof search>) {
    events.push('keyword:start');
    // Hold the keyword search until the vector lane has started; run one
    // after the other, it never does, and the wait gives up.
    await waitFor(() => events.includes('vector:start'), { timeoutMs: 2_000 }).catch(() => undefined);
    const result = await search.apply(store, args);
    events.push('keyword:end');
    return result;
  };
  const adapter = createConnectorStoreCorpusAdapter({ store, retrievalMode: 'hybrid', embeddingProvider: provider });
  const response = await adapter({
    query: 'kestrel boatyard invoice',
    maxResults: 5,
    corpus: defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }),
    context: { allowedTrustDomains: [store.trustDomain] },
  });
  expect(response.hits.map((hit) => hit.sourceItem.providerItemId)).toContain('k1');
  const vectorStart = events.indexOf('vector:start');
  expect(vectorStart).toBeGreaterThanOrEqual(0);
  // Started before the keyword lane's first search came back.
  expect(vectorStart).toBeLessThan(events.indexOf('keyword:end'));
});

test('the vector scan reads large pages on the read pool and yields at most once', async () => {
  const { dir, cleanup } = tempDir('olympus-vector-yield-');
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'internal.sqlite'),
    corpusId: DROPBOX_TIER_CORPUS_IDS.internal!,
    family: 'file',
    trustDomain: 'internal',
    tierLedger: null,
  });
  cleanups.push(cleanup, () => store.close(), () => setReadPoolObserverForTests());
  const provider = new RecordingProvider('built-in', 'yield-model', 'local');
  // Six 256-row pages of current embeddings on the request thread; one page on the pool.
  await store.syncFromConnector(fixtureConnector(() => Array.from({ length: 1300 }, (_, n) => ({
    id: `n${n}`, name: `note-${n}.txt`, text: `Synthetic note ${n} about item ${n * 7}.`,
  }))), { fetchContent: true });
  await store.embedChunks({ provider });

  // Rerun 7 on Sparta: 599 pages, each followed by setTimeout(0), cost the
  // lane about 0.7 s idle and more under load before it scored anything.
  // On the pool every page is also a round trip through the request thread.
  const pages: string[] = [];
  setReadPoolObserverForTests((_, read) => {
    if (/emb\.chunk_pk > \?/.test(read.sql)) pages.push(read.sql);
  }, { snapshots: true });
  const realSetTimeout = globalThis.setTimeout;
  let zeroDelayTimers = 0;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (!delay) zeroDelayTimers += 1;
    return realSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;
  try {
    const lane = await store.vectorSearchLane('synthetic note', provider, 10);
    expect(lane.rows.length).toBeGreaterThan(0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  expect(pages.length).toBe(1);
  expect(zeroDelayTimers).toBeLessThanOrEqual(1);
});

test("the hybrid lane's vector scan stops before the lane's deadline, keeping time for its keyword rows (#1305)", async () => {
  const { vectorScanDeadline } = await import('../src/workers/connector-store/local-index.ts');
  expect(vectorScanDeadline(undefined, 0)).toBeUndefined();
  // A tenth of the time left, at least a second.
  expect(vectorScanDeadline(60_000, 0)).toBe(54_000);
  expect(vectorScanDeadline(5_000, 0)).toBe(4_000);
});
