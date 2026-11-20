// The store's kept totals (store-totals.ts) must always equal a full recount:
// after imports, re-reads, removals, embedding, deletes and run records, by
// the triggers alone; and after any drift (a REPLACE, a corrupted row), by
// the reconcile, which also carries over writes made while it counted.

import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import {
  applyStoreTotalsCount, createStoreTotals, storeTotalsCountSql, storeTotalsWalkSteps,
  STORE_TOTALS_QUIET_MS, type StoreTotalsCount,
} from '../src/workers/connector-store/store-totals.ts';
import { Database } from 'bun:sqlite';
import { createTestClock } from './helpers/test-clock.ts';

const CORPUS_ID = 'secure_local.dropbox.files';
const ACCOUNT = 'dropbox.personal';
const NON_SYNC = `('connector_store_embedding_write_authority', 'x', 'y', 'z')`;

describe('store totals', () => {
  test('equal a full recount after every kind of write, without a reconcile', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    try {
      expect(store.totals()).toBeUndefined();
      expect(await store.reconcileTotals()).toBe(0);
      const check = () => expect(withoutStamp(store.totals())).toEqual(recount(store));
      check();
      await store.syncFromConnector(connector([file('a.txt', 'alpha '.repeat(400)), file('b.txt', 'beta'), file('c.pdf')]), { fetchContent: true });
      check();
      // A re-read with new text re-chunks; a file gone from the listing is tombstoned.
      await store.syncFromConnector(connector([file('a.txt', 'gamma '.repeat(900), 'rev-2'), file('b.txt', 'beta')]), { fetchContent: true });
      check();
      // A removal (as a deletion page or an account snapshot writes it).
      const db = (store as unknown as { db: Database }).db;
      db.query("UPDATE items SET tombstoned = 1 WHERE provider_item_id = 'c.pdf'").run();
      check();
      expect(store.totals()!.tombstonedItems).toBe(1);
      expect(store.totals()!.syncRuns).toBe(2);
      await store.embedChunks({ provider: fakeEmbeddings('fake-embed-v1') });
      await store.embedChunks({ provider: fakeEmbeddings('fake-embed-v2') });
      check();
      expect(Object.keys(store.totals()!.vectorsByModel).sort()).toEqual(['fake-embed-v1', 'fake-embed-v2']);
      await store.syncFromConnector(connector([file('b.txt', 'beta beta', 'rev-3')]), { fetchContent: true });
      check();
      let left = Infinity;
      while (left > 0) left = store.purgeAccountScope({ provider: 'dropbox', accountScope: ACCOUNT, connectorId: 'dropbox-test', limit: 1 }).remaining;
      check();
      expect(store.totals()!.items).toBe(0);
      expect(store.totals()!.vectorsByModel).toEqual({});
      // Nothing to put right.
      expect(await store.reconcileTotals()).toBe(0);
    } finally { store.close(); }
  });

  test('a corrupted total is put right by the reconcile, read on the read thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-totals-'));
    const dbPath = join(dir, 'store.sqlite');
    const store = new LocalConnectorStore({ dbPath, corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    try {
      await store.syncFromConnector(connector([file('a.txt', 'alpha '.repeat(400)), file('b.txt', 'beta')]), { fetchContent: true });
      await store.reconcileTotals();
      const exact = recount(store);
      expect(withoutStamp(store.totals())).toEqual(exact);
      // Corrupt it on purpose, as a REPLACE or an older build's table rebuild could.
      const raw = new Database(dbPath);
      raw.exec("UPDATE store_totals SET n = n + 7 WHERE name = 'chunks'; UPDATE store_totals SET n = n - 2 WHERE name = 'items';");
      raw.exec("DROP TRIGGER connector_store_totals_chunk_insert;");
      raw.close();
      expect(store.totals()!.chunks).toBe(exact.chunks + 7);
      expect(await store.reconcileTotals()).toBe(9);
      expect(withoutStamp(store.totals())).toEqual(exact);
      // The dropped trigger is back, so later writes keep the totals.
      await store.syncFromConnector(connector([file('a.txt', 'alpha '.repeat(400)), file('b.txt', 'beta'), file('d.txt', 'delta '.repeat(500))]), { fetchContent: true });
      expect(withoutStamp(store.totals())).toEqual(recount(store));
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('writes made while the reconcile counted are carried over, not lost', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    try {
      await store.reconcileTotals();
      await store.syncFromConnector(connector([file('a.txt', 'alpha')]), { fetchContent: true });
      const db = (store as unknown as { db: Database }).db;
      // The count is taken, then more is written before it is applied.
      const count = db.query(storeTotalsCountSql(NON_SYNC_SQL(db))).get() as StoreTotalsCount;
      await store.syncFromConnector(connector([file('a.txt', 'alpha'), file('b.txt', 'beta'), file('c.txt', 'gamma')]), { fetchContent: true });
      expect(applyStoreTotalsCount(db, count, new Date().toISOString())).toBe(0);
      expect(withoutStamp(store.totals())).toEqual(recount(store));
    } finally { store.close(); }
  });
});

// The walk (plan thread, 16 Nov): each table a range of keys at a time, each
// page its own read, and only when owed.
describe('the totals walk', () => {
  test('adds up a key at a time to the one-pass count', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    try {
      await store.syncFromConnector(connector([file('a.txt', 'alpha '.repeat(400)), file('b.txt', 'beta'), file('c.pdf')]), { fetchContent: true });
      await store.embedChunks({ provider: fakeEmbeddings('fake-embed-v1') });
      const db = (store as unknown as { db: Database }).db;
      const steps = storeTotalsWalkSteps(NON_SYNC_SQL(db), 1);
      let step = steps.next();
      let reads = 0;
      while (!step.done) {
        reads += 1;
        const statement = db.query(step.value.sql);
        step = steps.next(step.value.mode === 'get' ? statement.get(...(step.value.params as never[])) : statement.all(...(step.value.params as never[])));
      }
      expect(reads).toBeGreaterThan(5);
      expect(step.value.quiet).toBe(true);
      const whole = db.query(storeTotalsCountSql(NON_SYNC_SQL(db))).get() as StoreTotalsCount;
      const { kept_json: _a, vectors_json: walkedVectors, ...walked } = step.value.count;
      const { kept_json: _b, vectors_json: wholeVectors, ...counted } = whole;
      expect(walked).toEqual(counted);
      expect(JSON.parse(walkedVectors!)).toEqual(JSON.parse(wholeVectors!));
    } finally { store.close(); }
  });

  test('runs zero walk statements on exact totals, across writes and ledger changes', async () => {
    const clock = createTestClock();
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local', now: clock.date, tierLedger: ledger });
    const db = (store as unknown as { db: Database }).db;
    const query = spyOn(db, 'query');
    const background = () => store.reconcileTotals({ background: true });
    try {
      const item = file('a.txt', 'alpha');
      await store.syncFromConnector(connector([item]), { fetchContent: true });
      query.mockClear();
      expect(await background()).toBe(0);
      const walkStatements = query.mock.calls.map(([sql]) => sql).filter(isWalkStatement);
      expect(walkStatements).toHaveLength(6); // start, item, chunk, vectors, run, end
      for (let pass = 0; pass < 4; pass++) {
        await clock.advance(STORE_TOTALS_QUIET_MS);
        query.mockClear();
        expect(await background()).toBeUndefined();
        expect(query.mock.calls.map(([sql]) => sql).filter(isWalkStatement)).toEqual([]);
      }
      // A write keeps the totals exact through the triggers: no walk.
      db.exec('UPDATE items SET tombstoned = 1 WHERE item_pk = 1');
      query.mockClear();
      expect(await background()).toBeUndefined();
      expect(query.mock.calls.map(([sql]) => sql).filter(isWalkStatement)).toEqual([]);
      expect(withoutStamp(store.totals())).toEqual(recount(store));

      // A ledger change moves no row the totals count: no walk.
      const writes = store.writeSequence();
      ledger.markNewArrival(item.identity);
      expect(store.writeSequence()).toBe(writes);
      query.mockClear();
      expect(await background()).toBeUndefined();
      expect(query.mock.calls.map(([sql]) => sql).filter(isWalkStatement)).toEqual([]);

      db.exec("UPDATE store_totals SET n = n + 4 WHERE name = 'chunks'");
      expect(await background()).toBeUndefined();
      expect(await store.reconcileTotals()).toBe(4);
      expect(await background()).toBeUndefined();

      db.exec("UPDATE store_totals SET n = n + 3 WHERE name = 'chunks'");
      db.exec('DROP TRIGGER connector_store_totals_chunk_insert;');
      createStoreTotals(db, NON_SYNC_SQL(db));
      expect(store.writeSequence()).toBe(writes);
      expect(await background()).toBe(3);
      expect(await background()).toBeUndefined();
      expect(withoutStamp(store.totals())).toEqual(recount(store));
    } finally { query.mockRestore(); store.close(); ledger.close(); }
  });

  test('retries after a quiet hour and repairs a provably wrong total immediately', async () => {
    const clock = createTestClock();
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local', now: clock.date });
    const db = (store as unknown as { db: Database }).db;
    const background = () => store.reconcileTotals({ background: true });
    const write = () => db.exec('UPDATE items SET tombstoned = 1 - tombstoned WHERE item_pk = 1');
    const original = db.query.bind(db);
    let writeDuringWalk = false;
    const query = spyOn(db, 'query').mockImplementation((sql) => {
      if (writeDuringWalk && sql.includes('FROM items WHERE item_pk >')) {
        writeDuringWalk = false;
        write();
      }
      return original(sql);
    });
    try {
      await store.syncFromConnector(connector([file('a.txt', 'alpha')]), { fetchContent: true });
      expect(await background()).toBe(0);
      write();
      writeDuringWalk = true;
      expect(await store.reconcileTotals()).toBe(0);
      expect(writeDuringWalk).toBe(false);
      expect(store.totals()!.walkOwed).toBe('later');
      expect(store.totals()!.items).toBe(1);
      for (let hour = 0; hour < 3; hour++) {
        await clock.advance(STORE_TOTALS_QUIET_MS);
        write();
        query.mockClear();
        expect(await background()).toBeUndefined();
        expect(query.mock.calls.map(([sql]) => sql).filter(isWalkStatement)).toEqual([]);
      }
      await clock.advance(STORE_TOTALS_QUIET_MS - 1);
      expect(await background()).toBeUndefined();
      await clock.advance(1);
      expect(await background()).toBe(0);
      await clock.advance(STORE_TOTALS_QUIET_MS);
      expect(await background()).toBeUndefined();
      expect(withoutStamp(store.totals())).toEqual(recount(store));

      write();
      writeDuringWalk = true;
      expect(await store.reconcileTotals()).toBe(0);
      expect(store.totals()!.walkOwed).toBe('later');
      db.exec("UPDATE store_totals SET n = -2 WHERE name = 'chunks'");
      expect(await background()).toBe(3);
      expect(withoutStamp(store.totals())).toEqual(recount(store));
    } finally { query.mockRestore(); store.close(); }
  });
});

function isWalkStatement(sql: string): boolean {
  return /MAX\(item_pk\)|item_pk > \? AND item_pk <=|chunk_pk > \? AND chunk_pk <=|rowid > \? AND rowid <=|SELECT n AS writes/.test(sql);
}

/** The same real-sync predicate the store uses, read back from its own trigger. */
function NON_SYNC_SQL(db: Database): string {
  const sql = (db.query("SELECT sql FROM sqlite_master WHERE name = 'connector_store_totals_sync_insert'").get() as { sql: string }).sql;
  return /NOT IN (\([^)]*\))/.exec(sql)?.[1] ?? NON_SYNC;
}

function recount(store: LocalConnectorStore) {
  const db = (store as unknown as { db: Database }).db;
  const row = db.query(storeTotalsCountSql(NON_SYNC_SQL(db))).get() as StoreTotalsCount;
  return {
    items: row.items, tombstonedItems: row.tombstoned_items, chunks: row.chunks, syncRuns: row.sync_runs,
    vectorsByModel: JSON.parse(row.vectors_json ?? '{}') as Record<string, number>,
  };
}

function withoutStamp(totals: ReturnType<LocalConnectorStore['totals']>) {
  if (!totals) return totals;
  const { reconciledAt: _at, ...rest } = totals;
  return rest;
}

function fakeEmbeddings(modelId: string): SourceEmbeddingProvider {
  return {
    provider: 'fake-test-embeddings', modelId, dimension: 4, configHash: `fake-${modelId}`,
    epochId: `local:fake-test-embeddings:${modelId}:4`, backend: 'local',
    async embed(inputs: readonly SourceEmbeddingInput[]): Promise<number[][]> {
      return inputs.map((input) => [input.text.length % 7, 0.2, 0.3, 0.4]);
    },
  };
}

function file(name: string, text?: string, version = 'rev-1'): RawItem {
  return {
    identity: { family: 'file', provider: 'dropbox', accountScope: ACCOUNT, providerItemId: name, localItemId: `${ACCOUNT}:${name}`, sourceVersion: version },
    mimeType: text === undefined ? 'application/pdf' : 'text/plain',
    content: text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text },
    metadata: { title: name },
    fetchedAt: '2026-08-31T12:00:00.000Z',
  };
}

function connector(items: RawItem[]): SourceConnector {
  return {
    id: 'dropbox-test',
    family: 'file',
    async authenticate() {},
    listItems() { return (async function* () { yield { items, done: true }; })(); },
    async fetchItem(localItemId: string) {
      const found = items.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!found) throw new Error(`missing item ${localItemId}`);
      return found;
    },
    classificationSignals() { return {}; },
  };
}
