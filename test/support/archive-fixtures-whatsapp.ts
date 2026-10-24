/**
 * Synthetic WhatsApp chat exports, built in code: the text file of "Export
 * Chat" in the line styles real phones write, and the zip WhatsApp shares.
 * Nothing here is read from a real export; every name, time and sentence is
 * made up. Reusable by any test or release check that needs a chat export.
 *
 * Styles (what the open-source parsers of real exports show; see
 * workers/archive-import/whatsapp/grammar.ts for what each phone writes):
 * - `ios-24-dmy`     `[14/05/2026, 21:08:00] Name: text`
 * - `ios-12-mdy`     `[5/14/26, 9:08:00 PM] Name: text` (narrow no-break space before PM)
 * - `android-24-dmy` `14/05/2026, 21:08 - Name: text`
 * - `android-12-mdy` `5/14/26, 9:08 PM - Name: text`
 * - `android-dot-dmy` `14.05.26, 21:08 - Name: text`
 * - `iso`            `2026-05-14, 21:08 - Name: text`
 */
import { buildZip, type ZipFixtureEntry } from '../helpers/zip-fixture.ts';

/** Left-to-right mark, which iOS puts before many lines. */
export const LRM = String.fromCharCode(0x200e);
/** Narrow no-break space, which newer iOS puts before AM and PM. */
export const NARROW_NBSP = String.fromCharCode(0x202f);
export const BOM = String.fromCharCode(0xfeff);

export type SyntheticStyle = 'ios-24-dmy' | 'ios-12-mdy' | 'android-24-dmy' | 'android-12-mdy' | 'android-dot-dmy' | 'iso';

export interface SyntheticMessage {
  /** Local wall time, `YYYY-MM-DDTHH:MM:SS`. */
  at: string;
  /** Absent for a notice from WhatsApp itself. */
  sender?: string;
  text: string;
}

const pad = (value: number): string => String(value).padStart(2, '0');

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsOf(at: string): Parts {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(at);
  if (!match) throw new Error(`not a wall time: ${at}`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  return { year, month, day, hour, minute, second };
}

function twelveHour(parts: Parts): { hour: number; meridiem: 'AM' | 'PM' } {
  return { hour: parts.hour % 12 === 0 ? 12 : parts.hour % 12, meridiem: parts.hour >= 12 ? 'PM' : 'AM' };
}

/** The date and time as the style writes them, without the brackets or the dash that follow. */
export function styleStamp(at: string, style: SyntheticStyle): string {
  const p = partsOf(at);
  switch (style) {
    case 'ios-24-dmy':
      return `${pad(p.day)}/${pad(p.month)}/${p.year}, ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
    case 'ios-12-mdy': {
      const t = twelveHour(p);
      return `${p.month}/${p.day}/${pad(p.year % 100)}, ${t.hour}:${pad(p.minute)}:${pad(p.second)}${NARROW_NBSP}${t.meridiem}`;
    }
    case 'android-24-dmy':
      return `${pad(p.day)}/${pad(p.month)}/${p.year}, ${pad(p.hour)}:${pad(p.minute)}`;
    case 'android-12-mdy': {
      const t = twelveHour(p);
      return `${p.month}/${p.day}/${pad(p.year % 100)}, ${t.hour}:${pad(p.minute)} ${t.meridiem}`;
    }
    case 'android-dot-dmy':
      return `${pad(p.day)}.${pad(p.month)}.${pad(p.year % 100)}, ${pad(p.hour)}:${pad(p.minute)}`;
    case 'iso':
      return `${p.year}-${pad(p.month)}-${pad(p.day)}, ${pad(p.hour)}:${pad(p.minute)}`;
  }
}

export interface ChatTextOptions {
  style: SyntheticStyle;
  /** Lines end with CR LF. */
  crlf?: boolean;
  /** The file starts with a byte order mark. */
  bom?: boolean;
  /** iOS puts a left-to-right mark before each message line (default: true for iOS styles). */
  lrm?: boolean;
  /** The file ends without a line break. */
  noFinalNewline?: boolean;
}

/** One message as the export writes it (its text may span lines). */
export function messageLine(message: SyntheticMessage, options: ChatTextOptions): string {
  const ios = options.style.startsWith('ios');
  const lrm = options.lrm ?? ios;
  const stamp = styleStamp(message.at, options.style);
  const body = message.sender === undefined ? message.text : `${message.sender}: ${message.text}`;
  return ios ? `${lrm ? LRM : ''}[${stamp}] ${body}` : `${stamp} - ${body}`;
}

export function chatText(messages: readonly SyntheticMessage[], options: ChatTextOptions): string {
  const eol = options.crlf ? '\r\n' : '\n';
  const text = messages.map((message) => messageLine(message, options)).join(eol);
  return `${options.bom ? BOM : ''}${text}${options.noFinalNewline ? '' : eol}`;
}

/** A chat of `count` messages, one every few minutes from `start`, between two made-up people. */
export function syntheticChat(count: number, options: { start?: string; senders?: readonly string[]; label?: string } = {}): SyntheticMessage[] {
  const start = partsOf(options.start ?? '2026-02-14T09:00:00');
  const senders = options.senders ?? ['Sam Example', 'Alex Example'];
  const label = options.label ?? 'harbour';
  const base = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute, start.second);
  return Array.from({ length: count }, (_, index) => {
    const when = new Date(base + index * 7 * 60 * 1000 + (index % 3) * 1000);
    const at = `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}T${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}`;
    return { at, sender: senders[index % senders.length]!, text: `The synthetic ${label} log, entry ${index}.` };
  });
}

/** A notice from WhatsApp itself, as a header with no sender. */
export function notice(at: string, text = 'Messages and calls are end-to-end encrypted.'): SyntheticMessage {
  return { at, text };
}

export interface ChatZipOptions {
  /** The chat's text file inside the zip (default `_chat.txt`). */
  textName?: string;
  /** Method for the text file (default deflate). */
  method?: 'stored' | 'deflate';
  /** Media members to put beside the text, by name; their bytes are made up. */
  media?: readonly string[];
  /** Macintosh noise a zip made by Finder carries. */
  macNoise?: boolean;
  /** More members to add, as they are. */
  extra?: readonly ZipFixtureEntry[];
}

/** The zip WhatsApp shares: the chat's text file, and the chat's media beside it. */
export function chatZip(text: string | Uint8Array, options: ChatZipOptions = {}): Uint8Array {
  const textName = options.textName ?? '_chat.txt';
  const entries: ZipFixtureEntry[] = [
    ...(options.macNoise ? [{ name: '__MACOSX/', method: 'stored' as const }, { name: `__MACOSX/._${textName}`, data: 'noise', method: 'stored' as const }] : []),
    { name: textName, data: text, method: options.method ?? 'deflate' },
    ...(options.media ?? []).map((name) => ({ name, data: `synthetic media ${name}`, method: 'stored' as const })),
    ...(options.extra ?? []),
  ];
  return buildZip(entries);
}

/** Names of made-up media files, the way a phone names them. */
export function mediaNames(count: number, style: 'ios' | 'android' = 'ios'): string[] {
  return Array.from({ length: count }, (_, index) => style === 'ios'
    ? `${String(index + 1).padStart(8, '0')}-PHOTO-2026-02-14-09-00-${pad(index % 60)}.jpg`
    : `IMG-20260214-WA${String(index + 1).padStart(4, '0')}.jpg`);
}
