/**
 * The line grammar of a WhatsApp chat export (`_chat.txt`, or the text file
 * of "WhatsApp Chat with <name>"), as pure functions over one line of text.
 *
 * It belongs to the connector. Format detection (core/archive-formats.ts)
 * carries its own, smaller signature of a first line, as every format's
 * detection does, and a test holds the two in step.
 *
 * What is known about the exports, from the open-source parsers that read
 * them (not from WhatsApp's own documentation, which publishes no grammar):
 * - iOS writes `[5/1/19, 10:05:12 AM] Name: text`; Android writes
 *   `5/1/19, 10:05 - Name: text`. The date order, the separators (`/`, `.`,
 *   `-`), 12 or 24 hours and the AM/PM spelling (`AM`, `a.m.`, `a. m.`) follow
 *   the exporting phone's locale. A year is two or four digits, or comes
 *   first (`2019-01-05`).
 * - A left-to-right mark (U+200E) leads many lines, a narrow no-break space
 *   (U+202F) sits before AM/PM on newer iOS, and a file may start with a BOM.
 * - A message may span lines; only the first line has a header.
 * - A header with no `Name: ` is a notice from WhatsApp itself (encryption,
 *   joins, subject changes), in the phone's language.
 * - Media is a marker in the text: `<attached: 00000042-PHOTO-2020-06-07.jpg>`
 *   on iOS, `IMG-20200607-WA0001.jpg (file attached)` on Android, and
 *   `<Media omitted>` (or `image omitted`) when the export left media out.
 *
 * Not read: non-Latin digits (Arabic-Indic), non-Gregorian calendars, files
 * that are not UTF-8, and headers that carry a weekday or month name.
 */

export type WhatsAppDateOrder = 'dmy' | 'mdy' | 'ymd';

/** A header line, with its date parts as written (the date order is not applied yet). */
export interface WhatsAppHeaderMatch {
  /** The three numbers of the date, in the order written. */
  readonly p1: number;
  readonly p2: number;
  readonly p3: number;
  /** The first number is a four-digit year. */
  readonly yearFirst: boolean;
  /** The year as written when it is the last part: two digits become 20yy. */
  readonly lastYear: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** Everything after the header: `Name: text`, or a notice. */
  readonly rest: string;
  /**
   * How the phone wrote this header, apart from the numbers: brackets or a
   * dash, the date separator, a four-digit, two-digit or leading year, the
   * time separator, seconds, AM/PM. One file keeps one style; a header in
   * another style was not written by the same export.
   */
  readonly style: string;
}

/** A header whose date is resolved against a date order. */
export interface WhatsAppHeader extends WhatsAppHeaderMatch {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** `YYYY-MM-DDTHH:MM:SS`, the wall time as the phone wrote it (no zone). */
  readonly sentAt: string;
}

/** Bytes of a file's start examined to tell a chat export from anything else. */
export const WHATSAPP_HEAD_BYTES = 4096;

const INVISIBLE = new RegExp('[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');
const NARROW_SPACES = new RegExp('[\\u00a0\\u202f\\u2007\\u2009]', 'g');

/**
 * A line the way the grammar reads it: direction marks and the byte order mark
 * gone, no-break spaces plain.
 */
export function normalizeWhatsAppLine(line: string): string {
  return line.replace(INVISIBLE, '').replace(NARROW_SPACES, ' ');
}

const DATE = '(\\d{1,4})([./-])\\s?(\\d{1,2})[./-]\\s?(\\d{1,4})';
const TIME = '(\\d{1,2})([:.])(\\d{2})(?:[:.](\\d{2}))?(?:\\s?([ap])\\.?\\s?m\\.?)?';
const BRACKETED = new RegExp(`^\\[\\s?${DATE},?\\s+${TIME}\\s?\\]\\s?(.*)$`, 'is');
const DASHED = new RegExp(`^${DATE},?\\s+${TIME}\\s[-\\u2013]\\s(.*)$`, 'is');

/**
 * Reads a line as a message header, or undefined when it is not one. The line
 * is normalized first (`normalizeWhatsAppLine`).
 */
export function matchWhatsAppHeader(line: string): WhatsAppHeaderMatch | undefined {
  const bracketed = BRACKETED.exec(line);
  const found = bracketed ?? DASHED.exec(line);
  if (!found) return undefined;
  const [, g1, dateSep, g2, g3, hourText, timeSep, minuteText, secondText, meridiem, rest = ''] = found;
  if (g1 === undefined || g2 === undefined || g3 === undefined || hourText === undefined || minuteText === undefined) return undefined;
  if (g1.length === 3) return undefined;
  const yearFirst = g1.length === 4;
  if (yearFirst) {
    if (g3.length > 2) return undefined;
  } else if (g3.length !== 2 && g3.length !== 4) {
    return undefined;
  }
  let hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    const pm = meridiem.toLowerCase() === 'p';
    hour = hour === 12 ? (pm ? 12 : 0) : (pm ? hour + 12 : hour);
  }
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const p1 = Number(g1);
  const p2 = Number(g2);
  const p3 = Number(g3);
  const match: WhatsAppHeaderMatch = {
    p1,
    p2,
    p3,
    yearFirst,
    lastYear: g3.length === 2 ? 2000 + p3 : p3,
    hour,
    minute,
    second,
    rest,
    style: `${bracketed ? 'b' : 'd'}${dateSep}${yearFirst ? 'Y' : g3.length === 4 ? '4' : '2'}${timeSep}${secondText !== undefined ? 's' : 'n'}${meridiem !== undefined ? 'm' : 'h'}`,
  };
  // A line that names a date no calendar has (31/02) is text, not a header.
  return resolveWhatsAppHeader(match, 'dmy') || resolveWhatsAppHeader(match, 'mdy') ? match : undefined;
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function dateOf(year: number, month: number, day: number): { year: number; month: number; day: number } | undefined {
  if (year < 1990 || year > 2199 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return undefined;
  return { year, month, day };
}

/**
 * The earliest and latest wall time (as `YYYYMMDDHHMMSS` figures, to compare)
 * a header can be, over the readings of its date that exist: a header with a
 * four-digit year first has one, the others a day-first and a month-first
 * one. Undefined for a header no reading makes a date.
 */
export function whatsAppHeaderSpan(match: WhatsAppHeaderMatch): { earliest: number; latest: number } | undefined {
  const dates = match.yearFirst
    ? [dateOf(match.p1, match.p2, match.p3)]
    : [dateOf(match.lastYear, match.p2, match.p1), dateOf(match.lastYear, match.p1, match.p2)];
  const clock = match.hour * 10_000 + match.minute * 100 + match.second;
  const times = dates.flatMap((date) => (date ? [(date.year * 10_000 + date.month * 100 + date.day) * 1_000_000 + clock] : []));
  return times.length > 0 ? { earliest: Math.min(...times), latest: Math.max(...times) } : undefined;
}

/**
 * What the date of one header says about the file's date order, when it is
 * certain: a first part above 12 can only be a day, a second part above 12
 * only a day, a first part of four digits a year. Undefined when both
 * readings are possible.
 */
export function whatsAppOrderEvidence(match: WhatsAppHeaderMatch): WhatsAppDateOrder | undefined {
  if (match.yearFirst) return 'ymd';
  if (match.p1 > 12 && match.p2 <= 12) return 'dmy';
  if (match.p2 > 12 && match.p1 <= 12) return 'mdy';
  return undefined;
}

/**
 * The header with its date read in `order`. A date impossible in that order
 * (a month of 14) is read in the other one, so a file that mixes the two
 * still reads; a date impossible in both is no header.
 */
export function resolveWhatsAppHeader(match: WhatsAppHeaderMatch, order: WhatsAppDateOrder): WhatsAppHeader | undefined {
  let date: { year: number; month: number; day: number } | undefined;
  if (match.yearFirst) {
    date = dateOf(match.p1, match.p2, match.p3);
  } else {
    const dayFirst = dateOf(match.lastYear, match.p2, match.p1);
    const monthFirst = dateOf(match.lastYear, match.p1, match.p2);
    date = order === 'mdy' ? (monthFirst ?? dayFirst) : (dayFirst ?? monthFirst);
  }
  if (!date) return undefined;
  return {
    ...match,
    ...date,
    sentAt: `${String(date.year).padStart(4, '0')}-${two(date.month)}-${two(date.day)}T${two(match.hour)}:${two(match.minute)}:${two(match.second)}`,
  };
}

/** A longest sender name; a longer stretch before `: ` is a sentence, so the line is a notice. */
export const WHATSAPP_MAX_SENDER_CHARS = 128;

/**
 * The sender and text of what follows a header. A notice from WhatsApp itself
 * has no sender.
 */
export function splitWhatsAppSender(rest: string): { sender?: string; text: string } {
  for (let at = rest.indexOf(':'); at >= 0; at = rest.indexOf(':', at + 1)) {
    if (at > WHATSAPP_MAX_SENDER_CHARS) break;
    if (at + 1 < rest.length && rest[at + 1] !== ' ') continue;
    const sender = rest.slice(0, at).trim();
    if (!sender) break;
    return { sender, text: rest.slice(at + 1).trim() };
  }
  return { text: rest.trim() };
}

/**
 * The file a media marker line names, when the line is exactly one:
 * `<attached: 00000042-PHOTO-2020-06-07.jpg>` (iOS, in any language) or
 * `IMG-20200607-WA0001.jpg (file attached)` (Android, WhatsApp's own names).
 * `<Media omitted>` and `image omitted` name nothing.
 */
export function whatsAppAttachedFileName(line: string): string | undefined {
  const text = normalizeWhatsAppLine(line).trim();
  const angle = /^<[^<>:\uff1a\n]{1,40}[:\uff1a]\s*([^<>\n]+\.\w{1,8})>$/.exec(text);
  if (angle?.[1]) return angle[1].trim();
  const paren = /^((?:IMG|VID|PTT|AUD|DOC|STK|PHOTO|VIDEO|AUDIO|GIF|DOCUMENT|STICKER)-[\w-]+\.\w{1,8}) \([^()\n]{3,40}\)$/.exec(text);
  return paren?.[1];
}

/**
 * Whether a whole message is only the note that media was left out of the
 * export: `<Media omitted>` (Android), `image omitted` (iOS), or the same
 * in another language as one bracketed phrase.
 */
export function isWhatsAppMediaOmitted(text: string): boolean {
  const line = normalizeWhatsAppLine(text).trim();
  if (line.length < 4 || line.length > 48 || line.includes('\n')) return false;
  if (/^<[^<>:\uff1a]{3,40}>$/.test(line)) return !/\b(?:edited|deleted)\b/i.test(line);
  return /^[A-Za-z][A-Za-z ]{1,24} omitted$/.test(line);
}

/**
 * How many media files a message names or leaves out: one for each line that
 * is an attachment marker, and one for a message that is only an "omitted" note.
 */
export function whatsAppMediaMarkerCount(text: string): number {
  if (isWhatsAppMediaOmitted(text)) return 1;
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.length <= 400 && whatsAppAttachedFileName(line) !== undefined) count += 1;
  }
  return count;
}

/**
 * Whether a file or zip member is named the way WhatsApp names the text of a
 * chat export: `_chat.txt` (iOS) or `WhatsApp Chat with <name>.txt` (Android;
 * `WhatsApp Chat - <name>.txt` is the same in another phrasing). This is the
 * evidence that lets a folder's file be taken without being chosen by name.
 * A phone set to another language names the Android file in that language;
 * such a file is imported when chosen itself, not found in a folder.
 */
export function hasWhatsAppExportName(name: string): boolean {
  if (isWhatsAppZipNoise(name)) return false;
  const last = (name.split('/').pop() ?? name).toLowerCase();
  return last === '_chat.txt' || /^whatsapp chat (?:with|-)\s+\S.*\.txt$/.test(last);
}

const EXPORT_FILENAME = /^WhatsApp Chat (?:with|-)\s*(.+)$/i;

/** The chat a `WhatsApp Chat with <name>` or `WhatsApp Chat - <name>` file name is of, without its extension. */
export function whatsAppChatNameFromStem(stem: string): string | undefined {
  const chat = EXPORT_FILENAME.exec(stem.trim())?.[1]?.trim();
  return chat ? chat : undefined;
}

/** A member or file name without its folders and its `.txt` or `.zip`. */
export function whatsAppStem(name: string): string {
  const parts = name.split('/').filter((part) => part !== '');
  const last = parts[parts.length - 1] ?? name;
  return last.replace(/\.(?:txt|zip)$/i, '');
}

/** Names inside a zip that are not files of the export: macOS folders and resource forks. */
export function isWhatsAppZipNoise(name: string): boolean {
  if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')) return true;
  const base = name.split('/').pop() ?? name;
  return base.startsWith('._') || base === '.DS_Store';
}

const lenientUtf8 = new TextDecoder('utf-8');

/**
 * Whether the first bytes of a file are a chat export: UTF-8 text whose first
 * non-blank line is a message header.
 */
export function looksLikeWhatsAppChat(head: Uint8Array | undefined): boolean {
  if (!head || head.length < 10) return false;
  // A NUL is UTF-16 or binary: not text this grammar reads.
  if (head.includes(0)) return false;
  const text = lenientUtf8.decode(head);
  for (const raw of text.split('\n').slice(0, 8)) {
    const line = normalizeWhatsAppLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (line.trim() === '') continue;
    return matchWhatsAppHeader(line) !== undefined;
  }
  return false;
}

/** Whether a file's first bytes start like a zip. */
export function looksLikeZipHead(head: Uint8Array | undefined): boolean {
  return head !== undefined && head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b
    && ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06));
}

/** Bytes at the start of a line that are enough to tell whether it is a message header. */
export const WHATSAPP_HEADER_PREFIX_BYTES = 160;

const prefixDecoder = new TextDecoder('utf-8');

/**
 * Whether a line starts a message, judged from its first bytes alone, so a
 * line of megabytes costs no more to classify than a short one.
 */
export function startsWithWhatsAppHeader(lineStart: Uint8Array): boolean {
  const prefix = lineStart.length > WHATSAPP_HEADER_PREFIX_BYTES ? lineStart.subarray(0, WHATSAPP_HEADER_PREFIX_BYTES) : lineStart;
  return matchWhatsAppHeader(normalizeWhatsAppLine(prefixDecoder.decode(prefix))) !== undefined;
}
