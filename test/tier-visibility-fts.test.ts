import { afterEach, expect, spyOn, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { CONNECTOR_STORE_FTS_MIGRATION } from '../src/workers/connector-store/local-index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import {
  CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, openTierFixture,
  snapshotStore, tempDir,
} from './helpers/tier-fixtures.ts';
import { cleanups, fixtureWithEveryState, probe, secondWriter } from './helpers/tier-visibility-saved-set.ts';
import { createTestClock } from './helpers/test-clock.ts';

afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const ITEM = { id: 'garden', name: 'garden.txt', text: 'The compost bins need turning weekly.' };

async function loweringFixture(domain: 'internal' | 'secure_local' = 'internal') {
  const { dir, cleanup } = tempDir('olympus-1276-');
  const f = openTierFixture(dir);
  cleanups.push(cleanup, () => f.close());
  await f.set.sync(fixtureConnector(() => [ITEM]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  if (domain === 'secure_local') {
    await moveTieredItem({ set: f.set, identity: identityOf(ITEM.id), target: { metadataTier: 'secure', contentTier: 'secure' } });
    await f.stores.secure_local!.embedChunks({ provider: f.local });
  }
  const source = f.stores[domain]!;
  await source.saveVisibilityInTurns();
  await moveTieredItem({
    set: f.set, identity: identityOf(ITEM.id),
    target: { metadataTier: 'public', contentTier: 'public' },
    vectorIdentities: { public_safe: f.cloud },
  });
  return { f, source };
}

function ftsRows(store: LocalConnectorStore, id: string) {
  const db = probe(store).db;
  return {
    indexed: (db.query(`SELECT COUNT(*) AS n FROM connector_store_fts
      WHERE item_pk IN (SELECT item_pk FROM items WHERE local_item_id = ?)`).get(localId(id)) as { n: number }).n,
    owned: (db.query(`SELECT COUNT(*) AS n FROM connector_store_fts_rows
      WHERE item_pk IN (SELECT item_pk FROM items WHERE local_item_id = ?)`).get(localId(id)) as { n: number }).n,
  };
}

function rebuildFromScratch(store: LocalConnectorStore) {
  const spy = spyOn(store as unknown as { savedVisibilitySteps(): Generator<void, undefined> }, 'savedVisibilitySteps')
    .mockImplementation(function* () { return undefined; });
  cleanups.push(() => spy.mockRestore());
  probe(store).tierLedgerHiddenMemo = undefined;
}

test.each(['internal', 'secure_local'] as const)('publishing a lowering from %s removes only FTS rows, so keyword search reads no superseded candidates', async (domain) => {
  const { source } = await loweringFixture(domain);
  const kept = snapshotStore(source.dbPath, [localId(ITEM.id)]);
  expect(kept.chunks.length).toBeGreaterThan(0);
  expect(kept.vectors.length).toBeGreaterThan(0);
  await source.saveVisibilityInTurns();
  expect(ftsRows(source, ITEM.id)).toEqual({ indexed: 0, owned: 0 });
  expect(snapshotStore(source.dbPath, [localId(ITEM.id)])).toEqual(kept);
  const gate = spyOn(source as unknown as { tierVisibleRows(rows: unknown[]): unknown[] }, 'tierVisibleRows');
  try {
    expect(source.searchItems('compost', 10)).toEqual([]);
    expect(gate.mock.calls.flatMap(([rows]) => rows)).toEqual([]);
  } finally { gate.mockRestore(); }
});

test('rollback publication restores keyword search without replacing chunks or vectors', async () => {
  const { f, source } = await loweringFixture();
  await source.saveVisibilityInTurns();
  expect(ftsRows(source, ITEM.id)).toEqual({ indexed: 0, owned: 0 });
  const kept = snapshotStore(f.paths.internal, [localId(ITEM.id)]);
  f.ledger.rollbackMove(identityOf(ITEM.id), { expectedGeneration: f.ledger.getCurrent(identityOf(ITEM.id))!.generation });
  await source.saveVisibilityInTurns();
  expect(ftsRows(source, ITEM.id)).toEqual({ indexed: kept.chunks.length + 1, owned: kept.chunks.length + 1 });
  expect(source.searchItems('compost', 10).map(row => row.sourceItem.providerItemId)).toEqual([ITEM.id]);
  expect(snapshotStore(f.paths.internal, [localId(ITEM.id)])).toEqual(kept);
  await f.stores.public_safe!.saveVisibilityInTurns();
  expect(ftsRows(f.stores.public_safe!, ITEM.id)).toEqual({ indexed: 0, owned: 0 });
});

test('a full visibility generation restores a copy that left the hidden members', async () => {
  const { f, source } = await loweringFixture();
  await source.saveVisibilityInTurns();
  expect(ftsRows(source, ITEM.id)).toEqual({ indexed: 0, owned: 0 });
  f.ledger.rollbackMove(identityOf(ITEM.id), { expectedGeneration: f.ledger.getCurrent(identityOf(ITEM.id))!.generation });
  rebuildFromScratch(source);
  await source.saveVisibilityInTurns();
  expect(source.searchItems('compost', 10).map(row => row.sourceItem.providerItemId)).toEqual([ITEM.id]);
  expect(ftsRows(source, ITEM.id).owned).toBeGreaterThan(0);
});

test('refresh and FTS rebuild skip published superseded copies and retain held, names-only and moving copies', async () => {
  const { writer, pk } = await fixtureWithEveryState();
  await writer.saveVisibilityInTurns();
  const refresh = writer as unknown as { refreshFtsForItem(pk: number): number };
  expect(refresh.refreshFtsForItem(pk('hid'))).toBe(0);
  expect(ftsRows(writer, 'hid')).toEqual({ indexed: 0, owned: 0 });
  for (const id of ['plain', 'held', 'names', 'staged']) {
    expect(refresh.refreshFtsForItem(pk(id))).toBeGreaterThan(0);
    expect(ftsRows(writer, id).owned).toBeGreaterThan(0);
  }
  const db = probe(writer).db;
  db.transaction(() => {
    db.exec('DELETE FROM connector_store_fts_rows; DELETE FROM connector_store_fts;');
    db.query(CONNECTOR_STORE_FTS_MIGRATION.rebuildSql).run();
    db.exec(`INSERT INTO connector_store_fts_rows (fts_rowid, item_pk, chunk_pk)
      SELECT rowid, item_pk, chunk_pk FROM connector_store_fts;`);
  })();
  expect(ftsRows(writer, 'hid')).toEqual({ indexed: 0, owned: 0 });
  for (const id of ['plain', 'held', 'names', 'staged']) expect(ftsRows(writer, id).owned).toBeGreaterThan(0);
  expect(writer.searchItems('picnic', 20).map(row => row.sourceItem.providerItemId)).not.toContain('staged');
});

test('stale published flags cannot make a newly hidden copy servable', async () => {
  const { writer, ledgerDb } = await fixtureWithEveryState();
  await writer.saveVisibilityInTurns();
  expect(ftsRows(writer, 'plain').owned).toBeGreaterThan(0);
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?")
    .run(CORPORA.internal);
  expect(writer.searchItems('picnic', 20).map(row => row.sourceItem.providerItemId)).not.toContain('plain');
});

test('a reopened writer prunes old FTS rows even when the saved visibility stamp is already current', async () => {
  const { f, source } = await loweringFixture();
  await source.saveVisibilityInTurns();
  // Simulate the old build: the saved member is hidden, but FTS still holds it.
  const db = probe(source).db;
  db.exec(`INSERT INTO connector_store_fts (title, bounded_text, item_pk, chunk_pk)
    SELECT title, search_text, item_pk, NULL FROM items WHERE tombstoned = 0;
    INSERT OR IGNORE INTO connector_store_fts_rows (fts_rowid, item_pk, chunk_pk)
    SELECT rowid, item_pk, chunk_pk FROM connector_store_fts;`);
  expect(ftsRows(source, ITEM.id).owned).toBeGreaterThan(0);
  const reopened = new LocalConnectorStore({ dbPath: source.dbPath, corpusId: source.corpusId,
    family: source.family, trustDomain: source.trustDomain, tierLedger: f.ledger });
  cleanups.push(() => reopened.close());
  await reopened.saveVisibilityInTurns();
  expect(ftsRows(reopened, ITEM.id)).toEqual({ indexed: 0, owned: 0 });
});

test('unpublished generation flags neither suppress visible refreshes nor restore hidden copies', async () => {
  const { writer, pk } = await fixtureWithEveryState();
  await writer.saveVisibilityInTurns();
  const db = probe(writer).db;
  db.exec(`INSERT INTO tier_visibility_members
      (generation, provider, account_scope, conversation_key, provider_item_id, flags, item_pks_json)
    SELECT s.generation + 1, i.provider, i.account_scope, i.normalized_conversation, i.provider_item_id,
      CASE WHEN i.provider_item_id = 'plain' THEN 1 ELSE 0 END, json_array(i.item_pk)
    FROM items i CROSS JOIN tier_visibility_state s WHERE i.provider_item_id IN ('plain', 'hid');`);
  const refresh = writer as unknown as { refreshFtsForItem(pk: number): number };
  expect(refresh.refreshFtsForItem(pk('plain'))).toBeGreaterThan(0);
  expect(refresh.refreshFtsForItem(pk('hid'))).toBe(0);
  expect(ftsRows(writer, 'hid')).toEqual({ indexed: 0, owned: 0 });
});

test('FTS deletion and the hidden member roll back together if publication fails', async () => {
  const { f, source } = await loweringFixture();
  // The move has not published the source yet. Disable its background timer.
  probe(source).visibilityTimers = createTestClock();
  const db = probe(source).db;
  const before = db.query('SELECT * FROM tier_visibility_state').all();
  const beforeRows = ftsRows(source, ITEM.id);
  const target = source as unknown as { deleteFtsForItem(pk: number): number };
  const original = target.deleteFtsForItem.bind(source);
  const remove = spyOn(target, 'deleteFtsForItem').mockImplementation(pk => {
    original(pk);
    throw new Error('injected failure after FTS deletion');
  });
  try {
    await source.saveVisibilityInTurns();
    expect(remove).toHaveBeenCalled();
    expect(ftsRows(source, ITEM.id)).toEqual(beforeRows);
    expect(db.query('SELECT * FROM tier_visibility_state').all()).toEqual(before);
    expect(db.query('SELECT * FROM tier_visibility_members').all()).toEqual([]);
  } finally { remove.mockRestore(); }
  await probe(source).publishVisibility();
  expect(ftsRows(source, ITEM.id)).toEqual({ indexed: 0, owned: 0 });
  expect(f.ledger.getCurrent(identityOf(ITEM.id))!.contentTier).toBe('public');
});

test('FTS restoration and the member removal roll back together if publication fails', async () => {
  const { f, source } = await loweringFixture();
  await source.saveVisibilityInTurns();
  probe(source).visibilityTimers = createTestClock();
  const db = probe(source).db;
  const before = db.query('SELECT * FROM tier_visibility_members').all();
  f.ledger.rollbackMove(identityOf(ITEM.id), { expectedGeneration: f.ledger.getCurrent(identityOf(ITEM.id))!.generation });
  const target = source as unknown as { refreshFtsForItem(pk: number, generation?: number): number };
  const original = target.refreshFtsForItem.bind(source);
  const refresh = spyOn(target, 'refreshFtsForItem').mockImplementation((pk, generation) => {
    original(pk, generation);
    throw new Error('injected failure after FTS restoration');
  });
  try {
    await source.saveVisibilityInTurns();
    expect(refresh).toHaveBeenCalled();
    expect(ftsRows(source, ITEM.id)).toEqual({ indexed: 0, owned: 0 });
    expect(db.query('SELECT * FROM tier_visibility_members').all()).toEqual(before);
  } finally { refresh.mockRestore(); }
  await probe(source).publishVisibility();
  expect(source.searchItems('compost', 10).map(row => row.sourceItem.providerItemId)).toEqual([ITEM.id]);
});

test('a newer publisher repairs an interrupted full prune and a publisher that lost its lease cannot prune again', async () => {
  const { f, writer, ledgerDb } = await fixtureWithEveryState();
  await writer.saveVisibilityInTurns();
  const clock = createTestClock();
  probe(writer).visibilityTimers = clock;
  probe(writer).visibilityNow = clock.now;
  probe(writer).visibilityPublishChunk = 1;
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?")
    .run(CORPORA.internal);
  rebuildFromScratch(writer);
  probe(writer).tierHiddenItemPks();
  const older = probe(writer).visibilityPublishSteps();
  for (let step = 0; ftsRows(writer, 'plain').owned > 0; step++) {
    expect(step).toBeLessThan(100);
    expect(older.next().done).not.toBe(true);
  }
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'current' WHERE provider_item_id = 'plain' AND corpus_id = ?")
    .run(CORPORA.internal);
  clock.set(clock.now() + 60_000);
  const newer = secondWriter(f, clock);
  await newer.saveVisibilityInTurns();
  expect(ftsRows(newer, 'plain').owned).toBeGreaterThan(0);
  expect(() => { for (let step = older.next(); !step.done; step = older.next()) { /* resume */ } }).toThrow();
  expect(newer.searchItems('picnic', 20).map(row => row.sourceItem.providerItemId)).toContain('plain');
  expect(ftsRows(newer, 'plain').owned).toBeGreaterThan(0);
});

test('a refresh during a full generation build cannot leave superseded rows behind after publication', async () => {
  const { writer, ledgerDb, pk } = await fixtureWithEveryState();
  await writer.saveVisibilityInTurns();
  probe(writer).visibilityTimers = createTestClock();
  probe(writer).visibilityPublishChunk = 1;
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?")
    .run(CORPORA.internal);
  rebuildFromScratch(writer);
  probe(writer).tierHiddenItemPks();
  const steps = probe(writer).visibilityPublishSteps();
  for (let step = 0; ftsRows(writer, 'plain').owned > 0; step++) {
    expect(step).toBeLessThan(100);
    expect(steps.next().done).not.toBe(true);
  }
  // Sync still sees the old published generation, where plain is current.
  const refresh = writer as unknown as { refreshFtsForItem(pk: number): number };
  expect(refresh.refreshFtsForItem(pk('plain'))).toBeGreaterThan(0);
  for (let step = steps.next(); !step.done; step = steps.next()) { /* finish the publish */ }
  expect(ftsRows(writer, 'plain')).toEqual({ indexed: 0, owned: 0 });
});
