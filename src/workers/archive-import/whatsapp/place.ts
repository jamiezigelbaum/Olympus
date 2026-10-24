/**
 * Where a WhatsApp import stands, as the resume point it hands the store
 * (the cursor of a page), and the small amount of memory that makes message
 * identities stable across pages.
 *
 * - Place: a position in the archive (file, zip member, byte offset) and how
 *   to enter the stream there: at its start (the date order is not known
 *   yet), at the header line of a message, or inside the lines being dropped
 *   after a message that was cut. With it go the things a reader needs to
 *   carry on exactly as if it had never stopped: the date order, the style
 *   the file's headers are written in, the time of the header before, the
 *   identical messages already seen at one time, and, for a stored zip
 *   member, the CRC-32 of everything before the offset.
 * - Cursor: `wa1:<manifest>:<json>` or `wa1:<manifest>:done`. The manifest tag
 *   binds it to these files at these versions; every field is checked on the
 *   way in, because the cursor is read back from the store.
 * - Identity window: two messages alike in chat, sender, text and time are
 *   told apart by their number among the alike, counted within one time (a
 *   minute on Android, a second on iOS). That count needs only the messages
 *   of the time being read, so it is a short list that travels in the cursor.
 */
import {
  ArchiveImportStoppedError,
  type ArchiveConnectorInput,
} from '../../../core/archive-formats.ts';

export const WHATSAPP_CURSOR_PREFIX = 'wa1:';
/** Distinct messages kept in the window for one time; a time with more is told apart by position instead. */
export const WHATSAPP_WINDOW_MAX_KEYS = 24;

/** `d`, `m`, `y`: the order the file's headers show; `a`: day first, assumed; `?`: not read yet. */
export type OrderMark = 'd' | 'm' | 'y' | 'a' | '?';
export const ORDER_MARKS: readonly string[] = ['d', 'm', 'y', 'a', '?'];

export type PlaceMode =
  /** The start of the stream: lines before the first header are dropped. */
  | 'start'
  /** The header line of a message. */
  | 'message'
  /** At a line start, dropping lines until the next header. */
  | 'skip'
  /** Inside a line, dropping the rest of it and then lines until the next header. */
  | 'mid';
const PLACE_MODES: readonly string[] = ['start', 'message', 'skip', 'mid'];

export interface WindowState {
  /** The time (`YYYY-MM-DDTHH:MM:SS`) the keys were sent at. */
  sentAt: string;
  /** Each distinct message of that time (a short digest of sender and text) and how many of it were seen. */
  keys: Array<[string, number]>;
}

export interface Place {
  fileIndex: number;
  /** The member's place in the zip's directory; 0 for a plain file. */
  memberIndex: number;
  /** Where to start reading in the member. */
  offset: number;
  mode: PlaceMode;
  order: OrderMark;
  /** How the file's first header was written ('' while the start has not been read). */
  style: string;
  /** The time of the header before this place ('' for none). */
  prev: string;
  window?: WindowState;
  /** The stored member's CRC-32 before `offset`. */
  crc?: number;
}

export type ParsedCursor = { done: true } | { done: false; place: Place };

const SENT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const STYLE = /^[\x21-\x7e]{0,16}$/;
const WINDOW_KEY = /^[0-9a-f]{12}$/;

export function manifestTag(input: ArchiveConnectorInput): string {
  return input.manifestSha256.slice(0, 16);
}

export function cursorOf(input: ArchiveConnectorInput, place: Place): string {
  const json = {
    f: place.fileIndex,
    m: place.memberIndex,
    o: place.offset,
    k: place.mode,
    d: place.order,
    ...(place.style ? { s: place.style } : {}),
    ...(place.prev ? { p: place.prev } : {}),
    ...(place.window && place.window.keys.length > 0 ? { w: [place.window.sentAt, place.window.keys] } : {}),
    ...(place.crc !== undefined ? { c: place.crc >>> 0 } : {}),
  };
  return `${WHATSAPP_CURSOR_PREFIX}${manifestTag(input)}:${JSON.stringify(json)}`;
}

export function doneCursor(input: ArchiveConnectorInput): string {
  return `${WHATSAPP_CURSOR_PREFIX}${manifestTag(input)}:done`;
}

function isWhole(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads a resume point back. A cursor made for other files, or that is not a
 * place in these files, stops the import (`resume_point_invalid`) instead of
 * being read as something else.
 */
export function parseCursor(input: ArchiveConnectorInput, cursor: string | undefined): ParsedCursor | undefined {
  if (!cursor) return undefined;
  const invalid = (message = 'The resume point is not a position in this archive.'): ArchiveImportStoppedError =>
    new ArchiveImportStoppedError('resume_point_invalid', message);
  const prefix = `${WHATSAPP_CURSOR_PREFIX}${manifestTag(input)}:`;
  if (!cursor.startsWith(prefix)) throw invalid('The resume point belongs to other files than this archive\'s.');
  const rest = cursor.slice(prefix.length);
  if (rest === 'done') return { done: true };
  let json: unknown;
  try {
    json = JSON.parse(rest);
  } catch {
    throw invalid();
  }
  if (!isRecord(json)) throw invalid();
  const { f, m, o, k, d, s, p, w, c } = json;
  if (!isWhole(f, 0xffffffff) || !isWhole(m, 0xffffffff) || !isWhole(o) || typeof k !== 'string' || !PLACE_MODES.includes(k)
    || typeof d !== 'string' || !ORDER_MARKS.includes(d)) throw invalid();
  const file = input.files[f];
  if (!file) throw invalid();
  if (!file.members && (m !== 0 || o > file.version.size)) throw invalid();
  const mode = k as PlaceMode;
  if ((mode === 'start') !== (d === '?') || (mode === 'start' && o !== 0)) throw invalid();
  if (s !== undefined && (typeof s !== 'string' || !STYLE.test(s))) throw invalid();
  if (p !== undefined && (typeof p !== 'string' || !SENT_AT.test(p))) throw invalid();
  if (mode === 'start' && (s !== undefined || p !== undefined || w !== undefined)) throw invalid();
  let window: WindowState | undefined;
  if (w !== undefined) {
    if (!Array.isArray(w) || w.length !== 2 || typeof w[0] !== 'string' || !SENT_AT.test(w[0]) || !Array.isArray(w[1])
      || w[1].length === 0 || w[1].length > WHATSAPP_WINDOW_MAX_KEYS) throw invalid();
    const keys: Array<[string, number]> = [];
    for (const entry of w[1] as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !WINDOW_KEY.test(entry[0])
        || !isWhole(entry[1], 0xffffffff) || entry[1] < 1) throw invalid();
      keys.push([entry[0], entry[1]]);
    }
    window = { sentAt: w[0], keys };
  }
  if (c !== undefined && (!isWhole(c, 0xffffffff) || !file.members)) throw invalid();
  return {
    done: false,
    place: {
      fileIndex: f,
      memberIndex: m,
      offset: o,
      mode,
      order: d as OrderMark,
      style: typeof s === 'string' ? s : '',
      prev: typeof p === 'string' ? p : '',
      ...(window ? { window } : {}),
      ...(typeof c === 'number' ? { crc: c } : {}),
    },
  };
}

/**
 * The messages of the time being read, so that alike ones are numbered 0, 1,
 * 2 in the order they come. The list is short because messages come in
 * time order: a time with more distinct messages than the window keeps
 * (`undefined` ordinal) is told apart by position, which is stable too.
 */
export class IdentityWindow {
  private sentAt = '';
  private readonly keys = new Map<string, number>();

  static restore(state: WindowState | undefined): IdentityWindow {
    const window = new IdentityWindow();
    if (state) {
      window.sentAt = state.sentAt;
      for (const [key, count] of state.keys) window.keys.set(key, count);
    }
    return window;
  }

  /** The number of this message among the alike at its time, or undefined when it cannot be kept. */
  ordinal(sentAt: string, key: string): number | undefined {
    if (sentAt !== this.sentAt) {
      this.sentAt = sentAt;
      this.keys.clear();
    }
    const seen = this.keys.get(key);
    if (seen === undefined) {
      if (this.keys.size >= WHATSAPP_WINDOW_MAX_KEYS) return undefined;
      this.keys.set(key, 1);
      return 0;
    }
    this.keys.set(key, seen + 1);
    return seen;
  }

  state(): WindowState | undefined {
    return this.keys.size > 0 ? { sentAt: this.sentAt, keys: [...this.keys.entries()] } : undefined;
  }
}
