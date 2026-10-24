import { describe, expect, test } from 'bun:test';
import Tokenizer from '@streamparser/json/tokenizer.js';
import { ArchiveImportStoppedError } from '../src/core/archive-formats.ts';
import { ScopeSafeError } from '../src/core/scope-safe-fs.ts';
import { fileByteSource, type ArchiveByteSource } from '../src/workers/archive-import/byte-source.ts';
import {
  JSON_STREAM_FEED_SLICE_BYTES,
  JSON_STREAM_MAX_DEPTH,
  JSON_STREAM_MAX_QUEUED_EVENTS,
  JsonStreamError,
  JsonStreamReader,
  archiveStopFromReaderError,
  parseJsonResume,
  serializeJsonResume,
  type JsonResumePoint,
  type JsonStreamEvent,
  type JsonStreamOptions,
} from '../src/workers/archive-import/json-stream.ts';
import { buildZip, memoryRangeReader } from './helpers/zip-fixture.ts';
import { ZipArchive, ZipMemberReader } from '../src/workers/archive-import/zip-reader.ts';

const encoder = new TextEncoder();

function readAll(
  input: string | Uint8Array,
  options: Omit<JsonStreamOptions, 'maxItemBytes'> & { maxItemBytes?: number },
  chunkBytes = 1024 * 1024,
): JsonStreamEvent[] {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  const start = options.resume?.offset ?? 0;
  const source = fileByteSource(memoryRangeReader(bytes), { chunkBytes, start });
  const reader = new JsonStreamReader(source, { maxItemBytes: 1024 * 1024, ...options });
  const events: JsonStreamEvent[] = [];
  for (let event = reader.next(); event; event = reader.next()) events.push(event);
  return events;
}

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof JsonStreamError) return error.code;
    throw error;
  }
  return 'no error';
}

/** A source that hands out exactly the chunks given, so a test can end each one where it likes. */
function chunkedSource(chunks: readonly Uint8Array[]): ArchiveByteSource {
  let index = 0;
  let position = 0;
  return {
    get position() {
      return position;
    },
    next(): Uint8Array | undefined {
      const chunk = chunks[index];
      if (!chunk) return undefined;
      index += 1;
      position += chunk.length;
      return chunk;
    },
    unread(): void {
      throw new Error('not used');
    },
  };
}

/** Runs `run` while counting the bytes handed to the tokenizer. */
function countingTokenizerBytes<T>(run: () => T): { result: T; bytes: number } {
  const original = Tokenizer.prototype.write;
  let bytes = 0;
  Tokenizer.prototype.write = function patched(this: Tokenizer, input: Parameters<Tokenizer['write']>[0]): void {
    bytes += (input as Uint8Array).length;
    return original.call(this, input);
  };
  try {
    return { result: run(), bytes };
  } finally {
    Tokenizer.prototype.write = original;
  }
}

function drainReader(reader: JsonStreamReader): JsonStreamEvent[] {
  const events: JsonStreamEvent[] = [];
  for (let event = reader.next(); event; event = reader.next()) events.push(event);
  return events;
}

const CHAT = JSON.stringify({
  name: 'Team chat',
  kind: 'group',
  id: 4242,
  members: ['ann', 'bo'],
  messages: [
    { id: 1, from: 'ann', text: 'hello there', tags: [1, 2.5, -3e2, true, null] },
    { id: 2, from: 'bo', text: 'a "quoted" word, a back\\slash, é, 😀', nested: { deep: { deeper: [[], {}] } } },
    { id: 3, from: 'ann', text: '' },
    'a bare string item',
    7,
    null,
  ],
  trailer: 'after the messages',
});

describe('json stream items', () => {
  test('hands out the children of a named list, equal to what JSON.parse makes, whatever the chunking', () => {
    const expected = (JSON.parse(CHAT) as { messages: unknown[] }).messages;
    for (const chunk of [1, 2, 3, 5, 17, 64, 1000, 1 << 20]) {
      const events = readAll(CHAT, { itemPaths: [['messages']] }, chunk);
      expect(events.map((event) => event.value)).toEqual(expected);
      expect(events.map((event) => event.path)).toEqual(expected.map((_, index) => ['messages', index]));
      expect(events.every((event) => event.kind === 'item' && event.pathIndex === 0)).toBe(true);
    }
  });

  test('the frame holds the plain values around the way down, before the item', () => {
    const [first] = readAll(CHAT, { itemPaths: [['messages']] });
    expect(first!.frame).toEqual({ name: 'Team chat', kind: 'group', id: 4242 });
    // `members` is a list and `trailer` comes after the messages: neither is in a frame.
    expect(Object.keys(first!.frame)).not.toContain('members');
    expect(Object.keys(first!.frame)).not.toContain('trailer');
  });

  test('item offsets are byte offsets of the item and of the delimiter after it', () => {
    const text = '{"k":"é","list":[ {"a":1} , 22,"x" ]}';
    const bytes = encoder.encode(text);
    const events = readAll(bytes, { itemPaths: [['list']] }, 3);
    expect(events.map((event) => [event.start, event.end])).toEqual(events.map((event) => [event.start, event.end]));
    for (const event of events) {
      expect(bytes[event.end]).toBeDefined();
      expect([0x2c, 0x5d]).toContain(bytes[event.end]!);
      expect(JSON.parse(new TextDecoder().decode(bytes.subarray(event.start, event.end)))).toEqual(event.value);
    }
  });

  test('wildcards and several item paths, with the path that claimed each item', () => {
    const doc = JSON.stringify({
      chats: [
        { name: 'one', messages: [{ n: 1 }, { n: 2 }] },
        { name: 'two', messages: [{ n: 3 }] },
      ],
      notes: { first: { t: 'a' }, second: { t: 'b' } },
    });
    const events = readAll(doc, { itemPaths: [['chats', '*', 'messages'], ['notes']] }, 5);
    expect(events.map((event) => [event.pathIndex, event.path, event.value, event.frame])).toEqual([
      [0, ['chats', 0, 'messages', 0], { n: 1 }, { name: 'one' }],
      [0, ['chats', 0, 'messages', 1], { n: 2 }, { name: 'one' }],
      [0, ['chats', 1, 'messages', 0], { n: 3 }, { name: 'two' }],
      [1, ['notes', 'first'], { t: 'a' }, {}],
      [1, ['notes', 'second'], { t: 'b' }, {}],
    ]);
  });

  test('the root list itself, and a document that is only an empty list', () => {
    expect(readAll('[ {"a":1}, 2, [3] ]', { itemPaths: [[]] }).map((event) => event.value)).toEqual([{ a: 1 }, 2, [3]]);
    expect(readAll('[]', { itemPaths: [[]] })).toEqual([]);
    expect(readAll('  [ ]  ', { itemPaths: [[]] }, 1)).toEqual([]);
    expect(readAll('{"messages":[]}', { itemPaths: [['messages']] })).toEqual([]);
  });

  test('a byte order mark is not part of the document', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('[1,2]')]);
    for (const chunk of [1, 2, 3, 100]) {
      const events = readAll(bytes, { itemPaths: [[]] }, chunk);
      expect(events.map((event) => event.value)).toEqual([1, 2]);
      expect(events.map((event) => event.start)).toEqual([4, 6]);
    }
  });

  test('whole numbers beyond the exact range keep their digits; keys named like the prototype stay data', () => {
    const doc = '{"list":[{"id":12345678901234567890,"small":9007199254740991,"neg":-9007199254740993,"f":1.5,"__proto__":{"x":1}}]}';
    const [event] = readAll(doc, { itemPaths: [['list']] });
    const value = event!.value as Record<string, unknown>;
    expect(value.id).toBe('12345678901234567890');
    expect(value.small).toBe(9007199254740991);
    expect(value.neg).toBe('-9007199254740993');
    expect(value.f).toBe(1.5);
    expect(Object.keys(value)).toContain('__proto__');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test('many items in a long document come out in order', () => {
    const items: unknown[] = [];
    for (let index = 0; index < 60_000; index += 1) items.push({ i: index, t: `item ${index}` });
    const events = readAll(JSON.stringify({ list: items }), { itemPaths: [['list']] }, 4096);
    expect(events.length).toBe(60_000);
    expect(events[59_999]!.value).toEqual({ i: 59_999, t: 'item 59999' });
    expect(events[59_999]!.path).toEqual(['list', 59_999]);
  });
});

describe('json stream resuming', () => {
  test('continuing from any item boundary gives exactly the rest, with the same paths and frames', () => {
    const options = { itemPaths: [['messages']] };
    const full = readAll(CHAT, options);
    expect(full.length).toBe(6);
    for (const chunk of [1, 4, 33, 1 << 20]) {
      for (let k = 0; k < full.length; k += 1) {
        const rest = readAll(CHAT, { ...options, resume: full[k]!.resume }, chunk);
        expect(rest.map((event) => [event.path, event.value, event.frame, event.start, event.end]))
          .toEqual(full.slice(k + 1).map((event) => [event.path, event.value, event.frame, event.start, event.end]));
      }
    }
  });

  test('a resume point survives the trip through a cursor string', () => {
    const full = readAll(CHAT, { itemPaths: [['messages']] });
    for (const event of full) {
      const text = serializeJsonResume(event.resume);
      expect(parseJsonResume(text)).toEqual(event.resume);
    }
    const wildcards = readAll(JSON.stringify({ a: { k: 'v', list: [1, 2] } }), { itemPaths: [['a', 'list']] });
    const point = parseJsonResume(serializeJsonResume(wildcards[0]!.resume))!;
    const rest = readAll(JSON.stringify({ a: { k: 'v', list: [1, 2] } }), { itemPaths: [['a', 'list']], resume: point });
    expect(rest.map((event) => [event.value, event.frame])).toEqual([[2, { k: 'v' }]]);
  });

  test('text that is not a resume point is not one', () => {
    const good = readAll(CHAT, { itemPaths: [['messages']] })[0]!.resume;
    const text = serializeJsonResume(good);
    expect(parseJsonResume(text)).toBeDefined();
    for (const bad of ['', 'x', '[]', '{}', '{"o":-1,"l":[]}', '{"o":5,"l":[]}', '{"o":5,"l":[["x",1,{}]]}',
      '{"o":5,"l":[["a","one",{}]]}', '{"o":5,"l":[["o",1,{}]]}', '{"o":5,"l":[["a",1,{"k":{"nested":1}}]]}',
      '{"o":1.5,"l":[["a",1,{}]]}', `{"o":5,"l":[["a",1,{"k":"${'x'.repeat(2000)}"}]]}`]) {
      expect(parseJsonResume(bad)).toBeUndefined();
    }
  });

  test('an offset that is not an item boundary, or a source elsewhere, stops the read', () => {
    const full = readAll(CHAT, { itemPaths: [['messages']] });
    const point = full[1]!.resume;
    const bad: JsonResumePoint = { ...point, offset: point.offset + 1 };
    expect(code(() => readAll(CHAT, { itemPaths: [['messages']], resume: bad }))).toBe('resume_invalid');
    const middleOfText: JsonResumePoint = { ...point, offset: full[0]!.start + 3 };
    expect(code(() => readAll(CHAT, { itemPaths: [['messages']], resume: middleOfText }))).toBe('resume_invalid');
    const source = fileByteSource(memoryRangeReader(encoder.encode(CHAT)), { start: 0 });
    expect(code(() => new JsonStreamReader(source, { itemPaths: [['messages']], maxItemBytes: 1000, resume: point }))).toBe('resume_invalid');
  });
});

describe('json stream bounds', () => {
  test('an item longer than the bound is reported, not built, and the read goes on', () => {
    const doc = JSON.stringify({ list: [{ t: 'small' }, { t: 'x'.repeat(5000) }, { t: 'also small' }, { a: ['y'.repeat(300), 'y'.repeat(300), 'y'.repeat(300), 'y'.repeat(300)] }, 5] });
    for (const chunk of [7, 100, 1 << 20]) {
      const events = readAll(doc, { itemPaths: [['list']], maxItemBytes: 1000 }, chunk);
      expect(events.map((event) => event.kind)).toEqual(['item', 'oversize', 'item', 'oversize', 'item']);
      expect(events.map((event) => event.value)).toEqual([{ t: 'small' }, undefined, { t: 'also small' }, undefined, 5]);
      expect(events[1]!.path).toEqual(['list', 1]);
      // The resume point after an oversize item continues like any other.
      const rest = readAll(doc, { itemPaths: [['list']], maxItemBytes: 1000, resume: events[1]!.resume }, chunk);
      expect(rest.map((event) => event.kind)).toEqual(['item', 'oversize', 'item']);
    }
  });

  test('one huge piece of text is skipped without being held, whatever escapes it holds', () => {
    const big = `${'a'.repeat(200_000)}\\"${'b'.repeat(50)}\\\\${'c'.repeat(200_000)}\\\\\\"tail`;
    const doc = `{"title":"kept","blob":"${big}","list":[{"n":1},{"n":2,"image":"${big}"},{"n":3}],"after":"x"}`;
    for (const chunk of [1000, 4096, 65_537, 1 << 20]) {
      const events = readAll(doc, { itemPaths: [['list']], maxItemBytes: 100_000 }, chunk);
      expect(events.map((event) => [event.kind, event.path])).toEqual([
        ['item', ['list', 0]],
        ['oversize', ['list', 1]],
        ['item', ['list', 2]],
      ]);
      expect(events[0]!.frame).toEqual({ title: 'kept' });
      expect(events[2]!.value).toEqual({ n: 3 });
    }
  });

  test('a text far larger than the bound never sits in memory (resident size)', () => {
    const blobBytes = 256 * 1024 * 1024;
    const head = encoder.encode('{"title":"kept","blob":"');
    const tail = encoder.encode('","list":[1,2]}');
    const piece = new Uint8Array(1024 * 1024).fill(0x61);
    let sent = 0;
    let stage = 0;
    let peak = 0;
    Bun.gc(true);
    const baseline = process.memoryUsage().rss;
    let position = 0;
    let last: Uint8Array = new Uint8Array(0);
    const source = {
      get position() { return position; },
      next(): Uint8Array | undefined {
        peak = Math.max(peak, process.memoryUsage().rss);
        let chunk: Uint8Array | undefined;
        if (stage === 0) { chunk = head; stage = 1; }
        else if (stage === 1) {
          chunk = piece;
          sent += piece.length;
          if (sent >= blobBytes) stage = 2;
        } else if (stage === 2) { chunk = tail; stage = 3; }
        if (!chunk) return undefined;
        last = chunk;
        position += chunk.length;
        return last;
      },
      unread(): void { throw new Error('not used'); },
    };
    const reader = new JsonStreamReader(source, { itemPaths: [['list']], maxItemBytes: 64 * 1024 });
    const values: unknown[] = [];
    for (let event = reader.next(); event; event = reader.next()) values.push(event.value);
    expect(values).toEqual([1, 2]);
    // Held whole it would add the size of the text (measured: about 114 MB for 96 MiB), here 256 MiB; what the
    // engine itself adds while it warms up (measured: up to about 55 MB) does not grow with the text.
    expect(peak - baseline).toBeLessThan(100 * 1024 * 1024);
  });

  test('a backslash that falls on the end of a chunk does not end the skipped text early', () => {
    // Try every position of a chunk boundary around an escaped quote inside text that is being skipped.
    const text = `${'z'.repeat(300)}\\\\\\"${'z'.repeat(300)}`;
    const doc = `{"skip":"${text}","list":[1,2]}`;
    const bytes = encoder.encode(doc);
    for (let size = 280; size < 320; size += 1) {
      const events = readAll(bytes, { itemPaths: [['list']], maxItemBytes: 100 }, size);
      expect(events.map((event) => event.value)).toEqual([1, 2]);
    }
  });

  test('nesting beyond the bound stops the read', () => {
    const deep = `${'['.repeat(JSON_STREAM_MAX_DEPTH + 5)}${']'.repeat(JSON_STREAM_MAX_DEPTH + 5)}`;
    expect(code(() => readAll(`{"list":[${deep}]}`, { itemPaths: [['list']] }))).toBe('too_deep');
    expect(code(() => readAll(deep, { itemPaths: [['nothing']] }))).toBe('too_deep');
  });
});

describe('json stream bounds hold whatever the chunks', () => {
  const max = 10_000;

  // A text far over the bound whose every chunk ends inside an escape, a \u escape or a multi-byte character.
  const endings: Array<{ name: string; body: Uint8Array; tail: Uint8Array; end: Uint8Array }> = [
    { name: 'right after a backslash', body: encoder.encode('n' + 'a'.repeat(1000)), tail: encoder.encode('n'), end: encoder.encode('\\') },
    { name: 'inside a \\u escape', body: encoder.encode('00e9' + 'a'.repeat(1000)), tail: encoder.encode('e9'), end: encoder.encode('\\u00') },
    { name: 'inside a multi-byte character', body: Uint8Array.of(0xa9, ...encoder.encode('a'.repeat(1000))), tail: Uint8Array.of(0xa9), end: Uint8Array.of(0xc3) },
  ];

  for (const ending of endings) {
    test(`a huge text whose every chunk ends ${ending.name} is not held, and the items after it still come out`, () => {
      const chunks: Uint8Array[] = [];
      const first = new Uint8Array([...encoder.encode('{"blob":"'), ...encoder.encode('a'.repeat(1000)), ...ending.end]);
      chunks.push(first);
      for (let index = 0; index < 2500; index += 1) chunks.push(new Uint8Array([...ending.body, ...ending.end]));
      chunks.push(new Uint8Array([...ending.tail, ...encoder.encode('","list":[1,2]}')]));
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      expect(total).toBeGreaterThan(2_000_000);
      const { result, bytes } = countingTokenizerBytes(() => drainReader(new JsonStreamReader(chunkedSource(chunks), { itemPaths: [['list']], maxItemBytes: max })));
      expect(result.map((event) => event.value)).toEqual([1, 2]);
      // Only the document around the text and the first `max` bytes of the text ever reach the tokenizer.
      expect(bytes).toBeLessThan(max + 1024);
    });
  }

  test('where a text ends being allowed does not depend on the chunking', () => {
    for (const [length, kind] of [[100, 'item'], [101, 'oversize']] as const) {
      // A text of `length` bytes counting both quotes, as a list item of its own.
      const doc = `{"list":["${'x'.repeat(length - 2)}",1]}`;
      for (const chunk of [1, 2, 7, 100, 1 << 20]) {
        const events = readAll(doc, { itemPaths: [['list']], maxItemBytes: 100 }, chunk);
        expect(events.map((event) => event.kind)).toEqual([kind, 'item']);
        expect(events[1]!.value).toBe(1);
      }
    }
  });

  test('a number or word longer than the bound is damage, whatever the chunking', () => {
    for (const chunk of [1, 9, 1 << 20]) {
      expect(code(() => readAll(`{"list":[${'1'.repeat(300)}]}`, { itemPaths: [['list']], maxItemBytes: 100 }, chunk))).toBe('invalid_json');
      expect(readAll(`{"list":[${'1'.repeat(90)}]}`, { itemPaths: [['list']], maxItemBytes: 100 }, chunk).length).toBe(1);
    }
  });
});

describe('json stream feeds in bounded slices', () => {
  const bound = JSON_STREAM_MAX_QUEUED_EVENTS + JSON_STREAM_FEED_SLICE_BYTES / 2;

  test('a whole chunk of tiny items never has more than a fixed number of finished items waiting', () => {
    const count = 300_000;
    const doc = encoder.encode(`{"list":[${'1,'.repeat(count)}1]}`);
    const reader = new JsonStreamReader(chunkedSource([doc]), { itemPaths: [['list']], maxItemBytes: 1000 });
    const events = drainReader(reader);
    expect(events.length).toBe(count + 1);
    expect(events[count]!.path).toEqual(['list', count]);
    expect(reader.peakQueuedEvents).toBeGreaterThan(0);
    expect(reader.peakQueuedEvents).toBeLessThanOrEqual(bound);
  });

  test('one very large chunk is not turned into events before the first item is taken', () => {
    const doc = new Uint8Array(16 * 1024 * 1024);
    const head = encoder.encode('{"list":[');
    doc.set(head);
    for (let index = head.length; index < doc.length - 4; index += 2) {
      doc[index] = 0x30;
      doc[index + 1] = 0x2c;
    }
    const reader = new JsonStreamReader(chunkedSource([doc]), { itemPaths: [['list']], maxItemBytes: 1000 });
    const started = performance.now();
    expect(reader.next()?.value).toBe(0);
    expect(reader.next()?.value).toBe(0);
    expect(reader.peakQueuedEvents).toBeLessThanOrEqual(bound);
    // Only the slices needed to finish a few items were read, not the 16 MiB.
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('json stream keeps checking what it discards', () => {
  const long = 'q'.repeat(400);

  test('a syntax error after an oversize field of an item still stops the read', () => {
    const bad = [
      `{"list":[{"a":"${long}","b" 123}]}`,
      `{"list":[{"a":"${long}","c":[1,2}]}`,
      `{"list":[{"a":"${long}","c":{"x":1],"d":2}]}`,
      `{"list":[{"a":"${long}" "b":1}]}`,
      `{"list":[{"a":"${long}",,"b":1}]}`,
      `{"list":[{"a":"${long}","b":}]}`,
      `{"list":[{"a":[1,${long.length}${'0'.repeat(500)},,2]}]}`,
      `{"list":[{"a":"${long}"}}]}`,
    ];
    for (const doc of bad) {
      for (const chunk of [3, 50, 1 << 20]) {
        expect(code(() => readAll(doc, { itemPaths: [['list']], maxItemBytes: 100 }, chunk))).toBe('invalid_json');
      }
    }
    // Well-formed damage-free discarding still gives an oversize item and goes on.
    const good = `{"list":[{"a":"${long}","c":[1,{"x":[]}],"d":{"e":null}},{"n":2}]}`;
    expect(readAll(good, { itemPaths: [['list']], maxItemBytes: 100 }, 5).map((event) => event.kind)).toEqual(['oversize', 'item']);
  });

  test('a skipped text is checked for escapes, control characters and UTF-8', () => {
    const wrap = (inside: Uint8Array): Uint8Array => new Uint8Array([
      ...encoder.encode(`{"skip":"${'z'.repeat(300)}`), ...inside, ...encoder.encode('z","list":[1,2]}'),
    ]);
    const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
    const bad: Array<[string, Uint8Array]> = [
      ['an escape that does not exist', encoder.encode('\\x')],
      ['a short \\u escape', encoder.encode('\\u12g4')],
      ['a raw line break', bytes(0x0a)],
      ['a raw control character', bytes(0x01)],
      ['a byte that can never be UTF-8', bytes(0xff)],
      ['a continuation byte alone', bytes(0x80)],
      ['an overlong character', bytes(0xc0, 0x80)],
      ['a surrogate in UTF-8', bytes(0xed, 0xa0, 0x80)],
      ['a character cut short by the closing quote', bytes(0xe2, 0x82)],
      ['a character past the last code point', bytes(0xf4, 0x90, 0x80, 0x80)],
    ];
    for (const [name, inside] of bad) {
      for (const chunk of [1, 4, 64, 1 << 20]) {
        expect([name, code(() => readAll(wrap(inside), { itemPaths: [['list']], maxItemBytes: 100 }, chunk))]).toEqual([name, 'invalid_json']);
      }
    }
    const good: Array<[string, Uint8Array]> = [
      ['every escape', encoder.encode('\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\uD83D\\uDE00')],
      ['two, three and four byte characters', encoder.encode('é€😀')],
      ['the edges of the ranges', bytes(0xe0, 0xa0, 0x80, 0xed, 0x9f, 0xbf, 0xf0, 0x90, 0x80, 0x80, 0xf4, 0x8f, 0xbf, 0xbf)],
    ];
    for (const [name, inside] of good) {
      for (const chunk of [1, 2, 3, 5, 64, 1 << 20]) {
        const events = readAll(wrap(inside), { itemPaths: [['list']], maxItemBytes: 100 }, chunk);
        expect([name, events.map((event) => event.value)]).toEqual([name, [1, 2]]);
      }
    }
  });
});

describe('json stream checks the start of a text it later drops', () => {
  const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
  // A text of 400 bytes in a 100 byte bound: the bytes `inside` come early, well before the bound is reached.
  const early = (inside: Uint8Array): Uint8Array => new Uint8Array([
    ...encoder.encode(`{"skip":"${'z'.repeat(6)}`), ...inside, ...encoder.encode(`${'z'.repeat(400)}","list":[1,2]}`),
  ]);

  test('damage in the first bytes of a text longer than allowed is invalid JSON, however the input is chunked', () => {
    const bad: Array<[string, Uint8Array]> = [
      ['an escape that does not exist', encoder.encode('\\q')],
      ['a short \\u escape', encoder.encode('\\u12g4')],
      ['a raw line break', bytes(0x0a)],
      ['a raw control character', bytes(0x01)],
      ['a byte that can never be UTF-8', bytes(0xff)],
      ['a continuation byte alone', bytes(0x80)],
      ['an overlong character', bytes(0xc0, 0x80)],
      ['a surrogate in UTF-8', bytes(0xed, 0xa0, 0x80)],
      ['a character cut short by an ordinary byte', bytes(0xe2, 0x82, 0x41)],
      ['a character past the last code point', bytes(0xf4, 0x90, 0x80, 0x80)],
    ];
    for (const [name, inside] of bad) {
      for (const chunk of [1, 3, 64, 1 << 20]) {
        expect([name, chunk, code(() => readAll(early(inside), { itemPaths: [['list']], maxItemBytes: 100 }, chunk))]).toEqual([name, chunk, 'invalid_json']);
      }
    }
  });

  test('the case in the 200 byte text: one chunk and byte by byte both refuse it', () => {
    const doc = `["aa\\q${'a'.repeat(200)}",1]`;
    for (const chunk of [1, 1 << 20]) {
      expect([chunk, code(() => readAll(doc, { itemPaths: [[]], maxItemBytes: 100 }, chunk))]).toEqual([chunk, 'invalid_json']);
    }
  });

  test('a text that begins in an earlier slice is checked in the later slice too (a raw line break between two long runs)', () => {
    const doc = `["${'a'.repeat(1200)}\n${'a'.repeat(1200)}",1]`;
    for (const chunk of [1, 1 << 20]) {
      expect([chunk, code(() => readAll(doc, { itemPaths: [[]], maxItemBytes: 1500 }, chunk))]).toEqual([chunk, 'invalid_json']);
    }
    // The same text with the line break escaped is only large: an oversize item, then the next, whatever the chunking.
    const fine = `[["${'a'.repeat(1200)}\\n${'a'.repeat(1200)}",1],[2]]`;
    for (const chunk of [1, 7, 1 << 20]) {
      expect(readAll(fine, { itemPaths: [[]], maxItemBytes: 1500 }, chunk).map((event) => [event.kind, event.value])).toEqual([['oversize', undefined], ['item', [2]]]);
    }
  });

  test('well-formed starts of long texts are still skipped, wherever a character or escape meets the bound', () => {
    const good: Array<[string, string]> = [
      ['escapes', '\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\uD83D\\uDE00'],
      ['two, three and four byte characters', 'é€😀'],
    ];
    for (const [name, inside] of good) {
      // Shifting the text moves the bound across every part of the escape or character.
      for (let shift = 0; shift < 12; shift += 1) {
        const doc = `{"skip":"${'z'.repeat(shift)}${inside.repeat(30)}","list":[1,2]}`;
        for (const chunk of [1, 3, 64, 1 << 20]) {
          const events = readAll(doc, { itemPaths: [['list']], maxItemBytes: 100 }, chunk);
          expect([name, shift, chunk, events.map((event) => event.value)]).toEqual([name, shift, chunk, [1, 2]]);
        }
      }
    }
  });

  test('the same bytes in a text inside the bound were already invalid JSON, and still are', () => {
    const short = (inside: Uint8Array): Uint8Array => new Uint8Array([
      ...encoder.encode('[{"a":"x'), ...inside, ...encoder.encode('y"}]'),
    ]);
    for (const inside of [bytes(0xff), bytes(0x80), bytes(0xc0, 0x80), bytes(0xe2, 0x82), bytes(0x0a), encoder.encode('\\q')]) {
      for (const chunk of [1, 1 << 20]) {
        expect(code(() => readAll(short(inside), { itemPaths: [[]], maxItemBytes: 100 }, chunk))).toBe('invalid_json');
      }
    }
    // And good text keeps its value.
    const events = readAll(short(bytes(0xe2, 0x82, 0xac)), { itemPaths: [[]], maxItemBytes: 100 }, 1);
    expect((events[0]!.value as { a: string }).a).toBe('x\u20acy');
  });
});

describe('json stream errors come after the items before them', () => {
  const options = { itemPaths: [[]] as Array<Array<string | number>>, maxItemBytes: 1000 };

  function outcome(bytes: Uint8Array, chunkBytes: number): { values: unknown[]; error: string } {
    const reader = new JsonStreamReader(fileByteSource(memoryRangeReader(bytes), { chunkBytes }), options);
    const values: unknown[] = [];
    for (;;) {
      try {
        const event = reader.next();
        if (!event) return { values, error: 'none' };
        values.push(event.value);
      } catch (error) {
        if (!(error instanceof JsonStreamError)) throw error;
        // The same error again, every time.
        expect(() => reader.next()).toThrow(error);
        return { values, error: error.code };
      }
    }
  }

  test('items finished before a syntax error are returned, in one chunk or byte by byte', () => {
    const cases: Array<[string, unknown[], string]> = [
      ['[1,2,x]', [1, 2], 'invalid_json'],
      ['[{"a":1},{"b":2},]', [{ a: 1 }, { b: 2 }], 'invalid_json'],
      ['[1,2,3 4]', [1, 2], 'invalid_json'],
      ['[1,"two",[3],tru]', [1, 'two', [3]], 'invalid_json'],
      ['[1,2,{"a" 3}]', [1, 2], 'invalid_json'],
      ['[1,2,"bad \\q escape"]', [1, 2], 'invalid_json'],
      ['[1,2,3', [1, 2], 'truncated'],
      ['[1,2,]]', [1, 2], 'invalid_json'],
    ];
    for (const [text, values, error] of cases) {
      const bytes = encoder.encode(text);
      for (const chunkBytes of [1, 2, 3, 1 << 20]) {
        expect([text, chunkBytes, outcome(bytes, chunkBytes)]).toEqual([text, chunkBytes, { values, error }]);
      }
    }
  });

  test('the same holds across the slices of one large chunk', () => {
    const items = Array.from({ length: 3000 }, (_, index) => index);
    const text = `[${items.join(',')},x]`;
    const bytes = encoder.encode(text);
    expect(bytes.length).toBeGreaterThan(JSON_STREAM_FEED_SLICE_BYTES * 4);
    for (const chunkBytes of [1, 997, 1 << 20]) {
      expect(outcome(bytes, chunkBytes)).toEqual({ values: items, error: 'invalid_json' });
    }
  });
});

describe('json stream damage', () => {
  test('a document that is not whole or not JSON is named, never read as if it were', () => {
    const options = { itemPaths: [['list']] };
    expect(code(() => readAll('{"list":[1,2', options))).toBe('truncated');
    expect(code(() => readAll('{"list":[1,2]', options))).toBe('truncated');
    expect(code(() => readAll('{"list":[{"a":1},{"a":', options))).toBe('truncated');
    expect(code(() => readAll('{"list":[1 2]}', options))).toBe('invalid_json');
    expect(code(() => readAll('{"list":[1,]}', options))).toBe('invalid_json');
    expect(code(() => readAll('{"list":[{"a" 1}]}', options))).toBe('invalid_json');
    expect(code(() => readAll('{"list":[{a:1}]}', options))).toBe('invalid_json');
    expect(code(() => readAll('{"list":[1]} {"list":[2]}', options))).toBe('invalid_json');
    expect(code(() => readAll('{"list":[1]} ,', options))).toBe('invalid_json');
    expect(code(() => readAll('{"list":[tru]}', options))).toBe('invalid_json');
    expect(code(() => readAll('', options))).toBe('empty');
    expect(code(() => readAll('   ', options))).toBe('empty');
    expect(code(() => readAll('{"list":["unterminated', options))).toBe('truncated');
    // Reading the items that were whole before the damage still happens first.
    const bytes = encoder.encode('{"list":[1,2,');
    const reader = new JsonStreamReader(fileByteSource(memoryRangeReader(bytes), { chunkBytes: 4 }), { itemPaths: [['list']], maxItemBytes: 1000 });
    expect(reader.next()?.value).toBe(1);
    expect(reader.next()?.value).toBe(2);
    expect(() => reader.next()).toThrow(JsonStreamError);
    expect(() => reader.next()).toThrow(JsonStreamError);
  });

  test('damage inside an item is invalid JSON, not a half-built item', () => {
    expect(code(() => readAll('{"list":[{"a":[1,2}]}', { itemPaths: [['list']] }))).toBe('invalid_json');
    expect(code(() => readAll('{"list":[{"a":1,"a" }]}', { itemPaths: [['list']] }))).toBe('invalid_json');
  });

  test('a document with no list where one was named reads as no items', () => {
    expect(readAll('{"other":[1,2]}', { itemPaths: [['list']] })).toEqual([]);
    expect(readAll('{"list":"not a list"}', { itemPaths: [['list']] })).toEqual([]);
    expect(readAll('12', { itemPaths: [['list']] })).toEqual([]);
  });
});

describe('json stream inside a zip member', () => {
  test('reads a deflated member and resumes through the same resume points', () => {
    const items: unknown[] = [];
    for (let index = 0; index < 4000; index += 1) items.push({ id: index, text: `message number ${index}` });
    const json = JSON.stringify({ name: 'inside', messages: items });
    const zip = buildZip([{ name: 'export/result.json', data: json, method: 'deflate' }]);
    const archive = ZipArchive.open(memoryRangeReader(zip));
    const entry = [...archive.entries()][0]!;
    const run = (resume?: JsonResumePoint): JsonStreamEvent[] => {
      const member = ZipMemberReader.open(archive, entry, resume ? { start: resume.offset } : {});
      const reader = new JsonStreamReader(member, { itemPaths: [['messages']], maxItemBytes: 1 << 20, ...(resume ? { resume } : {}) });
      const events: JsonStreamEvent[] = [];
      for (let event = reader.next(); event; event = reader.next()) events.push(event);
      return events;
    };
    const full = run();
    expect(full.length).toBe(4000);
    expect(full[10]!.frame).toEqual({ name: 'inside' });
    const rest = run(full[2999]!.resume);
    expect(rest.map((event) => event.value)).toEqual(items.slice(3000));
  });
});

describe('a JSON reader failure as the import stopping', () => {
  const failure = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return archiveStopFromReaderError(error, 'export/result.json');
    }
    throw new Error('expected a failure');
  };

  test('a resume point that is not in the file is the resume point not belonging to it; a damaged or cut-short file could not be read', () => {
    const point = readAll(CHAT, { itemPaths: [['messages']] })[1]!.resume;
    const notAtBoundary: JsonResumePoint = { ...point, offset: point.offset + 1 };
    const stoppedFor = (error: unknown) => (error instanceof ArchiveImportStoppedError ? [error.code, error.relPath] : error);
    expect(stoppedFor(failure(() => readAll(CHAT, { itemPaths: [['messages']], resume: notAtBoundary })))).toEqual(['resume_point_invalid', 'export/result.json']);
    expect(stoppedFor(failure(() => readAll('{"list": [1, 2', { itemPaths: [['list']] })))).toEqual(['file_unreadable', 'export/result.json']);
    expect(stoppedFor(failure(() => readAll('{"list": [1 2]}', { itemPaths: [['list']] })))).toEqual(['file_unreadable', 'export/result.json']);
  });

  test('anything else is returned as it is, and a scope error keeps its own reasons', () => {
    const other = new Error('not a reader error');
    expect(archiveStopFromReaderError(other, 'a')).toBe(other);
    const changed = archiveStopFromReaderError(new ScopeSafeError('changed', 'the file changed'), 'a');
    expect(changed).toBeInstanceOf(ArchiveImportStoppedError);
    expect((changed as ArchiveImportStoppedError).code).toBe('file_changed');
  });
});
