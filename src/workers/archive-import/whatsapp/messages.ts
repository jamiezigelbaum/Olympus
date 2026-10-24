/**
 * Streaming readers for a WhatsApp chat export: lines out of any byte source
 * (a file range or a zip member), and messages out of lines.
 *
 * - Lines: split at LF, a trailing CR dropped. A line longer than
 *   LINE_BYTES_KEPT keeps its start and says so; memory never follows a line's
 *   length, so a file with no line breaks at all is read in bounded memory.
 * - Messages: a header line starts one, every line up to the next header
 *   continues it. The text kept per message is bounded (`maxTextChars`); the
 *   rest is read and dropped, and the message says it was cut.
 * - Where a page may stop: the message in progress starts at a known byte
 *   offset. When that offset lies in the chunk last read, `settle` gives the
 *   rest of the chunk back to the source, so a zip member's inflater can be
 *   parked exactly at the start of the next message.
 */
import { crc32Update, type ArchiveByteSource } from '../byte-source.ts';
import {
  matchWhatsAppHeader,
  normalizeWhatsAppLine,
  splitWhatsAppSender,
  whatsAppOrderEvidence,
  type WhatsAppDateOrder,
  type WhatsAppHeaderMatch,
} from '../../../core/whatsapp-export-grammar.ts';

/** Text kept per message (characters); longer messages are cut and counted as a gap. */
export const WHATSAPP_MAX_ITEM_TEXT_CHARS = 1_048_576;
/** Bytes of one line kept while it is read. */
export const WHATSAPP_LINE_BYTES_KEPT = 4 * 1024 * 1024;
/** Content read looking for the file's date order before it is taken as day first. */
export const WHATSAPP_ORDER_SCAN_MAX_BYTES = 256 * 1024 * 1024;

const utf8 = new TextDecoder('utf-8');

export interface WhatsAppLine {
  /** The line without its line break (a CR before it is dropped too). */
  bytes: Uint8Array;
  /** Where the line starts in the source's stream. */
  offset: number;
  /** The line was longer than LINE_BYTES_KEPT: `bytes` is only its start. */
  cut: boolean;
}

export class WhatsAppLineReader {
  private chunk: Uint8Array | undefined;
  private chunkStart = 0;
  private crcBeforeChunk: number | undefined;
  private at = 0;
  private carry: Uint8Array[] = [];
  private carryBytes = 0;
  private carryCut = false;
  private inLine = false;
  private lineStart = 0;
  private ended = false;

  constructor(private readonly source: ArchiveByteSource) {}

  get atEnd(): boolean {
    return this.ended;
  }

  /** The stream offsets of the chunk read last, or undefined before the first or after the end. */
  get lastChunk(): { start: number; end: number } | undefined {
    return this.chunk && !this.ended ? { start: this.chunkStart, end: this.chunkStart + this.chunk.length } : undefined;
  }

  /**
   * The CRC-32 of the stream before `offset`, when `offset` lies in the chunk
   * read last and the source keeps one.
   */
  crcAt(offset: number): number | undefined {
    const chunk = this.chunk;
    if (!chunk || this.ended || this.crcBeforeChunk === undefined) return undefined;
    if (offset < this.chunkStart || offset > this.chunkStart + chunk.length) return undefined;
    return crc32Update(this.crcBeforeChunk, chunk.subarray(0, offset - this.chunkStart));
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

  next(): WhatsAppLine | undefined {
    for (;;) {
      if (this.ended) return undefined;
      if (!this.chunk || this.at >= this.chunk.length) {
        const crcBefore = this.source.crc32;
        const chunk = this.source.next();
        if (!chunk) {
          this.ended = true;
          if (!this.inLine) return undefined;
          this.inLine = false;
          return this.take(new Uint8Array(0));
        }
        this.chunk = chunk;
        this.chunkStart = this.source.position - chunk.length;
        this.crcBeforeChunk = crcBefore;
        this.at = 0;
        continue;
      }
      const chunk = this.chunk;
      if (!this.inLine) {
        this.inLine = true;
        this.lineStart = this.chunkStart + this.at;
      }
      const newline = chunk.indexOf(0x0a, this.at);
      if (newline < 0) {
        this.keep(chunk.subarray(this.at));
        this.at = chunk.length;
        continue;
      }
      const segment = chunk.subarray(this.at, newline);
      this.at = newline + 1;
      this.inLine = false;
      return this.take(segment);
    }
  }

  private keep(bytes: Uint8Array): void {
    const room = WHATSAPP_LINE_BYTES_KEPT - this.carryBytes;
    if (room <= 0) {
      this.carryCut = true;
      return;
    }
    const part = bytes.length > room ? bytes.subarray(0, room) : bytes;
    if (bytes.length > room) this.carryCut = true;
    this.carry.push(part.slice());
    this.carryBytes += part.length;
  }

  private take(last: Uint8Array): WhatsAppLine {
    let bytes = last;
    let cut = this.carryCut;
    if (this.carry.length > 0 || this.carryCut) {
      this.keep(last);
      cut = this.carryCut;
      bytes = new Uint8Array(this.carryBytes);
      let at = 0;
      for (const part of this.carry) {
        bytes.set(part, at);
        at += part.length;
      }
    }
    this.carry = [];
    this.carryBytes = 0;
    this.carryCut = false;
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, bytes.length - 1);
    return { bytes, offset: this.lineStart, cut };
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
  /** How many header lines came before it in this file or member. */
  ordinal: number;
  header: WhatsAppHeaderMatch;
  /** Absent for a notice from WhatsApp itself. */
  sender?: string;
  /** The text after the header, lines joined, trailing space dropped. */
  text: string;
  /** Some of the text was cut: it was longer than the bound. */
  cut: boolean;
}

interface Building {
  offset: number;
  ordinal: number;
  header: WhatsAppHeaderMatch;
  sender: string | undefined;
  parts: string[];
  chars: number;
  cut: boolean;
}

export class WhatsAppMessageReader {
  private readonly lines: WhatsAppLineReader;
  private readonly maxTextChars: number;
  private readonly requireHeaderFirst: boolean;
  private ordinal: number;
  private building: Building | undefined;
  private firstLine = true;
  private finished = false;

  /**
   * `startOrdinal` is how many header lines lie before `source`'s position.
   * With `requireHeaderFirst` the first line must be a header (the stream was
   * entered where a message is said to start), else a WhatsAppFormatError.
   */
  constructor(
    private readonly source: ArchiveByteSource,
    options: { startOrdinal?: number; requireHeaderFirst?: boolean; maxTextChars?: number } = {},
  ) {
    this.lines = new WhatsAppLineReader(source);
    this.ordinal = options.startOrdinal ?? 0;
    this.requireHeaderFirst = options.requireHeaderFirst === true;
    this.maxTextChars = options.maxTextChars ?? WHATSAPP_MAX_ITEM_TEXT_CHARS;
  }

  /** The stream offset the reader has consumed up to. */
  get position(): number {
    return this.source.position;
  }

  /**
   * Where the message now being read starts, and its ordinal; undefined once
   * the stream has ended (nothing is left after the last message).
   */
  get pending(): { offset: number; ordinal: number } | undefined {
    return this.building ? { offset: this.building.offset, ordinal: this.building.ordinal } : undefined;
  }

  /** The message in progress starts in the chunk read last (so it can be given back to the source). */
  canSettle(): boolean {
    const building = this.building;
    const chunk = this.lines.lastChunk;
    return building !== undefined && chunk !== undefined && building.offset >= chunk.start;
  }

  /** The CRC-32 of the stream before the message in progress, when it can be known. */
  pendingCrc(): number | undefined {
    return this.building ? this.lines.crcAt(this.building.offset) : undefined;
  }

  /**
   * Gives the source back everything from the message in progress on, so the
   * source's position is that message's start. The reader is finished after.
   */
  settle(): boolean {
    const building = this.building;
    if (!building || !this.lines.giveBackFrom(building.offset)) return false;
    this.finished = true;
    this.building = undefined;
    return true;
  }

  /** The next whole message, or undefined once the stream has ended. */
  next(): WhatsAppRawMessage | undefined {
    if (this.finished) return undefined;
    for (;;) {
      const line = this.lines.next();
      if (!line) {
        this.finished = true;
        const last = this.building;
        this.building = undefined;
        return last ? this.finish(last) : undefined;
      }
      const text = whatsAppLineText(line);
      const header = matchWhatsAppHeader(text);
      if (this.firstLine) {
        this.firstLine = false;
        if (this.requireHeaderFirst && !header) {
          throw new WhatsAppFormatError('No message starts where this import was to resume.');
        }
      }
      if (header) {
        const done = this.building;
        const first = splitWhatsAppSender(header.rest);
        this.building = {
          offset: line.offset,
          ordinal: this.ordinal,
          header,
          sender: first.sender,
          parts: [],
          chars: 0,
          cut: line.cut,
        };
        this.ordinal += 1;
        this.append(this.building, first.text);
        if (done) return this.finish(done);
        continue;
      }
      if (this.building) {
        if (line.cut) this.building.cut = true;
        this.append(this.building, text);
      }
    }
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
      ordinal: message.ordinal,
      header: message.header,
      ...(message.sender !== undefined ? { sender: message.sender } : {}),
      text: message.parts.join('\n').replace(/\s+$/u, ''),
      cut: message.cut,
    };
  }
}

export interface WhatsAppDateOrderScan {
  order: WhatsAppDateOrder;
  /** Nothing in the file said which part is the day; day first was taken. */
  assumed: boolean;
}

/**
 * The date order of a file, read from its headers: a first part above 12 is a
 * day, a second part above 12 is a day, a first part of four digits is a year.
 * The first header that says wins. Undefined when `shouldContinue` stopped the
 * scan. A file whose headers never say (and could be read both ways) is
 * assumed day first, and says so.
 */
export function scanWhatsAppDateOrder(
  source: ArchiveByteSource,
  options: { shouldContinue?: () => boolean; maxBytes?: number } = {},
): WhatsAppDateOrderScan | undefined {
  const lines = new WhatsAppLineReader(source);
  const maxBytes = options.maxBytes ?? WHATSAPP_ORDER_SCAN_MAX_BYTES;
  let ambiguous = false;
  let seen = 0;
  for (;;) {
    const line = lines.next();
    if (!line) break;
    seen += 1;
    if (seen % 512 === 0 && options.shouldContinue && !options.shouldContinue()) return undefined;
    if (line.offset > maxBytes) break;
    const header = matchWhatsAppHeader(whatsAppLineText(line));
    if (!header) continue;
    const evidence = whatsAppOrderEvidence(header);
    if (evidence) return { order: evidence, assumed: false };
    // Both readings are possible; only a header whose two parts differ makes them different dates.
    if (header.p1 !== header.p2) ambiguous = true;
  }
  return { order: 'dmy', assumed: ambiguous };
}
