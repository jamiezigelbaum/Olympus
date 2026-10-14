import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { fixtureConnector, FIXTURE_PLACEMENT, openTierFixture, tempDir, identityOf, localId } from './helpers/tier-fixtures.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { purgeLowerTierContent } from '../src/workers/connector-store/tier-content-purge.ts';

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const body = 'Synthetic message about a garden meeting. Bodymarkerprivatepurge.';
const target = { metadataTier: 'private' as const, contentTier: 'secure' as const };

async function fixture() {
  const tmp = tempDir('olympus-private-purge-');
  let f = openTierFixture(tmp.dir, { family: 'email' });
  // Synthetic Gmail identities exercise the shared connector pipeline.
  const base = fixtureConnector(() => [{ id: 'mail', name: 'Garden', text: body }, { id: 'safe', name: 'Orchard', text: 'Ordinary pears.' }]);
  const connector = { ...base, id: 'gmail.synthetic', family: 'email' as const,
    listItems: async function* () { for await (const page of base.listItems()) {
      if ('items' in page) yield { ...page, items: page.items.map(item => ({ ...item, identity: { ...item.identity, provider: 'gmail', family: 'email' as const } })) };
    } },
    fetchItem: async (id: string) => { const item = await base.fetchItem(id); return { ...item, identity: { ...item.identity, provider: 'gmail', family: 'email' as const } }; },
  };
  await f.set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const identity = { ...identityOf('mail'), provider: 'gmail', family: 'email' as const };
  const safe = { ...identityOf('safe'), provider: 'gmail', family: 'email' as const };
  closes.push(() => { f.close(); tmp.cleanup(); });
  return { get f() { return f; }, identity, safe,
    restart: () => { f.close(); f = openTierFixture(tmp.dir, { family: 'email' }); return f; } };
}

function contentCounts(path: string, id = 'personal:mail') {
  const db = new Database(path);
  try {
    const pk = (db.query('SELECT item_pk FROM items WHERE local_item_id = ?').get(id) as { item_pk: number }).item_pk;
    const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE item_pk = ?`).get(pk) as { n: number }).n;
    return { chunks: count('chunks'), vectors: count('chunk_embeddings'), versions: count('item_text_versions'),
      fts: (db.query('SELECT COUNT(*) AS n FROM connector_store_fts WHERE item_pk = ? AND chunk_pk IS NOT NULL').get(pk) as { n: number }).n };
  } finally { db.close(); }
}
const empty = { chunks: 0, vectors: 0, versions: 0, fts: 0 };

test('Gmail Personal to Private removes lower body, FTS, vectors and version rows; Personal neighbour unchanged', async () => {
  const x = await fixture(); const f = x.f;
  expect(contentCounts(f.paths.internal)).toMatchObject({ chunks: 1, vectors: 1, fts: 1 });
  const beforeSafe = contentCounts(f.paths.internal, localId('safe'));
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  expect(contentCounts(f.paths.internal)).toEqual(empty);
  expect(f.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
  expect(contentCounts(f.paths.internal, localId('safe'))).toEqual(beforeSafe);
  expect(f.stores.internal!.searchItems('Bodymarkerprivatepurge', 10)).toEqual([]);
});

test.each(['afterVerified', 'afterPurge'] as const)('restart after %s converges without overwriting destination from empty source', async hook => {
  const x = await fixture();
  await expect(moveTieredItem({ set: x.f.set, identity: x.identity, target, [hook]: () => { throw new Error('crash'); } })).rejects.toThrow('crash');
  if (hook === 'afterVerified') expect(contentCounts(x.f.paths.internal).chunks).toBe(1);
  else expect(contentCounts(x.f.paths.internal)).toEqual(empty);
  const reopened = x.restart(); // bounded startup pass resumes receipt
  expect(reopened.ledger.getCurrent(x.identity)?.state).toBe('current');
  expect(reopened.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
  expect(contentCounts(reopened.paths.internal)).toEqual(empty);
});

test('failed destination copy/verification leaves source intact and can be retried', async () => {
  const x = await fixture();
  const store = x.f.stores.secure_local!;
  const original = store.importItemCopy.bind(store);
  store.importItemCopy = () => { throw new Error('disk full'); };
  await expect(moveTieredItem({ set: x.f.set, identity: x.identity, target })).rejects.toThrow('disk full');
  expect(contentCounts(x.f.paths.internal)).toMatchObject({ chunks: 1, vectors: 1, fts: 1 });
  store.importItemCopy = original;
  await moveTieredItem({ set: x.f.set, identity: x.identity, target });
  expect(contentCounts(x.f.paths.internal)).toEqual(empty);
});

test('bounded ledger repair clears pre-1.0.1 leftovers including zero-chunk text versions, idempotently', async () => {
  const x = await fixture(); const f = x.f;
  const lower = f.stores.internal!;
  const kept = lower.exportItemCopy(x.identity)!;
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  // Simulate old release's retained metadata-copy content after its flip.
  lower.importItemCopy(kept, { trustTier: 'S3', syncConnectorId: 'old-release', layers: 'both' });
  const db = new Database(f.paths.internal);
  const pk = (db.query('SELECT item_pk FROM items WHERE local_item_id = ?').get(localId('mail')) as { item_pk: number }).item_pk;
  db.query('INSERT OR REPLACE INTO item_text_versions (item_pk, source_version, recorded_at) VALUES (?, ?, ?)').run(pk, 'old', '2026-10-14');
  db.query('DELETE FROM chunks WHERE item_pk = ?').run(pk); db.close();
  expect(contentCounts(f.paths.internal).versions).toBe(1);
  const r = purgeLowerTierContent(f.set, { limit: 1 });
  expect(r.checked).toBeLessThanOrEqual(1);
  expect(contentCounts(f.paths.internal)).toEqual(empty);
  purgeLowerTierContent(f.set); purgeLowerTierContent(f.set);
  expect(contentCounts(f.paths.internal)).toEqual(empty);
  expect(f.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
});

test('repair refuses an identity whose generation changes before deletion', async () => {
  const x = await fixture(); const f = x.f;
  const retained = f.stores.internal!.exportItemCopy(x.identity)!;
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  f.stores.internal!.importItemCopy(retained, { trustTier: 'S3', syncConnectorId: 'old', layers: 'both' });
  const report = purgeLowerTierContent(f.set, { limit: 1, beforeDelete: () => {
    const competing = new Database(f.ledger.dbPath);
    competing.query('UPDATE tier_items SET generation = generation + 1 WHERE provider = ? AND account_scope = ? AND provider_item_id = ?')
      .run(x.identity.provider, x.identity.accountScope, x.identity.providerItemId);
    competing.close();
  } });
  expect(report.failed).toBe(1);
  expect(contentCounts(f.paths.internal).chunks).toBe(1);
});

test('a hidden higher-tier vector cannot crowd an eligible Personal item out of the rank limit', async () => {
  const x = await fixture(); const f = x.f;
  const lower = f.stores.internal!;
  const retained = lower.exportItemCopy(x.identity)!;
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  lower.importItemCopy(retained, { trustTier: 'S3', syncConnectorId: 'old-release', layers: 'both', vectorProvider: f.cloud });
  const db = new Database(f.paths.internal);
  for (const [id, values] of [[localId('mail'), [1, 0, 0, 0]], [localId('safe'), [0, 1, 0, 0]]] as const) {
    db.query('UPDATE chunk_embeddings SET embedding = ? WHERE item_pk = (SELECT item_pk FROM items WHERE local_item_id = ?)')
      .run(new Uint8Array(new Float32Array(values).buffer), id);
  }
  db.close();
  f.cloud.embed = async () => [[1, 0.8, 0, 0]];
  const results = await lower.vectorSearchItems('garden', f.cloud, 1);
  expect(results.map(row => row.sourceItem.localItemId)).toEqual([localId('safe')]);
});

test('destination verification failure preserves the lower source and its vectors', async () => {
  const x = await fixture();
  await expect(moveTieredItem({ set: x.f.set, identity: x.identity, target, afterVerified: () => {
    const db = new Database(x.f.paths.secure_local);
    db.query('DELETE FROM chunks').run(); db.close();
  } })).rejects.toThrow('destination changed');
  expect(contentCounts(x.f.paths.internal)).toMatchObject({ chunks: 1, vectors: 1, fts: 1 });
  expect(x.f.ledger.getCurrent(x.identity)?.state).toBe('moving');
});

test('a metadata-only raise removes zero-chunk version remnants', async () => {
  const tmp = tempDir(); const f = openTierFixture(tmp.dir, { embed: false });
  closes.push(() => { f.close(); tmp.cleanup(); });
  await f.set.sync(fixtureConnector(() => [{ id: 'mail', name: 'Garden' }]), { placement: FIXTURE_PLACEMENT });
  const identity = identityOf('mail');
  f.ledger.adoptLegacyPlacement(identity, [{ corpusId: f.stores.internal!.corpusId, trustDomain: 'internal', layers: 'metadata' }]);
  f.stores.internal!.bindTierSet(f.ledger);
  const db = new Database(f.paths.internal);
  const pk = (db.query('SELECT item_pk FROM items WHERE local_item_id = ?').get(localId('mail')) as { item_pk: number }).item_pk;
  db.query('INSERT INTO item_text_versions (item_pk, source_version, recorded_at) VALUES (?, ?, ?)').run(pk, 'old', '2026-10-14');
  db.close();
  await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  expect(contentCounts(f.paths.internal)).toEqual(empty);
});

test('a move between vector scan pages cannot crowd out a Personal match at ranking time', async () => {
  const x = await fixture(); const f = x.f; const lower = f.stores.internal!;
  const copy = lower.exportItemCopy(x.identity)!;
  lower.importItemCopy({ ...copy, chunks: Array.from({ length: 260 }, (_, chunkIndex) => ({ ...copy.chunks[0]!, chunkIndex })) },
    { trustTier: 'S3', syncConnectorId: 'paged-fixture', layers: 'both' });
  const db = new Database(f.paths.internal);
  db.query(`INSERT OR REPLACE INTO chunk_embeddings (chunk_pk, item_pk, model_id, content_hash, embedding, embedded_at)
    SELECT c.chunk_pk, c.item_pk, ?, c.embedding_input_hash, ?, '2026-10-14'
    FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.local_item_id = ?`)
    .run(f.cloud.modelId, new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer), localId('mail'));
  db.query('UPDATE chunk_embeddings SET embedding = ? WHERE item_pk = (SELECT item_pk FROM items WHERE local_item_id = ?)')
    .run(new Uint8Array(new Float32Array([0, 1, 0, 0]).buffer), localId('safe'));
  db.close();
  let moved!: Promise<unknown>;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  f.cloud.embed = async () => {
    setTimeout(() => { moved = moveTieredItem({ set: f.set, identity: x.identity, target }); began(); }, 0);
    return [[1, 0.8, 0, 0]];
  };
  const searching = lower.vectorSearchItems('garden', f.cloud, 1);
  await started; await moved;
  expect((await searching).map(row => row.sourceItem.localItemId)).toEqual([localId('safe')]);
});
