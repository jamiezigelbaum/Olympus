/**
 * Streaming readers for a WhatsApp chat export: lines out of any byte source
 * (a file range or a zip member), and messages out of lines.
 *
 * Nothing here holds more than a bounded amount of a file, and a reader can
 * stop at a byte read and say exactly where to start again:
 *
 * - Lines: split at LF, a trailing CR dropped. A line longer than
 *   LINE_BYTES_KEPT is handed out cut, and the rest of it is dropped without
 *   being kept, so a file with no line breaks at all is read in bounded memory.
 *   Every line carries the CRC-32 of the stream before it, when the source
 *   keeps one, so a stored zip member can be entered at any line start with
 *   its checksum still running.
 * - Messages: a header line starts one, every line up to the next header
 *   continues it. A message is read for at most MAX_MESSAGE_BYTES and keeps
 *   at most MAX_ITEM_TEXT_CHARS of text; past either it is cut: handed out at
 *   once, with the cut said, and the reader drops lines until the next
 *   header. Only dropped bytes are read in that state, which is where the
 *   reader may be asked to stop (`mayRead`): the resume point then names the
 *   byte and whether it lies inside a line.
 * - Where a pass may stop: at the start of the next message (its header line
 *   is already read), or while dropping the rest of a cut message. `settle`
 *   gives the unread part of the last chunk back to the source, so a zip
 *   member's inflater can be parked exactly at the resume point.
 */
import { crc32Update, type ArchiveByteSource } from '../byte-source.ts';
import {
  WHATSAPP_HEADER_PREFIX_BYTES,
  matchWhatsAppHeader,
  normalizeWhatsAppLine,
  splitWhatsAppSender,
  startsWithWhatsAppHeader,
  whatsAppOrderEvidence,
  type WhatsAppDateOrder,
  type WhatsAppHeaderMatch,
} from './grammar.ts';

/** Text kept per message (characters); longer messages are cut and counted as a gap. */
export const WHATSAPP_MAX_ITEM_TEXT_CHARS = 1_048_576;
/** Bytes of one line kept while it is read. */
export const WHATSAPP_LINE_BYTES_KEPT = 4 * 1024 * 1024;
/** Bytes one message is read for before it is cut, whatever text it kept. */
export const WHATSAPP_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Content read looking for the file's date order before it is taken as day first. */
export const WHATSAPP_ORDER_SCAN_MAX_BYTES = 16 * 1024 * 1024;
/** Headers that say which part of a date is the day: once this many are counted the order is settled. */
export const WHATSAPP_ORDER_VOTES_ENOUGH = 25;

const utf8 = new TextDecoder('utf-8');

export interface WhatsAppLine {
  /** The line without its line break (a CR before it is dropped too). */
  bytes: Uint8Array;
  /** Where the line starts in the source's stream. */
  offset: number;
  /** The CRC-32 of the stream before `offset`, when the source keeps one. */
  crc?: number;
  /** The line was longer than LINE_BYTES_KEPT: `bytes` is only its start, and the rest is being dropped. */
  cut: boolean;
}

export type WhatsAppLineStep =
  | { kind: 'line'; line: WhatsAppLine }
  | { kind: 'paused' }
  | { kind: 'end' };

interface LineInProgress {
  start: number;
  crc: number | undefined;
  parts: Uint8Array[];
  bytes: number;
  cut: boolean;
  /** `undecided`: not enough of it yet to tell a header; `drop`: its bytes are read and not kept. */
  mode: 'undecided' | 'keep' | 'drop';
}

export interface WhatsAppLineOptions {
  /** Hand out only lines that start a message; every other line is dropped unkept. */
  headersOnly?: boolean;
  /**
   * Asked before each read of the source that only dropped bytes can follow
   * (between lines, inside a line being dropped, or while a line's first
   * bytes are being judged). False stops the read: the step is `paused`, and
   * `readPoint` says where to start again (the start of a line whose first
   * bytes were still being judged is read again).
   */
  mayRead?: () => boolean;
}

/** Where a reader that stopped starts again. */
export interface WhatsAppReadPoint {
  /** The next unread byte of the stream. */
  offset: number;
  /** The byte lies inside a line (the rest of it is dropped first). */
  midLine: boolean;
  /** The CRC-32 of the stream before `offset`, when the source keeps one. */
  crc?: number;
}

export class WhatsAppLineReader {
  private chunk: Uint8Array | undefined;
  private chunkStart = 0;
  private at = 0;
  /** The CRC-32 of the stream before `chunk[foldedTo]`. */
  private crcRun: number | undefined;
  private foldedTo = 0;
  private line: LineInProgress | undefined;
  private ended = false;

  /** With `midLine`, the source's first byte lies inside a line, which is dropped. */
  constructor(private readonly source: ArchiveByteSource, options: { midLine?: boolean } = {}) {
    if (options.midLine) {
      this.line = { start: source.position, crc: undefined, parts: [], bytes: 0, cut: true, mode: 'drop' };
    }
  }

  get atEnd(): boolean {
    return this.ended;
  }

  /** The stream offsets of the chunk read last, or undefined before the first or after the end. */
  get lastChunk(): { start: number; end: number } | undefined {
    return this.chunk && !this.ended ? { start: this.chunkStart, end: this.chunkStart + this.chunk.length } : undefined;
  }

  /**
   * Where the next line to read starts, or the next byte to drop when a line
   * is being dropped; undefined after the stream ended. A line being kept
   * (a header still arriving) is read again from its start.
   */
  readPoint(): WhatsAppReadPoint | undefined {
    if (this.ended) return undefined;
    const line = this.line;
    if (line && line.mode !== 'drop') {
      return { offset: line.start, midLine: false, ...(line.crc !== undefined ? { crc: line.crc } : {}) };
    }
    const midLine = line !== undefined;
    if (!this.chunk) {
      const crc = this.source.crc32;
      return { offset: this.source.position, midLine, ...(crc !== undefined ? { crc } : {}) };
    }
    const crc = this.crcAt(this.at);
    return { offset: this.chunkStart + this.at, midLine, ...(crc !== undefined ? { crc } : {}) };
  }

  /**
   * Gives everything from `offset` on back to the source, so its position is
   * `offset`. Only when `offset` lies in the chunk read last; the reader is
   * finished after it.
   */
  giveBackFrom(offset: number): boolean {
    const chunk = this.chunk;
    if (!chunk || this.ended || offset < this.chunkStart || offset > this.chunkStart + chunk.length) return false;
    this.source.unread(this.chunkStart + chunk.length - offset);
    this.ended = true;
    return true;
  }

  next(options: WhatsAppLineOptions = {}): WhatsAppLineStep {
    const headersOnly = options.headersOnly === true;
    for (;;) {
      if (this.ended) return { kind: 'end' };
      if (!this.chunk || this.at >= this.chunk.length) {
        // Between lines, inside a line being dropped, or while the start of a line is being judged
        // (at most the header prefix is kept for that), only dropped bytes follow a read.
        const dropping = this.line === undefined || this.line.mode !== 'keep';
        if (dropping && options.mayRead && !options.mayRead()) return { kind: 'paused' };
        const crcBefore = this.source.crc32;
        const chunk = this.source.next();
        if (!chunk) {
          this.ended = true;
          return this.endOfStream();
        }
        this.chunk = chunk;
        this.chunkStart = this.source.position - chunk.length;
        this.crcRun = crcBefore;
        this.foldedTo = 0;
        this.at = 0;
        continue;
      }
      const chunk = this.chunk;
      if (!this.line) {
        this.line = {
          start: this.chunkStart + this.at,
          crc: this.crcAt(this.at),
          parts: [],
          bytes: 0,
          cut: false,
          mode: headersOnly ? 'undecided' : 'keep',
        };
      }
      const line = this.line;
      const newline = chunk.indexOf(0x0a, this.at);
      const segmentEnd = newline < 0 ? chunk.length : newline;
      const whole = chunk.subarray(this.at, segmentEnd);
      let segment = whole;
      // A view of the chunk is only safe while the line ends in it.
      const copy = newline < 0;
      if (line.mode === 'undecided') {
        const head = segment.subarray(0, Math.max(0, WHATSAPP_HEADER_PREFIX_BYTES - line.bytes));
        this.keep(line, head, true);
        segment = segment.subarray(head.length);
        if (line.bytes >= WHATSAPP_HEADER_PREFIX_BYTES || newline >= 0) this.decide(line);
      }
      if (line.mode === 'keep' && segment.length > 0) {
        const room = WHATSAPP_LINE_BYTES_KEPT - line.bytes;
        if (segment.length > room) {
          // A line over the bound goes out cut now; the rest of it is dropped as it is read.
          this.keep(line, segment.subarray(0, room), true);
          line.cut = true;
          line.mode = 'drop';
          this.at += whole.length - segment.length + room;
          return { kind: 'line', line: this.take(line) };
        }
        this.keep(line, segment, copy);
      }
      if (newline < 0) {
        this.at = chunk.length;
        continue;
      }
      this.at = newline + 1;
      this.line = undefined;
      if (line.mode === 'keep') return { kind: 'line', line: this.take(line) };
    }
  }

  private decide(line: LineInProgress): void {
    if (startsWithWhatsAppHeader(this.join(line))) {
      line.mode = 'keep';
    } else {
      line.mode = 'drop';
      line.parts = [];
      line.bytes = 0;
    }
  }

  private endOfStream(): WhatsAppLineStep {
    const line = this.line;
    this.line = undefined;
    if (!line) return { kind: 'end' };
    if (line.mode === 'undecided') this.decide(line);
    // An unterminated last line is a line.
    return line.mode === 'keep' ? { kind: 'line', line: this.take(line) } : { kind: 'end' };
  }

  private keep(line: LineInProgress, bytes: Uint8Array, copy: boolean): void {
    if (bytes.length === 0) return;
    line.parts.push(copy ? bytes.slice() : bytes);
    line.bytes += bytes.length;
  }

  private join(line: LineInProgress): Uint8Array {
    if (line.parts.length === 1) return line.parts[0]!;
    const bytes = new Uint8Array(line.bytes);
    let at = 0;
    for (const part of line.parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return bytes;
  }

  private take(line: LineInProgress): WhatsAppLine {
    let bytes = this.join(line);
    line.parts = [];
    if (!line.cut && bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, bytes.length - 1);
    return { bytes, offset: line.start, ...(line.crc !== undefined ? { crc: line.crc } : {}), cut: line.cut };
  }

  /** The CRC-32 of the stream before the byte at `index` of the chunk read last. */
  private crcAt(index: number): number | undefined {
    const chunk = this.chunk;
    if (!chunk || this.crcRun === undefined) return undefined;
    if (index > this.foldedTo) {
      this.crcRun = crc32Update(this.crcRun, chunk.subarray(this.foldedTo, index));
      this.foldedTo = index;
    }
    return index === this.foldedTo ? this.crcRun : undefined;
  }
}

/** The text of a line as the grammar reads it (direction marks gone, no-break spaces plain). */
export function whatsAppLineText(line: WhatsAppLine): string {
  return normalizeWhatsAppLine(utf8.decode(line.bytes));
}

export class WhatsAppFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppFormatError';
  }
}

/** One message as the file wrote it: the date parts are not resolved yet. */
export interface WhatsAppRawMessage {
  /** Where its header line starts. */
  offset: number;
  header: WhatsAppHeaderMatch;
  /** Absent for a notice from WhatsApp itself. */
  sender?: string;
  /** The text after the header, lines joined, trailing space dropped. */
  text: string;
  /** Some of the text was cut: the message was longer than the bounds. */
  cut: boolean;
}

interface Building {
  offset: number;
  crc: number | undefined;
  header: WhatsAppHeaderMatch;
  sender: string | undefined;
  parts: string[];
  chars: number;
  bytes: number;
  cut: boolean;
}

/** Where the next read starts, as a message reader would be entered there. */
export type WhatsAppResumePoint =
  | { kind: 'message'; offset: number; crc?: number }
  | { kind: 'skip'; offset: number; midLine: boolean; crc?: number };

export type WhatsAppMessageStep =
  | { kind: 'message'; message: WhatsAppRawMessage }
  | { kind: 'paused' }
  | { kind: 'end' };

export type WhatsAppEntry =
  /** At the start of the stream: lines before the first header are dropped. */
  | { kind: 'start' }
  /** At a header line: the first line must be one. */
  | { kind: 'message' }
  /** Dropping lines until the next header; `midLine`: the first byte is inside a line. */
  | { kind: 'skip'; midLine: boolean };

export class WhatsAppMessageReader {
  private readonly lines: WhatsAppLineReader;
  private readonly maxTextChars: number;
  private readonly maxMessageBytes: number;
  private building: Building | undefined;
  /** Lines are dropped until a header: before the first message, and after a message was cut. */
  private dropping: boolean;
  private expectHeader: boolean;
  private finished = false;

  constructor(
    private readonly source: ArchiveByteSource,
    entry: WhatsAppEntry = { kind: 'start' },
    options: { maxTextChars?: number; maxMessageBytes?: number } = {},
  ) {
    this.lines = new WhatsAppLineReader(source, { midLine: entry.kind === 'skip' && entry.midLine });
    this.dropping = entry.kind !== 'message';
    this.expectHeader = entry.kind === 'message';
    this.maxTextChars = options.maxTextChars ?? WHATSAPP_MAX_ITEM_TEXT_CHARS;
    this.maxMessageBytes = options.maxMessageBytes ?? WHATSAPP_MAX_MESSAGE_BYTES;
  }

  /** The stream offset the reader has consumed up to. */
  get position(): number {
    return this.source.position;
  }

  /**
   * Where reading starts again if it stopped now: at the header line of the
   * message being read, else inside the lines being dropped. Undefined once
   * the stream has ended.
   */
  resume(): WhatsAppResumePoint | undefined {
    if (this.finished) return undefined;
    const building = this.building;
    if (building) {
      return { kind: 'message', offset: building.offset, ...(building.crc !== undefined ? { crc: building.crc } : {}) };
    }
    const at = this.lines.readPoint();
    return at ? { kind: 'skip', offset: at.offset, midLine: at.midLine, ...(at.crc !== undefined ? { crc: at.crc } : {}) } : undefined;
  }

  /** The resume point lies in the chunk read last, so the source can be given the rest back (`settle`). */
  canSettle(): boolean {
    const chunk = this.lines.lastChunk;
    const at = this.resume();
    return chunk !== undefined && at !== undefined && at.offset >= chunk.start;
  }

  /**
   * Gives the source back everything from the resume point on, so the
   * source's position is that point. The reader is finished after.
   */
  settle(): boolean {
    const at = this.resume();
    if (!at || !this.lines.giveBackFrom(at.offset)) return false;
    this.finished = true;
    this.building = undefined;
    return true;
  }

  /**
   * The next whole message, `paused` when only dropped bytes were being read
   * and `mayRead` said stop, or `end` once the stream has ended.
   */
  next(mayRead?: () => boolean): WhatsAppMessageStep {
    for (;;) {
      if (this.finished) return { kind: 'end' };
      // A message whose first line was already cut goes out now.
      if (this.building?.cut) return { kind: 'message', message: this.cutOff() };
      const step = this.lines.next({
        headersOnly: this.dropping && !this.expectHeader,
        ...(this.dropping && mayRead ? { mayRead } : {}),
      });
      if (step.kind === 'paused') return { kind: 'paused' };
      if (step.kind === 'end') {
        this.finished = true;
        const last = this.building;
        this.building = undefined;
        return last ? { kind: 'message', message: this.finish(last) } : { kind: 'end' };
      }
      const line = step.line;
      const text = whatsAppLineText(line);
      const header = matchWhatsAppHeader(text);
      if (this.expectHeader) {
        this.expectHeader = false;
        if (!header) throw new WhatsAppFormatError('No message starts where this import was to resume.');
      }
      if (header) {
        const done = this.building;
        const first = splitWhatsAppSender(header.rest);
        this.building = {
          offset: line.offset,
          crc: line.crc,
          header,
          sender: first.sender,
          parts: [],
          chars: 0,
          bytes: line.bytes.length + 1,
          cut: line.cut,
        };
        this.dropping = false;
        this.append(this.building, first.text);
        if (done) return { kind: 'message', message: this.finish(done) };
        continue;
      }
      const building = this.building;
      if (!building) continue;
      building.bytes += line.bytes.length + 1;
      if (line.cut) building.cut = true;
      this.append(building, text);
      if (building.bytes >= this.maxMessageBytes) building.cut = true;
      if (building.cut) return { kind: 'message', message: this.cutOff() };
    }
  }

  /** The message in progress, cut: out it goes, and the lines after it are dropped until the next header. */
  private cutOff(): WhatsAppRawMessage {
    const message = this.building!;
    this.building = undefined;
    this.dropping = true;
    return this.finish(message);
  }

  private append(message: Building, text: string): void {
    if (message.chars >= this.maxTextChars) {
      if (text.length > 0) message.cut = true;
      return;
    }
    // Lines after the first are joined with a line break, which counts too.
    const separator = message.parts.length > 0 ? 1 : 0;
    const room = this.maxTextChars - message.chars - separator;
    if (text.length > room) {
      message.parts.push(text.slice(0, Math.max(0, room)));
      message.chars = this.maxTextChars;
      message.cut = true;
      return;
    }
    message.parts.push(text);
    message.chars += separator + text.length;
  }

  private finish(message: Building): WhatsAppRawMessage {
    return {
      offset: message.offset,
      header: message.header,
      ...(message.sender !== undefined ? { sender: message.sender } : {}),
      text: message.parts.join('\n').replace(/\s+$/u, ''),
      cut: message.cut,
    };
  }
}

export interface WhatsAppDateOrderScan {
  order: WhatsAppDateOrder;
  /** Nothing in the file settled which part is the day; day first was taken. */
  assumed: boolean;
  /** How the first header was written; every later header is held against it. Undefined: no header was found. */
  style: string | undefined;
  /** Bytes of the stream the scan read. */
  bytesRead: number;
}

/**
 * The date order of a file, read from its headers: a first part above 12 is a
 * day, a second part above 12 is a day, a first part of four digits is a year.
 * Each header that says counts one vote, and the order with the most votes
 * wins, so one header pasted into a message by hand cannot decide a file.
 * Headers written in another style than the first header's do not vote. The
 * scan stops after WHATSAPP_ORDER_VOTES_ENOUGH votes or WHATSAPP_ORDER_SCAN_MAX_BYTES.
 *
 * A file whose headers never say (and could be read both ways), or whose
 * votes tie, is taken day first and says so.
 */
export function scanWhatsAppDateOrder(
  source: ArchiveByteSource,
  options: { maxBytes?: number; votesEnough?: number } = {},
): WhatsAppDateOrderScan {
  const lines = new WhatsAppLineReader(source);
  const maxBytes = options.maxBytes ?? WHATSAPP_ORDER_SCAN_MAX_BYTES;
  const votesEnough = options.votesEnough ?? WHATSAPP_ORDER_VOTES_ENOUGH;
  const votes: Record<WhatsAppDateOrder, number> = { dmy: 0, mdy: 0, ymd: 0 };
  let total = 0;
  let style: string | undefined;
  let ambiguous = false;
  for (;;) {
    // Lines that are not headers are dropped inside `next`, so the bound is held at its reads.
    const step = lines.next({ headersOnly: true, mayRead: () => source.position < maxBytes });
    if (step.kind !== 'line') break;
    if (step.line.offset > maxBytes) break;
    const header = matchWhatsAppHeader(normalizeWhatsAppLine(utf8.decode(step.line.bytes.subarray(0, WHATSAPP_HEADER_PREFIX_BYTES))));
    if (!header) continue;
    style ??= header.style;
    if (header.style !== style) continue;
    const evidence = whatsAppOrderEvidence(header);
    if (evidence) {
      votes[evidence] += 1;
      total += 1;
      if (total >= votesEnough) break;
    } else if (header.p1 !== header.p2) {
      // Both readings are possible; only a header whose two parts differ makes them different dates.
      ambiguous = true;
    }
  }
  const bytesRead = source.position;
  const ranked = (Object.entries(votes) as Array<[WhatsAppDateOrder, number]>).sort((a, b) => b[1] - a[1]);
  const [top, runnerUp] = ranked;
  if (!top || top[1] === 0) return { order: 'dmy', assumed: ambiguous, style, bytesRead };
  if (runnerUp && runnerUp[1] === top[1]) return { order: 'dmy', assumed: true, style, bytesRead };
  return { order: top[0], assumed: false, style, bytesRead };
}
