// The Telegram Desktop export reader: finding result.json by its first keys,
// the repair of Telegram's non-JSON escapes, one item per message, and the
// resume points. Synthetic exports built in test/support, never a real one.
// The import end to end (stores, removal, live capture) is in
// archive-import-telegram-lifecycle.test.ts.

import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem } from '../src/core/contracts.ts';
import {
  ARCHIVE_COMMON_FINDINGS,
  ARCHIVE_FORMATS,
  ArchiveImportStoppedError,
  TELEGRAM_JSON_ARCHIVE_FORMAT,
  archiveFormatForProvider,
  archiveProbeNames,
  detectArchiveFormat,
  type ArchiveImportFinding,
  type ArchiveProbe,
  type ArchiveProbeEntry,
} from '../src/core/archive-formats.ts';
import { REMOTE_SOURCE_LABELS } from '../src/core/remote-result.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { fileByteSource } from '../src/workers/archive-import/byte-source.ts';
import { parseJsonResume, serializeJsonResume } from '../src/workers/archive-import/json-stream.ts';
import { archiveFileEntries, archiveManifestSha256, buildArchiveManifest } from '../src/workers/archive-import/manifest.ts';
import {
  TELEGRAM_FINDINGS,
  TELEGRAM_MAX_ITEM_TEXT_CHARS,
  TELEGRAM_MAX_MESSAGE_BYTES,
  createTelegramArchiveConnector,
} from '../src/workers/archive-import/telegram/connector.ts';
import { telegramJsonSource } from '../src/workers/archive-import/telegram/json-repair.ts';
import {
  cutText,
  flattenTelegramText,
  telegramMessageContent,
  telegramTime,
} from '../src/workers/archive-import/telegram/message.ts';
import { DASHBOARD_ARCHIVE_COPY } from '../src/workers/dashboard/vocabulary.ts';
import { memoryRangeReader } from './helpers/zip-fixture.ts';
import {
  TELEGRAM_FIXTURE_FIRST_SECONDS,
  telegramChat,
  telegramContact,
  telegramFileLeftOut,
  telegramFixtureIso,
  telegramFormatted,
  telegramFullExport,
  telegramJson,
  telegramLocation,
  telegramPhoto,
  telegramPoll,
  telegramService,
  telegramSingleChatExport,
  telegramSticker,
  telegramText,
  telegramTexts,
  telegramVoice,
  writeTelegramExport,
  writeTelegramHtmlExport,
} from './support/archive-fixtures-telegram.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tempDir(prefix = 'archive-telegram-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const encoder = new TextEncoder();

// --- Detection ------------------------------------------------------------------

function fileEntry(name: string, text: string | Uint8Array, relPath = name): ArchiveProbeEntry {
  const bytes = typeof text === 'string' ? encoder.encode(text) : text;
  return { relPath, name, kind: 'file', head: bytes.subarray(0, 4096) };
}

function chosenFile(name: string, text: string | Uint8Array): ArchiveProbe {
  return { chosen: fileEntry(name, text, name), children: [] };
}

function chosenFolder(children: ArchiveProbeEntry[]): ArchiveProbe {
  return { chosen: { relPath: '', name: 'Telegram Desktop', kind: 'directory' }, children };
}

const FULL_TEXT = telegramJson(telegramFullExport({ chats: [telegramChat({ messages: [telegramText(0, 'Hello.')] })] }));
const CHAT_TEXT = telegramJson(telegramSingleChatExport(telegramChat({ messages: [telegramText(0, 'Hello.')] })));

describe('telegram format detection', () => {
  test('a whole-account export is found though its chats start long after the first bytes', () => {
    // The personal sections come first, so `chats` is far past anything a probe reads.
    expect(FULL_TEXT.indexOf('"chats"')).toBeGreaterThan(4096);
    const detection = detectArchiveFormat(chosenFile('result.json', FULL_TEXT));
    expect(detection).toMatchObject({ kind: 'match', files: [''] });
    if (detection.kind === 'match') expect(detection.format.id).toBe('telegram_json');
  });

  test('a single chat export is found, with or without a name', () => {
    expect(detectArchiveFormat(chosenFile('result.json', CHAT_TEXT)).kind).toBe('match');
    const unnamed = telegramJson(telegramSingleChatExport(telegramChat({ name: null, messages: [telegramText(0, 'Hello.')] })));
    expect(unnamed).toContain('"name": null');
    expect(detectArchiveFormat(chosenFile('result.json', unnamed)).kind).toBe('match');
    const noName = telegramJson({ type: 'saved_messages', id: 1, messages: [] });
    expect(detectArchiveFormat(chosenFile('result.json', noName)).kind).toBe('match');
  });

  test('an export that excluded the personal sections still opens with a known section', () => {
    const text = telegramJson(telegramFullExport({ withoutPersonalSections: true, chats: [telegramChat({ messages: [] })] }));
    expect(detectArchiveFormat(chosenFile('anything.json', text)).kind).toBe('match');
    const left = telegramJson({ about: 'x', left_chats: { list: [] } });
    expect(detectArchiveFormat(chosenFile('result.json', left)).kind).toBe('match');
  });

  test('a byte order mark and leading blank space do not hide it', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(`\n  ${CHAT_TEXT}`)]);
    expect(detectArchiveFormat(chosenFile('result.json', bom)).kind).toBe('match');
  });

  test('the folder that holds result.json is found by that file, named in any case', () => {
    const inner = fileEntry('Result.JSON', FULL_TEXT);
    const detection = detectArchiveFormat(chosenFolder([
      fileEntry('export_results.html', '<html>'),
      { relPath: 'photos', name: 'photos', kind: 'directory' },
      inner,
    ]));
    expect(detection).toMatchObject({ kind: 'match', files: ['Result.JSON'] });
  });

  test('other JSON, other names and a folder without the file are not a match', () => {
    const others = [
      '{"messages": []}',
      '{"name": "x", "type": "group", "id": 1, "members": []}',
      '{"chats": "not a Telegram export"}',
      '[{"about": "x"}]',
      '{"about": "x", "notes": []}',
      '',
      'From sender@example.invalid Mon Jan  5 10:00:00 2015\nSubject: x\n',
    ];
    for (const text of others) {
      expect(detectArchiveFormat(chosenFile('result.json', text), [TELEGRAM_JSON_ARCHIVE_FORMAT]).kind).toBe('none');
    }
    expect(detectArchiveFormat(chosenFolder([fileEntry('notes.json', FULL_TEXT)]), [TELEGRAM_JSON_ARCHIVE_FORMAT]).kind).toBe('none');
    // result.json in a folder, but not a Telegram one.
    expect(detectArchiveFormat(chosenFolder([fileEntry('result.json', '{"results": []}')]), [TELEGRAM_JSON_ARCHIVE_FORMAT]).kind).toBe('none');
  });

  test('the HTML form is turned away with what to do, and nothing else is', () => {
    const html = detectArchiveFormat(chosenFile('messages.html', '<!DOCTYPE html><html>'));
    expect(html.kind).toBe('none');
    if (html.kind === 'none') {
      expect(html.advice).toContain('Machine-readable JSON');
      expect(html.advice).toContain('Export Telegram data');
      // Plain words: no file names, no paths.
      expect(html.advice).not.toContain('/');
      expect(html.supported).toContain(TELEGRAM_JSON_ARCHIVE_FORMAT.label);
    }
    for (const name of ['messages2.html', 'export_results.html', 'Messages.HTM']) {
      const found = detectArchiveFormat(chosenFile(name, '<html>'));
      expect(found.kind === 'none' && found.advice !== undefined).toBe(true);
    }
    // The folder of an HTML export.
    const folder = detectArchiveFormat(chosenFolder([fileEntry('messages.html', '<html>'), { relPath: 'css', name: 'css', kind: 'directory' }]));
    expect(folder.kind === 'none' && folder.advice !== undefined).toBe(true);
    // A folder with both forms is the JSON export, not a refusal.
    expect(detectArchiveFormat(chosenFolder([fileEntry('messages.html', '<html>'), fileEntry('result.json', FULL_TEXT)])).kind).toBe('match');
    // Mail or any other file gets no Telegram advice.
    const mail = detectArchiveFormat(chosenFile('notes.txt', 'plain notes'));
    expect(mail.kind === 'none' && mail.advice === undefined).toBe(true);
  });

  test('result.json and the HTML names are asked for by name, so a huge export folder still finds them', () => {
    expect(archiveProbeNames(ARCHIVE_FORMATS)).toEqual(expect.arrayContaining(['result.json', 'messages.html', 'export_results.html']));
  });

  test('its citation label is a word the remote surfaces already know', () => {
    expect(archiveFormatForProvider('telegram_export')?.citationLabel).toBe('Telegram');
    expect(REMOTE_SOURCE_LABELS).toContain(TELEGRAM_JSON_ARCHIVE_FORMAT.citationLabel!);
    // Not the live capture's provider.
    expect(TELEGRAM_JSON_ARCHIVE_FORMAT.provider).not.toBe('telegram');
    expect(TELEGRAM_JSON_ARCHIVE_FORMAT.family).toBe('chat');
  });
});

describe('telegram HTML export folders on disk', () => {
  test('the probe of a real folder finds the HTML marker and result.json', async () => {
    const { probeArchivePath } = await import('../src/workers/archive-import/manifest.ts');
    const htmlDir = tempDir();
    writeTelegramHtmlExport(htmlDir);
    const htmlRoot = ScopeRoot.open(htmlDir);
    cleanups.push(() => htmlRoot.close());
    const refused = detectArchiveFormat(probeArchivePath(htmlRoot, '', { probeNames: archiveProbeNames() }));
    expect(refused.kind === 'none' && refused.advice !== undefined).toBe(true);

    const jsonDir = tempDir();
    writeTelegramExport(jsonDir, FULL_TEXT);
    writeTelegramHtmlExport(jsonDir);
    const jsonRoot = ScopeRoot.open(jsonDir);
    cleanups.push(() => jsonRoot.close());
    const found = detectArchiveFormat(probeArchivePath(jsonRoot, '', { probeNames: archiveProbeNames() }));
    expect(found).toMatchObject({ kind: 'match', files: ['result.json'] });
  });
});

// --- The repair of Telegram's escapes ---------------------------------------------

function drain(source: ReturnType<typeof telegramJsonSource>): { text: string; sizes: number[] } {
  const parts: Uint8Array[] = [];
  const sizes: number[] = [];
  for (let chunk = source.next(); chunk; chunk = source.next()) {
    parts.push(chunk.slice());
    sizes.push(chunk.length);
  }
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return { text: new TextDecoder().decode(all), sizes };
}

function repaired(text: string, chunkBytes: number): string {
  const bytes = encoder.encode(text);
  return drain(telegramJsonSource(fileByteSource(memoryRangeReader(bytes), { chunkBytes }))).text;
}

describe('telegram JSON repair', () => {
  test('a control character written as \\xNN becomes spaces of the same length', () => {
    const text = '{"text": "form\\x0Bfeed \\x1B[0m end"}';
    const out = repaired(text, 1024);
    expect(out).toBe('{"text": "form    feed     [0m end"}');
    expect(out.length).toBe(text.length);
    expect(JSON.parse(out).text).toBe('form    feed     [0m end');
    // Lower-case hex too, as some releases wrote it.
    expect(repaired('"a\\x0bb"', 1024)).toBe('"a    b"');
  });

  test('a backslash that is itself escaped does not start an escape', () => {
    const literal = '"C:\\\\x41\\\\x0B"';
    expect(repaired(literal, 1024)).toBe(literal);
    // An escaped backslash, then a real \x0B escape.
    expect(repaired('"a\\\\\\x0Bb"', 1024)).toBe('"a\\\\    b"');
    // Not hex: left for the JSON reader to refuse.
    expect(repaired('"\\xZZ"', 1024)).toBe('"\\xZZ"');
    // Other escapes are not touched.
    expect(repaired('"\\n\\t\\"\\u00e9"', 1024)).toBe('"\\n\\t\\"\\u00e9"');
  });

  test('every way of splitting the bytes gives the same text', () => {
    const text = '{"a": "x\\x0B\\x0Cy", "b": "\\\\x0B\\\\\\x1Bz", "c": "end\\x0';
    const whole = repaired(text, 1 << 20);
    for (let chunkBytes = 1; chunkBytes <= text.length; chunkBytes += 1) {
      expect(repaired(text, chunkBytes)).toBe(whole);
    }
    // The file ends inside an escape: handed on as it is, the reader refuses it.
    expect(whole.endsWith('end\\x0')).toBe(true);
  });

  test('position is the offset of the next byte, and unread takes bytes back', () => {
    const text = '{"t": "a\\x0Bb", "u": "cc"}';
    const bytes = encoder.encode(text);
    const source = telegramJsonSource(fileByteSource(memoryRangeReader(bytes), { chunkBytes: 7 }));
    const seen: string[] = [];
    let total = 0;
    for (let chunk = source.next(); chunk; chunk = source.next()) {
      total += chunk.length;
      expect(source.position).toBe(total);
      seen.push(new TextDecoder().decode(chunk));
    }
    expect(total).toBe(bytes.length);
    expect(seen.join('')).toBe('{"t": "a    b", "u": "cc"}');

    const again = telegramJsonSource(fileByteSource(memoryRangeReader(bytes), { chunkBytes: 1 << 20 }));
    const chunk = again.next()!;
    again.unread(5);
    expect(again.position).toBe(chunk.length - 5);
    const rest = again.next()!;
    expect(new TextDecoder().decode(rest)).toBe('{"t": "a    b", "u": "cc"}'.slice(-5));
    expect(again.position).toBe(chunk.length);
    expect(() => again.unread(rest.length + 1)).toThrow(RangeError);
  });

  test('a source resumed in the middle of a file starts outside any escape', () => {
    const text = '{"a": ["x\\x0B", "y\\x0C"]}';
    const bytes = encoder.encode(text);
    const start = text.indexOf(', "y');
    const source = telegramJsonSource(fileByteSource(memoryRangeReader(bytes), { start, chunkBytes: 4 }));
    expect(source.position).toBe(start);
    expect(drain(source).text).toBe(', "y    "]}');
  });
});

// --- One message ------------------------------------------------------------------

describe('telegram message text', () => {
  test('formatted text keeps its words and its links', () => {
    expect(flattenTelegramText('plain')).toBe('plain');
    expect(flattenTelegramText([
      'See ',
      { type: 'bold', text: 'the tide table' },
      ' at ',
      { type: 'text_link', text: 'the harbour office', href: 'https://harbour.example.invalid/tides' },
      ', ',
      { type: 'text_link', text: 'https://harbour.example.invalid/map', href: 'https://harbour.example.invalid/map' },
      ' or ',
      { type: 'link', text: 'https://harbour.example.invalid/chart' },
      ' ',
      { type: 'mention', text: '@synthetic_sam' },
      '.',
    ])).toBe('See the tide table at the harbour office (https://harbour.example.invalid/tides), https://harbour.example.invalid/map or https://harbour.example.invalid/chart @synthetic_sam.');
    expect(flattenTelegramText([{ type: 'text_link', text: '', href: 'https://harbour.example.invalid/x' }])).toBe('https://harbour.example.invalid/x');
    expect(flattenTelegramText(undefined)).toBe('');
    expect(flattenTelegramText([7, null, { text: 5 }, 'ok'])).toBe('ok');
  });

  test('text_entities stand in when text is empty; text wins when both say something', () => {
    const entitiesOnly = telegramMessageContent({ text: '', text_entities: [{ type: 'plain', text: 'from the entities' }] });
    expect(entitiesOnly).toMatchObject({ text: 'from the entities', hasContent: true });
    const both = telegramMessageContent({ text: 'the text', text_entities: [{ type: 'plain', text: 'other' }] });
    expect(both.text).toBe('the text');
  });

  test('pictures and files are named in the text, counted, and never read', () => {
    const photo = telegramMessageContent(telegramPhoto(1, 'Dawn over the pier'));
    expect(photo.text).toBe('Dawn over the pier\n[Photo: photos/photo_1@05-01-2015_10-00-00.jpg (not imported)]');
    expect(photo).toMatchObject({ mediaFiles: 1, hasContent: true });
    expect(photo.attachments).toEqual(['Photo: photos/photo_1@05-01-2015_10-00-00.jpg']);

    const voice = telegramMessageContent(telegramVoice(2));
    expect(voice.text).toBe('[Voice message: voice_messages/audio_2@05-01-2015_10-00-00.ogg, 7 s (not imported)]');

    const sticker = telegramMessageContent(telegramSticker(3));
    expect(sticker.text).toBe('[Sticker \u{1F600}: stickers/sticker_3.webp (not imported)]');

    // A file the export left out is said so, and is not counted as one the import skipped.
    const missing = telegramMessageContent(telegramFileLeftOut(4));
    expect(missing.text).toBe('[File (not in the export)]');
    expect(missing).toMatchObject({ mediaFiles: 0, hasContent: true, attachments: [] });

    const document = telegramMessageContent({ file: 'files/report.pdf', file_name: 'Harbour report.pdf', duration_seconds: 75 });
    expect(document.text).toBe('[File: Harbour report.pdf, files/report.pdf, 1:15 (not imported)]');
  });

  test('a contact, a place, a location and a poll are kept as lines', () => {
    expect(telegramMessageContent(telegramContact(1)).text).toBe('Contact: Robin Placeholder, +1 555 0100');
    expect(telegramMessageContent(telegramLocation(2)).text).toBe('Place: Synthetic Pier\nLocation: 51.5, -0.12');
    expect(telegramMessageContent(telegramPoll(3)).text).toBe('Poll: Which harbour at dawn?\n- North quay (2 votes)\n- South quay (1 vote)');
  });

  test('a message with nothing to keep has no content', () => {
    expect(telegramMessageContent(telegramText(1, '')).hasContent).toBe(false);
    expect(telegramMessageContent({ text: '   \n ', photo: '' }).hasContent).toBe(false);
    expect(telegramMessageContent({}).hasContent).toBe(false);
  });

  test('a time is the exact Unix time when there is one, else the zone-less date in this zone', () => {
    expect(telegramTime({ date_unixtime: '1420452000', date: '2000-01-01T00:00:00' }, 'date'))
      .toEqual({ iso: '2015-01-05T10:00:00.000Z', assumedZone: false });
    expect(telegramTime({ date_unixtime: 1420452000 }, 'date').iso).toBe('2015-01-05T10:00:00.000Z');
    const local = telegramTime({ date: '2015-01-05T10:00:00' }, 'date');
    expect(local).toEqual({ iso: new Date(2015, 0, 5, 10, 0, 0).toISOString(), assumedZone: true });
    // A date that names its zone is exact.
    expect(telegramTime({ date: '2015-01-05T10:00:00Z' }, 'date')).toEqual({ iso: '2015-01-05T10:00:00.000Z', assumedZone: false });
    expect(telegramTime({ date: '2015-01-05T10:00:00+02:00' }, 'date')).toEqual({ iso: '2015-01-05T08:00:00.000Z', assumedZone: false });
    // Nonsense is no time, never a wrong one.
    for (const message of [{}, { date: 'yesterday' }, { date: 12 }, { date_unixtime: '0' }, { date_unixtime: '99999999999' }, { date_unixtime: 'abc' }]) {
      expect(telegramTime(message as Record<string, unknown>, 'date').iso).toBeUndefined();
    }
    expect(telegramTime({ edited_unixtime: '1420455600' }, 'edited').iso).toBe('2015-01-05T11:00:00.000Z');
  });

  test('cutting text never splits a surrogate pair', () => {
    const text = `ab${'\u{1F600}'}cd`;
    expect(cutText(text, 3)).toBe('ab');
    expect(cutText(text, 4)).toBe(`ab${'\u{1F600}'}`);
    expect(cutText(text, 10)).toBe(text);
  });
});

// --- The connector, over real files through the scope-safe reader ------------------

function exportFile(text: string, name = 'result.json') {
  const dir = tempDir();
  const path = writeTelegramExport(dir, text, name);
  return { dir, path, name };
}

function connectorFor(
  dir: string,
  name: string,
  options: { pageSize?: number; shouldContinue?: () => boolean; manifestSha256?: string; maxBytesPerListing?: number } = {},
) {
  const root = ScopeRoot.open(dir);
  cleanups.push(() => root.close());
  const files = buildArchiveManifest(root, [name]);
  const findings: ArchiveImportFinding[] = [];
  const positions: number[] = [];
  const connector = createTelegramArchiveConnector({
    archiveId: 'synthetic-archive',
    connectorId: 'archive.synthetic-archive',
    accountScope: 'synthetic-archive',
    format: TELEGRAM_JSON_ARCHIVE_FORMAT,
    root,
    files: archiveFileEntries(files),
    manifestSha256: options.manifestSha256 ?? archiveManifestSha256(files),
    report: (finding) => { findings.push(finding); },
    reportPosition: (position) => { positions.push(position.offset); },
    shouldContinue: options.shouldContinue ?? (() => true),
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.maxBytesPerListing !== undefined ? { maxBytesPerListing: options.maxBytesPerListing } : {}),
  });
  return { connector, findings, positions, files, root };
}

type Connector = ReturnType<typeof connectorFor>['connector'];

async function listAll(connector: Connector, cursor?: string) {
  const items: RawItem[] = [];
  const cursors: string[] = [];
  let done = false;
  for await (const page of connector.listItems(cursor ? { cursor } : {})) {
    items.push(...page.items);
    if (page.nextCursor) cursors.push(page.nextCursor);
    done = page.done;
  }
  return { items, cursors, done };
}

function textOf(item: RawItem): string {
  return item.content.kind === 'text' ? item.content.text : '';
}

function counts(findings: readonly ArchiveImportFinding[], findingClass: 'gap' | 'skipped'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const finding of findings) {
    if (finding.class === findingClass) out[finding.kind] = (out[finding.kind] ?? 0) + (finding.count ?? 1);
  }
  return out;
}

/** The byte offset a cursor resumes at. */
function cursorOffset(cursor: string): number {
  const resume = parseJsonResume(cursor.split(':').slice(3).join(':'));
  if (!resume) throw new Error('not a resume point');
  return resume.offset;
}

describe('telegram connector: items', () => {
  const TEXT = telegramJson(telegramFullExport({
    chats: [
      telegramChat({ name: 'Alex Example', type: 'personal_chat', id: 5001, messages: [
        telegramText(0, 'Good morning from the harbour.', { from: 'Alex Example', fromId: 'user5001' }),
        telegramText(1, 'Tide tables later.'),
      ] }),
      // The same numeric id as the chat above, on purpose: ids repeat across kinds of chat.
      telegramChat({ name: 'Synthetic Harbour Group', type: 'private_group', id: 5001, messages: [
        telegramText(2, 'Group note one.'),
        telegramText(3, 'Group note two.'),
      ] }),
    ],
    leftChats: [
      telegramChat({ name: 'Old Channel', type: 'public_channel', id: 5001, messages: [telegramText(4, 'Channel post.')] }),
    ],
  }));

  test('one item per message, each in its own chat, with who wrote it and when', async () => {
    const file = exportFile(TEXT);
    const { connector } = connectorFor(file.dir, file.name);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map(textOf)).toEqual([
      'Good morning from the harbour.', 'Tide tables later.', 'Group note one.', 'Group note two.', 'Channel post.',
    ]);
    for (const item of items) {
      expect(item.identity).toMatchObject({ family: 'chat', provider: 'telegram_export', accountScope: 'synthetic-archive' });
      expect(item.identity.localItemId).toBe(`synthetic-archive:${item.identity.providerItemId}`);
      expect(item.mimeType).toBe('text/plain; charset=utf-8');
    }
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(5);
    expect(items.map((item) => item.identity.providerThreadId)).toEqual(['chats:0', 'chats:0', 'chats:1', 'chats:1', 'left_chats:0']);
    expect(items.map((item) => item.metadata.authoredAt)).toEqual([0, 1, 2, 3, 4].map(telegramFixtureIso));
    expect(items[0]!.metadata).toMatchObject({
      title: 'Alex Example', chat: 'Alex Example', chatId: '5001', chatType: 'personal_chat',
      sender: 'Alex Example', senderId: 'user5001', sentAt: telegramFixtureIso(0), telegramMessageId: '1000',
      attachmentsNotIngested: 0,
    });
    expect(items[1]!.metadata.sender).toBe('Sam Example');
    expect(items[0]!.metadata.leftChat).toBeUndefined();
    expect(items[4]!.metadata).toMatchObject({ leftChat: true, chatType: 'public_channel', title: 'Old Channel' });
    // Every item says when it was written: the dashboard's date range reads this.
    for (const item of items) expect(typeof item.metadata.authoredAt).toBe('string');
  });

  test('the same message id and time in two chats is two items; the same file twice gives the same identities', async () => {
    const same = telegramText(0, 'The very same words.');
    const text = telegramJson(telegramFullExport({
      withoutPersonalSections: true,
      chats: [telegramChat({ id: 1, messages: [same] }), telegramChat({ id: 2, messages: [same, same] })],
    }));
    const first = exportFile(text);
    const one = await listAll(connectorFor(first.dir, first.name).connector);
    expect(one.items).toHaveLength(3);
    expect(new Set(one.items.map((item) => item.identity.providerItemId)).size).toBe(3);
    const second = exportFile(text);
    const two = await listAll(connectorFor(second.dir, second.name).connector);
    expect(two.items.map((item) => item.identity.providerItemId)).toEqual(one.items.map((item) => item.identity.providerItemId));
  });

  test('a single chat export reads the same way, in one chat', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({
      name: 'Solo Chat', type: 'personal_chat', id: 9, messages: [telegramText(0, 'One.'), telegramService(1), telegramText(2, 'Two.')],
    }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    expect(items.map(textOf)).toEqual(['One.', 'Two.']);
    expect(items.map((item) => item.identity.providerThreadId)).toEqual(['chat', 'chat']);
    expect(items[0]!.metadata).toMatchObject({ title: 'Solo Chat', chatType: 'personal_chat', chatId: '9' });
    expect(counts(findings, 'skipped')).toEqual({ service_message: 1 });
    expect(counts(findings, 'gap')).toEqual({});
  });

  test('a chat without a name gets a plain title, never an empty one', async () => {
    const text = telegramJson(telegramFullExport({
      withoutPersonalSections: true,
      chats: [
        telegramChat({ name: null, type: 'saved_messages', id: 1, messages: [telegramText(0, 'a note to self')] }),
        telegramChat({ name: null, type: 'personal_chat', id: 2, messages: [telegramText(1, 'from a deleted account')] }),
        telegramChat({ name: '', type: 'private_group', id: 3, messages: [telegramText(2, 'in a group')] }),
      ],
    }));
    const file = exportFile(text);
    const { items } = await listAll(connectorFor(file.dir, file.name).connector);
    expect(items.map((item) => item.metadata.title)).toEqual(['Saved Messages', 'Unnamed Telegram chat 2', 'Unnamed Telegram chat 3']);
  });

  test('the connector hands the classifier the title, sender and kind of chat, and nothing else of the text', async () => {
    const file = exportFile(TEXT);
    const { connector } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    const signals = items.map((item) => connector.classificationSignals!(item));
    expect(signals[0]).toEqual({ title: 'Alex Example', sender: 'Alex Example', conversationKind: 'direct', folderKeys: ['chats:0'] });
    expect(signals[2]).toMatchObject({ title: 'Synthetic Harbour Group', conversationKind: 'group' });
    expect(signals[4]).toMatchObject({ title: 'Old Channel', conversationKind: 'channel', folderKeys: ['left_chats:0'] });
  });

  test('links in formatted messages are kept in the item text', async () => {
    const text = telegramJson(telegramSingleChatExport(telegramChat({ messages: [
      telegramFormatted(0, ['Tides: ', { type: 'text_link', text: 'the table', href: 'https://harbour.example.invalid/tides' }, ' and ', { type: 'bold', text: 'dawn' }]),
    ] })));
    const file = exportFile(text);
    const { items } = await listAll(connectorFor(file.dir, file.name).connector);
    expect(textOf(items[0]!)).toBe('Tides: the table (https://harbour.example.invalid/tides) and dawn');
  });

  test('a message with an unreadable date still imports, without a made-up time', async () => {
    const odd = { ...telegramText(0, 'Dated by nobody.'), date: 'someday', date_unixtime: 'soon' };
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [odd] }))));
    const { items, } = await listAll(connectorFor(file.dir, file.name).connector);
    expect(items).toHaveLength(1);
    expect(items[0]!.metadata.authoredAt).toBeUndefined();
  });
});

describe('telegram connector: time', () => {
  test('the exact Unix time wins over the date beside it, and no assumption is counted', async () => {
    const message = { ...telegramText(0, 'On time.'), date: '2001-02-03T04:05:06' };
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [message] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    expect(items[0]!.metadata.authoredAt).toBe(telegramFixtureIso(0));
    expect(findings).toEqual([]);
  });

  test('releases before 4.0 write only a zone-less date: read in this zone, counted as one assumption', async () => {
    const messages = [0, 1, 2, 3].map((index) => telegramText(index, `Old note ${index}.`, { dateOnly: true }));
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages }))));
    const { connector, findings } = connectorFor(file.dir, file.name, { pageSize: 2 });
    const { items, cursors } = await listAll(connector);
    expect(items.map((item) => item.metadata.authoredAt)).toEqual([0, 1, 2, 3].map((index) => new Date(2015, 0, 5, 10 + index, 0, 0).toISOString()));
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.assumption]: 1 });
    // A restart after the first page does not say it a second time.
    const resumed = connectorFor(file.dir, file.name, { pageSize: 2 });
    const rest = await listAll(resumed.connector, cursors[0]);
    expect(rest.items).toHaveLength(2);
    expect(resumed.findings).toEqual([]);
  });
});

describe('telegram connector: what is left out', () => {
  test('service messages and messages with nothing to read are skipped and counted, never items', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [
      telegramText(0, 'First.'),
      telegramService(1, 'join_group_by_link'),
      telegramService(2, 'pin_message'),
      telegramText(3, ''),
      { ...telegramText(4, ''), text: [], text_entities: [] },
      telegramText(5, 'Last.'),
    ] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map(textOf)).toEqual(['First.', 'Last.']);
    expect(counts(findings, 'skipped')).toEqual({ [TELEGRAM_FINDINGS.serviceMessage]: 2, [TELEGRAM_FINDINGS.withoutText]: 2 });
    expect(counts(findings, 'gap')).toEqual({});
  });

  test('pictures and files stay as a marker in the text, and are counted once each', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [
      telegramPhoto(0, 'Dawn'),
      telegramVoice(1),
      telegramSticker(2),
      telegramFileLeftOut(3),
      { ...telegramPhoto(4, ''), file: 'files/also.pdf' },
    ] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    expect(items).toHaveLength(5);
    expect(textOf(items[0]!)).toContain('[Photo: photos/photo_0@05-01-2015_10-00-00.jpg (not imported)]');
    expect(items[0]!.metadata).toMatchObject({ attachmentsNotIngested: 1, attachments: ['Photo: photos/photo_0@05-01-2015_10-00-00.jpg'] });
    expect(textOf(items[3]!)).toBe('[File (not in the export)]');
    expect(items[4]!.metadata.attachmentsNotIngested).toBe(2);
    // One per message with its count, not one per file read: nothing was read.
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.mediaNotImported]: 1 + 1 + 1 + 2 });
  });

  test('each part of an account export that is not messages is one gap, said once, however long it is', async () => {
    const file = exportFile(telegramJson(telegramFullExport({
      contacts: 300,
      chats: [telegramChat({ messages: telegramTexts(3) })],
    })));
    const { connector, findings } = connectorFor(file.dir, file.name, { pageSize: 1 });
    const { items } = await listAll(connector);
    expect(items).toHaveLength(3);
    // personal_information, profile_pictures, contacts, frequent_contacts, sessions, other_data.
    // web_sessions is written empty: there is nothing in it to leave out.
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.sectionNotImported]: 6 });
    expect(findings.every((finding) => finding.class === 'gap')).toBe(true);
    // No contact, phone number or session detail reaches an item.
    for (const item of items) {
      expect(textOf(item)).not.toContain('555');
      expect(JSON.stringify(item.metadata)).not.toContain('Contact');
    }
  });

  test('an export that excluded its personal sections has no such gaps', async () => {
    const file = exportFile(telegramJson(telegramFullExport({ withoutPersonalSections: true, chats: [telegramChat({ messages: telegramTexts(2) })] })));
    const { connector, findings } = connectorFor(file.dir, file.name);
    await listAll(connector);
    expect(findings).toEqual([]);
  });

  test('a very long message keeps its start and says so; the next message is unaffected', async () => {
    const long = `${'The synthetic harbour log runs on. '.repeat(40_000)}END`;
    expect(long.length).toBeGreaterThan(TELEGRAM_MAX_ITEM_TEXT_CHARS);
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [
      telegramText(0, long), telegramText(1, 'Short.'),
    ] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    expect(items).toHaveLength(2);
    expect(textOf(items[0]!).length).toBeLessThanOrEqual(TELEGRAM_MAX_ITEM_TEXT_CHARS);
    expect(textOf(items[0]!).startsWith('The synthetic harbour log runs on.')).toBe(true);
    expect(textOf(items[0]!)).not.toContain('END');
    expect(textOf(items[1]!)).toBe('Short.');
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.itemTruncated]: 1 });
    // The gap is where the message is.
    expect(findings[0]!.fileIndex).toBe(0);
  });

  test('a message too large to build is a gap with its place, and reading goes on after it', async () => {
    const huge = 'x'.repeat(TELEGRAM_MAX_MESSAGE_BYTES + 1024);
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [
      telegramText(0, 'Before.'), telegramText(1, huge), telegramText(2, 'After.'),
    ] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map(textOf)).toEqual(['Before.', 'After.']);
    expect(counts(findings, 'gap')).toEqual({ [TELEGRAM_FINDINGS.tooLarge]: 1 });
    expect(findings[0]!.offset).toBeGreaterThan(0);
  });

  test('a message that is not an object is a gap, not a throw', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [
      telegramText(0, 'Before.'), 'a stray string' as unknown as Record<string, unknown>, 7 as unknown as Record<string, unknown>, telegramText(3, 'After.'),
    ] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    expect(items.map(textOf)).toEqual(['Before.', 'After.']);
    expect(counts(findings, 'gap')).toEqual({ [TELEGRAM_FINDINGS.unreadable]: 2 });
  });

  test('findings are reported in file order, at the message they belong to', async () => {
    const file = exportFile(telegramJson(telegramFullExport({
      chats: [telegramChat({ messages: [
        telegramText(0, 'One.'), telegramService(1), telegramPhoto(2, 'Two'), telegramText(3, ''), telegramText(4, 'Three.'),
      ] })],
    })));
    const { connector, findings } = connectorFor(file.dir, file.name, { pageSize: 2 });
    await listAll(connector);
    const offsets = findings.map((finding) => finding.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    // Two findings of one message share its place; different messages do not.
    const byKind = Object.fromEntries(findings.filter((finding) => finding.kind !== ARCHIVE_COMMON_FINDINGS.sectionNotImported).map((finding) => [finding.kind, finding.offset]));
    expect(byKind[TELEGRAM_FINDINGS.serviceMessage]).toBeLessThan(byKind[ARCHIVE_COMMON_FINDINGS.mediaNotImported]!);
    expect(byKind[ARCHIVE_COMMON_FINDINGS.mediaNotImported]).toBeLessThan(byKind[TELEGRAM_FINDINGS.withoutText]!);
  });
});

describe('telegram connector: Telegram escapes and damaged files', () => {
  test('a control character in a message does not stop the file; its words are kept', async () => {
    const messages = [
      telegramText(0, 'Before \u000B the form feed.'),
      telegramText(1, 'Escape \u001B[0m code and a literal \\x0B written out.'),
      telegramText(2, 'After.'),
    ];
    const text = telegramJson(telegramSingleChatExport(telegramChat({ messages })));
    expect(text).toContain('\\x0B');
    expect(text).toContain('\\x1B');
    const file = exportFile(text);
    const { connector, findings } = connectorFor(file.dir, file.name, { pageSize: 1 });
    const { items } = await listAll(connector);
    expect(items).toHaveLength(3);
    expect(textOf(items[0]!)).toContain('Before');
    expect(textOf(items[0]!)).toContain('the form feed.');
    expect(textOf(items[1]!)).toContain('a literal \\x0B written out.');
    expect(findings).toEqual([]);
  });

  test('a file larger than a read, with escapes everywhere, imports every message once across pages', async () => {
    const messages = Array.from({ length: 1500 }, (_, index) =>
      telegramText(index, index % 7 === 0 ? `Entry \u000B ${index} with a code \u001B[0m inside.` : `Entry ${index} is plain.`));
    const text = telegramJson(telegramFullExport({ chats: [telegramChat({ messages })] }));
    expect(Buffer.byteLength(text)).toBeGreaterThan(3 * 128 * 1024);
    const file = exportFile(text);
    const { connector, findings } = connectorFor(file.dir, file.name, { pageSize: 100 });
    const { items, cursors } = await listAll(connector);
    expect(items).toHaveLength(1500);
    expect(cursors.length).toBeGreaterThan(10);
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(1500);
    expect(counts(findings, 'gap')[TELEGRAM_FINDINGS.unreadable]).toBeUndefined();
    expect(textOf(items[1499]!)).toBe('Entry 1499 is plain.');
  });

  test('an export cut short imports what came before the cut and counts the file as damaged', async () => {
    const messages = telegramTexts(30);
    const text = telegramJson(telegramSingleChatExport(telegramChat({ messages })));
    const cutAt = text.indexOf('"id": 1020,') + 25;
    const cut = text.slice(0, cutAt);
    const file = exportFile(cut);
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items, done, cursors } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(20);
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.fileDamaged]: 1 });
    expect(findings[0]!.offset).toBe(Buffer.byteLength(cut));
    expect(cursors.at(-1)).toEndWith(':done');
  });

  test('a file that stops being JSON part-way is damaged too; the listing ends instead of throwing', async () => {
    const messages = telegramTexts(2500);
    const text = telegramJson(telegramSingleChatExport(telegramChat({ messages })));
    const at = text.indexOf('"id": 3000,'); // message 2000
    expect(at).toBeGreaterThan(0);
    const broken = `${text.slice(0, at)}!!! not json ${text.slice(at)}`;
    const file = exportFile(broken);
    const { connector, findings } = connectorFor(file.dir, file.name, { pageSize: 50 });
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.fileDamaged]: 1 });
    // The messages before the break come through, up to the read it was in.
    expect(items.length).toBeLessThanOrEqual(1999);
    expect(items.length).toBeGreaterThan(1999 - 600);
  });

  test('an empty file and a file that is not JSON at all are damaged, not thrown', async () => {
    for (const body of ['', '   ', 'From sender@example.invalid\nnot json']) {
      const file = exportFile(body);
      const { connector, findings } = connectorFor(file.dir, file.name);
      const { items, done } = await listAll(connector);
      expect({ body, done, items: items.length }).toEqual({ body, done: true, items: 0 });
      expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.fileDamaged]: 1 });
    }
  });
});

describe('telegram connector: resume', () => {
  const TEXT = telegramJson(telegramFullExport({
    contacts: 1,
    chats: [
      telegramChat({ name: 'One', id: 1, messages: [telegramText(0, 'a0'), telegramService(1), telegramText(2, 'a2'), telegramPhoto(3, 'a3')] }),
      telegramChat({ name: 'Two', id: 2, messages: [telegramText(4, 'b4')] }),
      telegramChat({ name: 'Empty', id: 3, messages: [] }),
      telegramChat({ name: 'Three', id: 4, messages: [telegramText(5, 'c5'), telegramText(6, 'c6')] }),
    ],
    leftChats: [telegramChat({ name: 'Gone', id: 5, messages: [telegramText(7, 'd7'), telegramText(8, '')] })],
  }));
  const WORDS = ['a0', 'a2', 'a3', 'b4', 'c5', 'c6', 'd7'];

  test('a resume point from any page lists exactly the rest, across chats and sections', async () => {
    const file = exportFile(TEXT);
    const whole = connectorFor(file.dir, file.name, { pageSize: 1 });
    const all = await listAll(whole.connector);
    expect(all.items.map((item) => textOf(item).split('\n')[0])).toEqual(WORDS);
    expect(all.cursors.length).toBeGreaterThanOrEqual(WORDS.length);
    for (const [index, cursor] of all.cursors.entries()) {
      if (cursor.endsWith(':done')) continue;
      // A new connector, as after a restart.
      const resumed = connectorFor(file.dir, file.name, { pageSize: 1 });
      const rest = await listAll(resumed.connector, cursor);
      // One item a page: the cursor after page `index` has read index + 1 of them.
      const taken = all.items.slice(0, index + 1);
      expect({ index, ids: [...taken, ...rest.items].map((item) => item.identity.providerItemId) })
        .toEqual({ index, ids: all.items.map((item) => item.identity.providerItemId) });
      // Each item after the restart is the item it was without one: the chat's name and kind came through the resume point.
      const original = new Map(all.items.map((item) => [item.identity.providerItemId, item]));
      for (const item of rest.items) {
        const same = original.get(item.identity.providerItemId)!;
        expect(item.identity).toEqual(same.identity);
        expect(item.metadata).toEqual(same.metadata);
        expect(item.content).toEqual(same.content);
      }
      // Findings of the part already read are not reported again.
      const through = cursorOffset(cursor);
      for (const finding of resumed.findings) expect(finding.offset).toBeGreaterThan(through);
      // A part of the account export is not said again either.
      expect(resumed.findings.some((finding) => finding.kind === ARCHIVE_COMMON_FINDINGS.sectionNotImported)).toBe(false);
    }
  });

  test('pages come in the size asked, resume points move forward, and the last page is done', async () => {
    const file = exportFile(TEXT);
    const { connector, positions } = connectorFor(file.dir, file.name, { pageSize: 3 });
    const pages: Array<{ n: number; done: boolean; cursor?: string }> = [];
    for await (const page of connector.listItems({})) pages.push({ n: page.items.length, done: page.done, ...(page.nextCursor ? { cursor: page.nextCursor } : {}) });
    expect(pages.map((page) => page.n)).toEqual([3, 3, 1]);
    expect(pages.map((page) => page.done)).toEqual([false, false, true]);
    expect(pages.at(-1)!.cursor).toEndWith(':done');
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.length).toBeGreaterThan(0);
  });

  test('a limit stops the listing at a message boundary and leaves a point to continue from', async () => {
    const file = exportFile(TEXT);
    const { connector } = connectorFor(file.dir, file.name, { pageSize: 10 });
    const first: RawItem[] = [];
    let cursor: string | undefined;
    for await (const page of connector.listItems({ limit: 4 })) {
      first.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(first).toHaveLength(4);
    const rest = await listAll(connectorFor(file.dir, file.name).connector, cursor);
    expect(rest.items.map((item) => textOf(item).split('\n')[0])).toEqual(WORDS.slice(4));
  });

  test('stopping between messages leaves a resume point at the next one', async () => {
    const file = exportFile(TEXT);
    let calls = 0;
    const { connector } = connectorFor(file.dir, file.name, { shouldContinue: () => ++calls <= 17 });
    const first = await listAll(connector);
    expect(first.done).toBe(false);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(WORDS.length);
    const rest = await listAll(connectorFor(file.dir, file.name).connector, first.cursors.at(-1));
    expect([...first.items, ...rest.items].map((item) => textOf(item).split('\n')[0])).toEqual(WORDS);
  });

  test('a byte budget ends a pass early; the next pass continues', async () => {
    const file = exportFile(TEXT);
    const first = await listAll(connectorFor(file.dir, file.name, { pageSize: 100, maxBytesPerListing: 1 }).connector);
    expect(first.done).toBe(false);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(WORDS.length);
  });

  test('a finished import resumes to nothing', async () => {
    const file = exportFile(TEXT);
    const { connector } = connectorFor(file.dir, file.name);
    const all = await listAll(connector);
    expect(await listAll(connector, all.cursors.at(-1))).toMatchObject({ items: [], done: true });
  });

  test('a resume point belongs to these files only, and a made-up one stops the import', async () => {
    const file = exportFile(TEXT);
    const { connector } = connectorFor(file.dir, file.name, { pageSize: 1 });
    const all = await listAll(connector);
    const cursor = all.cursors[1]!;

    const other = connectorFor(file.dir, file.name, { manifestSha256: 'f'.repeat(64) });
    await expect(listAll(other.connector, cursor)).rejects.toMatchObject({ code: 'resume_point_invalid' });

    const tag = cursor.split(':').slice(0, 2).join(':');
    const size = Buffer.byteLength(TEXT);
    const level = (kind: 'object' | 'array', pointer: string | number) => ({ kind, pointer, frame: {} });
    const forged = [
      `${tag}:0:7`,
      `${tag}:2:${serializeJsonResume({ offset: 10, levels: [level('object', 'messages'), level('array', 0)] })}`,
      `${tag}:0:garbage`,
      // Valid, but not the place after a message: inside a chat header, a section, the root.
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [] })}`,
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [level('object', 'contacts'), level('object', 'list'), level('array', 0)] })}`,
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [level('object', 'chats'), level('object', 'list'), level('array', 0)] })}`,
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [level('object', 'messages'), level('array', -1)] })}`,
      // After a message, but past the end of the file.
      `${tag}:0:${serializeJsonResume({ offset: size + 1, levels: [level('object', 'messages'), level('array', 0)] })}`,
      'tg1:',
      'mbox:abc:0',
    ];
    for (const bad of forged) {
      await expect(listAll(connectorFor(file.dir, file.name).connector, bad)).rejects.toBeInstanceOf(ArchiveImportStoppedError);
    }
  });

  test('a resume point at the start of a single chat export continues inside it', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: telegramTexts(6) }))));
    const { connector } = connectorFor(file.dir, file.name, { pageSize: 2 });
    const all = await listAll(connector);
    // Two full pages, then the page that finds the end (a full page cannot know it was the last).
    expect(all.cursors.map((cursor) => cursor.endsWith(':done'))).toEqual([false, false, false, true]);
    const rest = await listAll(connectorFor(file.dir, file.name).connector, all.cursors[0]);
    expect(rest.items.map((item) => item.identity.providerItemId)).toEqual(all.items.slice(2).map((item) => item.identity.providerItemId));
    expect(rest.items.map((item) => item.identity.providerThreadId)).toEqual(['chat', 'chat', 'chat', 'chat']);
    expect(rest.items[0]!.metadata.title).toBe('Synthetic Harbour Group');
  });
});

describe('telegram connector: the file must stay the file approved', () => {
  test('a file that changed or went missing stops the listing instead of reading other bytes', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: telegramTexts(3) }))));
    const { connector } = connectorFor(file.dir, file.name);
    appendFileSync(file.path, '\n');
    await expect(listAll(connector)).rejects.toMatchObject({ code: 'file_changed', relPath: 'result.json' });
    unlinkSync(file.path);
    await expect(listAll(connector)).rejects.toMatchObject({ code: 'file_missing', relPath: 'result.json' });
  });

  test('a file changed after the first page stops the listing, though its messages were already read', async () => {
    const text = telegramJson(telegramSingleChatExport(telegramChat({ messages: telegramTexts(3) })));
    const changes: Record<string, (path: string) => void> = {
      grown: (path) => appendFileSync(path, ' '),
      replaced: (path) => {
        writeFileSync(`${path}.new`, text);
        renameSync(`${path}.new`, path);
      },
      removed: (path) => unlinkSync(path),
    };
    const expected: Record<string, string> = { grown: 'file_changed', replaced: 'file_changed', removed: 'file_missing' };
    for (const [name, change] of Object.entries(changes)) {
      const file = exportFile(text);
      const { connector } = connectorFor(file.dir, file.name, { pageSize: 1 });
      const pages: boolean[] = [];
      let caught: unknown;
      try {
        for await (const page of connector.listItems({})) {
          pages.push(page.done);
          if (pages.length === 1) change(file.path);
        }
      } catch (error) {
        caught = error;
      }
      expect({ name, pages }).toEqual({ name, pages: [false] });
      expect(caught).toBeInstanceOf(ArchiveImportStoppedError);
      expect({ name, code: (caught as ArchiveImportStoppedError).code as string }).toEqual({ name, code: expected[name]! });
    }
  });

  test('the connector reads only result.json: the media it names are never opened', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [telegramPhoto(0, 'see'), telegramVoice(1)] }))));
    const { connector, files } = connectorFor(file.dir, file.name);
    expect(files.map((entry) => entry.rel_path)).toEqual(['result.json']);
    const { items } = await listAll(connector);
    expect(items).toHaveLength(2);
  });

  test('an item cannot be fetched on its own', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: telegramTexts(1) }))));
    const { connector } = connectorFor(file.dir, file.name);
    await expect(connector.fetchItem('x')).rejects.toThrow();
  });
});

describe('telegram findings on the dashboard', () => {
  test('every kind this connector can report has its own plain sentence, one and many, never the catch-all', () => {
    const gaps = DASHBOARD_ARCHIVE_COPY.gaps as Record<string, { one: string; many: string } | undefined>;
    for (const kind of [...Object.values(TELEGRAM_FINDINGS), ...Object.values(ARCHIVE_COMMON_FINDINGS)]) {
      const sentence = gaps[kind];
      expect({ kind, has: sentence !== undefined }).toEqual({ kind, has: true });
      expect(sentence!.one).not.toBe(gaps.other!.one);
      expect(sentence!.many).toContain('{n}');
      expect(sentence!.one).not.toContain('{n}');
    }
  });
});

describe('the first timestamp of the fixtures', () => {
  test('is 2015-01-05T10:00:00Z', () => {
    expect(new Date(TELEGRAM_FIXTURE_FIRST_SECONDS * 1000).toISOString()).toBe('2015-01-05T10:00:00.000Z');
  });
});
