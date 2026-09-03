// Contract 1 (SourceConnector) conformance tests for the WhatsApp export
// connector. Everything runs against real fixture exports on disk: both
// standard header formats, multiline continuations, system lines (surfaced as
// metadata-only items), zip archives (stored + deflated entries), offset
// cursor pagination, deterministic ids, and the S4/secure_local floor.

import { describe, expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import {
  createWhatsAppSourceConnector,
  parseWhatsAppChatExport,
  whatsAppChatNameFromExportFilename,
} from '../src/workers/whatsapp/index.ts';

const ACCOUNT = 'personal';
const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'whatsapp');

function fixtureConnector(): SourceConnector {
  return createWhatsAppSourceConnector({ exportDir: FIXTURE_DIR, account: ACCOUNT });
}

async function drain(pages: AsyncIterable<SourceConnectorListPage>): Promise<SourceConnectorListPage[]> {
  const collected: SourceConnectorListPage[] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

async function drainItems(connector: SourceConnector, options?: { cursor?: string; limit?: number }): Promise<RawItem[]> {
  const pages = await drain(connector.listItems(options));
  return pages.flatMap((page) => [...page.items]);
}

// Minimal zip writer for fixtures: enough of the format (local headers,
// central directory, end-of-central-directory) for the connector's reader.
function zipFixture(entries: { name: string; text: string; deflate?: boolean }[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.text, 'utf8');
    const data = entry.deflate ? deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    localChunks.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralChunks);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, centralDirectory, endRecord]);
}

describe('WhatsApp SourceConnector (Contract 1)', () => {
  test('exposes the frozen contract identity', () => {
    const connector = fixtureConnector();
    expect(connector.id).toBe('whatsapp');
    expect(connector.family).toBe('chat');
  });

  test('authenticate accepts a directory with parseable exports', async () => {
    await expect(fixtureConnector().authenticate()).resolves.toBeUndefined();
  });

  test('authenticate rejects a missing directory', async () => {
    const connector = createWhatsAppSourceConnector({
      exportDir: join(FIXTURE_DIR, 'does-not-exist'),
      account: ACCOUNT,
    });
    await expect(connector.authenticate()).rejects.toThrow(/does not exist/);
  });

  test('authenticate rejects an empty directory', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'whatsapp-empty-'));
    const connector = createWhatsAppSourceConnector({ exportDir: emptyDir, account: ACCOUNT });
    await expect(connector.authenticate()).rejects.toThrow(/no \.txt or \.zip chat exports/);
  });

  test('authenticate rejects a directory whose exports do not parse', async () => {
    const junkDir = mkdtempSync(join(tmpdir(), 'whatsapp-junk-'));
    writeFileSync(join(junkDir, 'notes.txt'), 'not a whatsapp export\njust some prose\n');
    const connector = createWhatsAppSourceConnector({ exportDir: junkDir, account: ACCOUNT });
    await expect(connector.authenticate()).rejects.toThrow(/no parseable chat export/);
  });

  test('extracts the chat name from export file names', () => {
    expect(whatsAppChatNameFromExportFilename('WhatsApp Chat with Ana Silva.txt')).toBe('Ana Silva');
    expect(whatsAppChatNameFromExportFilename('WhatsApp Chat - Lisbon Plans.zip')).toBe('Lisbon Plans');
    expect(whatsAppChatNameFromExportFilename('random-export.txt')).toBe('random-export');
  });

  test('listItems parses both header formats into contract RawItems', async () => {
    const items = await drainItems(fixtureConnector());
    expect(items).toHaveLength(8);

    const bracketed = items[1] as RawItem;
    expect(bracketed.identity).toEqual({
      family: 'chat',
      provider: 'whatsapp',
      accountScope: ACCOUNT,
      providerItemId: bracketed.identity.providerItemId,
      providerConversationId: 'Ana Silva',
      localItemId: `${ACCOUNT}:${bracketed.identity.providerItemId}`,
    });
    expect(bracketed.identity.providerItemId).toMatch(/^[0-9a-f]{32}$/);
    expect(bracketed.mimeType).toBe('text/plain');
    expect(bracketed.content).toEqual({ kind: 'text', text: 'Bom dia! Are we still on for lunch?' });
    expect(bracketed.metadata).toEqual({
      chat: 'Ana Silva',
      sender: 'Ana Silva',
      senderLabel: 'Ana Silva',
      sentAt: '2026-06-10T09:15:02',
    });

    const dashed = items[5] as RawItem;
    expect(dashed.identity.providerConversationId).toBe('Tiago');
    expect(dashed.content).toEqual({ kind: 'text', text: 'Did you see the Benfica match?' });
    expect(dashed.metadata).toEqual({
      chat: 'Tiago',
      sender: 'Tiago',
      senderLabel: 'Tiago',
      sentAt: '2026-05-12T21:16:00',
    });
  });

  test('parses US month/day export headers when day/month is impossible', () => {
    const messages = parseWhatsAppChatExport([
      '[5/14/26, 9:08:00 AM] Jane Doe: First US-format message',
      '[5/14/26, 9:09:15 AM] Sam: Second US-format message',
    ].join('\n'), 'Jane Doe');

    expect(messages.map((message) => ({
      sender: message.sender,
      sentAt: message.sentAt,
      text: message.text,
    }))).toEqual([
      {
        sender: 'Jane Doe',
        sentAt: '2026-05-14T09:08:00',
        text: 'First US-format message',
      },
      {
        sender: 'Sam',
        sentAt: '2026-05-14T09:09:15',
        text: 'Second US-format message',
      },
    ]);
  });

  test('keeps day/month interpretation for ambiguous export headers', () => {
    const [message] = parseWhatsAppChatExport(
      '03/01/2026, 1:05:09 PM - Rui: Flight booked\n',
      'Lisbon Plans',
    );

    expect(message?.sentAt).toBe('2026-01-03T13:05:09');
  });

  test('continuation lines append to the previous message', async () => {
    const items = await drainItems(fixtureConnector());

    const bracketedMultiline = items[3] as RawItem;
    expect(bracketedMultiline.content).toEqual({
      kind: 'text',
      text: 'Perfect. Bringing the contract:\n- page one signed\n- page two pending',
    });

    const dashedMultiline = items[6] as RawItem;
    expect(dashedMultiline.content).toEqual({
      kind: 'text',
      text: "Caught the second half\nstill can't believe that goal",
    });
  });

  test('system lines are surfaced as metadata-only items, not skipped', async () => {
    const items = await drainItems(fixtureConnector());

    const system = items[0] as RawItem;
    expect(system.content).toEqual({ kind: 'metadata_only' });
    expect(system.metadata.system).toBe(true);
    expect(system.metadata.sender).toBeUndefined();
    expect(system.metadata.chat).toBe('Ana Silva');
    expect(system.metadata.sentAt).toBe('2026-06-10T09:14:30');
    expect(String(system.metadata.systemText)).toContain('end-to-end encrypted');

    const dashedSystem = items[4] as RawItem;
    expect(dashedSystem.content).toEqual({ kind: 'metadata_only' });
    expect(dashedSystem.metadata.system).toBe(true);
    expect(dashedSystem.identity.providerConversationId).toBe('Tiago');
  });

  test('ids are deterministic across runs and unique within the corpus', async () => {
    const first = (await drainItems(fixtureConnector())).map((item) => item.identity.providerItemId);
    const second = (await drainItems(fixtureConnector())).map((item) => item.identity.providerItemId);

    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  test('listItems pages with an offset cursor and respects limit', async () => {
    const pages = await drain(fixtureConnector().listItems({ limit: 3 }));

    expect(pages.map((page) => page.items.length)).toEqual([3, 3, 2]);
    expect(pages.map((page) => page.nextCursor)).toEqual(['3', '6', '8']);
    expect(pages.map((page) => page.done)).toEqual([false, false, true]);
  });

  test('listItems resumes from a provided cursor', async () => {
    const full = await drain(fixtureConnector().listItems({ limit: 3 }));
    const resumed = await drain(fixtureConnector().listItems({ cursor: '3', limit: 3 }));

    expect(resumed).toHaveLength(2);
    expect(resumed[0]?.items.map((item) => item.identity.localItemId))
      .toEqual(full[1]?.items.map((item) => item.identity.localItemId) ?? []);
    expect(resumed[1]?.done).toBe(true);

    const exhausted = await drain(fixtureConnector().listItems({ cursor: '8' }));
    expect(exhausted).toEqual([{ items: [], done: true }]);
  });

  test('listItems defaults to ~500 messages per page', async () => {
    const bigDir = mkdtempSync(join(tmpdir(), 'whatsapp-big-'));
    const lines = Array.from({ length: 1_200 }, (_, index) => `01/02/26, 10:00 - Bot: message ${index}`);
    writeFileSync(join(bigDir, 'WhatsApp Chat with Bot.txt'), `${lines.join('\n')}\n`);
    const connector = createWhatsAppSourceConnector({ exportDir: bigDir, account: ACCOUNT });

    const pages = await drain(connector.listItems());

    expect(pages.map((page) => page.items.length)).toEqual([500, 500, 200]);
    expect(pages.map((page) => page.nextCursor)).toEqual(['500', '1000', '1200']);
    expect(pages[2]?.done).toBe(true);
  });

  test('skips status@broadcast exports instead of indexing them as chats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-status-'));
    writeFileSync(
      join(dir, 'WhatsApp Chat with status@broadcast.txt'),
      '[07/09/2026, 07:00:00] Sam: transient status update\n',
    );
    writeFileSync(
      join(dir, 'WhatsApp Chat with Family.txt'),
      '[07/09/2026, 07:01:00] Sam: real chat message\n',
    );
    const connector = createWhatsAppSourceConnector({ exportDir: dir, account: ACCOUNT });

    const items = await drainItems(connector);

    expect(items).toHaveLength(1);
    expect(items[0]?.identity.providerConversationId).toBe('Family');
    expect(items[0]?.content).toEqual({ kind: 'text', text: 'real chat message' });
  });

  test('fetchItem re-parses the export and returns the same item by id', async () => {
    const connector = fixtureConnector();
    const listed = (await drainItems(connector))[3] as RawItem;

    const fetched = await connector.fetchItem(listed.identity.localItemId);

    expect(fetched.identity).toEqual(listed.identity);
    expect(fetched.content).toEqual(listed.content);
    expect(fetched.metadata).toEqual(listed.metadata);
  });

  test('fetchItem rejects ids outside the connector account and unknown ids', async () => {
    const connector = fixtureConnector();
    await expect(connector.fetchItem('work:0123456789abcdef0123456789abcdef'))
      .rejects.toThrow(/personal:<provider item id>/);
    await expect(connector.fetchItem(`personal:${'0'.repeat(32)}`)).rejects.toThrow(/was not found/);
  });

  test('classify is ALWAYS S4/secure_local for chats and system items alike', async () => {
    const connector = fixtureConnector();
    const items = await drainItems(connector);
    const expected = {
      trustTier: 'S4',
      trustDomain: 'secure_local',
      localOnly: true,
      cloudEmbeddingEligible: false,
    } as const;

    expect(connector.classify(items[1] as RawItem)).toEqual(expected);
    expect(connector.classify(items[0] as RawItem)).toEqual(expected);
  });

  test('zip exports are read (stored + deflated), macOS noise entries skipped', async () => {
    const zipDir = mkdtempSync(join(tmpdir(), 'whatsapp-zip-'));
    const chatText = '[03/01/2026, 1:05:09 PM] Rui: Flight booked\n[03/01/2026, 1:06:00 PM] Sam: Nice — send the dates\n';
    writeFileSync(join(zipDir, 'WhatsApp Chat - Lisbon Plans.zip'), zipFixture([
      { name: '_chat.txt', text: chatText, deflate: true },
      { name: '__MACOSX/._chat.txt', text: 'resource fork noise' },
    ]));
    const connector = createWhatsAppSourceConnector({ exportDir: zipDir, account: ACCOUNT });

    await connector.authenticate();
    const items = await drainItems(connector);

    expect(items).toHaveLength(2);
    const booked = items[0] as RawItem;
    expect(booked.identity.providerConversationId).toBe('Lisbon Plans');
    expect(booked.content).toEqual({ kind: 'text', text: 'Flight booked' });
    expect(booked.metadata).toEqual({
      chat: 'Lisbon Plans',
      sender: 'Rui',
      senderLabel: 'Rui',
      sentAt: '2026-01-03T13:05:09',
    });
  });
});
