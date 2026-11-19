import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { hashString, LocalConnectorStore, type ConnectorStoreScoredSearchRow } from '../src/workers/connector-store/local-index.ts';
import { startMainThreadSqlSiteCount } from '../src/workers/connector-store/main-thread-sql-trace.ts';
import { setReadPoolObserverForTests, shutdownReadPool, type StoreRead } from '../src/workers/connector-store/off-thread-reads.ts';
import { encodeEmbedding, type SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { ACCOUNT, identityOf, JUDGED_PERSONAL_SNIFFER, tempDir } from './helpers/tier-fixtures.ts';

interface Probe {
  db: Database;
  readHere: LocalConnectorStore['readHere'];
  readOffThread: LocalConnectorStore['readOffThread'];
  readVectorJudgment: LocalConnectorStore['readVectorJudgment'];
  visibleVectorItemPksSteps: LocalConnectorStore['visibleVectorItemPksSteps'];
  tierVisibleRows: LocalConnectorStore['tierVisibleRows'];
  tierHiddenItemPks: LocalConnectorStore['tierHiddenItemPks'];
  scheduleVisibilityPublish(): void;
}

const probe = (store: LocalConnectorStore) => store as unknown as Probe;
const cleanups: Array<() => void> = [];
const filters = { provider: 'fixture', locatorPathScope: '/Files' };
const leading = 'x'.repeat(3_996) + 'é😀\0';
const provider: SourceEmbeddingProvider = {
  provider: 'built-in', backend: 'local', modelId: 'winner-fixture', dimension: 3, configHash: '1', epochId: '1',
  async embed(inputs) { return inputs.map(({ text }) => text.includes('harbor') ? [1, 0, 0] : [0, 1, 0]); },
};
const isVisibility = (read: StoreRead) => read.sql.includes('SELECT i.item_pk, i.provider, i.account_scope, i.provider_item_id, i.provider_conversation_id');
const isHydration = (read: StoreRead) => read.sql.includes('0 AS rank') && read.sql.includes('i.item_pk IN');
const isChunk = (read: StoreRead) => read.sql.includes('FROM chunks WHERE chunk_pk = ?') && read.sql.includes('content_hash, bounded_text');
const isPriorChunks = (read: StoreRead) => read.sql.includes('FROM chunks WHERE item_pk = ? AND chunk_index < ?');

afterEach(() => {
  setReadPoolObserverForTests();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  shutdownReadPool();
});

function setup() {
  const tmp = tempDir('olympus-vector-winner-reads-');
  const ledger = new TierLedger({ dbPath: join(tmp.dir, 'ledger.sqlite') });
  const store = new LocalConnectorStore({
    dbPath: join(tmp.dir, 'store.sqlite'), corpusId: 'internal.fixture.winners', family: 'file', trustDomain: 'internal', tierLedger: ledger,
  });
  cleanups.push(() => { store.close(); ledger.close(); tmp.cleanup(); });
  const lane = probe(store);
  const ledgerDb = (ledger as unknown as { db: Database }).db;
  // Seed retained rows and vectors together. Real ledger writes below
  // keep the visibility and hydration paths intact.
  ledgerDb.exec('PRAGMA synchronous = OFF');
  lane.db.exec('PRAGMA synchronous = OFF');
  lane.scheduleVisibilityPublish = () => {};
  store.bindTierSet(ledger);
  const ids = ['first', 'private', 'secret', 'held', 'embed-held', 'tombstone', 'other-account', 'outside', 'grant-open', 'last'];
  lane.db.transaction(() => {
    lane.db.query(`INSERT INTO sync_runs (sync_run_id, corpus_id, connector_id, status, started_at)
      VALUES ('seed', ?, 'fixture_lane', 'completed', '2026-11-01')`).run(store.corpusId);
    const addItem = lane.db.query(`INSERT INTO items (item_pk, provider, family, account_scope, provider_item_id,
      local_item_id, source_version, title, locator_uri, mime_type, fetched_at, indexed_at, trust_tier, sync_run_id)
      VALUES (?, 'fixture', 'file', ?, ?, ?, 'v1', ?, ?, 'text/plain', '2026-11-01', '2026-11-01', 'S3', 'seed')`);
    const addChunk = lane.db.query(`INSERT INTO chunks (item_pk, chunk_index, bounded_text, content_hash, embedding_input_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?, '2026-11-01')`);
    for (const [index, id] of ids.entries()) {
      const pk = index + 1;
      addItem.run(pk, ACCOUNT, id, identityOf(id).localItemId, id, `/Files/${id}`);
      for (const [chunkIndex, text] of [leading, `harbor note ${id}`].entries()) {
        const hash = hashString(text);
        addChunk.run(pk, chunkIndex, text, hash, hash);
      }
    }
    lane.db.query(`INSERT INTO chunk_embeddings (chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at)
      SELECT chunk_pk, ?, item_pk, embedding_input_hash, CASE chunk_index WHEN 0 THEN ? ELSE ? END,
        '2026-11-01' FROM chunks`).run(provider.modelId, encodeEmbedding([0, 1, 0], 3), encodeEmbedding([1, 0, 0], 3));
  })();
  const decision = classifyItemTiers({ signals: {}, text: 'Ordinary harbor notes.' }, { sniffer: JUDGED_PERSONAL_SNIFFER });
  ledgerDb.transaction(() => {
    for (const id of ids) ledger.recordRoutedPlacement(identityOf(id), decision, {
      copies: [{ corpusId: store.corpusId, trustDomain: 'internal', layers: 'both' }],
      embedHold: false,
    });
  })();
  const hold = (id: string) => ledgerDb.query('UPDATE tier_copies SET embed_hold = 1 WHERE provider_item_id = ?').run(id);
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = ?").run('private');
  ledger.putWriteIntent({ identity: identityOf('secret'), connectorId: 'fixture_lane', kind: 'secret' });
  ledgerDb.query("UPDATE tier_items SET state = 'pending', content_pending = 1 WHERE provider_item_id = ?").run('held');
  store.grantOnDemandRead(identityOf('held').localItemId, 'v1');
  store.grantOnDemandRead(identityOf('grant-open').localItemId, 'v1');
  hold('embed-held');
  lane.db.query('UPDATE items SET tombstoned = 1 WHERE provider_item_id = ?').run('tombstone');
  lane.db.query('UPDATE items SET account_scope = ? WHERE provider_item_id = ?').run('work', 'other-account');
  lane.db.query('UPDATE items SET locator_uri = ? WHERE provider_item_id = ?').run('/Other/outside', 'outside');
  lane.tierHiddenItemPks();
  return { store, lane, ledger, hold, search: (limit = 10, locate = true) => store.vectorSearchLane('harbor', provider, limit, ACCOUNT, filters, undefined, { locate }) };
}

test('warm vector search takes visibility, row hydration and chunk matching off the calling thread', async () => {
  const h = setup();
  await h.search();
  const trace = startMainThreadSqlSiteCount(5);
  const pooled: StoreRead[] = [];
  setReadPoolObserverForTests((_path, read) => pooled.push(read), { snapshots: true });
  try {
    const result = await h.search();
    const targetSites = trace.sites().filter(({ site }) => /visibleVectorItemPks|searchRowsByItemPks|chunkMatchForChunkPk/.test(site));
    expect(targetSites).toEqual([]);
    expect(result.rows.map((row) => row.sourceItem.providerItemId)).toEqual(['first', 'grant-open', 'last']);
    expect(pooled.filter(isVisibility)).toHaveLength(2);
    for (const mode of [isHydration, isChunk, isPriorChunks]) expect(pooled.some(mode)).toBe(true);
    expect(pooled.some((read) => read.sql.includes('FROM tier_copies'))).toBe(true);
  } finally { trace.stop(); }
});

test('live pooled visibility and hydrated results match synchronous sets, rows and rank order', async () => {
  const h = setup();
  type Item = { item_pk: number; provider_item_id: string; account_scope: string };
  const all = h.lane.db.query('SELECT item_pk, provider_item_id, account_scope FROM items ORDER BY item_pk').all() as Item[];
  const inScope = h.lane.db.query(`SELECT item_pk, provider_item_id, account_scope FROM items
    WHERE account_scope = ? AND provider = ? AND tombstoned = 0 AND locator_uri LIKE '/Files/%' ORDER BY item_pk`).all(ACCOUNT, filters.provider) as Item[];
  // The old path ran the shared visibility rule, including the per-identity
  // on-demand lookup, on this connection for each SQL batch.
  const legacy = h.lane.tierVisibleRows(inScope, (row) => identityOf(row.provider_item_id), () => 'content', false,
    (copies) => !copies.some((copy) => copy.corpusId === h.store.corpusId && copy.state === 'current' && copy.embedHold));
  expect(legacy.map((row) => row.provider_item_id)).toEqual(['first', 'grant-open', 'last']);
  const steps = (ledger: TierLedger | undefined) => h.lane.visibleVectorItemPksSteps(all.map((row) => row.item_pk), ACCOUNT, filters, ledger);
  const result = (await h.lane.readVectorJudgment(steps, new Set<number>()))();
  expect(result).toEqual(new Set(legacy.map((row) => row.item_pk)));

  const located = await h.search();
  const unlocated = await h.search(10, false);
  const expected = legacy.map<ConnectorStoreScoredSearchRow>((row) => ({
    sourceItem: identityOf(row.provider_item_id), title: row.provider_item_id, syncRunId: 'seed', trustTier: 'S3', rank: 0, bestCosine: 1,
  }));
  expect(unlocated.rows).toEqual(expected.map((row) => ({ ...row, contentMatched: true })));
  expect(located.rows).toEqual(expected.map((row, index) => {
    const text = `harbor note ${row.sourceItem.providerItemId}`;
    return { ...row, chunk: {
      chunkId: String(legacy[index]!.item_pk * 2), chunkIndex: 1, contentHash: hashString(text),
      charStart: 0, charEnd: text.length, itemCharStart: leading.length, itemCharEnd: leading.length + text.length,
      chunkChars: text.length, lane: 'semantic',
    } };
  }));
  const sync = spyOn(h.lane, 'readOffThread').mockImplementation(async (reads) => h.lane.readHere(reads));
  try {
    expect(located).toEqual(await h.search());
    expect(unlocated).toEqual(await h.search(10, false));
  } finally { sync.mockRestore(); }
});

test('an unreadable ledger hides the entire batch', async () => {
  const h = setup();
  const db = (h.ledger as unknown as { db: Database }).db;
  db.exec('DROP TABLE tier_copies');
  const pks = (h.lane.db.query('SELECT item_pk FROM items').all() as Array<{ item_pk: number }>).map(row => row.item_pk);
  const visible = (await h.lane.readVectorJudgment(
    (ledger) => h.lane.visibleVectorItemPksSteps(pks, ACCOUNT, filters, ledger), new Set<number>(),
  ))();
  expect(visible.size).toBe(0);
  expect((await h.search()).rows).toEqual([]);
});

test.each(['visibility', 'chunk hydration'] as const)('a hold during pooled %s drops the winner and refills', async (phase) => {
  const h = setup();
  const writer = new Database(h.ledger.dbPath);
  cleanups.push(() => writer.close());
  writer.exec('PRAGMA synchronous = OFF');
  let visibilityReads = 0;
  let written = false;
  setReadPoolObserverForTests((_path, read) => {
    if (isVisibility(read)) visibilityReads++;
    const matchingRead = phase === 'visibility' ? visibilityReads === 2 && isVisibility(read) : isChunk(read);
    if (!written && matchingRead) {
      written = true;
      writer.query('UPDATE tier_copies SET embed_hold = 1 WHERE provider_item_id = ?').run('first');
    }
  }, { snapshots: true });
  const result = await h.search(2);
  expect(written).toBe(true);
  expect(visibilityReads).toBeGreaterThan(2);
  expect(result.rows.map((row) => row.sourceItem.providerItemId)).toEqual(['grant-open', 'last']);
});

test('a write after the pooled judgment still takes effect at the return boundary', async () => {
  const h = setup();
  const read = h.lane.readVectorJudgment.bind(h.lane);
  let judgments = 0;
  h.lane.readVectorJudgment = async (make, unavailable) => {
    const finish = await read(make, unavailable);
    if (++judgments === 2) h.hold('first');
    return finish;
  };
  const result = await h.search(2);
  expect(judgments).toBeGreaterThan(2);
  expect(result.rows.map((row) => row.sourceItem.providerItemId)).toEqual(['grant-open', 'last']);
});

test('an open ledger write hold uses the live connection, including its uncommitted hold', async () => {
  const h = setup();
  const reads: StoreRead[] = [];
  setReadPoolObserverForTests((_path, read) => reads.push(read), { snapshots: true });
  await h.ledger.holdingWrites(async () => {
    h.hold('first');
    expect((await h.search(2)).rows.map((row) => row.sourceItem.providerItemId)).toEqual(['grant-open', 'last']);
  });
  expect(reads.some(isVisibility)).toBe(false);
});
