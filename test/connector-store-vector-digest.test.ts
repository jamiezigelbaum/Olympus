import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { LocalConnectorStore, nextVectorDigestBackfillRows, connectorStoreCurrentEmbeddingPageQuery, connectorStoreCurrentEmbeddingRowsIterator, connectorStoreVectorDigestPageQuery, scanDigestPages } from '../src/workers/connector-store/local-index.ts';
import { applyVectorDigestWindow, backfillVectorDigests, createVectorDigestSchema, vectorDigestSourceQuery, vectorDigestState, writeVectorDigest, type VectorDigestSourceRow } from '../src/workers/connector-store/vector-digest.ts';
import { cosineSimilarity, decodeEmbedding, encodeEmbedding, type SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { encodeVectorDigest, scoreVectorDigest } from '../src/workers/source-index/vector-digest.ts';
import type { StoreRead } from '../src/workers/connector-store/off-thread-reads.ts';
import { waitFor } from './helpers/test-clock.ts';
import { setReadPoolObserverForTests, setReadPoolWaitingWorkForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { probeVectorDigest, seededVectorRandom } from '../eval/vector-digest-probe.ts';

const modelId = 'digest-fixture';
const provider: SourceEmbeddingProvider = { provider: 'built-in', backend: 'local', modelId, dimension: 3, configHash: '1', epochId: '1', async embed(inputs) { return inputs.map(() => [1, 0, 0]); } };
const open = (dbPath = ':memory:') => new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.digest', family: 'file', trustDomain: 'internal', tierLedger: null });
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
    CREATE TABLE chunks(chunk_pk INTEGER PRIMARY KEY, item_pk INTEGER REFERENCES items(item_pk) ON DELETE CASCADE, embedding_input_hash TEXT);
    CREATE TABLE chunk_embeddings(chunk_pk INTEGER REFERENCES chunks(chunk_pk) ON DELETE CASCADE, model_id TEXT, item_pk INTEGER, content_hash TEXT, embedding BLOB, embedded_at TEXT, PRIMARY KEY(chunk_pk, model_id));
    CREATE INDEX embeddings_model ON chunk_embeddings(model_id);`);
  createVectorDigestSchema(db);
  return db;
}
function insert(db: Database, chunkPk: number, vector: number[], itemPk = chunkPk, model = modelId): void {
  db.query('INSERT OR IGNORE INTO items VALUES (?, ?, ?, 0, ?, ?)').run(itemPk, String(itemPk), 'a', 'fixture', '/allowed/item');
  db.query('INSERT OR IGNORE INTO chunks VALUES (?, ?, ?)').run(chunkPk, itemPk, 'hash');
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

test('SQL eligibility excludes account, filter, tombstone and stale-hash rows before full vectors reach scoring; expands past rejected top K', async () => {
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
      if (q.sql.includes('FROM chunk_embeddings emb')) {
        exactReads++;
        for (const row of rows as Array<{ item_pk: number }>) { fullRows++; expect(row.item_pk).toBeGreaterThan(1200); }
        expect(q.sql).toContain('emb.chunk_pk IN');
        expect(q.sql).toContain('i.account_scope = ?');
      }
    }), [1, 0, 0], options, undefined, 20);
    expect(rank(result)).toEqual(exact(db, [1, 0, 0], options));
    expect(exactReads).toBeGreaterThanOrEqual(3);
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
      expect(queries.some(sql => sql.includes('emb.chunk_pk IN'))).toBe(true);
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
        if (query.sql.includes('FROM chunk_embeddings emb')) {
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

test('backfill turns shrink when slow, regrow when fast, and stand back while an Ask reads the store', async () => {
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
    const lanes = store as unknown as { vectorLanesInFlight: number };
    lanes.vectorLanesInFlight = 1;
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
    lanes.vectorLanesInFlight = 0;
    await waitFor(() => vectorDigestState(db, modelId).completed);
    expect(slices).toBeGreaterThan(0);
  } finally { store.close(); }
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

test('a file store backfill stands back while owner-visible reads wait for the pool (#1487)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vector-digest-pool-wait-'));
  const store = open(join(dir, 'store.sqlite'));
  let waiting = true;
  setReadPoolWaitingWorkForTests(() => waiting);
  try {
    await store.syncFromConnector(connector(40), { fetchContent: true });
    await store.embedChunks({ provider });
    const db = database(store);
    db.exec('DELETE FROM chunk_vector_digest; DELETE FROM chunk_vector_digest_meta');
    const scheduler = store as unknown as { scheduleVectorDigestBackfill(model?: string, delayMs?: number): void };
    const schedule = scheduler.scheduleVectorDigestBackfill.bind(store);
    let backoffs = 0;
    scheduler.scheduleVectorDigestBackfill = (model, delayMs) => { if (delayMs === 250) backoffs++; schedule(model, delayMs); };
    scheduler.scheduleVectorDigestBackfill(modelId);
    await waitFor(() => backoffs >= 2);
    expect(vectorDigestState(db, modelId).cursorRowid).toBe(0);
    waiting = false;
    await waitFor(() => vectorDigestState(db, modelId).completed);
    expect(db.query('SELECT COUNT(*) AS n FROM chunk_vector_digest').get()).toEqual({ n: 40 });
  } finally { setReadPoolWaitingWorkForTests(); store.close(); rmSync(dir, { recursive: true, force: true }); }
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
