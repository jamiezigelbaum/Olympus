// A minimal reader for the gzip'd ustar archives npm publishes. It returns the
// regular files whose archive path a caller asks for and nothing else: no
// links, no devices, no absolute or parent-relative paths. The archive's
// integrity is checked before this runs; this only has to be correct, not
// defensive against a hostile archive.

import { gunzipSync } from 'node:zlib';

export interface TarFile {
  path: string;
  mode: number;
  data: Uint8Array;
}

const BLOCK = 512;

export function readTarGz(archive: Uint8Array, include: (path: string) => boolean): TarFile[] {
  return readTar(gunzipSync(archive), include);
}

export function readTar(tar: Uint8Array, include: (path: string) => boolean): TarFile[] {
  const files: TarFile[] = [];
  let offset = 0;
  let paxPath: string | undefined;
  let longName: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      paxPath = parsePaxPath(data) ?? paxPath;
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = cString(data);
      continue;
    }
    const name = cString(header.subarray(0, 100));
    const prefix = isUstar(header) ? cString(header.subarray(345, 500)) : '';
    const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = undefined;
    longName = undefined;
    if (type !== '0' && type !== '\0') continue;
    if (!isSafeRelativePath(path) || !include(path)) continue;
    files.push({ path, mode: parseOctal(header.subarray(100, 108)), data: data.slice() });
  }
  return files;
}

function isUstar(header: Uint8Array): boolean {
  return cString(header.subarray(257, 263)).startsWith('ustar');
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function parseOctal(bytes: Uint8Array): number {
  const text = cString(bytes).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parsePaxPath(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data);
  for (const record of text.split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) return match[1];
  }
  return undefined;
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((segment) => segment !== '..');
}
