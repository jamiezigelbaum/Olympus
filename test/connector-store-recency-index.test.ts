// OLYMPUS_TEST_LANE: deploy
// Reopening the fixture launches the production SQLite maintenance subprocess.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import {
  CONNECTOR_STORE_CONVERSATION_INDEX_SQL,
  LocalConnectorStore,
  connectorStoreOpenStamp,
  setConnectorStoreRecencyIndexAdmission,
  type ConnectorStoreSearchFilters,
} from '../src/workers/connector-store/local-index.ts';
import { readOnPool, type StoreRead } from '../src/workers/connector-store/off-thread-reads.ts';
import { waitFor } from './helpers/test-clock.ts';
import { tempDir } from './helpers/tier-fixtures.ts';

const GLOBAL_INDEX = 'idx_connector_store_items_recent_live';
const ACCOUNT_INDEX = 'idx_connector_store_items_recent_account_live';
const TIE = '2026-11-19T09:02:00.000Z';
const EARLIER = '2026-11-19T09:01:00.000Z';
const LATER = '2026-11-19T09:03:00.000Z';

function chatFixture(): SourceConnector {
  const items: RawItem[] = Array.from({ length: 8 }, (_, i) => {
    const id = `m${i + 1}`;
    return {
      identity: {
        family: 'chat', provider: 'telegram', accountScope: i === 5 ? 'work' : 'personal',
        providerItemId: id, providerConversationId: 'room', localItemId: id, sourceVersion: '1',
      },
      mimeType: 'text/plain',
      content: { kind: 'text', text: `Fixture message ${id}` },
      metadata: { sentAt: TIE, senderLabel: i < 3 ? 'Sam' : 'Lee' },
      fetchedAt: TIE,
    };
  });
  return {
    id: 'fixture-chat', family: 'chat',
    async authenticate() {},
    async *listItems() { yield { items, done: true }; },
    async fetchItem(id) { return items.find((item) => item.identity.localItemId === id)!; },
    classificationSignals() { return {}; },
  };
}

function recentRead(store: LocalConnectorStore, accountScope?: string, filters?: ConnectorStoreSearchFilters, limit = 4): StoreRead {
  return (store as unknown as {
    recentItemsRead(limit: number, account?: string, filters?: ConnectorStoreSearchFilters): StoreRead;
  }).recentItemsRead(limit, accountScope, filters);
}

function plan(db: Database, read: StoreRead): string[] {
  return db.query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${read.sql}`)
    .all(...read.params as SQLQueryBindings[]).map((row) => row.detail);
}

function bytecode(db: Database, read: StoreRead) {
  return db.query<{ opcode: string; p3: number }, SQLQueryBindings[]>(`EXPLAIN ${read.sql}`)
    .all(...read.params as SQLQueryBindings[])
    .map((op) => {
      // Schema cookie and connection-local virtual table pointer.
      if (op.opcode === 'Transaction') return { ...op, p3: 0 };
      if (op.opcode === 'VOpen') return { ...op, p4: null };
      return op;
    });
}

function readRows(db: Database, read: StoreRead) {
  return db.query<{ provider_item_id: string }, SQLQueryBindings[]>(read.sql).all(...read.params as SQLQueryBindings[]);
}

function indexSql(db: Database, index: string): string | undefined {
  return db.query<{ sql: string }, [string]>("SELECT sql FROM main.sqlite_master WHERE type = 'index' AND name = ?").get(index)?.sql;
}

test('the bounded recency reads preserve order, filters, and neighbouring conversation reads', async () => {
  const { dir, cleanup } = tempDir('olympus-recency-test-');
  const options = { dbPath: join(dir, 'chat.sqlite'), corpusId: 'internal.fixture.chat', family: 'chat', trustDomain: 'internal', tierLedger: null } as const;
  const seed = new LocalConnectorStore(options);
  const db = new Database(options.dbPath);
  let writer: LocalConnectorStore | undefined;
  let reader: LocalConnectorStore | undefined;
  try {
    await seed.syncFromConnector(chatFixture(), { fetchContent: true });
    const reads = [
      recentRead(seed),
      recentRead(seed, 'personal'),
      recentRead(seed, 'absent'),
      recentRead(seed, 'personal', { senderLabel: 'Sam' }),
      recentRead(seed, 'personal', { senderLabel: 'absent' }),
      recentRead(seed, 'personal', { senderIdentities: [{ provider: 'telegram', senderLabel: 'Sam' }] }),
      recentRead(seed, 'personal', { locatorPathScope: '/' }), // Predicate with no bound value.
      recentRead(seed, undefined, { authoredAfter: EARLIER }),
      recentRead(seed, 'personal', { provider: 'telegram' }),
    ];
    const indexes = [GLOBAL_INDEX, ACCOUNT_INDEX];
    const ddl = indexes.map((index) => indexSql(db, index));
    expect(ddl[0]).toContain('ON items(COALESCE(authored_at, updated_at, indexed_at)) WHERE tombstoned IS 0');
    expect(ddl[1]).toContain('ON items(account_scope, COALESCE(authored_at, updated_at, indexed_at)) WHERE +tombstoned IS 0');
    seed.close();
    db.exec('PRAGMA synchronous = NORMAL');
    db.transaction(() => {
      db.query("UPDATE items SET authored_at = NULL, updated_at = ?, indexed_at = ? WHERE local_item_id = 'm3'").run(TIE, LATER);
      db.query("UPDATE items SET authored_at = NULL, updated_at = NULL, indexed_at = ? WHERE local_item_id = 'm4'").run(TIE);
      db.query("UPDATE items SET authored_at = ?, updated_at = ? WHERE local_item_id = 'm5'").run(EARLIER, LATER);
      db.query("UPDATE items SET authored_at = ? WHERE local_item_id IN ('m6', 'm7', 'm8')").run(LATER);
      db.exec("UPDATE items SET tombstoned = 1 WHERE local_item_id = 'm7'");
      db.exec("DELETE FROM chunks WHERE item_pk = (SELECT item_pk FROM items WHERE local_item_id = 'm8')");
      db.exec(CONNECTOR_STORE_CONVERSATION_INDEX_SQL);
      indexes.forEach((index) => db.exec(`DROP INDEX ${index}`));
    })();
    const previous = reads.map((read) => readRows(db, read));
    expect(previous.map((rows) => rows.map((row) => row.provider_item_id))).toEqual([
      ['m6', 'm4', 'm3', 'm2'], ['m4', 'm3', 'm2', 'm1'], [],
      ['m3', 'm2', 'm1'], [], ['m3', 'm2', 'm1'], [], ['m6', 'm2', 'm1', 'm5'],
      ['m4', 'm3', 'm2', 'm1'],
    ]);
    const legacyReads = reads.map((read) => ({ ...read, sql: read.sql.replace('ORDER BY +COALESCE', 'ORDER BY COALESCE') }));
    const previousPlans = legacyReads.map((read) => plan(db, read));
    const previousBytecode = legacyReads.map((read) => bytecode(db, read));
    previousPlans.forEach((details) => expect(details).toContain('USE TEMP B-TREE FOR ORDER BY'));

    reader = new LocalConnectorStore({ ...options, readOnly: true });
    const neighbourIds = () => reader!.conversationNeighbours('m1', 2, 'personal').map((row) => row.sourceItem.providerItemId);
    expect(neighbourIds()).toEqual(['m5', 'm2']);
    const recentIds = async () => (await reader!.recentItemsOffThread(4, 'personal')).map((row) => row.sourceItem.providerItemId);
    expect(await recentIds()).toEqual(['m4', 'm3', 'm2', 'm1']);
    const buildAttempts: boolean[] = [];
    setConnectorStoreRecencyIndexAdmission(async (work, preempt) => {
      const building = work();
      if (!buildAttempts.length) preempt();
      const done = await building;
      buildAttempts.push(done);
      return done;
    });
    writer = new LocalConnectorStore(options);
    expect(indexes.map((index) => indexSql(db, index))).toEqual([undefined, undefined]);
    const openStamp = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
    const schemaVersion = (connection: Database) => connection.query("SELECT version FROM schema_version WHERE store_id = 'connector-store'").get();
    expect(schemaVersion(db)).toEqual({ version: 16 });

    // Ingest preempts the first build. An existing writer owns the WAL write
    // lock during the next attempt. The build defers and the
    // same warm read connection can answer before and after the schema commit.
    db.exec('BEGIN IMMEDIATE');
    await waitFor(() => buildAttempts.length >= 2, { description: 'preempted and busy background build attempts' });
    expect(buildAttempts).toEqual([false, false]);
    db.exec('COMMIT');
    await waitFor(() => buildAttempts.includes(true), { description: 'background recency index commit' });

    using built = new Database(options.dbPath);
    expect(indexes.map((index) => indexSql(built, index))).toEqual(ddl);
    expect(built.query('PRAGMA user_version').get()).toEqual({ user_version: openStamp });
    expect(connectorStoreOpenStamp(built)).toBe(openStamp);
    expect(schemaVersion(built)).toEqual({ version: 16 });
    for (const [i, read] of reads.entries()) {
      const details = plan(built, read);
      if (i === 0) expect(details).toContain(`SCAN i USING INDEX ${GLOBAL_INDEX}`);
      else if (i < 3) expect(details).toContain(`SEARCH i USING INDEX ${ACCOUNT_INDEX} (account_scope=?)`);
      else {
        expect(details).toEqual(previousPlans[i]!);
        expect(bytecode(built, read)).toEqual(previousBytecode[i]!);
      }
      expect(readRows(built, read)).toEqual(previous[i]!);
    }
    expect(await recentIds()).toEqual(['m4', 'm3', 'm2', 'm1']);
    const accountRead = reads[1]!;
    const warmPlan = await readOnPool(options.dbPath, { ...accountRead, sql: `EXPLAIN QUERY PLAN ${accountRead.sql}` });
    expect(warmPlan).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining(ACCOUNT_INDEX) })]));
    expect(neighbourIds()).toEqual(['m5', 'm2']);

    // A full candidate page can still be missing all its chunks. The
    // original sort finds the older eligible item in both scopes.
    built.exec("DELETE FROM chunks WHERE item_pk IN (SELECT item_pk FROM items WHERE local_item_id IN ('m2', 'm3', 'm4', 'm6', 'm8'))");
    for (const account of [undefined, 'personal']) {
      const read = recentRead(writer, account, undefined, 1);
      expect(readRows(built, read).map((row) => row.provider_item_id)).toEqual(['m1']);
    }
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    setConnectorStoreRecencyIndexAdmission();
    reader?.close();
    writer?.close();
    seed.close();
    db.close();
    cleanup();
  }
}, 30_000);
