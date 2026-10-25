// The WhatsApp export grammar and its streaming readers: header lines in the
// styles phones write, the date order read from the file's headers, messages
// that span lines, the same messages whatever size the chunks come in, and
// readers that stop at a byte read and start again exactly there. Synthetic
// text only.

import { describe, expect, test } from 'bun:test';
import { WHATSAPP_ARCHIVE_FORMAT, type ArchiveProbe } from '../src/core/archive-formats.ts';
import { crc32Update, fileByteSource, type ArchiveByteSource } from '../src/workers/archive-import/byte-source.ts';
import { ZipArchive, ZipMemberReader } from '../src/workers/archive-import/zip-reader.ts';
import {
  WHATSAPP_HEADER_PREFIX_BYTES,
  hasWhatsAppExportName,
  isWhatsAppMediaOmitted,
  isWhatsAppZipNoise,
  looksLikeWhatsAppChat,
  matchWhatsAppHeader,
  normalizeWhatsAppLine,
  resolveWhatsAppHeader,
  splitWhatsAppSender,
  startsWithWhatsAppHeader,
  whatsAppAttachedFileName,
  whatsAppChatNameFromStem,
  whatsAppMediaMarkerCount,
  whatsAppOrderEvidence,
} from '../src/workers/archive-import/whatsapp/grammar.ts';
import {
  WhatsAppFormatError,
  WhatsAppLineReader,
  WhatsAppMessageReader,
  scanWhatsAppDateOrder,
  type WhatsAppEntry,
  type WhatsAppRawMessage,
} from '../src/workers/archive-import/whatsapp/messages.ts';
import { buildZip, memoryRangeReader } from './helpers/zip-fixture.ts';
import {
  BOM,
  LRM,
  NARROW_NBSP,
  chatText,
  messageLine,
  notice,
  styleStamp,
  syntheticChat,
  type SyntheticStyle,
} from './support/archive-fixtures-whatsapp.ts';

function memory(text: string | Uint8Array) {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text);
  return {
    size: bytes.length,
    readAt: (offset: number, length: number) => new Uint8Array(bytes.subarray(offset, offset + length)),
  };
}

/** A source over text that keeps a CRC-32 of the bytes before its position, as a stored zip member does. */
function checksummedSource(text: string, chunkBytes: number, start = 0): ArchiveByteSource {
  const bytes = Buffer.from(text, 'utf8');
  const inner = fileByteSource(memory(bytes), { chunkBytes, start });
  return {
    get position() { return inner.position; },
    next: () => inner.next(),
    unread: (count: number) => inner.unread(count),
    get crc32() { return crc32Update(0, bytes.subarray(0, inner.position)); },
  };
}

function crcBefore(text: string, offset: number): number {
  return crc32Update(0, Buffer.from(text, 'utf8').subarray(0, offset));
}

interface ReadOptions {
  chunkBytes?: number;
  start?: number;
  entry?: WhatsAppEntry;
  maxMessageBytes?: number;
}

function readAll(text: string, options: ReadOptions = {}): WhatsAppRawMessage[] {
  const source = fileByteSource(memory(text), { chunkBytes: options.chunkBytes ?? 1024 * 1024, start: options.start ?? 0 });
  const reader = new WhatsAppMessageReader(source, options.entry ?? { kind: 'start' }, {
    ...(options.maxMessageBytes !== undefined ? { maxMessageBytes: options.maxMessageBytes } : {}),
  });
  const messages: WhatsAppRawMessage[] = [];
  for (let step = reader.next(); step.kind === 'message'; step = reader.next()) messages.push(step.message);
  return messages;
}

const STYLES: Array<[SyntheticStyle, 'dmy' | 'mdy' | 'ymd']> = [
  ['ios-24-dmy', 'dmy'],
  ['ios-12-mdy', 'mdy'],
  ['android-24-dmy', 'dmy'],
  ['android-12-mdy', 'mdy'],
  ['android-dot-dmy', 'dmy'],
  ['iso', 'ymd'],
];

describe('whatsapp header grammar', () => {
  test.each(STYLES)('%s: a message line reads back to the time it was written with', (style, order) => {
    for (const at of ['2026-05-14T21:08:07', '2026-05-14T00:05:00', '2026-05-14T12:30:00', '2025-12-31T23:59:58']) {
      const line = messageLine({ at, sender: 'Sam Example', text: 'Hello: there' }, { style });
      const match = matchWhatsAppHeader(normalizeWhatsAppLine(line));
      expect(match).toBeDefined();
      const resolved = resolveWhatsAppHeader(match!, order)!;
      const seconds = style.startsWith('android') || style === 'iso' ? '00' : at.slice(17);
      expect(resolved.sentAt).toBe(`${at.slice(0, 17)}${seconds}`);
      expect(splitWhatsAppSender(match!.rest)).toEqual({ sender: 'Sam Example', text: 'Hello: there' });
    }
  });

  test('each header carries the style it was written in, and one export keeps one style', () => {
    const styleOf = (style: SyntheticStyle) =>
      matchWhatsAppHeader(normalizeWhatsAppLine(messageLine({ at: '2026-05-14T21:08:07', sender: 'A', text: 'x' }, { style })))!.style;
    const all = STYLES.map(([style]) => styleOf(style));
    expect(new Set(all).size).toBe(STYLES.length);
    // Another message of the same export is in the same style, whatever its numbers.
    const other = matchWhatsAppHeader(normalizeWhatsAppLine(messageLine({ at: '2025-01-02T03:04:05', sender: 'B', text: 'y' }, { style: 'ios-12-mdy' })))!.style;
    expect(other).toBe(styleOf('ios-12-mdy'));
    // A header typed by hand into a message differs from the export's style in a part or two.
    expect(matchWhatsAppHeader('[1/2/23, 10:00] X: y')!.style).not.toBe(styleOf('ios-12-mdy'));
    expect(matchWhatsAppHeader('1/2/23, 10:00 - X: y')!.style).not.toBe(styleOf('android-12-mdy'));
  });

  test('a day above 12 settles the order; two small numbers do not', () => {
    const header = (stamp: string) => matchWhatsAppHeader(`${stamp} - Sam: hi`)!;
    expect(whatsAppOrderEvidence(header('14/05/2026, 21:08'))).toBe('dmy');
    expect(whatsAppOrderEvidence(header('5/14/26, 9:08 PM'))).toBe('mdy');
    expect(whatsAppOrderEvidence(header('2026-05-14, 21:08'))).toBe('ymd');
    expect(whatsAppOrderEvidence(header('03/04/2026, 21:08'))).toBeUndefined();
    const ambiguous = header('03/04/2026, 21:08');
    expect(resolveWhatsAppHeader(ambiguous, 'dmy')!.sentAt).toBe('2026-04-03T21:08:00');
    expect(resolveWhatsAppHeader(ambiguous, 'mdy')!.sentAt).toBe('2026-03-04T21:08:00');
  });

  test('direction marks, narrow spaces and a byte order mark do not hide a header', () => {
    const line = `${BOM}${LRM}[5/14/26, 9:08:00${NARROW_NBSP}PM] Sam Example: ${LRM}image omitted`;
    const match = matchWhatsAppHeader(normalizeWhatsAppLine(line))!;
    expect(resolveWhatsAppHeader(match, 'mdy')!.sentAt).toBe('2026-05-14T21:08:00');
    expect(splitWhatsAppSender(match.rest)).toEqual({ sender: 'Sam Example', text: 'image omitted' });
  });

  test('12 and 24 hour clocks: midnight, noon and the a.m. spelling', () => {
    const at = (line: string) => resolveWhatsAppHeader(matchWhatsAppHeader(line)!, 'dmy')!.sentAt;
    expect(at('14/05/2026, 12:00 AM - A: x')).toBe('2026-05-14T00:00:00');
    expect(at('14/05/2026, 12:00 PM - A: x')).toBe('2026-05-14T12:00:00');
    expect(at('[14/05/2026, 9:08:00 p. m.] A: x')).toBe('2026-05-14T21:08:00');
    expect(at('14/05/2026, 23:59 - A: x')).toBe('2026-05-14T23:59:00');
  });

  test('lines that are not headers: plain text, impossible dates and times, odd years', () => {
    for (const line of [
      'just a sentence', '31/02/2026, 10:00 - A: x', '14/05/2026, 25:00 - A: x', '14/05/2026, 10:61 - A: x',
      '14/05/2026, 13:00 PM - A: x', '123/1/2020, 10:00 - A: x', '14/05/202, 10:00 - A: x', '14/05/2026 10:00 A: x',
    ]) {
      expect(matchWhatsAppHeader(line)).toBeUndefined();
    }
  });

  test('a notice has no sender; a long stretch before a colon is a sentence, not a name', () => {
    expect(splitWhatsAppSender('Messages and calls are end-to-end encrypted.')).toEqual({ text: 'Messages and calls are end-to-end encrypted.' });
    expect(splitWhatsAppSender('Sam: ')).toEqual({ sender: 'Sam', text: '' });
    expect(splitWhatsAppSender(`${'x'.repeat(200)}: tail`).sender).toBeUndefined();
    expect(splitWhatsAppSender('Sam:no space')).toEqual({ text: 'Sam:no space' });
  });

  test('media markers: attached files, omitted notes, and ordinary text', () => {
    expect(whatsAppAttachedFileName('<attached: 00000042-PHOTO-2020-06-07-10-05-12.jpg>')).toBe('00000042-PHOTO-2020-06-07-10-05-12.jpg');
    expect(whatsAppAttachedFileName(`${LRM}<Anhang: 00000007-VCARD.vcf>`)).toBe('00000007-VCARD.vcf');
    expect(whatsAppAttachedFileName('IMG-20200607-WA0001.jpg (file attached)')).toBe('IMG-20200607-WA0001.jpg');
    expect(whatsAppAttachedFileName('I saw IMG-20200607-WA0001.jpg yesterday')).toBeUndefined();
    expect(isWhatsAppMediaOmitted('<Media omitted>')).toBe(true);
    expect(isWhatsAppMediaOmitted(`${LRM}image omitted`)).toBe(true);
    expect(isWhatsAppMediaOmitted('<This message was edited>')).toBe(false);
    expect(isWhatsAppMediaOmitted('see you at 5, nothing omitted here maybe')).toBe(false);
    expect(whatsAppMediaMarkerCount('<attached: 00000001-PHOTO-2020-01-01-00-00-00.jpg>\ncaption line\n<attached: 00000002-PHOTO-2020-01-01-00-00-01.jpg>')).toBe(2);
    expect(whatsAppMediaMarkerCount('<Media omitted>')).toBe(1);
    expect(whatsAppMediaMarkerCount('plain words')).toBe(0);
  });

  test('chat names come from the export file names; zip noise and export names are told apart', () => {
    expect(whatsAppChatNameFromStem('WhatsApp Chat with Harbour crew')).toBe('Harbour crew');
    expect(whatsAppChatNameFromStem('WhatsApp Chat - Sam Example')).toBe('Sam Example');
    expect(whatsAppChatNameFromStem('_chat')).toBeUndefined();
    expect(isWhatsAppZipNoise('__MACOSX/._chat.txt')).toBe(true);
    expect(isWhatsAppZipNoise('folder/')).toBe(true);
    expect(isWhatsAppZipNoise('_chat.txt')).toBe(false);
    expect(hasWhatsAppExportName('_chat.txt')).toBe(true);
    expect(hasWhatsAppExportName('Export/WhatsApp Chat with Sam.txt')).toBe(true);
    expect(hasWhatsAppExportName('__MACOSX/._WhatsApp Chat with Sam.txt')).toBe(false);
    expect(hasWhatsAppExportName('notes.txt')).toBe(false);
    expect(hasWhatsAppExportName('build.txt')).toBe(false);
    expect(hasWhatsAppExportName('whatsapp-debug.txt')).toBe(false);
    expect(hasWhatsAppExportName('00000042-PHOTO.jpg')).toBe(false);
  });

  test('detection looks at the first bytes only: a header line, as text', () => {
    const head = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));
    expect(looksLikeWhatsAppChat(head(chatText(syntheticChat(3), { style: 'ios-24-dmy', bom: true })))).toBe(true);
    expect(looksLikeWhatsAppChat(head(`\n\n${chatText(syntheticChat(3), { style: 'android-24-dmy' })}`))).toBe(true);
    expect(looksLikeWhatsAppChat(head('Dear diary, today was a long synthetic day.\n'))).toBe(false);
    expect(looksLikeWhatsAppChat(head('{"name": "Synthetic export", "chats": []}'))).toBe(false);
    expect(looksLikeWhatsAppChat(undefined)).toBe(false);
    expect(looksLikeWhatsAppChat(new Uint8Array([0x5b, 0x00, 0x31, 0x00, 0x2f, 0x00, 0x31, 0x00, 0x2f, 0x00, 0x32, 0x00]))).toBe(false);
  });

  test('a line is judged a header from its first bytes, so a line of megabytes costs no more than a short one', () => {
    const header = `14/05/2026, 21:08 - Sam Example: ${'y'.repeat(1_000_000)}`;
    expect(header.length).toBeGreaterThan(WHATSAPP_HEADER_PREFIX_BYTES);
    expect(startsWithWhatsAppHeader(Buffer.from(header, 'utf8'))).toBe(true);
    expect(startsWithWhatsAppHeader(Buffer.from(`${'y'.repeat(1_000_000)} 14/05/2026, 21:08 - Sam Example: x`, 'utf8'))).toBe(false);
    expect(startsWithWhatsAppHeader(Buffer.from('plain', 'utf8'))).toBe(false);
  });
});

describe('detection and the connector grammar agree', () => {
  // The format definition carries its own smaller signature (core does not hold the grammar).
  // Everything the grammar reads as a first line must be a first line the definition accepts, and
  // text neither reads must be refused by both. The signature may be looser on impossible dates.
  const probeOf = (text: string): ArchiveProbe => ({
    chosen: { relPath: '', name: 'chat.txt', kind: 'file', head: new Uint8Array(Buffer.from(text, 'utf8')) },
    children: [],
  });
  const detects = (text: string): boolean => WHATSAPP_ARCHIVE_FORMAT.detect(probeOf(text)) !== undefined;

  test('every style the phones write, with their invisible marks, is detected', () => {
    const times = ['2026-05-14T21:08:07', '2026-05-14T00:05:00', '2026-05-14T12:30:00', '2025-12-31T23:59:58'];
    for (const [style] of STYLES) {
      for (const at of times) {
        for (const decorate of [(text: string) => text, (text: string) => `${BOM}${text}`, (text: string) => text.replace(/\n$/, '\r\n')]) {
          const text = decorate(chatText([{ at, sender: 'Sam Example', text: 'hello there' }], { style }));
          expect(looksLikeWhatsAppChat(Buffer.from(text, 'utf8'))).toBe(true);
          expect(detects(text)).toBe(true);
        }
      }
    }
  });

  test('prose, JSON, mail, binary and an empty file are refused by both', () => {
    for (const text of [
      'Dear diary, today was a long synthetic day.\nNothing happened.\n',
      '{"name":"Synthetic","chats":{"list":[]}}',
      'From sender@example.invalid Mon Jan  5 10:00:00 2015\nSubject: x\n',
      '',
      '\n\n   \n',
      `${String.fromCharCode(0).repeat(40)}14/05/2026, 10:00 - A: x`,
    ]) {
      expect(looksLikeWhatsAppChat(Buffer.from(text, 'utf8'))).toBe(false);
      expect(detects(text)).toBe(false);
    }
  });
});

describe('whatsapp message reader', () => {
  const sample = chatText([
    ...syntheticChat(2, { start: '2026-05-13T09:00:00' }),
    { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: 'first line\nsecond line\n\nfourth line' },
    notice('2026-05-14T10:01:00'),
    { at: '2026-05-14T10:02:00', sender: 'Alex Example', text: 'last one' },
  ], { style: 'android-24-dmy' });

  test('a message may span lines, and the notice between has no sender', () => {
    const messages = readAll(sample);
    expect(messages.map((message) => message.sender)).toEqual(['Sam Example', 'Alex Example', 'Sam Example', undefined, 'Alex Example']);
    expect(messages[2]!.text).toBe('first line\nsecond line\n\nfourth line');
    expect(messages[3]!.text).toBe('Messages and calls are end-to-end encrypted.');
    expect(messages[0]!.offset).toBe(0);
    for (const message of messages) {
      expect(Buffer.from(sample, 'utf8').subarray(message.offset, message.offset + 10).toString('utf8')).toMatch(/^\d{2}\/\d{2}\/\d{4}/);
    }
  });

  test('chunk size changes nothing: the same messages and offsets, down to one byte', () => {
    const whole = readAll(sample);
    for (const chunkBytes of [1, 2, 3, 7, 16, 64]) {
      expect(readAll(sample, { chunkBytes })).toEqual(whole);
    }
    const crlf = chatText(syntheticChat(6), { style: 'ios-24-dmy', crlf: true, bom: true });
    expect(readAll(crlf, { chunkBytes: 5 })).toEqual(readAll(crlf));
    expect(readAll(crlf)[0]!.text).toBe('The synthetic harbour log, entry 0.');
  });

  test('it enters at a message and refuses a place that is not one', () => {
    const whole = readAll(sample);
    const rest = readAll(sample, { start: whole[2]!.offset, entry: { kind: 'message' } });
    expect(rest).toEqual(whole.slice(2));
    expect(() => readAll(sample, { start: whole[2]!.offset + 5, entry: { kind: 'message' } })).toThrow(WhatsAppFormatError);
    // A line of a multi-line message is not a place to resume at.
    const secondLine = Buffer.from(sample, 'utf8').indexOf('second line');
    expect(() => readAll(sample, { start: secondLine, entry: { kind: 'message' } })).toThrow(WhatsAppFormatError);
  });

  test('lines before the first header are ignored; a file with no header has no message', () => {
    const messages = readAll(`${BOM}\nExported by a synthetic phone\n${sample}`);
    expect(messages).toHaveLength(5);
    expect(readAll('nothing here\nat all\n')).toEqual([]);
    expect(readAll('')).toEqual([]);
  });

  test('a long message keeps all its text, however many lines; the next message is not affected', () => {
    // Past the million characters the reader used to keep, across lines of different lengths.
    const long = 'x'.repeat(300_000);
    const lines = Array.from({ length: 5 }, (_, index) => `${index}${long}`);
    const text = chatText([
      { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: lines.join('\n') },
      { at: '2026-05-14T10:01:00', sender: 'Alex Example', text: 'short' },
    ], { style: 'android-24-dmy' });
    const messages = readAll(text);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.cut).toBe(false);
    expect(messages[0]!.text).toBe(lines.join('\n'));
    expect(messages[0]!.text.length).toBeGreaterThan(1_500_000);
    expect(messages[1]).toMatchObject({ cut: false, text: 'short', sender: 'Alex Example' });
    expect(readAll(text, { chunkBytes: 4093 })).toEqual(messages);
  });

  test('a header at the very end of the file, with no line break, is a message', () => {
    const text = chatText(syntheticChat(2), { style: 'android-24-dmy', noFinalNewline: true });
    const messages = readAll(text);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.text).toBe('The synthetic harbour log, entry 1.');
  });

  test('a line of megabytes is read in bounded memory and the message says it was cut', () => {
    const big = `14/05/2026, 10:00 - Sam Example: ${'y'.repeat(6 * 1024 * 1024)}\n14/05/2026, 10:01 - Alex Example: after\n`;
    const messages = readAll(big, { chunkBytes: 1024 * 1024 });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.cut).toBe(true);
    // The reader keeps no more of a line than its memory bound.
    expect(messages[0]!.text.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(messages[1]!.text).toBe('after');
  });

  test('a header pasted into a message body starts a message, in its own style: the format cannot say otherwise', () => {
    const text = [
      '14/05/2026, 10:00 - Sam Example: look at what Pat sent',
      '[1/2/23, 10:00] Pat: pasted from another chat',
      '14/05/2026, 10:05 - Alex Example: thanks',
      '',
    ].join('\n');
    const messages = readAll(text);
    expect(messages.map((message) => message.sender)).toEqual(['Sam Example', 'Pat', 'Alex Example']);
    // The reader hands over each header as the file wrote it, with its style, so the caller can tell a stranger from the export's own.
    expect(messages[1]!.header.style).not.toBe(messages[0]!.header.style);
    expect(messages[2]!.header.style).toBe(messages[0]!.header.style);
  });
});

describe('whatsapp message reader stops at byte reads and starts again exactly there', () => {
  /** A chat whose middle message is far larger than the message bound the readers are given. */
  const huge = chatText([
    { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: 'before' },
    { at: '2026-05-14T10:01:00', sender: 'Alex Example', text: Array.from({ length: 400 }, (_, index) => `line ${index} ${'z'.repeat(280)}`).join('\n') },
    { at: '2026-05-14T10:02:00', sender: 'Sam Example', text: 'after' },
    { at: '2026-05-14T10:03:00', sender: 'Alex Example', text: 'and last' },
  ], { style: 'android-24-dmy' });
  const hugeFile = memory(huge);
  const MESSAGE_BOUND = 2000;

  test('a message over the byte bound is cut after about that many bytes, not read to its end', () => {
    const source = fileByteSource(hugeFile, { chunkBytes: 512 });
    const reader = new WhatsAppMessageReader(source, { kind: 'start' }, { maxMessageBytes: MESSAGE_BOUND });
    const first = reader.next();
    expect(first.kind === 'message' && first.message.text).toBe('before');
    const second = reader.next();
    expect(second.kind).toBe('message');
    if (second.kind !== 'message') return;
    expect(second.message.cut).toBe(true);
    const bigStart = Buffer.from(huge, 'utf8').indexOf('14/05/2026, 10:01');
    // Nothing past the bound and the chunk it ended in was read: the other 100 KB were not.
    expect(source.position).toBeLessThanOrEqual(bigStart + MESSAGE_BOUND + 512 * 3);
    expect(hugeFile.size).toBeGreaterThan(100_000);
  });

  test('reading may stop while the rest of a cut message is dropped, and a new reader goes on from where it says', () => {
    const whole = readAll(huge, { maxMessageBytes: MESSAGE_BOUND, chunkBytes: 512 });
    expect(whole.map((message) => message.text.slice(0, 6))).toEqual(['before', 'line 0', 'after', 'and la']);
    for (const chunkBytes of [64, 512]) {
      // A line is judged from its first 160 bytes, so a stop inside one starts it again: enough reads to get past them.
      for (const allowReads of [3, 5, 40]) {
        const messages: WhatsAppRawMessage[] = [];
        let entry: WhatsAppEntry = { kind: 'start' };
        let start = 0;
        let rounds = 0;
        let pauses = 0;
        for (; rounds < 50_000; rounds += 1) {
          const source = fileByteSource(hugeFile, { chunkBytes, start });
          const reader: WhatsAppMessageReader = new WhatsAppMessageReader(source, entry, { maxMessageBytes: MESSAGE_BOUND });
          let paused = false;
          for (;;) {
            // Each step may take `allowReads` reads of dropped bytes before the reader has to stop.
            let allowed = allowReads;
            const step = reader.next(() => allowed-- > 0);
            if (step.kind === 'message') { messages.push(step.message); continue; }
            paused = step.kind === 'paused';
            break;
          }
          if (!paused) break;
          pauses += 1;
          const at: NonNullable<ReturnType<WhatsAppMessageReader['resume']>> = reader.resume()!;
          // A pause is always in the lines being dropped, never in the middle of a message.
          expect(at.kind).toBe('skip');
          start = at.offset;
          entry = at.kind === 'skip' ? { kind: 'skip', midLine: at.midLine } : { kind: 'message' };
        }
        expect(rounds).toBeLessThan(50_000);
        expect(messages).toEqual(whole);
        // The reads were limited, so the stop happened: 100 KB of dropped bytes cannot be read in a few small chunks.
        if (allowReads <= 5 && chunkBytes <= 64) expect(pauses).toBeGreaterThan(5);
      }
    }
  });

  test('the resume point of a message is its header line, with the checksum of everything before it', () => {
    const text = chatText(syntheticChat(12), { style: 'android-24-dmy' });
    for (const chunkBytes of [1, 5, 16, 64, 1024]) {
      const source = checksummedSource(text, chunkBytes);
      const reader = new WhatsAppMessageReader(source);
      const seen: number[] = [];
      for (let step = reader.next(); step.kind === 'message'; step = reader.next()) {
        seen.push(step.message.offset);
        const at = reader.resume();
        if (!at) continue;
        expect(at.kind).toBe('message');
        // The header line that begins the next message may straddle chunks; its checksum is still known.
        expect(at.crc).toBe(crcBefore(text, at.offset));
        expect(Buffer.from(text, 'utf8').subarray(at.offset, at.offset + 2).toString('utf8')).toMatch(/^\d\d$/);
      }
      expect(seen).toHaveLength(12);
    }
  });

  test('a stored zip member resumed at a header that straddled a read still verifies to its end', () => {
    // Messages one read long less 20 bytes, so every header begins 20 bytes before a read ends.
    const read = 1024 * 1024;
    const prefix = messageLine({ at: '2026-05-14T10:00:00', sender: 'Sam Example', text: '' }, { style: 'android-24-dmy' });
    const text = chatText(Array.from({ length: 4 }, (_, index) => ({
      at: `2026-05-14T10:0${index}:00`,
      sender: 'Sam Example',
      text: 'x'.repeat(read - 20 - Buffer.byteLength(prefix, 'utf8') - 1),
    })), { style: 'android-24-dmy' });
    const archive = ZipArchive.open(memoryRangeReader(buildZip([{ name: '_chat.txt', data: Buffer.from(text, 'utf8'), method: 'stored' }])));
    const entry = [...archive.entries()][0]!;
    let offset = 0;
    let crc: number | undefined;
    let ends = 0;
    const found: number[] = [];
    for (let pass = 0; pass < 10; pass += 1) {
      const member = ZipMemberReader.open(archive, entry, { start: offset, ...(crc !== undefined ? { startCrc: crc } : {}) });
      const reader = new WhatsAppMessageReader(member, offset === 0 ? { kind: 'start' } : { kind: 'message' });
      const step = reader.next();
      if (step.kind !== 'message') throw new Error('expected a message');
      found.push(step.message.offset);
      const at = reader.resume();
      if (!at) {
        // The last message ends the member: its checksum must have been followed all the way.
        for (let more = reader.next(); more.kind !== 'end'; more = reader.next());
        expect(member.end?.crcOk).toBe(true);
        ends += 1;
        member.close();
        break;
      }
      // The next header started inside the read this message ended in, and its checksum is known.
      expect(at.crc).toBeDefined();
      offset = at.offset;
      crc = at.crc;
      member.close();
    }
    expect(ends).toBe(1);
    expect(found).toHaveLength(4);
  });
});

describe('whatsapp date order scan', () => {
  const scan = (text: string, chunkBytes = 1024 * 1024, options: { maxBytes?: number; votesEnough?: number } = {}) =>
    scanWhatsAppDateOrder(fileByteSource(memory(text), { chunkBytes }), options);

  test('a first part above 12 is a day, a second above 12 is a day, a leading year is a year', () => {
    const one = (style: SyntheticStyle) => scan(chatText([{ at: '2026-05-14T10:00:00', sender: 'A', text: 'x' }], { style }));
    expect(one('android-24-dmy')).toMatchObject({ order: 'dmy', assumed: false });
    expect(one('android-12-mdy')).toMatchObject({ order: 'mdy', assumed: false });
    expect(one('iso')).toMatchObject({ order: 'ymd', assumed: false });
  });

  test('the order most headers say wins, not the first that says: one header pasted into a message cannot decide a file', () => {
    const pasted = '25/03/2026, 10:01 - Pat: pasted from a day first chat';
    const real = Array.from({ length: 6 }, (_, index) => `03/${20 + index}/2026, 11:0${index} - Sam: written by the month first phone`);
    const text = `03/04/2026, 10:00 - Sam: opening\n${pasted}\n${real.join('\n')}\n`;
    expect(scan(text)).toMatchObject({ order: 'mdy', assumed: false });
    expect(scan(text, 16)).toMatchObject({ order: 'mdy', assumed: false });
  });

  test('a pasted header dated before the one above it does not vote, whichever way the one above is read', () => {
    // The real message is ambiguous (1 February or 2 January); the pasted one is from an older month first chat.
    const text = '01/02/2026, 10:00 - Sam: the real message\n12/25/2023, 09:00 - Pat: pasted from an old month first chat\n';
    expect(scan(text)).toMatchObject({ order: 'dmy', assumed: true });
    expect(scan(text, 16)).toMatchObject({ order: 'dmy', assumed: true });
    // In order, the same two headers are a month first file.
    expect(scan('01/02/2026, 10:00 - Sam: the real message\n12/25/2026, 09:00 - Pat: written later\n')).toMatchObject({ order: 'mdy', assumed: false });
    // Dated before the one above under one reading only, it is not out of order.
    expect(scan('03/04/2026, 10:00 - Sam: opening\n25/03/2026, 10:01 - Pat: later\n')).toMatchObject({ order: 'dmy', assumed: false });
  });

  test('a few headers in a row dated before the one above them are taken as the file\'s own dates after all', () => {
    // A header from the future pasted into a message: the real ones that follow are dated before it.
    const real = Array.from({ length: 6 }, (_, index) => `03/${20 + index}/2026, 11:0${index} - Sam: written by the month first phone`);
    const text = `03/04/2026, 10:00 - Sam: opening\n25/03/2030, 10:01 - Pat: pasted from the future\n${real.join('\n')}\n`;
    expect(scan(text)).toMatchObject({ order: 'mdy', assumed: false });
  });

  test('a tie between orders, or headers that never say, is day first and says it was taken', () => {
    expect(scan('03/25/2026, 10:00 - A: one\n25/03/2026, 10:01 - A: two\n')).toMatchObject({ order: 'dmy', assumed: true });
    expect(scan('03/04/2026, 10:00 - A: one\n04/05/2026, 10:00 - A: two\n')).toMatchObject({ order: 'dmy', assumed: true });
  });

  test('a file whose dates read the same either way is not an assumption', () => {
    expect(scan('05/05/2026, 10:00 - A: one\n06/06/2026, 10:00 - A: two\n')).toMatchObject({ order: 'dmy', assumed: false });
    const none = scan('nothing\n');
    expect(none).toMatchObject({ order: 'dmy', assumed: false });
    expect(none.style).toBeUndefined();
  });

  test('headers in another style than the first do not vote', () => {
    const text = [
      '03/04/2026, 10:00 - A: the first header fixes the style',
      '[3/25/26, 11:00:00 AM] B: a bracketed stranger',
      '[3/26/26, 11:01:00 AM] B: another',
      '[3/27/26, 11:02:00 AM] B: and another',
      '',
    ].join('\n');
    const found = scan(text);
    expect(found).toMatchObject({ order: 'dmy', assumed: true });
    expect(found.style).toBe(matchWhatsAppHeader('03/04/2026, 10:00 - A: x')!.style);
  });

  test('the scan reads a bounded amount and says how much, even through a file with no header at all', () => {
    const lines = Array.from({ length: 4000 }, (_, index) => `03/04/2026, 10:00 - A: ambiguous ${index}\n`).join('');
    expect(scan(lines, 64, { maxBytes: 1000 }).bytesRead).toBeLessThanOrEqual(1000 + 64 * 4);
    const junk = `${'no header here, only filler text\n'.repeat(5000)}25/03/2026, 10:00 - A: late\n`;
    const dropped = scan(junk, 64, { maxBytes: 1000 });
    expect(dropped.bytesRead).toBeLessThanOrEqual(1000 + 64 * 4);
    expect(dropped.style).toBeUndefined();
    // Enough votes end it early.
    const voting = Array.from({ length: 100 }, (_, index) => `25/03/2026, 10:${String(index % 60).padStart(2, '0')} - A: ${index}\n`).join('');
    const early = scan(voting, 64, { votesEnough: 5 });
    expect(early).toMatchObject({ order: 'dmy', assumed: false });
    expect(early.bytesRead).toBeLessThan(voting.length / 2);
  });
});

describe('whatsapp line reader', () => {
  test('lines keep their offsets across chunks and drop their line breaks', () => {
    const text = 'one\r\ntwo\n\nlast without break';
    const source = fileByteSource(memory(text), { chunkBytes: 4 });
    const reader = new WhatsAppLineReader(source);
    const lines: Array<[string, number]> = [];
    for (let step = reader.next(); step.kind === 'line'; step = reader.next()) {
      lines.push([Buffer.from(step.line.bytes).toString('utf8'), step.line.offset]);
    }
    expect(lines).toEqual([['one', 0], ['two', 5], ['', 9], ['last without break', 10]]);
  });

  test('every line carries the checksum of the stream before it, whatever the chunk size and wherever a line straddles one', () => {
    const text = chatText(syntheticChat(20), { style: 'ios-24-dmy', crlf: true });
    for (const chunkBytes of [1, 2, 7, 33, 100, 4096]) {
      const reader = new WhatsAppLineReader(checksummedSource(text, chunkBytes));
      let count = 0;
      for (let step = reader.next(); step.kind === 'line'; step = reader.next()) {
        count += 1;
        expect(step.line.crc).toBe(crcBefore(text, step.line.offset));
      }
      expect(count).toBe(20);
    }
  });

  test('stamps for the fixture builders read the way the styles say', () => {
    expect(styleStamp('2026-05-14T21:08:07', 'ios-24-dmy')).toBe('14/05/2026, 21:08:07');
    expect(styleStamp('2026-05-14T21:08:07', 'android-12-mdy')).toBe('5/14/26, 9:08 PM');
    expect(styleStamp('2026-05-14T00:08:07', 'ios-12-mdy')).toBe(`5/14/26, 12:08:07${NARROW_NBSP}AM`);
  });
});
