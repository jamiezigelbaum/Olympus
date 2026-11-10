// What one keyword lane costs on a large store (#1242).
//
// On Sparta's real stores (2026-11-10, probes 2 and 3) a keyword lane took
// 7 to 10 s and timed out its store: it ran the same search twice (the
// expansion-free baseline is identical when the question has no
// alternatives), and counted each concept's matches store-wide again on
// every search. These pin the cheaper shape with
// synthetic data: the work done, not wall time.
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  LocalConnectorStore,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { DROPBOX_TIER_CORPUS_IDS } from '../src/workers/dropbox-files/connector-store.ts';
import { traceKeywordSearch } from '../eval/store-probe.ts';
import { fixtureConnector, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

// One item holds every concept of the question; the rest hold one or two, so
// the minimum-signal filter needs the store-wide concept weights.
const ITEMS = [
  { id: 'answer', name: 'kestrel-boatyard.txt', text: 'Kestrel boatyard invoice total was 4182 dollars for the hull.' },
  ...Array.from({ length: 30 }, (_, n) => ({
    id: `invoice-${n}`,
    name: `invoice-${n}.txt`,
    text: `Invoice ${n} for garden supplies${n % 3 === 0 ? ' with a running total' : ''}, paid in spring.`,
  })),
  ...Array.from({ length: 30 }, (_, n) => ({ id: `other-${n}`, name: `other-${n}.txt`, text: `Notes ${n} about tomatoes and the south fence.` })),
];
const QUESTION = 'What was the kestrel boatyard invoice total?';

async function openStore(): Promise<LocalConnectorStore> {
  const { dir, cleanup } = tempDir('olympus-keyword-cost-');
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'internal.sqlite'),
    corpusId: DROPBOX_TIER_CORPUS_IDS.internal!,
    family: 'file',
    trustDomain: 'internal',
    tierLedger: null,
  });
  cleanups.push(cleanup, () => store.close());
  await store.syncFromConnector(fixtureConnector(() => ITEMS), { fetchContent: true });
  return store;
}

test('a keyword lane never runs the same search twice', async () => {
  const store = await openStore();
  const calls: string[] = [];
  const original = store.searchItemsDetailedOffThread;
  store.searchItemsDetailedOffThread = function (...args: Parameters<typeof original>) {
    calls.push(JSON.stringify([args[0], args[1], args[4] ?? {}]));
    return original.apply(store, args);
  };
  const adapter = createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword' });
  const response = await adapter({
    query: QUESTION,
    maxResults: 5,
    corpus: defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }),
    context: { allowedTrustDomains: [store.trustDomain] },
  });
  expect(response.hits[0]?.sourceItem.providerItemId).toBe('answer');
  expect(calls.length).toBeGreaterThan(0);
  expect(new Set(calls).size).toBe(calls.length);
});

test('store-wide concept counts are read once, not on every search', async () => {
  const store = await openStore();
  const first = traceKeywordSearch(store, QUESTION, undefined, undefined).runs as Array<{ statements: Record<string, { calls: number }> }>;
  const second = traceKeywordSearch(store, QUESTION, undefined, undefined).runs as Array<{ statements: Record<string, { calls: number }> }>;
  expect(first[0]!.statements.concept_weight_count?.calls).toBeGreaterThan(0);
  for (const run of [first[1]!, ...second]) expect(run.statements.concept_weight_count).toBeUndefined();
});
