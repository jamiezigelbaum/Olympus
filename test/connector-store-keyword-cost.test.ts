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
import { keywordStatementKind, traceKeywordSearch } from '../eval/store-probe.ts';
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

test('ties at the bound fall back to ranking every match, with the same page', async () => {
  const store = await openStoreWith(Array.from({ length: 600 }, (_, n) => ({ id: `same-${n}`, name: `same-${n}.txt`, text: 'kestrel boatyard note' })));
  const runs = traceKeywordSearch(store, 'kestrel', undefined, undefined).runs as TraceRun[];
  for (const run of runs) {
    expect(run.statements.ranked_match_page_bounded?.calls).toBe(1);
    expect(run.statements.ranked_match_page?.calls).toBe(1);
    expect(run.rows).toBe(50);
  }
});

// Which concepts each candidate holds is asked of the candidates' own FTS
// rows. Matching a concept across the whole store and keeping the candidates
// read every match of a common word: about 1 s a call on Sparta's Private
// store (rerun 13), and 22 s cold for "invoice" on a 120k-item fixture,
// against 4 ms from the candidates' rows.
test('concept hits read only the candidates\' FTS rows, never every match in the store', async () => {
  const store = await openStore();
  const db = (store as unknown as { db: { query: (sql: string) => { all: (...params: unknown[]) => unknown[] } } }).db;
  const query = db.query;
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  db.query = function (sql: string) {
    const statement = query.call(db, sql);
    if (keywordStatementKind(sql) !== 'concept_hits_for_candidates') return statement;
    return { ...statement, all: (...params: unknown[]) => { statements.push({ sql, params }); return statement.all(...params); } } as typeof statement;
  };
  let rows;
  try {
    rows = store.searchItemsDetailed(QUESTION, 5, undefined, undefined, { prefix: false }).rows;
  } finally {
    db.query = query;
  }
  expect(rows[0]?.sourceItem.providerItemId).toBe('answer');
  expect(statements.length).toBeGreaterThan(0);
  for (const { sql, params } of statements) {
    const plan = (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail);
    expect(plan[0]).toMatch(/^SEARCH \w+ USING COVERING INDEX idx_connector_store_fts_rows_item \(item_pk=\?\)$/);
  }
});
