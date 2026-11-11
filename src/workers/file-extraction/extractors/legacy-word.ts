import { readCompoundFile } from './compound-file.ts';
import { OfficeDocumentUnreadableError } from './document-formats.ts';

export function readLegacyWord(bytes: Uint8Array): string {
  try {
    return decodeLegacyWord(bytes);
  } catch (error) {
    if (error instanceof OfficeDocumentUnreadableError) throw error;
    throw new OfficeDocumentUnreadableError('damaged', 'Word piece table is malformed.');
  }
}

function decodeLegacyWord(bytes: Uint8Array): string {
  const file = readCompoundFile(bytes);
  const word = file.readStream('WordDocument');
  if (!word || ![0xa5ec, 0xa5dc, 0xa697].includes(word.readUInt16LE(0))) {
    throw new OfficeDocumentUnreadableError('damaged', 'Word document stream is missing or malformed.');
  }
  if (word.readUInt16LE(0) !== 0xa5ec || word.readUInt16LE(2) < 0x00c0) {
    throw new OfficeDocumentUnreadableError('unsupported', 'Word versions before Word 97 are unsupported.');
  }
  const flags = word.readUInt16LE(10);
  if (flags & 0x8100) throw new OfficeDocumentUnreadableError('encrypted', 'Word document is encrypted.');
  const table = file.readStream(flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new OfficeDocumentUnreadableError('unsupported', 'Word piece table is missing.');
  const cslwAt = 34 + word.readUInt16LE(32) * 2;
  const pairsAt = cslwAt + 2 + word.readUInt16LE(cslwAt) * 4;
  if (word.readUInt16LE(pairsAt) <= 33) {
    throw new OfficeDocumentUnreadableError('unsupported', 'Word piece table is missing.');
  }
  const fcClxAt = pairsAt + 2 + 33 * 8;
  const offset = word.readUInt32LE(fcClxAt);
  const length = word.readUInt32LE(fcClxAt + 4);
  if (length === 0) throw new OfficeDocumentUnreadableError('unsupported', 'Word piece table is missing.');
  if (offset + length > table.length) throw new RangeError();
  const clx = table.subarray(offset, offset + length);
  let at = 0;
  while (clx[at] === 1) at += 3 + clx.readUInt16LE(at + 1);
  if (at >= clx.length) throw new OfficeDocumentUnreadableError('unsupported', 'Word piece table is missing.');
  if (clx[at] !== 2) throw new RangeError();
  const plcLength = clx.readUInt32LE(at + 1);
  if (plcLength < 4 || (plcLength - 4) % 12 || at + 5 + plcLength !== clx.length) throw new RangeError();
  const plc = clx.subarray(at + 5);
  const count = (plcLength - 4) / 12;
  const pieces: string[] = [];
  let decodedBytes = 0;
  if (plc.readUInt32LE(0) !== 0) throw new RangeError();
  for (let i = 0; i < count; i += 1) {
    const chars = plc.readUInt32LE((i + 1) * 4) - plc.readUInt32LE(i * 4);
    const fc = plc.readUInt32LE((count + 1) * 4 + i * 8 + 2);
    const compressed = (fc & 0x40000000) !== 0;
    const start = (fc & 0x3fffffff) / (compressed ? 2 : 1);
    const size = chars * (compressed ? 1 : 2);
    decodedBytes += size;
    if (chars < 0 || !Number.isInteger(start) || start + size > word.length || decodedBytes > 64 * 1024 * 1024) throw new RangeError();
    const data = word.subarray(start, start + size);
    pieces.push(compressed ? new TextDecoder('windows-1252').decode(data) : data.toString('utf16le'));
  }
  return wordControlsToText(pieces.join(''));
}

function wordControlsToText(input: string): string {
  const fields: boolean[] = [];
  let hidden = 0;
  const text: string[] = [];
  let start = 0;
  for (let at = 0; at < input.length; at += 1) {
    const code = input.charCodeAt(at);
    if (code >= 32 || code === 9 || code === 10) continue;
    if (!hidden) text.push(input.slice(start, at));
    if (code === 0x13) { fields.push(true); hidden += 1; }
    else if (code === 0x14) {
      if (fields.at(-1)) { fields[fields.length - 1] = false; hidden -= 1; }
    } else if (code === 0x15) { if (fields.pop()) hidden -= 1; }
    else if (!hidden) {
      if (code === 7) text.push('\t');
      else if (code === 11 || code === 12 || code === 13 || code === 14) text.push('\n');
    }
    start = at + 1;
  }
  if (!hidden) text.push(input.slice(start));
  return text.join('');
}
