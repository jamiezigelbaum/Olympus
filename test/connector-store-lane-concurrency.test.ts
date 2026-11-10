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
import { DROPBOX_TIER_CORPUS_IDS } from '../src/workers/dropbox-files/connector-store.ts';
import type { SourceEmbeddingInput } from '../src/workers/source-index/embeddings.ts';
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
    await new Promise((resolve) => setTimeout(resolve, 100));
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
