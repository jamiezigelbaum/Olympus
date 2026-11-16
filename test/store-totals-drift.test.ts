// The store's kept totals (store-totals.ts) must always equal a full recount:
// after imports, re-reads, removals, embedding, deletes and run records, by
// the triggers alone; and after any drift (a REPLACE, a corrupted row), by
// the reconcile, which also carries over writes made while it counted.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  applyStoreTotalsCount, createStoreTotals, readStoreTotals, storeTotalsCountSql, storeTotalsReconcileDue, storeTotalsWalkSteps,
  STORE_TOTALS_REWALK_AFTER_MS, type StoreTotalsCount,
} from '../src/workers/connector-store/store-totals.ts';
import { Database } from 'bun:sqlite';

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

  test('is owed only when the totals were never filled, a trigger was put back, or an hour after a walk that saw writes', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    try {
      const db = (store as unknown as { db: Database }).db;
      const now = Date.now();
      expect(storeTotalsReconcileDue(store.totals(), now)).toBe(true);
      await store.reconcileTotals();
      // Filled and exact: no walk on a clock.
      expect(storeTotalsReconcileDue(store.totals(), now + 10 * STORE_TOTALS_REWALK_AFTER_MS)).toBe(false);
      // A trigger missing at open: owed now.
      db.exec('DROP TRIGGER connector_store_totals_chunk_insert;');
      createStoreTotals(db, NON_SYNC_SQL(db));
      expect(readStoreTotals(db)!.walkOwed).toBe('now');
      expect(storeTotalsReconcileDue(store.totals(), now)).toBe(true);
      await store.reconcileTotals();
      expect(store.totals()!.walkOwed).toBeUndefined();
      // A walk that saw writes: owed again an hour later.
      const count = db.query(storeTotalsCountSql(NON_SYNC_SQL(db))).get() as StoreTotalsCount;
      applyStoreTotalsCount(db, count, new Date(now).toISOString(), { exact: false });
      expect(store.totals()!.walkOwed).toBe('later');
      expect(storeTotalsReconcileDue(store.totals(), now + 1_000)).toBe(false);
      expect(storeTotalsReconcileDue(store.totals(), now + STORE_TOTALS_REWALK_AFTER_MS)).toBe(true);
    } finally { store.close(); }
  });
});

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
