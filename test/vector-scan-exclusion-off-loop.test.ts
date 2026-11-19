import { afterEach, expect, spyOn, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { startMainThreadSqlSiteCount } from '../src/workers/connector-store/main-thread-sql-trace.ts';
import { setReadPoolObserverForTests, shutdownReadPool, type StoreRead } from '../src/workers/connector-store/off-thread-reads.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

type Exclusion = { has(itemPk: number): boolean };
type BaseLists = { hidden: number[]; held: number[]; metadataLayer: number[] };
interface StoreProbe {
  db: Database;
  scheduleVisibilityPublish(): void;
  tierHiddenCountsRefresh: Promise<void> | undefined;
  tierLedgerHiddenMemo?: { lists: { hidden: { add(pk: number): void; delete(pk: number): void } } };
  tierLedgerHiddenSteps(): Generator<unknown, BaseLists, unknown>;
  tierLedgerHiddenItemPks(): BaseLists;
  hiddenChildItemPks(): number[];
  hiddenChildItemPksInTurns(): Promise<number[]>;
  vectorScanExcludedItemPks(): Exclusion | undefined | Promise<Exclusion | undefined>;
  vectorScanExclusion: { set: Set<number> } | undefined;
}

const probe = (store: LocalConnectorStore) => store as unknown as StoreProbe;
const ids = ['visible', 'changing', 'held', 'metadata', 'hidden-parent', 'hidden-child', 'tombstoned-parent', 'tombstoned-child'];
const initiallyExcluded = ['held', 'metadata', 'hidden-parent', 'hidden-child', 'tombstoned-child'];
const cleanups: Array<() => void> = [];

afterEach(() => {
  setReadPoolObserverForTests();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  shutdownReadPool();
});

async function setup() {
  const tmp = tempDir('olympus-vector-scan-exclusion-');
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanups.push(() => { f.close(); tmp.cleanup(); });
  for (const store of Object.values(f.stores)) probe(store!).scheduleVisibilityPublish = () => {};
  const writer = f.stores.internal!;
  const db = probe(writer).db;
  const ledgerDb = (f.ledger as unknown as { db: Database }).db;
  await f.set.sync(fixtureConnector(() => ids.map(id => ({ id, name: id, text: 'Orchard picnic notes.' }))),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await writer.embedChunks({ provider: f.cloud });
  // Give each withheld row a real vector so the live check has to reject it
  // when the scan does not have an exclusion set.
  expect(db.query('SELECT COUNT(DISTINCT item_pk) AS count FROM chunk_embeddings').get()).toEqual({ count: ids.length });
  const copyState = (id: string, state: 'current' | 'staged' | 'superseded') => {
    ledgerDb.query('UPDATE tier_copies SET copy_state = ? WHERE corpus_id = ? AND provider_item_id = ?').run(state, writer.corpusId, id);
  };
  copyState('hidden-parent', 'staged');
  ledgerDb.query('UPDATE tier_copies SET embed_hold = 1 WHERE provider_item_id = ?').run('held');
  ledgerDb.query("UPDATE tier_copies SET layers = 'metadata' WHERE provider_item_id = ?").run('metadata');
  for (const parent of ['hidden', 'tombstoned']) {
    db.query('UPDATE items SET parent_local_item_id = ? WHERE provider_item_id = ?')
      .run(identityOf(`${parent}-parent`).localItemId, `${parent}-child`);
  }
  // Keep the child's own live row and vector after deleting its parent.
  writer.tombstoneCopy(identityOf('tombstoned-parent'), { connectorId: 'fixture-deletion' });

  const reader = (poolIncremental = true) => {
    const key = 'OLYMPUS_HIDDEN_SET_INCREMENTAL_OFF_LOOP';
    const previous = process.env[key];
    process.env[key] = poolIncremental ? '1' : '0';
    let store: LocalConnectorStore;
    try {
      store = new LocalConnectorStore({ dbPath: f.paths.internal, corpusId: CORPORA.internal, family: 'file',
        trustDomain: 'internal', readOnly: true, tierLedger: f.ledger });
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    store.useChildVisibility({ ledger: () => f.ledger, stores: () => [store, f.stores.secure_local!] });
    cleanups.push(() => store.close());
    return store;
  };
  const search = (store: LocalConnectorStore) => store.vectorSearchLane('Orchard picnic notes.', f.cloud, ids.length);
  const pk = (id: string) => (db.query('SELECT item_pk FROM items WHERE provider_item_id = ?').get(id) as { item_pk: number }).item_pk;
  return { pk, reader, search, copyState };
}

function syncExclusion(store: StoreProbe): Set<number> {
  const { hidden, held, metadataLayer } = store.tierLedgerHiddenItemPks();
  return new Set([...hidden, ...held, ...metadataLayer, ...store.hiddenChildItemPks()]);
}

function observePool() {
  const reads: StoreRead[] = [];
  setReadPoolObserverForTests((_path, read) => reads.push(read), { snapshots: true });
  return reads;
}

test.each([true, false])('warm vector search reads changed parents on the pool (incremental feed pooling %s)', async (poolIncremental) => {
  const h = await setup();
  const front = h.reader(poolIncremental);
  probe(front).tierLedgerHiddenItemPks();
  probe(front).hiddenChildItemPks();
  h.copyState('hidden-parent', 'superseded');
  const pooled = observePool();
  const trace = startMainThreadSqlSiteCount(8);
  try {
    const result = await h.search(front);
    const sites = trace.sites().filter(({ site }) => /\b(hiddenChildSteps|parentStandings)\b/.test(site)
      || (poolIncremental && site.includes('tierLedgerHiddenSteps ')
        // These statements check the binding and capture feed bounds before yielding.
        && !/\b(tierSetBinding|holdsBoundId|hiddenChangeFinders)\b/.test(site)));
    expect(sites).toEqual([]);
    expect(pooled.some(({ sql }) => sql.includes('FROM keys k CROSS JOIN tier_copies'))).toBe(poolIncremental);
    expect(pooled.some(({ sql }) => sql.includes('FROM items WHERE local_item_id IN'))).toBe(true);
    expect(result.rows.map(({ sourceItem }) => sourceItem.providerItemId).sort()).toEqual(['changing', 'visible']);
  } finally { trace.stop(); }
});

test('the vector exclusion and search match the synchronous builders, and concurrent searches share a build', async () => {
  const h = await setup();
  const front = h.reader();
  const reference = h.reader();
  const frontProbe = probe(front);
  const referenceProbe = probe(reference);
  const cold = spyOn(frontProbe, 'vectorScanExcludedItemPks');
  const coldSearch = await h.search(front);
  expect(await cold.mock.results[0]?.value).toBeUndefined();
  expect(coldSearch.rows.map(({ sourceItem }) => sourceItem.providerItemId).sort()).toEqual(['changing', 'visible']);
  await frontProbe.tierHiddenCountsRefresh;
  cold.mockRestore();

  referenceProbe.vectorScanExcludedItemPks = () => syncExclusion(referenceProbe);
  const builds = spyOn(frontProbe, 'tierLedgerHiddenSteps');
  const exclusion = spyOn(frontProbe, 'vectorScanExcludedItemPks');
  const [first, second] = await Promise.all([h.search(front), h.search(front)]);
  expect(builds).toHaveBeenCalledTimes(1);
  expect(first).toEqual(await h.search(reference));
  expect(second).toEqual(first);
  const initial = await exclusion.mock.results[0]?.value as Exclusion | undefined;
  expect(await exclusion.mock.results[1]?.value).toBe(initial);
  expect(syncExclusion(referenceProbe)).toEqual(new Set(initiallyExcluded.map(h.pk)));
  for (const id of ids) expect(initial?.has(h.pk(id))).toBe(initiallyExcluded.includes(id));

  const cached = frontProbe.vectorScanExclusion?.set;
  await h.search(front);
  expect(cached).toBeDefined();
  expect(frontProbe.vectorScanExclusion?.set).toBe(cached);

  h.copyState('hidden-parent', 'current');
  h.copyState('changing', 'staged');
  const changed = await h.search(front);
  expect(changed).toEqual(await h.search(reference));
  expect(changed.rows.map(({ sourceItem }) => sourceItem.providerItemId).sort()).toEqual(['hidden-child', 'hidden-parent', 'visible']);
  expect(frontProbe.vectorScanExclusion?.set).not.toBe(cached);
  const expected = syncExclusion(referenceProbe);
  const updated = await exclusion.mock.results.at(-1)?.value as Exclusion | undefined;
  for (const id of ids) expect(updated?.has(h.pk(id))).toBe(expected.has(h.pk(id)));

  const failedChildRead = spyOn(frontProbe, 'hiddenChildItemPksInTurns').mockRejectedValueOnce(new Error('fixture read failure'));
  expect(await h.search(front)).toEqual(changed);
  expect(await exclusion.mock.results.at(-1)?.value).toBeUndefined();
  failedChildRead.mockRestore();
  expect(await h.search(front)).toEqual(changed);
  expect(await exclusion.mock.results.at(-1)?.value).toBeDefined();
});

test('a write and memo advance during a large set build discard it and the live check still hides the new copy', async () => {
  const h = await setup();
  const front = h.reader();
  const reference = h.reader();
  const frontProbe = probe(front);
  const referenceProbe = probe(reference);
  frontProbe.tierLedgerHiddenItemPks();
  frontProbe.hiddenChildItemPks();
  referenceProbe.vectorScanExcludedItemPks = () => syncExclusion(referenceProbe);
  // Pad the real memo past one set-building slice without timing a large
  // SQLite seed. Negative pks cannot collide with the fixture's stored rows.
  const padding = Array.from({ length: 20_001 }, (_, index) => -index - 1);
  const hidden = frontProbe.tierLedgerHiddenMemo!.lists.hidden;
  for (const pk of padding) hidden.add(pk);

  const exclusion = spyOn(frontProbe, 'vectorScanExcludedItemPks');
  const childRead = frontProbe.hiddenChildItemPksInTurns.bind(frontProbe);
  let write: Promise<void> | undefined;
  const duringBuild = spyOn(frontProbe, 'hiddenChildItemPksInTurns').mockImplementationOnce(async () => {
    const children = await childRead();
    // Runs on the event loop while the copy of the base lists is in progress.
    write = new Promise<void>(resolve => setImmediate(resolve)).then(() => {
      expect(frontProbe.vectorScanExclusion).toBeUndefined();
      h.copyState('changing', 'staged');
      expect(frontProbe.tierLedgerHiddenItemPks().hidden).toContain(h.pk('changing'));
    });
    return children;
  });
  const raced = await h.search(front);
  expect(write).toBeDefined();
  await write;
  expect(await exclusion.mock.results[0]?.value).toBeUndefined();
  expect(frontProbe.vectorScanExclusion).toBeUndefined();
  expect(raced).toEqual(await h.search(reference));
  expect(raced.rows.map(({ sourceItem }) => sourceItem.providerItemId)).toEqual(['visible']);
  duringBuild.mockRestore();
  for (const pk of padding) hidden.delete(pk);

  expect(await h.search(front)).toEqual(raced);
  const rebuilt = await exclusion.mock.results.at(-1)?.value as Exclusion | undefined;
  const expected = syncExclusion(referenceProbe);
  expect(new Set(ids.map(h.pk).filter(pk => rebuilt?.has(pk)))).toEqual(expected);
});
