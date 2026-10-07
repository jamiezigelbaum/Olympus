// A minimal reader for one entry of a ZIP archive (a Python wheel): enough to
// take the LiteRT-LM library out of Google's pinned wheel without a
// dependency. Stored and deflated entries only; no ZIP64, encryption or
// multi-disk archives, which a wheel under 4 GB never needs.

import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/** The bytes of `name` in `archive`, or undefined when the archive has no such entry. */
export function readZipEntry(archive: Uint8Array, name: string): Uint8Array | undefined {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  // The end record sits in the last 22 bytes plus at most a 64 KB comment.
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 22 - 0xffff); offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('Not a ZIP archive: no end of central directory.');
  const entries = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY) throw new Error('Corrupt ZIP central directory.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const entryName = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (flags & 0x1) throw new Error(`${name} is encrypted.`);
    if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER) throw new Error('Corrupt ZIP local header.');
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? new Uint8Array(inflateRawSync(compressed)) : undefined;
    if (!data) throw new Error(`${name} uses unsupported ZIP compression method ${method}.`);
    if (data.length !== size) throw new Error(`${name} unpacked to ${data.length} bytes, expected ${size}.`);
    return data;
  }
  return undefined;
}
