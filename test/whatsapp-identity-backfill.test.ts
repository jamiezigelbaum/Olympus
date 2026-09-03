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

describe('WhatsApp identity backfill', () => {
  test('resolves existing LID conversations and same-name export aliases without exposing message text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-identity-backfill-'));
    const storePath = join(dir, 'connector-store.db');
    const sessionPath = join(dir, 'session.db');

    const store = new LocalConnectorStore({
      dbPath: storePath,
      corpusId: 'secure_local.whatsapp.messages',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    await store.syncFromConnector(createConnector([
      message('live-1', '98765430001111@lid', '98765430001111@lid', '98765430001111@lid', 'school form tomorrow'),
      message('export-1', 'Jane Doe', 'Jane Doe', 'Jane Doe', 'old exported message'),
    ]), { fetchContent: true });

    expect(store.searchItems('Jane Doe', 10).map((hit) => hit.sourceItem.providerItemId)).toEqual(['export-1']);
    store.close();

    const sessionDb = createSessionDb(sessionPath);
    const dryStoreDb = new Database(storePath);
    const dryRun = backfillWhatsAppConnectorStoreIdentities({
      connectorStoreDb: dryStoreDb,
      sessionDb,
      apply: false,
    });
    dryStoreDb.close();
    expect(dryRun).toMatchObject({
      dry_run: true,
      items_scanned: 2,
      items_matched: 2,
      items_updated: 2,
      lid_conversations_matched: 1,
      export_name_aliases_matched: 1,
      fts_rows_rebuilt: 0,
      policy: { direct_db_mutation: false, network_used: false },
    });

    const applyStoreDb = new Database(storePath);
    const applied = backfillWhatsAppConnectorStoreIdentities({
      connectorStoreDb: applyStoreDb,
      sessionDb,
      apply: true,
    });
    applyStoreDb.close();
    sessionDb.close();
    expect(applied.items_updated).toBe(2);
    expect(applied.fts_rows_rebuilt).toBe(2);

    const reopened = new LocalConnectorStore({
      dbPath: storePath,
      corpusId: 'secure_local.whatsapp.messages',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    const hits = reopened.searchItems('Jane Doe', 10);
    expect(hits.map((hit) => hit.sourceItem.providerItemId)).toContain('live-1');
    expect(hits.find((hit) => hit.sourceItem.providerItemId === 'live-1')?.title).toBe('Jane Doe');
    expect(reopened.searchItems('15551230002', 10).map((hit) => hit.sourceItem.providerItemId)).toContain('export-1');
    expect(reopened.localContent(`${ACCOUNT}:live-1`)?.chunks).toEqual(['school form tomorrow']);
    reopened.close();
  });
});

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

function message(id: string, conversationId: string, chat: string, sender: string, text: string): RawItem {
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
      chat,
      sender,
      sentAt: '2026-07-09T12:00:00Z',
    }),
    fetchedAt: '2026-07-09T12:00:01Z',
  };
}

function createSessionDb(path: string): Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT NOT NULL);
    CREATE TABLE whatsmeow_contacts (
      our_jid TEXT NOT NULL,
      their_jid TEXT NOT NULL,
      first_name TEXT,
      full_name TEXT,
      push_name TEXT,
      business_name TEXT,
      redacted_phone TEXT
    );
  `);
  db.query('INSERT INTO whatsmeow_lid_map (lid, pn) VALUES (?, ?)')
    .run('98765430001111', '15551230001');
  db.query('INSERT INTO whatsmeow_lid_map (lid, pn) VALUES (?, ?)')
    .run('98765430002222', '15551230002');
  const insert = db.query(`
    INSERT INTO whatsmeow_contacts (our_jid, their_jid, first_name, full_name, push_name, business_name, redacted_phone)
    VALUES ('15551230003@s.whatsapp.net', ?, NULL, ?, NULL, NULL, NULL)
  `);
  insert.run('15551230001@s.whatsapp.net', 'Jane Doe');
  insert.run('15551230002@s.whatsapp.net', 'Jane Doe');
  return db;
}
