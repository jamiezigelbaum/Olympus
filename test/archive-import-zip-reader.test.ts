import { describe, expect, test } from 'bun:test';
import { ArchiveImportStoppedError } from '../src/core/archive-formats.ts';
import { ScopeSafeError } from '../src/core/scope-safe-fs.ts';
import { crc32Update, crc32UpdateByTable, fileByteSource } from '../src/workers/archive-import/byte-source.ts';
import {
  ZIP_READ_CHUNK_BYTES,
  ZipArchive,
  ZipFormatError,
  ZipMemberError,
  ZipMemberReader,
  readZipMemberHead,
  stoppableZipSource,
  zipFindingOffset,
  type ZipEntry,
} from '../src/workers/archive-import/zip-reader.ts';
import { buildZip, memoryRangeReader, referenceCrc32, type ZipFixtureEntry } from './helpers/zip-fixture.ts';

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
  });

  test('a member that is shorter than the directory says is a size mismatch, not a crash', () => {
    const data = new TextEncoder().encode('0123456789'.repeat(20));
    const bytes = buildZip([{ name: 'short.txt', data, method: 'deflate' }]);
    const reader = memoryRangeReader(bytes);
    const archive = ZipArchive.open(reader);
    const entry = entryNamed(archive, 'short.txt');
    const lying = { ...entry, uncompressedSize: data.length + 50 };
    const member = ZipMemberReader.open(archive, lying);
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
