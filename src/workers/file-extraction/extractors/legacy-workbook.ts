import { readCompoundFile } from './compound-file.ts';
import { OfficeDocumentUnreadableError } from './document-formats.ts';

export interface DocumentSheet {
  name: string;
  rows: string[][];
}

interface RecordPart {
  id: number;
  offset: number;
  data: Buffer;
}

export function readLegacyWorkbook(bytes: Uint8Array): DocumentSheet[] {
  try {
    return decodeWorkbook(bytes);
  } catch (error) {
    if (error instanceof OfficeDocumentUnreadableError) throw error;
    throw new OfficeDocumentUnreadableError('damaged', 'Workbook records are malformed.');
  }
}

function decodeWorkbook(bytes: Uint8Array): DocumentSheet[] {
  const file = readCompoundFile(bytes);
  const stream = file.readStream('Workbook') ?? file.readStream('Book');
  if (!stream) throw new OfficeDocumentUnreadableError('damaged', 'Workbook stream is missing.');
  const records: RecordPart[] = [];
  let at = 0;
  while (at + 4 <= stream.length) {
    const id = stream.readUInt16LE(at);
    const length = stream.readUInt16LE(at + 2);
    if (id === 0 && length === 0 && stream.subarray(at).every((byte) => byte === 0)) break;
    // Bytes past the last whole record are padding; a cut-off sheet still fails its EOF check.
    if (at + 4 + length > stream.length) break;
    if (records.length >= 1_000_000) throw new RangeError();
    records.push({ id, offset: at, data: stream.subarray(at + 4, at + 4 + length) });
    at += 4 + length;
  }
  if (records.some((record) => record.id === 0x002f)) {
    throw new OfficeDocumentUnreadableError('encrypted', 'Workbook is encrypted.');
  }
  const first = records[0];
  if (!first || ![0x0009, 0x0209, 0x0409, 0x0809].includes(first.id)) throw new RangeError();
  if (first.id !== 0x0809 || first.data.readUInt16LE(0) !== 0x0600) {
    throw new OfficeDocumentUnreadableError('unsupported', 'Workbook versions before BIFF8 are unsupported.');
  }
  if (first.data.readUInt16LE(2) !== 5) throw new RangeError();
  const globalsEnd = records.findIndex((record) => record.id === 0x000a);
  if (globalsEnd < 0) throw new RangeError();
  const sheets: Array<{ name: string; offset: number }> = [];
  let strings: string[] = [];
  for (let i = 1; i < globalsEnd; i += 1) {
    const record = records[i]!;
    if (record.id === 0x0085) {
      const data = record.data;
      if (data[5] !== 0) continue;
      const chars = data.readUInt8(6);
      const wide = (data.readUInt8(7) & 1) !== 0;
      const size = chars * (wide ? 2 : 1);
      if (8 + size > data.length) throw new RangeError();
      sheets.push({ name: biffText(data.subarray(8, 8 + size), wide), offset: data.readUInt32LE(0) });
    } else if (record.id === 0x00fc) {
      const parts = [record.data];
      while (records[i + 1]?.id === 0x003c) parts.push(records[++i]!.data);
      strings = readSharedStrings(parts);
    }
  }
  const byOffset = new Map(records.map((record, index) => [record.offset, index]));
  let cellCount = 0;
  const sheetOffsets = new Set<number>();
  return sheets.map((sheet) => {
    if (sheetOffsets.has(sheet.offset)) throw new RangeError();
    sheetOffsets.add(sheet.offset);
    const index = byOffset.get(sheet.offset);
    const bof = index === undefined ? undefined : records[index];
    if (!bof || bof.id !== 0x0809 || bof.data.readUInt16LE(0) !== 0x0600 || bof.data.readUInt16LE(2) !== 0x0010) throw new RangeError();
    const rows = new Map<number, string[]>();
    const put = (row: number, column: number, value: string): void => {
      if (column > 255 || ++cellCount > 500_000) throw new RangeError();
      const cells = rows.get(row) ?? [];
      while (cells.length <= column) cells.push('');
      cells[column] = value;
      rows.set(row, cells);
    };
    let ended = false;
    for (let i = index! + 1; i < records.length; i += 1) {
      const { id, data } = records[i]!;
      if (id === 0x000a) { ended = true; break; }
      if (id === 0x0809) throw new RangeError();
      if (![0x00fd, 0x0204, 0x0203, 0x027e, 0x00bd, 0x0205, 0x0006].includes(id)) continue;
      const row = data.readUInt16LE(0);
      const column = data.readUInt16LE(2);
      if (id === 0x00fd) {
        const value = strings[data.readUInt32LE(6)];
        if (value === undefined) throw new RangeError();
        put(row, column, value);
      } else if (id === 0x0204) {
        const count = data.readUInt16LE(6);
        const wide = (data.readUInt8(8) & 1) !== 0;
        const end = 9 + count * (wide ? 2 : 1);
        if (end > data.length) throw new RangeError();
        put(row, column, biffText(data.subarray(9, end), wide));
      } else if (id === 0x0006) {
        const value = formulaResult(data, records, i);
        if (value !== undefined) put(row, column, value);
      } else if (id === 0x0203) put(row, column, finiteNumber(data.readDoubleLE(6)));
      else if (id === 0x027e) put(row, column, decodeRk(data.readUInt32LE(6)));
      else if (id === 0x00bd) {
        const last = data.readUInt16LE(data.length - 2);
        if (last < column || last > 255 || data.length !== 6 + (last - column + 1) * 6) throw new RangeError();
        for (let col = column; col <= last; col += 1) put(row, col, decodeRk(data.readUInt32LE(6 + (col - column) * 6)));
      } else {
        const value = data.readUInt8(6);
        const error = data.readUInt8(7);
        if (error > 1 || (error === 0 && value > 1)) throw new RangeError();
        put(row, column, error ? biffError(value) : value ? 'TRUE' : 'FALSE');
      }
    }
    if (!ended) throw new RangeError();
    return { name: sheet.name, rows: [...rows].sort(([a], [b]) => a - b).map(([, cells]) => cells) };
  });
}

// Compressed BIFF8 strings contain Unicode low bytes, not a code page.
function biffText(bytes: Buffer, wide: boolean): string {
  return bytes.toString(wide ? 'utf16le' : 'latin1');
}

function finiteNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError();
  return String(value);
}

// A FORMULA record carries its last calculated result; a text result follows in a STRING record.
function formulaResult(data: Buffer, records: RecordPart[], index: number): string | undefined {
  if (data.length < 14) throw new RangeError();
  if (data.readUInt16LE(12) !== 0xffff) return finiteNumber(data.readDoubleLE(6));
  const kind = data[6]!;
  if (kind === 1) return data[8] ? 'TRUE' : 'FALSE';
  if (kind === 2) return biffError(data[8]!);
  if (kind === 3) return undefined;
  if (kind !== 0) throw new RangeError();
  let next = index + 1;
  // Shared and array formula records may sit between the formula and its text result.
  while (records[next]?.id === 0x04bc || records[next]?.id === 0x0221) next += 1;
  const text = records[next];
  if (text?.id !== 0x0207 || text.data.length < 3) throw new RangeError();
  const chars = text.data.readUInt16LE(0);
  const wide = (text.data[2]! & 1) !== 0;
  const available = Math.floor((text.data.length - 3) / (wide ? 2 : 1));
  return biffText(text.data.subarray(3, 3 + Math.min(chars, available) * (wide ? 2 : 1)), wide);
}

function decodeRk(rk: number): string {
  let value: number;
  if (rk & 2) value = rk >> 2;
  else {
    const data = Buffer.alloc(8);
    data.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    value = data.readDoubleLE();
  }
  return finiteNumber(rk & 1 ? value / 100 : value);
}

function biffError(value: number): string {
  const errors: Record<number, string> = {
    0: '#NULL!', 7: '#DIV/0!', 15: '#VALUE!', 23: '#REF!', 29: '#NAME?', 36: '#NUM!', 42: '#N/A',
  };
  const text = errors[value];
  if (text === undefined) throw new RangeError();
  return text;
}

function readSharedStrings(parts: Buffer[]): string[] {
  let part = 0;
  let at = 0;
  const advance = (): void => {
    while (part < parts.length && at === parts[part]!.length) { part += 1; at = 0; }
    if (part >= parts.length) throw new RangeError();
  };
  const byte = (): number => { advance(); return parts[part]![at++]!; };
  const u16 = (): number => byte() + byte() * 256;
  const u32 = (): number => u16() + u16() * 65536;
  const skip = (count: number): void => {
    while (count > 0) {
      advance();
      const size = Math.min(count, parts[part]!.length - at);
      at += size;
      count -= size;
    }
  };
  u32();
  const unique = u32();
  if (unique > parts.reduce((sum, data) => sum + data.length, 0) / 3) throw new RangeError();
  const strings: string[] = [];
  let totalChars = 0;
  for (let i = 0; i < unique; i += 1) {
    const chars = u16();
    const flags = byte();
    let wide = (flags & 1) !== 0;
    const runs = flags & 8 ? u16() : 0;
    const extension = flags & 4 ? u32() : 0;
    totalChars += chars;
    if (totalChars > 8_000_000) throw new RangeError();
    const chunks: string[] = [];
    let remaining = chars;
    while (remaining > 0) {
      if (at === parts[part]!.length) {
        part += 1;
        at = 0;
        if (!parts[part]?.length) throw new RangeError();
        const option = byte();
        if (option > 1) throw new RangeError();
        wide = option === 1;
      }
      const size = Math.min(remaining, Math.floor((parts[part]!.length - at) / (wide ? 2 : 1)));
      if (size === 0) throw new RangeError();
      const end = at + size * (wide ? 2 : 1);
      chunks.push(biffText(parts[part]!.subarray(at, end), wide));
      at = end;
      remaining -= size;
    }
    skip(runs * 4 + extension);
    strings.push(chunks.join(''));
  }
  return strings;
}
