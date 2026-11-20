import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore, nextVectorDigestBackfillRows, setVectorDigestBackfillHold, connectorStoreCurrentEmbeddingPageQuery, connectorStoreCurrentEmbeddingRowsIterator, connectorStoreVectorDigestPageQuery, forEachPackedVectorDigest, scanDigestPages, type VectorDigestPackedPage } from '../src/workers/connector-store/local-index.ts';
import { applyVectorDigestWindow, backfillVectorDigests, createVectorDigestSchema, vectorDigestSourceQuery, vectorDigestState, writeVectorDigest, type VectorDigestSourceRow } from '../src/workers/connector-store/vector-digest.ts';
import { cosineSimilarity, decodeEmbedding, encodeEmbedding, type SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { encodeVectorDigest, scoreVectorDigest } from '../src/workers/source-index/vector-digest.ts';
import type { StoreRead } from '../src/workers/connector-store/off-thread-reads.ts';
import { waitFor } from './helpers/test-clock.ts';
import { storeReadHasPriority, withStoreReadPriority } from '../src/core/store-reclaim-admission.ts';
import { createStandBack, ownerAskReason } from '../src/workers/engine/stand-back.ts';
import { READ_POOL_RESCORE_READERS, readPoolDiagnostics, setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { probeVectorDigest, seededVectorRandom } from '../eval/vector-digest-probe.ts';

// The digest pass is opt-in while olympus-ops#151 is open; these tests cover it on.
const digestSetting = process.env.OLYMPUS_VECTOR_DIGEST;
beforeAll(() => { delete process.env.OLYMPUS_VECTOR_DIGEST; });
afterAll(() => { if (digestSetting !== undefined) process.env.OLYMPUS_VECTOR_DIGEST = digestSetting; });
const modelId = 'digest-fixture';
const provider: SourceEmbeddingProvider = { provider: 'built-in', backend: 'local', modelId, dimension: 3, configHash: '1', epochId: '1', async embed(inputs) { return inputs.map(() => [1, 0, 0]); } };
const open = (dbPath = ':memory:', tierLedger: TierLedger | null = null) => {
  const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.digest', family: 'file', trustDomain: 'internal', tierLedger });
  // These disposable fixtures exercise indexing and backfill, not power-loss
  // durability. Hundreds of FULL-synchronous commits otherwise dominate seed
  // time on the runner (with either vacuum mode).
  database(store).exec('PRAGMA synchronous=OFF');
  return store;
};
const database = (store: LocalConnectorStore) => (store as unknown as { db: Database }).db;
function connector(count: number): SourceConnector {
  const items: RawItem[] = Array.from({ length: count }, (_, i) => ({
    identity: { family: 'file', provider: 'fixture', accountScope: 'a', providerItemId: String(i), localItemId: `a:${i}`, sourceVersion: '1' },
    mimeType: 'text/plain', content: { kind: 'text', text: `harbor note ${i}` },
    metadata: { name: `note${i}`, locatorUri: `/allowed/${i}`, authoredAt: '2026-11-01T00:00:00Z' }, fetchedAt: '2026-11-01T00:00:00Z',
  }));
  return { id: 'fixture', family: 'file', async authenticate() {}, async *listItems() { yield { items, done: true }; }, async fetchItem(id) { return items.find(x => x.identity.localItemId === id)!; }, classificationSignals() { return {}; } };
}
function reader(db: Database, onRows?: (query: StoreRead, rows: unknown) => void) {
  return async (query: StoreRead): Promise<unknown> => {
    const params = query.params as Array<string | number | null>;
    const rows = query.mode === 'all' ? db.query(query.sql).all(...params) : db.query(query.sql).get(...params);
    onRows?.(query, rows);
    return rows;
  };
}
function rank(result: Awaited<ReturnType<typeof scanDigestPages>>, limit = 20): number[] {
  if ('skippedReason' in result) throw new Error(result.skippedReason);
  return [...result.bestByItem].filter(([, v]) => v.bestCosine >= 0.18)
    .sort((a, b) => b[1].bestCosine - a[1].bestCosine || a[0] - b[0]).slice(0, limit).map(([pk]) => pk);
}
function exact(db: Database, query: number[], options: Parameters<typeof connectorStoreCurrentEmbeddingRowsIterator>[1], limit = 20): number[] {
  const best = new Map<number, number>();
  for (const row of connectorStoreCurrentEmbeddingRowsIterator(db, options)) {
    const score = cosineSimilarity(query, decodeEmbedding(row.embedding));
    if (score > (best.get(row.itemPk) ?? -Infinity)) best.set(row.itemPk, score);
  }
  return [...best].filter(([, score]) => score >= 0.18).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit).map(([pk]) => pk);
}

/** Minimal SQL spine for numerical recall; real store writes are exercised below. */
function numericStore(path = ':memory:'): Database {
  const db = new Database(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA synchronous=OFF; PRAGMA journal_mode=WAL;
    CREATE TABLE items(item_pk INTEGER PRIMARY KEY, local_item_id TEXT, account_scope TEXT, tombstoned INTEGER DEFAULT 0, provider TEXT, locator_uri TEXT);
    CREATE TABLE chunks(chunk_pk INTEGER PRIMARY KEY, item_pk INTEGER REFERENCES items(item_pk) ON DELETE CASCADE,
      embedding_input_hash TEXT, content_hash TEXT NOT NULL);
    CREATE TABLE chunk_embeddings(chunk_pk INTEGER REFERENCES chunks(chunk_pk) ON DELETE CASCADE, model_id TEXT, item_pk INTEGER, content_hash TEXT, embedding BLOB, embedded_at TEXT, PRIMARY KEY(chunk_pk, model_id));
    CREATE INDEX embeddings_model ON chunk_embeddings(model_id);`);
  createVectorDigestSchema(db);
  return db;
}
function insert(db: Database, chunkPk: number, vector: number[], itemPk = chunkPk, model = modelId): void {
  db.query('INSERT OR IGNORE INTO items VALUES (?, ?, ?, 0, ?, ?)').run(itemPk, String(itemPk), 'a', 'fixture', '/allowed/item');
  db.query('INSERT OR IGNORE INTO chunks VALUES (?, ?, ?, ?)').run(chunkPk, itemPk, 'hash', 'text-hash');
  const embedding = encodeEmbedding(vector, vector.length);
  db.query('INSERT OR REPLACE INTO chunk_embeddings VALUES (?, ?, ?, ?, ?, ?)').run(chunkPk, model, itemPk, 'hash', embedding, 'now');
  writeVectorDigest(db, chunkPk, model, itemPk, embedding);
}
function finish(db: Database, model = modelId): void { while (!backfillVectorDigests(db, model, 256).completed) {} }

test('digest is a normalized signed int8 prefix with a float32 scale, including small and zero vectors', () => {
  const vector = Array.from({ length: 768 }, (_, i) => Math.sin(i));
  const digest = encodeVectorDigest(decodeEmbedding(encodeEmbedding(vector, 768)));
  expect(digest.length).toBe(260);
  expect(scoreVectorDigest(digest, digest)).toBeCloseTo(1, 2);
  const prefix = vector.slice(0, 256);
  expect(scoreVectorDigest(digest, encodeVectorDigest(prefix))).toBeCloseTo(1, 2);
  expect(encodeVectorDigest([1, -1, 0]).length).toBe(7);
  expect(scoreVectorDigest(encodeVectorDigest([0, 0]), encodeVectorDigest([0, 0]))).toBe(0);
});

test('real embedding insert, epoch replace, copy import, item delete, model delete and cascades maintain digests atomically', async () => {
  const store = open(), target = open();
  try {
    await store.syncFromConnector(connector(4), { fetchContent: true });
    await store.embedChunks({ provider });
    const db = database(store);
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 4 });
    expect(vectorDigestState(db, modelId).completed).toBe(true);
    expect(db.query('SELECT DISTINCT account_scope FROM chunk_vector_digest').all()).toEqual([{ account_scope: 'a' }]);
    const before = (db.query('SELECT digest FROM chunk_vector_digest LIMIT 1').get() as { digest: Uint8Array }).digest;
    const replacement = { ...provider, epochId: '2', async embed(inputs: Parameters<SourceEmbeddingProvider['embed']>[0]) { return inputs.map(() => [0, 1, 0]); } };
    await store.embedChunks({ provider: replacement });
    const after = (db.query('SELECT digest FROM chunk_vector_digest LIMIT 1').get() as { digest: Uint8Array }).digest;
    expect(after).not.toEqual(before);
    const copy = store.exportItemCopy({ provider: 'fixture', accountScope: 'a', providerItemId: '0' });
    expect(copy).toBeDefined();
    target.importItemCopy(copy!, { vectorProvider: replacement, trustTier: 'S2', syncConnectorId: 'fixture' });
    expect(database(target).query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 1 });
    // Rollback includes both vector and digest.
    expect(() => db.transaction(() => {
      const embedding = encodeEmbedding([0, 0, 1], 3);
      db.query('UPDATE chunk_embeddings SET embedding = ? WHERE chunk_pk = 1').run(embedding);
      writeVectorDigest(db, 1, modelId, 1, embedding);
      throw new Error('rollback');
    })()).toThrow('rollback');
    expect((db.query('SELECT digest FROM chunk_vector_digest WHERE chunk_pk=1').get() as { digest: Uint8Array }).digest).toEqual(after);
    db.query('DELETE FROM chunk_embeddings WHERE item_pk = 1').run();
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 3 });
    db.query('DELETE FROM items WHERE item_pk = 2').run();
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 2 });
    db.query('DELETE FROM chunks WHERE item_pk = 3').run();
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 1 });
    db.query('DELETE FROM chunk_embeddings WHERE model_id = ?').run(modelId);
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 0 });
    await store.embedChunks({ provider: replacement });
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 2 });
  } finally { store.close(); target.close(); }
});

test('backfill resumes across reopen, bounds physical rows, and invalidates displaced model completion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vector-digest-backfill-'));
  let db = numericStore(join(dir, 'store.sqlite'));
  try {
    db.transaction(() => { for (let i = 1; i <= 20; i++) insert(db, i, [1, i / 20]); })();
    db.exec('DELETE FROM chunk_vector_digest; DELETE FROM chunk_vector_digest_meta');
    const first = backfillVectorDigests(db, modelId, 3);
    expect(first).toEqual({ cursorRowid: 3, completed: false, scanned: 3 });
    db.close(); db = new Database(join(dir, 'store.sqlite')); db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=OFF');
    expect(vectorDigestState(db, modelId)).toEqual({ cursorRowid: 3, completed: false });
    expect(backfillVectorDigests(db, modelId, 3).cursorRowid).toBe(6);
    // A maintained new write behind the cursor (rowid reuse) is already digested.
    db.transaction(() => insert(db, 2, [0, 1]))();
    finish(db);
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 20 });
    expect(backfillVectorDigests(db, modelId).scanned).toBe(0);
    db.transaction(() => insert(db, 1, [0, 1], 1, 'other'))();
    expect(vectorDigestState(db, modelId)).toEqual({ cursorRowid: 0, completed: false });
    finish(db, 'other');
    expect(vectorDigestState(db, 'other').completed).toBe(true);
    finish(db);
    expect(vectorDigestState(db, 'other').completed).toBe(false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('SQL eligibility excludes account, filter, tombstone and stale-hash rows before full vectors reach scoring; filtered rows never take a ranking slot', async () => {
  const db = numericStore();
  try {
    db.transaction(() => { for (let i = 1; i <= 1300; i++) insert(db, i, i <= 1200 ? [1, 0, 0] : [0.9, 0.1, 0]); })();
    finish(db);
    db.exec(`UPDATE items SET tombstoned = 1 WHERE item_pk <= 300;
      UPDATE chunks SET embedding_input_hash = 'stale' WHERE chunk_pk > 300 AND chunk_pk <= 600;
      UPDATE items SET provider = 'excluded' WHERE item_pk > 600 AND item_pk <= 900;
      UPDATE items SET account_scope = 'other' WHERE item_pk > 900 AND item_pk <= 1200;`);
    let exactReads = 0, fullRows = 0;
    const options = { modelId, accountScope: 'a', filters: { provider: 'fixture', locatorPathScope: '/allowed' } };
    const result = await scanDigestPages(reader(db, (q, rows) => {
      if (q.sql.includes('FROM json_each(?) pick')) {
        exactReads++;
        for (const row of rows as Array<{ item_pk: number }>) { fullRows++; expect(row.item_pk).toBeGreaterThan(1200); }
        expect(q.sql).toContain('FROM json_each(?) pick');
        expect(q.sql).toContain('i.account_scope = ?');
      }
    }), [1, 0, 0], options, undefined, 20);
    expect(rank(result)).toEqual(exact(db, [1, 0, 0], options));
    // The scope filters apply in the digest pass too, so rejected rows never
    // take a ranking slot: one re-score batch reaches the eligible tail.
    expect(exactReads).toBe(2); // one batch, read 256 named chunks a page
    expect(fullRows).toBe(100);
    // Sequential rowid range scan; no temp sort or secondary index.
    const page = connectorStoreVectorDigestPageQuery(options, 0);
    const plan = db.query(`EXPLAIN QUERY PLAN ${page.sql}`).all(...page.params) as Array<{ detail: string }>;
    expect(plan.some(x => /INTEGER PRIMARY KEY/.test(x.detail))).toBe(true);
    expect(plan.some(x => /TEMP B-TREE/.test(x.detail))).toBe(false);
    expect(await scanDigestPages(reader(db), [1, 0, 0], options, Date.now() - 1, 20)).toEqual({ skippedReason: 'vector_scan_deadline_exceeded' });
  } finally { db.close(); }
});

test('real lane uses exact fallback until backfill completes, then preserves winner chunks, item ties and visibility', async () => {
  const store = open();
  try {
    await store.syncFromConnector(connector(30), { fetchContent: true });
    await store.embedChunks({ provider });
    const db = database(store);
    db.exec('DELETE FROM chunk_vector_digest_meta');
    const before = await store.vectorSearchLane('harbor', provider, 20, 'a');
    await store.ensureVectorDigestReady(modelId, 100);
    expect(vectorDigestState(db, modelId).completed).toBe(true);
    const after = await store.vectorSearchLane('harbor', provider, 20, 'a');
    expect(after).toEqual(before);
    expect(after.rows).toHaveLength(20);
  } finally { store.close(); }
});


test('both passes keep a single read snapshot while another connection replaces vectors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vector-digest-snapshot-'));
  const path = join(dir, 'store.sqlite');
  const writer = numericStore(path);
  let db: Database | undefined;
  try {
    writer.transaction(() => { for (let i = 1; i <= 50; i++) insert(writer, i, [1, 0, 0]); })();
    finish(writer);
    db = new Database(path, { readonly: true });
    db.exec('BEGIN DEFERRED TRANSACTION');
    let changed = false;
    const result = await scanDigestPages(reader(db, (query) => {
      if (!changed && query.sql.includes('FROM chunk_vector_digest')) {
        changed = true;
        writer.transaction(() => { for (let i = 1; i <= 50; i++) insert(writer, i, [0, 1, 0]); })();
      }
    }), [1, 0, 0], { modelId }, undefined, 20);
    expect(changed).toBe(true);
    expect(rank(result)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    if ('bestByItem' in result) expect(result.bestByItem.get(1)?.bestCosine).toBe(1);
    db.exec('ROLLBACK');
    expect(rank(await scanDigestPages(reader(db), [1, 0, 0], { modelId }, undefined, 20))).toEqual([]);
  } finally { db?.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('v15 migration leaves vectors intact, creates an empty projection, and resumes bounded backfill after reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vector-digest-migration-'));
  const path = join(dir, 'store.sqlite');
  let store = open();
  try {
    await store.syncFromConnector(connector(8), { fetchContent: true });
    await store.embedChunks({ provider });
    const vectors = database(store).query('SELECT embedding FROM chunk_embeddings ORDER BY chunk_pk').all();
    // Materialize the synthetic fixture once rather than fsync each seed
    // transaction on the shared runner volume. Migration itself uses a file.
    const fixture = database(store).serialize();
    store.close();
    writeFileSync(path, fixture);
    const old = new Database(path);
    old.exec('PRAGMA synchronous=OFF; PRAGMA journal_mode=WAL');
    old.exec(`DROP TRIGGER connector_store_vector_digest_account; DROP TRIGGER connector_store_vector_digest_delete;
      DROP TABLE chunk_vector_digest; DROP TABLE chunk_vector_digest_meta;
      DROP TRIGGER connector_store_invalidate_label_observation;
      ALTER TABLE items DROP COLUMN classification_labels_json;
      UPDATE schema_version SET version = 15 WHERE store_id = 'connector-store';`);
    old.close();
    store = open(path);
    expect(database(store).query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 0 });
    expect(database(store).query('SELECT embedding FROM chunk_embeddings ORDER BY chunk_pk').all()).toEqual(vectors);
    expect(store.backfillVectorDigest(modelId, 2)).toMatchObject({ scanned: 2, completed: false });
    store.close(); store = open(path);
    expect(vectorDigestState(database(store), modelId).cursorRowid).toBe(2);
    await store.ensureVectorDigestReady(modelId, 20);
    expect(vectorDigestState(database(store), modelId).completed).toBe(true);
    expect(database(store).query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 8 });
    const queries: string[] = [];
    setReadPoolObserverForTests((_, query) => { queries.push(query.sql); }, { snapshots: true });
    try {
      expect((await store.vectorSearchLane('harbor', provider, 5, 'a')).rows).toHaveLength(5);
      expect(queries.some(sql => sql.includes('FROM chunk_vector_digest'))).toBe(true);
      expect(queries.some(sql => sql.includes('FROM json_each(?) pick'))).toBe(true);
    } finally { setReadPoolObserverForTests(); }
    // The eval API works on the same read-only connection used by its CLI.
    const readOnly = new Database(path, { readonly: true, create: false });
    try {
      readOnly.exec('PRAGMA query_only=ON');
      expect((await probeVectorDigest(readOnly, { modelId, queries: 2 })).queries).toBe(2);
    } finally { readOnly.close(); }

  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('every filter uses the shared SQL eligibility builder for restricted full-vector reads', async () => {
  const store = open();
  try {
    await store.syncFromConnector(connector(12), { fetchContent: true });
    await store.embedChunks({ provider });
    const db = database(store);
    db.exec(`UPDATE items SET sender_id='sender', sender_label='Person', provider_conversation_id='room',
      search_text='facet', source_scope_generation='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', source_scope_revision='00000000-0000-4000-8000-000000000001', source_scope_folder_keys_json='["folder"]'
      WHERE item_pk % 2 = 0;`);
    await store.ensureVectorDigestReady(modelId, 20);
    const cases: NonNullable<Parameters<typeof connectorStoreCurrentEmbeddingPageQuery>[0]['filters']>[] = [
      { provider: 'fixture' }, { provider: 'excluded' }, { observedConnectorId: 'fixture' }, { observedConnectorId: 'excluded' },
      { observedConnectorIdPrefix: 'fix' }, { observedConnectorId: 'excluded', observedConnectorIdPrefix: 'fix' },
      { locatorPathScope: '/allowed/2' }, { locatorPathScopes: ['/allowed/2', '/allowed/4'] }, { locatorPathExcludedScopes: ['/allowed/2'] },
      { conversationId: 'room' }, { senderId: 'sender' }, { senderLabel: 'Person' },
      { senderIdentities: [{ provider: 'fixture', senderId: 'sender' }] },
      { senderLabel: 'missing', senderIdentities: [{ provider: 'fixture', senderId: 'sender' }] },
      { authoredAfter: '2026-11-01T00:00:00Z' }, { authoredBefore: '2025-01-01T00:00:00Z' }, { searchTextExactLines: ['facet'] },
      { sourceScopeGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { sourceScopeRevision: '00000000-0000-4000-8000-000000000001' },
      { sourceScopeFolderAnyKeys: ['folder'] }, { sourceScopeFolderNoneKeys: ['folder'] },
    ];
    for (const filters of cases) {
      const options = { modelId, accountScope: 'a', filters };
      const allowed = exact(db, [1, 0, 0], options);
      const result = await scanDigestPages(reader(db, (query, rows) => {
        if (query.sql.includes('FROM json_each(?) pick')) {
          for (const row of rows as Array<{ item_pk: number }>) expect(allowed).toContain(row.item_pk);
        }
      }), [1, 0, 0], options, undefined, 20);
      expect(rank(result)).toEqual(allowed);
    }
    // The public lane converts metadata-only scopes into SQL exclusions.
    expect((await store.vectorSearchLane('harbor', provider, 20, 'a', { metadataOnlyLocatorPathScopes: ['/allowed'] })).rows).toEqual([]);
    const folderLane = await store.vectorSearchLane('harbor', provider, 20, 'a', { metadataOnlySourceScopeFolderKeys: ['folder'] });
    expect(folderLane.rows).toHaveLength(6);
  } finally { store.close(); }
});


test('automatic maintenance yields between bounded slices and completes without an operator call', async () => {
  const store = open();
  try {
    await store.syncFromConnector(connector(280), { fetchContent: true });
    await store.embedChunks({ provider });
    const db = database(store);
    // Simulate a migrated projection while the write-triggered maintenance
    // is queued. Completion must be reached by the actual background runner.
    db.exec('DELETE FROM chunk_vector_digest; DELETE FROM chunk_vector_digest_meta');
    let slices = 0;
    const advance = store.backfillVectorDigest.bind(store);
    store.backfillVectorDigest = (model, maxRows) => {
      const result = advance(model, maxRows);
      expect(result.scanned).toBeLessThanOrEqual(128);
      slices++;
      return result;
    };
    const during = store.status().embeddingByModel.find((row) => row.modelId === modelId)?.fastSearchReady;
    expect(during).toBeGreaterThanOrEqual(0);
    expect(during).toBeLessThan(1);
    await waitFor(() => vectorDigestState(db, modelId).completed);
    expect(slices).toBeGreaterThanOrEqual(3);
    expect(store.status().embeddingByModel.find((row) => row.modelId === modelId)?.fastSearchReady).toBe(1);
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 280 });
  } finally { store.close(); }
});

test('backfill turns shrink when slow, regrow when fast, and stand back while the owner asks', async () => {
  expect(nextVectorDigestBackfillRows(128, 60)).toBe(64);
  expect(nextVectorDigestBackfillRows(8, 60)).toBe(8);
  expect(nextVectorDigestBackfillRows(64, 2)).toBe(128);
  expect(nextVectorDigestBackfillRows(128, 2)).toBe(128);
  expect(nextVectorDigestBackfillRows(64, 15)).toBe(64);
  const store = open();
  try {
    await store.syncFromConnector(connector(200), { fetchContent: true });
    await store.embedChunks({ provider });
    const db = database(store);
    let ownerAsking = true;
    setVectorDigestBackfillHold(() => ownerAsking);
    db.exec('DELETE FROM chunk_vector_digest; DELETE FROM chunk_vector_digest_meta');
    let slices = 0;
    const advance = store.backfillVectorDigest.bind(store);
    store.backfillVectorDigest = (model, maxRows) => { slices++; return advance(model, maxRows); };
    const scheduler = store as unknown as { scheduleVectorDigestBackfill(model?: string, delayMs?: number): void };
    const schedule = scheduler.scheduleVectorDigestBackfill.bind(store);
    let backoffs = 0;
    scheduler.scheduleVectorDigestBackfill = (model, delayMs) => { if (delayMs === 250) backoffs++; schedule(model, delayMs); };
    scheduler.scheduleVectorDigestBackfill(modelId);
    await waitFor(() => backoffs >= 2);
    expect(slices).toBe(0);
    ownerAsking = false;
    await waitFor(() => vectorDigestState(db, modelId).completed);
    expect(slices).toBeGreaterThan(0);
  } finally { setVectorDigestBackfillHold(); store.close(); }
});

test('many winning chunks of one item cannot fill the item budget: the pass expands to distinct items', async () => {
  const db = numericStore();
  try {
    db.transaction(() => {
      // 900 chunks of one item outrank everything else, so the first K are all its own.
      for (let i = 1; i <= 900; i++) insert(db, i, [1, 0, 0], 5000);
      for (let i = 901; i <= 1400; i++) insert(db, i, [1, 0.2, 0]);
    })();
    finish(db);
    const result = await scanDigestPages(reader(db), [1, 0, 0], { modelId }, undefined, 20);
    if (!('bestByItem' in result)) throw new Error(result.skippedReason);
    expect(result.bestByItem.has(5000)).toBe(true);
    expect(rank(result).length).toBe(20);
  } finally { db.close(); }
});

test('when ledger visibility hides every first-pass candidate, the lane scans wider and still returns visible matches', async () => {
  const store = open();
  try {
    await store.syncFromConnector(connector(600), { fetchContent: true });
    await store.embedChunks({ provider });
    const db = database(store);
    expect(vectorDigestState(db, modelId).completed).toBe(true);
    const hidden = new Set((db.query('SELECT item_pk FROM items ORDER BY item_pk LIMIT 500').all() as Array<{ item_pk: number }>).map((row) => row.item_pk));
    const lane = store as unknown as { visibleVectorItemPks(pks: readonly number[]): Set<number> };
    lane.visibleVectorItemPks = (pks) => new Set(pks.filter((pk) => !hidden.has(pk)));
    const result = await store.vectorSearchLane('harbor note', provider, 2);
    expect(result.rows).toHaveLength(2);
  } finally { store.close(); }
});

test.each(['grant is revoked', 'source version changes'] as const)(
  'a names-only item is no longer a semantic winner when its %s after scoring', async (change) => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = open(':memory:', ledger);
    try {
      await store.syncFromConnector(connector(1), { fetchContent: true, sourceScopeObservation: () => ({
        accountGeneration: 'a'.repeat(64), scopeRevision: '00000000-0000-4000-8000-000000000001', folderKeys: ['names'],
      }) });
      ledger.recordRoutedPlacement({ provider: 'fixture', accountScope: 'a', providerItemId: '0' },
        classifyItemTiers({ signals: {}, text: 'harbor note 0' }), {
          copies: [{ corpusId: store.corpusId, trustDomain: 'internal', layers: 'both' }],
          embedHold: false,
        });
      await store.embedChunks({ provider });
      const db = database(store);
      if (change === 'source version changes') db.exec('UPDATE chunk_vector_digest_meta SET completed = 0');
      const filters = { metadataOnlySourceScopeFolderKeys: ['names'] };
      const search = () => store.vectorSearchLane('harbor note', provider, 1, 'a', filters);
      expect((await search()).rows).toEqual([]);
      store.grantOnDemandRead('a:0', '1');
      expect((await search()).rows.map(row => row.sourceItem.localItemId)).toEqual(['a:0']);

      const lane = store as unknown as { visibleVectorItemPks: LocalConnectorStore['visibleVectorItemPks'] };
      const visible = lane.visibleVectorItemPks.bind(store);
      const beforeValidation = spyOn(lane, 'visibleVectorItemPks').mockImplementationOnce((pks, ...scope) => {
        expect(pks).toHaveLength(1);
        if (change === 'grant is revoked') db.query('DELETE FROM on_demand_item_reads WHERE local_item_id = ?').run('a:0');
        else db.query('UPDATE items SET source_version = ? WHERE local_item_id = ?').run('2', 'a:0');
        return visible(pks, ...scope);
      });
      const result = await search();
      expect(beforeValidation).toHaveBeenCalled();
      expect(result.rows).toEqual([]);
    } finally { store.close(); ledger.close(); }
  },
);

test.each(['another item', 'updated text'] as const)(
  'a semantic winner keeps its rank without a locator when its chunk key is reused for %s', async (replacement) => {
    const store = open();
    try {
      await store.syncFromConnector(connector(2), { fetchContent: true });
      await store.embedChunks({ provider });
      const db = database(store);
      if (replacement === 'updated text') db.exec('UPDATE chunk_vector_digest_meta SET completed = 0');
      const [other, winner] = db.query(`SELECT i.local_item_id, c.item_pk, c.chunk_pk, c.bounded_text, c.content_hash
        FROM chunks c JOIN items i ON i.item_pk = c.item_pk ORDER BY c.chunk_pk`).all() as Array<{
        local_item_id: string; item_pk: number; chunk_pk: number; bounded_text: string; content_hash: string;
      }>;
      if (!other || !winner) throw new Error('Expected two indexed chunks');
      const search = () => store.vectorSearchLane('harbor note', provider, 2, 'a');
      const before = (await search()).rows;
      expect(before.map(row => row.sourceItem.localItemId)).toEqual([other.local_item_id, winner.local_item_id]);
      expect(before[1]?.chunk?.chunkId).toBe(String(winner.chunk_pk));

      const lane = store as unknown as { searchRowsByItemPks: LocalConnectorStore['searchRowsByItemPks'] };
      const hydrate = lane.searchRowsByItemPks.bind(store);
      const beforeHydration = spyOn(lane, 'searchRowsByItemPks').mockImplementationOnce((pks, ...scope) => {
        const moved = replacement === 'another item';
        const itemPk = moved ? other.item_pk : winner.item_pk;
        const text = moved ? winner.bounded_text : 'Updated harbor note';
        const hash = moved ? winner.content_hash : new Bun.CryptoHasher('sha256').update(text).digest('hex');
        db.transaction(() => {
          db.query('DELETE FROM chunks WHERE chunk_pk = ?').run(winner.chunk_pk);
          const inserted = db.query(`INSERT INTO chunks (item_pk, chunk_index, bounded_text, content_hash, indexed_at)
            VALUES (?, ?, ?, ?, '2026-11-02') RETURNING chunk_pk, item_pk`).get(itemPk, moved ? 1 : 0, text, hash);
          expect(inserted).toEqual({ chunk_pk: winner.chunk_pk, item_pk: itemPk });
        })();
        return hydrate(pks, ...scope);
      });
      const result = await search();
      expect(beforeHydration).toHaveBeenCalled();
      expect(result.rows.map(row => row.sourceItem.localItemId)).toEqual(before.map(row => row.sourceItem.localItemId));
      expect(result.rows[0]?.chunk).toEqual(before[0]?.chunk);
      expect(result.rows[1]?.chunk).toBeUndefined();
    } finally { store.close(); }
  },
);

function heldVectorStore(count: number, heldCount: number) {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = open(':memory:', ledger);
  const close = () => { store.close(); ledger.close(); };
  const decision = classifyItemTiers({ signals: {}, text: 'Ordinary harbor notes.' });
  const copies = [{ corpusId: store.corpusId, trustDomain: 'internal' as const, layers: 'both' as const }];
  const setHold = (id: number, embedHold: boolean) => ledger.recordRoutedPlacement(
    { provider: 'fixture', accountScope: 'a', providerItemId: String(id) }, decision, { copies, embedHold },
  );
  try {
    const db = database(store);
    // Seed the real store directly so no ingest or embedding pass warms its
    // visibility memo. Equal cosines make the ranked item order explicit.
    const sequence = 'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)';
    const embedding = encodeEmbedding([1, 0, 0], 3);
    db.transaction(() => {
      db.query(`INSERT INTO sync_runs (sync_run_id, corpus_id, connector_id, status, started_at)
        VALUES ('seed', ?, 'fixture', 'completed', '2026-11-01')`).run(store.corpusId);
      db.query(`${sequence} INSERT INTO items (item_pk, provider, family, account_scope, provider_item_id,
        local_item_id, title, mime_type, fetched_at, indexed_at, trust_tier, sync_run_id)
        SELECT n, 'fixture', 'file', 'a', n - 1, 'a:' || (n - 1), 'Note ' || n,
          'text/plain', '2026-11-01', '2026-11-01', 'S3', 'seed' FROM seq`).run(count);
      db.query(`${sequence} INSERT INTO chunks (chunk_pk, item_pk, chunk_index, bounded_text, content_hash, embedding_input_hash, indexed_at)
        SELECT n, n, 0, 'Harbor note ' || n, 'hash', 'hash', '2026-11-01' FROM seq`).run(count);
      db.query(`${sequence} INSERT INTO chunk_embeddings (chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at)
        SELECT n, ?, n, 'hash', ?, '2026-11-01' FROM seq`).run(count, modelId, embedding);
    })();
    finish(db);
    const ledgerDb = (ledger as unknown as { db: Database }).db;
    ledgerDb.transaction(() => { for (let id = 0; id < count; id++) setHold(id, id < heldCount); })();
    const lane = store as unknown as {
      vectorScanExcludedItemPks: LocalConnectorStore['vectorScanExcludedItemPks'];
      visibleVectorItemPks: LocalConnectorStore['visibleVectorItemPks'];
      searchRowsByItemPks: LocalConnectorStore['searchRowsByItemPks'];
      chunkMatchForChunkPk: LocalConnectorStore['chunkMatchForChunkPk'];
    };
    const scanExclusions = lane.vectorScanExcludedItemPks.bind(store);
    lane.vectorScanExcludedItemPks = () => {
      const exclusions = scanExclusions();
      expect(exclusions).toBeUndefined();
      return exclusions;
    };
    return { store, lane, setHold, close };
  } catch (error) {
    close();
    throw error;
  }
}

test('cold vector visibility over 5,000 items and 90% held yields without changing rows or order', async () => {
  const { store, lane, close } = heldVectorStore(5_000, 4_500);
  const visible = lane.visibleVectorItemPks.bind(store);
  const limit = 20;
  const realNow = performance.now.bind(performance);
  let elapsed = 0;
  let turnStarted: number | undefined;
  const stretches: number[] = [];
  const batches: number[] = [];
  // Advance the slice clock deterministically even on a fast runner. Use the
  // actual clock to measure each synchronous stretch into its next microtask.
  const clock = spyOn(performance, 'now').mockImplementation(() => realNow() + elapsed);
  lane.visibleVectorItemPks = (pks, ...scope) => {
    if (turnStarted === undefined) {
      const started = turnStarted = realNow();
      queueMicrotask(() => { stretches.push(realNow() - started); turnStarted = undefined; });
    }
    const eligible = visible(pks, ...scope);
    batches.push(pks.length);
    elapsed += 20;
    return eligible;
  };
  try {
    const result = await store.vectorSearchLane('harbor note', provider, limit, 'a');
    expect(result.skippedReason).toBeUndefined();
    expect(result.rows.map(row => row.sourceItem.providerItemId)).toEqual(
      Array.from({ length: limit }, (_, i) => String(4_500 + i)),
    );
    expect(batches).toEqual([...Array<number>(23).fill(200), limit]);
    expect(stretches.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...stretches)).toBeLessThan(200);

    // Every cosine is 1 in this fixture. The unsliced reference can check
    // every candidate in PK order at once and then take the first visible K.
    const ordered = database(store).query('SELECT item_pk, chunk_pk, content_hash FROM chunks ORDER BY item_pk').all() as Array<{
      item_pk: number; chunk_pk: number; content_hash: string;
    }>;
    const allowed = visible(ordered.map(row => row.item_pk), 'a');
    const winners = ordered.filter(row => allowed.has(row.item_pk)).slice(0, limit);
    const searchRows = lane.searchRowsByItemPks(winners.map(row => row.item_pk), 'a');
    const unsliced = winners.map(({ item_pk, chunk_pk, content_hash }) => ({
      ...searchRows.get(item_pk)!, chunk: lane.chunkMatchForChunkPk(chunk_pk, item_pk, content_hash)!, bestCosine: 1,
    }));
    expect(result.rows).toEqual(unsliced);
  } finally { clock.mockRestore(); close(); }
});

test('a hold during a vector visibility yield drops provisional winners and refills in rank order', async () => {
  const { store, lane, setHold, close } = heldVectorStore(400, 197);
  const visible = lane.visibleVectorItemPks.bind(store);
  const realNow = performance.now.bind(performance);
  let elapsed = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => realNow() + elapsed);
  let holdDuringYield: Promise<void> | undefined;
  const batches: number[] = [];
  lane.visibleVectorItemPks = (pks, ...scope) => {
    batches.push(pks.length);
    const eligible = visible(pks, ...scope);
    if (batches.length === 1) {
      // The first batch has three visible items. Hold its two provisional
      // winners so the refill must use its spare and read the next batch.
      holdDuringYield = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
        setHold(197, true);
        setHold(198, true);
      });
      elapsed += 51;
    }
    return eligible;
  };
  try {
    const result = await store.vectorSearchLane('harbor note', provider, 2, 'a');
    expect(result.rows.map(row => row.sourceItem.providerItemId)).toEqual(['199', '200']);
    expect(batches).toEqual([200, 2, 200, 2]);
  } finally { await holdDuringYield; clock.mockRestore(); close(); }
});

test('a file store backfills on the read pool: the worker thread only writes digests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vector-digest-pool-'));
  const store = open(join(dir, 'store.sqlite'));
  try {
    await store.syncFromConnector(connector(300), { fetchContent: true });
    await store.embedChunks({ provider });
    const db = database(store);
    db.exec('DELETE FROM chunk_vector_digest; DELETE FROM chunk_vector_digest_meta');
    let inThread = 0;
    const advance = store.backfillVectorDigest.bind(store);
    store.backfillVectorDigest = (model, maxRows) => { inThread++; return advance(model, maxRows); };
    (store as unknown as { scheduleVectorDigestBackfill(model?: string): void }).scheduleVectorDigestBackfill(modelId);
    await waitFor(() => vectorDigestState(db, modelId).completed);
    expect(inThread).toBe(0);
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 300 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('with OLYMPUS_VECTOR_DIGEST=off, a store with a complete digest runs the exact scan', async () => {
  const store = open();
  const saved = process.env.OLYMPUS_VECTOR_DIGEST;
  const queries: string[] = [];
  try {
    await store.syncFromConnector(connector(30), { fetchContent: true });
    await store.embedChunks({ provider });
    expect(vectorDigestState(database(store), modelId).completed).toBe(true);
    const withDigest = await store.vectorSearchLane('harbor', provider, 10, 'a');
    process.env.OLYMPUS_VECTOR_DIGEST = 'off';
    const db = database(store);
    const query = db.query.bind(db);
    db.query = ((sql: string) => { queries.push(sql); return query(sql); }) as typeof db.query;
    const exact = await store.vectorSearchLane('harbor', provider, 10, 'a');
    // The scheduled backfill's own state probe (chunk_vector_digest_meta) can land in this window; the scan reading the digest is what must not happen.
    expect(queries.filter(sql => sql.includes('chunk_vector_digest') && !sql.includes('chunk_vector_digest_meta'))).toEqual([]);
    expect(exact).toEqual(withDigest);
  } finally {
    if (saved === undefined) delete process.env.OLYMPUS_VECTOR_DIGEST; else process.env.OLYMPUS_VECTOR_DIGEST = saved;
    store.close();
  }
});

// A backfill that stands back for anything but the owner, or without a
// bound, never finishes on a busy install, and its store stays on the slow
// exact scan (plan thread, 15 Nov). It stands back by the engine's one rule.
test('a background lease held and the owner asking every 10 s never keeps a file store backfill waiting past the bound', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vector-digest-stand-back-'));
  const store = open(join(dir, 'store.sqlite'));
  let releaseLease!: () => void;
  const lease = withStoreReadPriority(() => new Promise<void>(resolve => { releaseLease = resolve; }));
  // A scaled clock: one real millisecond is 100 of the owner's, so the
  // 60 s bound is 600 ms here, and the owner asks 4 s of every 10 s.
  const started = Date.now();
  const at = () => (Date.now() - started) * 100;
  const owner = { get busy() { return at() % 10_000 < 4_000 || at() < 400_000; } };
  const lines: string[] = [];
  const standBack = createStandBack({ reason: () => ownerAskReason(owner, () => false), now: at, log: line => lines.push(line) });
  setVectorDigestBackfillHold(() => standBack.holds('digest'));
  try {
    await store.syncFromConnector(connector(40), { fetchContent: true });
    await store.embedChunks({ provider });
    const db = database(store);
    db.exec('DELETE FROM chunk_vector_digest; DELETE FROM chunk_vector_digest_meta');
    expect(storeReadHasPriority()).toBe(true);
    (store as unknown as { scheduleVectorDigestBackfill(model?: string, delayMs?: number): void }).scheduleVectorDigestBackfill(modelId);
    // The owner is busy for the first 400 s; the backfill still finishes, on its share.
    await waitFor(() => vectorDigestState(db, modelId).completed, { description: 'the backfill finished' });
    expect(at()).toBeLessThan(400_000);
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 40 });
    const counts = standBack.counts().digest!;
    expect(counts.holds).toBeGreaterThan(0);
    expect(counts.bound_reached).toBeGreaterThan(0);
    expect(lines.some(line => line.includes('digest stands back'))).toBe(true);
  } finally {
    setVectorDigestBackfillHold();
    releaseLease?.();
    await lease;
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('a locked digest write on the pool path retries instead of stalling the backfill (#1469)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vector-digest-pool-lock-'));
  const path = join(dir, 'store.sqlite');
  const store = open(path);
  const writer = new Database(path);
  try {
    await store.syncFromConnector(connector(50), { fetchContent: true });
    await store.embedChunks({ provider });
    const db = database(store);
    db.exec('DELETE FROM chunk_vector_digest; DELETE FROM chunk_vector_digest_meta');
    const scheduler = store as unknown as { scheduleVectorDigestBackfill(model?: string, delayMs?: number): void };
    const schedule = scheduler.scheduleVectorDigestBackfill.bind(store);
    let backoffs = 0;
    scheduler.scheduleVectorDigestBackfill = (model, delayMs) => { if (delayMs === 250) backoffs++; schedule(model, delayMs); };
    writer.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
    scheduler.scheduleVectorDigestBackfill(modelId);
    await waitFor(() => backoffs >= 1);
    writer.exec('ROLLBACK');
    await waitFor(() => vectorDigestState(db, modelId).completed);
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 50 });
  } finally { writer.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a window read before a vector was replaced, or before the cursor moved, never lands a stale digest', () => {
  const db = numericStore();
  try {
    db.transaction(() => { for (let i = 1; i <= 4; i++) insert(db, i, [1, 0, 0]); })();
    db.exec('DELETE FROM chunk_vector_digest; DELETE FROM chunk_vector_digest_meta');
    const query = vectorDigestSourceQuery(0, 128);
    const stale = db.query(query.sql).all(...query.params) as VectorDigestSourceRow[];
    // Chunk 2 is re-embedded after the read; its own write keeps its digest current.
    db.transaction(() => {
      const embedding = encodeEmbedding([0, 1, 0], 3);
      db.query('UPDATE chunk_embeddings SET embedding = ?, embedded_at = ? WHERE chunk_pk = 2').run(embedding, 'later');
      writeVectorDigest(db, 2, modelId, 2, embedding);
    })();
    const fresh = (db.query('SELECT digest FROM chunk_vector_digest WHERE chunk_pk = 2').get() as { digest: Uint8Array }).digest;
    expect(applyVectorDigestWindow(db, modelId, 1, stale, 128).scanned).toBe(0);
    expect(applyVectorDigestWindow(db, modelId, 0, stale, 128)).toEqual({ cursorRowid: 4, completed: true, scanned: 4 });
    const after = (db.query('SELECT digest FROM chunk_vector_digest WHERE chunk_pk = 2').get() as { digest: Uint8Array }).digest;
    expect([...after]).toEqual([...fresh]);
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 4 });
  } finally { db.close(); }
});

test('a competing writer rolls back the backfill slice and restores the normal lock timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vector-digest-lock-'));
  const path = join(dir, 'store.sqlite');
  const db = numericStore(path);
  const writer = new Database(path);
  try {
    db.transaction(() => insert(db, 1, [1, 0, 0]))();
    db.exec('DELETE FROM chunk_vector_digest_meta; PRAGMA busy_timeout=10000');
    writer.exec('PRAGMA synchronous=OFF; BEGIN IMMEDIATE; UPDATE items SET tombstoned=1');
    expect(() => backfillVectorDigests(db, modelId)).toThrow(/locked|busy/i);
    expect(vectorDigestState(db, modelId)).toEqual({ cursorRowid: 0, completed: false });
    expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 10000 });
    writer.exec('ROLLBACK');
    expect(backfillVectorDigests(db, modelId).completed).toBe(true);
  } finally {
    try { writer.exec('ROLLBACK'); } catch { /* already rolled back */ }
    writer.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('seeded clustered 768-dimensional store: top 20 items equal exact for >=99% of 200 random queries', async () => {
  const db = numericStore();
  const random = seededVectorRandom(1444);
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
  const centers = Array.from({ length: 40 }, () => Array.from({ length: 768 }, normal));
  const vectors: number[][] = [];
  try {
    // 8,000 vectors, 4,000 items, two correlated passages/item, 40 semantic
    // clusters. Independent noise in all dimensions; no duplicated vectors.
    db.transaction(() => {
      for (let i = 0; i < 8000; i++) {
        const center = centers[Math.floor(i / 200)]!;
        const vector = center.map(x => x + 0.18 * normal());
        vectors.push(vector);
        insert(db, i + 1, vector, Math.floor(i / 2) + 1);
      }
    })();
    finish(db);
    let identical = 0, overlap = 0;
    for (let i = 0; i < 200; i++) {
      const query = vectors[Math.floor(random() * vectors.length)]!.map(x => x + 0.1 * normal());
      const expected = exact(db, query, { modelId });
      const got = rank(await scanDigestPages(reader(db), query, { modelId }, undefined, 20));
      identical += Number(JSON.stringify(got) === JSON.stringify(expected));
      overlap += expected.filter(pk => got.includes(pk)).length;
    }
    console.log(JSON.stringify({ recallQueries: 200, identicalTop20: identical, top20OverlapCount: overlap, expectedOverlapCount: 4000 }));
    expect(identical).toBeGreaterThanOrEqual(198);
    const report = await probeVectorDigest(db, { modelId, queries: 2 });
    expect(report.queries).toBe(2);
    expect(report.identicalTop20Queries).toBe(2);
    expect(JSON.stringify(report)).not.toContain('digest-fixture');
  } finally { db.close(); }
}, 120_000);

test('a digest page crosses as one packed blob that unpacks byte for byte, NULs and high bytes included (olympus-ops#151)', () => {
  const db = new Database(':memory:');
  try {
    db.run('CREATE TABLE chunk_vector_digest (chunk_pk INTEGER PRIMARY KEY, model_id TEXT, item_pk INTEGER, account_scope TEXT, digest BLOB)');
    const expected = new Map<number, Uint8Array>();
    for (let pk = 1; pk <= 10; pk++) {
      const digest = new Uint8Array(pk === 7 ? 8 : 260).map((_, i) => (pk * 31 + i * 7) % 256);
      digest[0] = 0; digest[digest.length - 1] = 0;
      expected.set(pk, digest);
      db.query('INSERT INTO chunk_vector_digest VALUES (?, ?, 1, ?, ?)').run(pk, 'm', 'a', digest);
    }
    const page = connectorStoreVectorDigestPageQuery({ modelId: 'm' }, 2, 6);
    const packed = db.query(page.sql).get(...page.params) as VectorDigestPackedPage;
    expect(packed.packed).toBeInstanceOf(Uint8Array);
    expect([packed.n, packed.last_pk]).toEqual([6, 8]);
    const seen: number[] = [];
    expect(forEachPackedVectorDigest(packed, (pk, digest) => {
      seen.push(pk);
      expect([...digest]).toEqual([...expected.get(pk)!]);
      return true;
    })).toBe(true);
    expect(seen).toEqual([3, 4, 5, 6, 7, 8]);
    const empty = connectorStoreVectorDigestPageQuery({ modelId: 'm' }, 10);
    const none = db.query(empty.sql).get(...empty.params) as VectorDigestPackedPage;
    expect(none.n).toBe(0);
    expect(forEachPackedVectorDigest(none, () => { throw new Error('no rows to visit'); })).toBe(true);
  } finally { db.close(); }
});

test('re-scoring stops by score, not count: an item the 256-dimension digest ranks below a full batch is still found (#1529)', async () => {
  const db = numericStore();
  const dims = 300;
  const vector = (entries: Array<[number, number]>) => { const v = new Array(dims).fill(0); for (const [i, x] of entries) v[i] = x; return v; };
  try {
    db.transaction(() => {
      // 1,000 chunks the digest scores 1.0 (their prefix is the query's) but whose exact cosine is about 0.88.
      for (let i = 1; i <= 1000; i++) insert(db, i, vector([[0, 1], [299, 0.3]]));
      // The exact winner: its digest score (about 0.95) puts it behind all 1,000.
      insert(db, 1001, vector([[0, 0.95], [1, 0.31], [299, 1]]));
      // Chunks the digest scores near 0: once they are next, re-scoring stops.
      for (let i = 1002; i <= 4000; i++) insert(db, i, vector([[2, 1]]));
    })();
    finish(db);
    const query = vector([[0, 1], [299, 1]]);
    const options = { modelId };
    let rescored = 0;
    const result = await scanDigestPages(reader(db, (q, rows) => {
      if (q.sql.includes('FROM json_each(?) pick')) rescored += (rows as unknown[]).length;
    }), query, options, undefined, 5);
    expect(rank(result, 5)).toEqual(exact(db, query, options, 5));
    expect(rank(result, 5)[0]).toBe(1001);
    if ('skippedReason' in result) throw new Error(result.skippedReason);
    expect(result.exhausted).toBe(false);
    expect(rescored).toBeLessThanOrEqual(1200);
  } finally { db.close(); }
});

test('a store with fewer related items than the limit is not read back whole: re-scoring stops at the score floor', async () => {
  const db = numericStore();
  try {
    db.transaction(() => {
      insert(db, 1, [1, 0, 0]);
      insert(db, 2, [0.9, 0.1, 0]);
      // Unrelated to the question: exact cosine 0, far under the lane's floor.
      for (let i = 3; i <= 6000; i++) insert(db, i, [0, 1, 0]);
    })();
    finish(db);
    let rescored = 0;
    const result = await scanDigestPages(reader(db, (q, rows) => {
      if (q.sql.includes('FROM json_each(?) pick')) rescored += (rows as unknown[]).length;
    }), [1, 0, 0], { modelId }, undefined, 5);
    expect(rank(result, 2)).toEqual([1, 2]);
    expect(rescored).toBeLessThanOrEqual(400);
  } finally { db.close(); }
});

test('the candidate cap never cuts a pass short of the limit: rejected top candidates drain to the eligible tail in one pass', async () => {
  const db = numericStore();
  try {
    db.transaction(() => {
      // 21,000 top digest candidates SQL rejects (tombstoned), above five eligible chunks.
      for (let i = 1; i <= 21_000; i++) insert(db, i, [1, 0, 0]);
      for (let i = 21_001; i <= 21_005; i++) insert(db, i, [0.6, 0.8, 0]);
      db.exec('UPDATE items SET tombstoned = 1 WHERE item_pk <= 21000');
    })();
    finish(db);
    const result = await scanDigestPages(reader(db), [1, 0, 0], { modelId }, undefined, 5);
    expect(rank(result, 5)).toEqual([21_001, 21_002, 21_003, 21_004, 21_005]);
    if ('skippedReason' in result) throw new Error(result.skippedReason);
    expect(result.exhausted).toBe(true);
  } finally { db.close(); }
});

// ASK SPEED (olympus-ops#151, 14 Nov): on Jamie's box the Dropbox vector
// lane ran out its 54 s deadline on every Ask. The scan ranked items the
// store would not serve, the ledger check then dropped them, and the scan
// re-ran 8x wider until enough survived, reading the whole store. These
// count the scan's reads, so a fast machine cannot hide the extra passes.
describe('the vector lane ranks only what it can serve, in one pass', () => {
  const count = 2_000;
  // Item i's vector leans away from the query as i grows: the first items rank highest.
  const graded: SourceEmbeddingProvider = { ...provider, async embed(inputs) {
    return inputs.map((input) => {
      const n = Number(/(\d+)\s*$/.exec(input.text)?.[1] ?? 0);
      const lean = n / count;
      return [1 - lean * 0.5, lean, 0];
    });
  } };
  async function seeded(): Promise<{ store: LocalConnectorStore; dir: string; pks: number[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'vector-digest-workcount-'));
    const store = open(join(dir, 'store.sqlite'));
    await store.syncFromConnector(connector(count), { fetchContent: true });
    await store.embedChunks({ provider: graded });
    await store.ensureVectorDigestReady(modelId, 4_096);
    const pks = (database(store).query('SELECT item_pk FROM items ORDER BY CAST(provider_item_id AS INTEGER)').all() as Array<{ item_pk: number }>).map((row) => row.item_pk);
    return { store, dir, pks };
  }
  function counted() {
    const reads = { digestPages: 0, rescoreStatements: 0 };
    setReadPoolObserverForTests((_, query) => {
      if (query.sql.includes('FROM chunk_vector_digest d')) reads.digestPages += 1;
      if (query.sql.includes('FROM json_each(?) pick')) reads.rescoreStatements += 1;
    }, { snapshots: true });
    return reads;
  }

  test('90% of the best-ranked items held for judging: one digest read, one re-score batch, a full visible result', async () => {
    const { store, dir, pks } = await seeded();
    try {
      // The store's own visibility set and the live ledger agree: the top 90% are held.
      const held = new Set(pks.slice(0, count * 0.9));
      const lane = store as unknown as {
        tierLedgerHiddenItemPks(): { hidden: number[]; held: number[]; heldForJudgment: number[]; metadataLayer: number[]; metadataLayerContentUnread: number[]; moving: number };
        visibleVectorItemPks(pks: readonly number[]): Set<number>;
      };
      const value = { hidden: [], held: [...held], heldForJudgment: [...held], metadataLayer: [], metadataLayerContentUnread: [], moving: 0 };
      lane.tierLedgerHiddenItemPks = () => value;
      lane.visibleVectorItemPks = (candidates) => new Set(candidates.filter((pk) => !held.has(pk)));
      const reads = counted();
      try {
        const result = await store.vectorSearchLane('harbor note', graded, 20);
        expect(result.skippedReason).toBeUndefined();
        expect(result.rows).toHaveLength(20);
        expect(reads.digestPages).toBe(1);
        expect(reads.rescoreStatements).toBeLessThanOrEqual(2);
      } finally { setReadPoolObserverForTests(); }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('90% of the best-ranked items outside the search scope: one digest read, one re-score batch', async () => {
    const { store, dir, pks } = await seeded();
    try {
      database(store).query(`UPDATE items SET provider = 'out_of_scope' WHERE item_pk IN (SELECT value FROM json_each(?))`)
        .run(JSON.stringify(pks.slice(0, count * 0.9)));
      const reads = counted();
      try {
        const result = await store.vectorSearchLane('harbor note', graded, 20, undefined, { provider: 'fixture' });
        expect(result.rows).toHaveLength(20);
        expect(reads.digestPages).toBe(1);
        expect(reads.rescoreStatements).toBeLessThanOrEqual(2);
      } finally { setReadPoolObserverForTests(); }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  // ASK SPEED (ops#151, 15 Nov): with his approved Dropbox folder scope in
  // place the re-score page was planned from the items index (every item of
  // the account), about 2 s a page, and the lane hit its 54 s deadline. Every
  // speed number before this was taken without the scope.
  test('under a folder scope shaped like the owner\'s, the re-score seeks its named chunks, and nothing out of scope or names-only comes back', async () => {
    const { store, dir, pks } = await seeded();
    try {
      const db = database(store);
      // 100 folders: 0-79 approved (70-79 names only), 80-99 excluded.
      const generation = 'b'.repeat(64);
      const revision = '00000000-0000-4000-8000-000000000002';
      db.query(`UPDATE items SET source_scope_generation = ?, source_scope_revision = ?,
        source_scope_folder_keys_json = json_array('f' || ((CAST(provider_item_id AS INTEGER)) % 100))`).run(generation, revision);
      await store.ensureVectorDigestReady(modelId, 4_096);
      const folderOf = new Map(pks.map((pk, i) => [pk, i % 100]));
      const keys = (from: number, to: number) => Array.from({ length: to - from }, (_, at) => `f${from + at}`);
      const filters = {
        provider: 'fixture', sourceScopeGeneration: generation, sourceScopeRevision: revision,
        sourceScopeFolderAnyKeys: keys(0, 80), sourceScopeFolderNoneKeys: keys(80, 100),
        metadataOnlySourceScopeFolderKeys: keys(70, 80),
      };
      const rescores: StoreRead[] = [];
      setReadPoolObserverForTests((_, query) => { if (query.sql.includes('FROM json_each(?) pick')) rescores.push(query); }, { snapshots: true });
      let result: Awaited<ReturnType<typeof store.vectorSearchLane>>;
      try { result = await store.vectorSearchLane('harbor note', graded, 24, 'a', filters); } finally { setReadPoolObserverForTests(); }
      expect(result.skippedReason).toBeUndefined();
      expect(result.rows).toHaveLength(24);
      const itemPkOf = new Map((db.query('SELECT item_pk, local_item_id FROM items').all() as Array<{ item_pk: number; local_item_id: string }>)
        .map((row) => [row.local_item_id, row.item_pk]));
      for (const row of result.rows) expect(folderOf.get(itemPkOf.get(row.sourceItem.localItemId)!)!).toBeLessThan(70);
      // The best-ranked items sit in every folder, so a leak would show at once.
      expect(result.rows.map((row) => itemPkOf.get(row.sourceItem.localItemId))).toEqual(pks.filter((_, i) => i % 100 < 70).slice(0, 24));
      expect(rescores.length).toBeGreaterThan(0);
      // A batch of more than one page is read side by side: the scan's worker and the re-score's.
      expect(readPoolDiagnostics().threads).toBeGreaterThanOrEqual(1 + READ_POOL_RESCORE_READERS);
      for (const read of rescores) {
        const plan = (db.query(`EXPLAIN QUERY PLAN ${read.sql}`).all(...(read.params as Array<string | number | null>)) as Array<{ detail: string; parent: number }>)
          .filter((row) => row.parent === 0).map((row) => row.detail);
        expect(plan[0]).toMatch(/^SCAN pick/);
        expect(plan[1]).toMatch(/^SEARCH emb USING (PRIMARY KEY|INDEX sqlite_autoindex_chunk_embeddings_1) \(chunk_pk=\? AND model_id=\?\)/);
        expect(plan.some((detail) => /^(SCAN|SEARCH) i USING (COVERING )?INDEX/.test(detail) && !/item_pk=\?/.test(detail))).toBe(false);
      }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('a scan cut after ranking began keeps the winners it found, and names the cut', async () => {
    const db = numericStore();
    try {
      db.transaction(() => { for (let i = 1; i <= 3_000; i++) insert(db, i, [1, i / 3_000, 0]); })();
      finish(db);
      const deadlineAtMs = Date.now() + 3_000;
      let rescored = 0;
      const result = await scanDigestPages(reader(db, (query) => {
        if (!query.sql.includes('FROM json_each(?) pick')) return;
        // The first re-score page is folded, then the clock runs out on the next.
        if (++rescored === 2) { const until = deadlineAtMs + 1; while (Date.now() < until) { /* past the deadline */ } }
      }), [1, 0, 0], { modelId }, deadlineAtMs, 20);
      if ('skippedReason' in result) throw new Error(`cut dropped its winners: ${result.skippedReason}`);
      expect(result.cutReason).toBe('vector_scan_deadline_exceeded');
      expect(result.bestByItem.size).toBeGreaterThan(0);
    } finally { db.close(); }
  }, 120_000);
});
