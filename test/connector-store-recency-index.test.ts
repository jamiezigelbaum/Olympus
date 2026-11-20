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
import { readOnPool, setReadPoolObserverForTests, type StoreRead } from '../src/workers/connector-store/off-thread-reads.ts';
import { waitFor } from './helpers/test-clock.ts';
import { tempDir } from './helpers/tier-fixtures.ts';

const GLOBAL_INDEX = 'idx_connector_store_items_recent_live';
const ACCOUNT_INDEX = 'idx_connector_store_items_recent_account_live';
const PERSONAL_BODY_INDEX = 'idx_connector_store_personal_body_order';
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

test('Personal body pages seek through source-date ties before reaching undated rows by insertion order', async () => {
  const { dir, cleanup } = tempDir('olympus-personal-body-pages-');
  const options = { dbPath: join(dir, 'chat.sqlite'), corpusId: 'internal.fixture.chat', family: 'chat', trustDomain: 'internal', tierLedger: null } as const;
  const store = new LocalConnectorStore(options);
  const db = new Database(options.dbPath);
  try {
    await store.syncFromConnector(chatFixture(), { fetchContent: true });
    db.exec("UPDATE items SET authored_at = NULL WHERE local_item_id IN ('m3', 'm4', 'm6')");
    db.query("UPDATE items SET updated_at = ? WHERE local_item_id = 'm3'").run(LATER);
    db.query("UPDATE items SET indexed_at = ? WHERE local_item_id = 'm4'").run(LATER);
    db.query("UPDATE items SET indexed_at = ? WHERE local_item_id = 'm6'").run(EARLIER);
    db.exec("UPDATE items SET authored_at = '2026-11-19T08:04:00-01:00' WHERE local_item_id = 'm5'");
    db.exec("UPDATE items SET tombstoned = 1 WHERE local_item_id = 'm7'");
    db.exec("DELETE FROM chunks WHERE item_pk = (SELECT item_pk FROM items WHERE local_item_id = 'm8')");

    const reads: StoreRead[] = [];
    setReadPoolObserverForTests((path, read) => { if (path === options.dbPath) reads.push(read); }, { snapshots: true });
    const first = (await store.personalBodyPageFinder(undefined, 2).offThread())!;
    expect(first.items.map((item) => item.identity.providerItemId)).toEqual(['m5', 'm3']);
    const second = (await store.personalBodyPageFinder(first.next, 2).offThread())!;
    expect(second.items.map((item) => item.identity.providerItemId)).toEqual(['m2']);
    const third = (await store.personalBodyPageFinder(second.next, 2).offThread())!;
    expect(third.items.map((item) => item.identity.providerItemId)).toEqual(['m1', 'm6']);
    const last = (await store.personalBodyPageFinder(third.next, 2).offThread())!;
    expect(last.items.map((item) => item.identity.providerItemId)).toEqual(['m4']);
    expect(last.next).toBeUndefined();
    // The read worker returns already grouped text. Each slice seeks the
    // chunk index and stops at its budget before aggregating.
    const slices = reads.filter(read => read.sql.includes('FROM chunks'));
    expect(slices.length).toBeGreaterThan(0);
    for (const slice of slices) {
      expect(plan(db, slice)).toContainEqual(expect.stringMatching(/SEARCH chunks USING INDEX .*item_pk=.*chunk_index>/));
      expect(slice.sql).toMatch(/ORDER BY chunk_index LIMIT \?/);
      const group = db.query(slice.sql).get(...slice.params as SQLQueryBindings[]);
      expect(group).toHaveProperty('text');
      expect(group).toHaveProperty('n');
    }
    const orderReads = reads.filter(read => read.sql.includes(`INDEXED BY ${PERSONAL_BODY_INDEX}`));
    expect(orderReads.length).toBeGreaterThan(1);
    const firstPlan = plan(db, orderReads[0]!);
    expect(firstPlan).toEqual([`SEARCH items USING INDEX ${PERSONAL_BODY_INDEX} (<expr>>?)`]);
    const resumedPlans = orderReads.slice(1).flatMap(read => plan(db, read));
    expect(resumedPlans).toEqual(expect.arrayContaining([
      expect.stringContaining(`SEARCH items USING INDEX ${PERSONAL_BODY_INDEX} (<expr>=? AND item_pk<?)`),
      expect.stringContaining(`SEARCH items USING INDEX ${PERSONAL_BODY_INDEX} (<expr><?)`),
    ]));
    expect(resumedPlans.every(detail => detail.startsWith('SEARCH '))).toBe(true);
    const candidate = first.items[0]!;
    expect(candidate.text).toBe('Fixture message m5');
    expect(store.itemMigrationFingerprint(candidate.identity)).toBe(candidate.fingerprint);
    db.exec("DELETE FROM chunks WHERE item_pk = (SELECT item_pk FROM items WHERE local_item_id = 'm5')");
    expect(store.itemMigrationFingerprint(candidate.identity)).not.toBe(candidate.fingerprint);
  } finally {
    setReadPoolObserverForTests();
    db.close();
    store.close();
    cleanup();
  }
});

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
      db.exec(`DROP INDEX ${PERSONAL_BODY_INDEX}`);
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
    expect(schemaVersion(db)).toEqual({ version: 18 });

    // Ingest preempts the first build. An existing writer owns the WAL write
    // lock during the next attempt. The build defers and the
    // same warm read connection can answer before and after the schema commit.
    db.exec('BEGIN IMMEDIATE');
    expect(await writer.personalBodyPageFinder(undefined, 4).offThread()).toBeUndefined();
    await waitFor(() => buildAttempts.length >= 2, { description: 'preempted and busy background build attempts' });
    expect(buildAttempts).toEqual([false, false]);
    db.exec('COMMIT');
    await waitFor(() => buildAttempts.includes(true), { description: 'background recency index commit' });

    using built = new Database(options.dbPath);
    expect(indexSql(built, PERSONAL_BODY_INDEX)).toBeDefined();
    expect((await writer.personalBodyPageFinder(undefined, 4).offThread())?.items).toHaveLength(3);
    expect(indexes.map((index) => indexSql(built, index))).toEqual(ddl);
    expect(built.query('PRAGMA user_version').get()).toEqual({ user_version: openStamp });
    expect(connectorStoreOpenStamp(built)).toBe(openStamp);
    expect(schemaVersion(built)).toEqual({ version: 18 });
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
