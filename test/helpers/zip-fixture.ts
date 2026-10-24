/**
 * Zip files built in code for tests: stored and deflated members, data
 * descriptors, zip64 records, damaged checksums. Nothing here reads a real
 * export; every byte is made from the arguments.
 */
import { deflateRawSync } from 'node:zlib';

/** The checksum written by an independent bitwise implementation, so tests do not lean on the reader's own. */
export function referenceCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipFixtureEntry {
  name: string;
  /** Member bytes (text is UTF-8). A name ending in `/` is a folder and has none. */
  data?: Uint8Array | string;
  method?: 'stored' | 'deflate';
  /** Sizes and checksum after the data instead of before it. */
  descriptor?: boolean;
  /** Zip64 size and offset fields for this member. */
  zip64?: boolean;
  /** Written as the checksum instead of the right one. */
  badCrc?: number;
  /** The UTF-8 flag on the name. */
  utf8?: boolean;
  /** Compressed bytes to use instead of compressing `data`. */
  rawCompressed?: Uint8Array;
  /** Compression method number written instead of the real one (the data stays as it is). */
  methodNumber?: number;
  /** The encryption flag. */
  encrypted?: boolean;
  /** Written as the uncompressed size, in both headers, instead of the data's length. */
  declaredSize?: number;
  /** Written as the compressed size, in both headers, instead of the compressed bytes' length. */
  declaredCompressedSize?: number;
  /** Written as the local header's offset in the directory instead of where the member starts. */
  directoryOffset?: number;
  /** What the member's own header says where it should differ from the directory. */
  localHeader?: {
    name?: string;
    methodNumber?: number;
    encrypted?: boolean;
    crc?: number;
    compressedSize?: number;
    uncompressedSize?: number;
    /** More bytes in the header's extra field, after the zip64 record if there is one. */
    extra?: Uint8Array;
  };
}

export interface ZipFixtureOptions {
  /** Zip64 end records, whatever the sizes. */
  zip64End?: boolean;
  comment?: string;
}

function bytesOf(data: Uint8Array | string | undefined): Uint8Array {
  if (data === undefined) return new Uint8Array(0);
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

class Writer {
  private parts: Uint8Array[] = [];
  length = 0;
  u8(value: number): void {
    this.bytes(Uint8Array.of(value & 0xff));
  }
  u16(value: number): void {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value, true);
    this.bytes(out);
  }
  u32(value: number): void {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, true);
    this.bytes(out);
  }
  u64(value: number): void {
    const out = new Uint8Array(8);
    const view = new DataView(out.buffer);
    view.setUint32(0, value % 0x100000000, true);
    view.setUint32(4, Math.floor(value / 0x100000000), true);
    this.bytes(out);
  }
  bytes(data: Uint8Array): void {
    this.parts.push(data);
    this.length += data.length;
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

export function buildZip(entries: readonly ZipFixtureEntry[], options: ZipFixtureOptions = {}): Uint8Array {
  const file = new Writer();
  const central = new Writer();
  for (const entry of entries) {
    const data = bytesOf(entry.data);
    const method = entry.method ?? 'stored';
    const compressed = entry.rawCompressed ?? (method === 'deflate' ? new Uint8Array(deflateRawSync(data)) : data);
    const crc = entry.badCrc !== undefined ? entry.badCrc >>> 0 : referenceCrc32(data);
    const name = new TextEncoder().encode(entry.name);
    const localName = entry.localHeader?.name === undefined ? name : new TextEncoder().encode(entry.localHeader.name);
    const compressedSize = entry.declaredCompressedSize ?? compressed.length;
    const uncompressedSize = entry.declaredSize ?? data.length;
    const flags = (entry.descriptor ? 0x8 : 0) | (entry.utf8 ? 0x800 : 0) | (entry.encrypted ? 0x1 : 0);
    const localFlags = entry.localHeader?.encrypted === undefined
      ? flags
      : (flags & ~0x1) | (entry.localHeader.encrypted ? 0x1 : 0);
    const methodNumber = entry.methodNumber ?? (method === 'deflate' ? 8 : 0);
    const offset = file.length;
    const zip64 = entry.zip64 === true;

    file.u32(0x04034b50);
    file.u16(zip64 ? 45 : 20);
    file.u16(localFlags);
    file.u16(entry.localHeader?.methodNumber ?? methodNumber);
    file.u16(0);
    file.u16(0x21);
    if (entry.descriptor) {
      file.u32(entry.localHeader?.crc ?? 0);
      file.u32(entry.localHeader?.compressedSize ?? 0);
      file.u32(entry.localHeader?.uncompressedSize ?? 0);
    } else {
      file.u32(entry.localHeader?.crc ?? crc);
      file.u32(zip64 ? 0xffffffff : (entry.localHeader?.compressedSize ?? compressedSize));
      file.u32(zip64 ? 0xffffffff : (entry.localHeader?.uncompressedSize ?? uncompressedSize));
    }
    file.u16(localName.length);
    const zip64Extra = zip64 && !entry.descriptor ? 20 : 0;
    const moreExtra = entry.localHeader?.extra ?? new Uint8Array(0);
    file.u16(zip64Extra + moreExtra.length);
    file.bytes(localName);
    if (zip64Extra) {
      file.u16(0x0001);
      file.u16(16);
      file.u64(entry.localHeader?.uncompressedSize ?? uncompressedSize);
      file.u64(entry.localHeader?.compressedSize ?? compressedSize);
    }
    file.bytes(moreExtra);
    file.bytes(compressed);
    if (entry.descriptor) {
      file.u32(0x08074b50);
      file.u32(crc);
      if (zip64) {
        file.u64(compressedSize);
        file.u64(uncompressedSize);
      } else {
        file.u32(compressedSize);
        file.u32(uncompressedSize);
      }
    }

    central.u32(0x02014b50);
    central.u16(zip64 ? 45 : 20);
    central.u16(zip64 ? 45 : 20);
    central.u16(flags);
    central.u16(methodNumber);
    central.u16(0);
    central.u16(0x21);
    central.u32(crc);
    central.u32(zip64 ? 0xffffffff : compressedSize);
    central.u32(zip64 ? 0xffffffff : uncompressedSize);
    central.u16(name.length);
    central.u16(zip64 ? 28 : 0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(zip64 ? 0xffffffff : (entry.directoryOffset ?? offset));
    central.bytes(name);
    if (zip64) {
      central.u16(0x0001);
      central.u16(24);
      central.u64(uncompressedSize);
      central.u64(compressedSize);
      central.u64(entry.directoryOffset ?? offset);
    }
  }
  const centralBytes = central.done();
  const centralOffset = file.length;
  file.bytes(centralBytes);
  const comment = new TextEncoder().encode(options.comment ?? '');
  if (options.zip64End) {
    const recordAt = file.length;
    file.u32(0x06064b50);
    file.u64(44);
    file.u16(45);
    file.u16(45);
    file.u32(0);
    file.u32(0);
    file.u64(entries.length);
    file.u64(entries.length);
    file.u64(centralBytes.length);
    file.u64(centralOffset);
    file.u32(0x07064b50);
    file.u32(0);
    file.u64(recordAt);
    file.u32(1);
    file.u32(0x06054b50);
    file.u16(0xffff);
    file.u16(0xffff);
    file.u16(0xffff);
    file.u16(0xffff);
    file.u32(0xffffffff);
    file.u32(0xffffffff);
  } else {
    file.u32(0x06054b50);
    file.u16(0);
    file.u16(0);
    file.u16(entries.length);
    file.u16(entries.length);
    file.u32(centralBytes.length);
    file.u32(centralOffset);
  }
  file.u16(comment.length);
  file.bytes(comment);
  return file.done();
}

/** A range reader over bytes held in memory that refuses a longer read than `maxRange`, as the scope reader does. */
export function memoryRangeReader(
  bytes: Uint8Array,
  options: { maxRange?: number; reads?: Array<{ offset: number; length: number }> } = {},
): { size: number; readAt(offset: number, length: number): Uint8Array } {
  const maxRange = options.maxRange ?? Number.POSITIVE_INFINITY;
  return {
    size: bytes.length,
    readAt(offset: number, length: number): Uint8Array {
      if (length > maxRange) throw new Error(`readAt asked for ${length} bytes; the most allowed is ${maxRange}`);
      options.reads?.push({ offset, length });
      return bytes.slice(offset, Math.min(bytes.length, offset + length));
    },
  };
}
