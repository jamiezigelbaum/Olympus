/**
 * Random-access zip reading for archive imports.
 *
 * An export that arrives as a zip is read where it is: the central directory
 * is read in bounded chunks through the scope-safe range reader, and one
 * member at a time is inflated as a stream. Nothing here loads a whole
 * archive or a whole member.
 *
 * - Structure: classic and zip64 end records, zip64 sizes and offsets in the
 *   extra fields, files written with data descriptors (the central
 *   directory is the authority on sizes and checksums). Names are UTF-8
 *   when flagged or when they decode as UTF-8, else code page 437.
 * - Members: stored or deflated. An encrypted member, or one with another
 *   method, is named in an error the caller turns into a gap.
 * - Checksum: the CRC-32 of a member's bytes is checked while it streams; a
 *   mismatch is reported in the member's end result (the bytes were already
 *   handed out), for the caller to record as a gap. There is no size or
 *   compression-ratio refusal: memory is bounded by streaming, never by
 *   refusing a real export.
 * - Resuming: a stored member is entered at any offset directly. A deflated
 *   member is entered by inflating from its start, unless a continuation
 *   (`ZipMemberReader.suspend`, kept by `continuation-cache.ts`) holds the
 *   inflater exactly where the last pass stopped.
 * - Changes: every read goes through the caller's range reader, which refuses
 *   a file that changed under it; `stoppableZipSource` turns that into the
 *   import's stopped error.
 */
import { createHash } from 'node:crypto';
import { Inflate } from 'fflate/browser';
import { ARCHIVE_COMMON_FINDINGS, type ArchiveImportFinding } from '../../core/archive-formats.ts';
import { archiveStopFromScopeError } from './stop-errors.ts';
import { crc32Update, type ArchiveByteSource } from './byte-source.ts';

/**
 * What the reader needs from a file; a `ScopeFileReader` is one.
 */
export interface ZipByteSource {
  readonly size: number;
  readAt(offset: number, length: number): Uint8Array;
}

/**
 * Bytes per `readAt` call; far below the scope reader's own cap.
 */
export const ZIP_READ_CHUNK_BYTES = 1024 * 1024;
/**
 * Compressed bytes read from the file at a time while inflating.
 */
export const ZIP_COMPRESSED_BLOCK_BYTES = 256 * 1024;
/**
 * Compressed bytes handed to the inflater at a time. Deflate never expands
 * more than about 1032 to 1, so one push yields at most about 17 MiB.
 */
export const ZIP_INFLATE_PUSH_BYTES = 16 * 1024;
/**
 * More than this waiting in a suspended member is not kept: the next pass inflates again.
 */
export const ZIP_CONTINUATION_MAX_PENDING_BYTES = 8 * 1024 * 1024;
/**
 * What an inflater holds besides what waits in it: its window and working
 * buffers, counted generously.
 */
export const ZIP_INFLATER_OVERHEAD_BYTES = 128 * 1024;
/**
 * More members than this sharing bytes with others and the whole zip is damaged.
 */
const ZIP_MAX_NAMED_OVERLAPS = 4096;
/**
 * A zip whose directory is not in file order has its members sorted in memory
 * to check them for overlap, up to this many. That costs 28 bytes a member
 * while it runs (7 MiB at the bound) and keeps 8 bytes a member (2 MiB) for
 * the life of the archive object. A larger directory in that state is not
 * sorted and not checked for overlap (`ZipArchive.overlapsUnchecked`).
 */
export const ZIP_OVERLAP_SORT_MAX_ENTRIES = 262_144;
/**
 * Bytes read to find the member after the one being opened.
 */
const ZIP_NEIGHBOR_READ_BYTES = 64 * 1024;
/**
 * The end record is searched for in this much of the file's end.
 */
const MAX_END_SEARCH_BYTES = 22 + 0xffff + 20;

const SIG_END = 0x06054b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export type ZipFormatErrorCode = 'not_a_zip' | 'damaged' | 'multi_disk' | 'too_large';

/**
 * The zip itself cannot be read as a zip.
 */
export class ZipFormatError extends Error {
  readonly code: ZipFormatErrorCode;
  constructor(code: ZipFormatErrorCode, message: string) {
    super(message);
    this.name = 'ZipFormatError';
    this.code = code;
  }
}

export type ZipMemberErrorCode = 'encrypted' | 'unsupported_method' | 'damaged';

/**
 * One member cannot be read; the zip and its other members still can.
 */
export class ZipMemberError extends Error {
  readonly code: ZipMemberErrorCode;
  readonly memberName: string;
  constructor(code: ZipMemberErrorCode, memberName: string, message: string) {
    super(message);
    this.name = 'ZipMemberError';
    this.code = code;
    this.memberName = memberName;
  }
}

export interface ZipEntry {
  /**
   * Position in the central directory, from 0.
   */
  index: number;
  name: string;
  method: number;
  flags: number;
  encrypted: boolean;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
  /**
   * The name exactly as the directory spells it (before any decoding): what a
   * member's own header must say too. Absent on an entry made by hand.
   */
  rawName?: Uint8Array;
  /**
   * Where this entry's record starts in the file; absent on an entry made by hand.
   */
  directoryAt?: number;
}

/**
 * The central directory in one number each: how many members, and a digest of their table.
 */
export interface ZipMemberTable {
  count: number;
  sha256: string;
}

const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeCp437(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]!;
  return out;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const lenientUtf8 = new TextDecoder('utf-8');

function isAscii(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte >= 0x80) return false;
  return true;
}

function decodeName(raw: Uint8Array, flags: number, unicodePath: Uint8Array | undefined): string {
  if (unicodePath) return lenientUtf8.decode(unicodePath);
  if (isAscii(raw)) return lenientUtf8.decode(raw);
  if (flags & 0x800) return lenientUtf8.decode(raw);
  // A name without the UTF-8 flag that is valid UTF-8 is far more likely UTF-8 than code page 437 (macOS writes it so).
  try {
    return strictUtf8.decode(raw);
  } catch {
    return decodeCp437(raw);
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(data: DataView, offset: number): number {
  const low = data.getUint32(offset, true);
  const high = data.getUint32(offset + 4, true);
  if (high >= 0x200000) throw new ZipFormatError('too_large', 'A size or offset in this zip is beyond what can be addressed.');
  return high * 0x100000000 + low;
}

function readExact(source: ZipByteSource, offset: number, length: number): Uint8Array {
  if (length < 0 || offset < 0 || offset + length > source.size) throw new ZipFormatError('damaged', 'The zip ends before its own records do.');
  if (length <= ZIP_READ_CHUNK_BYTES) {
    const bytes = source.readAt(offset, length);
    if (bytes.length !== length) throw new ZipFormatError('damaged', 'The zip ends before its own records do.');
    return bytes;
  }
  const out = new Uint8Array(length);
  for (let done = 0; done < length;) {
    const part = source.readAt(offset + done, Math.min(ZIP_READ_CHUNK_BYTES, length - done));
    if (part.length === 0) throw new ZipFormatError('damaged', 'The zip ends before its own records do.');
    out.set(part, done);
    done += part.length;
  }
  return out;
}

interface CentralDirectory {
  offset: number;
  size: number;
  entries: number;
}

function locateCentralDirectory(source: ZipByteSource): CentralDirectory {
  if (source.size < 22) throw new ZipFormatError('not_a_zip', 'This file is too short to be a zip.');
  const tailStart = Math.max(0, source.size - MAX_END_SEARCH_BYTES);
  const tail = readExact(source, tailStart, source.size - tailStart);
  const tailView = view(tail);
  let found = -1;
  let lenient = -1;
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (tailView.getUint32(at, true) !== SIG_END) continue;
    const comment = tailView.getUint16(at + 20, true);
    if (at + 22 + comment === tail.length) {
      found = at;
      break;
    }
    if (lenient < 0 && at + 22 + comment < tail.length) lenient = at;
  }
  if (found < 0) found = lenient;
  if (found < 0) throw new ZipFormatError('not_a_zip', 'This file has no zip end record.');
  const endAt = tailStart + found;
  let disk = tailView.getUint16(found + 4, true);
  let cdDisk = tailView.getUint16(found + 6, true);
  let entries = tailView.getUint16(found + 10, true);
  let size = tailView.getUint32(found + 12, true);
  let offset = tailView.getUint32(found + 16, true);
  let before = endAt;
  if (found >= 20 && tailView.getUint32(found - 20, true) === SIG_ZIP64_LOCATOR) {
    const z64At = u64(tailView, found - 20 + 8);
    if (z64At + 56 > source.size) throw new ZipFormatError('damaged', 'The zip64 end record is outside the file.');
    const record = readExact(source, z64At, 56);
    const data = view(record);
    if (data.getUint32(0, true) !== SIG_ZIP64_END) throw new ZipFormatError('damaged', 'The zip64 end record is not where the zip says.');
    disk = data.getUint32(16, true);
    cdDisk = data.getUint32(20, true);
    entries = u64(data, 32);
    size = u64(data, 40);
    offset = u64(data, 48);
    before = z64At;
  }
  if (disk !== 0 || cdDisk !== 0) throw new ZipFormatError('multi_disk', 'This zip is split over several files.');
  if (offset + size > before) throw new ZipFormatError('damaged', 'The zip\'s directory is outside the file.');
  if (entries * 46 > size) throw new ZipFormatError('damaged', 'The zip\'s directory is shorter than its entries.');
  return { offset, size, entries };
}

function* extraFields(extra: Uint8Array): Generator<{ id: number; data: Uint8Array }> {
  const data = view(extra);
  for (let at = 0; at + 4 <= extra.length;) {
    const id = data.getUint16(at, true);
    const length = data.getUint16(at + 2, true);
    if (at + 4 + length > extra.length) return;
    yield { id, data: extra.subarray(at + 4, at + 4 + length) };
    at += 4 + length;
  }
}

/**
 * A zip, read through bounded range reads.
 */
export class ZipArchive {
  readonly source: ZipByteSource;
  readonly entryCount: number;
  private readonly directory: CentralDirectory;
  private cachedLayout: ZipLayout | undefined;

  private constructor(source: ZipByteSource, directory: CentralDirectory) {
    this.source = source;
    this.directory = directory;
    this.entryCount = directory.entries;
  }

  /**
   * Whether `head` (a file's first bytes) starts like a zip.
   */
  static looksLikeZip(head: Uint8Array | undefined): boolean {
    return head !== undefined && head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b
      && ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06));
  }

  /**
   * Reads the end records; throws `ZipFormatError` when this is not a zip.
   */
  static open(source: ZipByteSource): ZipArchive {
    return new ZipArchive(source, locateCentralDirectory(source));
  }

  /**
   * Every member in directory order, read from the directory in bounded chunks.
   */
  *entries(): Generator<ZipEntry> {
    yield* this.readEntries(this.directory.offset, 0, ZIP_READ_CHUNK_BYTES);
  }

  /**
   * The entries from the one at `firstIndex`, whose record starts at file offset `from`, read `chunkBytes` at a time.
   */
  private *readEntries(from: number, firstIndex: number, chunkBytes: number): Generator<ZipEntry> {
    const { offset, size, entries } = this.directory;
    const end = offset + size;
    if (!Number.isSafeInteger(from) || from < offset || from > end) throw new ZipFormatError('damaged', 'An entry of the zip\'s directory is not where it says.');
    let buffer = new Uint8Array(0);
    let at = 0;
    let nextRead = from;
    const need = (length: number): void => {
      if (buffer.length - at >= length) return;
      const remaining = end - nextRead;
      if (remaining <= 0) throw new ZipFormatError('damaged', 'The zip\'s directory ends before its entries do.');
      const part = readExact(this.source, nextRead, Math.min(chunkBytes, remaining));
      nextRead += part.length;
      const joined = new Uint8Array(buffer.length - at + part.length);
      joined.set(buffer.subarray(at));
      joined.set(part, buffer.length - at);
      buffer = joined;
      at = 0;
      if (buffer.length < length) need(length);
    };
    for (let index = firstIndex; index < entries; index += 1) {
      need(46);
      const recordAt = nextRead - buffer.length + at;
      const header = view(buffer.subarray(at, at + 46));
      if (header.getUint32(0, true) !== SIG_CENTRAL) throw new ZipFormatError('damaged', 'The zip\'s directory has an entry that is not one.');
      const nameLength = header.getUint16(28, true);
      const extraLength = header.getUint16(30, true);
      const commentLength = header.getUint16(32, true);
      const total = 46 + nameLength + extraLength + commentLength;
      need(total);
      const record = buffer.subarray(at, at + total);
      const data = view(record);
      const flags = data.getUint16(8, true);
      const method = data.getUint16(10, true);
      const crc32 = data.getUint32(16, true);
      let compressedSize = data.getUint32(20, true);
      let uncompressedSize = data.getUint32(24, true);
      let localHeaderOffset = data.getUint32(42, true);
      const rawName = record.subarray(46, 46 + nameLength);
      const extra = record.subarray(46 + nameLength, 46 + nameLength + extraLength);
      let unicodePath: Uint8Array | undefined;
      for (const field of extraFields(extra)) {
        if (field.id === 0x0001) {
          const zip64 = view(field.data);
          let cursor = 0;
          const take = (): number => {
            if (cursor + 8 > field.data.length) throw new ZipFormatError('damaged', 'A zip64 field in the zip\'s directory is cut short.');
            const value = u64(zip64, cursor);
            cursor += 8;
            return value;
          };
          if (uncompressedSize === 0xffffffff) uncompressedSize = take();
          if (compressedSize === 0xffffffff) compressedSize = take();
          if (localHeaderOffset === 0xffffffff) localHeaderOffset = take();
        } else if (field.id === 0x7075 && field.data.length > 5 && field.data[0] === 1) {
          // Info-ZIP Unicode path: valid only while it describes this very name.
          const nameCrc = view(field.data).getUint32(1, true);
          if (nameCrc === crc32Update(0, rawName)) unicodePath = field.data.subarray(5);
        }
      }
      const name = decodeName(rawName, flags, unicodePath);
      yield {
        index,
        name,
        method,
        flags,
        encrypted: (flags & 0x1) !== 0,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        isDirectory: name.endsWith('/'),
        rawName: rawName.slice(),
        directoryAt: recordAt,
      };
      at += total;
    }
  }

  /**
   * The count of members and a digest of what the directory says about each
   * (name, method, flags, checksum, sizes, where it starts): a member that
   * changed, moved or was added changes it.
   */
  memberTable(): ZipMemberTable {
    const hash = createHash('sha256');
    let count = 0;
    for (const entry of this.entries()) {
      hash.update(`${JSON.stringify([entry.name, entry.method, entry.flags, entry.crc32, entry.compressedSize, entry.uncompressedSize, entry.localHeaderOffset])}\n`);
      count += 1;
    }
    return { count, sha256: hash.digest('hex') };
  }

  /**
   * Members that satisfy `predicate`, in directory order, at most `limit`.
   */
  find(predicate: (entry: ZipEntry) => boolean, limit = Number.POSITIVE_INFINITY): ZipEntry[] {
    const found: ZipEntry[] = [];
    if (limit <= 0) return found;
    for (const entry of this.entries()) {
      if (!predicate(entry)) continue;
      found.push(entry);
      if (found.length >= limit) break;
    }
    return found;
  }

  /**
   * The member at `index` in the directory, if there is one.
   */
  entryAt(index: number): ZipEntry | undefined {
    for (const entry of this.entries()) {
      if (entry.index === index) return entry;
      if (entry.index > index) break;
    }
    return undefined;
  }

  /**
   * Where the member's data starts in the file, after checking its local
   * record against the directory's entry. The directory is the authority; a
   * member that disagrees with it is damaged, not read as one or the other.
   * - The header says what the directory says: method, encryption flag, name,
   *   checksum and sizes (ZIP64 sizes resolved from the header's own extra
   *   field). Zeros stand for "after the data" only when the header says it
   *   has a descriptor.
   * - The record's true extent is its header, name, extra field, data and
   *   (if it has one) descriptor. It must end before the directory, and
   *   before the start of the next member in the file.
   * - No member's start may fall inside another's lower-bound extent (see
   *   `layout`).
   * Only the member being opened has its header read; the members around it
   * are checked from the directory, which costs a few small reads each.
   */
  dataStart(entry: ZipEntry): number {
    try {
      const header = readExact(this.source, entry.localHeaderOffset, 30);
      const data = view(header);
      if (data.getUint32(0, true) !== SIG_LOCAL) throw new ZipFormatError('damaged', 'A member does not start where the directory says.');
      const flags = data.getUint16(6, true);
      const nameLength = data.getUint16(26, true);
      const extraLength = data.getUint16(28, true);
      if (data.getUint16(8, true) !== entry.method) throw new ZipFormatError('damaged', 'A member\'s header and the directory disagree on how it is compressed.');
      if (((flags & 0x1) !== 0) !== entry.encrypted) throw new ZipFormatError('damaged', 'A member\'s header and the directory disagree on whether it is encrypted.');
      const tail = nameLength + extraLength === 0 ? new Uint8Array(0) : readExact(this.source, entry.localHeaderOffset + 30, nameLength + extraLength);
      if (entry.rawName && !sameBytes(tail.subarray(0, nameLength), entry.rawName)) throw new ZipFormatError('damaged', 'A member\'s header and the directory disagree on its name.');
      let zip64: { uncompressed: number; compressed: number } | undefined;
      for (const field of extraFields(tail.subarray(nameLength))) {
        if (field.id === 0x0001 && field.data.length >= 16) {
          const sizes = view(field.data);
          zip64 = { uncompressed: u64(sizes, 0), compressed: u64(sizes, 8) };
          break;
        }
      }
      const hasDescriptor = (flags & 0x8) !== 0;
      let compressed = data.getUint32(18, true);
      let uncompressed = data.getUint32(22, true);
      if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
        if (!zip64) throw new ZipFormatError('damaged', 'A member\'s header points to a zip64 size it does not have.');
        if (compressed === 0xffffffff) compressed = zip64.compressed;
        if (uncompressed === 0xffffffff) uncompressed = zip64.uncompressed;
      }
      const agrees = (local: number, wanted: number): boolean => local === wanted || (hasDescriptor && local === 0);
      if (!agrees(data.getUint32(14, true), entry.crc32) || !agrees(compressed, entry.compressedSize) || !agrees(uncompressed, entry.uncompressedSize)) {
        throw new ZipFormatError('damaged', 'A member\'s header and the directory disagree on its checksum or size.');
      }
      const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
      let end = start + entry.compressedSize;
      if (hasDescriptor) end += this.descriptorLength(end, zip64 !== undefined);
      if (end > this.source.size) throw new ZipFormatError('damaged', 'A member runs past the end of the file.');
      if (end > this.directory.offset) throw new ZipFormatError('damaged', 'A member runs into the zip\'s directory.');
      const layout = this.layout();
      if (layout.flagged === 'all' || layout.flagged.has(entry.index)) throw new ZipFormatError('damaged', 'Members of this zip share bytes.');
      const next = this.nextStartAfter(entry, layout);
      if (next !== undefined && end > next) throw new ZipFormatError('damaged', 'Members of this zip share bytes.');
      return start;
    } catch (error) {
      if (error instanceof ZipFormatError) throw new ZipMemberError('damaged', entry.name, error.message);
      throw error;
    }
  }

  /**
   * Bytes of the data descriptor that follows data ending at `dataEnd`: its
   * checksum and two sizes (eight bytes each with a zip64 record, else four),
   * and the optional signature in front, looked for where it would be.
   */
  private descriptorLength(dataEnd: number, zip64: boolean): number {
    const signed = dataEnd + 4 <= this.source.size && view(readExact(this.source, dataEnd, 4)).getUint32(0, true) === 0x08074b50;
    return (signed ? 4 : 0) + 4 + (zip64 ? 16 : 8);
  }

  /**
   * Whether the directory is out of file order and has too many members to
   * sort (`ZIP_OVERLAP_SORT_MAX_ENTRIES`), so that members were not all
   * checked against each other for overlap. A format that reads such a zip
   * reports it (`zipOverlapAssumption`). Reads the directory once.
   */
  overlapsUnchecked(): boolean {
    return this.layout().kind === 'unchecked';
  }

  /**
   * What the directory alone says about members sharing bytes, found once.
   * A member's lower-bound extent runs from its header to the end of its name
   * and data (the local extra field and descriptor are not known without
   * reading the header; `dataStart` adds them for the member it opens). One
   * pass over the directory in order keeps a fixed amount of state. A
   * directory out of file order is sorted in memory up to
   * `ZIP_OVERLAP_SORT_MAX_ENTRIES`; a larger one is not sorted and its
   * out-of-order part is not checked. The members named are at most
   * `ZIP_MAX_NAMED_OVERLAPS`; beyond that the answer is `'all'`.
   */
  private layout(): ZipLayout {
    if (this.cachedLayout) return this.cachedLayout;
    const found = new Set<number>();
    let all = false;
    const mark = (index: number): void => {
      if (found.size >= ZIP_MAX_NAMED_OVERLAPS) all = true;
      else found.add(index);
    };
    let sweepEnd = 0;
    let sweepIndex = -1;
    let previousOffset = -1;
    const sweep = (index: number, offset: number, end: number): void => {
      if (end > this.directory.offset) mark(index);
      if (sweepIndex >= 0 && offset < sweepEnd) {
        mark(sweepIndex);
        mark(index);
      }
      previousOffset = offset;
      if (end > sweepEnd) {
        sweepEnd = end;
        sweepIndex = index;
      }
    };
    const extent = (entry: ZipEntry): number => entry.localHeaderOffset + 30
      + (entry.rawName ? entry.rawName.length : new TextEncoder().encode(entry.name).length) + entry.compressedSize;
    let ordered = true;
    for (const entry of this.entries()) {
      if (entry.localHeaderOffset < previousOffset) {
        ordered = false;
        break;
      }
      sweep(entry.index, entry.localHeaderOffset, extent(entry));
      if (all) break;
    }
    let layout: ZipLayout;
    if (all) {
      layout = { kind: 'ordered', flagged: 'all' };
    } else if (ordered) {
      layout = { kind: 'ordered', flagged: found };
    } else if (this.directory.entries <= ZIP_OVERLAP_SORT_MAX_ENTRIES) {
      // Out of file order: sort positions held in typed arrays (28 bytes a member while this runs), then sweep again.
      found.clear();
      const count = this.directory.entries;
      const offsets = new Float64Array(count);
      const ends = new Float64Array(count);
      for (const entry of this.entries()) {
        offsets[entry.index] = entry.localHeaderOffset;
        ends[entry.index] = extent(entry);
      }
      const order = new Uint32Array(count);
      for (let index = 0; index < count; index += 1) order[index] = index;
      order.sort((a, b) => offsets[a]! - offsets[b]! || a - b);
      sweepEnd = 0;
      sweepIndex = -1;
      previousOffset = -1;
      const starts = new Float64Array(count);
      for (let position = 0; position < count; position += 1) {
        const index = order[position]!;
        starts[position] = offsets[index]!;
        if (!all) sweep(index, offsets[index]!, ends[index]!);
      }
      layout = { kind: 'sorted', flagged: all ? 'all' : found, starts };
    } else {
      // Too many to sort: what the ordered start of the directory found stands, the rest is not checked.
      layout = { kind: 'unchecked', flagged: found };
    }
    this.cachedLayout = layout;
    return layout;
  }

  /**
   * The smallest start of any other member after this one's, from the
   * directory; undefined when there is none or it cannot be known (a
   * directory too large to sort and out of order, an entry made by hand).
   */
  private nextStartAfter(entry: ZipEntry, layout: ZipLayout): number | undefined {
    if (layout.kind === 'sorted') {
      let low = 0;
      let high = layout.starts.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (layout.starts[middle]! <= entry.localHeaderOffset) low = middle + 1;
        else high = middle;
      }
      return low < layout.starts.length ? layout.starts[low]! : undefined;
    }
    if (layout.kind !== 'ordered' || entry.directoryAt === undefined) return undefined;
    // In file order the next member is the next record; this one has no twin (it would have been named), so it starts later.
    for (const following of this.readEntries(entry.directoryAt, entry.index, ZIP_NEIGHBOR_READ_BYTES)) {
      if (following.index === entry.index) continue;
      return following.localHeaderOffset > entry.localHeaderOffset ? following.localHeaderOffset : undefined;
    }
    return undefined;
  }
}

type ZipLayout =
  | { kind: 'ordered'; flagged: ReadonlySet<number> | 'all' }
  | { kind: 'sorted'; flagged: ReadonlySet<number> | 'all'; starts: Float64Array }
  | { kind: 'unchecked'; flagged: ReadonlySet<number> | 'all' };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * A range reader made for an import in progress: a file that changed, went
 * missing or cannot be read stops the import with the usual stopped error.
 */
export function stoppableZipSource(
  reader: ZipByteSource,
  relPath: string,
): ZipByteSource {
  return {
    get size(): number {
      return reader.size;
    },
    readAt(offset: number, length: number): Uint8Array {
      try {
        return reader.readAt(offset, length);
      } catch (error) {
        throw archiveStopFromScopeError(error, relPath);
      }
    },
  };
}

/**
 * How a member ended once all of it was read.
 */
export interface ZipMemberEnd {
  /**
   * Bytes the member produced.
   */
  bytes: number;
  /**
   * The member produced as many bytes as the directory says.
   */
  sizeOk: boolean;
  /**
   * The checksum matched; undefined when this read did not cover the whole member from its start.
   */
  crcOk: boolean | undefined;
}

/**
 * A member's inflater, kept exactly where a pass stopped. Opaque; hand it
 * back to `ZipMemberReader.open` for the same member at the same offset.
 */
export interface ZipContinuation {
  /**
   * The offset in the member the next chunk starts at.
   */
  readonly position: number;
  /**
   * About how much memory keeping it costs, in bytes (the inflater's window
   * and buffers, output waiting to be read, compressed bytes waiting).
   */
  readonly retainedBytes: number;
}

interface ContinuationState extends ZipContinuation {
  readonly memberKey: string;
  readonly crc: number;
  readonly crcKnown: boolean;
  readonly inflate: Inflate;
  readonly compressedNext: number;
  readonly compressedBlock: Uint8Array;
  readonly out: readonly Uint8Array[];
  readonly inflateFinished: boolean;
}

function memberKey(entry: ZipEntry): string {
  return `${entry.localHeaderOffset}:${entry.crc32}:${entry.compressedSize}:${entry.uncompressedSize}:${entry.method}`;
}

export interface ZipMemberOpenOptions {
  /**
   * The uncompressed offset to start at (default 0).
   */
  start?: number;
  /**
   * The CRC-32 of the member's bytes before `start`, from the pass that stopped there.
   */
  startCrc?: number;
  /**
   * A continuation for exactly this member at exactly `start`.
   */
  continuation?: ZipContinuation;
}

/**
 * One member of a zip as a byte stream.
 */
export class ZipMemberReader implements ArchiveByteSource {
  readonly entry: ZipEntry;
  private readonly archive: ZipArchive;
  private readonly dataStart: number;
  private readonly startAt: number;
  private pos = 0;
  private runningCrc = 0;
  private crcKnown: boolean;
  private out: Uint8Array[] = [];
  private lastChunk: Uint8Array = new Uint8Array(0);
  private crcBeforeLast = 0;
  private heldLast = 0;
  private closed = false;
  private result: ZipMemberEnd | undefined;
  // Stored members: the next offset to read.
  private storedNext = 0;
  // Deflated members.
  private inflate: Inflate | undefined;
  private compressedNext = 0;
  private compressedBlock: Uint8Array = new Uint8Array(0);
  private compressedOffset = 0;
  private inflateFinished = false;
  private failure: ZipMemberError | undefined;

  private constructor(archive: ZipArchive, entry: ZipEntry, dataStart: number, options: ZipMemberOpenOptions) {
    this.archive = archive;
    this.entry = entry;
    this.dataStart = dataStart;
    const start = options.start ?? 0;
    if (!Number.isSafeInteger(start) || start < 0 || start > entry.uncompressedSize) {
      throw new ZipMemberError('damaged', entry.name, 'The offset to start a member at is not inside it.');
    }
    this.startAt = start;
    this.crcKnown = start === 0;
    // Nothing to inflate: a directory, a stored member of no bytes, or a deflated one that holds no stream at all.
    // A deflated member with a stream, even one that claims to expand to nothing, still runs its stream below.
    if (entry.isDirectory || (entry.uncompressedSize === 0 && (entry.method === 0 || entry.compressedSize === 0))) {
      this.inflateFinished = true;
      this.pos = start;
      this.crcKnown = true;
      return;
    }
    if (entry.method === 0) {
      this.storedNext = start;
      this.pos = start;
      if (start > 0 && options.startCrc !== undefined) {
        this.runningCrc = options.startCrc >>> 0;
        this.crcKnown = true;
      }
      return;
    }
    // Deflated.
    const kept = options.continuation as ContinuationState | undefined;
    if (kept && kept.memberKey === memberKey(entry) && kept.position === start) {
      this.inflate = this.bind(kept.inflate);
      this.compressedNext = kept.compressedNext;
      this.compressedBlock = kept.compressedBlock;
      this.compressedOffset = 0;
      this.out = [...kept.out];
      this.inflateFinished = kept.inflateFinished;
      this.pos = start;
      this.runningCrc = kept.crc;
      this.crcKnown = kept.crcKnown;
      return;
    }
    // From the start, discarding what comes before `start` (its checksum still counts).
    this.inflate = this.bind(new Inflate(() => undefined));
    this.crcKnown = true;
  }

  /**
   * Points an inflater's output at this reader (a continued one still points at the reader that stopped).
   */
  private bind(inflate: Inflate): Inflate {
    inflate.ondata = (chunk) => {
      if (chunk.length > 0) this.out.push(chunk);
    };
    return inflate;
  }

  /**
   * Opens a member; throws `ZipMemberError` for one that cannot be read.
   */
  static open(archive: ZipArchive, entry: ZipEntry, options: ZipMemberOpenOptions = {}): ZipMemberReader {
    if (entry.encrypted) throw new ZipMemberError('encrypted', entry.name, 'This member is encrypted.');
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipMemberError('unsupported_method', entry.name, `This member uses compression method ${entry.method}.`);
    }
    if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) {
      throw new ZipMemberError('damaged', entry.name, 'A stored member\'s sizes disagree.');
    }
    // Every member that is read has its own header checked, whatever size the directory gives it.
    const dataStart = entry.isDirectory ? 0 : archive.dataStart(entry);
    return new ZipMemberReader(archive, entry, dataStart, options);
  }

  get position(): number {
    // A member entered at an offset reports that offset before the first read, while the inflater is still catching up.
    return Math.max(this.pos, this.startAt);
  }

  /**
   * The CRC-32 of the bytes before `position`; undefined when this read cannot know it.
   */
  get crc32(): number | undefined {
    return this.crcKnown ? this.runningCrc : undefined;
  }

  /**
   * How the member ended; only after `next()` returned undefined.
   */
  get end(): ZipMemberEnd | undefined {
    return this.result;
  }

  next(): Uint8Array | undefined {
    if (this.closed) throw new Error('This member reader was suspended or closed.');
    if (this.failure) throw this.failure;
    for (;;) {
      let chunk = this.out.shift();
      if (chunk === undefined) {
        if (!this.fillOrFail()) {
          this.conclude();
          return undefined;
        }
        continue;
      }
      if (this.pos < this.startAt) {
        const skip = this.startAt - this.pos;
        if (chunk.length <= skip) {
          this.runningCrc = crc32Update(this.runningCrc, chunk);
          this.pos += chunk.length;
          continue;
        }
        const head = chunk.subarray(0, skip);
        this.runningCrc = crc32Update(this.runningCrc, head);
        this.pos += head.length;
        chunk = chunk.subarray(skip);
      }
      this.crcBeforeLast = this.runningCrc;
      if (this.crcKnown) this.runningCrc = crc32Update(this.runningCrc, chunk);
      this.lastChunk = chunk;
      this.heldLast = chunk.length;
      this.pos += chunk.length;
      return chunk;
    }
  }

  unread(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > this.heldLast) throw new RangeError('unread past the last chunk');
    if (count === 0) return;
    this.heldLast -= count;
    this.pos -= count;
    if (this.crcKnown) this.runningCrc = crc32Update(this.crcBeforeLast, this.lastChunk.subarray(0, this.heldLast));
    this.out.unshift(this.lastChunk.subarray(this.heldLast));
    this.lastChunk = this.lastChunk.subarray(0, this.heldLast);
    this.result = undefined;
  }

  /**
   * Stops reading and returns the inflater where it is, for a later pass to
   * continue from `position` without inflating the member again. Undefined
   * for a stored member (a later pass enters it directly, with `crc32`), for
   * one that is finished, and for one with too much waiting to keep.
   */
  suspend(): ZipContinuation | undefined {
    if (this.closed) return undefined;
    this.closed = true;
    if (this.entry.method !== 8 || !this.inflate || (this.inflateFinished && this.out.length === 0)) return undefined;
    const pending = this.out.reduce((sum, chunk) => sum + chunk.length, 0);
    if (pending > ZIP_CONTINUATION_MAX_PENDING_BYTES || this.pos < this.startAt) return undefined;
    const compressedWaiting = this.compressedBlock.length - this.compressedOffset;
    const state: ContinuationState = {
      position: this.pos,
      retainedBytes: ZIP_INFLATER_OVERHEAD_BYTES + pending + compressedWaiting,
      memberKey: memberKey(this.entry),
      crc: this.runningCrc,
      crcKnown: this.crcKnown,
      inflate: this.inflate,
      compressedNext: this.compressedNext,
      compressedBlock: this.compressedBlock.slice(this.compressedOffset),
      out: [...this.out],
      inflateFinished: this.inflateFinished,
    };
    this.inflate = undefined;
    this.out = [];
    return state;
  }

  close(): void {
    this.closed = true;
    this.inflate = undefined;
    this.out = [];
  }

  /**
   * A member found damaged stays damaged: what was inflated since the last chunk is dropped and every later read throws the same error.
   */
  private fillOrFail(): boolean {
    try {
      return this.fill();
    } catch (error) {
      if (error instanceof ZipMemberError) {
        this.failure = error;
        this.out = [];
        this.inflateFinished = true;
      }
      throw error;
    }
  }

  /**
   * Produces more decoded bytes into `out`; false once the member has no more.
   */
  private fill(): boolean {
    if (this.entry.method === 0) {
      if (this.storedNext >= this.entry.uncompressedSize) return false;
      const length = Math.min(ZIP_READ_CHUNK_BYTES, this.entry.uncompressedSize - this.storedNext);
      const bytes = this.archive.source.readAt(this.dataStart + this.storedNext, length);
      if (bytes.length === 0) throw new ZipMemberError('damaged', this.entry.name, 'A stored member ends early.');
      this.storedNext += bytes.length;
      this.out.push(bytes);
      return true;
    }
    if (this.inflateFinished || !this.inflate) return false;
    if (this.compressedOffset >= this.compressedBlock.length && this.compressedNext < this.entry.compressedSize) {
      const length = Math.min(ZIP_COMPRESSED_BLOCK_BYTES, this.entry.compressedSize - this.compressedNext);
      this.compressedBlock = readBlock(this.archive.source, this.dataStart + this.compressedNext, length, this.entry.name);
      this.compressedOffset = 0;
      this.compressedNext += length;
    }
    const slice = this.compressedBlock.subarray(this.compressedOffset, this.compressedOffset + ZIP_INFLATE_PUSH_BYTES);
    this.compressedOffset += slice.length;
    const final = this.compressedOffset >= this.compressedBlock.length && this.compressedNext >= this.entry.compressedSize;
    try {
      this.inflate.push(slice, final);
    } catch (error) {
      if (error instanceof ZipMemberError) throw error;
      throw new ZipMemberError('damaged', this.entry.name, 'This member\'s compressed data is damaged.');
    }
    // The stream, not the directory's size, says where the member's data ends: both must say the same, at once.
    const progress = inflaterProgress(this.inflate);
    if (progress.ended) {
      const pushed = this.compressedNext - (this.compressedBlock.length - this.compressedOffset);
      const consumed = pushed - progress.unconsumed;
      if (consumed < this.entry.compressedSize) {
        throw new ZipMemberError('damaged', this.entry.name, 'This member\'s compressed data ends before the size the zip gives it.');
      }
      if (consumed > this.entry.compressedSize) {
        throw new ZipMemberError('damaged', this.entry.name, 'This member\'s compressed data runs past the size the zip gives it.');
      }
      this.inflateFinished = true;
    } else if (final) {
      throw new ZipMemberError('damaged', this.entry.name, 'This member\'s compressed data ends without a complete stream.');
    }
    return true;
  }

  private conclude(): void {
    if (this.result) return;
    const sizeOk = this.pos === this.entry.uncompressedSize;
    this.result = {
      bytes: this.pos,
      sizeOk,
      crcOk: this.crcKnown ? this.runningCrc === this.entry.crc32 : undefined,
    };
  }
}

/**
 * Where a streaming inflater stands: whether its stream has ended, and how
 * many bytes it was handed that it did not use. fflate offers no call for
 * this, so it is read from the inflater's own state: `s.f` (the last block
 * was seen) with `s.l` empty (that block is over) marks the end, and `p` holds
 * the bytes not yet consumed from the byte `s.p` points into. A different
 * fflate that lays this out otherwise is refused loudly, never guessed at.
 */
export function inflaterProgress(inflate: Inflate): { ended: boolean; unconsumed: number } {
  const internal = inflate as unknown as { s?: { f?: unknown; l?: unknown; p?: unknown }; p?: unknown };
  const state = internal.s;
  if (typeof state !== 'object' || state === null || !(internal.p instanceof Uint8Array)
    || (state.p !== undefined && typeof state.p !== 'number')) {
    throw new Error('The installed inflater does not expose the state this reader reads; the zip reader must be updated with it.');
  }
  const ended = Boolean(state.f) && !state.l;
  const partialByte = typeof state.p === 'number' && (state.p & 7) !== 0 ? 1 : 0;
  return { ended, unconsumed: Math.max(0, internal.p.length - partialByte) };
}

function readBlock(source: ZipByteSource, offset: number, length: number, name: string): Uint8Array {
  try {
    return readExact(source, offset, length);
  } catch (error) {
    if (error instanceof ZipFormatError) throw new ZipMemberError('damaged', name, error.message);
    throw error;
  }
}

/**
 * The first `maxBytes` bytes of a member, or fewer when it is shorter or
 * cannot be read as far; undefined for one that cannot be read at all.
 * Read errors of the file itself are not caught.
 */
export function readZipMemberHead(archive: ZipArchive, entry: ZipEntry, maxBytes: number): Uint8Array | undefined {
  let reader: ZipMemberReader;
  try {
    reader = ZipMemberReader.open(archive, entry);
  } catch (error) {
    if (error instanceof ZipMemberError) return undefined;
    throw error;
  }
  const parts: Uint8Array[] = [];
  let have = 0;
  let failed = false;
  try {
    while (have < maxBytes) {
      const chunk = reader.next();
      if (!chunk) break;
      const take = chunk.subarray(0, maxBytes - have);
      parts.push(take);
      have += take.length;
    }
  } catch (error) {
    if (!(error instanceof ZipMemberError)) throw error;
    failed = true;
  } finally {
    reader.close();
  }
  if (parts.length === 0) return entry.uncompressedSize === 0 && !failed ? new Uint8Array(0) : undefined;
  const out = new Uint8Array(have);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * A finding's position inside a zip: findings are ordered by one number per
 * file, so a member and an offset in it share one. Members up to 2^20 and
 * offsets up to 8 GiB keep their order; beyond that the offset is capped.
 */
export function zipFindingOffset(memberIndex: number, offsetInMember: number): number {
  return memberIndex * 0x200000000 + Math.min(Math.max(0, offsetInMember), 0x1ffffffff);
}

/**
 * The finding a format reports for a zip it read whose members could not all
 * be checked against each other for overlap, so that the import took it as
 * given that no two members share bytes (`ArchiveImportFinding`, kind
 * `assumption`, the dashboard's words say what it means); undefined when they
 * were all checked.
 */
export function zipOverlapAssumption(archive: ZipArchive, fileIndex: number): ArchiveImportFinding | undefined {
  if (!archive.overlapsUnchecked()) return undefined;
  return { kind: ARCHIVE_COMMON_FINDINGS.assumption, class: 'gap', fileIndex, offset: zipFindingOffset(0, 0), count: 1 };
}
