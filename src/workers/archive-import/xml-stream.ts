/**
 * Streaming reading of the records inside a large XML file.
 *
 * An XML export is one document whose bulk is a long run of sibling elements
 * (one per note, say), some of which carry very large text (an attachment's
 * bytes in base64). This reader walks the document byte by byte, a chunk at a
 * time, and hands out one record at a time from the paths a format names,
 * never holding more than one record (plus the chunk being read) in memory.
 *
 * - Records: the elements whose path from the document's root equals one of
 *   `recordPaths` (`['export', 'note']`). Each is handed out whole, as a small
 *   tree of elements, attributes and text, with the byte offsets where it
 *   starts and ends.
 * - Ranges: the text of an element named in `rangeElements` is never kept.
 *   The record carries where it is in the file instead (`ranges`, byte offsets
 *   of the raw text), so a caller can read it later, in bounded slices,
 *   without the reader ever holding it. Text in such an element that holds an
 *   entity reference is flagged (`rangeEntities`): its raw bytes are not the
 *   text.
 * - Resuming: a record is handed out with its end offset. A later pass opens a
 *   source at that offset and continues there with the open elements above
 *   it (`open`), without reading what came before.
 * - Bounds: a record whose kept bytes (its tags and the text it keeps) pass
 *   `maxRecordBytes` is not built; it is handed out as `oversize`, with its
 *   offsets, and the reader moves on, still checking what it discards. A tag,
 *   a comment, a processing instruction or a document type declaration longer
 *   than XML_STREAM_MAX_MARKUP_BYTES stops the read, as nesting deeper than
 *   XML_STREAM_MAX_DEPTH does.
 * - Grammar: start, end and empty-element tags, attributes in single or double
 *   quotes, text, CDATA sections, comments, processing instructions and the
 *   document type declaration (with an internal subset). The five predefined
 *   entities and numeric character references are decoded in text and
 *   attributes; any other entity reference is kept as written. An end tag
 *   that does not close the open element, markup that is not XML, or a
 *   document that ends inside an element is damage: the records whole before
 *   it are handed out first, then the error is thrown, however the bytes were
 *   chunked.
 */
import type { ArchiveByteSource } from './byte-source.ts';

export const XML_STREAM_MAX_DEPTH = 256;
/** The longest tag, comment, processing instruction or declaration the reader takes. */
export const XML_STREAM_MAX_MARKUP_BYTES = 1024 * 1024;
/** What one kept range of a range element costs a record, against its byte budget: its own bookkeeping. */
export const XML_STREAM_RANGE_COST = 32;

export type XmlStreamErrorCode = 'invalid_xml' | 'truncated' | 'too_deep';

export class XmlStreamError extends Error {
  readonly code: XmlStreamErrorCode;
  /** The byte offset in the file where the damage was found. */
  readonly offset: number;
  constructor(code: XmlStreamErrorCode, message: string, offset: number) {
    super(message);
    this.name = 'XmlStreamError';
    this.code = code;
    this.offset = offset;
  }
}

/** One element of a record. */
export interface XmlElement {
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: Array<XmlElement | string>;
  /** For a `rangeElements` element: where its raw text is in the file, in order. */
  ranges?: Array<{ start: number; end: number }>;
  /** For a `rangeElements` element: its text held an entity reference, so its raw bytes are not its text. */
  rangeEntities?: true;
}

export type XmlStreamEvent =
  | { kind: 'record'; path: readonly string[]; element: XmlElement; start: number; end: number }
  /** A record past `maxRecordBytes`: not built. */
  | { kind: 'oversize'; path: readonly string[]; start: number; end: number };

export interface XmlStreamOptions {
  recordPaths: readonly (readonly string[])[];
  rangeElements?: readonly string[];
  maxRecordBytes: number;
  /**
   * Resuming: the elements open at the source's first byte, from the root
   * (a record's end, as `open` after it said). Absent at the start of a file.
   */
  open?: readonly string[];
}

const LT = 0x3c;
const GT = 0x3e;
const AMP = 0x26;

const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Text with the predefined entities and numeric references decoded; any other reference kept as written. */
export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9._-]*);/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return PREDEFINED[ref] ?? whole;
  });
}

const NAME = /^[A-Za-z_:À-￿][\w.:\-·À-￿]*$/;
const ATTRIBUTE = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

/** A start or empty-element tag's text (between `<` and `>`): its name and attributes, or undefined when it is not one. */
export function parseXmlTag(inner: string): { name: string; attributes: Record<string, string>; empty: boolean } | undefined {
  let text = inner;
  const empty = text.endsWith('/');
  if (empty) text = text.slice(0, -1);
  const nameMatch = /^[^\s/>]+/.exec(text);
  if (!nameMatch || !NAME.test(nameMatch[0])) return undefined;
  const attributes: Record<string, string> = {};
  let at = nameMatch[0].length;
  ATTRIBUTE.lastIndex = at;
  for (;;) {
    if (/^\s*$/.test(text.slice(at))) break;
    ATTRIBUTE.lastIndex = at;
    const match = ATTRIBUTE.exec(text);
    if (!match) return undefined;
    attributes[match[1]!] = decodeXmlEntities(match[2] ?? match[3] ?? '');
    at = ATTRIBUTE.lastIndex;
  }
  return { name: nameMatch[0], attributes, empty };
}

type Mode = 'text' | 'markup' | 'comment' | 'cdata' | 'pi' | 'doctype' | 'range';

interface Building {
  element: XmlElement;
  /** Text bytes not yet decoded, and whether they were CDATA (no entity decoding). */
  pending: Uint8Array[];
  pendingCdata: boolean;
}

/**
 * Hands out the records of one XML document from a byte source. Pull-based:
 * `next()` reads on until a record is whole (or the document ends) and returns
 * it, so nothing waits in a queue and damage is thrown only after every record
 * whole before it was taken.
 */
export class XmlStreamReader {
  private readonly source: ArchiveByteSource;
  private readonly recordPaths: readonly (readonly string[])[];
  private readonly rangeNames: ReadonlySet<string>;
  private readonly maxRecordBytes: number;
  private readonly decoder = new TextDecoder('utf-8');

  private chunk: Uint8Array = new Uint8Array(0);
  private chunkStart = 0;
  private index = 0;
  private ended = false;

  private readonly stack: string[];
  private mode: Mode = 'text';
  private markup: number[] = [];
  private markupStart = 0;
  /** Bytes matched so far of the terminator a comment, CDATA or PI waits for. */
  private doctypeDepth = 0;
  private doctypeQuote = 0;
  private markupQuote = 0;

  // The record being read: its depth in the stack, where it began, the tree so far.
  private recordDepth = -1;
  private recordPath: readonly string[] = [];
  private recordStart = 0;
  private recordBytes = 0;
  private discarding = false;
  private building: Building[] = [];
  /** Up to two `]` that ended the last chunk inside a CDATA section: text, or the start of its `]]>`. */
  private cdataHeld: number[] = [];
  private rootSeenName: string | undefined;

  constructor(source: ArchiveByteSource, options: XmlStreamOptions) {
    this.source = source;
    this.recordPaths = options.recordPaths;
    this.rangeNames = new Set(options.rangeElements ?? []);
    this.maxRecordBytes = Math.max(1, options.maxRecordBytes);
    this.stack = [...(options.open ?? [])];
    if (this.stack.length > 0) this.rootSeenName = this.stack[0];
    this.chunkStart = source.position;
  }

  /** The document's root element's name, once its start tag was read (or the resume point named it). */
  get rootName(): string | undefined {
    return this.rootSeenName;
  }

  /** The elements open where the reader is now, from the root. */
  get open(): readonly string[] {
    return this.stack;
  }

  private get offset(): number {
    return this.chunkStart + this.index;
  }

  private fail(code: XmlStreamErrorCode, message: string, offset = this.offset): never {
    throw new XmlStreamError(code, message, offset);
  }

  private fill(): boolean {
    if (this.index < this.chunk.length) return true;
    if (this.ended) return false;
    for (;;) {
      const position = this.source.position;
      const next = this.source.next();
      if (next === undefined) {
        this.ended = true;
        return false;
      }
      if (next.length === 0) continue;
      this.chunkStart = position;
      this.chunk = next;
      this.index = 0;
      return true;
    }
  }

  private inRecord(): boolean {
    return this.recordDepth >= 0;
  }

  private keeping(): boolean {
    return this.inRecord() && !this.discarding;
  }

  private count(bytes: number): void {
    if (!this.keeping()) return;
    this.recordBytes += bytes;
    if (this.recordBytes > this.maxRecordBytes) {
      this.discarding = true;
      this.building = [];
    }
  }

  private top(): Building | undefined {
    return this.building[this.building.length - 1];
  }

  private flushText(): void {
    const open = this.top();
    if (!open || open.pending.length === 0) return;
    const total = open.pending.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of open.pending) {
      bytes.set(part, at);
      at += part.length;
    }
    const text = this.decoder.decode(bytes);
    open.element.children.push(open.pendingCdata ? text : decodeXmlEntities(text));
    open.pending = [];
  }

  private keepText(bytes: Uint8Array, cdata: boolean): void {
    if (!this.keeping() || bytes.length === 0) return;
    const open = this.top();
    if (!open) return;
    if (open.pending.length > 0 && open.pendingCdata !== cdata) this.flushText();
    open.pendingCdata = cdata;
    // A copy: the chunk is the source's and may be reused.
    open.pending.push(bytes.slice());
    this.count(bytes.length);
  }

  private inRange(): boolean {
    const open = this.top();
    return !!open && this.rangeNames.has(open.element.name);
  }

  private matchRecord(): readonly string[] | undefined {
    return this.recordPaths.find((path) => path.length === this.stack.length && path.every((name, at) => name === this.stack[at]));
  }

  /** The next record, or undefined at the end of the document. */
  next(): XmlStreamEvent | undefined {
    for (;;) {
      if (!this.fill()) {
        if (this.mode !== 'text' || this.stack.length > 0) {
          this.fail('truncated', 'The document ends inside an element.');
        }
        return undefined;
      }
      const event = this.step();
      if (event) return event;
    }
  }

  /** Reads within the current chunk until an event is whole or the chunk is used up. */
  private step(): XmlStreamEvent | undefined {
    const chunk = this.chunk;
    while (this.index < chunk.length) {
      switch (this.mode) {
        case 'text': {
          const lt = chunk.indexOf(LT, this.index);
          const end = lt < 0 ? chunk.length : lt;
          if (end > this.index) {
            const piece = chunk.subarray(this.index, end);
            if (this.inRange() && this.keeping()) {
              const open = this.top()!;
              if (piece.includes(AMP)) open.element.rangeEntities = true;
              this.addRange(open, this.offset, piece.length);
            } else if (this.keeping()) {
              this.keepText(piece, false);
            } else if (!this.inRecord() && this.stack.length === 0 && this.rootSeenName !== undefined) {
              // After the root closed only space may follow.
              if (piece.some((byte) => byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09)) {
                this.fail('invalid_xml', 'Text after the document\'s root element.');
              }
            }
            this.index = end;
          }
          if (lt >= 0) {
            this.mode = 'markup';
            this.markup = [];
            // The offset of the `<` itself.
            this.markupStart = this.offset;
            this.markupQuote = 0;
            this.index += 1;
          }
          break;
        }
        case 'markup': {
          const byte = chunk[this.index]!;
          this.index += 1;
          this.markup.push(byte);
          if (this.markup.length > XML_STREAM_MAX_MARKUP_BYTES) this.fail('invalid_xml', 'A tag is too long.', this.markupStart);
          // What kind of markup this is, once its first bytes say.
          if (this.markup.length === 3 && this.markup[0] === 0x21 && this.markup[1] === 0x2d && this.markup[2] === 0x2d) {
            this.mode = 'comment';
            this.markup = [];
            break;
          }
          if (this.markup.length === 8 && String.fromCharCode(...this.markup) === '![CDATA[') {
            if (!this.inRecord() && this.stack.length === 0) this.fail('invalid_xml', 'A CDATA section outside the document\'s root element.', this.markupStart);
            this.mode = 'cdata';
            this.markup = [];
            this.cdataHeld = [];
            break;
          }
          if (this.markup.length === 8 && String.fromCharCode(...this.markup).toUpperCase() === '!DOCTYPE') {
            this.mode = 'doctype';
            this.doctypeDepth = 0;
            this.doctypeQuote = 0;
            break;
          }
          if (this.markup.length === 1 && byte === 0x3f) {
            this.mode = 'pi';
            this.markup = [];
            break;
          }
          if (byte === 0x22 || byte === 0x27) {
            if (this.markupQuote === 0) this.markupQuote = byte;
            else if (this.markupQuote === byte) this.markupQuote = 0;
          }
          if (byte === GT && this.markupQuote === 0) {
            const event = this.tag();
            if (event) return event;
          }
          break;
        }
        case 'comment': {
          // `-->`: the markup buffer keeps the last two bytes.
          const byte = chunk[this.index]!;
          this.index += 1;
          if (byte === GT && this.markup.length >= 2 && this.markup[this.markup.length - 1] === 0x2d && this.markup[this.markup.length - 2] === 0x2d) {
            this.mode = 'text';
            this.markup = [];
            this.chargeSkipped();
            break;
          }
          this.markup.push(byte);
          if (this.markup.length > 2) this.markup.shift();
          this.countMarkupLength();
          break;
        }
        case 'pi': {
          const byte = chunk[this.index]!;
          this.index += 1;
          if (byte === GT && this.markup[this.markup.length - 1] === 0x3f) {
            this.mode = 'text';
            this.markup = [];
            this.chargeSkipped();
            break;
          }
          this.markup.push(byte);
          if (this.markup.length > 1) this.markup.shift();
          this.countMarkupLength();
          break;
        }
        case 'doctype': {
          const byte = chunk[this.index]!;
          this.index += 1;
          if (this.inRecord() || this.stack.length > 0) this.fail('invalid_xml', 'A document type declaration inside an element.', this.markupStart);
          if (this.doctypeQuote !== 0) {
            if (byte === this.doctypeQuote) this.doctypeQuote = 0;
          } else if (byte === 0x22 || byte === 0x27) this.doctypeQuote = byte;
          else if (byte === 0x5b) this.doctypeDepth += 1;
          else if (byte === 0x5d) this.doctypeDepth = Math.max(0, this.doctypeDepth - 1);
          else if (byte === GT && this.doctypeDepth === 0) {
            this.mode = 'text';
            this.markup = [];
            break;
          }
          this.countMarkupLength();
          break;
        }
        case 'cdata': {
          // Until `]]>`. Text is kept (or ranged) as it goes; a `]` or `]]` at the end of a chunk waits for the next.
          let view = chunk.subarray(this.index);
          let base = this.offset;
          if (this.cdataHeld.length > 0) {
            const joined = new Uint8Array(this.cdataHeld.length + view.length);
            joined.set(this.cdataHeld, 0);
            joined.set(view, this.cdataHeld.length);
            base -= this.cdataHeld.length;
            view = joined;
            this.cdataHeld = [];
          }
          let close = -1;
          for (let at = 0; at + 2 < view.length; at += 1) {
            if (view[at] === 0x5d && view[at + 1] === 0x5d && view[at + 2] === GT) {
              close = at;
              break;
            }
          }
          if (close >= 0) {
            this.cdataText(view.subarray(0, close), base);
            this.index = chunk.length - (view.length - (close + 3));
            this.mode = 'text';
            break;
          }
          let tail = 0;
          while (tail < 2 && tail < view.length && view[view.length - 1 - tail] === 0x5d) tail += 1;
          this.cdataText(view.subarray(0, view.length - tail), base);
          this.cdataHeld = Array.from(view.subarray(view.length - tail));
          this.index = chunk.length;
          break;
        }
        default:
          this.index = chunk.length;
      }
    }
    return undefined;
  }

  /** CDATA text at `start` in the file. */
  private cdataText(bytes: Uint8Array, start: number): void {
    if (bytes.length === 0) return;
    if (this.inRange() && this.keeping()) {
      // CDATA bytes are the text as written: a range over them reads them as they are.
      this.addRange(this.top()!, start, bytes.length);
      return;
    }
    this.keepText(bytes, true);
  }

  /**
   * Where a range element's raw text is: joined to the last range when it goes on from it, else a new range.
   * The text is not held, so it is not charged; each range kept is (XML_STREAM_RANGE_COST), so text cut into
   * many pieces (by comments, say) cannot grow a record's bookkeeping past its budget.
   */
  private addRange(open: Building, start: number, length: number): void {
    const ranges = open.element.ranges!;
    const last = ranges[ranges.length - 1];
    if (last && last.end === start) {
      last.end = start + length;
      return;
    }
    ranges.push({ start, end: start + length });
    this.count(XML_STREAM_RANGE_COST);
  }

  /** Markup skipped inside a record (a comment, a processing instruction) is charged to it as read. */
  private chargeSkipped(): void {
    this.count(this.offset - this.markupStart);
  }

  private countMarkupLength(): void {
    if (this.offset - this.markupStart > XML_STREAM_MAX_MARKUP_BYTES) this.fail('invalid_xml', 'Markup is too long.', this.markupStart);
  }

  /** A tag ended at the current byte (just past its `>`). */
  private tag(): XmlStreamEvent | undefined {
    const bytes = Uint8Array.from(this.markup.slice(0, -1));
    this.markup = [];
    this.mode = 'text';
    const tagStart = this.markupStart;
    const tagEnd = this.offset;
    const text = this.decoder.decode(bytes);
    if (text.startsWith('/')) {
      const name = text.slice(1).trim();
      const expected = this.stack[this.stack.length - 1];
      if (expected === undefined || name !== expected) this.fail('invalid_xml', 'An end tag does not close the open element.', tagStart);
      return this.close(tagEnd, tagEnd - tagStart);
    }
    if (text.startsWith('!')) this.fail('invalid_xml', 'Markup that is not XML.', tagStart);
    const parsed = parseXmlTag(text);
    if (!parsed) this.fail('invalid_xml', 'A tag that is not XML.', tagStart);
    if (this.stack.length === 0) {
      if (this.rootSeenName !== undefined) this.fail('invalid_xml', 'A second root element.', tagStart);
      this.rootSeenName = parsed.name;
    }
    this.stack.push(parsed.name);
    if (this.stack.length > XML_STREAM_MAX_DEPTH) this.fail('too_deep', 'Elements are nested too deeply.', tagStart);
    if (!this.inRecord()) {
      const path = this.matchRecord();
      if (path) {
        this.recordDepth = this.stack.length;
        this.recordPath = path;
        this.recordStart = tagStart;
        this.recordBytes = 0;
        this.discarding = false;
        this.building = [];
      }
    }
    if (this.keeping()) {
      this.flushText();
      const element: XmlElement = { name: parsed.name, attributes: parsed.attributes, children: [] };
      if (this.rangeNames.has(parsed.name)) element.ranges = [];
      const parent = this.top();
      if (parent) parent.element.children.push(element);
      this.building.push({ element, pending: [], pendingCdata: false });
      this.count(tagEnd - tagStart);
    }
    if (parsed.empty) return this.close(tagEnd, 0);
    return undefined;
  }

  /** The open element closed at `end`. */
  private close(end: number, tagBytes: number): XmlStreamEvent | undefined {
    if (this.keeping()) {
      this.flushText();
      this.count(tagBytes);
    }
    const depth = this.stack.length;
    this.stack.pop();
    if (!this.inRecord()) return undefined;
    if (this.discarding) {
      if (depth !== this.recordDepth) return undefined;
      this.recordDepth = -1;
      this.discarding = false;
      this.building = [];
      return { kind: 'oversize', path: this.recordPath, start: this.recordStart, end };
    }
    const done = this.building.pop();
    if (depth !== this.recordDepth || !done) return undefined;
    this.recordDepth = -1;
    this.building = [];
    return { kind: 'record', path: this.recordPath, element: done.element, start: this.recordStart, end };
  }
}

/** An element's text, its children's included, as one string. */
export function xmlText(element: XmlElement): string {
  return element.children.map((child) => (typeof child === 'string' ? child : xmlText(child))).join('');
}

/** The first child element of this name. */
export function xmlChild(element: XmlElement, name: string): XmlElement | undefined {
  for (const child of element.children) if (typeof child !== 'string' && child.name === name) return child;
  return undefined;
}

/** Every child element of this name, in order. */
export function xmlChildren(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement => typeof child !== 'string' && child.name === name);
}
