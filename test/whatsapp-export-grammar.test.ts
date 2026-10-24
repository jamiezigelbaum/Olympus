// The WhatsApp export grammar and its streaming readers: header lines in the
// styles phones write, the date order read from the file, messages that span
// lines, and the same messages whatever size the chunks come in. Synthetic
// text only.

import { describe, expect, test } from 'bun:test';
import { fileByteSource } from '../src/workers/archive-import/byte-source.ts';
import {
  WhatsAppFormatError,
  WhatsAppLineReader,
  WhatsAppMessageReader,
  scanWhatsAppDateOrder,
  type WhatsAppRawMessage,
} from '../src/workers/archive-import/whatsapp/messages.ts';
import {
  isWhatsAppChatMemberName,
  isWhatsAppMediaOmitted,
  isWhatsAppZipNoise,
  looksLikeWhatsAppChat,
  matchWhatsAppHeader,
  normalizeWhatsAppLine,
  resolveWhatsAppHeader,
  splitWhatsAppSender,
  whatsAppAttachedFileName,
  whatsAppChatNameFromStem,
  whatsAppMediaMarkerCount,
  whatsAppOrderEvidence,
} from '../src/core/whatsapp-export-grammar.ts';
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

function readAll(text: string, options: { chunkBytes?: number; start?: number; startOrdinal?: number; requireHeaderFirst?: boolean; maxTextChars?: number } = {}): WhatsAppRawMessage[] {
  const source = fileByteSource(memory(text), { chunkBytes: options.chunkBytes ?? 1024 * 1024, start: options.start ?? 0 });
  const reader = new WhatsAppMessageReader(source, {
    ...(options.startOrdinal !== undefined ? { startOrdinal: options.startOrdinal } : {}),
    ...(options.requireHeaderFirst !== undefined ? { requireHeaderFirst: options.requireHeaderFirst } : {}),
    ...(options.maxTextChars !== undefined ? { maxTextChars: options.maxTextChars } : {}),
  });
  const messages: WhatsAppRawMessage[] = [];
  for (let message = reader.next(); message; message = reader.next()) messages.push(message);
  return messages;
}

describe('whatsapp header grammar', () => {
  const styles: Array<[SyntheticStyle, 'dmy' | 'mdy' | 'ymd']> = [
    ['ios-24-dmy', 'dmy'],
    ['ios-12-mdy', 'mdy'],
    ['android-24-dmy', 'dmy'],
    ['android-12-mdy', 'mdy'],
    ['android-dot-dmy', 'dmy'],
    ['iso', 'ymd'],
  ];

  test.each(styles)('%s: a message line reads back to the time it was written with', (style, order) => {
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

  test('chat names come from the export file names; zip noise and chat members are told apart', () => {
    expect(whatsAppChatNameFromStem('WhatsApp Chat with Harbour crew')).toBe('Harbour crew');
    expect(whatsAppChatNameFromStem('WhatsApp Chat - Sam Example')).toBe('Sam Example');
    expect(whatsAppChatNameFromStem('_chat')).toBeUndefined();
    expect(isWhatsAppZipNoise('__MACOSX/._chat.txt')).toBe(true);
    expect(isWhatsAppZipNoise('folder/')).toBe(true);
    expect(isWhatsAppZipNoise('_chat.txt')).toBe(false);
    expect(isWhatsAppChatMemberName('_chat.txt')).toBe(true);
    expect(isWhatsAppChatMemberName('Export/WhatsApp Chat with Sam.txt')).toBe(true);
    expect(isWhatsAppChatMemberName('__MACOSX/._WhatsApp Chat with Sam.txt')).toBe(false);
    expect(isWhatsAppChatMemberName('notes.txt')).toBe(false);
    expect(isWhatsAppChatMemberName('00000042-PHOTO.jpg')).toBe(false);
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
    expect(messages.map((message) => message.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(messages[0]!.offset).toBe(0);
    for (const message of messages) {
      expect(Buffer.from(sample, 'utf8').subarray(message.offset, message.offset + 10).toString('utf8')).toMatch(/^\d{2}\/\d{2}\/\d{4}/);
    }
  });

  test('chunk size changes nothing: the same messages, offsets and ordinals, down to one byte', () => {
    const whole = readAll(sample);
    for (const chunkBytes of [1, 2, 3, 7, 16, 64]) {
      expect(readAll(sample, { chunkBytes })).toEqual(whole);
    }
    const crlf = chatText(syntheticChat(6), { style: 'ios-24-dmy', crlf: true, bom: true });
    expect(readAll(crlf, { chunkBytes: 5 })).toEqual(readAll(crlf));
    expect(readAll(crlf)[0]!.text).toBe('The synthetic harbour log, entry 0.');
  });

  test('it resumes at a message offset with the ordinal that goes with it, and refuses a place inside a message', () => {
    const whole = readAll(sample);
    const rest = readAll(sample, { start: whole[2]!.offset, startOrdinal: 2, requireHeaderFirst: true });
    expect(rest).toEqual(whole.slice(2));
    expect(() => readAll(sample, { start: whole[2]!.offset + 5, startOrdinal: 2, requireHeaderFirst: true })).toThrow(WhatsAppFormatError);
    // A line of a multi-line message is not a place to resume at.
    const secondLine = Buffer.from(sample, 'utf8').indexOf('second line');
    expect(() => readAll(sample, { start: secondLine, startOrdinal: 3, requireHeaderFirst: true })).toThrow(WhatsAppFormatError);
  });

  test('lines before the first header are ignored; a file with no header has no message', () => {
    const messages = readAll(`${BOM}\nExported by a synthetic phone\n${sample}`);
    expect(messages).toHaveLength(5);
    expect(readAll('nothing here\nat all\n')).toEqual([]);
    expect(readAll('')).toEqual([]);
  });

  test('a message over the bound is cut and says so; the next message is not affected', () => {
    const long = 'x'.repeat(5000);
    const text = chatText([
      { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: `${long}\n${long}` },
      { at: '2026-05-14T10:01:00', sender: 'Alex Example', text: 'short' },
    ], { style: 'android-24-dmy' });
    const messages = readAll(text, { maxTextChars: 1000 });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.cut).toBe(true);
    expect(messages[0]!.text.length).toBe(1000);
    expect(messages[1]).toMatchObject({ cut: false, text: 'short', sender: 'Alex Example' });
    expect(readAll(text, { maxTextChars: 1000, chunkBytes: 13 })).toEqual(messages);
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
    expect(messages[0]!.text.length).toBeLessThanOrEqual(1024 * 1024);
    expect(messages[1]!.text).toBe('after');
  });

  test('the message in progress can be given back to the source, so a stream resumes exactly there', () => {
    const text = chatText(syntheticChat(40), { style: 'android-24-dmy' });
    const source = fileByteSource(memory(text), { chunkBytes: 1024 * 1024 });
    const reader = new WhatsAppMessageReader(source);
    const first = [reader.next()!, reader.next()!, reader.next()!];
    expect(reader.canSettle()).toBe(true);
    const pending = reader.pending!;
    expect(pending.ordinal).toBe(3);
    expect(reader.settle()).toBe(true);
    expect(source.position).toBe(pending.offset);
    const resumed = readAll(text, { start: pending.offset, startOrdinal: pending.ordinal, requireHeaderFirst: true });
    expect([...first, ...resumed]).toEqual(readAll(text));
  });

  test('a header that starts in an earlier chunk cannot be given back', () => {
    const text = chatText(syntheticChat(3), { style: 'android-24-dmy' });
    const source = fileByteSource(memory(text), { chunkBytes: 20 });
    const reader = new WhatsAppMessageReader(source);
    reader.next();
    expect(reader.canSettle()).toBe(false);
    expect(reader.settle()).toBe(false);
  });
});

describe('whatsapp date order scan', () => {
  const scan = (text: string, chunkBytes = 1024 * 1024) =>
    scanWhatsAppDateOrder(fileByteSource(memory(text), { chunkBytes }));

  test('the first header that says wins, wherever it is', () => {
    const early = chatText([{ at: '2026-05-14T10:00:00', sender: 'A', text: 'x' }], { style: 'android-24-dmy' });
    expect(scan(early)).toEqual({ order: 'dmy', assumed: false });
    const month = chatText([{ at: '2026-05-14T10:00:00', sender: 'A', text: 'x' }], { style: 'android-12-mdy' });
    expect(scan(month)).toEqual({ order: 'mdy', assumed: false });
    const late = [
      ...Array.from({ length: 30 }, (_, index) => `03/04/2026, 10:${String(index).padStart(2, '0')} - A: ambiguous ${index}\n`),
      '25/04/2026, 11:00 - A: settled\n',
    ].join('');
    expect(scan(late, 64)).toEqual({ order: 'dmy', assumed: false });
    expect(scan(chatText([{ at: '2026-05-14T10:00:00', sender: 'A', text: 'x' }], { style: 'iso' }))).toEqual({ order: 'ymd', assumed: false });
  });

  test('a file that never says is taken as day first, and says so', () => {
    const text = '03/04/2026, 10:00 - A: one\n04/05/2026, 10:00 - A: two\n';
    expect(scan(text)).toEqual({ order: 'dmy', assumed: true });
  });

  test('a file whose dates read the same either way is not an assumption', () => {
    expect(scan('05/05/2026, 10:00 - A: one\n06/06/2026, 10:00 - A: two\n')).toEqual({ order: 'dmy', assumed: false });
    expect(scan('nothing\n')).toEqual({ order: 'dmy', assumed: false });
  });

  test('a scan asked to stop says so', () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `03/04/2026, 10:00 - A: ambiguous ${index}\n`).join('');
    expect(scanWhatsAppDateOrder(fileByteSource(memory(lines)), { shouldContinue: () => false })).toBeUndefined();
  });
});

describe('whatsapp line reader', () => {
  test('lines keep their offsets across chunks and drop their line breaks', () => {
    const text = 'one\r\ntwo\n\nlast without break';
    const source = fileByteSource(memory(text), { chunkBytes: 4 });
    const reader = new WhatsAppLineReader(source);
    const lines: Array<[string, number]> = [];
    for (let line = reader.next(); line; line = reader.next()) lines.push([Buffer.from(line.bytes).toString('utf8'), line.offset]);
    expect(lines).toEqual([['one', 0], ['two', 5], ['', 9], ['last without break', 10]]);
  });

  test('stamps for the fixture builders read the way the styles say', () => {
    expect(styleStamp('2026-05-14T21:08:07', 'ios-24-dmy')).toBe('14/05/2026, 21:08:07');
    expect(styleStamp('2026-05-14T21:08:07', 'android-12-mdy')).toBe('5/14/26, 9:08 PM');
    expect(styleStamp('2026-05-14T00:08:07', 'ios-12-mdy')).toBe(`5/14/26, 12:08:07${NARROW_NBSP}AM`);
  });
});
