import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { pinKeywordAlternatives, withKeywordRequestScope } from '../src/core/source-index/keyword-context.ts';
import { LocalConnectorStore, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import type { ConnectorStoreKeywordFtsOptions, ConnectorStoreKeywordSearch, ConnectorStoreSearchFilters } from '../src/workers/connector-store/local-index.ts';
import type { StoreRead } from '../src/workers/connector-store/off-thread-reads.ts';
import { fixtureConnector, tempDir, type FixtureSpec } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function openStore(items: FixtureSpec[]) {
  const { dir, cleanup } = tempDir('olympus-concept-hits-');
  const store = new LocalConnectorStore({ dbPath: join(dir, 'store.sqlite'), corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal', tierLedger: null });
  cleanups.push(cleanup, () => store.close());
  await store.syncFromConnector(fixtureConnector(() => items), { fetchContent: true, maxChunkChars: 256 });
  return store;
}

type Internals = {
  db: Database;
  searchItemsSteps(query: string, limit: number, account: string | undefined, filters: ConnectorStoreSearchFilters | undefined, options: ConnectorStoreKeywordFtsOptions): Generator<StoreRead | { here(): unknown }, ConnectorStoreKeywordSearch, unknown>;
  conceptWeightsSteps(groups: string[][], exact: Map<string, unknown>): Generator<StoreRead, { counts: number[] }, unknown>;
};
function internals(store: LocalConnectorStore) { return store as unknown as Internals; }
// The search's steps also yield its visibility judgment, which a hand driver runs here as the store's own driver does.
function drive<T>(store: LocalConnectorStore, steps: Generator<StoreRead | { here(): unknown }, T, unknown>, reads: StoreRead[] = []): T {
  let step = steps.next();
  while (!step.done) {
    const read = step.value;
    if ('here' in read) {
      step = steps.next(read.here());
      continue;
    }
    reads.push(read);
    const statement = internals(store).db.query(read.sql);
    step = steps.next(statement[read.mode](...(read.params as SQLQueryBindings[])));
  }
  return step.value;
}
function search(store: LocalConnectorStore, options: ConnectorStoreKeywordFtsOptions = {}, filters?: ConnectorStoreSearchFilters, reads: StoreRead[] = [], limit = 50, query = 'quartz cobalt') {
  return drive(store, internals(store).searchItemsSteps(query, limit, undefined, filters, { locate: false, ...options }), reads);
}
function summary(result: ConnectorStoreKeywordSearch) {
  return {
    ids: result.rows.map(row => row.sourceItem.providerItemId),
    matched: result.rows.map(row => result.concepts.matched.get(row.sourceItem.localItemId)),
    total: result.concepts.total,
    saturated: result.saturated,
  };
}
function conceptReads(reads: StoreRead[]) {
  // Recognize the purpose independently of which table owns the item pk.
  return reads.filter(read => /SELECT DISTINCT/.test(read.sql) && /local_item_id, i.source_version/.test(read.sql));
}
const ITEMS: FixtureSpec[] = [
  { id: 'names', name: 'quartz cobalt.txt' },
  { id: 'both', name: 'quartz cobalt.txt', text: 'quartz cobalt' },
  { id: 'body', name: 'body.txt', text: 'quartz cobalt' },
  { id: 'partial', name: 'partial.txt', text: 'quartz' },
];

test('known matches keep their order and concept coverage in plain, content-only and relaxed searches', async () => {
  const store = await openStore(ITEMS);
  expect(summary(search(store))).toEqual({ ids: ['both', 'names', 'body'], matched: [2, 2, 2], total: 2, saturated: false });
  expect(summary(search(store, { contentOnly: true }))).toEqual({ ids: ['both', 'body'], matched: [2, 2], total: 2, saturated: false });
  const reads: StoreRead[] = [];
  expect(summary(search(store, { relaxed: true }, undefined, reads))).toEqual({ ids: ['both', 'names', 'body', 'partial'], matched: [0, 0, 0, 0], total: 0, saturated: false });
  expect(conceptReads(reads)).toEqual([]);
});

test('metadata-only path and folder scopes apply to concept hits as well as candidates', async () => {
  const store = await openStore(ITEMS);
  internals(store).db.query("UPDATE items SET source_scope_folder_keys_json = '[\"names-only\"]' WHERE provider_item_id IN ('both', 'body')").run();
  for (const filters of [
    { metadataOnlyLocatorPathScopes: ['/Files/quartz cobalt.txt', '/Files/body.txt'] },
    { metadataOnlySourceScopeFolderKeys: ['names-only'] },
  ]) {
    expect(summary(search(store, {}, filters))).toEqual({ ids: ['both', 'names'], matched: [2, 2], total: 2, saturated: false });
    expect(summary(search(store, { contentOnly: true }, filters))).toEqual({ ids: [], matched: [], total: 2, saturated: false });
  }
  // This row's name matches only quartz; its scoped-out body must not supply cobalt.
  const filters = { metadataOnlyLocatorPathScopes: ['/Files/quartz.txt'] };
  const scoped = await openStore([{ id: 'split', name: 'quartz.txt', text: 'cobalt' }, { id: 'complete', name: 'quartz cobalt.txt' }]);
  expect(summary(search(scoped, {}, filters))).toEqual({ ids: ['complete'], matched: [2], total: 2, saturated: false });
});

test('per-group and unique-literal reads use rowids only from FTS and drive from the item index', async () => {
  const store = await openStore([
    { id: 'rare', name: 'rare.txt', text: 'quartz' },
    ...Array.from({ length: 12 }, (_, n) => ({ id: `common-${n}`, name: 'common.txt', text: 'cobalt lantern' })),
  ]);
  const reads: StoreRead[] = [];
  const result = search(store, {}, { metadataOnlyLocatorPathScopes: ['/elsewhere'], metadataOnlySourceScopeFolderKeys: ['other'] }, reads, 50, 'quartz cobalt lantern');
  expect(result.rows.map(row => row.sourceItem.providerItemId)).toContain('rare');
  const hits = conceptReads(reads);
  // Three groups plus the unique literal quartz exception.
  expect(hits).toHaveLength(4);
  for (const read of hits) {
    expect(read.sql).toContain('FROM connector_store_fts_rows r');
    expect(read.sql).toContain('+r.fts_rowid IN (SELECT rowid FROM connector_store_fts WHERE connector_store_fts MATCH ?)');
    expect(read.sql).not.toMatch(/connector_store_fts\.(?:item_pk|chunk_pk)/);
    expect(read.sql).toContain('r.chunk_pk IS NULL');
    const plan = internals(store).db.query(`EXPLAIN QUERY PLAN ${read.sql}`).all(...(read.params as SQLQueryBindings[])) as Array<{ detail: string }>;
    expect(plan.some(row => /SEARCH r USING .*\(item_pk=\?\)/.test(row.detail))).toBe(true);
  }
});

test('mapping-table concept counts equal known distinct items, including repeated chunks, names and absent terms', async () => {
  const store = await openStore([
    { id: 'many', name: 'many.txt', text: 'quartz cobalt '.repeat(100) },
    { id: 'names', name: 'quartz cobalt.txt' },
    { id: 'partial', name: 'partial.txt', text: 'quartz' },
  ]);
  const db = internals(store).db;
  const groups = [['quartz'], ['cobalt'], ['absentword'], ['quartz', 'cobalt']];
  const expected = [3, 2, 0, 3];
  for (const [index, group] of groups.entries()) {
    const query = group.map(term => `"${term}"*`).join(' OR ');
    const old = db.query('SELECT COUNT(DISTINCT item_pk) AS count FROM connector_store_fts WHERE connector_store_fts MATCH ?').get(query) as { count: number };
    const mapped = db.query('SELECT COUNT(DISTINCT r.item_pk) AS count FROM connector_store_fts_rows r WHERE r.fts_rowid IN (SELECT rowid FROM connector_store_fts WHERE connector_store_fts MATCH ?)').get(query) as { count: number };
    expect(old.count).toBe(expected[index]!);
    expect(mapped.count).toBe(expected[index]!);
  }
  const reads: StoreRead[] = [];
  expect(drive(store, internals(store).conceptWeightsSteps(groups, new Map()), reads).counts).toEqual(expected);
  expect(reads.filter(read => read.sql.includes('COUNT(DISTINCT')).every(read => read.sql.includes('COUNT(DISTINCT r.item_pk)'))).toBe(true);
});

test('a lane shares positive and negative group answers with content-only and expansion-free runs', async () => {
  const store = await openStore(ITEMS);
  const runs: Array<{ options: ConnectorStoreKeywordFtsOptions; reads: StoreRead[] }> = [];
  const original = internals(store).searchItemsSteps.bind(store);
  // Observe yielded SQL while the real off-thread runner executes it. The
  // lane's Map must remain here; pool jobs receive just SQL and bindings.
  internals(store).searchItemsSteps = function* (...args) {
    const reads: StoreRead[] = [];
    runs.push({ options: args[4], reads });
    const steps = original(...args);
    let step = steps.next();
    while (!step.done) {
      if (!('here' in step.value)) reads.push(step.value);
      step = steps.next(yield step.value);
    }
    return step.value;
  };
  const adapter = createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword' });
  const response = await withKeywordRequestScope(() => {
    pinKeywordAlternatives(store, 'quartz cobalt', new Map([['cobalt', ['azul']]]));
    return adapter({
      query: 'quartz cobalt', maxResults: 50,
      corpus: defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }),
      context: { allowedTrustDomains: [store.trustDomain] },
    });
  });
  expect(response.hits.map(hit => hit.sourceItem.providerItemId)).toEqual(['both', 'body', 'names']);
  expect(runs.map(run => run.options.contentOnly === true)).toEqual([false, true, false, true]);
  expect(runs[0]!.options.conceptHitMemo).toBeInstanceOf(Map);
  expect(runs.every(run => run.options.conceptHitMemo === runs[0]!.options.conceptHitMemo)).toBe(true);
  // The baseline changes cobalt's query, so only that group is unknown.
  expect(runs.map(run => conceptReads(run.reads).length)).toEqual([2, 0, 1, 0]);
});

test('memo reuse requires the same local item and version and keeps scope parameters separate', async () => {
  const store = await openStore(ITEMS);
  const memo = new Map<string, Map<number, { local_item_id: string; source_version: string | null; hit: boolean }>>();
  const options = { conceptHitMemo: memo };
  search(store, options);
  const known: StoreRead[] = [];
  expect(summary(search(store, { ...options, contentOnly: true }, undefined, known)).matched).toEqual([2, 2]);
  expect(conceptReads(known)).toEqual([]);
  for (const change of ["source_version = 'v2'", "local_item_id = 'replacement'"]) {
    internals(store).db.exec(`UPDATE items SET ${change} WHERE provider_item_id = 'body'`);
    const reads: StoreRead[] = [];
    expect(summary(search(store, options, undefined, reads)).ids).toContain('body');
    expect(conceptReads(reads)).toHaveLength(2);
    // When any answer is unknown, read the whole page, including known pks.
    expect(conceptReads(reads).every(read => read.params.filter(param => typeof param === 'number').length === ITEMS.length)).toBe(true);
  }
  for (const path of ['/Files', '/elsewhere']) {
    const reads: StoreRead[] = [];
    search(store, options, { metadataOnlyLocatorPathScopes: [path] }, reads);
    expect(conceptReads(reads)).toHaveLength(2);
  }
});
