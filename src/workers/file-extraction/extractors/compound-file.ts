import { OfficeDocumentUnreadableError } from './document-formats.ts';

const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT = 0xfffffffd;
const DIFAT = 0xfffffffc;
const MAX_READ_BYTES = 64 * 1024 * 1024;

export interface CompoundFile {
  readStream(name: string): Buffer | undefined;
}

function damaged(): never {
  throw new OfficeDocumentUnreadableError('damaged', 'Compound file is inconsistent or exceeds the read limit.');
}

function checked<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof OfficeDocumentUnreadableError) throw error;
    return damaged();
  }
}

// Sector ids are relative to the end of the padded header, including in v4.
export function readCompoundFile(bytes: Uint8Array): CompoundFile {
  return checked(() => openCompoundFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
}

function openCompoundFile(file: Buffer): CompoundFile {
  if (file.length < 512 || file.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') damaged();
  const major = file.readUInt16LE(26);
  const shift = file.readUInt16LE(30);
  if (file.readUInt16LE(28) !== 0xfffe || file.readUInt16LE(32) !== 6
    || !((major === 3 && shift === 9) || (major === 4 && shift === 12))
    || file.readUInt32LE(56) !== 4096) damaged();
  const sectorSize = 2 ** shift;
  // Some writers leave the last sector short; the missing tail reads as zeros.
  const sectorCount = Math.ceil(file.length / sectorSize) - 1;
  let totalRead = 0;
  const claimed = new Set<number>();
  const sector = (id: number): Buffer => {
    if (!Number.isInteger(id) || id < 0 || id >= sectorCount) damaged();
    totalRead += sectorSize;
    if (totalRead > MAX_READ_BYTES) damaged();
    const data = file.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
    if (data.length === sectorSize) return data;
    const padded = Buffer.alloc(sectorSize);
    data.copy(padded);
    return padded;
  };
  const claim = (id: number): void => {
    if (claimed.has(id)) damaged();
    claimed.add(id);
  };
  const fatCount = file.readUInt32LE(44);
  const difatCount = file.readUInt32LE(72);
  if (fatCount === 0 || fatCount > sectorCount || difatCount > sectorCount) damaged();
  const fatIds: number[] = [];
  const addFatId = (id: number): void => {
    if (id !== FREE) {
      if (fatIds.length >= fatCount) damaged();
      fatIds.push(id);
    }
  };
  for (let at = 76; at < 512; at += 4) addFatId(file.readUInt32LE(at));
  const difatIds: number[] = [];
  let next = file.readUInt32LE(68);
  for (let i = 0; i < difatCount; i += 1) {
    claim(next);
    difatIds.push(next);
    const data = sector(next);
    for (let at = 0; at < sectorSize - 4; at += 4) addFatId(data.readUInt32LE(at));
    next = data.readUInt32LE(sectorSize - 4);
  }
  if ((difatCount > 0 && next !== END) || (difatCount === 0 && next !== END && next !== FREE)
    || fatIds.length !== fatCount) damaged();
  const fats = fatIds.map((id) => { claim(id); return sector(id); });
  const fatAt = (id: number): number => {
    const entriesPerSector = sectorSize / 4;
    const part = fats[Math.floor(id / entriesPerSector)];
    if (id < 0 || id >= sectorCount || !part) damaged();
    return part.readUInt32LE((id % entriesPerSector) * 4);
  };
  for (const id of fatIds) if (fatAt(id) !== FAT) damaged();
  for (const id of difatIds) if (fatAt(id) !== DIFAT) damaged();
  const chain = (start: number, size?: number): Buffer => {
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_READ_BYTES)) damaged();
    const parts: Buffer[] = [];
    let id = start;
    while (id !== END) {
      if (parts.length >= sectorCount || (size !== undefined && parts.length >= Math.ceil(size / sectorSize))) damaged();
      claim(id);
      parts.push(sector(id));
      id = fatAt(id);
    }
    if (size !== undefined && parts.length !== Math.ceil(size / sectorSize)) damaged();
    return Buffer.concat(parts).subarray(0, size);
  };
  const directory = chain(file.readUInt32LE(48));
  if (directory.length === 0 || (major === 4 && directory.length / sectorSize !== file.readUInt32LE(40))
    || (major === 3 && file.readUInt32LE(40) !== 0)) damaged();
  const entry = (id: number) => {
    if (id >= directory.length / 128) damaged();
    const at = id * 128;
    const type = directory[at + 66]!;
    const nameBytes = directory.readUInt16LE(at + 64);
    if (nameBytes < 2 || nameBytes > 64 || nameBytes % 2 || directory.readUInt16LE(at + nameBytes - 2) !== 0) damaged();
    const size = directory.readUInt32LE(at + 120) + directory.readUInt32LE(at + 124) * 2 ** 32;
    if (!Number.isSafeInteger(size) || (major === 3 && directory.readUInt32LE(at + 124) !== 0)) damaged();
    return {
      name: directory.subarray(at, at + nameBytes - 2).toString('utf16le'), type, size,
      start: directory.readUInt32LE(at + 116), child: directory.readUInt32LE(at + 76),
      left: directory.readUInt32LE(at + 68), right: directory.readUInt32LE(at + 72),
    };
  };
  const root = entry(0);
  if (root.type !== 5) damaged();
  const streams = new Map<string, ReturnType<typeof entry>>();
  const pending = [root.child];
  const visited = new Set<number>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === FREE) continue;
    if (visited.has(id) || id === 0) damaged();
    visited.add(id);
    const item = entry(id);
    if (item.type !== 1 && item.type !== 2) damaged();
    pending.push(item.left, item.right);
    if (item.type === 2) {
      const key = item.name.toLowerCase();
      // A stream's child field is meaningless; some writers leave it zero.
      if (streams.has(key)) damaged();
      streams.set(key, item);
    }
  }
  const miniFatCount = file.readUInt32LE(64);
  if (miniFatCount > sectorCount) damaged();
  const miniFat = chain(file.readUInt32LE(60), miniFatCount * sectorSize);
  let miniStream: Buffer | undefined;
  const miniClaimed = new Set<number>();
  const cache = new Map<string, Buffer>();
  return {
    readStream(name) {
      return checked(() => {
        const key = name.toLowerCase();
        const item = streams.get(key);
        if (!item) return undefined;
        const previous = cache.get(key);
        if (previous) return previous;
        let data: Buffer;
        if (item.size >= 4096) data = chain(item.start, item.size);
        else if (item.size === 0) {
          if (item.start !== END) damaged();
          data = Buffer.alloc(0);
        } else {
          miniStream ??= chain(root.start, root.size);
          const parts: Buffer[] = [];
          let id = item.start;
          while (id !== END) {
            if (parts.length >= Math.ceil(item.size / 64) || miniClaimed.has(id)
              || id >= miniFat.length / 4 || (id + 1) * 64 > miniStream.length) damaged();
            miniClaimed.add(id);
            totalRead += 64;
            if (totalRead > MAX_READ_BYTES) damaged();
            parts.push(miniStream.subarray(id * 64, (id + 1) * 64));
            id = miniFat.readUInt32LE(id * 4);
          }
          if (parts.length !== Math.ceil(item.size / 64)) damaged();
          data = Buffer.concat(parts).subarray(0, item.size);
        }
        cache.set(key, data);
        return data;
      });
    },
  };
}
