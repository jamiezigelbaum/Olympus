import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

const STORE_ID = 'connector-store';
const FIXED_NOW = new Date('2026-07-22T12:00:00.000Z');

describe('LocalConnectorStore conversation-scoped identity migration', () => {
  test('migrates the current v4 schema in place and preserves every dependent row', async () => {
    await withDatabasePath(async (dbPath) => {
      const before = createCurrentV4Fixture(dbPath);

      let store = openFixtureStore(dbPath);
      expect(store.status().counts).toEqual({
        items: 2,
        tombstonedItems: 0,
        chunks: 2,
        embeddedChunks: 2,
        syncRuns: 2,
        itemsWithText: 2,
      });
      expect(store.status().embeddingByModel).toHaveLength(1);
      expect(store.status().embeddingByModel[0]).toMatchObject({ embeddedChunks: 2, itemsEmbedded: 2 });
      store.close();

      const firstOpen = inspectFixture(dbPath);
      expect(firstOpen.version).toBe(11);
      expect(firstOpen.data).toEqual(before);
      expect(firstOpen.foreignKeyErrors).toEqual([]);
      // The reactions column arrives empty on an upgraded store, so an item
      // that predates the column behaves exactly as it did before.
      expect(firstOpen.reactions).toEqual([
        { item_pk: 101, reactions_json: null },
        { item_pk: 202, reactions_json: null },
      ]);
      expect(firstOpen.senders).toEqual([
        { item_pk: 101, sender_id: null, sender_label: null, sender_is_owner: null },
        { item_pk: 202, sender_id: null, sender_label: null, sender_is_owner: null },
      ]);
      expect(firstOpen.senderIndexes).toEqual([
        'idx_connector_store_items_sender_id',
        'idx_connector_store_items_sender_label',
        'idx_connector_store_items_sender_owner',
      ]);
      expect(firstOpen.identities).toEqual([
        {
          provider: 'source-alpha',
          provider_item_id: 'alpha-1',
          provider_conversation_id: null,
          normalized_conversation: '',
        },
        {
          provider: 'source-beta',
          provider_item_id: 'beta-1',
          provider_conversation_id: 'conversation-beta',
          normalized_conversation: 'conversation-beta',
        },
      ]);
      expect(firstOpen.identityIndexColumns).toEqual([
        'provider',
        'account_scope',
        'normalized_conversation',
        'provider_item_id',
      ]);

      store = openFixtureStore(dbPath);
      expect(store.locatorIdentityIndexStatus()).toEqual({
        state: 'backfill_required',
        cursorItemPk: 0,
        indexedItems: 0,
      });
      expect(() => store.activeIdentityForLocator({
        provider: 'source-alpha',
        accountScope: 'fixture-account',
        locatorUri: 'FIXTURE://ALPHA',
      })).toThrow(/requires bounded backfill/);
      expect(store.backfillLocatorIdentityIndex({ maxItems: 1 })).toEqual({
        state: 'backfill_required',
        scannedItems: 1,
        indexedItems: 1,
        cursorItemPk: 101,
      });
      expect(store.backfillLocatorIdentityIndex({ maxItems: 1 })).toEqual({
        state: 'ready',
        scannedItems: 1,
        indexedItems: 2,
        cursorItemPk: 202,
      });
      expect(store.activeIdentityForLocator({
        provider: 'source-alpha',
        accountScope: 'fixture-account',
        locatorUri: 'FIXTURE://ALPHA',
      })?.providerItemId).toBe('alpha-1');
      store.close();

      // Opening the already-migrated store again applies no destructive work.
      store = openFixtureStore(dbPath);
      store.close();
      expect(inspectFixture(dbPath)).toEqual(firstOpen);

      store = openFixtureStore(dbPath);
      await store.syncFromConnector(conversationConnector([
        conversationItem('chat-a', 'first chat passage'),
        conversationItem('chat-b', 'second chat passage'),
      ]), { fetchContent: true });
      expect(store.status().counts.items).toBe(4);

      // Same provider item id and same conversation converges on the existing
      // row, while the sibling conversation remains independently addressable.
      await store.syncFromConnector(conversationConnector([
        conversationItem('chat-a', 'updated first chat passage'),
      ]), { fetchContent: true });
      expect(store.status().counts.items).toBe(4);
      expect(store.localContent('telegram:chat-a:shared-message')?.chunks)
        .toEqual(['updated first chat passage']);
      expect(store.localContent('telegram:chat-b:shared-message')?.chunks)
        .toEqual(['second chat passage']);
      store.close();

      const db = new Database(dbPath);
      try {
        expect(db.query(`
          SELECT normalized_conversation
          FROM items
          WHERE provider = 'telegram-fixture' AND provider_item_id = 'shared-message'
          ORDER BY normalized_conversation
        `).all()).toEqual([
          { normalized_conversation: 'chat-a' },
          { normalized_conversation: 'chat-b' },
        ]);
        expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        db.close();
      }
    });
  });

  test('converges an upgraded locator identity index without an operator pass', async () => {
    await withDatabasePath(async (dbPath) => {
      createCurrentV4Fixture(dbPath);
      const store = openFixtureStore(dbPath);
      try {
        const locator = {
          provider: 'source-alpha',
          accountScope: 'fixture-account',
          locatorUri: 'FIXTURE://ALPHA',
        };
        // The deletion path skips instead of throwing: one unresolved deletion
        // is recoverable, a killed listing pass replays its page forever.
        expect(store.activeIdentityForLocatorIfIndexed(locator)).toBeUndefined();

        // A bounded call that cannot finish leaves the durable cursor advanced
        // and still reports the index as unconverged.
        expect(await store.ensureLocatorIdentityIndexReady({ maxItems: 1, maxWindows: 1 })).toEqual({
          state: 'backfill_required',
          scannedItems: 1,
          indexedItems: 1,
          cursorItemPk: 101,
        });
        expect(store.activeIdentityForLocatorIfIndexed(locator)).toBeUndefined();

        expect(await store.ensureLocatorIdentityIndexReady({ maxItems: 1 })).toEqual({
          state: 'ready',
          scannedItems: 1,
          indexedItems: 2,
          cursorItemPk: 202,
        });
        expect(store.activeIdentityForLocatorIfIndexed(locator)?.providerItemId).toBe('alpha-1');
        expect(await store.ensureLocatorIdentityIndexReady()).toEqual({
          state: 'ready',
          scannedItems: 0,
          indexedItems: 2,
          cursorItemPk: 202,
        });
      } finally {
        store.close();
      }
    });
  });

  test('refuses unversioned collisions, partial v4 schemas, and future schemas', async () => {
    await withDatabasePath((dbPath) => {
      const db = new Database(dbPath, { create: true });
      db.exec('CREATE TABLE items (item_pk INTEGER PRIMARY KEY);');
      db.close();
      expect(() => openFixtureStore(dbPath)).toThrow(/unversioned\/colliding/);
    });

    await withDatabasePath((dbPath) => {
      const db = new Database(dbPath, { create: true });
      createSchemaVersionTable(db, 4);
      db.exec('CREATE TABLE items (item_pk INTEGER PRIMARY KEY);');
      db.close();
      expect(() => openFixtureStore(dbPath)).toThrow(/required v4 columns/);
    });

    await withDatabasePath((dbPath) => {
      const db = new Database(dbPath, { create: true });
      createSchemaVersionTable(db, 99);
      db.close();
      expect(() => openFixtureStore(dbPath)).toThrow(/schema_version 99/);
    });

    await withDatabasePath((dbPath) => {
      createCurrentV4Fixture(dbPath);
      const store = openFixtureStore(dbPath);
      store.close();
      const db = new Database(dbPath);
      db.exec('DROP INDEX idx_connector_store_items_sender_label;');
      db.close();
      expect(() => openFixtureStore(dbPath)).toThrow(/idx_connector_store_items_sender_label/);
    });
  });
});

function openFixtureStore(dbPath: string): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath,
    corpusId: 'internal.fixture.messages',
    family: 'chat',
    trustDomain: 'internal',
    now: () => FIXED_NOW,
  });
}

function createCurrentV4Fixture(dbPath: string): FixtureData {
  const db = new Database(dbPath, { create: true });
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_version (
        store_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE sync_runs (
        sync_run_id TEXT PRIMARY KEY,
        corpus_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        status TEXT NOT NULL,
        cursor TEXT,
        items_seen INTEGER NOT NULL DEFAULT 0,
        items_indexed INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        audit_receipt_sha256 TEXT
      );
      CREATE TABLE items (
        item_pk INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        family TEXT NOT NULL,
        account_scope TEXT NOT NULL,
        provider_item_id TEXT NOT NULL,
        provider_thread_id TEXT,
        provider_conversation_id TEXT,
        provider_file_id TEXT,
        provider_event_id TEXT,
        local_item_id TEXT NOT NULL,
        source_version TEXT,
        title TEXT,
        search_text TEXT,
        locator_uri TEXT,
        mime_type TEXT NOT NULL,
        authored_at TEXT,
        updated_at TEXT,
        fetched_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        content_hash TEXT,
        trust_tier TEXT NOT NULL,
        tombstoned INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        sync_run_id TEXT NOT NULL,
        UNIQUE(provider, account_scope, provider_item_id),
        FOREIGN KEY(sync_run_id) REFERENCES sync_runs(sync_run_id)
      );
      CREATE INDEX idx_items_local_item_id ON items(local_item_id);
      CREATE TABLE chunks (
        chunk_pk INTEGER PRIMARY KEY,
        item_pk INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        bounded_text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        embedding_input_hash TEXT,
        UNIQUE(item_pk, chunk_index),
        FOREIGN KEY(item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
      );
      CREATE VIRTUAL TABLE connector_store_fts USING fts5(
        title,
        bounded_text,
        item_pk UNINDEXED,
        chunk_pk UNINDEXED
      );
      CREATE TABLE chunk_embeddings (
        chunk_pk INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        item_pk INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        embedded_at TEXT NOT NULL,
        PRIMARY KEY (chunk_pk, model_id),
        FOREIGN KEY(chunk_pk) REFERENCES chunks(chunk_pk) ON DELETE CASCADE
      );
      CREATE INDEX idx_connector_store_chunk_embeddings_item
        ON chunk_embeddings(item_pk, model_id);
      CREATE TABLE item_owners (
        item_pk INTEGER NOT NULL,
        connector_id TEXT NOT NULL,
        ownership_kind TEXT NOT NULL CHECK(ownership_kind IN ('observed', 'preservation')),
        first_seen_sync_run_id TEXT NOT NULL,
        last_seen_sync_run_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(item_pk, connector_id),
        FOREIGN KEY(item_pk) REFERENCES items(item_pk) ON DELETE CASCADE,
        FOREIGN KEY(first_seen_sync_run_id) REFERENCES sync_runs(sync_run_id),
        FOREIGN KEY(last_seen_sync_run_id) REFERENCES sync_runs(sync_run_id)
      );
      CREATE INDEX idx_connector_store_item_owners_connector
        ON item_owners(connector_id, ownership_kind, last_seen_sync_run_id);
    `);
    db.query('INSERT INTO schema_version (store_id, version, applied_at) VALUES (?, 4, ?)')
      .run(STORE_ID, FIXED_NOW.toISOString());
    const insertRun = db.query(`
      INSERT INTO sync_runs (
        sync_run_id, corpus_id, connector_id, status, items_seen, items_indexed,
        started_at, completed_at, audit_receipt_sha256
      ) VALUES (?, 'internal.fixture.messages', ?, 'completed', 1, 1, ?, ?, ?)
    `);
    insertRun.run('run-alpha', 'connector-alpha', '2026-07-20T10:00:00.000Z', '2026-07-20T10:01:00.000Z', 'a'.repeat(64));
    insertRun.run('run-beta', 'connector-beta', '2026-07-21T10:00:00.000Z', '2026-07-21T10:01:00.000Z', 'b'.repeat(64));

    const insertItem = db.query(`
      INSERT INTO items (
        item_pk, provider, family, account_scope, provider_item_id,
        provider_conversation_id, local_item_id, source_version, title,
        search_text, locator_uri, mime_type, authored_at, updated_at,
        fetched_at, indexed_at, content_hash, trust_tier, sync_run_id
      ) VALUES (?, ?, 'chat', 'fixture-account', ?, ?, ?, 'fixture-v1', ?, ?, ?,
        'text/plain', ?, ?, ?, ?, ?, 'S2', ?)
    `);
    insertItem.run(
      101,
      'source-alpha',
      'alpha-1',
      null,
      'source-alpha:alpha-1',
      'Alpha fixture',
      'alpha fixture search',
      'fixture://alpha',
      '2026-07-20T09:00:00.000Z',
      '2026-07-20T09:00:00.000Z',
      '2026-07-20T10:00:00.000Z',
      '2026-07-20T10:01:00.000Z',
      'alpha-content-hash',
      'run-alpha',
    );
    insertItem.run(
      202,
      'source-beta',
      'beta-1',
      'conversation-beta',
      'source-beta:conversation-beta:beta-1',
      'Beta fixture',
      'beta fixture search',
      'fixture://beta',
      '2026-07-21T09:00:00.000Z',
      '2026-07-21T09:00:00.000Z',
      '2026-07-21T10:00:00.000Z',
      '2026-07-21T10:01:00.000Z',
      'beta-content-hash',
      'run-beta',
    );

    const insertChunk = db.query(`
      INSERT INTO chunks (
        chunk_pk, item_pk, chunk_index, bounded_text, content_hash,
        embedding_input_hash, indexed_at
      ) VALUES (?, ?, 0, ?, ?, ?, ?)
    `);
    insertChunk.run(1001, 101, 'synthetic alpha passage', 'alpha-chunk-hash', 'alpha-embedding-hash', '2026-07-20T10:01:00.000Z');
    insertChunk.run(2002, 202, 'synthetic beta passage', 'beta-chunk-hash', 'beta-embedding-hash', '2026-07-21T10:01:00.000Z');
    db.query('INSERT INTO connector_store_fts (title, bounded_text, item_pk, chunk_pk) VALUES (?, ?, ?, ?)')
      .run('Alpha fixture', 'synthetic alpha passage', 101, 1001);
    db.query('INSERT INTO connector_store_fts (title, bounded_text, item_pk, chunk_pk) VALUES (?, ?, ?, ?)')
      .run('Beta fixture', 'synthetic beta passage', 202, 2002);

    const insertEmbedding = db.query(`
      INSERT INTO chunk_embeddings (
        chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at
      ) VALUES (?, 'fixture-model', ?, ?, ?, ?)
    `);
    insertEmbedding.run(1001, 101, 'alpha-embedding-hash', new Uint8Array([1, 2, 3, 4]), '2026-07-20T10:02:00.000Z');
    insertEmbedding.run(2002, 202, 'beta-embedding-hash', new Uint8Array([5, 6, 7, 8]), '2026-07-21T10:02:00.000Z');
    const insertOwner = db.query(`
      INSERT INTO item_owners (
        item_pk, connector_id, ownership_kind, first_seen_sync_run_id,
        last_seen_sync_run_id, first_seen_at, last_seen_at
      ) VALUES (?, ?, 'observed', ?, ?, ?, ?)
    `);
    insertOwner.run(101, 'connector-alpha', 'run-alpha', 'run-alpha', '2026-07-20T10:00:00.000Z', '2026-07-20T10:01:00.000Z');
    insertOwner.run(202, 'connector-beta', 'run-beta', 'run-beta', '2026-07-21T10:00:00.000Z', '2026-07-21T10:01:00.000Z');
    return fixtureData(db);
  } finally {
    db.close();
  }
}

function inspectFixture(dbPath: string): {
  version: number;
  data: FixtureData;
  identities: unknown[];
  identityIndexColumns: string[];
  senders: unknown[];
  senderIndexes: string[];
  reactions: unknown[];
  foreignKeyErrors: unknown[];
} {
  const db = new Database(dbPath);
  try {
    const version = db.query('SELECT version FROM schema_version WHERE store_id = ?')
      .get(STORE_ID) as { version: number };
    const identityIndex = (db.query('PRAGMA index_list(items)').all() as Array<{ name: string; unique: number }>)
      .find((row) => row.unique === 1);
    return {
      version: version.version,
      data: fixtureData(db),
      identities: db.query(`
        SELECT provider, provider_item_id, provider_conversation_id, normalized_conversation
        FROM items WHERE item_pk IN (101, 202) ORDER BY item_pk
      `).all(),
      identityIndexColumns: identityIndex
        ? (db.query(`PRAGMA index_info(${identityIndex.name})`).all() as Array<{ name: string }>).map((row) => row.name)
        : [],
      senders: db.query(`
        SELECT item_pk, sender_id, sender_label, sender_is_owner
        FROM items WHERE item_pk IN (101, 202) ORDER BY item_pk
      `).all(),
      senderIndexes: (db.query('PRAGMA index_list(items)').all() as Array<{ name: string }>)
        .map((row) => row.name)
        .filter((name) => name.startsWith('idx_connector_store_items_sender_'))
        .sort(),
      reactions: db.query(`
        SELECT item_pk, reactions_json
        FROM items WHERE item_pk IN (101, 202) ORDER BY item_pk
      `).all(),
      foreignKeyErrors: db.query('PRAGMA foreign_key_check').all(),
    };
  } finally {
    db.close();
  }
}

interface FixtureData {
  items: unknown[];
  chunks: unknown[];
  fts: unknown[];
  embeddings: unknown[];
  owners: unknown[];
}

function fixtureData(db: Database): FixtureData {
  return {
    items: db.query(`
      SELECT
        item_pk, provider, family, account_scope, provider_item_id,
        provider_thread_id, provider_conversation_id, provider_file_id,
        provider_event_id, local_item_id, source_version, title, search_text,
        locator_uri, mime_type, authored_at, updated_at, fetched_at, indexed_at,
        content_hash, trust_tier, tombstoned, deleted_at, sync_run_id
      FROM items ORDER BY item_pk
    `).all(),
    chunks: db.query('SELECT * FROM chunks ORDER BY chunk_pk').all(),
    fts: db.query(`
      SELECT title, bounded_text, item_pk, chunk_pk
      FROM connector_store_fts ORDER BY CAST(item_pk AS INTEGER), CAST(chunk_pk AS INTEGER)
    `).all(),
    embeddings: db.query(`
      SELECT chunk_pk, model_id, item_pk, content_hash, HEX(embedding) AS embedding_hex, embedded_at
      FROM chunk_embeddings ORDER BY chunk_pk, model_id
    `).all(),
    owners: db.query('SELECT * FROM item_owners ORDER BY item_pk, connector_id').all(),
  };
}

function conversationItem(conversationId: string, text: string): RawItem {
  return {
    identity: {
      family: 'chat',
      provider: 'telegram-fixture',
      accountScope: 'fixture-account',
      providerItemId: 'shared-message',
      providerConversationId: conversationId,
      localItemId: `telegram:${conversationId}:shared-message`,
      sourceVersion: 'fixture-v1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text },
    metadata: Object.freeze({
      title: `Conversation ${conversationId}`,
      authoredAt: '2026-07-22T11:00:00.000Z',
    }),
    fetchedAt: '2026-07-22T11:01:00.000Z',
  };
}

function conversationConnector(items: readonly RawItem[]): SourceConnector {
  const byLocalId = new Map(items.map((item) => [item.identity.localItemId, item]));
  return {
    id: 'telegram-fixture-connector',
    family: 'chat',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = byLocalId.get(localItemId);
      if (!item) throw new Error('missing synthetic conversation fixture');
      return item;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' });
    },
  };
}

function createSchemaVersionTable(db: Database, version: number): void {
  db.exec(`
    CREATE TABLE schema_version (
      store_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  db.query('INSERT INTO schema_version (store_id, version, applied_at) VALUES (?, ?, ?)')
    .run(STORE_ID, version, FIXED_NOW.toISOString());
}

async function withDatabasePath<T>(run: (dbPath: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'connector-store-conversation-identity-'));
  try {
    return await run(join(dir, 'store.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
