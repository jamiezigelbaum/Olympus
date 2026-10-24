import { describe, expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { Inflate } from 'fflate/browser';
import { ArchiveImportStoppedError } from '../src/core/archive-formats.ts';
import { ScopeSafeError } from '../src/core/scope-safe-fs.ts';
import { crc32Update, crc32UpdateByTable, fileByteSource } from '../src/workers/archive-import/byte-source.ts';
import {
  ZIP_COMPRESSED_BLOCK_BYTES,
  ZIP_OVERLAP_SORT_MAX_ENTRIES,
  ZIP_READ_CHUNK_BYTES,
  ZipArchive,
  ZipFormatError,
  ZipMemberError,
  ZipMemberReader,
  inflaterProgress,
  readZipMemberHead,
  stoppableZipSource,
  zipFindingOffset,
  zipOverlapAssumption,
  type ZipEntry,
} from '../src/workers/archive-import/zip-reader.ts';
import { buildZip, memoryRangeReader, referenceCrc32, type ZipFixtureEntry } from './helpers/zip-fixture.ts';

const encoder = new TextEncoder();

function sample(size: number, seed = 1): Uint8Array<ArrayBufferLike> {
  const out: Uint8Array<ArrayBufferLike> = new Uint8Array(size);
  let state = seed;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[index] = state >>> 16;
  }
  return out;
}

function open(entries: readonly ZipFixtureEntry[], options: Parameters<typeof buildZip>[1] = {}, maxRange = ZIP_READ_CHUNK_BYTES) {
  const bytes = buildZip(entries, options);
  const reads: Array<{ offset: number; length: number }> = [];
  const reader = memoryRangeReader(bytes, { maxRange, reads });
  return { bytes, reads, reader, archive: ZipArchive.open(reader) };
}

function drain(member: ZipMemberReader): { bytes: Uint8Array<ArrayBufferLike>; chunks: number; largest: number } {
  const parts: Uint8Array[] = [];
  let total = 0;
  let largest = 0;
  for (let chunk = member.next(); chunk; chunk = member.next()) {
    parts.push(chunk);
    total += chunk.length;
    largest = Math.max(largest, chunk.length);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return { bytes, chunks: parts.length, largest };
}

function entryNamed(archive: ZipArchive, name: string): ZipEntry {
  const found = archive.find((entry) => entry.name === name)[0];
  if (!found) throw new Error(`no member ${name}`);
  return found;
}

describe('crc32', () => {
  test('the table version agrees with the runtime and with a bitwise one, in pieces', () => {
    const data = sample(10_000, 7);
    const whole = referenceCrc32(data);
    expect(crc32Update(0, data)).toBe(whole);
    expect(crc32UpdateByTable(0, data)).toBe(whole);
    let running = 0;
    for (let at = 0; at < data.length; at += 777) running = crc32UpdateByTable(running, data.subarray(at, at + 777));
    expect(running).toBe(whole);
    expect(crc32Update(0, new Uint8Array(0))).toBe(0);
  });
});

describe('zip structure', () => {
  test('lists members of a plain zip, with folders and names in order', () => {
    const { archive } = open([
      { name: 'docs/' },
      { name: 'docs/a.txt', data: 'alpha', method: 'deflate' },
      { name: 'b.bin', data: sample(100) },
    ], { comment: 'a zip comment' });
    const names = [...archive.entries()].map((entry) => entry.name);
    expect(names).toEqual(['docs/', 'docs/a.txt', 'b.bin']);
    expect([...archive.entries()].map((entry) => entry.isDirectory)).toEqual([true, false, false]);
    expect(archive.entryAt(2)?.name).toBe('b.bin');
    expect(archive.entryAt(3)).toBeUndefined();
  });

  test('zip64 member fields and zip64 end records read like the classic ones', () => {
    const { archive } = open([
      { name: 'big-fields.txt', data: 'zip64 member', zip64: true },
      { name: 'deflated.txt', data: 'zip64 deflated member '.repeat(50), method: 'deflate', zip64: true },
      { name: 'plain.txt', data: 'plain' },
    ], { zip64End: true });
    expect(archive.entryCount).toBe(3);
    const read = (name: string): string => new TextDecoder().decode(drain(ZipMemberReader.open(archive, entryNamed(archive, name))).bytes);
    expect(read('big-fields.txt')).toBe('zip64 member');
    expect(read('deflated.txt')).toBe('zip64 deflated member '.repeat(50));
    expect(read('plain.txt')).toBe('plain');
  });

  test('data descriptors: the directory is the authority, stored and deflated alike', () => {
    const text = 'written with a descriptor after the data. '.repeat(30);
    const { archive } = open([
      { name: 'stored.txt', data: text, descriptor: true },
      { name: 'deflated.txt', data: text, method: 'deflate', descriptor: true },
      { name: 'after.txt', data: 'after both' },
    ]);
    for (const name of ['stored.txt', 'deflated.txt']) {
      const member = ZipMemberReader.open(archive, entryNamed(archive, name));
      expect(new TextDecoder().decode(drain(member).bytes)).toBe(text);
      expect(member.end).toEqual({ bytes: text.length, sizeOk: true, crcOk: true });
    }
    expect(new TextDecoder().decode(drain(ZipMemberReader.open(archive, entryNamed(archive, 'after.txt'))).bytes)).toBe('after both');
  });

  test('names: flagged UTF-8, unflagged UTF-8 and code page 437', () => {
    const bytes = buildZip([{ name: 'plain.txt', data: 'x' }, { name: 'ünï.txt', data: 'y', utf8: true }, { name: 'café/note.txt', data: 'z' }]);
    const names = [...ZipArchive.open(memoryRangeReader(bytes)).entries()].map((entry) => entry.name);
    expect(names).toEqual(['plain.txt', 'ünï.txt', 'café/note.txt']);
    // A name that is not UTF-8 reads as code page 437.
    const patched = buildZip([{ name: 'XfeX.txt', data: 'q' }]);
    let patchedNames = 0;
    for (let index = 0; index + 8 <= patched.length; index += 1) {
      if (new TextDecoder().decode(patched.subarray(index, index + 8)) === 'XfeX.txt') {
        patched[index + 1] = 0x82;
        patchedNames += 1;
      }
    }
    expect(patchedNames).toBe(2);
    expect([...ZipArchive.open(memoryRangeReader(patched)).entries()][0]!.name).toBe('X\u00e9eX.txt');
  });

  test('not a zip, a split zip and a cut zip are named as such', () => {
    expect(() => ZipArchive.open(memoryRangeReader(new TextEncoder().encode('just some text, longer than a zip end record is')))).toThrow(ZipFormatError);
    expect(() => ZipArchive.open(memoryRangeReader(new Uint8Array(5)))).toThrow(ZipFormatError);
    const good = buildZip([{ name: 'a.txt', data: 'a' }]);
    const split = good.slice();
    split[good.length - 22 + 4] = 1;
    try {
      ZipArchive.open(memoryRangeReader(split));
      throw new Error('should not open');
    } catch (error) {
      expect((error as ZipFormatError).code).toBe('multi_disk');
    }
    const cut = good.slice(0, good.length - 40);
    expect(() => ZipArchive.open(memoryRangeReader(cut))).toThrow(ZipFormatError);
    expect(ZipArchive.looksLikeZip(good.subarray(0, 4))).toBe(true);
    expect(ZipArchive.looksLikeZip(new TextEncoder().encode('From x'))).toBe(false);
    expect(ZipArchive.looksLikeZip(undefined)).toBe(false);
  });

  test('a directory far bigger than one read is listed in bounded reads', () => {
    const entries: ZipFixtureEntry[] = [];
    const longName = 'a-long-folder-name-to-fill-the-directory/'.repeat(2);
    for (let index = 0; index < 22_000; index += 1) entries.push({ name: `${longName}file-${index}.txt` });
    const { archive, reads, bytes } = open(entries);
    // The directory alone is more than one read of the most this reader may ask for.
    expect(bytes.length).toBeGreaterThan(ZIP_READ_CHUNK_BYTES);
    let count = 0;
    let last = '';
    for (const entry of archive.entries()) {
      count += 1;
      last = entry.name;
    }
    expect(count).toBe(22_000);
    expect(last).toBe(`${longName}file-21999.txt`);
    expect(Math.max(...reads.map((read) => read.length))).toBeLessThanOrEqual(ZIP_READ_CHUNK_BYTES);
    expect(archive.memberTable().count).toBe(22_000);
  });

  test('the member table digest moves when any member changes, is added, or is renamed', () => {
    const base = [{ name: 'a.txt', data: 'one' }, { name: 'b.txt', data: 'two' }];
    const digest = (entries: ZipFixtureEntry[]): string => open(entries).archive.memberTable().sha256;
    const original = digest(base);
    expect(digest(base)).toBe(original);
    expect(digest([{ name: 'a.txt', data: 'one' }, { name: 'b.txt', data: 'twp' }])).not.toBe(original);
    expect(digest([...base, { name: 'c.txt', data: 'three' }])).not.toBe(original);
    expect(digest([{ name: 'a.txt', data: 'one' }, { name: 'b2.txt', data: 'two' }])).not.toBe(original);
    expect(digest([base[1]!, base[0]!])).not.toBe(original);
  });
});

describe('reading members', () => {
  test('a stored member larger than one read comes out whole, in reads no longer than the limit', () => {
    const data = sample(3 * ZIP_READ_CHUNK_BYTES + 12_345, 3);
    const { archive, reads } = open([{ name: 'big.bin', data }]);
    const member = ZipMemberReader.open(archive, entryNamed(archive, 'big.bin'));
    const out = drain(member);
    expect(out.bytes).toEqual(data);
    expect(out.largest).toBeLessThanOrEqual(ZIP_READ_CHUNK_BYTES);
    expect(Math.max(...reads.map((read) => read.length))).toBeLessThanOrEqual(ZIP_READ_CHUNK_BYTES);
    expect(member.end).toEqual({ bytes: data.length, sizeOk: true, crcOk: true });
    expect(member.crc32).toBe(referenceCrc32(data));
  });

  test('a deflated member larger than the compressed block comes out whole', () => {
    const data = sample(1_500_000, 5);
    for (let index = 0; index < data.length; index += 3) data[index] = 0x61 + (index % 7);
    const { archive, reads } = open([{ name: 'text.bin', data, method: 'deflate' }]);
    const member = ZipMemberReader.open(archive, entryNamed(archive, 'text.bin'));
    const out = drain(member);
    expect(out.bytes).toEqual(data);
    expect(member.end).toEqual({ bytes: data.length, sizeOk: true, crcOk: true });
    expect(Math.max(...reads.map((read) => read.length))).toBeLessThanOrEqual(ZIP_READ_CHUNK_BYTES);
  });

  test('a wrong checksum is reported at the end, after the bytes were handed out', () => {
    const data = new TextEncoder().encode('the bytes are fine, the checksum is not');
    for (const method of ['stored', 'deflate'] as const) {
      const { archive } = open([{ name: 'm.txt', data, method, badCrc: referenceCrc32(data) ^ 1 }]);
      const member = ZipMemberReader.open(archive, entryNamed(archive, 'm.txt'));
      expect(drain(member).bytes).toEqual(data);
      expect(member.end).toEqual({ bytes: data.length, sizeOk: true, crcOk: false });
    }
  });

  test('a very high compression ratio is read, never refused, and no chunk is the whole member', () => {
    const size = 64 * 1024 * 1024;
    const data = new Uint8Array(size);
    const { archive, bytes } = open([{ name: 'zeros.bin', data, method: 'deflate' }]);
    expect(bytes.length).toBeLessThan(size / 500);
    const member = ZipMemberReader.open(archive, entryNamed(archive, 'zeros.bin'));
    let total = 0;
    let largest = 0;
    for (let chunk = member.next(); chunk; chunk = member.next()) {
      total += chunk.length;
      largest = Math.max(largest, chunk.length);
    }
    expect(total).toBe(size);
    expect(largest).toBeLessThan(size / 2);
    expect(member.end).toEqual({ bytes: size, sizeOk: true, crcOk: true });
    // About 2.4 s alone; the shared build machine under load needs more than the default 5 s.
  }, 30_000);

  test('a member that is shorter than the directory says is a size mismatch, not a crash', () => {
    const data = new TextEncoder().encode('0123456789'.repeat(20));
    const { archive } = open([{ name: 'short.txt', data, method: 'deflate', declaredSize: data.length + 50 }]);
    const member = ZipMemberReader.open(archive, entryNamed(archive, 'short.txt'));
    drain(member);
    expect(member.end?.sizeOk).toBe(false);
  });

  test('encrypted members and unknown methods are named, and the zip still reads its other members', () => {
    const { archive } = open([
      { name: 'secret.txt', data: 'x', encrypted: true },
      { name: 'odd.txt', data: 'y', methodNumber: 12 },
      { name: 'fine.txt', data: 'fine' },
    ]);
    const attempt = (name: string): ZipMemberError => {
      try {
        ZipMemberReader.open(archive, entryNamed(archive, name));
      } catch (error) {
        return error as ZipMemberError;
      }
      throw new Error('opened');
    };
    expect(attempt('secret.txt').code).toBe('encrypted');
    expect(attempt('secret.txt').memberName).toBe('secret.txt');
    expect(attempt('odd.txt').code).toBe('unsupported_method');
    expect(new TextDecoder().decode(drain(ZipMemberReader.open(archive, entryNamed(archive, 'fine.txt'))).bytes)).toBe('fine');
  });

  test('damaged compressed data is a member error, not a thrown surprise', () => {
    const data = new TextEncoder().encode('compress me '.repeat(100));
    const { archive } = open([{ name: 'bad.txt', data, method: 'deflate', rawCompressed: new Uint8Array(40).fill(0xff) }]);
    const member = ZipMemberReader.open(archive, entryNamed(archive, 'bad.txt'));
    expect(() => drain(member)).toThrow(ZipMemberError);
  });

  test('unread gives bytes back, and the checksum still ends right', () => {
    const data = sample(200_000, 11);
    for (const method of ['stored', 'deflate'] as const) {
      const { archive } = open([{ name: 'm.bin', data, method }]);
      const member = ZipMemberReader.open(archive, entryNamed(archive, 'm.bin'));
      const first = member.next()!;
      const keep = Math.floor(first.length / 3);
      member.unread(first.length - keep);
      expect(member.position).toBe(keep);
      const rest = drain(member);
      expect(Buffer.from([...first.subarray(0, keep), ...rest.bytes]).equals(data)).toBe(true);
      expect(member.end?.crcOk).toBe(true);
      expect(() => member.unread(10_000_000)).toThrow();
    }
  });

  test('a stored member is entered at any offset directly, with the checksum carried', () => {
    const data = sample(50_000, 13);
    const { archive, reads } = open([{ name: 'm.bin', data }]);
    const entry = entryNamed(archive, 'm.bin');
    const startCrc = referenceCrc32(data.subarray(0, 30_000));
    reads.length = 0;
    const member = ZipMemberReader.open(archive, entry, { start: 30_000, startCrc });
    expect(drain(member).bytes).toEqual(data.subarray(30_000));
    expect(member.end?.crcOk).toBe(true);
    expect(reads.every((read) => read.offset >= entry.localHeaderOffset)).toBe(true);
    // Without the carried checksum the member cannot be verified from the middle.
    const unknown = ZipMemberReader.open(archive, entry, { start: 30_000 });
    drain(unknown);
    expect(unknown.end?.crcOk).toBeUndefined();
  });

  test('a deflated member entered at an offset inflates from its start and still verifies', () => {
    const data = sample(80_000, 17);
    const { archive } = open([{ name: 'm.bin', data, method: 'deflate' }]);
    const member = ZipMemberReader.open(archive, entryNamed(archive, 'm.bin'), { start: 33_333 });
    expect(drain(member).bytes).toEqual(data.subarray(33_333));
    expect(member.end).toEqual({ bytes: data.length, sizeOk: true, crcOk: true });
  });

  test('a continuation resumes where a pass stopped without reading the member again from its start', () => {
    const data = sample(900_000, 19);
    for (let index = 0; index < data.length; index += 2) data[index] = 0x30 + (index % 11);
    const { archive, reads } = open([{ name: 'm.bin', data, method: 'deflate' }]);
    const entry = entryNamed(archive, 'm.bin');
    reads.length = 0;
    const first = ZipMemberReader.open(archive, entry);
    const taken: Uint8Array[] = [];
    let got = 0;
    while (got < 400_000) {
      const chunk = first.next()!;
      taken.push(chunk);
      got += chunk.length;
    }
    const continuation = first.suspend();
    expect(continuation?.position).toBe(got);
    const dataStart = archive.dataStart(entry);
    const readsOfFirstPass = reads.length;
    const inMember = (read: { offset: number }): boolean => read.offset >= dataStart && read.offset < dataStart + entry.compressedSize;
    const lastCompressedEnd = Math.max(...reads.slice(0, readsOfFirstPass).filter(inMember).map((read) => read.offset + read.length));
    const second = ZipMemberReader.open(archive, entry, { start: got, continuation: continuation! });
    const rest = drain(second);
    const all = new Uint8Array(data.length);
    let at = 0;
    for (const part of [...taken, rest.bytes]) {
      all.set(part, at);
      at += part.length;
    }
    expect(Buffer.from(all).equals(data)).toBe(true);
    expect(second.end).toEqual({ bytes: data.length, sizeOk: true, crcOk: true });
    // The second pass read only compressed bytes after where the first one stopped.
    const later = reads.slice(readsOfFirstPass).filter(inMember);
    expect(later.length).toBeGreaterThan(0);
    expect(lastCompressedEnd).toBeGreaterThan(dataStart);
    expect(Math.min(...later.map((read) => read.offset))).toBeGreaterThanOrEqual(lastCompressedEnd);
    expect(() => first.next()).toThrow();
  });

  test('a continuation for another offset or member is ignored and the member is read from its start', () => {
    const data = sample(300_000, 23);
    const { archive } = open([{ name: 'm.bin', data, method: 'deflate' }, { name: 'n.bin', data: sample(1000, 2), method: 'deflate' }]);
    const entry = entryNamed(archive, 'm.bin');
    const first = ZipMemberReader.open(archive, entry);
    const chunk = first.next()!;
    const continuation = first.suspend()!;
    const wrongOffset = ZipMemberReader.open(archive, entry, { start: chunk.length + 5, continuation });
    expect(drain(wrongOffset).bytes).toEqual(data.subarray(chunk.length + 5));
    const wrongMember = ZipMemberReader.open(archive, entryNamed(archive, 'n.bin'), { start: 0, continuation });
    expect(drain(wrongMember).bytes).toEqual(sample(1000, 2));
  });

  test('the head of a member: shorter members, damaged members and empty ones', () => {
    const { archive } = open([
      { name: 'long.txt', data: 'abcdefghij'.repeat(1000), method: 'deflate' },
      { name: 'short.txt', data: 'tiny' },
      { name: 'empty.txt', data: '' },
      { name: 'odd.txt', data: 'y', methodNumber: 12 },
      { name: 'dir/' },
    ]);
    const head = (name: string, max: number): string | undefined => {
      const bytes = readZipMemberHead(archive, entryNamed(archive, name), max);
      return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
    };
    expect(head('long.txt', 25)).toBe('abcdefghij'.repeat(2) + 'abcde');
    expect(head('short.txt', 25)).toBe('tiny');
    expect(head('empty.txt', 25)).toBe('');
    expect(head('odd.txt', 25)).toBeUndefined();
    expect(head('dir/', 25)).toBe('');
  });
});

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function openError(archive: ZipArchive, name: string): ZipMemberError {
  try {
    ZipMemberReader.open(archive, entryNamed(archive, name)).close();
  } catch (error) {
    if (error instanceof ZipMemberError) return error;
    throw error;
  }
  throw new Error(`${name} opened`);
}

/** The same zip with its directory records in another order (the members stay where they are). */
function reorderDirectory(bytes: Uint8Array, order: readonly number[]): Uint8Array {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  const count = data.getUint16(endAt + 10, true);
  const size = data.getUint32(endAt + 12, true);
  const offset = data.getUint32(endAt + 16, true);
  const records: Uint8Array[] = [];
  for (let at = offset, index = 0; index < count; index += 1) {
    const total = 46 + data.getUint16(at + 28, true) + data.getUint16(at + 30, true) + data.getUint16(at + 32, true);
    records.push(bytes.slice(at, at + total));
    at += total;
  }
  const out = bytes.slice();
  let at = offset;
  for (const index of order) {
    out.set(records[index]!, at);
    at += records[index]!.length;
  }
  expect(at).toBe(offset + size);
  return out;
}

describe('a member whose stream and size disagree', () => {
  test('padding after the end of the stream is refused at once, without reading it all', () => {
    const data = new TextEncoder().encode('tiny');
    const padding = new Uint8Array(3 * 1024 * 1024);
    const { archive, reads } = open([{ name: 'm.txt', data, method: 'deflate', rawCompressed: concat(new Uint8Array(deflateRawSync(data)), padding) }]);
    const entry = entryNamed(archive, 'm.txt');
    const start = archive.dataStart(entry);
    reads.length = 0;
    const member = ZipMemberReader.open(archive, entry);
    let error: unknown;
    try {
      drain(member);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ZipMemberError);
    expect((error as ZipMemberError).code).toBe('damaged');
    // The same error every time after, and no bytes handed out late.
    expect(() => member.next()).toThrow(error as Error);
    const inMember = reads.filter((read) => read.offset >= start && read.offset < start + entry.compressedSize);
    expect(inMember.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(ZIP_COMPRESSED_BLOCK_BYTES);
    // The probe's head read stops there too and gives nothing for it.
    reads.length = 0;
    expect(readZipMemberHead(archive, entry, 4096)).toBeUndefined();
    expect(reads.filter((read) => read.offset >= start && read.offset < start + entry.compressedSize)
      .reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(ZIP_COMPRESSED_BLOCK_BYTES);
  });

  test('even a few bytes after the end of the stream make the member damaged', () => {
    const data = new TextEncoder().encode('a short member '.repeat(40));
    for (const extra of [1, 3, 17]) {
      const { archive } = open([{ name: 'm.txt', data, method: 'deflate', rawCompressed: concat(new Uint8Array(deflateRawSync(data)), new Uint8Array(extra)) }]);
      expect(() => drain(ZipMemberReader.open(archive, entryNamed(archive, 'm.txt')))).toThrow(ZipMemberError);
    }
    // The exact stream is fine.
    const { archive } = open([{ name: 'm.txt', data, method: 'deflate' }]);
    expect(drain(ZipMemberReader.open(archive, entryNamed(archive, 'm.txt'))).bytes).toEqual(data);
  });

  test('a stream that runs past the size the zip gives it is damaged', () => {
    const data = sample(20_000, 31);
    const whole = new Uint8Array(deflateRawSync(data));
    const { archive } = open([{ name: 'm.bin', data, method: 'deflate', rawCompressed: whole, declaredCompressedSize: whole.length - 40 }]);
    expect(() => drain(ZipMemberReader.open(archive, entryNamed(archive, 'm.bin')))).toThrow(ZipMemberError);
  });

  test('the inflater state read for this is pinned to what fflate does with real streams', () => {
    const cases = [
      new TextEncoder().encode('x'),
      new TextEncoder().encode('fixed codes, ending inside a byte '.repeat(3)),
      sample(70_000, 5),
    ];
    for (const data of cases) {
      for (const stored of [false, true]) {
        const stream = stored
          ? new Uint8Array(deflateRawSync(data, { level: 0 }))
          : new Uint8Array(deflateRawSync(data));
        const inflate = new Inflate(() => undefined);
        // Pushed in pieces: it ends exactly when the last byte of the stream is in.
        let at = 0;
        let ended = false;
        while (at < stream.length) {
          const piece = stream.subarray(at, Math.min(stream.length, at + 1000));
          inflate.push(piece, false);
          at += piece.length;
          const progress = inflaterProgress(inflate);
          ended = progress.ended;
          if (at < stream.length) expect(progress.ended).toBe(false);
          else expect(progress).toEqual({ ended: true, unconsumed: 0 });
        }
        expect(ended).toBe(true);
        // Extra bytes pushed in the same call that ends the stream are counted as unused.
        for (const extra of [1, 5, 40]) {
          const again = new Inflate(() => undefined);
          again.push(concat(stream, new Uint8Array(extra)), false);
          expect(inflaterProgress(again)).toEqual({ ended: true, unconsumed: extra });
        }
      }
    }
    expect(() => inflaterProgress({} as unknown as Inflate)).toThrow('does not expose');
  });
});

describe('members of no bytes', () => {
  test('a deflated member that claims to be empty but holds a stream is not read as empty', () => {
    const data = new TextEncoder().encode('there is content here, whatever the directory says');
    const { archive } = open([{ name: 'm.txt', data, method: 'deflate', declaredSize: 0, badCrc: 0 }]);
    const member = ZipMemberReader.open(archive, entryNamed(archive, 'm.txt'));
    drain(member);
    expect(member.end?.sizeOk).toBe(false);
    expect(member.end?.crcOk).toBe(false);
    expect(readZipMemberHead(archive, entryNamed(archive, 'm.txt'), 100)).toEqual(data);
  });

  test('padding after an empty stream is damage, like any other', () => {
    const { archive } = open([{ name: 'm.txt', data: '', method: 'deflate', rawCompressed: Uint8Array.of(3, 0, 0, 0) }]);
    expect(() => drain(ZipMemberReader.open(archive, entryNamed(archive, 'm.txt')))).toThrow(ZipMemberError);
    expect(readZipMemberHead(archive, entryNamed(archive, 'm.txt'), 100)).toBeUndefined();
  });

  test('a real empty member still reads: stored, an empty deflate stream, and no stream at all', () => {
    const { archive } = open([
      { name: 'stored.txt', data: '' },
      { name: 'stream.txt', data: '', method: 'deflate' },
      { name: 'handwritten.txt', data: '', method: 'deflate', rawCompressed: Uint8Array.of(3, 0) },
      { name: 'nothing.txt', data: '', method: 'deflate', rawCompressed: new Uint8Array(0) },
      { name: 'folder/' },
    ]);
    for (const name of ['stored.txt', 'stream.txt', 'handwritten.txt', 'nothing.txt']) {
      const member = ZipMemberReader.open(archive, entryNamed(archive, name));
      expect(drain(member).bytes.length).toBe(0);
      expect(member.end).toEqual({ bytes: 0, sizeOk: true, crcOk: true });
      expect(readZipMemberHead(archive, entryNamed(archive, name), 100)).toEqual(new Uint8Array(0));
    }
    expect(readZipMemberHead(archive, entryNamed(archive, 'folder/'), 100)).toEqual(new Uint8Array(0));
  });

  test('an empty member still has its own header checked', () => {
    const { archive } = open([
      { name: 'where.txt', data: '', directoryOffset: 3 },
      { name: 'name.txt', data: '', localHeader: { name: 'other.txt' } },
      { name: 'method.txt', data: '', localHeader: { methodNumber: 8 } },
      { name: 'fine.txt', data: '' },
      { name: 'deflated.txt', data: '', method: 'deflate', directoryOffset: 5 },
    ]);
    for (const name of ['where.txt', 'name.txt', 'method.txt', 'deflated.txt']) {
      expect(openError(archive, name).code).toBe('damaged');
      expect(readZipMemberHead(archive, entryNamed(archive, name), 100)).toBeUndefined();
    }
    expect(drain(ZipMemberReader.open(archive, entryNamed(archive, 'fine.txt'))).bytes.length).toBe(0);
  });
});

describe('a member and the directory must agree', () => {
  test('method, encryption, name, checksum and sizes each make a disagreeing member damaged', () => {
    const text = 'agree with the directory '.repeat(8);
    const { archive } = open([
      { name: 'ok.txt', data: text },
      { name: 'method.txt', data: text, localHeader: { methodNumber: 8 } },
      { name: 'flag.txt', data: text, localHeader: { encrypted: true } },
      { name: 'name.txt', data: text, localHeader: { name: 'nome.txt' } },
      { name: 'long-name.txt', data: text, localHeader: { name: 'long-name.txt.more' } },
      { name: 'crc.txt', data: text, localHeader: { crc: 12345 } },
      { name: 'csize.txt', data: text, localHeader: { compressedSize: 5 } },
      { name: 'usize.txt', data: text, localHeader: { uncompressedSize: 5 } },
    ]);
    expect(new TextDecoder().decode(drain(ZipMemberReader.open(archive, entryNamed(archive, 'ok.txt'))).bytes)).toBe(text);
    for (const name of ['method.txt', 'flag.txt', 'name.txt', 'long-name.txt', 'crc.txt', 'csize.txt', 'usize.txt']) {
      const error = openError(archive, name);
      expect(error.code).toBe('damaged');
      expect(error.memberName).toBe(name);
    }
  });

  test('sizes after the data (a descriptor) and zip64 placeholders in the header are not disagreements', () => {
    const { archive } = open([
      { name: 'desc.txt', data: 'with a descriptor', descriptor: true },
      { name: 'big.txt', data: 'zip64 member', zip64: true },
      { name: 'big-desc.txt', data: 'zip64 with descriptor', zip64: true, descriptor: true, method: 'deflate' },
    ]);
    for (const name of ['desc.txt', 'big.txt', 'big-desc.txt']) {
      expect(drain(ZipMemberReader.open(archive, entryNamed(archive, name))).bytes.length).toBeGreaterThan(0);
    }
  });

  test('members that share bytes are damaged, in file order or not', () => {
    const same = [
      { name: 'a.txt', data: 'first member' },
      { name: 'a.txt', data: 'first member', directoryOffset: 0 },
      { name: 'z.txt', data: 'a third that stands alone' },
    ];
    const { archive } = open(same);
    expect(new TextDecoder().decode(drain(ZipMemberReader.open(archive, entryNamed(archive, 'z.txt'))).bytes)).toBe('a third that stands alone');
    for (const index of [0, 1]) {
      const error = (() => {
        try {
          ZipMemberReader.open(archive, archive.entryAt(index)!);
        } catch (caught) {
          return caught as ZipMemberError;
        }
        return undefined;
      })();
      expect(error?.code).toBe('damaged');
      expect(error?.message).toContain('share bytes');
    }
    // The same zip with its directory shuffled still finds them, and the lone member reads.
    const shuffled = ZipArchive.open(memoryRangeReader(reorderDirectory(buildZip(same), [2, 1, 0])));
    expect(shuffled.entryAt(0)!.name).toBe('z.txt');
    expect(drain(ZipMemberReader.open(shuffled, shuffled.entryAt(0)!)).bytes.length).toBeGreaterThan(0);
    expect(() => ZipMemberReader.open(shuffled, shuffled.entryAt(1)!)).toThrow(ZipMemberError);
    expect(() => ZipMemberReader.open(shuffled, shuffled.entryAt(2)!)).toThrow(ZipMemberError);
  });

  test('a member that claims bytes belonging to the next one, or to the directory, is damaged', () => {
    const { archive } = open([
      { name: 'a.bin', data: sample(10, 1), declaredSize: 200, declaredCompressedSize: 200 },
      { name: 'b.bin', data: sample(500, 2) },
      { name: 'c.bin', data: sample(10, 3), declaredSize: 100_000, declaredCompressedSize: 100_000 },
    ]);
    expect(openError(archive, 'a.bin').message).toContain('share bytes');
    expect(openError(archive, 'b.bin').message).toContain('share bytes');
    expect(openError(archive, 'c.bin').code).toBe('damaged');
  });

  test('a directory in another order than the file, with nothing wrong, reads every member', () => {
    const entries = Array.from({ length: 3000 }, (_, index) => ({ name: `m${index}.txt`, data: `member ${index}` }));
    const order = entries.map((_, index) => index).reverse();
    const archive = ZipArchive.open(memoryRangeReader(reorderDirectory(buildZip(entries), order)));
    for (const index of [0, 1, 1500, 2999]) {
      const entry = archive.entryAt(index)!;
      expect(entry.name).toBe(`m${2999 - index}.txt`);
      expect(new TextDecoder().decode(drain(ZipMemberReader.open(archive, entry)).bytes)).toBe(`member ${2999 - index}`);
    }
  });

  test('a directory that claims more entries than it has room for is damaged when the zip is opened', () => {
    const bytes = buildZip([{ name: 'a.txt', data: 'a' }]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const endAt = bytes.length - 22;
    view.setUint16(endAt + 8, 60_000, true);
    view.setUint16(endAt + 10, 60_000, true);
    expect(() => ZipArchive.open(memoryRangeReader(bytes))).toThrow(ZipFormatError);
  });
});

/**
 * A zip that is only described, never held: `count` members of no bytes, the member at directory index i
 * in slot `slotOf(i)` of the file, read on demand like a file on disk.
 */
function virtualZip(
  count: number,
  slotOf: (index: number) => number,
  indexAt: (slot: number) => number,
): { size: number; readAt(offset: number, length: number): Uint8Array } {
  const SLOT = 64;
  const RECORD = 55;
  const directoryAt = SLOT * count;
  const recordsEnd = directoryAt + RECORD * count;
  const size = recordsEnd + 56 + 20 + 22;
  const nameOf = (index: number): Uint8Array => encoder.encode(`m${String(index).padStart(8, '0')}`);
  const localHeader = (index: number): Uint8Array => {
    const out = new Uint8Array(39);
    const data = new DataView(out.buffer);
    data.setUint32(0, 0x04034b50, true);
    data.setUint16(4, 20, true);
    data.setUint16(26, 9, true);
    out.set(nameOf(index), 30);
    return out;
  };
  const record = (index: number): Uint8Array => {
    const out = new Uint8Array(RECORD);
    const data = new DataView(out.buffer);
    data.setUint32(0, 0x02014b50, true);
    data.setUint16(4, 20, true);
    data.setUint16(6, 20, true);
    data.setUint16(28, 9, true);
    data.setUint32(42, SLOT * slotOf(index), true);
    out.set(nameOf(index), 46);
    return out;
  };
  // The end of a zip with more than 65,535 members: zip64 end record, its locator, then the ordinary end record.
  const end = new Uint8Array(56 + 20 + 22);
  const endData = new DataView(end.buffer);
  endData.setUint32(0, 0x06064b50, true);
  endData.setBigUint64(4, 44n, true);
  endData.setBigUint64(24, BigInt(count), true);
  endData.setBigUint64(32, BigInt(count), true);
  endData.setBigUint64(40, BigInt(RECORD * count), true);
  endData.setBigUint64(48, BigInt(directoryAt), true);
  endData.setUint32(56, 0x07064b50, true);
  endData.setBigUint64(56 + 8, BigInt(recordsEnd), true);
  endData.setUint32(56 + 16, 1, true);
  endData.setUint32(76, 0x06054b50, true);
  endData.setUint16(76 + 8, 0xffff, true);
  endData.setUint16(76 + 10, 0xffff, true);
  endData.setUint32(76 + 12, 0xffffffff, true);
  endData.setUint32(76 + 16, 0xffffffff, true);
  return {
    size,
    readAt(offset: number, length: number): Uint8Array {
      const out = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      const copy = (piece: Uint8Array, pieceAt: number): void => {
        const from = Math.max(offset, pieceAt);
        const to = Math.min(offset + out.length, pieceAt + piece.length);
        if (to > from) out.set(piece.subarray(from - pieceAt, to - pieceAt), from - offset);
      };
      if (offset < directoryAt) {
        for (let slot = Math.floor(offset / SLOT); slot * SLOT < Math.min(directoryAt, offset + out.length); slot += 1) copy(localHeader(indexAt(slot)), slot * SLOT);
      }
      if (offset + out.length > directoryAt && offset < recordsEnd) {
        const first = Math.max(0, Math.floor((offset - directoryAt) / RECORD));
        for (let index = first; index < count && directoryAt + index * RECORD < offset + out.length; index += 1) copy(record(index), directoryAt + index * RECORD);
      }
      copy(end, recordsEnd);
      return out;
    },
  };
}

/** Runs `run` while recording the length of every Float64Array and Uint32Array made. */
function countingTypedArrays<T>(run: () => T): { result: T; floats: number[]; ints: number[] } {
  const globals = globalThis as unknown as Record<string, unknown>;
  const Float = globalThis.Float64Array;
  const Int = globalThis.Uint32Array;
  const floats: number[] = [];
  const ints: number[] = [];
  class CountedFloat extends Float {
    constructor(...args: ConstructorParameters<typeof Float64Array>) {
      super(...args);
      floats.push(this.length);
    }
  }
  class CountedInt extends Int {
    constructor(...args: ConstructorParameters<typeof Uint32Array>) {
      super(...args);
      ints.push(this.length);
    }
  }
  globals.Float64Array = CountedFloat;
  globals.Uint32Array = CountedInt;
  try {
    return { result: run(), floats, ints };
  } finally {
    globals.Float64Array = Float;
    globals.Uint32Array = Int;
  }
}

describe('a large directory is checked in bounded memory', () => {
  const cap = ZIP_OVERLAP_SORT_MAX_ENTRIES;

  test('out of file order and at the bound: sorted in memory, 28 bytes a member while it runs', () => {
    const source = virtualZip(cap, (index) => cap - 1 - index, (slot) => cap - 1 - slot);
    const { result, floats, ints } = countingTypedArrays(() => {
      const archive = ZipArchive.open(source);
      const entry = archive.entryAt(7)!;
      const start = archive.dataStart(entry);
      return { archive, start, entry };
    });
    // The instrument sees the arrays: offsets, ends, order, and the sorted starts that stay.
    expect(floats.filter((length) => length === cap).length).toBe(3);
    expect(ints.filter((length) => length === cap).length).toBe(1);
    const bytes = floats.reduce((sum, length) => sum + length * 8, 0) + ints.reduce((sum, length) => sum + length * 4, 0);
    expect(bytes).toBeLessThanOrEqual(28 * cap + 1024 * 1024);
    expect(result.archive.overlapsUnchecked()).toBe(false);
    expect(zipOverlapAssumption(result.archive, 0)).toBeUndefined();
    expect(result.start).toBe(64 * (cap - 1 - 7) + 39);
  });

  test('out of file order and over the bound: no array grows with the directory, one assumption is reported, the zip still reads', () => {
    const count = cap + 1;
    const source = virtualZip(count, (index) => count - 1 - index, (slot) => count - 1 - slot);
    const { result, floats, ints } = countingTypedArrays(() => {
      const archive = ZipArchive.open(source);
      const entry = archive.entryAt(7)!;
      return { archive, entry, start: archive.dataStart(entry) };
    });
    expect(Math.max(0, ...floats, ...ints)).toBeLessThanOrEqual(4096);
    expect(result.start).toBe(64 * (count - 1 - 7) + 39);
    expect(result.archive.overlapsUnchecked()).toBe(true);
    expect(zipOverlapAssumption(result.archive, 3)).toEqual({ kind: 'assumption', class: 'gap', fileIndex: 3, offset: 0, count: 1 });
    // The archive is not refused: its members open.
    expect(ZipMemberReader.open(result.archive, result.entry).entry.name).toBe('m00000007');
  });

  test('over the bound but in file order: the whole directory is checked in a fixed amount of state', () => {
    const count = cap + 1000;
    const source = virtualZip(count, (index) => index, (slot) => slot);
    const { result, floats, ints } = countingTypedArrays(() => {
      const archive = ZipArchive.open(source);
      const entry = archive.entryAt(count - 1)!;
      return { archive, start: archive.dataStart(entry) };
    });
    expect(Math.max(0, ...floats, ...ints)).toBeLessThanOrEqual(4096);
    expect(result.archive.overlapsUnchecked()).toBe(false);
    expect(zipOverlapAssumption(result.archive, 0)).toBeUndefined();
    expect(result.start).toBe(64 * (count - 1) + 39);
  });

  test('members sharing bytes are named without keeping more than a fixed number of them', () => {
    // 20,000 entries that all say they start at the first slot.
    const source = virtualZip(20_000, () => 0, () => 0);
    const added: number[] = [];
    const original = Set.prototype.add;
    Set.prototype.add = function counted(this: Set<unknown>, value: unknown): Set<unknown> {
      if (typeof value === 'number') added.push(value);
      return original.call(this, value);
    };
    try {
      const archive = ZipArchive.open(source);
      const error = (() => {
        try {
          archive.dataStart(archive.entryAt(0)!);
        } catch (caught) {
          return caught as ZipMemberError;
        }
        return undefined;
      })();
      expect(error?.code).toBe('damaged');
      expect(error?.message).toContain('share bytes');
    } finally {
      Set.prototype.add = original;
    }
    expect(new Set(added).size).toBeLessThanOrEqual(4096);
    expect(new Set(added).size).toBeGreaterThan(0);
  });
});

describe('a member\'s true extent', () => {
  const payload = encoder.encode('SHARED PAYLOAD');

  function hiddenHeader(name: string, extraLength: number): Uint8Array {
    const nameBytes = encoder.encode(name);
    const out = new Uint8Array(30 + nameBytes.length + extraLength);
    const data = new DataView(out.buffer);
    data.setUint32(0, 0x04034b50, true);
    data.setUint16(4, 20, true);
    data.setUint32(14, referenceCrc32(payload), true);
    data.setUint32(18, payload.length, true);
    data.setUint32(22, payload.length, true);
    data.setUint16(26, nameBytes.length, true);
    data.setUint16(28, extraLength, true);
    out.set(nameBytes, 30);
    return out;
  }

  test('a second member whose header hides in the first one\'s extra field is found when the first is opened', () => {
    // a.bin: header (35 bytes), a 65-byte extra field that holds b.bin's whole header at its offset 20, then the payload.
    const extra = new Uint8Array(65);
    extra.set(hiddenHeader('b.bin', 10), 20);
    const { archive } = open([
      { name: 'a.bin', data: payload, localHeader: { extra } },
      { name: 'b.bin', data: payload, directoryOffset: 35 + 20 },
    ]);
    const a = entryNamed(archive, 'a.bin');
    const b = entryNamed(archive, 'b.bin');
    // Neither starts inside the other's name and data, so the directory alone shows nothing wrong.
    expect(b.localHeaderOffset).toBe(55);
    expect(openError(archive, 'a.bin').message).toContain('share bytes');
    // The hidden member is a well-formed record of its own; it is the first that is refused.
    expect(drain(ZipMemberReader.open(archive, b)).bytes).toEqual(payload);
    expect(a.compressedSize).toBe(payload.length);
  });

  test('a descriptor counts: a member that starts inside the one before it\'s descriptor shares bytes', () => {
    const { archive } = open([
      { name: 'a.bin', data: payload, descriptor: true },
      { name: 'b.bin', data: payload, directoryOffset: 35 + payload.length + 4 },
    ]);
    expect(openError(archive, 'a.bin').message).toContain('share bytes');
    // Without the second member the same record is fine, descriptor and all.
    const alone = open([{ name: 'a.bin', data: payload, descriptor: true }, { name: 'c.bin', data: 'later', descriptor: true }]);
    expect(drain(ZipMemberReader.open(alone.archive, entryNamed(alone.archive, 'a.bin'))).bytes).toEqual(payload);
  });

  test('extra fields and descriptors that stay clear of the next member are not overlap', () => {
    const { archive } = open([
      { name: 'a.bin', data: payload, localHeader: { extra: new Uint8Array(40) } },
      { name: 'b.bin', data: payload, descriptor: true, localHeader: { extra: new Uint8Array(7) } },
      { name: 'c.bin', data: payload, zip64: true, descriptor: true },
      { name: 'd.bin', data: payload },
    ]);
    for (const name of ['a.bin', 'b.bin', 'c.bin', 'd.bin']) {
      expect(drain(ZipMemberReader.open(archive, entryNamed(archive, name))).bytes).toEqual(payload);
    }
  });
});

describe('a member\'s header and the directory agree on checksum and sizes', () => {
  const text = 'the same bytes in the header and the directory';

  test('zeros stand in for the real values only when the header says a descriptor follows', () => {
    const zeros = { crc: 0, compressedSize: 0, uncompressedSize: 0 };
    const { archive } = open([
      { name: 'plain.txt', data: text, localHeader: zeros },
      { name: 'later.txt', data: text, descriptor: true },
      { name: 'later-wrong.txt', data: text, descriptor: true, localHeader: { crc: 12345 } },
      { name: 'later-size.txt', data: text, descriptor: true, localHeader: { uncompressedSize: 3 } },
      { name: 'later-real.txt', data: text, descriptor: true, localHeader: { crc: referenceCrc32(encoder.encode(text)) } },
    ]);
    expect(openError(archive, 'plain.txt').code).toBe('damaged');
    expect(openError(archive, 'later-wrong.txt').code).toBe('damaged');
    expect(openError(archive, 'later-size.txt').code).toBe('damaged');
    for (const name of ['later.txt', 'later-real.txt']) {
      expect(new TextDecoder().decode(drain(ZipMemberReader.open(archive, entryNamed(archive, name))).bytes)).toBe(text);
    }
  });

  test('sizes behind 0xffffffff are read from the header\'s zip64 record and compared', () => {
    const { archive } = open([
      { name: 'ok.txt', data: text, zip64: true },
      { name: 'big-uncompressed.txt', data: text, zip64: true, localHeader: { uncompressedSize: 5 } },
      { name: 'big-compressed.txt', data: text, zip64: true, localHeader: { compressedSize: 5 } },
      { name: 'missing.txt', data: text, localHeader: { compressedSize: 0xffffffff } },
    ]);
    expect(drain(ZipMemberReader.open(archive, entryNamed(archive, 'ok.txt'))).bytes.length).toBe(text.length);
    for (const name of ['big-uncompressed.txt', 'big-compressed.txt', 'missing.txt']) {
      expect([name, openError(archive, name).code]).toEqual([name, 'damaged']);
    }
  });
});

describe('a changed file stops the import', () => {
  test('the range reader refusing a changed file becomes the usual stopped error', () => {
    const bytes = buildZip([{ name: 'a.txt', data: 'data to read' }]);
    let changed = false;
    const reader = {
      size: bytes.length,
      readAt(offset: number, length: number): Uint8Array {
        if (changed) throw new ScopeSafeError('changed', 'the file changed since it was seen');
        return bytes.slice(offset, offset + length);
      },
    };
    const archive = ZipArchive.open(stoppableZipSource(reader, 'export.zip'));
    const entry = entryNamed(archive, 'a.txt');
    changed = true;
    try {
      ZipMemberReader.open(archive, entry);
      throw new Error('should stop');
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveImportStoppedError);
      expect((error as ArchiveImportStoppedError).code).toBe('file_changed');
      expect((error as ArchiveImportStoppedError).relPath).toBe('export.zip');
    }
  });

  test('a file that is gone and one that cannot be read have their own reasons', () => {
    const make = (code: ConstructorParameters<typeof ScopeSafeError>[0]) => stoppableZipSource({
      size: 10,
      readAt() {
        throw new ScopeSafeError(code);
      },
    }, 'export.zip');
    const codeOf = (code: ConstructorParameters<typeof ScopeSafeError>[0]): string => {
      try {
        make(code).readAt(0, 1);
      } catch (error) {
        return (error as ArchiveImportStoppedError).code;
      }
      return 'no error';
    };
    expect(codeOf('not_found')).toBe('file_missing');
    expect(codeOf('io')).toBe('file_unreadable');
  });
});

describe('finding positions', () => {
  test('stay in order across members and offsets', () => {
    expect(zipFindingOffset(0, 5)).toBeLessThan(zipFindingOffset(0, 6));
    expect(zipFindingOffset(0, 0x1ffffffff)).toBeLessThan(zipFindingOffset(1, 0));
    expect(zipFindingOffset(3, 10)).toBeLessThan(zipFindingOffset(4, 0));
    expect(Number.isSafeInteger(zipFindingOffset(1_000_000, 0x1ffffffff))).toBe(true);
  });

  test('the byte source over a plain file feeds the same readers', () => {
    const bytes = sample(5000, 29);
    const source = fileByteSource(memoryRangeReader(bytes), { chunkBytes: 1024 });
    const first = source.next()!;
    expect(first.length).toBe(1024);
    source.unread(24);
    expect(source.position).toBe(1000);
    const second = source.next()!;
    expect(second.length).toBe(24);
    expect(source.position).toBe(1024);
  });
});
