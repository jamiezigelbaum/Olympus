import { describe, expect, test } from 'bun:test';
import { ArchiveImportStoppedError } from '../src/core/archive-formats.ts';
import { ScopeSafeError } from '../src/core/scope-safe-fs.ts';
import { fileByteSource } from '../src/workers/archive-import/byte-source.ts';
import { archiveStopFromReaderError } from '../src/workers/archive-import/stop-errors.ts';
import {
  JSON_STREAM_MAX_DEPTH,
  JsonStreamError,
  JsonStreamReader,
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
    const blobBytes = 96 * 1024 * 1024;
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
    const reader = new JsonStreamReader(source, { itemPaths: [['list']], maxItemBytes: 1024 * 1024 });
    const values: unknown[] = [];
    for (let event = reader.next(); event; event = reader.next()) values.push(event.value);
    expect(values).toEqual([1, 2]);
    // Held whole it would add the size of the text (measured: about 114 MB for 96 MiB).
    expect(peak - baseline).toBeLessThan(48 * 1024 * 1024);
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
