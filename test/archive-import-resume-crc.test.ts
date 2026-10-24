// The helpers that keep a zip member's checksum across a stop part-way through
// a record (archive-import/resume-crc.ts), and the probe that reads the keys of
// a list's first record (archive-import/record-probe.ts). Both are format
// neutral: the streams here are made up in the test.

import { describe, expect, test } from 'bun:test';
import { crc32Update, fileByteSource, type ArchiveByteSource } from '../src/workers/archive-import/byte-source.ts';
import {
  RECORD_PROBE_MAX_FOLDER_SCAN_BYTES,
  RECORD_PROBE_MAX_KEYS,
  RECORD_PROBE_MAX_SCAN_BYTES,
  probeFirstRecordKeys,
  probeListIsEmpty,
  recordProbeBudget,
} from '../src/workers/archive-import/record-probe.ts';
import { recoverZipMemberCrc, trackBoundaries } from '../src/workers/archive-import/resume-crc.ts';
import { ZipArchive } from '../src/workers/archive-import/zip-reader.ts';
import { buildZip, referenceCrc32 } from './helpers/zip-fixture.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

/** A stream handed out `chunk` bytes at a time, with the CRC-32 before its position kept as a zip member keeps it (null: it knows none). */
function chunked(data: Uint8Array, chunk: number, startAt = 0, startCrc: number | null = 0): ArchiveByteSource {
  let position = startAt;
  let crc: number | undefined = startCrc ?? undefined;
  let last: Uint8Array = new Uint8Array(0);
  let crcBeforeLast: number | undefined = crc;
  let held = 0;
  return {
    get position() { return position; },
    get crc32() { return crc; },
    next() {
      if (position >= data.length) return undefined;
      last = data.subarray(position, Math.min(data.length, position + chunk));
      crcBeforeLast = crc;
      crc = crc === undefined ? undefined : crc32Update(crc, last);
      held = last.length;
      position += last.length;
      return last;
    },
    unread(count) {
      if (count > held) throw new RangeError('unread past the last chunk');
      held -= count;
      position -= count;
      last = last.subarray(0, held);
      crc = crcBeforeLast === undefined ? undefined : crc32Update(crcBeforeLast, last);
    },
  };
}

describe('the checksum at a record boundary', () => {
  const data = bytes('x'.repeat(10_000));

  test('is the checksum of the bytes before it, however many chunks were read past it', () => {
    const tracked = trackBoundaries(chunked(data, 1000));
    tracked.next();
    tracked.next();
    tracked.markBoundary(1500);
    tracked.next();
    tracked.next();
    tracked.next();
    expect(tracked.boundary).toBe(1500);
    expect(tracked.crcAtBoundary()).toBe(referenceCrc32(data.subarray(0, 1500)));
    // Only the latest boundary is kept.
    tracked.markBoundary(4500);
    expect(tracked.crcAtBoundary()).toBe(referenceCrc32(data.subarray(0, 4500)));
  });

  test('is forgotten, not guessed, for a boundary outside the chunk read last', () => {
    const tracked = trackBoundaries(chunked(data, 1000));
    tracked.next();
    tracked.next();
    tracked.markBoundary(500);
    expect(tracked.boundary).toBeUndefined();
    expect(tracked.crcAtBoundary()).toBeUndefined();
    tracked.markBoundary(5000);
    expect(tracked.crcAtBoundary()).toBeUndefined();
  });

  test('comes from the start figure the caller knows for a stream entered part-way, never from the stream\'s own before it has read', () => {
    const inner = chunked(data, 1000, 3000, null);
    const withStart = trackBoundaries(chunked(data, 1000, 3000, 12345), referenceCrc32(data.subarray(0, 3000)));
    withStart.next();
    withStart.markBoundary(3400);
    expect(withStart.crcAtBoundary()).toBe(referenceCrc32(data.subarray(0, 3400)));
    // A stream that knows no sum has no boundary sum until a chunk it summed from a known point.
    const unknown = trackBoundaries(inner);
    unknown.next();
    unknown.markBoundary(3400);
    expect(unknown.crcAtBoundary()).toBeUndefined();
    unknown.next();
    unknown.markBoundary(4400);
    expect(unknown.crcAtBoundary()).toBeUndefined();
  });

  test('moves with what is given back', () => {
    const tracked = trackBoundaries(chunked(data, 1000));
    tracked.next();
    tracked.next();
    tracked.unread(400);
    expect(tracked.position).toBe(1600);
    tracked.markBoundary(1300);
    expect(tracked.crcAtBoundary()).toBe(referenceCrc32(data.subarray(0, 1300)));
    tracked.next();
    tracked.markBoundary(2200);
    expect(tracked.crcAtBoundary()).toBe(referenceCrc32(data.subarray(0, 2200)));
  });
});

describe('the checksum of a member before an offset, by replay', () => {
  const body = bytes(JSON.stringify({ text: 'word '.repeat(600_000) }));
  const zip = buildZip([
    { name: 'stored.json', data: body, method: 'stored' },
    { name: 'deflated.json', data: body, method: 'deflate' },
  ]);
  const open = () => {
    const file = { size: zip.length, readAt: (offset: number, length: number) => zip.subarray(offset, offset + length) };
    return ZipArchive.open(file);
  };

  test('is the checksum of exactly those bytes, for a member of either kind', () => {
    const archive = open();
    for (const entry of archive.entries()) {
      for (const offset of [0, 1, 1_048_576, 2_000_000, body.length]) {
        expect({ name: entry.name, offset, recovered: recoverZipMemberCrc(archive, entry, offset, () => true) })
          .toEqual({ name: entry.name, offset, recovered: { kind: 'crc', crc: referenceCrc32(body.subarray(0, offset)) } });
      }
    }
  });

  test('says so when the import is told to stop, and when the member does not reach the offset', () => {
    const archive = open();
    const entry = [...archive.entries()][0]!;
    expect(recoverZipMemberCrc(archive, entry, 2_000_000, () => false)).toEqual({ kind: 'interrupted' });
    expect(recoverZipMemberCrc(archive, entry, body.length + 10, () => true)).toEqual({ kind: 'unavailable' });
  });
});

describe('the keys of the first record of a list', () => {
  const source = (text: string) => fileByteSource({ size: bytes(text).length, readAt: (offset, length) => bytes(text).subarray(offset, offset + length) }, { chunkBytes: 7 });

  test('are read past a long text, the values skipped, in the order written', () => {
    const text = JSON.stringify([{ a: 'x'.repeat(100_000), b: { nested: ['y'.repeat(50_000)] }, c: 1 }, { later: true }]);
    expect([...probeFirstRecordKeys(source(text), [])!]).toEqual(['a', 'b', 'c']);
    const wrapped = JSON.stringify({ version: 2, notes: [{ a: 'x'.repeat(100_000), b: 1 }, { later: true }] });
    expect([...probeFirstRecordKeys(source(wrapped), ['notes'])!]).toEqual(['a', 'b']);
  });

  test('stop when the keys so far decide, and not before', () => {
    const text = JSON.stringify([{ a: 1, b: 2, c: 'x'.repeat(100_000), d: 4 }]);
    const seen: string[][] = [];
    const keys = probeFirstRecordKeys(source(text), [], (so) => {
      seen.push([...so]);
      return so.has('b');
    });
    expect([...keys!]).toEqual(['a', 'b']);
    expect(seen).toEqual([['a'], ['a', 'b']]);
  });

  test('read a record of any size, holding the keys and one chunk', () => {
    const size = 24 * 1024 * 1024;
    let handed = 0;
    const head = bytes('[{"a":"');
    const tail = bytes('","title":"T","uid":"u"}]');
    const filler = new Uint8Array(1024 * 1024).fill(0x78);
    let position = 0;
    let stage = 0;
    const stream: ArchiveByteSource = {
      get position() { return position; },
      next() {
        if (stage === 0) { stage = 1; position += head.length; return head; }
        if (stage === 1) {
          if (handed < size) { handed += filler.length; position += filler.length; return filler; }
          stage = 2;
          position += tail.length;
          return tail;
        }
        return undefined;
      },
      unread() { throw new RangeError('not used'); },
    };
    expect([...probeFirstRecordKeys(stream, [])!]).toEqual(['a', 'title', 'uid']);
    expect(handed).toBe(size);
  });

  test('keep at most a bounded number of key names', () => {
    const record = Object.fromEntries(Array.from({ length: RECORD_PROBE_MAX_KEYS + 50 }, (_, index) => [`k${index}`, index]));
    expect(probeFirstRecordKeys(source(JSON.stringify([record])), [])!.size).toBe(RECORD_PROBE_MAX_KEYS);
  });

  test('have no record to give for a document that is not a list of records, or not whole JSON', () => {
    expect(probeFirstRecordKeys(source('[1, 2, 3]'), [])).toBeUndefined();
    expect(probeFirstRecordKeys(source('[]'), [])).toBeUndefined();
    expect(probeFirstRecordKeys(source('{"notes": 5}'), ['notes'])).toBeUndefined();
    expect(probeFirstRecordKeys(source('not json at all'), [])).toBeUndefined();
    // Cut short after the keys: what was read is what there is.
    expect([...probeFirstRecordKeys(source('[{"a":1,"b":"unfinished'), [])!]).toEqual(['a']);
  });
});

/** A document of `head`, then `megabytes` MiB of one long text, then `tail`: nothing of it exists in memory but one chunk. */
function longDocument(head: string, megabytes: number, tail: string) {
  const opening = bytes(head);
  const closing = bytes(tail);
  const filler = new Uint8Array(1024 * 1024).fill(0x78);
  let position = 0;
  let stage = 0;
  let handed = 0;
  const source: ArchiveByteSource = {
    get position() { return position; },
    next() {
      if (stage === 0) { stage = 1; position += opening.length; return opening; }
      if (stage === 1) {
        if (handed < megabytes) { handed += 1; position += filler.length; return filler; }
        stage = 2;
        position += closing.length;
        return closing;
      }
      return undefined;
    },
    unread() { throw new RangeError('not used'); },
  };
  return { source, megabytes: () => handed };
}

describe('how much of a document the looks at it read', () => {
  const CAP_MIB = RECORD_PROBE_MAX_SCAN_BYTES / (1024 * 1024);

  test('a list found within the allowance is read', () => {
    const doc = longDocument('{"settings":"', CAP_MIB - 24, '","notes":[{"a":1,"title":"T"}]}');
    expect([...probeFirstRecordKeys(doc.source, ['notes'])!]).toEqual(['a', 'title']);
  });

  test('past the allowance the answer is "nothing found", without reading to the end', () => {
    const doc = longDocument('{"settings":"', 300, '","notes":[{"a":1,"title":"T"}]}');
    expect(probeFirstRecordKeys(doc.source, ['notes'])).toBeUndefined();
    // Chunks are read whole, so the last one may run past the allowance by one.
    expect(doc.megabytes()).toBeLessThanOrEqual(CAP_MIB + 1);
    expect(doc.megabytes()).toBeGreaterThanOrEqual(CAP_MIB);
    const empty = longDocument('{"settings":"', 300, '","notes":[]}');
    expect(probeListIsEmpty(empty.source, ['notes'])).toBe(false);
    expect(empty.megabytes()).toBeLessThanOrEqual(CAP_MIB + 1);
  });

  test('the looks at one document share the allowance', () => {
    const budget = recordProbeBudget();
    const first = longDocument('{"settings":"', 40, '","other":1}');
    expect(probeFirstRecordKeys(first.source, ['notes'], undefined, budget)).toBeUndefined();
    const second = longDocument('{"settings":"', 40, '","notes":[]}');
    expect(probeListIsEmpty(second.source, ['notes'], budget)).toBe(false);
    expect(second.megabytes()).toBeLessThan(40);
    expect(budget.left).toBeLessThanOrEqual(0);
  });
});

describe('the allowance the files of one folder share', () => {
  const MiB = 1024 * 1024;

  test('is spent across the documents, and the one that ran into it is told from one that ran into its own', () => {
    const folder = recordProbeBudget(60 * MiB);
    const firstOwn = recordProbeBudget();
    const first = longDocument('{"settings":"', 40, '","other":1}');
    expect(probeFirstRecordKeys(first.source, ['notes'], undefined, [firstOwn, folder])).toBeUndefined();
    // Read whole, within both: nothing ran out.
    expect(first.megabytes()).toBe(40);
    expect(firstOwn.ranOut).toBeUndefined();
    expect(folder.ranOut).toBeUndefined();
    // The next document is cut short by what the folder has left, and the folder says so.
    const secondOwn = recordProbeBudget();
    const second = longDocument('{"settings":"', 40, '","notes":[{"a":1,"title":"T"}]}');
    expect(probeFirstRecordKeys(second.source, ['notes'], undefined, [secondOwn, folder])).toBeUndefined();
    expect(second.megabytes()).toBeLessThan(25);
    expect(folder.ranOut).toBe(true);
    expect(secondOwn.ranOut).toBeUndefined();
  });

  test('a document past its own allowance is its own limit, not the folder running out', () => {
    const folder = recordProbeBudget(500 * MiB);
    const own = recordProbeBudget();
    const long = longDocument('{"settings":"', 300, '","notes":[{"a":1,"title":"T"}]}');
    expect(probeFirstRecordKeys(long.source, ['notes'], undefined, [own, folder])).toBeUndefined();
    expect(own.ranOut).toBe(true);
    expect(folder.ranOut).toBeUndefined();
    // The same for the question of an empty list.
    const own2 = recordProbeBudget();
    const folder2 = recordProbeBudget(500 * MiB);
    expect(probeListIsEmpty(longDocument('{"settings":"', 300, '","notes":[]}').source, ['notes'], [own2, folder2])).toBe(false);
    expect(own2.ranOut).toBe(true);
    expect(folder2.ranOut).toBeUndefined();
    const folder3 = recordProbeBudget(10 * MiB);
    expect(probeListIsEmpty(longDocument('{"settings":"', 40, '","notes":[]}').source, ['notes'], [recordProbeBudget(), folder3])).toBe(false);
    expect(folder3.ranOut).toBe(true);
  });

  test('a folder\'s default is bigger than a document\'s, and a document\'s own is unchanged', () => {
    expect(RECORD_PROBE_MAX_FOLDER_SCAN_BYTES).toBeGreaterThan(RECORD_PROBE_MAX_SCAN_BYTES);
    expect(recordProbeBudget().left).toBe(RECORD_PROBE_MAX_SCAN_BYTES);
  });
});

describe('whether a list is empty', () => {
  const source = (text: string) => fileByteSource({ size: bytes(text).length, readAt: (offset, length) => bytes(text).subarray(offset, offset + length) }, { chunkBytes: 61 });

  test('is told past long values before it, and only for a list with nothing in it', () => {
    const long = 'x'.repeat(30_000);
    expect(probeListIsEmpty(source(JSON.stringify({ settings: long, notes: [] })), ['notes'])).toBe(true);
    expect(probeListIsEmpty(source(`{"settings": {"a": [${'1,'.repeat(3_000)}2]}, "notes": [ \n ]}`), ['notes'])).toBe(true);
    for (const text of [
      JSON.stringify({ settings: long, notes: [1] }),
      JSON.stringify({ settings: long, notes: [{}] }),
      JSON.stringify({ settings: long, notes: {} }),
      JSON.stringify({ settings: long, notes: 'none yet' }),
      JSON.stringify({ settings: long, other: [] }),
      JSON.stringify({ settings: long, notes: Array.from({ length: 20_000 }, () => 0) }),
      '[]',
      'not json',
      '{"settings": "unfinished',
    ]) {
      expect({ text: text.slice(0, 40), empty: probeListIsEmpty(source(text), ['notes']) }).toEqual({ text: text.slice(0, 40), empty: false });
    }
    expect(probeListIsEmpty(source('{"notes": []}'), [])).toBe(false);
  });
});
