// The vector lane walks chunk_embeddings in primary-key order (#1242).
//
// Its page query once let SQLite take the model_id index, so every 256-row
// page read and sorted (blobs included) all of the model's rows: quadratic in
// the store's vector count, which ran a 1.3 GB store past the 10 s lane
// deadline on every eval question (2026-11-10 rerun 5). This pins the plan:
// a range walk on the primary key, no sort.
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { createConnectorStoreCorpusAdapter, defineConnectorCorpus, LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { createSourceAnswerTrace, runWithSourceAnswerTrace, snapshotSourceAnswerTrace } from '../src/workers/source-index/answer-latency-trace.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const provider: SourceEmbeddingProvider = {
  provider: 'built-in', backend: 'local', modelId: 'scan-plan-v1', epochId: '1', configHash: '1', dimension: 2,
  async embed(inputs) { return inputs.map(() => [1, 0]); },
};

function isWinnerLookup(sql: string): boolean {
  return sql.includes('i.account_scope, i.provider_item_id, i.provider_conversation_id')
    && sql.includes('WHERE i.item_pk IN (');
}

async function seedTieredVectors(fixture: ReturnType<typeof openTierFixture>, ids = ['a', 'b', 'c']) {
  await fixture.set.sync(fixtureConnector(() => ids.map(id => ({
    id, name: `${id}.txt`, text: `Ordinary lantern notes for shelf ${id}.`,
  }))), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await fixture.stores.internal!.embedChunks({ provider });
}

function holdVector(ledger: Database, store: LocalConnectorStore, id: string): void {
  ledger.run('UPDATE tier_copies SET embed_hold = 1 WHERE provider_item_id = ? AND corpus_id = ?', [id, store.corpusId]);
}

test('the vector lane pages by primary key without sorting the model\'s rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-vector-scan-plan-'));
  const dbPath = join(dir, 'store.sqlite');
  const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fake.scan', family: 'file', trustDomain: 'internal', tierLedger: null });
  const pageQueries: string[] = [];
  try {
    const items: RawItem[] = Array.from({ length: 40 }, (_, index) => ({
      identity: { family: 'file', provider: 'fake', accountScope: 'personal', providerItemId: `f${index}`, providerFileId: `f${index}`, localItemId: `personal:f${index}`, sourceVersion: 'v1' },
      mimeType: 'text/plain',
      content: { kind: 'text', text: `note ${index} about the harbor` },
      metadata: { name: `f${index}.txt`, locatorUri: `/f${index}.txt`, pathDisplay: `/f${index}.txt`, updatedAt: '2026-11-10T00:00:00Z' },
      fetchedAt: '2026-11-10T00:00:00Z',
    }));
    const connector: SourceConnector = {
      id: 'fake', family: 'file', async authenticate() {},
      async *listItems() { yield { items, done: true }; },
      async fetchItem(id) { return items.find((item) => item.identity.localItemId === id)!; },
      classificationSignals() { return {}; },
    };
    await store.syncFromConnector(connector, { fetchContent: true });
    await store.embedChunks({ provider });
    // A second model's vectors make the model filter selective, as after a model switch.
    await store.embedChunks({ provider: { ...provider, modelId: 'scan-plan-v2', epochId: '2' } });

    // The pages are read on the store's read-pool thread (#1305).
    setReadPoolObserverForTests((_, read) => {
      if (/FROM chunk_embeddings emb/.test(read.sql) && /emb\.chunk_pk > \?/.test(read.sql)) pageQueries.push(read.sql);
    }, { snapshots: true });
    const lane = await store.vectorSearchLane('harbor', provider, 10, 'personal');
    setReadPoolObserverForTests();
    expect(lane.rows.length).toBeGreaterThan(0);
    expect(pageQueries.length).toBeGreaterThan(0);

    const db = new Database(dbPath, { readonly: true });
    try {
      const plan = (db.query(`EXPLAIN QUERY PLAN ${pageQueries[0]}`).all('scan-plan-v1', 0, 'personal', 256) as Array<{ detail: string }>)
        .map((row) => row.detail);
      expect(plan.some((detail) => /SEARCH emb USING INDEX sqlite_autoindex_chunk_embeddings_1 \(chunk_pk>\?\)/.test(detail))).toBe(true);
      expect(plan.some((detail) => /TEMP B-TREE/.test(detail))).toBe(false);
    } finally {
      db.close();
    }
  } finally {
    setReadPoolObserverForTests();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a read-only file store runs semantic search with zero loop SQL before and after visibility warm-up', async () => {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  const ledgerDb = new Database(fixture.ledger.dbPath);
  let front: LocalConnectorStore | undefined;
  try {
    await seedTieredVectors(fixture);
    const writer = fixture.stores.internal!;
    holdVector(ledgerDb, writer, 'c');
    const writerDb = new Database(writer.dbPath);
    try {
      writerDb.run("UPDATE items SET parent_local_item_id = 'personal:a' WHERE provider_item_id = 'b'");
    } finally { writerDb.close(); }
    await writer.keepVisibilityCurrentInTurns();
    const reader = front = new LocalConnectorStore({
      dbPath: writer.dbPath, corpusId: writer.corpusId, family: writer.family, trustDomain: writer.trustDomain, readOnly: true,
    });
    const adapter = createConnectorStoreCorpusAdapter({ store: reader, embeddingProvider: provider, accountScope: 'personal' });
    const request = {
      query: 'lantern', maxResults: 3, corpus: defineConnectorCorpus(reader),
      context: { allowedTrustDomains: ['internal'] as const },
    };
    const memo = () => (reader as unknown as { tierLedgerHiddenMemo?: unknown }).tierLedgerHiddenMemo;
    for (const warmed of [false, true]) {
      if (warmed) await reader.keepVisibilityCurrentInTurns();
      expect(Boolean(memo())).toBe(warmed);
      const pooled: string[] = [];
      const memoReads: string[] = [];
      setReadPoolObserverForTests((_path, read, snapshot) => {
        pooled.push(read.sql);
        if (!snapshot) memoReads.push(read.sql);
      }, { snapshots: true });
      const trace = createSourceAnswerTrace();
      const result = await runWithSourceAnswerTrace(trace, () => adapter.semanticNeighbours!(request));
      expect(snapshotSourceAnswerTrace(trace).mainThreadSql.statements).toBe(0);
      expect(result.laneAudits?.[0]?.skippedReason).toBeUndefined();
      expect(result.hits.map(hit => hit.sourceItem.providerItemId)).toEqual(['a', 'b']);
      expect(result.hits.every(hit => hit.provenance?.chunk?.span?.lane === 'semantic')).toBe(true);
      expect(pooled.some(isWinnerLookup)).toBe(true);
      expect(pooled.some(sql => sql.includes('FROM tier_visibility_changes'))).toBe(true);
      expect(memoReads.some(sql => sql.includes('FROM tier_visibility_changes'))).toBe(warmed);
      expect(pooled.some(sql => /tier_visibility_(members|state)/.test(sql))).toBe(false);
      expect(Boolean(memo())).toBe(warmed);
      setReadPoolObserverForTests();
    }
  } finally {
    setReadPoolObserverForTests();
    front?.close();
    ledgerDb.close();
    fixture.close();
    cleanup();
  }
});

test('a vector winner hidden during a later pooled winner lookup is withheld', async () => {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  const store = fixture.stores.internal!;
  const ledgerDb = new Database(fixture.ledger.dbPath);
  try {
    await seedTieredVectors(fixture);
    const ranked = (await store.vectorSearchLane('lantern', provider, 3)).rows.map(row => row.sourceItem.providerItemId);
    expect(ranked).toHaveLength(3);
    holdVector(ledgerDb, store, ranked[1]!);
    let lookups = 0;
    setReadPoolObserverForTests((_path, read) => {
      if (isWinnerLookup(read.sql) && ++lookups === 2) queueMicrotask(() => holdVector(ledgerDb, store, ranked[0]!));
    });
    const result = await store.vectorSearchLane('lantern', provider, 2);
    expect(lookups).toBe(2);
    expect(result.skippedReason).toBeUndefined();
    expect(result.rows.map(row => row.sourceItem.providerItemId)).toEqual([ranked[2]!]);
  } finally {
    setReadPoolObserverForTests();
    ledgerDb.close();
    fixture.close();
    cleanup();
  }
});

test('a visibility change during pooled chunk location causes a fresh judgment', async () => {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  const store = fixture.stores.internal!;
  const ledgerDb = new Database(fixture.ledger.dbPath);
  try {
    await seedTieredVectors(fixture);
    let locations = 0;
    const judgedBatches: unknown[][] = [];
    setReadPoolObserverForTests((_path, read) => {
      if (read.sql.includes('0 AS rank') && read.sql.includes('WHERE i.item_pk IN (')) judgedBatches.push([...read.params]);
      if (!read.sql.includes('WITH want(ordinal, item_pk')) return;
      if (++locations === 1) queueMicrotask(() => holdVector(ledgerDb, store, 'a'));
    }, { snapshots: true });
    const result = await store.vectorSearchLane('lantern', provider, 3);
    expect(result.skippedReason).toBeUndefined();
    expect(result.rows.map(row => row.sourceItem.providerItemId)).toEqual(['b', 'c']);
    expect(judgedBatches.map(batch => batch.length)).toEqual([3, 1]);
    expect(judgedBatches[1]).toEqual([judgedBatches[0]![0]]);
    expect(locations).toBe(1);
  } finally {
    setReadPoolObserverForTests();
    ledgerDb.close();
    fixture.close();
    cleanup();
  }
});

test('semantic winners settle while unrelated item and ledger writes keep advancing both feeds', async () => {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  const store = fixture.stores.internal!;
  const storeDb = new Database(store.dbPath);
  const ledgerDb = new Database(fixture.ledger.dbPath);
  try {
    await seedTieredVectors(fixture, ['a', 'b', 'c', 'unrelated']);
    const expected = await store.vectorSearchLane('lantern', provider, 3);
    expect(expected.rows.map(row => row.sourceItem.providerItemId)).toEqual(['a', 'b', 'c']);
    let validating = false;
    let writes = 0;
    let markerReads = 0;
    setReadPoolObserverForTests((path, read) => {
      if (isWinnerLookup(read.sql)) validating = true;
      if (!validating || (path !== store.dbPath && path !== fixture.ledger.dbPath)) return;
      if (read.sql.includes('olympus_read_file_identity() AS file, schema_version')) markerReads += 1;
      // Both commits happen throughout the validation, including between its
      // old and fresh snapshots. Each also writes an unrelated feed key.
      storeDb.run("UPDATE items SET title = ?, trust_tier = trust_tier WHERE provider_item_id = 'unrelated'", [String(++writes)]);
      ledgerDb.run("UPDATE tier_copies SET embed_hold = 1 - embed_hold WHERE provider_item_id = 'unrelated'");
    }, { snapshots: true });
    expect(await store.vectorSearchLane('lantern', provider, 3)).toEqual(expected);
    expect(markerReads).toBeGreaterThanOrEqual(4);
    expect(writes).toBeGreaterThan(markerReads);
  } finally {
    setReadPoolObserverForTests();
    storeDb.close();
    ledgerDb.close();
    fixture.close();
    cleanup();
  }
});

test('a schema-compatible file replacing the configured ledger cannot expose a held winner', async () => {
  const { dir, cleanup } = tempDir();
  const dbPath = join(dir, 'store.sqlite');
  const ledgerPath = join(dir, 'ledger.sqlite');
  const replacementPath = join(dir, 'replacement.sqlite');
  const ledger = new TierLedger({ dbPath: ledgerPath });
  const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.identity', family: 'file', trustDomain: 'internal', tierLedger: null });
  try {
    const source = fixtureConnector(() => [{ id: 'a', name: 'a.txt', text: 'Ordinary lantern notes.' }]);
    await store.syncFromConnector(source, { fetchContent: true });
    await store.embedChunks({ provider });
    const item = (await source.listItems()[Symbol.asyncIterator]().next()).value!.items[0] as RawItem;
    const decision = classifyItemTiers({ signals: {}, text: 'Ordinary lantern notes.' });
    ledger.recordRoutedPlacement(item.identity, decision, {
      copies: [{ corpusId: store.corpusId, trustDomain: 'internal', layers: 'both' }], embedHold: true,
    });
    store.useTierLedger(ledger);
    expect(store.tierSetBinding()).toBeUndefined();
    expect(await store.vectorSearchLane('lantern', provider, 1)).toEqual({ rows: [] });

    new TierLedger({ dbPath: replacementPath }).close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(ledgerPath + suffix)) renameSync(ledgerPath + suffix, join(dir, 'original.sqlite') + suffix);
    }
    renameSync(replacementPath, ledgerPath);
    expect(await store.vectorSearchLane('lantern', provider, 1)).toEqual({ rows: [], skippedReason: 'vector_visibility_unavailable' });
  } finally {
    store.close();
    ledger.close();
    cleanup();
  }
});

test('an on-demand grant that needs judging hides a winner during chunk location', async () => {
  const { dir, cleanup } = tempDir();
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'store.sqlite'), corpusId: 'internal.fixture.grant', family: 'file', trustDomain: 'internal', tierLedger: null,
  });
  try {
    await store.syncFromConnector(fixtureConnector(() => ['a', 'b'].map(id => ({
      id, name: `${id}.txt`, text: `Ordinary lantern notes for shelf ${id}.`,
    }))), { fetchContent: true });
    await store.embedChunks({ provider });
    let granted = false;
    setReadPoolObserverForTests((_path, read) => {
      if (granted || !read.sql.includes('WITH want(ordinal, item_pk')) return;
      granted = true;
      store.grantOnDemandRead('personal:a', 'v1');
    }, { snapshots: true });
    const result = await store.vectorSearchLane('lantern', provider, 2);
    expect(granted).toBe(true);
    expect(result.skippedReason).toBeUndefined();
    expect(result.rows.map(row => row.sourceItem.providerItemId)).toEqual(['b']);
  } finally {
    setReadPoolObserverForTests();
    store.close();
    cleanup();
  }
});
