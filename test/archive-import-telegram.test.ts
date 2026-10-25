// The Telegram Desktop export reader: finding result.json by its first keys,
// the repair of Telegram's non-JSON escapes, one item per message, and the
// resume points. Synthetic exports built in test/support, never a real one.
// The import end to end (stores, removal, live capture) is in
// archive-import-telegram-lifecycle.test.ts.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
  TELEGRAM_MAX_MESSAGE_BYTES,
  createTelegramArchiveConnector,
} from '../src/workers/archive-import/telegram/connector.ts';
import { telegramJsonSource } from '../src/workers/archive-import/telegram/json-repair.ts';
import { ACCOUNT_SECTIONS, accountEntryContent, type AccountSection } from '../src/workers/archive-import/telegram/account.ts';
import {
  flattenTelegramText,
  telegramMessageContent,
  telegramServiceContent,
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
  telegramTodo,
  telegramUnreadableKind,
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

    // A file the export left out is said so and counted, and keeps the name the export gave it: a search for the name finds the message.
    const missing = telegramMessageContent(telegramFileLeftOut(4));
    expect(missing.text).toBe('[File: synthetic-report.pdf (not in the export)]');
    expect(missing).toMatchObject({ mediaFiles: 1, hasContent: true, attachments: ['File: synthetic-report.pdf'] });
    // Without a name there is nothing to keep but the marker.
    const unnamed = telegramMessageContent({ file: '(File exceeds maximum size. Change data exporting settings to download.)', media_type: 'voice_message' });
    expect(unnamed).toMatchObject({ text: '[Voice message (not in the export)]', mediaFiles: 1, attachments: [] });
    expect(telegramMessageContent({ photo: '(File not included. Change data exporting settings to download.)' })).toMatchObject({
      text: '[Photo (not in the export)]',
      mediaFiles: 1,
      attachments: [],
    });

    const document = telegramMessageContent({ file: 'files/report.pdf', file_name: 'Harbour report.pdf', duration_seconds: 75 });
    expect(document.text).toBe('[File: Harbour report.pdf, files/report.pdf, 1:15 (not imported)]');
  });

  test('a contact, a place, a location and a poll are kept as lines', () => {
    expect(telegramMessageContent(telegramContact(1)).text).toBe('Contact: Robin Placeholder, +1 555 0100');
    expect(telegramMessageContent(telegramLocation(2)).text).toBe('Place: Synthetic Pier\nLocation: 51.5, -0.12');
    expect(telegramMessageContent(telegramPoll(3)).text).toBe('Poll: Which harbour at dawn?\n- North quay (2 votes)\n- South quay (1 vote)');
  });

  test('a poll keeps its question and answers whether they are plain, formatted or mixed', () => {
    const poll = (question: unknown, answers: unknown[]) => telegramMessageContent({
      text: '',
      poll: { question, closed: false, total_voters: 3, answers: answers.map((text, index) => ({ text, voters: index + 1, chosen: false })) },
    });
    // Plain: the form the writer uses when nothing in the words is formatted.
    expect(poll('Which harbour?', ['North', 'South']).text).toBe('Poll: Which harbour?\n- North (1 vote)\n- South (2 votes)');
    // Formatted: an array of strings and typed parts, in the question and in each answer.
    expect(poll(['Which ', { type: 'bold', text: 'harbour' }, '?'], [[{ type: 'italic', text: 'North' }], ['Sou', { type: 'bold', text: 'th' }]]).text)
      .toBe('Poll: Which harbour?\n- North (1 vote)\n- South (2 votes)');
    // Mixed: a formatted question over plain answers, and plain over formatted, and a link keeps its address.
    expect(poll([{ type: 'bold', text: 'Which harbour?' }], ['North', 'South']).text).toBe('Poll: Which harbour?\n- North (1 vote)\n- South (2 votes)');
    expect(poll('Which harbour?', [[{ type: 'bold', text: 'North' }], 'South', [{ type: 'text_link', text: 'the map', href: 'https://harbour.example.invalid/map' }]]).text)
      .toBe('Poll: Which harbour?\n- North (1 vote)\n- South (2 votes)\n- the map (https://harbour.example.invalid/map) (3 votes)');
    // A poll whose words are all formatted is a poll, not "nothing to read".
    const allFormatted = poll([{ type: 'bold', text: 'Which harbour?' }], [[{ type: 'bold', text: 'North' }], [{ type: 'bold', text: 'South' }]]);
    expect(allFormatted.hasContent).toBe(true);
    expect(allFormatted.unsupported).toBe(false);
    expect(poll([], [[], '']).hasContent).toBe(false);
  });

  test('a to-do list keeps its title and tasks, plain or formatted, and is never empty or unreadable', () => {
    const plain = telegramMessageContent(telegramTodo(1, 'Before sailing', ['Check the tide table', 'Fill the water tank']));
    expect(plain.text).toBe('To-do list: Before sailing\n- Check the tide table\n- Fill the water tank');
    expect(plain).toMatchObject({ hasContent: true, unsupported: false, mediaFiles: 0 });
    const formatted = telegramMessageContent(telegramTodo(2, [{ type: 'bold', text: 'Before ' }, 'sailing'], [
      [{ type: 'italic', text: 'Check' }, ' the tide table'],
      '',
      [{ type: 'text_link', text: 'the harbour office', href: 'https://harbour.example.invalid/office' }],
    ]));
    expect(formatted.text).toBe('To-do list: Before sailing\n- Check the tide table\n- the harbour office (https://harbour.example.invalid/office)');
    // Tasks without a title, a title without tasks, and the words of the message above them.
    expect(telegramMessageContent(telegramTodo(3, '', ['Only task'])).text).toBe('To-do list:\n- Only task');
    expect(telegramMessageContent(telegramTodo(4, 'No tasks yet', [])).text).toBe('To-do list: No tasks yet');
    expect(telegramMessageContent({ ...telegramTodo(5, 'Packing', ['Rope']), text: 'Our list' }).text).toBe('Our list\nTo-do list: Packing\n- Rope');
    expect(telegramMessageContent(telegramTodo(6, '', [])).hasContent).toBe(false);
  });

  test('an invoice and a game keep their words', () => {
    expect(telegramMessageContent({ invoice_information: { title: 'Harbour pass', description: 'Three nights', amount: 1500, currency: 'USD' } }).text)
      .toBe('Invoice: Harbour pass, Three nights');
    expect(telegramMessageContent({ game_title: 'Knots', game_description: 'Tie them fast' }).text).toBe('Game: Knots, Tie them fast');
    expect(telegramMessageContent({ game_title: 'Knots' }).text).toBe('Game: Knots');
  });

  test('a kind of content that is not read is said so, and never taken for an empty message', () => {
    const unreadable = (extra: Record<string, unknown>, words = '') => telegramMessageContent(telegramUnreadableKind(1, extra, { text: words }));
    for (const extra of [
      { rich_message: { rtl: false, part: false, blocks: [{ type: 'paragraph', text: { type: 'plain', text: 'Words in a block' } }] } },
      { giveaway_information: { quantity: 5, months: 3, channels: ['1001'], countries: [], additional_prize: '', stars: 0 } },
      { giveaway_results: { channel: '1001', winners: [], winners_count: 0 } },
      { paid_stars_amount: 50 },
      { type: 'unsupported' },
      { some_kind_added_later: { anything: true } },
    ]) {
      const content = unreadable(extra);
      expect({ extra, hasContent: content.hasContent, unsupported: content.unsupported }).toEqual({ extra, hasContent: false, unsupported: true });
    }
    // With words beside it, the words are kept and the rest is still said.
    expect(unreadable({ paid_stars_amount: 50 }, 'Look at this')).toMatchObject({ text: 'Look at this', hasContent: true, unsupported: true });
    // What the reader knows, or that holds no words, is not unreadable; an empty message is just empty.
    expect(unreadable({ reactions: [{ type: 'emoji', count: 1, emoji: 'x' }], inline_bot_buttons: [[{ type: 'url', text: 'Open' }]] }))
      .toMatchObject({ hasContent: false, unsupported: false });
    expect(unreadable({ location_information: null })).toMatchObject({ hasContent: false, unsupported: false });
    expect(telegramMessageContent(telegramText(1, ''))).toMatchObject({ hasContent: false, unsupported: false });
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

  test('no line of a message is cut: a long name, question or answer is kept to its last word', () => {
    const long = `${'north quay '.repeat(120)}end`;
    expect(long.length).toBeGreaterThan(1000);
    expect(telegramMessageContent({ file: 'files/x.pdf', file_name: long }).text).toContain(`${long}, files/x.pdf`);
    const poll = telegramMessageContent({ poll: { question: long, answers: Array.from({ length: 60 }, (_, index) => ({ text: `Answer ${index}`, voters: 0 })) } });
    expect(poll.text.split('\n')[0]).toBe(`Poll: ${long}`);
    // Every answer, not the first fifty.
    expect(poll.text.split('\n')).toHaveLength(61);
    expect(poll.text).toContain('- Answer 59 (0 votes)');
    const todo = telegramMessageContent(telegramTodo(1, long, Array.from({ length: 60 }, (_, index) => `Task ${index}`)));
    expect(todo.text.split('\n')).toHaveLength(61);
    expect(todo.text).toContain('- Task 59');
  });
});

describe('telegram service messages', () => {
  const say = (action: string, extra: Record<string, unknown> = {}, from = 'Alex Example') =>
    telegramServiceContent(telegramService(1, action, { from, extra })).text;

  test('a join, a call, a pin and the like are one plain sentence that names who did it', () => {
    expect(say('create_group', { title: 'Harbour Crew', members: ['Sam Example', 'Robin Placeholder'] }))
      .toBe('Alex Example created the group "Harbour Crew" with Sam Example and Robin Placeholder.');
    expect(say('edit_group_title', { title: 'Dawn Patrol' })).toBe('Alex Example changed the group name to "Dawn Patrol".');
    expect(say('invite_members', { members: ['Sam Example', 'Robin Placeholder', 'Kit Sample'] }))
      .toBe('Alex Example added Sam Example, Robin Placeholder and Kit Sample.');
    expect(say('remove_members', { members: ['Sam Example'] })).toBe('Alex Example removed Sam Example.');
    expect(say('join_group_by_link')).toBe('Alex Example joined the group by invite link.');
    expect(say('join_group_by_link', { inviter: 'Robin Placeholder' })).toBe('Alex Example joined the group by invite link from Robin Placeholder.');
    expect(say('pin_message', { message_id: 1042, reply_to_peer_id: 'user1001' })).toBe('Alex Example pinned message 1042.');
    expect(say('pin_message')).toBe('Alex Example pinned a message.');
    expect(say('clear_history')).toBe('Alex Example cleared the chat history.');
    expect(say('joined_telegram')).toBe('Alex Example joined Telegram.');
    expect(say('delete_group_photo')).toBe('Alex Example removed the group photo.');
    expect(say('set_messages_ttl', { period: 86400 })).toBe('Alex Example set messages to disappear after 24 hours.');
    expect(say('topic_created', { title: 'Tides' })).toBe('Alex Example created the topic "Tides".');
  });

  test('a call says who called and for how long', () => {
    expect(say('phone_call', { duration_seconds: 205, discard_reason: 'hangup' })).toBe('Alex Example made a phone call that lasted 3 minutes 25 seconds.');
    expect(say('phone_call', { duration_seconds: 3725 })).toBe('Alex Example made a phone call that lasted 1 hour 2 minutes 5 seconds.');
    expect(say('phone_call', { duration_seconds: 1 })).toBe('Alex Example made a phone call that lasted 1 second.');
    expect(say('phone_call', { duration_seconds: 0, discard_reason: 'missed' })).toBe('Missed phone call from Alex Example.');
    expect(say('phone_call', { discard_reason: 'busy' })).toBe('Alex Example called; the line was busy.');
    expect(say('group_call', { duration: 600 })).toBe('Alex Example started a voice chat that lasted 10 minutes.');
  });

  test('an action this does not know still reads as a sentence, and keeps every field it carries', () => {
    expect(say('some_new_action', { thing_count: 3, note: 'hello', flag: true, who: ['Sam Example', 'Kit Sample'] }))
      .toBe('Alex Example: some new action.\nthing count: 3\nnote: hello\nflag: true\nwho: Sam Example and Kit Sample');
    expect(telegramServiceContent({ type: 'service', id: 1, action: 'take_screenshot' }).text).toBe('Someone took a screenshot.');
    expect(telegramServiceContent({ type: 'service', id: 2 }).text).toBe('Someone: a service event.');
    expect(telegramServiceContent(telegramService(1, 'some_new_action')).hasContent).toBe(true);
  });

  test('a picture a service message names is counted and not imported', () => {
    const content = telegramServiceContent(telegramService(1, 'edit_group_photo', { extra: { photo: 'photos/group_1.jpg', photo_file_size: 1000, width: 10, height: 10 } }));
    expect(content.text).toBe('Sam Example changed the group photo.\n[Photo: photos/group_1.jpg (not imported)]');
    expect(content).toMatchObject({ mediaFiles: 1, attachments: ['Photo: photos/group_1.jpg'], unsupported: false });
  });
});

describe('telegram account entries', () => {
  const section = (name: string): AccountSection => ACCOUNT_SECTIONS.find((candidate) => candidate.name === name)!;

  test('every part of the account export the reader knows is named once, with the entries it holds', () => {
    expect(ACCOUNT_SECTIONS.map((part) => part.name)).toEqual([
      'personal_information', 'profile_pictures', 'stories', 'profile_music', 'contacts', 'frequent_contacts', 'sessions', 'web_sessions', 'other_data',
    ]);
    // The profile and the other data are one object each; every other part is a list of entries.
    expect(ACCOUNT_SECTIONS.filter((part) => part.whole).map((part) => part.name)).toEqual(['personal_information', 'other_data']);
  });

  test('a contact is a headline and a line for each field, the time as the export wrote it', () => {
    const content = accountEntryContent(section('contacts'), {
      user_id: 2002, first_name: 'Robin', last_name: 'Placeholder', phone_number: '+1 555 0102', date: '2015-01-04T09:00:00', date_unixtime: '1420362000',
    });
    expect(content.text).toBe([
      'Contact: Robin Placeholder',
      'User id: 2002',
      'First name: Robin',
      'Last name: Placeholder',
      'Phone number: +1 555 0102',
      'Date: 2015-01-04T09:00:00',
    ].join('\n'));
    expect(content.mediaFiles).toBe(0);
    // A contact the export gives no name or number for still says so and keeps its time (from the Unix time alone).
    expect(accountEntryContent(section('contacts'), { date: '', date_unixtime: '1420362000' }).text)
      .toBe('Contact: no name or number in the export\nDate: 2015-01-04T09:00:00.000Z');
  });

  test('a session and a web session say what and where, and a frequent contact its kind', () => {
    expect(accountEntryContent(section('sessions'), {
      last_active: '2015-01-04T09:00:00', last_active_unixtime: '1420362000', last_ip: '203.0.113.7', last_country: 'Synthetic Land',
      application_name: 'Telegram Android', application_version: '10.0', device_model: 'Synthetic Phone', platform: 'Android', system_version: '14',
    }).text).toBe([
      'Telegram session: Telegram Android 10.0 on Synthetic Phone',
      'Last active: 2015-01-04T09:00:00',
      'Last ip: 203.0.113.7',
      'Last country: Synthetic Land',
      'Application name: Telegram Android',
      'Application version: 10.0',
      'Device model: Synthetic Phone',
      'Platform: Android',
      'System version: 14',
    ].join('\n'));
    expect(accountEntryContent(section('web_sessions'), { domain_name: 'harbour.example.invalid', browser: 'Synthetic Browser', bot_username: 'harbour_bot' }).text.split('\n')[0])
      .toBe('Web session: harbour.example.invalid, Synthetic Browser');
    expect(accountEntryContent(section('frequent_contacts'), { id: 2002, category: 'inline_bots', type: 'bot_chat', name: 'Harbour Bot', rating: 0.5 }).text)
      .toBe('Frequent contact: Harbour Bot (inline bots)\nId: 2002\nCategory: inline_bots\nType: bot_chat\nName: Harbour Bot\nRating: 0.5');
  });

  test('the profile is one entry built from all its fields; other data keeps its nesting', () => {
    expect(accountEntryContent(section('personal_information'), {
      user_id: 1001, first_name: 'Sam', last_name: 'Example', phone_number: '+1 555 0101', username: '@synthetic_sam', bio: 'Synthetic account for tests.',
    }).text).toBe([
      'Telegram profile: Sam Example (@synthetic_sam)',
      'User id: 1001',
      'First name: Sam',
      'Last name: Example',
      'Phone number: +1 555 0101',
      'Username: @synthetic_sam',
      'Bio: Synthetic account for tests.',
    ].join('\n'));
    expect(accountEntryContent(section('other_data'), {
      notes: 'Synthetic other data.', settings: { theme: 'dark', nested: { depth: 2, tags: ['a', 'b'] } }, items: [{ name: 'one' }, 'two'], empty: {}, nothing: null, blank: '  ',
    }).text).toBe([
      'Other Telegram account data',
      'Notes: Synthetic other data.',
      'Settings:',
      '  Theme: dark',
      '  Nested:',
      '    Depth: 2',
      '    Tags: a, b',
      'Items:',
      '  -',
      '    Name: one',
      '  - two',
    ].join('\n'));
  });

  test('a picture is named and counted, never opened; the time stays', () => {
    const content = accountEntryContent(section('profile_pictures'), { date: '2015-01-04T09:00:00', date_unixtime: '1420362000', photo: 'profile_pictures/photo_1.jpg' });
    expect(content.text).toBe('Profile picture\n[Photo: profile_pictures/photo_1.jpg (not imported)]\nDate: 2015-01-04T09:00:00');
    expect(content).toMatchObject({ mediaFiles: 1, attachments: ['Photo: profile_pictures/photo_1.jpg'] });
    const story = accountEntryContent(section('stories'), { date: '2015-01-04T09:00:00', pinned: true, media: { photo: 'stories/story_1.jpg' } });
    expect(story.text).toBe('Story\n[Photo: stories/story_1.jpg (not imported)]\nDate: 2015-01-04T09:00:00\nPinned: yes');
    expect(story.mediaFiles).toBe(1);
  });

  test('a value that is not an object is still kept', () => {
    expect(accountEntryContent(section('contacts'), 'a stray string').text).toBe('Contact: no name or number in the export\na stray string');
    expect(accountEntryContent(section('contacts'), 7).text).toBe('Contact: no name or number in the export\n7');
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
    withoutPersonalSections: true,
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
    expect(items.map(textOf)).toEqual(['One.', 'Sam Example joined the group by invite link.', 'Two.']);
    expect(items.map((item) => item.identity.providerThreadId)).toEqual(['chat', 'chat', 'chat']);
    expect(items[0]!.metadata).toMatchObject({ title: 'Solo Chat', chatType: 'personal_chat', chatId: '9' });
    expect(counts(findings, 'skipped')).toEqual({});
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

  test('releases before 4.0 write only a zone-less date: read in this zone, counted once as the time zone assumed', async () => {
    const messages = [0, 1, 2, 3].map((index) => telegramText(index, `Old note ${index}.`, { dateOnly: true }));
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages }))));
    const { connector, findings } = connectorFor(file.dir, file.name, { pageSize: 2 });
    const { items, cursors } = await listAll(connector);
    expect(items.map((item) => item.metadata.authoredAt)).toEqual([0, 1, 2, 3].map((index) => new Date(2015, 0, 5, 10 + index, 0, 0).toISOString()));
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.timeZoneAssumed]: 1 });
    // A restart after the first page does not say it a second time.
    const resumed = connectorFor(file.dir, file.name, { pageSize: 2 });
    const rest = await listAll(resumed.connector, cursors[0]);
    expect(rest.items).toHaveLength(2);
    expect(resumed.findings).toEqual([]);
  });
});

describe('telegram connector: what is left out', () => {
  test('messages with nothing to read are skipped and counted, never items; service messages are items in their chat', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [
      telegramText(0, 'First.'),
      telegramService(1, 'join_group_by_link', { from: 'Alex Example', fromId: 'user77' }),
      telegramService(2, 'pin_message', { extra: { message_id: 1000 } }),
      telegramText(3, ''),
      { ...telegramText(4, ''), text: [], text_entities: [] },
      telegramText(5, 'Last.'),
    ] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map(textOf)).toEqual([
      'First.', 'Alex Example joined the group by invite link.', 'Sam Example pinned message 1000.', 'Last.',
    ]);
    // A service message has its time, its actor as the sender, and says it is one.
    expect(items[1]!.metadata).toMatchObject({
      authoredAt: telegramFixtureIso(1), sender: 'Alex Example', senderId: 'user77', serviceMessage: true, serviceAction: 'join_group_by_link', title: 'Synthetic Harbour Group',
    });
    expect(items[1]!.identity.providerThreadId).toBe('chat');
    expect(items[0]!.metadata.serviceMessage).toBeUndefined();
    expect(counts(findings, 'skipped')).toEqual({ [TELEGRAM_FINDINGS.withoutText]: 2 });
    expect(counts(findings, 'gap')).toEqual({});
  });

  test('a service message is never counted as left out, and one with a picture counts the picture', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [
      telegramService(0, 'edit_group_photo', { extra: { photo: 'photos/group_0.jpg' } }),
      telegramService(1, 'phone_call', { extra: { duration_seconds: 65, discard_reason: 'hangup' } }),
    ] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    expect(items.map(textOf)).toEqual([
      'Sam Example changed the group photo.\n[Photo: photos/group_0.jpg (not imported)]',
      'Sam Example made a phone call that lasted 1 minute 5 seconds.',
    ]);
    expect(counts(findings, 'skipped')).toEqual({});
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.mediaNotImported]: 1 });
  });

  test('a kind of content that is not read is a gap, never "nothing to read"; the words beside it are still kept', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [
      telegramText(0, 'First.'),
      telegramUnreadableKind(1, { rich_message: { rtl: false, part: false, blocks: [] } }),
      telegramUnreadableKind(2, { giveaway_information: { quantity: 5, months: 3, channels: [], countries: [], additional_prize: '', stars: 0 } }),
      telegramUnreadableKind(3, { type: 'unsupported' }),
      telegramUnreadableKind(4, { paid_stars_amount: 50 }, { text: 'Paid picture caption.' }),
      telegramText(5, ''),
    ] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    expect(items.map(textOf)).toEqual(['First.', 'Paid picture caption.']);
    expect(counts(findings, 'gap')).toEqual({ [TELEGRAM_FINDINGS.unsupported]: 4 });
    expect(counts(findings, 'skipped')).toEqual({ [TELEGRAM_FINDINGS.withoutText]: 1 });
  });

  test('a to-do list and a formatted poll are imported as messages, with their words to search', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [
      telegramTodo(0, 'Before sailing', ['Check the tide table', 'Fill the water tank']),
      telegramPoll(1, { extra: { poll: {
        question: [{ type: 'bold', text: 'Which harbour?' }],
        answers: [{ text: [{ type: 'bold', text: 'North quay' }], voters: 2 }],
      } } }),
    ] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    expect(items.map(textOf)).toEqual([
      'To-do list: Before sailing\n- Check the tide table\n- Fill the water tank',
      'Poll: Which harbour?\n- North quay (2 votes)',
    ]);
    expect(counts(findings, 'skipped')).toEqual({});
    expect(counts(findings, 'gap')).toEqual({});
  });

  test('a file the export left out keeps its name in the text and in the attachments, and is counted', async () => {
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [telegramFileLeftOut(0)] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    expect(textOf(items[0]!)).toBe('[File: synthetic-report.pdf (not in the export)]');
    expect(items[0]!.metadata).toMatchObject({ attachments: ['File: synthetic-report.pdf'], attachmentsNotIngested: 1 });
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.mediaNotImported]: 1 });
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
    expect(textOf(items[3]!)).toBe('[File: synthetic-report.pdf (not in the export)]');
    expect(items[3]!.metadata.attachmentsNotIngested).toBe(1);
    expect(items[4]!.metadata.attachmentsNotIngested).toBe(2);
    // One per message with its count, not one per file read: nothing was read. A file the export left out counts like the rest.
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.mediaNotImported]: 1 + 1 + 1 + 1 + 2 });
  });

  test('each part of an account export that is not chats becomes items: one per entry, the profile and other data one each', async () => {
    const file = exportFile(telegramJson(telegramFullExport({
      contacts: 3,
      chats: [telegramChat({ messages: telegramTexts(2) })],
    })));
    const { connector, findings } = connectorFor(file.dir, file.name, { pageSize: 1 });
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    // The profile, a profile picture, three contacts, a frequent contact, a session, the other data (web_sessions is written empty), then the messages.
    expect(items).toHaveLength(8 + 2);
    expect(items.map((item) => item.identity.providerThreadId)).toEqual([
      'account:personal_information', 'account:profile_pictures', 'account:contacts', 'account:contacts', 'account:contacts',
      'account:frequent_contacts', 'account:sessions', 'account:other_data', 'chats:0', 'chats:0',
    ]);
    expect(items.map((item) => item.metadata.title)).toEqual([
      'Telegram account: profile', 'Telegram account: profile pictures', 'Telegram account: contacts', 'Telegram account: contacts', 'Telegram account: contacts',
      'Telegram account: frequent contacts', 'Telegram account: sessions', 'Telegram account: other data', 'Synthetic Harbour Group', 'Synthetic Harbour Group',
    ]);
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(10);
    expect(textOf(items[0]!)).toBe([
      'Telegram profile: Sam Example (@synthetic_sam)',
      'User id: 1001',
      'First name: Sam',
      'Last name: Example',
      'Phone number: +1 555 0101',
      'Username: @synthetic_sam',
      'Bio: Synthetic account for tests.',
    ].join('\n'));
    expect(textOf(items[1]!)).toBe('Profile picture\n[Photo: profile_pictures/photo_1.jpg (not imported)]\nDate: 2015-01-04T09:00:00');
    expect(textOf(items[2]!)).toBe('Contact: Contact0 Placeholder\nFirst name: Contact0\nLast name: Placeholder\nPhone number: +1 555 0200\nDate: 2015-01-04T09:00:00');
    expect(textOf(items[4]!)).toContain('Contact: Contact2 Placeholder');
    expect(textOf(items[5]!)).toBe('Frequent contact: Synthetic Frequent (people)\nId: 2002\nCategory: people\nType: personal_chat\nName: Synthetic Frequent\nRating: 0.5');
    expect(textOf(items[6]!)).toBe([
      'Telegram session: on Synthetic Phone',
      'Last active: 2015-01-04T09:00:00',
      'Device model: Synthetic Phone',
      'Platform: Android',
    ].join('\n'));
    expect(textOf(items[7]!)).toBe('Other Telegram account data\nAbout: Synthetic placeholder text for a part of the export.\nNotes: Synthetic other data.');
    // The picture is named, not read: one finding, the way a message's picture is. Nothing else of the account is a loss.
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.mediaNotImported]: 1 });
    expect(counts(findings, 'skipped')).toEqual({});
    expect(items[1]!.metadata).toMatchObject({ attachmentsNotIngested: 1, attachments: ['Photo: profile_pictures/photo_1.jpg'] });
    expect(items[2]!.metadata).toMatchObject({ attachmentsNotIngested: 0, accountSection: 'contacts' });
  });

  test('an account entry has no date of its own: the chats\' dates and recency stay the messages\'', async () => {
    const file = exportFile(telegramJson(telegramFullExport({ contacts: 2, chats: [telegramChat({ messages: telegramTexts(2) })] })));
    const { connector } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    const account = items.filter((item) => String(item.identity.providerThreadId).startsWith('account:'));
    expect(account).toHaveLength(7);
    for (const item of account) {
      expect(item.metadata.authoredAt).toBeUndefined();
      expect(item.metadata.sentAt).toBeUndefined();
      expect(item.metadata.sender).toBeUndefined();
    }
    expect(items.filter((item) => !String(item.identity.providerThreadId).startsWith('account:')).map((item) => item.metadata.authoredAt))
      .toEqual([0, 1].map(telegramFixtureIso));
  });

  test('the classifier is given the part\'s title and thread, never a prior', async () => {
    const file = exportFile(telegramJson(telegramFullExport({ contacts: 1, chats: [] })));
    const { connector } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    const contact = items.find((item) => item.identity.providerThreadId === 'account:contacts')!;
    expect(connector.classificationSignals!(contact)).toEqual({ title: 'Telegram account: contacts', folderKeys: ['account:contacts'] });
  });

  test('a profile is one item however small the pages are, and a part with nothing in it makes none', async () => {
    const text = telegramJson(telegramFullExport({ omit: ['profile_pictures', 'contacts', 'frequent_contacts', 'sessions', 'other_data'], chats: [] }));
    const file = exportFile(text);
    const { connector, findings } = connectorFor(file.dir, file.name, { pageSize: 1, maxBytesPerListing: 1 });
    const out = await listAll(connector);
    // A budget of one byte ends the pass after the first thing it can hand over: the whole profile, never half of it.
    expect(out.items).toHaveLength(1);
    expect(textOf(out.items[0]!)).toContain('Bio: Synthetic account for tests.');
    expect(out.done).toBe(false);
    const rest = await listAll(connectorFor(file.dir, file.name, { maxBytesPerListing: 1 }).connector, out.cursors.at(-1));
    expect(rest.items).toEqual([]);
    expect(rest.done).toBe(true);
    expect(findings).toEqual([]);
  });

  test('an entry of the account export too large to build is one gap with its place; the entries around it are kept', async () => {
    const huge = 'x'.repeat(TELEGRAM_MAX_MESSAGE_BYTES + 1024);
    const full = telegramFullExport({ contacts: 2, chats: [] }) as Record<string, any>;
    full.contacts.list.splice(1, 0, { first_name: huge, phone_number: '+1 555 0999' });
    const file = exportFile(telegramJson(full));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    expect(items.filter((item) => item.identity.providerThreadId === 'account:contacts').map((item) => textOf(item).split('\n')[0]))
      .toEqual(['Contact: Contact0 Placeholder', 'Contact: Contact1 Placeholder']);
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.sectionNotImported]: 1, [ARCHIVE_COMMON_FINDINGS.mediaNotImported]: 1 });
  });

  test('a file cut inside the other data keeps what was read of it, and the file is counted as damaged', async () => {
    const text = telegramJson(telegramFullExport({ omit: ['profile_pictures', 'contacts', 'frequent_contacts', 'sessions'], chats: [] }));
    // After the first field of the other data, before the second.
    const cutAt = text.indexOf('"notes"');
    const file = exportFile(text.slice(0, cutAt));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.map((item) => item.identity.providerThreadId)).toEqual(['account:personal_information', 'account:other_data']);
    expect(textOf(items[1]!)).toBe('Other Telegram account data\nAbout: Synthetic placeholder text for a part of the export.');
    expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.fileDamaged]: 1 });
  });

  test('an export that excluded its personal sections has no such gaps', async () => {
    const file = exportFile(telegramJson(telegramFullExport({ withoutPersonalSections: true, chats: [telegramChat({ messages: telegramTexts(2) })] })));
    const { connector, findings } = connectorFor(file.dir, file.name);
    await listAll(connector);
    expect(findings).toEqual([]);
  });

  test('a very long message is kept whole and nothing is said; the next message is unaffected', async () => {
    // Past the one-million-character cut the reader used to make.
    const long = `${'The synthetic harbour log runs on. '.repeat(40_000)}END`;
    expect(long.length).toBeGreaterThan(1_000_000);
    const file = exportFile(telegramJson(telegramSingleChatExport(telegramChat({ messages: [
      telegramText(0, long), telegramText(1, 'Short.'),
    ] }))));
    const { connector, findings } = connectorFor(file.dir, file.name);
    const { items } = await listAll(connector);
    expect(items).toHaveLength(2);
    expect(textOf(items[0]!)).toBe(long);
    expect(items[0]!.identity.sourceVersion).toBe(createHash('sha256').update(long).digest('hex').slice(0, 32));
    expect(textOf(items[1]!)).toBe('Short.');
    expect(findings).toEqual([]);
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
    // The profile picture is the first thing found; then each message's own, in the order they are in the file.
    const byKind = Object.fromEntries(findings.map((finding) => [finding.kind, finding.offset]));
    expect(findings.map((finding) => finding.kind)).toEqual([
      ARCHIVE_COMMON_FINDINGS.mediaNotImported, ARCHIVE_COMMON_FINDINGS.mediaNotImported, TELEGRAM_FINDINGS.withoutText,
    ]);
    expect(byKind[TELEGRAM_FINDINGS.withoutText]).toBeGreaterThan(findings[1]!.offset);
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
    const text = telegramJson(telegramFullExport({ withoutPersonalSections: true, chats: [telegramChat({ messages })] }));
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

  test('a file that stops being JSON part-way is damaged too; every message before the damage is imported and the listing ends instead of throwing', async () => {
    // The second case puts the damage past several 1 MiB reads, in a read that also holds finished messages.
    for (const { total, damaged, minBytes } of [
      { total: 2500, damaged: 2000, minBytes: 0 },
      { total: 7500, damaged: 7000, minBytes: 2 * 1024 * 1024 },
    ]) {
      const messages = telegramTexts(total);
      const text = telegramJson(telegramSingleChatExport(telegramChat({ messages })));
      const at = text.indexOf(`"id": ${1000 + damaged},`);
      expect(at).toBeGreaterThan(0);
      const broken = `${text.slice(0, at)}!!! not json ${text.slice(at)}`;
      expect(Buffer.byteLength(broken.slice(0, at))).toBeGreaterThan(minBytes);
      const file = exportFile(broken);
      const { connector, findings } = connectorFor(file.dir, file.name, { pageSize: 50 });
      const { items, done, cursors } = await listAll(connector);
      expect(done).toBe(true);
      expect(cursors.at(-1)).toEndWith(':done');
      expect(counts(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.fileDamaged]: 1 });
      // Not one valid message before the damage is lost, and none after it is made up.
      expect(items.map((item) => textOf(item).split('\n')[0])).toEqual(
        Array.from({ length: damaged }, (_, index) => `The synthetic harbour log, entry ${index}.`),
      );
    }
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
  // The account's own items come first (the profile, a picture, a contact, a frequent contact, a session, other data), then the chats'.
  const ACCOUNT_WORDS = [
    'Telegram profile: Sam Example (@synthetic_sam)', 'Profile picture', 'Contact: Contact0 Placeholder', 'Frequent contact: Synthetic Frequent (people)',
    'Telegram session: on Synthetic Phone', 'Other Telegram account data',
  ];
  const WORDS = [...ACCOUNT_WORDS, 'a0', 'Sam Example joined the group by invite link.', 'a2', 'a3', 'b4', 'c5', 'c6', 'd7'];

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
    }
  });

  test('pages come in the size asked, resume points move forward, and the last page is done', async () => {
    const file = exportFile(TEXT);
    const { connector, positions } = connectorFor(file.dir, file.name, { pageSize: 3 });
    const pages: Array<{ n: number; done: boolean; cursor?: string }> = [];
    for await (const page of connector.listItems({})) pages.push({ n: page.items.length, done: page.done, ...(page.nextCursor ? { cursor: page.nextCursor } : {}) });
    expect(pages.map((page) => page.n)).toEqual([3, 3, 3, 3, 2]);
    expect(pages.map((page) => page.done)).toEqual([false, false, false, false, true]);
    expect(pages.at(-1)!.cursor).toEndWith(':done');
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.length).toBeGreaterThan(0);
  });

  test('a limit stops the listing at a message boundary and leaves a point to continue from', async () => {
    const file = exportFile(TEXT);
    const { connector } = connectorFor(file.dir, file.name, { pageSize: 10 });
    const first: RawItem[] = [];
    let cursor: string | undefined;
    // Eight items: past the account's six, so the limit falls among the chats' messages.
    for await (const page of connector.listItems({ limit: 8 })) {
      first.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(first).toHaveLength(8);
    const rest = await listAll(connectorFor(file.dir, file.name).connector, cursor);
    expect(rest.items.map((item) => textOf(item).split('\n')[0])).toEqual(WORDS.slice(8));
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

  test('a byte budget ends a pass early; the passes that follow bring in the rest', async () => {
    const file = exportFile(TEXT);
    const first = await listAll(connectorFor(file.dir, file.name, { pageSize: 100, maxBytesPerListing: 1 }).connector);
    expect(first.done).toBe(false);
    expect(first.items.length).toBeLessThan(WORDS.length);
    const words: string[] = first.items.map((item) => textOf(item).split('\n')[0]!);
    let cursor = first.cursors.at(-1);
    for (let pass = 0; cursor && !cursor.endsWith(':done'); pass += 1) {
      expect(pass).toBeLessThan(200);
      const next = await listAll(connectorFor(file.dir, file.name, { pageSize: 100, maxBytesPerListing: 1 }).connector, cursor);
      words.push(...next.items.map((item) => textOf(item).split('\n')[0]!));
      cursor = next.cursors.at(-1);
    }
    expect(words).toEqual(WORDS);
  });

  test('a pass can end inside the parts of an account export that are not chats; no entry is made twice or lost, and each finding is said once', async () => {
    const file = exportFile(TEXT);
    const whole = connectorFor(file.dir, file.name, { pageSize: 1 });
    const all = await listAll(whole.connector);
    const mediaOf = (list: readonly ArchiveImportFinding[]) =>
      list.filter((finding) => finding.kind === ARCHIVE_COMMON_FINDINGS.mediaNotImported).map((finding) => finding.offset);
    // The profile picture's, then the message a3's.
    expect(mediaOf(whole.findings)).toHaveLength(2);
    const chatsStart = Buffer.byteLength(TEXT.slice(0, TEXT.indexOf('"chats"')));

    // A budget of one byte ends each pass after the first thing it can hand over, wherever that is.
    const items: RawItem[] = [];
    const media: number[] = [];
    let cursor: string | undefined;
    let done = false;
    let passes = 0;
    const cursorsInSections: number[] = [];
    while (!done) {
      passes += 1;
      expect(passes).toBeLessThan(200);
      const pass = connectorFor(file.dir, file.name, { pageSize: 100, maxBytesPerListing: 1 });
      const out = await listAll(pass.connector, cursor);
      if (cursor) for (const finding of pass.findings) expect(finding.offset).toBeGreaterThan(cursorOffset(cursor));
      items.push(...out.items);
      media.push(...mediaOf(pass.findings));
      done = out.done;
      cursor = out.cursors.at(-1);
      if (!done && cursor && cursorOffset(cursor) < chatsStart) cursorsInSections.push(cursorOffset(cursor));
      if (passes === 1) {
        // The first pass stops among the parts: with the profile (all of it, never half), and a point to go on from.
        expect(out.items.map((item) => item.identity.providerThreadId)).toEqual(['account:personal_information']);
        expect(done).toBe(false);
        expect(cursorOffset(cursor!)).toBeLessThan(chatsStart);
      }
    }
    expect(cursorsInSections.length).toBeGreaterThan(3);
    expect(items.map((item) => item.identity.providerItemId)).toEqual(all.items.map((item) => item.identity.providerItemId));
    // The same findings at the same places as a pass that never stopped: none twice, none lost.
    expect(media).toEqual(mediaOf(whole.findings));
  });

  test('a long part of an account export is read in more than one pass when it is longer than the budget', async () => {
    // The budget counts bytes read, in reads of 1 MiB: a part of 2.5 MiB with a budget just over one read needs several passes.
    const text = telegramJson(telegramFullExport({ contacts: 16_000, chats: [telegramChat({ messages: telegramTexts(3) })] }));
    const file = exportFile(text);
    const chatsStart = Buffer.byteLength(text.slice(0, text.indexOf('"chats"')));
    expect(chatsStart).toBeGreaterThan(2.5 * 1024 * 1024);
    let cursor: string | undefined;
    let passes = 0;
    let passesEndingInTheParts = 0;
    let done = false;
    const items: RawItem[] = [];
    while (!done) {
      passes += 1;
      expect(passes).toBeLessThan(50);
      const out = await listAll(connectorFor(file.dir, file.name, { maxBytesPerListing: 1024 * 1024 + 1 }).connector, cursor);
      items.push(...out.items);
      done = out.done;
      cursor = out.cursors.at(-1);
      if (!done && cursor && cursorOffset(cursor) < chatsStart) passesEndingInTheParts += 1;
    }
    expect(passesEndingInTheParts).toBeGreaterThanOrEqual(2);
    // Every contact once, and the rest of the account, and the three messages.
    expect(items.filter((item) => item.identity.providerThreadId === 'account:contacts')).toHaveLength(16_000);
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(items.length);
    expect(items).toHaveLength(16_000 + 5 + 3);
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
      // Valid, but not the place after a message or after an entry of a part of the account export: inside a chat header, a part's header, the root.
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [] })}`,
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [level('object', 'contacts')] })}`,
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [level('object', 'contacts'), level('array', 0)] })}`,
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [level('object', 'contacts'), level('object', 'about'), level('array', 0)] })}`,
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [level('object', 'contacts'), level('object', 'list'), level('array', -1)] })}`,
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [level('object', 'personal_information')] })}`,
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [level('object', 'about'), level('object', 'x')] })}`,
      // After an entry of a part of the account export, but where no entry ends: the reader refuses the place itself.
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [level('object', 'contacts'), level('object', 'list'), level('array', 0)] })}`,
      `${tag}:0:${serializeJsonResume({ offset: 10, levels: [level('object', 'personal_information'), level('object', 'first_name')] })}`,
      // After a part's entry, but past the end of the file.
      `${tag}:0:${serializeJsonResume({ offset: size + 1, levels: [level('object', 'contacts'), level('object', 'list'), level('array', 0)] })}`,
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

  test('a file that was not imported is not said to have been in the archive: some were only referred to, and some the export left out', () => {
    const sentence = DASHBOARD_ARCHIVE_COPY.gaps.media_not_imported;
    for (const words of [sentence.one, sentence.many]) {
      expect(words).not.toMatch(/\bin the archive\b/);
      expect(words).toContain('the archive refers to');
    }
  });
});

describe('the first timestamp of the fixtures', () => {
  test('is 2015-01-05T10:00:00Z', () => {
    expect(new Date(TELEGRAM_FIXTURE_FIRST_SECONDS * 1000).toISOString()).toBe('2015-01-05T10:00:00.000Z');
  });
});
