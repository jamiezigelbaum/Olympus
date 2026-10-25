/**
 * Streaming split of an mbox file into messages, by byte offset.
 *
 * A message starts at a `From ` line: at the start of the file or right after
 * a newline. The splitter reads the file in growing ranges through the
 * scope-safe reader and never holds more than one message (bounded by
 * `maxMessageBytes`) plus one read range. A message over the bound is not
 * read: its span is reported as too large and the splitter skips to the next
 * `From ` line without keeping its bytes.
 *
 * Each message comes back without its `From ` line, without the blank line
 * that separates it from the next one, and with `>From ` quoting undone one
 * level (mboxrd: `>From ` becomes `From `, `>>From ` becomes `>From `). LF and
 * CRLF files both work; bytes are never re-encoded.
 */

const SEPARATOR = Buffer.from('\nFrom ', 'latin1');
const FROM = Buffer.from('From ', 'latin1');
const LF = 0x0a;
const CR = 0x0d;
const GT = 0x3e;

export const MBOX_DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MIN_READ_BYTES = 1024 * 1024;

export interface MboxByteSource {
  readonly size: number;
  readAt(offset: number, length: number): Uint8Array;
}

export interface MboxMessageSpan {
  /** Byte offset of the message's `From ` line. */
  offset: number;
  /** Bytes from that line to the next message (or the end of the file). */
  length: number;
  /** The message itself; absent when it was over the size bound. */
  raw?: Uint8Array;
  /**
   * The `From ` line, without its line end (latin1, at most
   * `MAX_SEPARATOR_CHARS`): Google Takeout writes the Gmail message id in it.
   */
  separator?: string;
  tooLarge: boolean;
}

export const MAX_SEPARATOR_CHARS = 1024;

export class MboxFormatError extends Error {
  readonly offset: number;
  constructor(offset: number) {
    super('No message starts at this position of the mail file.');
    this.name = 'MboxFormatError';
    this.offset = offset;
  }
}

export class MboxSplitter {
  private readonly source: MboxByteSource;
  private readonly maxMessageBytes: number;
  private buffer: Buffer = Buffer.alloc(0);
  /** File offset of `buffer[0]`. */
  private bufferStart: number;
  private next_: number;

  constructor(source: MboxByteSource, options: { start?: number; maxMessageBytes?: number } = {}) {
    this.source = source;
    this.maxMessageBytes = Math.max(1, options.maxMessageBytes ?? MBOX_DEFAULT_MAX_MESSAGE_BYTES);
    this.next_ = options.start ?? 0;
    this.bufferStart = this.next_;
  }

  /** Where the next message starts: a resume point. */
  get position(): number {
    return this.next_;
  }

  get done(): boolean {
    return this.next_ >= this.source.size;
  }

  next(): MboxMessageSpan | undefined {
    const start = this.next_;
    if (start >= this.source.size) return undefined;
    this.dropBefore(start);
    this.ensure(start, FROM.length);
    if (!this.bytesAt(start).subarray(0, FROM.length).equals(FROM)) throw new MboxFormatError(start);

    // Look for the next separator, reading more while the message is within bounds.
    let scanFrom = start + 1;
    for (;;) {
      const found = this.indexOfSeparator(scanFrom);
      if (found !== undefined) {
        const end = found + 1;
        this.next_ = end;
        return this.span(start, end);
      }
      const buffered = this.bufferStart + this.buffer.length;
      if (buffered >= this.source.size) {
        this.next_ = this.source.size;
        return this.span(start, this.source.size);
      }
      if (buffered - start > this.maxMessageBytes) return this.skipTooLarge(start);
      scanFrom = Math.max(start + 1, buffered - SEPARATOR.length + 1);
      this.readMore(Math.max(MIN_READ_BYTES, this.buffer.length));
    }
  }

  private span(start: number, end: number): MboxMessageSpan {
    const length = end - start;
    if (length > this.maxMessageBytes) return { offset: start, length, tooLarge: true };
    const bytes = this.bytesAt(start).subarray(0, length);
    return { offset: start, length, raw: unquote(stripSeparatorLines(bytes)), separator: separatorLine(bytes), tooLarge: false };
  }

  /** Scans on to the next separator holding at most one read range, for a message over the bound. */
  private skipTooLarge(start: number): MboxMessageSpan {
    let scanFrom = this.bufferStart + Math.max(0, this.buffer.length - SEPARATOR.length + 1);
    for (;;) {
      const keepFrom = Math.max(this.bufferStart, scanFrom - SEPARATOR.length);
      this.dropBefore(keepFrom);
      const buffered = this.bufferStart + this.buffer.length;
      if (buffered >= this.source.size) {
        this.next_ = this.source.size;
        return { offset: start, length: this.source.size - start, tooLarge: true };
      }
      this.readMore(MIN_READ_BYTES);
      const found = this.indexOfSeparator(Math.max(start + 1, scanFrom));
      if (found !== undefined) {
        this.next_ = found + 1;
        return { offset: start, length: found + 1 - start, tooLarge: true };
      }
      scanFrom = Math.max(start + 1, this.bufferStart + this.buffer.length - SEPARATOR.length + 1);
    }
  }

  private indexOfSeparator(fromOffset: number): number | undefined {
    const index = this.buffer.indexOf(SEPARATOR, Math.max(0, fromOffset - this.bufferStart));
    return index < 0 ? undefined : this.bufferStart + index;
  }

  private bytesAt(offset: number): Buffer {
    return this.buffer.subarray(offset - this.bufferStart);
  }

  private dropBefore(offset: number): void {
    if (offset < this.bufferStart) {
      this.buffer = Buffer.alloc(0);
      this.bufferStart = offset;
      return;
    }
    const drop = offset - this.bufferStart;
    if (drop >= this.buffer.length) {
      this.buffer = Buffer.alloc(0);
      this.bufferStart = offset;
    } else if (drop > 0) {
      this.buffer = this.buffer.subarray(drop);
      this.bufferStart = offset;
    }
  }

  private ensure(offset: number, length: number): void {
    while (this.bufferStart + this.buffer.length < Math.min(offset + length, this.source.size)) {
      this.readMore(MIN_READ_BYTES);
    }
  }

  private readMore(length: number): void {
    const from = this.bufferStart + this.buffer.length;
    const chunk = this.source.readAt(from, Math.min(length, Math.max(0, this.source.size - from)));
    if (chunk.length === 0) throw new MboxFormatError(from);
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length)
      : Buffer.concat([this.buffer, chunk]);
  }
}

/** The `From ` line, bounded, without its line end. */
function separatorLine(bytes: Buffer): string {
  const end = bytes.indexOf(LF);
  const line = bytes.subarray(0, Math.min(end < 0 ? bytes.length : end, MAX_SEPARATOR_CHARS)).toString('latin1');
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Drops the `From ` line and the one blank line before the next message. */
function stripSeparatorLines(bytes: Buffer): Buffer {
  const firstLineEnd = bytes.indexOf(LF);
  let body = firstLineEnd < 0 ? Buffer.alloc(0) : bytes.subarray(firstLineEnd + 1);
  const n = body.length;
  if (n >= 4 && body[n - 4] === CR && body[n - 3] === LF && body[n - 2] === CR && body[n - 1] === LF) {
    body = body.subarray(0, n - 2);
  } else if (n >= 2 && body[n - 2] === LF && body[n - 1] === LF) {
    body = body.subarray(0, n - 1);
  } else if (n === 1 && body[0] === LF) {
    body = body.subarray(0, 0);
  }
  return body;
}

/** Undoes one level of `>From ` quoting at the start of every line. */
function unquote(bytes: Buffer): Uint8Array {
  const out: Buffer[] = [];
  let copied = 0;
  let lineStart = 0;
  while (lineStart < bytes.length) {
    if (bytes[lineStart] === GT) {
      let index = lineStart;
      while (index < bytes.length && bytes[index] === GT) index += 1;
      if (bytes.subarray(index, index + FROM.length).equals(FROM)) {
        out.push(bytes.subarray(copied, lineStart));
        copied = lineStart + 1;
      }
    }
    const next = bytes.indexOf(LF, lineStart);
    if (next < 0) break;
    lineStart = next + 1;
  }
  if (copied === 0) return bytes;
  out.push(bytes.subarray(copied));
  return Buffer.concat(out);
}
