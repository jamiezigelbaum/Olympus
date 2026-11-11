// What one keyword lane costs on a large store (#1242).
//
// On Sparta's real stores (2026-11-10, probes 2 and 3) a keyword lane took
// 7 to 10 s and timed out its store: it ran the same search twice (the
// expansion-free baseline is identical when the question has no
// alternatives), and counted each concept's matches store-wide again on
// every search. These pin the cheaper shape with
// synthetic data: the work done, not wall time.
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import {
  LocalConnectorStore,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { DROPBOX_TIER_CORPUS_IDS } from '../src/workers/dropbox-files/connector-store.ts';
import { traceKeywordSearch } from '../eval/store-probe.ts';
import { fixtureConnector, tempDir } from './helpers/tier-fixtures.ts';

// The store's bm25 title weight (local-index.ts).
const CONNECTOR_STORE_FTS_TITLE_WEIGHT = 1.5;

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

// The ranked page orders a large store's matches by bm25 (#1242). Ranking
// every match and reading each one's item cost Sparta's stores 5 to 9 s cold
// on a common word; ranking only the best FTS rows first is the same answer
// whenever those rows decide the page, and the full ranking stays the
// fallback when they cannot (ties at the bound).
async function openStoreWith(items: Array<{ id: string; name: string; text: string }>): Promise<LocalConnectorStore> {
  const { dir, cleanup } = tempDir('olympus-keyword-bound-');
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'internal.sqlite'),
    corpusId: DROPBOX_TIER_CORPUS_IDS.internal!,
    family: 'file',
    trustDomain: 'internal',
    tierLedger: null,
  });
  cleanups.push(cleanup, () => store.close());
  await store.syncFromConnector(fixtureConnector(() => items), { fetchContent: true });
  return store;
}

type TraceRun = { rows: number; statements: Record<string, { calls: number }> };

test('a ranked page decided by the best matches never ranks the rest of the store', async () => {
  // 600 notes say "kestrel" once, each a word longer than the last, so every
  // match ranks differently and shorter ranks higher; one says it three times.
  const store = await openStoreWith([
    { id: 'answer', name: 'answer.txt', text: 'kestrel kestrel kestrel' },
    ...Array.from({ length: 600 }, (_, n) => ({ id: `note-${n}`, name: `note-${n}.txt`, text: `kestrel ${'word '.repeat(n + 1)}` })),
  ]);
  const runs = traceKeywordSearch(store, 'kestrel', undefined, undefined).runs as TraceRun[];
  for (const run of runs) {
    expect(run.statements.ranked_match_page_bounded?.calls).toBe(1);
    expect(run.statements.ranked_match_page).toBeUndefined();
  }
  const rows = store.searchItemsDetailed('kestrel', 50, undefined, undefined, { prefix: false }).rows;
  expect(rows.map((row) => row.sourceItem.providerItemId)).toEqual(['answer', ...Array.from({ length: 49 }, (_, n) => `note-${n}`)]);
});

// Ties at the bound used to rank every match in the store and read each
// one's item: about 1 GB a query on a 700k-item store (2026-11-11). Every
// row that ranks at or above the tied rank decides the page as well as the
// full ranking does, so only those are read; a store's worse matches are not.
test('ties at the bound read only the rows tied with it or better, with the full ranking\'s page', async () => {
  const store = await openStoreWith([
    { id: 'best', name: 'best.txt', text: 'kestrel kestrel kestrel' },
    ...Array.from({ length: 600 }, (_, n) => ({ id: `same-${n}`, name: `same-${n}.txt`, text: 'kestrel boatyard note' })),
    ...Array.from({ length: 300 }, (_, n) => ({ id: `worse-${n}`, name: `worse-${n}.txt`, text: `kestrel ${'word '.repeat(n + 5)}` })),
  ]);
  const runs = traceKeywordSearch(store, 'kestrel', undefined, undefined).runs as TraceRun[];
  for (const run of runs) {
    expect(run.statements.ranked_match_page_bounded?.calls).toBe(1);
    expect(run.statements.ranked_match_page_tied?.calls).toBe(1);
    expect(run.statements.ranked_match_page).toBeUndefined();
    expect(run.rows).toBe(50);
  }
  // The full ranking's page, read straight from the store file (an oracle
  // independent of the search code).
  const oracle = new Database(store.dbPath, { readonly: true });
  cleanups.push(() => oracle.close());
  const expected = (oracle.query(`
    SELECT i.provider_item_id AS id, MIN(connector_store_fts.rank) AS rank
    FROM connector_store_fts JOIN items i ON i.item_pk = connector_store_fts.item_pk
    WHERE connector_store_fts MATCH 'kestrel' AND connector_store_fts.rank MATCH 'bm25(${CONNECTOR_STORE_FTS_TITLE_WEIGHT}, 1.0)'
      AND i.tombstoned = 0
    GROUP BY i.item_pk
    ORDER BY rank ASC, COALESCE(i.updated_at, i.authored_at, i.indexed_at) DESC, i.item_pk ASC
    LIMIT 50`).all() as Array<{ id: string }>).map((row) => row.id);
  const rows = store.searchItemsDetailed('kestrel', 50, undefined, undefined, { prefix: false }).rows;
  expect(expected[0]).toBe('best');
  expect(rows.map((row) => row.sourceItem.providerItemId)).toEqual(expected);
});
