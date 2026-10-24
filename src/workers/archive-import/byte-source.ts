/**
 * Sequential byte sources for archive readers.
 *
 * Every shared reader (a zip member, a JSON stream, a line reader) pulls
 * bytes through one small interface, so a format's connector reads a plain
 * file range and a file inside a zip the same way, and can stop at an item
 * boundary and give back the bytes it read past it.
 *
 * Memory stays bounded: a source hands out one chunk at a time (never the
 * whole file), and `unread` only ever takes back part of the last chunk.
 */
import * as zlib from 'node:zlib';

/**
 * The bytes one `readAt` call asks for, well under the scope reader's own cap.
 */
export const ARCHIVE_SOURCE_CHUNK_BYTES = 1024 * 1024;

/**
 * What a source needs from a file: its size and bounded range reads.
 */
export interface ByteRangeReader {
  readonly size: number;
  readAt(offset: number, length: number): Uint8Array;
}

export interface ArchiveByteSource {
  /**
   * The offset, in this stream, of the byte the next chunk starts with.
   */
  readonly position: number;
  /**
   * The next chunk (never empty), or undefined once the stream has ended.
   */
  next(): Uint8Array | undefined;
  /**
   * Takes back the last `count` bytes of what was handed out, so `position`
   * goes back by `count` and the next chunk starts with them. `count` may be
   * any amount up to the length of the chunk most recently returned.
   */
  unread(count: number): void;
  /**
   * The CRC-32 of the bytes before `position`, when this source keeps one.
   */
  readonly crc32?: number | undefined;
}

type Crc32Fn = (data: Uint8Array, value?: number) => number;

const nativeCrc32 = (zlib as unknown as { crc32?: Crc32Fn }).crc32;

let crcTable: Int32Array | undefined;

function tableCrc32(data: Uint8Array, value: number): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = ~value;
  for (let index = 0; index < data.length; index += 1) {
    crc = crcTable[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

/**
 * The CRC-32 of `data` continuing from `value` (the CRC of the bytes before
 * it, 0 at the start). The runtime's own when it has one, else a table.
 */
export function crc32Update(value: number, data: Uint8Array): number {
  if (data.length === 0) return value >>> 0;
  return nativeCrc32 ? nativeCrc32(data, value) >>> 0 : tableCrc32(data, value);
}

/**
 * The table implementation, for the test that keeps it in step with the runtime's.
 */
export function crc32UpdateByTable(value: number, data: Uint8Array): number {
  return tableCrc32(data, value);
}

/**
 * Chunks of a file from `start` to `end` (default: the end of the file),
 * each read with one bounded `readAt`. A changed file throws whatever the
 * reader throws; nothing here catches it.
 */
export function fileByteSource(
  reader: ByteRangeReader,
  options: { start?: number; end?: number; chunkBytes?: number } = {},
): ArchiveByteSource {
  const end = Math.min(reader.size, options.end ?? reader.size);
  const chunkBytes = Math.max(1, options.chunkBytes ?? ARCHIVE_SOURCE_CHUNK_BYTES);
  let readFrom = Math.max(0, options.start ?? 0);
  let position = readFrom;
  let pending: Uint8Array | undefined;
  let last: Uint8Array = new Uint8Array(0);
  // How much of `last` is still counted as handed out.
  let held = 0;
  return {
    get position(): number {
      return position;
    },
    next(): Uint8Array | undefined {
      let chunk: Uint8Array;
      if (pending) {
        chunk = pending;
        pending = undefined;
      } else {
        if (readFrom >= end) return undefined;
        chunk = reader.readAt(readFrom, Math.min(chunkBytes, end - readFrom));
        readFrom += chunk.length;
        if (chunk.length === 0) return undefined;
      }
      last = chunk;
      held = chunk.length;
      position += chunk.length;
      return chunk;
    },
    unread(count: number): void {
      if (!Number.isInteger(count) || count < 0 || count > held) throw new RangeError('unread past the last chunk');
      if (count === 0) return;
      held -= count;
      position -= count;
      // `last` stays whole, so a second take-back still reaches everything given back before it.
      pending = last.subarray(held);
    },
  };
}
