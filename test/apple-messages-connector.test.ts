// Contract 1 (SourceConnector) conformance tests for the Apple Messages
// connector. Everything runs against fixture chat.db files built with the
// real minimal schema (message, chat, handle, chat_message_join) in a temp
// directory — no live ~/Library/Messages access, no Full Disk Access needed.

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { createAppleMessagesSourceConnector } from '../src/workers/apple-messages/index.ts';

const ACCOUNT = 'personal';
const APPLE_EPOCH_UNIX_SECONDS = 978_307_200;
const CHAT_IDENTIFIER = 'iMessage;-;jordan@example.com';
const LONG_TEXT = 'attributedBody long payload '.repeat(8).trim(); // > 127 bytes, exercises the 0x81 length prefix

const fixtureDir = mkdtempSync(join(tmpdir(), 'olympus-apple-messages-'));
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

function appleSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000) - APPLE_EPOCH_UNIX_SECONDS;
}

function appleNanoseconds(iso: string): number {
  return appleSeconds(iso) * 1_000_000_000;
}

// Builds an attributedBody blob in the typedstream shape the connector's
// documented best-effort decoder understands: streamtyped header, class chain,
// `NSString`, the inline-string marker 0x2B, a typedstream length prefix
// (single byte, or 0x81 + uint16le for longer payloads), then UTF-8 bytes.
function typedstreamAttributedBody(text: string): Uint8Array {
  const encoder = new TextEncoder();
  const payload = encoder.encode(text);
  const lengthBytes = payload.byteLength < 128
    ? [payload.byteLength]
    : [0x81, payload.byteLength & 0xff, (payload.byteLength >> 8) & 0xff];
  return Uint8Array.from([
    0x04, 0x0b, ...encoder.encode('streamtyped'),
    0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84,
    0x19, ...encoder.encode('NSMutableAttributedString'), 0x00,
    0x84, 0x84, 0x12, ...encoder.encode('NSAttributedString'), 0x00,
    0x84, 0x84, 0x08, ...encoder.encode('NSObject'), 0x00,
    0x85, 0x92, 0x84, 0x84, 0x84,
    0x08, ...encoder.encode('NSString'), 0x01,
    0x94, 0x84, 0x01, 0x2b,
    ...lengthBytes,
    ...payload,
    0x86, 0x84, 0x02, 0x69, 0x49,
  ]);
}

interface FixtureMessage {
  guid: string;
  text?: string | null;
  attributedBody?: Uint8Array | null;
  handleId?: number;
  date?: number;
  isFromMe?: boolean;
  service?: string | null;
  chatId?: number;
}

function createChatDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT 'iMessage'
    );
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL,
      chat_identifier TEXT NOT NULL,
      service_name TEXT
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      text TEXT,
      attributedBody BLOB,
      handle_id INTEGER NOT NULL DEFAULT 0,
      date INTEGER NOT NULL DEFAULT 0,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      service TEXT
    );
    CREATE TABLE chat_message_join (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      message_date INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, message_id)
    );
  `);
  return db;
}

function lastInsertRowid(db: Database): number {
  const row = db.query('SELECT last_insert_rowid() AS rowid').get() as { rowid: number };
  return row.rowid;
}

function insertHandle(db: Database, id: string): number {
  db.query('INSERT INTO handle (id) VALUES (?)').run(id);
  return lastInsertRowid(db);
}

function insertChat(db: Database, chatIdentifier: string): number {
  db.query('INSERT INTO chat (guid, chat_identifier) VALUES (?, ?)').run(`chat-${chatIdentifier}`, chatIdentifier);
  return lastInsertRowid(db);
}

function insertMessage(db: Database, message: FixtureMessage): number {
  db.query(
    'INSERT INTO message (guid, text, attributedBody, handle_id, date, is_from_me, service) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    message.guid,
    message.text ?? null,
    message.attributedBody ?? null,
    message.handleId ?? 0,
    message.date ?? 0,
    message.isFromMe ? 1 : 0,
    message.service === undefined ? 'iMessage' : message.service,
  );
  const rowid = lastInsertRowid(db);
  if (message.chatId !== undefined) {
    db.query('INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)')
      .run(message.chatId, rowid, message.date ?? 0);
  }
  return rowid;
}

function buildMainFixture(path: string): void {
  const db = createChatDb(path);
  const jordan = insertHandle(db, 'jordan@example.com');
  const chat = insertChat(db, CHAT_IDENTIFIER);
  insertMessage(db, {
    guid: 'guid-inbound-nanos',
    text: 'Lisbon next month?',
    handleId: jordan,
    date: appleNanoseconds('2026-06-01T10:00:00Z'),
    chatId: chat,
  });
  insertMessage(db, {
    guid: 'guid-outbound-seconds',
    text: 'Booked the flat for June.',
    isFromMe: true,
    date: appleSeconds('2026-06-02T09:30:00Z'),
    chatId: chat,
  });
  insertMessage(db, {
    guid: 'guid-attributed',
    text: null,
    attributedBody: typedstreamAttributedBody('Decoded from the attributedBody typedstream.'),
    handleId: jordan,
    date: appleNanoseconds('2026-06-03T08:00:00Z'),
    service: 'SMS',
    chatId: chat,
  });
  insertMessage(db, {
    guid: 'guid-attributed-long',
    text: null,
    attributedBody: typedstreamAttributedBody(LONG_TEXT),
    handleId: jordan,
    date: appleNanoseconds('2026-06-03T08:05:00Z'),
    chatId: chat,
  });
  insertMessage(db, {
    guid: 'guid-attachment-only',
    text: null,
    attributedBody: Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x10, 0x42]),
    handleId: jordan,
    date: appleNanoseconds('2026-06-03T09:00:00Z'),
    chatId: chat,
  });
  insertMessage(db, {
    guid: 'guid-no-chat',
    text: 'orphan message without a chat row',
    handleId: jordan,
    date: appleNanoseconds('2026-06-04T12:00:00Z'),
  });
  db.close();
}

const mainDbPath = join(fixtureDir, 'chat.db');
buildMainFixture(mainDbPath);

function mainConnector(): SourceConnector {
  return createAppleMessagesSourceConnector({ chatDbPath: mainDbPath, account: ACCOUNT });
}

async function drain(pages: AsyncIterable<SourceConnectorListPage>): Promise<SourceConnectorListPage[]> {
  const collected: SourceConnectorListPage[] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

async function listAll(connector: SourceConnector): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for await (const page of connector.listItems()) items.push(...page.items);
  return items;
}

function itemByGuid(items: RawItem[], guid: string): RawItem {
  const item = items.find((candidate) => candidate.identity.providerItemId === guid);
  if (!item) throw new Error(`fixture item ${guid} missing from listing`);
  return item;
}

describe('Apple Messages SourceConnector (Contract 1)', () => {
  test('exposes the frozen contract identity', () => {
    const connector = mainConnector();
    expect(connector.id).toBe('apple_messages');
    expect(connector.family).toBe('chat');
  });

  test('authenticate succeeds against a readable chat.db', async () => {
    await expect(mainConnector().authenticate()).resolves.toBeUndefined();
  });

  test('authenticate surfaces a Full Disk Access hint when the path is missing', async () => {
    const connector = createAppleMessagesSourceConnector({
      chatDbPath: join(fixtureDir, 'does-not-exist', 'chat.db'),
      account: ACCOUNT,
    });
    await expect(connector.authenticate()).rejects.toThrow(/Full Disk Access/);
  });

  test('authenticate surfaces a Full Disk Access hint when the file is not sqlite', async () => {
    const bogusPath = join(fixtureDir, 'not-a-database.db');
    writeFileSync(bogusPath, 'this is just text, not a sqlite database');
    const connector = createAppleMessagesSourceConnector({ chatDbPath: bogusPath, account: ACCOUNT });
    await expect(connector.authenticate()).rejects.toThrow(/Full Disk Access/);
  });

  test('authenticate rejects sqlite files that are not a Messages chat.db', async () => {
    const otherDbPath = join(fixtureDir, 'other.db');
    const db = new Database(otherDbPath, { create: true });
    db.exec('CREATE TABLE notes (body TEXT)');
    db.close();
    const connector = createAppleMessagesSourceConnector({ chatDbPath: otherDbPath, account: ACCOUNT });
    await expect(connector.authenticate()).rejects.toThrow(/no message table/);
  });

  test('listItems maps text messages to contract RawItems', async () => {
    const items = await listAll(mainConnector());
    const item = itemByGuid(items, 'guid-inbound-nanos');

    expect(item.identity).toEqual({
      family: 'chat',
      provider: 'apple_messages',
      accountScope: ACCOUNT,
      providerItemId: 'guid-inbound-nanos',
      providerConversationId: CHAT_IDENTIFIER,
      localItemId: 'personal:guid-inbound-nanos',
    });
    expect(item.mimeType).toBe('text/plain');
    expect(item.content).toEqual({ kind: 'text', text: 'Lisbon next month?' });
    expect(item.metadata).toEqual({
      sender: 'jordan@example.com',
      chat_identifier: CHAT_IDENTIFIER,
      sent_at: '2026-06-01T10:00:00.000Z',
      service: 'iMessage',
    });
  });

  test('is_from_me messages report me as the sender', async () => {
    const items = await listAll(mainConnector());
    const item = itemByGuid(items, 'guid-outbound-seconds');

    expect(item.metadata.sender).toBe('me');
    expect(item.content).toEqual({ kind: 'text', text: 'Booked the flat for June.' });
  });

  test('handles both Apple-epoch date encodings (seconds and nanoseconds)', async () => {
    const items = await listAll(mainConnector());

    expect(itemByGuid(items, 'guid-inbound-nanos').metadata.sent_at).toBe('2026-06-01T10:00:00.000Z');
    expect(itemByGuid(items, 'guid-outbound-seconds').metadata.sent_at).toBe('2026-06-02T09:30:00.000Z');
  });

  test('decodes attributedBody typedstream when text is null', async () => {
    const items = await listAll(mainConnector());
    const short = itemByGuid(items, 'guid-attributed');
    const long = itemByGuid(items, 'guid-attributed-long');

    expect(short.content).toEqual({ kind: 'text', text: 'Decoded from the attributedBody typedstream.' });
    expect(short.metadata.service).toBe('SMS');
    expect(long.content).toEqual({ kind: 'text', text: LONG_TEXT });
  });

  test('falls back to metadata_only when attributedBody cannot be decoded', async () => {
    const items = await listAll(mainConnector());
    const item = itemByGuid(items, 'guid-attachment-only');

    expect(item.content).toEqual({ kind: 'metadata_only' });
    expect(item.metadata.sender).toBe('jordan@example.com');
    expect(item.metadata.sent_at).toBe('2026-06-03T09:00:00.000Z');
  });

  test('omits the conversation id when a message has no chat row', async () => {
    const items = await listAll(mainConnector());
    const item = itemByGuid(items, 'guid-no-chat');

    expect(item.identity.providerConversationId).toBeUndefined();
    expect('chat_identifier' in item.metadata).toBe(false);
    expect(item.content).toEqual({ kind: 'text', text: 'orphan message without a chat row' });
  });

  test('never emits tombstones: every row is a plain item', async () => {
    const items = await listAll(mainConnector());

    expect(items).toHaveLength(6);
    for (const item of items) {
      expect('deleted' in item.metadata).toBe(false);
      expect(['text', 'metadata_only']).toContain(item.content.kind);
    }
  });

  test('paginates by ROWID cursor and resumes from a provided cursor', async () => {
    const dbPath = join(fixtureDir, 'pagination.db');
    const db = createChatDb(dbPath);
    const chat = insertChat(db, 'iMessage;-;+15550001111');
    const handle = insertHandle(db, '+15550001111');
    for (let index = 1; index <= 5; index += 1) {
      insertMessage(db, {
        guid: `p-${index}`,
        text: `message ${index}`,
        handleId: handle,
        date: appleNanoseconds('2026-06-01T10:00:00Z') + index,
        chatId: chat,
      });
    }
    db.close();
    const connector = createAppleMessagesSourceConnector({ chatDbPath: dbPath, account: ACCOUNT });

    const pages = await drain(connector.listItems({ limit: 2 }));

    expect(pages.map((page) => page.items.map((item) => item.identity.providerItemId))).toEqual([
      ['p-1', 'p-2'],
      ['p-3', 'p-4'],
      ['p-5'],
    ]);
    expect(pages.map((page) => page.nextCursor)).toEqual(['2', '4', '5']);
    expect(pages.map((page) => page.done)).toEqual([false, false, true]);

    const resumed = await drain(connector.listItems({ cursor: '2', limit: 2 }));
    expect(resumed.map((page) => page.items.map((item) => item.identity.providerItemId))).toEqual([
      ['p-3', 'p-4'],
      ['p-5'],
    ]);
    expect(resumed[1]?.done).toBe(true);
  });

  test('sinceDays filters out old messages in both date encodings', async () => {
    const dbPath = join(fixtureDir, 'since-days.db');
    const db = createChatDb(dbPath);
    const chat = insertChat(db, 'iMessage;-;+15550002222');
    const handle = insertHandle(db, '+15550002222');
    const nowAppleSeconds = Math.floor(Date.now() / 1000) - APPLE_EPOCH_UNIX_SECONDS;
    insertMessage(db, {
      guid: 'recent-nanos',
      text: 'sent yesterday',
      handleId: handle,
      date: (nowAppleSeconds - 86_400) * 1_000_000_000,
      chatId: chat,
    });
    insertMessage(db, {
      guid: 'old-seconds',
      text: 'sent in 2020 (seconds encoding)',
      handleId: handle,
      date: appleSeconds('2020-01-01T00:00:00Z'),
      chatId: chat,
    });
    insertMessage(db, {
      guid: 'old-nanos',
      text: 'sent in 2019 (nanosecond encoding)',
      handleId: handle,
      date: appleNanoseconds('2019-06-15T00:00:00Z'),
      chatId: chat,
    });
    db.close();
    const connector = createAppleMessagesSourceConnector({ chatDbPath: dbPath, account: ACCOUNT, sinceDays: 30 });

    const items = await listAll(connector);

    expect(items.map((item) => item.identity.providerItemId)).toEqual(['recent-nanos']);
  });

  test('fetchItem re-reads one message by guid', async () => {
    const item = await mainConnector().fetchItem('personal:guid-attributed');

    expect(item.identity.providerItemId).toBe('guid-attributed');
    expect(item.identity.localItemId).toBe('personal:guid-attributed');
    expect(item.identity.providerConversationId).toBe(CHAT_IDENTIFIER);
    expect(item.content).toEqual({ kind: 'text', text: 'Decoded from the attributedBody typedstream.' });
    expect(item.metadata.service).toBe('SMS');
  });

  test('fetchItem rejects local item ids outside the connector account', async () => {
    await expect(mainConnector().fetchItem('work:guid-attributed')).rejects.toThrow(/personal:<message guid>/);
  });

  test('fetchItem rejects unknown guids', async () => {
    await expect(mainConnector().fetchItem('personal:guid-never-existed')).rejects.toThrow(/not found/);
  });

  test('classify is ALWAYS S4/secure_local, for every content kind', async () => {
    const connector = mainConnector();
    const items = await listAll(connector);
    const expected = {
      trustTier: 'S4',
      trustDomain: 'secure_local',
      localOnly: true,
      cloudEmbeddingEligible: false,
    } as const;

    expect(connector.classify(itemByGuid(items, 'guid-inbound-nanos'))).toEqual(expected);
    expect(connector.classify(itemByGuid(items, 'guid-attachment-only'))).toEqual(expected);
    const secretLooking: RawItem = {
      ...itemByGuid(items, 'guid-inbound-nanos'),
      content: { kind: 'text', text: 'my aws key is AKIAABCDEFGHIJKLMNOP' },
    };
    expect(connector.classify(secretLooking)).toEqual(expected);
  });
});
