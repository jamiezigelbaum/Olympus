import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { backfillWhatsAppConnectorStoreIdentities } from '../scripts/whatsapp-identity-backfill.ts';

const ACCOUNT = 'personal';
const CORPUS = 'secure_local.whatsapp.messages';

describe('WhatsApp identity backfill FTS ownership', () => {
  test('--apply keeps the fts row ownership map pointing at the rows it wrote', async () => {
    const storePath = await seededStore();

    applyBackfill(storePath);

    const db = new Database(storePath);
    const ftsRowids = (db.query('SELECT rowid AS id FROM connector_store_fts ORDER BY rowid').all() as Array<{ id: number }>)
      .map((row) => row.id);
    const mappedRowids = (db.query('SELECT fts_rowid AS id FROM connector_store_fts_rows ORDER BY fts_rowid').all() as Array<{ id: number }>)
      .map((row) => row.id);
    db.close();

    // A count check passes even when every mapping dangles, which is why the
    // store's own reopen validation cannot see this: compare the rowids.
    expect(ftsRowids).toEqual(mappedRowids);
  });

  test('a sync after --apply leaves the store openable', async () => {
    const storePath = await seededStore();

    applyBackfill(storePath);

    const resumed = new LocalConnectorStore({
      dbPath: storePath,
      corpusId: CORPUS,
      family: 'chat',
      trustDomain: 'secure_local',
    });
    await resumed.syncFromConnector(createConnector(fixtureMessages()), { fetchContent: true });
    resumed.close();

    const reopened = new LocalConnectorStore({
      dbPath: storePath,
      corpusId: CORPUS,
      family: 'chat',
      trustDomain: 'secure_local',
    });
    expect(reopened.searchItems('Jane Doe', 10).length).toBeGreaterThan(0);
    reopened.close();
  });
});

async function seededStore(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-identity-backfill-fts-'));
  const storePath = join(dir, 'connector-store.db');
  const store = new LocalConnectorStore({
    dbPath: storePath,
    corpusId: CORPUS,
    family: 'chat',
    trustDomain: 'secure_local',
  });
  await store.syncFromConnector(createConnector(fixtureMessages()), { fetchContent: true });
  store.close();
  return storePath;
}

function applyBackfill(storePath: string): void {
  const sessionDb = createSessionDb(join(storePath, '..', 'session.db'));
  const storeDb = new Database(storePath);
  try {
    const summary = backfillWhatsAppConnectorStoreIdentities({
      connectorStoreDb: storeDb,
      sessionDb,
      apply: true,
    });
    expect(summary.fts_rows_rebuilt).toBeGreaterThan(0);
  } finally {
    storeDb.close();
    sessionDb.close();
  }
}

function fixtureMessages(): RawItem[] {
  return [
    message('live-1', '98765430001111@lid', 'school form tomorrow'),
    message('export-1', 'Jane Doe', 'old exported message'),
  ];
}

function createConnector(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'whatsapp-live',
    family: 'chat',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const found = items.find((item) => item.identity.localItemId === localItemId);
      if (!found) throw new Error(`missing item ${localItemId}`);
      return found;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}

function message(id: string, conversationId: string, text: string): RawItem {
  return {
    identity: {
      family: 'chat',
      provider: 'whatsapp',
      accountScope: ACCOUNT,
      providerItemId: id,
      providerConversationId: conversationId,
      localItemId: `${ACCOUNT}:${id}`,
      sourceVersion: '2026-07-09T12:00:00Z',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text },
    metadata: Object.freeze({
      chat: conversationId,
      sender: conversationId,
      sentAt: '2026-07-09T12:00:00Z',
    }),
    fetchedAt: '2026-07-09T12:00:01Z',
  };
}

function createSessionDb(path: string): Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS whatsmeow_contacts (
      our_jid TEXT NOT NULL,
      their_jid TEXT NOT NULL,
      first_name TEXT,
      full_name TEXT,
      push_name TEXT,
      business_name TEXT,
      redacted_phone TEXT
    );
  `);
  db.query('INSERT OR REPLACE INTO whatsmeow_lid_map (lid, pn) VALUES (?, ?)')
    .run('98765430001111', '15551230001');
  db.query('INSERT OR REPLACE INTO whatsmeow_lid_map (lid, pn) VALUES (?, ?)')
    .run('98765430002222', '15551230002');
  const insert = db.query(`
    INSERT INTO whatsmeow_contacts (our_jid, their_jid, first_name, full_name, push_name, business_name, redacted_phone)
    VALUES ('15551230003@s.whatsapp.net', ?, NULL, ?, NULL, NULL, NULL)
  `);
  insert.run('15551230001@s.whatsapp.net', 'Jane Doe');
  insert.run('15551230002@s.whatsapp.net', 'Jane Doe');
  return db;
}
