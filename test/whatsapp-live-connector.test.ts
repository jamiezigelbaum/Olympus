// Contract 1 (SourceConnector) conformance tests for the WhatsApp LIVE spool
// connector (the read side of tools/whatsapp-bridge). Everything runs against
// real spool fixture files on disk: filename+line ordering, "file:line" cursor
// resume across files, growing-file tolerance, media lines as metadata_only,
// malformed-line skips surfaced as a gap count, deterministic identities, and
// the S4/secure_local floor.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  createWhatsAppLiveSourceConnector,
  readWhatsAppLiveSpoolStatus,
} from '../src/workers/whatsapp/index.ts';

const ACCOUNT = 'personal';

interface SpoolLineInput {
  id: string;
  chat_jid?: string;
  chat_name?: string;
  sender_jid?: string;
  sender_name?: string;
  from_me?: boolean;
  timestamp?: string;
  text?: string;
  media_type?: string;
  media_path?: string;
  media_mime?: string;
  media_duration_seconds?: number | string;
  media_size_bytes?: number | string;
  download_status?: string;
  media_key?: string;
  media_direct_path?: string;
  media_file_sha256?: string;
  media_file_enc_sha256?: string;
  media_key_timestamp?: number | string;
  mentions?: Record<string, string>;
  preview_title?: string;
  preview_description?: string;
  preview_url?: string;
}

function spoolLine(input: SpoolLineInput): string {
  return `${JSON.stringify({
    chat_jid: 'chat-1@s.whatsapp.net',
    chat_name: 'Ada',
    sender_jid: 'sender-1@s.whatsapp.net',
    sender_name: 'Ada',
    from_me: false,
    timestamp: '2026-06-11T10:00:00Z',
    text: `message ${input.id}`,
    ...input,
  })}\n`;
}

function makeSpoolDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-live-spool-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function connectorFor(spoolDir: string): SourceConnector {
  return createWhatsAppLiveSourceConnector({ spoolDir, account: ACCOUNT });
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

function ids(items: readonly RawItem[]): string[] {
  return items.map((item) => item.identity.providerItemId);
}

describe('WhatsApp live SourceConnector (Contract 1)', () => {
  test('exposes the frozen contract identity', () => {
    const connector = connectorFor(makeSpoolDir({}));
    expect(connector.id).toBe('whatsapp-live');
    expect(connector.family).toBe('chat');
  });

  test('authenticate accepts an existing spool directory (even an empty one)', async () => {
    await expect(connectorFor(makeSpoolDir({})).authenticate()).resolves.toBeUndefined();
  });

  test('authenticate rejects a missing spool directory', async () => {
    const connector = connectorFor(join(makeSpoolDir({}), 'does-not-exist'));
    await expect(connector.authenticate()).rejects.toThrow(/does not exist/);
  });

  test('an empty spool lists a single empty done page', async () => {
    const pages = await drain(connectorFor(makeSpoolDir({})).listItems());
    expect(pages).toHaveLength(1);
    expect(pages[0]?.items).toHaveLength(0);
    expect(pages[0]?.done).toBe(true);
  });

  test('lists messages across spool files in filename+line order', async () => {
    const dir = makeSpoolDir({
      '2026-06-10.jsonl': spoolLine({ id: 'a1' }) + spoolLine({ id: 'a2' }),
      '2026-06-11.jsonl': spoolLine({ id: 'b1' }) + spoolLine({ id: 'b2' }) + spoolLine({ id: 'b3' }),
    });
    const items = await drainItems(connectorFor(dir));
    expect(ids(items)).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);
  });

  test('paginates with file:line cursors and resumes across files', async () => {
    const dir = makeSpoolDir({
      '2026-06-10.jsonl': spoolLine({ id: 'a1' }) + spoolLine({ id: 'a2' }),
      '2026-06-11.jsonl': spoolLine({ id: 'b1' }) + spoolLine({ id: 'b2' }),
    });
    const connector = connectorFor(dir);

    const pages = await drain(connector.listItems({ limit: 3 }));
    expect(ids([...(pages[0]?.items ?? [])])).toEqual(['a1', 'a2', 'b1']);
    expect(pages[0]?.nextCursor).toBe('2026-06-11.jsonl:1');
    expect(pages[0]?.done).toBe(false);

    // Resume exactly where the cursor points, in a fresh listItems call.
    const resumed = await drainItems(connector, { cursor: pages[0]?.nextCursor ?? '' });
    expect(ids(resumed)).toEqual(['b2']);

    // A cursor mid-way through an earlier file also crosses file boundaries.
    const fromEarlier = await drainItems(connector, { cursor: '2026-06-10.jsonl:1' });
    expect(ids(fromEarlier)).toEqual(['a2', 'b1', 'b2']);
  });

  test('a cursor naming a vanished file resumes at the next file by name', async () => {
    const dir = makeSpoolDir({
      '2026-06-11.jsonl': spoolLine({ id: 'b1' }),
    });
    const items = await drainItems(connectorFor(dir), { cursor: '2026-06-10.jsonl:7' });
    expect(ids(items)).toEqual(['b1']);
  });

  test('rejects cursors that are not <fileName>:<lineCount>', async () => {
    const connector = connectorFor(makeSpoolDir({}));
    await expect(drainItems(connector, { cursor: 'not-a-cursor' })).rejects.toThrow(/fileName/);
  });

  test('tolerates the live file growing after a cursor was taken', async () => {
    const file = '2026-06-11.jsonl';
    const dir = makeSpoolDir({ [file]: spoolLine({ id: 'b1' }) + spoolLine({ id: 'b2' }) });
    const connector = connectorFor(dir);

    const pages = await drain(connector.listItems());
    expect(ids([...(pages.at(-1)?.items ?? [])])).toEqual(['b1', 'b2']);
    const cursor = pages.at(-1)?.nextCursor ?? '';
    expect(cursor).toBe(`${file}:2`);

    // The daemon appends two more messages and a new day starts.
    appendFileSync(join(dir, file), spoolLine({ id: 'b3' }));
    writeFileSync(join(dir, '2026-06-12.jsonl'), spoolLine({ id: 'c1' }));

    const resumed = await drainItems(connector, { cursor });
    expect(ids(resumed)).toEqual(['b3', 'c1']);
  });

  test('leaves an unterminated trailing fragment (write in progress) for later', async () => {
    const file = '2026-06-11.jsonl';
    const partial = spoolLine({ id: 'b2' });
    const dir = makeSpoolDir({
      [file]: spoolLine({ id: 'b1' }) + partial.slice(0, partial.length - 10),
    });
    const connector = connectorFor(dir);

    const pages = await drain(connector.listItems());
    expect(ids(pages.flatMap((page) => [...page.items]))).toEqual(['b1']);
    const cursor = pages.at(-1)?.nextCursor ?? '';
    expect(cursor).toBe(`${file}:1`);

    // The daemon finishes the write; resume picks the completed line up.
    appendFileSync(join(dir, file), partial.slice(partial.length - 10));
    const resumed = await drainItems(connectorFor(dir), { cursor });
    expect(ids(resumed)).toEqual(['b2']);
  });

  test('reports the timestamp from the last valid terminated spool message', () => {
    const unterminated = spoolLine({ id: 'in-progress', timestamp: '2026-06-12T09:00:00Z' }).trimEnd();
    const dir = makeSpoolDir({
      '2026-06-10.jsonl': spoolLine({ id: 'older-file', timestamp: '2026-06-10T20:00:00Z' }),
      '2026-06-11.jsonl':
        spoolLine({ id: 'first-live', timestamp: '2026-06-11T12:00:00Z' })
        + spoolLine({ id: 'last-terminated', timestamp: '2026-06-11T11:30:00Z' })
        + unterminated,
    });

    expect(readWhatsAppLiveSpoolStatus(dir)).toMatchObject({
      files: 2,
      messages: 3,
      newestMessageTimestamp: '2026-06-11T11:30:00Z',
    });
  });

  test('maps text lines to the specified RawItem shape', async () => {
    const dir = makeSpoolDir({
      '2026-06-11.jsonl': spoolLine({
        id: 'msg-1',
        chat_jid: 'chat-9@g.us',
        chat_name: 'Family',
        sender_jid: 'sender-7@s.whatsapp.net',
        sender_name: 'Grace',
        from_me: false,
        timestamp: '2026-06-11T12:34:56Z',
        text: 'hello there',
      }),
    });
    const [item] = await drainItems(connectorFor(dir));
    expect(item?.identity).toEqual({
      family: 'chat',
      provider: 'whatsapp',
      accountScope: ACCOUNT,
      providerItemId: 'msg-1',
      providerConversationId: 'chat-9@g.us',
      // A WhatsApp id is unique only inside its chat, so the local id carries
      // the chat as well.
      localItemId: `${ACCOUNT}:chat-9@g.us:msg-1`,
      sourceVersion: '2026-06-11T12:34:56Z',
    });
    expect(item?.content).toEqual({ kind: 'text', text: 'hello there' });
    expect(item?.metadata).toEqual({
      chat: 'Family',
      sender: 'Grace',
      senderId: 'sender-7@s.whatsapp.net',
      senderLabel: 'Grace',
      senderIsOwner: false,
      fromMe: false,
      sentAt: '2026-06-11T12:34:56Z',
    });
  });

  test('preserves resolved mention text and mention map metadata', async () => {
    const dir = makeSpoolDir({
      '2026-07-09.jsonl': spoolLine({
        id: 'mention-1',
        chat_jid: '12036303990000000000@g.us',
        chat_name: 'Family',
        sender_jid: '98765430001111@lid',
        sender_name: 'Jane',
        timestamp: '2026-07-09T07:29:01Z',
        text: '@98765430009999 pick Sam up',
        mentions: { '98765430009999': 'you' },
      }),
    });

    const [item] = await drainItems(connectorFor(dir));
    expect(item?.content).toEqual({ kind: 'text', text: '@you pick Sam up' });
    expect(item?.metadata).toEqual({
      chat: 'Family',
      sender: 'Jane',
      senderId: '98765430001111@lid',
      senderLabel: 'Jane',
      senderIsOwner: false,
      fromMe: false,
      sentAt: '2026-07-09T07:29:01Z',
      mentions: { '98765430009999': 'you' },
    });
  });

  test('enriches a maps link preview into content, search text, FTS, and the embedding input hash', async () => {
    const url = 'https://maps.google.com/?q=barouk';
    const enriched = [
      url,
      'Link preview: Barouk',
      'Description: lx factory',
    ].join('\n');
    const dir = makeSpoolDir({
      '2026-07-24.jsonl': spoolLine({
        id: 'barouk-map',
        timestamp: '2026-07-24T20:15:00Z',
        text: url,
        preview_title: 'Barouk',
        preview_description: 'lx factory',
        preview_url: url,
      }),
    });
    const [item] = await drainItems(connectorFor(dir));
    expect(item?.content).toEqual({ kind: 'text', text: enriched });
    expect(item?.metadata['searchText']).toBe(enriched);
    expect(enriched).not.toContain('Preview URL:');

    const dbPath = join(mkdtempSync(join(tmpdir(), 'whatsapp-preview-store-')), 'connector-store.db');
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: 'secure_local.whatsapp.messages',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    try {
      await store.syncFromConnector(connectorFor(dir), { fetchContent: true });
      expect(store.searchItems('Barouk', 5)).toHaveLength(1);
      expect(store.searchItems('lx factory', 5)).toHaveLength(1);

      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.query(`
          SELECT i.search_text, c.bounded_text, c.embedding_input_hash
          FROM items i
          JOIN chunks c ON c.item_pk = i.item_pk
          WHERE i.provider_item_id = ?
        `).get('barouk-map') as {
          search_text: string;
          bounded_text: string;
          embedding_input_hash: string;
        } | null;
        expect(row).not.toBeNull();
        expect(row?.search_text).toBe(enriched);
        expect(row?.bounded_text).toBe(enriched);
        const embeddingInput = [
          'Title: Ada',
          `Context: ${enriched}`,
          'MIME type: text/plain',
          'Modified: 2026-07-24T20:15:00Z',
          enriched,
        ].join('\n');
        expect(row?.embedding_input_hash).toBe(
          createHash('sha256').update(embeddingInput).digest('hex'),
        );
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  test('adds a distinct matched preview URL but keeps legacy lines unchanged', async () => {
    const original = 'See the short link https://maps.app.goo.gl/example';
    const dir = makeSpoolDir({
      '2026-07-24.jsonl':
        spoolLine({
          id: 'distinct-preview-url',
          text: original,
          preview_title: 'Barouk',
          preview_url: 'https://www.google.com/maps/place/Barouk',
        })
        + spoolLine({ id: 'legacy-line', text: 'ordinary text' }),
    });
    const [preview, legacy] = await drainItems(connectorFor(dir));
    const expected = [
      original,
      'Link preview: Barouk',
      'Preview URL: https://www.google.com/maps/place/Barouk',
    ].join('\n');
    expect(preview?.content).toEqual({ kind: 'text', text: expected });
    expect(preview?.metadata['searchText']).toBe(expected);
    expect(legacy?.content).toEqual({ kind: 'text', text: 'ordinary text' });
    expect(legacy?.metadata['searchText']).toBeUndefined();
  });

  test('falls back to JIDs when display names are empty', async () => {
    const dir = makeSpoolDir({
      '2026-06-11.jsonl': spoolLine({ id: 'msg-2', chat_name: '', sender_name: '', from_me: true }),
    });
    const [item] = await drainItems(connectorFor(dir));
    expect(item?.metadata['chat']).toBe('chat-1@s.whatsapp.net');
    expect(item?.metadata['sender']).toBe('sender-1@s.whatsapp.net');
    expect(item?.metadata['fromMe']).toBe(true);
    expect(item?.metadata['senderId']).toBe('sender-1@s.whatsapp.net');
    expect(item?.metadata['senderLabel']).toBe('sender-1@s.whatsapp.net');
    expect(item?.metadata['senderIsOwner']).toBe(true);
  });

  test('media lines become metadata_only items that keep the media kind', async () => {
    const dir = makeSpoolDir({
      '2026-06-11.jsonl': spoolLine({ id: 'voice-1', text: '', media_type: 'audio' }) + spoolLine({ id: 'text-1' }),
    });
    const items = await drainItems(connectorFor(dir));
    expect(items).toHaveLength(2);
    expect(items[0]?.content).toEqual({ kind: 'metadata_only' });
    expect(items[0]?.metadata['mediaType']).toBe('audio');
    expect(items[1]?.content.kind).toBe('text');
    expect(items[1]?.metadata['mediaType']).toBeUndefined();
  });

  test('new audio media spool fields are parsed tolerantly into metadata', async () => {
    const mediaPath = join(makeSpoolDir({}), 'media', 'audio', 'voice-2.ogg');
    const dir = makeSpoolDir({
      '2026-06-11.jsonl': spoolLine({
        id: 'voice-2',
        text: '',
        media_type: 'audio',
        media_path: mediaPath,
        media_mime: 'audio/ogg; codecs=opus',
        media_duration_seconds: 14,
        media_size_bytes: 4096,
        download_status: 'ok',
        media_key: 'AQID',
        media_direct_path: '/mms/audio',
        media_file_sha256: 'BAUG',
        media_file_enc_sha256: 'BwgJ',
        media_key_timestamp: 123456789,
      }),
    });

    const [item] = await drainItems(connectorFor(dir));
    expect(item?.content).toEqual({ kind: 'metadata_only' });
    expect(item?.metadata).toMatchObject({
      mediaType: 'audio',
      mediaPath,
      mediaMime: 'audio/ogg; codecs=opus',
      mediaDurationSeconds: 14,
      mediaSizeBytes: 4096,
      downloadStatus: 'ok',
      mediaKey: 'AQID',
      mediaDirectPath: '/mms/audio',
      mediaFileSha256: 'BAUG',
      mediaFileEncSha256: 'BwgJ',
      mediaKeyTimestamp: 123456789,
    });
  });

  test('old and malformed optional media fields keep the line readable', async () => {
    const dir = makeSpoolDir({
      '2026-06-11.jsonl': spoolLine({
        id: 'voice-legacy',
        text: '',
        media_type: 'audio',
        media_duration_seconds: 'bad',
        media_size_bytes: 'bad',
        media_key_timestamp: 'bad',
      }),
    });

    const [item] = await drainItems(connectorFor(dir));
    expect(item?.content).toEqual({ kind: 'metadata_only' });
    expect(item?.metadata['mediaType']).toBe('audio');
    expect(item?.metadata['mediaDurationSeconds']).toBeUndefined();
    expect(readWhatsAppLiveSpoolStatus(dir).malformedLines).toBe(0);
  });

  test('audio sidecars no longer bypass the shared extraction owner', async () => {
    const dir = makeSpoolDir({});
    const mediaDir = join(dir, 'media', 'audio');
    mkdirSync(mediaDir, { recursive: true });
    const mediaPath = join(mediaDir, 'voice-3.ogg');
    writeFileSync(mediaPath, 'fake-audio');
    writeFileSync(`${mediaPath}.transcript.txt`, '  bring the red notebook tomorrow\n');
    writeFileSync(join(dir, '2026-06-11.jsonl'), spoolLine({
      id: 'voice-3',
      text: '',
      media_type: 'audio',
      media_path: mediaPath,
      media_mime: 'audio/ogg; codecs=opus',
      media_size_bytes: 10,
      download_status: 'ok',
    }));

    const [item] = await drainItems(connectorFor(dir));
    expect(item?.identity.providerItemId).toBe('voice-3');
    expect(item?.content).toEqual({ kind: 'metadata_only' });
    expect(item?.mimeType).toBe('audio/ogg; codecs=opus');
    expect(item?.metadata).toMatchObject({
      mediaType: 'audio',
      mediaPath,
      locatorUri: mediaPath,
      mediaMime: 'audio/ogg; codecs=opus',
      mediaSizeBytes: 10,
      downloadStatus: 'ok',
    });
    expect(item?.metadata['transcript_source']).toBeUndefined();
  });

  test('skips malformed lines without wedging and surfaces the gap count', async () => {
    const dir = makeSpoolDir({
      '2026-06-10.jsonl':
        spoolLine({ id: 'a1' })
        + 'this is not json\n'
        + '{"id":"","chat_jid":"x","timestamp":"t","from_me":false,"text":"missing id"}\n'
        + '\n'
        + spoolLine({ id: 'a2' }),
      '2026-06-11.jsonl': '{"truncated":\n' + spoolLine({ id: 'b1' }),
    });
    // Malformed lines are skipped (documented) but still advance the cursor.
    const pages = await drain(connectorFor(dir).listItems());
    expect(ids(pages.flatMap((page) => [...page.items]))).toEqual(['a1', 'a2', 'b1']);
    expect(pages.at(-1)?.nextCursor).toBe('2026-06-11.jsonl:2');
    // The skip is surfaced as a gap count for ingest wiring to report.
    const status = readWhatsAppLiveSpoolStatus(dir);
    expect(status.malformedLines).toBe(3);
    expect(status.messages).toBe(3);
    expect(status.files).toBe(2);
  });

  test('skips status@broadcast lines without treating them as chat evidence', async () => {
    const dir = makeSpoolDir({
      '2026-06-10.jsonl':
        spoolLine({ id: 'chat-1', text: 'real private chat' })
        + spoolLine({
          id: 'status-1',
          chat_jid: 'status@broadcast',
          chat_name: 'Status',
          text: 'transient status update',
        })
        + spoolLine({ id: 'chat-2', text: 'another real chat' }),
    });
    const connector = connectorFor(dir);

    const pages = await drain(connector.listItems());
    const items = pages.flatMap((page) => [...page.items]);

    expect(ids(items)).toEqual(['chat-1', 'chat-2']);
    expect(pages.at(-1)?.nextCursor).toBe('2026-06-10.jsonl:3');
    expect(readWhatsAppLiveSpoolStatus(dir)).toMatchObject({
      malformedLines: 0,
      messages: 3,
    });
    await expect(connector.fetchItem(`${ACCOUNT}:status-1`)).rejects.toThrow(/was not found/);
  });

  test('fetchItem re-reads a message by local item id', async () => {
    const dir = makeSpoolDir({
      '2026-06-10.jsonl': spoolLine({ id: 'a1', text: 'first' }),
      '2026-06-11.jsonl': spoolLine({ id: 'b1', text: 'second' }),
    });
    const item = await connectorFor(dir).fetchItem(`${ACCOUNT}:chat-1@s.whatsapp.net:b1`);
    expect(item.identity.localItemId).toBe(`${ACCOUNT}:chat-1@s.whatsapp.net:b1`);
    expect(item.content).toEqual({ kind: 'text', text: 'second' });
  });

  test('fetchItem returns the last occurrence of a re-delivered id', async () => {
    const dir = makeSpoolDir({
      '2026-06-10.jsonl': spoolLine({ id: 'dup-1', text: 'old delivery' }),
      '2026-06-11.jsonl': spoolLine({ id: 'dup-1', text: 'new delivery', timestamp: '2026-06-11T11:00:00Z' }),
    });
    const item = await connectorFor(dir).fetchItem(`${ACCOUNT}:dup-1`);
    expect(item.content).toEqual({ kind: 'text', text: 'new delivery' });
    expect(item.identity.sourceVersion).toBe('2026-06-11T11:00:00Z');
  });

  test('fetchItem rejects unknown ids and malformed local item ids', async () => {
    const connector = connectorFor(makeSpoolDir({ '2026-06-11.jsonl': spoolLine({ id: 'a1' }) }));
    await expect(connector.fetchItem(`${ACCOUNT}:missing`)).rejects.toThrow(/was not found/);
    await expect(connector.fetchItem('missing-prefix')).rejects.toThrow(/local item ids/);
  });

  test('identity is deterministic across reads', async () => {
    const dir = makeSpoolDir({ '2026-06-11.jsonl': spoolLine({ id: 'a1' }) + spoolLine({ id: 'a2' }) });
    const first = await drainItems(connectorFor(dir));
    const second = await drainItems(connectorFor(dir));
    expect(first.map((item) => item.identity)).toEqual(second.map((item) => item.identity));
  });

  test('classify is ALWAYS S4/secure_local for live chat history', async () => {
    const dir = makeSpoolDir({
      '2026-06-11.jsonl': spoolLine({ id: 'a1' }) + spoolLine({ id: 'media-1', text: '', media_type: 'image' }),
    });
    const connector = connectorFor(dir);
    for (const item of await drainItems(connector)) {
      const sensitivity = connector.classify(item);
      expect(sensitivity.trustTier).toBe('S4');
      expect(sensitivity.trustDomain).toBe('secure_local');
    }
  });

  test('ignores non-jsonl files and nested directories in the spool dir', async () => {
    const dir = makeSpoolDir({
      '2026-06-11.jsonl': spoolLine({ id: 'a1' }),
      'qr.txt': 'leftover pairing artifact\n',
    });
    mkdirSync(join(dir, 'archive'));
    const items = await drainItems(connectorFor(dir));
    expect(ids(items)).toEqual(['a1']);
  });

  test('round-trips through the shared connector store (the real ingest path)', async () => {
    const dir = makeSpoolDir({
      '2026-06-10.jsonl': spoolLine({ id: 'a1', text: 'remember the falafel place on Allenby' }),
      '2026-06-11.jsonl':
        spoolLine({ id: 'b1', text: 'flight lands tuesday at noon' })
        + spoolLine({ id: 'voice-1', text: '', media_type: 'audio' }),
    });
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.whatsapp.messages',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    try {
      const summary = await store.syncFromConnector(connectorFor(dir), { fetchContent: true });
      expect(summary.itemsSeen).toBe(3);
      expect(summary.itemsIndexed).toBe(3);
      expect(summary.itemsRejected).toBe(0);
      expect(summary.cursor).toBe('2026-06-11.jsonl:2');
      expect(summary.policy.trustDomain).toBe('secure_local');

      const rows = store.searchItems('falafel', 5);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sourceItem.localItemId).toBe(`${ACCOUNT}:chat-1@s.whatsapp.net:a1`);
      expect(rows[0]?.trustTier).toBe('S4');
      expect(rows[0]).toMatchObject({
        conversationLabel: 'Ada',
        senderId: 'sender-1@s.whatsapp.net',
        authorLabel: 'Ada',
        senderIsOwner: false,
      });

      // Resuming from the persisted cursor after the live file grows ingests
      // only the new line — the periodic-sync wiring in deploy notes.
      appendFileSync(join(dir, '2026-06-11.jsonl'), spoolLine({ id: 'b2', text: 'and bring the charger' }));
      const cursor = store.status().lastSyncRun?.cursor ?? '';
      const second = await store.syncFromConnector(connectorFor(dir), { cursor, fetchContent: true });
      expect(second.itemsSeen).toBe(1);
      expect(second.cursor).toBe('2026-06-11.jsonl:3');
    } finally {
      store.close();
    }
  });

  test('live-sync repair-senders mode backfills retained spool metadata idempotently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsapp-sender-repair-'));
    const stateDir = join(root, 'state');
    const spoolDir = join(stateDir, 'spool');
    const dbPath = join(stateDir, 'connector-store.db');
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(join(spoolDir, '2026-07-23.jsonl'), spoolLine({
      id: 'owner-message',
      chat_jid: 'peer-dor@s.whatsapp.net',
      chat_name: 'Dor',
      sender_jid: 'owner@s.whatsapp.net',
      sender_name: 'Sam',
      from_me: true,
      timestamp: '2026-07-23T10:00:00Z',
      text: 'owner-authored DM',
    }));
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: 'secure_local.whatsapp.messages',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    await store.syncFromConnector(connectorFor(spoolDir), { fetchContent: true });
    store.close();
    const db = new Database(dbPath);
    db.exec('UPDATE items SET sender_id = NULL, sender_label = NULL, sender_is_owner = NULL;');
    db.close();

    const script = join(import.meta.dir, '..', 'scripts', 'whatsapp-live-sync.ts');
    const run = () => Bun.spawnSync([
      process.execPath,
      script,
      '--mode', 'repair-senders',
      '--db', dbPath,
      '--account', ACCOUNT,
    ], {
      env: { ...process.env, OLYMPUS_WHATSAPP_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const first = run();
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout.toString())).toMatchObject({
      kind: 'whatsapp_sender_repair_receipt',
      status: 'completed',
      converged: true,
      counts: { itemsScanned: 1, itemsRepaired: 1, itemsMissing: 0 },
      policy: { counts_only: true, source_text_returned: false },
    });
    const second = run();
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout.toString())).toMatchObject({
      counts: { itemsScanned: 1, itemsRepaired: 0, itemsUnchanged: 1 },
    });
  }, 30_000);
});
