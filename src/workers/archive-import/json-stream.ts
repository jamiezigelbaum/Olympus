/**
 * Streaming reading of the items inside a large JSON file.
 *
 * A JSON export is one document, often hundreds of megabytes, whose bulk is
 * one or two long lists (a list of notes, a list of chat messages). This
 * reader walks the document as a stream of tokens and hands out one item at
 * a time from the lists a format names by path, never holding more than one
 * item (plus the chunk being read) in memory.
 *
 * - Items: the children of the containers at `itemPaths`. A path is the keys
 *   (and indexes) from the document's root to the container; `'*'` stands for
 *   any key or index at that level; `[]` is the root itself. The first path
 *   that matches a value claims it, whole.
 * - Frame: the plain values (text, numbers, true, false, null) that sit
 *   beside the way down to an item, in the objects around it and before it
 *   (the name of the chat a message is in). A value that comes after the item
 *   cannot be known when the item is handed out, and is not in its frame.
 *   Text longer than a thousand characters is left out of frames.
 * - Resuming: an item is handed out once the delimiter after it has been
 *   read, together with a resume point: that delimiter's byte offset and the
 *   open containers at that offset. A later pass opens a source at that
 *   offset and continues exactly there, with a new tokenizer, without reading
 *   what came before it.
 * - Bounds: an item longer than `maxItemBytes` is not built; it is handed out
 *   as `oversize` (the caller records a gap) and the reader moves on. A
 *   single piece of text longer than that is skipped in place, byte by byte,
 *   without ever being held. Nesting deeper than JSON_STREAM_MAX_DEPTH stops
 *   the read.
 * - Numbers: a whole number too large to be exact in a JavaScript number is
 *   handed out as its digits in text, so an identifier is never rounded.
 */
import Tokenizer from '@streamparser/json/tokenizer.js';
import TokenType from '@streamparser/json/utils/types/tokenType.js';
import type { ArchiveByteSource } from './byte-source.ts';

export type JsonPrimitive = string | number | boolean | null;
export type JsonPathSegment = string | number;
export type JsonFrame = Readonly<Record<string, JsonPrimitive>>;

/**
 * Stands for any key or index at its level in an item path.
 */
export const JSON_STREAM_ANY = '*';
export const JSON_STREAM_MAX_DEPTH = 512;
export const JSON_STREAM_MAX_KEY_CHARS = 1024;
export const JSON_STREAM_MAX_FRAME_VALUE_CHARS = 1024;
export const JSON_STREAM_MAX_FRAME_KEYS = 64;

export type JsonStreamErrorCode = 'invalid_json' | 'truncated' | 'empty' | 'resume_invalid' | 'too_deep';

export class JsonStreamError extends Error {
  readonly code: JsonStreamErrorCode;
  constructor(code: JsonStreamErrorCode, message: string) {
    super(message);
    this.name = 'JsonStreamError';
    this.code = code;
  }
}

/**
 * One open container on the way down to the item, outermost first in a resume point.
 */
export interface JsonResumeLevel {
  readonly kind: 'object' | 'array';
  /**
   * The key (object) or index (array) of the child that holds, or just held, the item.
   */
  readonly pointer: JsonPathSegment;
  readonly frame: JsonFrame;
}

/**
 * Where to continue: the delimiter after an item, and the containers open there.
 */
export interface JsonResumePoint {
  readonly offset: number;
  readonly levels: readonly JsonResumeLevel[];
}

export interface JsonStreamOptions {
  /**
   * The containers whose children are items.
   */
  itemPaths: readonly (readonly JsonPathSegment[])[];
  /**
   * An item longer than this many bytes is reported as `oversize`, not built.
   */
  maxItemBytes: number;
  /**
   * Continue after an item: the source must be positioned at `resume.offset`.
   */
  resume?: JsonResumePoint;
}

export interface JsonStreamEvent {
  /**
   * `oversize`: the item was longer than `maxItemBytes`; `value` is undefined.
   */
  kind: 'item' | 'oversize';
  /**
   * The keys and indexes from the root to the item.
   */
  path: readonly JsonPathSegment[];
  /**
   * Which of `itemPaths` claimed it.
   */
  pathIndex: number;
  value: unknown;
  frame: JsonFrame;
  /**
   * Byte offset of the item's first byte.
   */
  start: number;
  /**
   * Byte offset of the delimiter after the item (where `resume` continues).
   */
  end: number;
  resume: JsonResumePoint;
}

// A token the tokenizer never makes: text longer than the bound, skipped unread.
const OVERSIZE = -1;

type Phase = 'root' | 'done' | 'first' | 'next' | 'colon' | 'value' | 'after';
type Role = 'key' | 'colon' | 'value' | 'comma' | 'close';

interface Level {
  readonly kind: 'object' | 'array';
  readonly pointer: JsonPathSegment | undefined;
  readonly frame: JsonFrame;
}

interface BuildLevel {
  kind: 'object' | 'array';
  phase: Phase;
  key: string | undefined;
  value: unknown[] | Record<string, unknown>;
}

interface Capture {
  start: number;
  pathIndex: number;
  path: JsonPathSegment[];
  frame: JsonFrame;
  oversize: boolean;
  depth: number;
  build: BuildLevel[] | undefined;
  result: unknown;
}

const EMPTY_FRAME: JsonFrame = Object.freeze({});
const MAX_SAFE_DIGITS = String(Number.MAX_SAFE_INTEGER);

function isValueStart(type: number): boolean {
  return type === TokenType.LEFT_BRACE || type === TokenType.LEFT_BRACKET || type === TokenType.STRING
    || type === TokenType.NUMBER || type === TokenType.TRUE || type === TokenType.FALSE
    || type === TokenType.NULL || type === OVERSIZE;
}

function invalid(): JsonStreamError {
  return new JsonStreamError('invalid_json', 'This file is not valid JSON.');
}

/**
 * What a token is at this point of the grammar; anything the grammar does not allow throws.
 */
function classify(kind: 'object' | 'array' | 'root', phase: Phase, type: number): Role {
  if (kind === 'root') {
    if (phase === 'root' && isValueStart(type)) return 'value';
    throw invalid();
  }
  if (kind === 'object') {
    if (phase === 'first') {
      if (type === TokenType.STRING) return 'key';
      if (type === TokenType.RIGHT_BRACE) return 'close';
    } else if (phase === 'next') {
      if (type === TokenType.STRING) return 'key';
    } else if (phase === 'colon') {
      if (type === TokenType.COLON) return 'colon';
    } else if (phase === 'value') {
      if (isValueStart(type)) return 'value';
    } else if (phase === 'after') {
      if (type === TokenType.COMMA) return 'comma';
      if (type === TokenType.RIGHT_BRACE) return 'close';
    }
    throw invalid();
  }
  if (phase === 'first') {
    if (isValueStart(type)) return 'value';
    if (type === TokenType.RIGHT_BRACKET) return 'close';
  } else if (phase === 'next') {
    if (isValueStart(type)) return 'value';
  } else if (phase === 'after') {
    if (type === TokenType.COMMA) return 'comma';
    if (type === TokenType.RIGHT_BRACKET) return 'close';
  }
  throw invalid();
}

/**
 * Sets an own property, even one named like the prototype link.
 */
function setOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A tokenizer that keeps a whole number beyond the exact range of a JavaScript number as its digits.
 */
class ExactNumberTokenizer extends Tokenizer {
  protected override parseNumber(numberStr: string): number {
    const value = Number(numberStr);
    if (Number.isSafeInteger(value) || !Number.isFinite(value)) return value;
    const digits = numberStr.startsWith('-') ? numberStr.slice(1) : numberStr;
    let wholeNumber = digits.length > 0;
    for (let index = 0; index < digits.length; index += 1) {
      const code = digits.charCodeAt(index);
      if (code < 0x30 || code > 0x39) {
        wholeNumber = false;
        break;
      }
    }
    if (!wholeNumber) return value;
    // Only when it really is out of range (a long run of zeros is exact either way).
    if (digits.length < MAX_SAFE_DIGITS.length) return value;
    return numberStr as unknown as number;
  }
}

function copyFrame(frame: JsonFrame): Record<string, JsonPrimitive> {
  const out: Record<string, JsonPrimitive> = {};
  for (const key of Object.keys(frame)) setOwn(out, key, frame[key]);
  return out;
}

/**
 * A resume point as text, for a cursor.
 */
export function serializeJsonResume(point: JsonResumePoint): string {
  return JSON.stringify({
    o: point.offset,
    l: point.levels.map((level) => [level.kind === 'object' ? 'o' : 'a', level.pointer, level.frame]),
  });
}

/**
 * A resume point from `serializeJsonResume`'s text; undefined for anything that is not exactly one.
 */
export function parseJsonResume(text: string): JsonResumePoint | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { o, l } = raw as { o?: unknown; l?: unknown };
  if (typeof o !== 'number' || !Number.isSafeInteger(o) || o < 0) return undefined;
  if (!Array.isArray(l) || l.length === 0 || l.length > JSON_STREAM_MAX_DEPTH) return undefined;
  const levels: JsonResumeLevel[] = [];
  for (const entry of l as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 3) return undefined;
    const [code, pointer, frame] = entry as [unknown, unknown, unknown];
    if (code !== 'o' && code !== 'a') return undefined;
    if (code === 'a') {
      if (typeof pointer !== 'number' || !Number.isSafeInteger(pointer) || pointer < 0) return undefined;
    } else if (typeof pointer !== 'string' || pointer.length > JSON_STREAM_MAX_KEY_CHARS) {
      return undefined;
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return undefined;
    const keys = Object.keys(frame);
    if (keys.length > JSON_STREAM_MAX_FRAME_KEYS) return undefined;
    const clean: Record<string, JsonPrimitive> = {};
    for (const key of keys) {
      const value = (frame as Record<string, unknown>)[key];
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
      if (typeof value === 'string' && value.length > JSON_STREAM_MAX_FRAME_VALUE_CHARS) return undefined;
      setOwn(clean, key, value);
    }
    levels.push({ kind: code === 'o' ? 'object' : 'array', pointer: pointer as JsonPathSegment, frame: clean });
  }
  return { offset: o, levels };
}

/**
 * Hands out the items of a JSON stream one at a time.
 */
export class JsonStreamReader {
  private readonly source: ArchiveByteSource;
  private readonly itemPaths: readonly (readonly JsonPathSegment[])[];
  private readonly maxItemBytes: number;
  private readonly queue: JsonStreamEvent[] = [];
  private queueAt = 0;
  private levels: Level[] = [];
  private phase: Phase = 'root';
  private capture: Capture | undefined;
  private pending: Capture | undefined;
  private merged: JsonFrame | undefined;
  private tokenizer: Tokenizer | undefined;
  // Absolute offset of the first byte the current tokenizer was given.
  private base = 0;
  private fed = 0;
  private openToken: { type: number; start: number } | undefined;
  private backslashParity = 0;
  private skipping: { start: number; escaped: boolean } | undefined;
  private failure: JsonStreamError | undefined;
  private resuming: boolean;
  private started = false;
  private head: Uint8Array | undefined;
  private finished = false;

  constructor(source: ArchiveByteSource, options: JsonStreamOptions) {
    this.source = source;
    this.itemPaths = options.itemPaths;
    this.maxItemBytes = Math.max(1, options.maxItemBytes);
    this.resuming = options.resume !== undefined;
    if (options.resume) {
      const resume = options.resume;
      if (source.position !== resume.offset || resume.levels.length === 0 || resume.levels.length > JSON_STREAM_MAX_DEPTH) {
        throw new JsonStreamError('resume_invalid', 'No item ends where this import was to resume.');
      }
      this.levels = resume.levels.map((level) => ({ kind: level.kind, pointer: level.pointer, frame: level.frame }));
      this.phase = 'after';
      this.started = true;
    }
  }

  /**
   * How far into the stream the source has been read.
   */
  get position(): number {
    return this.source.position;
  }

  /**
   * The next item, or undefined once the document has ended. Throws `JsonStreamError` for a document that is not whole.
   */
  next(): JsonStreamEvent | undefined {
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.queueAt < this.queue.length) {
        const event = this.queue[this.queueAt]!;
        this.queueAt += 1;
        if (this.queueAt === this.queue.length) {
          this.queue.length = 0;
          this.queueAt = 0;
        }
        return event;
      }
      if (this.finished) return undefined;
      const chunk = this.source.next();
      if (chunk === undefined) {
        this.finish();
        this.finished = true;
        continue;
      }
      this.feed(chunk);
    }
  }

  // --- Bytes to tokens ----------------------------------------------------------

  private startTokenizer(base: number): Tokenizer {
    const tokenizer = new ExactNumberTokenizer({ emitPartialTokens: true });
    this.base = base;
    this.openToken = undefined;
    tokenizer.onToken = (info) => {
      if (this.failure) return;
      if (info.partial) {
        this.openToken = { type: info.token, start: this.base + info.offset };
        return;
      }
      this.openToken = undefined;
      try {
        this.handle(info.token, info.value, this.base + info.offset);
      } catch (error) {
        this.failure = error instanceof JsonStreamError ? error : invalid();
        throw this.failure;
      }
    };
    tokenizer.onError = () => {
      this.failure ??= this.resuming
        ? new JsonStreamError('resume_invalid', 'No item ends where this import was to resume.')
        : invalid();
    };
    this.tokenizer = tokenizer;
    return tokenizer;
  }

  private feed(chunk: Uint8Array): void {
    let data = chunk;
    let at = this.source.position - chunk.length;
    if (!this.started) {
      // A byte order mark ahead of the document is not part of it.
      const joined = this.head ? concat(this.head, data) : data;
      at -= this.head ? this.head.length : 0;
      if (joined.length < 3) {
        this.head = joined;
        return;
      }
      this.head = undefined;
      this.started = true;
      data = joined;
      if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
        data = data.subarray(3);
        at += 3;
      }
    }
    this.push(data, at);
  }

  /**
   * `data` begins at absolute offset `at`.
   */
  private push(input: Uint8Array, atStart: number): void {
    let data = input;
    let at = atStart;
    while (data.length > 0) {
      if (this.skipping) {
        const found = this.skipText(data);
        if (found < 0) return;
        const start = this.skipping.start;
        this.skipping = undefined;
        at += found + 1;
        data = data.subarray(found + 1);
        this.startTokenizer(at);
        this.fed = at;
        this.backslashParity = 0;
        this.deliver(OVERSIZE, undefined, start);
        continue;
      }
      let tokenizer = this.tokenizer;
      if (!tokenizer) {
        tokenizer = this.startTokenizer(at);
        this.backslashParity = 0;
      }
      this.fed = at + data.length;
      try {
        tokenizer.write(data);
      } catch (error) {
        throw this.failure ?? (error instanceof JsonStreamError ? error : invalid());
      }
      if (this.failure) throw this.failure;
      this.backslashParity = trailingBackslashParity(data, this.backslashParity);
      const open = this.openToken;
      if (open && this.fed - open.start > this.maxItemBytes) {
        if (open.type !== TokenType.STRING) throw invalid();
        // Text this long is never held: the tokenizer is dropped and the rest of the text read past.
        this.skipping = { start: open.start, escaped: this.backslashParity === 1 };
        this.tokenizer = undefined;
        this.openToken = undefined;
      }
      return;
    }
  }

  /**
   * Reads past the rest of a piece of text; the index of its closing quote in `data`, or -1 if it goes on.
   */
  private skipText(data: Uint8Array): number {
    const skipping = this.skipping!;
    let escaped = skipping.escaped;
    for (let index = 0; index < data.length; index += 1) {
      const byte = data[index]!;
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) return index;
    }
    skipping.escaped = escaped;
    return -1;
  }

  private finish(): void {
    if (this.head) {
      // Fewer than three bytes in all: a document still, such as an empty list.
      const head = this.head;
      this.head = undefined;
      this.started = true;
      this.push(head, 0);
    }
    if (this.skipping || this.openToken?.type === TokenType.STRING) {
      throw new JsonStreamError('truncated', 'This file ends inside a piece of text.');
    }
    if (this.tokenizer) {
      try {
        this.tokenizer.end();
      } catch (error) {
        throw this.failure ?? (error instanceof JsonStreamError ? error : invalid());
      }
      if (this.failure) throw this.failure;
    }
    if (this.capture || this.pending || this.levels.length > 0 || this.phase === 'first' || this.phase === 'next'
      || this.phase === 'colon' || this.phase === 'value') {
      throw new JsonStreamError('truncated', 'This file ends before its last item does.');
    }
    if (this.phase === 'root') throw new JsonStreamError('empty', 'This file holds no JSON.');
  }

  // --- Tokens to items ----------------------------------------------------------

  /**
   * A token the tokenizer did not make (the skipped text), through the same path as the others.
   */
  private deliver(type: number, value: unknown, start: number): void {
    try {
      this.handle(type, value, start);
    } catch (error) {
      this.failure = error instanceof JsonStreamError ? error : invalid();
      throw this.failure;
    }
  }

  private handle(type: number, value: unknown, start: number): void {
    if (this.resuming) {
      this.resuming = false;
      const top = this.levels[this.levels.length - 1]!;
      const fits = type === TokenType.COMMA || (top.kind === 'object' ? type === TokenType.RIGHT_BRACE : type === TokenType.RIGHT_BRACKET);
      if (!fits) throw new JsonStreamError('resume_invalid', 'No item ends where this import was to resume.');
    }
    if (this.capture) {
      this.captureToken(this.capture, type, value, start);
      return;
    }
    const top = this.levels[this.levels.length - 1];
    const role = classify(top ? top.kind : 'root', this.phase, type);
    switch (role) {
      case 'key': {
        const key = value as string;
        if (key.length > JSON_STREAM_MAX_KEY_CHARS) throw invalid();
        this.levels[this.levels.length - 1] = { kind: 'object', pointer: key, frame: top!.frame };
        this.phase = 'colon';
        return;
      }
      case 'colon':
        this.phase = 'value';
        return;
      case 'comma':
        this.flush(start);
        this.phase = 'next';
        return;
      case 'close':
        this.flush(start);
        this.levels.pop();
        this.merged = undefined;
        this.phase = this.levels.length === 0 ? 'done' : 'after';
        return;
      case 'value':
        this.beginValue(type, value, start);
        return;
    }
  }

  private beginValue(type: number, value: unknown, start: number): void {
    let top = this.levels[this.levels.length - 1];
    if (top && top.kind === 'array') {
      top = { kind: 'array', pointer: typeof top.pointer === 'number' ? top.pointer + 1 : 0, frame: top.frame };
      this.levels[this.levels.length - 1] = top;
    }
    if (top) {
      const index = this.matchingPath();
      if (index >= 0) {
        const path = this.levels.map((level) => level.pointer as JsonPathSegment);
        const capture: Capture = {
          start,
          pathIndex: index,
          path,
          frame: this.mergedFrame(),
          oversize: false,
          depth: 0,
          build: [],
          result: undefined,
        };
        this.capture = capture;
        this.captureToken(capture, type, value, start);
        return;
      }
    }
    if (type === TokenType.LEFT_BRACE || type === TokenType.LEFT_BRACKET) {
      if (this.levels.length >= JSON_STREAM_MAX_DEPTH) throw new JsonStreamError('too_deep', 'This file nests deeper than Olympus reads.');
      this.levels.push({
        kind: type === TokenType.LEFT_BRACE ? 'object' : 'array',
        pointer: undefined,
        frame: EMPTY_FRAME,
      });
      this.merged = undefined;
      this.phase = 'first';
      return;
    }
    if (top && top.kind === 'object' && type !== OVERSIZE) this.recordFrame(top, value as JsonPrimitive);
    this.phase = top ? 'after' : 'done';
  }

  private recordFrame(top: Level, value: JsonPrimitive): void {
    if (typeof value === 'string' && value.length > JSON_STREAM_MAX_FRAME_VALUE_CHARS) return;
    const key = top.pointer as string;
    if (!Object.prototype.hasOwnProperty.call(top.frame, key) && Object.keys(top.frame).length >= JSON_STREAM_MAX_FRAME_KEYS) return;
    const frame: Record<string, JsonPrimitive> = copyFrame(top.frame);
    setOwn(frame, key, value);
    this.levels[this.levels.length - 1] = { kind: 'object', pointer: top.pointer, frame };
    this.merged = undefined;
  }

  /**
   * Which item path the value being read belongs to (-1: none). The value's container is every open level but the last.
   */
  private matchingPath(): number {
    const depth = this.levels.length - 1;
    for (let index = 0; index < this.itemPaths.length; index += 1) {
      const path = this.itemPaths[index]!;
      if (path.length !== depth) continue;
      let all = true;
      for (let at = 0; at < depth; at += 1) {
        const wanted = path[at]!;
        if (wanted !== JSON_STREAM_ANY && wanted !== this.levels[at]!.pointer) {
          all = false;
          break;
        }
      }
      if (all) return index;
    }
    return -1;
  }

  private mergedFrame(): JsonFrame {
    if (this.merged) return this.merged;
    const out: Record<string, JsonPrimitive> = {};
    for (const level of this.levels) {
      for (const key of Object.keys(level.frame)) setOwn(out, key, level.frame[key]);
    }
    this.merged = Object.keys(out).length === 0 ? EMPTY_FRAME : out;
    return this.merged;
  }

  private captureToken(capture: Capture, type: number, value: unknown, start: number): void {
    if (!capture.oversize && (type === OVERSIZE || start - capture.start > this.maxItemBytes)) {
      capture.oversize = true;
      capture.build = undefined;
    }
    if (type === TokenType.LEFT_BRACE || type === TokenType.LEFT_BRACKET) {
      capture.depth += 1;
      if (capture.depth > JSON_STREAM_MAX_DEPTH) throw new JsonStreamError('too_deep', 'This file nests deeper than Olympus reads.');
    } else if (type === TokenType.RIGHT_BRACE || type === TokenType.RIGHT_BRACKET) {
      capture.depth -= 1;
      if (capture.depth < 0) throw invalid();
    }
    if (capture.build) this.build(capture, capture.build, type, value);
    if (capture.depth === 0) {
      this.capture = undefined;
      this.pending = capture;
      this.phase = 'after';
    }
  }

  private build(capture: Capture, stack: BuildLevel[], type: number, value: unknown): void {
    const top = stack[stack.length - 1];
    const role = classify(top ? top.kind : 'root', top ? top.phase : 'root', type);
    const place = (placed: unknown): void => {
      const parent = stack[stack.length - 1];
      if (!parent) {
        capture.result = placed;
        return;
      }
      if (parent.kind === 'array') (parent.value as unknown[]).push(placed);
      else setOwn(parent.value, parent.key!, placed);
      parent.phase = 'after';
    };
    switch (role) {
      case 'key': {
        const key = value as string;
        if (key.length > JSON_STREAM_MAX_KEY_CHARS) throw invalid();
        top!.key = key;
        top!.phase = 'colon';
        return;
      }
      case 'colon':
        top!.phase = 'value';
        return;
      case 'comma':
        top!.phase = 'next';
        return;
      case 'close': {
        const closed = stack.pop()!;
        place(closed.value);
        return;
      }
      case 'value':
        if (type === TokenType.LEFT_BRACE || type === TokenType.LEFT_BRACKET) {
          stack.push({
            kind: type === TokenType.LEFT_BRACE ? 'object' : 'array',
            phase: 'first',
            key: undefined,
            value: type === TokenType.LEFT_BRACE ? {} : [],
          });
        } else {
          place(value);
        }
        return;
    }
  }

  /**
   * The delimiter after an item has been read: the item is whole, and the resume point is here.
   */
  private flush(delimiterAt: number): void {
    const capture = this.pending;
    if (!capture) return;
    this.pending = undefined;
    const oversize = capture.oversize || delimiterAt - capture.start > this.maxItemBytes;
    this.queue.push({
      kind: oversize ? 'oversize' : 'item',
      path: capture.path,
      pathIndex: capture.pathIndex,
      value: oversize ? undefined : capture.result,
      frame: capture.frame,
      start: capture.start,
      end: delimiterAt,
      resume: { offset: delimiterAt, levels: this.levels.slice() as JsonResumeLevel[] },
    });
  }
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length);
  out.set(first);
  out.set(second, first.length);
  return out;
}

/**
 * Whether the bytes so far end in an unfinished backslash escape: 1 if so, else 0.
 */
function trailingBackslashParity(data: Uint8Array, carried: number): number {
  let index = data.length;
  while (index > 0 && data[index - 1] === 0x5c) index -= 1;
  const run = data.length - index;
  return index === 0 ? (carried + run) % 2 : run % 2;
}
