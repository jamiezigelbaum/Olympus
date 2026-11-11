// What one keyword lane costs on a large store (#1242).
//
// On Sparta's real stores (2026-11-10, probes 2 and 3) a keyword lane took
// 7 to 10 s and timed out its store: it ran the same search twice (the
// expansion-free baseline is identical when the question has no
// alternatives), and counted each concept's matches store-wide again on
// every search. These pin the cheaper shape with
// synthetic data: the work done, not wall time.
import { afterAll, afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import {
  LocalConnectorStore,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { DROPBOX_TIER_CORPUS_IDS } from '../src/workers/dropbox-files/connector-store.ts';
import { traceKeywordSearch } from '../eval/store-probe.ts';
import { keywordCountWindows } from '../src/workers/connector-store/local-index.ts';
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

// A word found in over a fifth of a store's FTS rows ranks almost every row
// and says little about which one answers (the Expert Agents keyword rule).
// On Sparta's largest stores (2026-11-11, olympus-ops#151) leaving such words
// out of the match cut the ranking from 8.4 to 2.1 s on the Private Dropbox
// store, keeping most of the top 10. The words still count toward a
// candidate's concepts; they only stop deciding which rows are ranked.
function rankedMatches(store: LocalConnectorStore, run: () => void): string[] {
  const db = (store as unknown as { db: { query: (sql: string) => { all: (...params: unknown[]) => unknown[] } } }).db;
  const query = db.query;
  const matches: string[] = [];
  db.query = function (sql: string) {
    const statement = query.call(db, sql);
    if (!sql.includes('LIMIT ? OFFSET ?')) return statement;
    return { ...statement, all: (...params: unknown[]) => { matches.push(String(params[0])); return statement.all(...params); } };
  };
  try { run(); } finally { db.query = query; }
  return matches;
}

// About 5,200 FTS rows (a name row and a text row per item): over the size
// below which every word is matched.
const COMMON_ITEMS = [
  { id: 'answer', name: 'answer.txt', text: 'Kestrel boatyard notes from the harbour visit.' },
  ...Array.from({ length: 1300 }, (_, n) => ({ id: `note-${n}`, name: `note-${n}.txt`, text: `${n < 1170 ? 'Weekly' : 'Monthly'} notes ${n} about the garden and the fence.` })),
  ...Array.from({ length: 1300 }, (_, n) => ({ id: `other-${n}`, name: `other-${n}.txt`, text: `Shopping list ${n}: tomatoes, bread, coffee.` })),
];

// One large store for the tests below: syncing it takes seconds.
let commonStore: Promise<LocalConnectorStore> | undefined;
const sharedCleanups: Array<() => void> = [];
afterAll(() => { while (sharedCleanups.length) sharedCleanups.pop()!(); });
function largeCommonStore(): Promise<LocalConnectorStore> {
  return commonStore ??= (async () => {
    const { dir, cleanup } = tempDir('olympus-keyword-common-');
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'internal.sqlite'),
      corpusId: DROPBOX_TIER_CORPUS_IDS.internal!,
      family: 'file',
      trustDomain: 'internal',
      tierLedger: null,
    });
    sharedCleanups.push(cleanup, () => store.close());
    await store.syncFromConnector(fixtureConnector(() => COMMON_ITEMS), { fetchContent: true });
    return store;
  })();
}

test('a small store matches every word of the question', async () => {
  const store = await openStoreWith(COMMON_ITEMS.slice(0, 81));
  const matches = rankedMatches(store, () => { store.searchItemsDetailed('kestrel boatyard notes', 10); });
  for (const match of matches) for (const word of ['kestrel', 'boatyard', 'notes']) expect(match).toContain(`"${word}"`);
});

test('a word in over a fifth of the rows is left out of the match, and the answer still leads', async () => {
  const store = await largeCommonStore();
  let rows: Array<{ sourceItem: { providerItemId: string } }> = [];
  const matches = rankedMatches(store, () => { rows = store.searchItemsDetailed('kestrel boatyard notes', 10).rows; });
  expect(matches.length).toBeGreaterThan(0);
  for (const match of matches) {
    expect(match).toContain('"kestrel"');
    expect(match).not.toContain('"notes"');
  }
  expect(rows[0]?.sourceItem.providerItemId).toBe('answer');
}, 60_000);

test('when every word is common, the rarest one is kept', async () => {
  // Each item has a name row and a text row: "notes" is in about half the
  // rows, "shopping" in a quarter, "weekly" in a little over a fifth.
  const store = await largeCommonStore();
  // The rarest word is kept wherever it stands in the question.
  for (const question of ['weekly notes shopping', 'notes shopping weekly', 'shopping weekly notes']) {
    const matches = rankedMatches(store, () => { store.searchItemsDetailed(question, 10); });
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match).toContain('"weekly"');
      expect(match).not.toContain('"notes"');
      expect(match).not.toContain('"shopping"');
    }
  }
}, 60_000);

test('an exact-word search counts exact words: a rare word whose completions are common stays', async () => {
  // "week*" reaches every "weekly" row; "week" itself is in none.
  const store = await largeCommonStore();
  const prefixed = rankedMatches(store, () => { store.searchItemsDetailed('kestrel week', 10); });
  for (const match of prefixed) expect(match).not.toContain('"week"');
  const exact = rankedMatches(store, () => { store.searchItemsDetailed('kestrel week', 10, undefined, undefined, { prefix: false }); });
  expect(exact.length).toBeGreaterThan(0);
  for (const match of exact) expect(match).toContain('"week"');
}, 60_000);

test('a question of rare words matches as before', async () => {
  const store = await largeCommonStore();
  const matches = rankedMatches(store, () => { store.searchItemsDetailed('kestrel boatyard harbour', 10); });
  for (const match of matches) for (const word of ['kestrel', 'boatyard', 'harbour']) expect(match).toContain(`"${word}"`);
}, 60_000);

// Counting how often a word appears read its whole doclist: on a 1M-row store
// cold, up to 9 s for one question (2026-11-11, #1423). A count over a few
// rowid windows estimates the share for a fraction of that.
test('a large store estimates a word\'s share from a few bounded rowid windows', () => {
  expect(keywordCountWindows(5_200)).toEqual([[1, 5_200]]);
  const windows = keywordCountWindows(1_000_000);
  expect(windows.length).toBeGreaterThan(1);
  expect(windows.reduce((sum, [from, to]) => sum + to - from + 1, 0)).toBeLessThanOrEqual(20_000);
  expect(windows[0]![0]).toBe(1);
  expect(windows.at(-1)![1]).toBeLessThanOrEqual(1_000_000);
  expect(windows.at(-1)![0]).toBeGreaterThan(500_000);
  for (let index = 1; index < windows.length; index += 1) expect(windows[index]![0]).toBeGreaterThan(windows[index - 1]![1]);
});

test('word shares are counted over rowid windows, never by reading a word\'s whole doclist', async () => {
  const store = await largeCommonStore();
  const db = (store as unknown as { db: { query: (sql: string) => unknown } }).db;
  const query = db.query;
  const counts: string[] = [];
  db.query = function (sql: string) {
    if (/^\s*SELECT COUNT\(\*\)/.test(sql) && sql.includes('connector_store_fts MATCH ?')) counts.push(sql);
    return query.call(db, sql);
  };
  try { store.searchItemsDetailed('notes about tomatoes and bread', 10); } finally { db.query = query; }
  expect(counts.length).toBeGreaterThan(0);
  for (const sql of counts) expect(sql).toContain('rowid BETWEEN ? AND ?');
}, 60_000);

// The eval report reads these from the lane audit (#1423): how many words a
// store left out and the rows its match ranks, so a timing run can be read
// per store.
test('the keyword lane audit says how many words it left out and the rows ranked, estimated', async () => {
  const store = await largeCommonStore();
  const adapter = createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword' });
  const search = (query: string) => adapter({
    query,
    maxResults: 5,
    corpus: defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }),
    context: { allowedTrustDomains: [store.trustDomain] },
  });
  const keywordAudit = async (query: string) => (await search(query)).laneAudits?.find((lane) => lane.laneType === 'keyword');
  const dropped = await keywordAudit('kestrel boatyard notes');
  expect(dropped?.wordsLeftOut).toBe(1);
  expect(dropped!.rowsRankedEstimate!).toBeLessThan(dropped!.rowsRankedEveryWordEstimate!);
  const kept = await keywordAudit('kestrel boatyard harbour');
  expect(kept?.wordsLeftOut).toBe(0);
  expect(kept?.rowsRankedEstimate).toBe(kept?.rowsRankedEveryWordEstimate);
  const small = await openStoreWith(COMMON_ITEMS.slice(0, 81));
  const smallAudit = (await createConnectorStoreCorpusAdapter({ store: small, retrievalMode: 'keyword' })({
    query: 'kestrel boatyard notes',
    maxResults: 5,
    corpus: defineConnectorCorpus({ corpusId: small.corpusId, family: small.family, trustDomain: small.trustDomain }),
    context: { allowedTrustDomains: [small.trustDomain] },
  })).laneAudits?.find((lane) => lane.laneType === 'keyword');
  expect(smallAudit?.wordsLeftOut).toBeUndefined();
}, 60_000);
