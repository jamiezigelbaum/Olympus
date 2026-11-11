import { describe, expect, test } from 'bun:test';
import { fileMimeTypeFromName } from '../src/core/file-mime.ts';
import {
  DOC_MIME_TYPE, XLS_MIME_TYPE, ODT_MIME_TYPE, ODS_MIME_TYPE, ODP_MIME_TYPE, EPUB_MIME_TYPE,
} from '../src/workers/file-extraction/extractors/bounded-text.ts';
import { readCompoundFile } from '../src/workers/file-extraction/extractors/compound-file.ts';
import { OfficeDocumentUnreadableError } from '../src/workers/file-extraction/extractors/document-formats.ts';
import { createTextExtractor, textLaneAccepts, TEXT_EXTRACTOR_VERSION } from '../src/workers/file-extraction/extractors/text.ts';
import { extractorInput, storedZipBytes } from './fixtures/file-extraction-extractor-fixtures.ts';

const END = 0xfffffffe;
const FREE = 0xffffffff;

// A CFB writer independent of the reader, with mini streams and extended DIFAT.
function compoundFile(streams: Record<string, Buffer>, sectorSize = 512): Buffer {
  const sectors: Buffer[] = [];
  const links: number[] = [];
  const allocate = (data: Buffer): number => {
    if (!data.length) return END;
    const start = sectors.length;
    for (let at = 0; at < data.length; at += sectorSize) {
      const sector = Buffer.alloc(sectorSize);
      data.copy(sector, 0, at, at + sectorSize);
      sectors.push(sector);
      links.push(at + sectorSize < data.length ? sectors.length : END);
    }
    return start;
  };
  const directory = Buffer.alloc(Math.ceil((Object.keys(streams).length + 1) / (sectorSize / 128)) * sectorSize);
  const directoryStart = allocate(directory);
  const entries = Object.entries(streams);
  const miniParts: Buffer[] = [];
  const miniLinks: number[] = [];
  const streamStarts = entries.map(([, data]) => {
    if (data.length >= 4096) return allocate(data);
    if (!data.length) return END;
    const start = miniLinks.length;
    for (let at = 0; at < data.length; at += 64) {
      const part = Buffer.alloc(64);
      data.copy(part, 0, at, at + 64);
      miniParts.push(part);
      miniLinks.push(at + 64 < data.length ? miniLinks.length + 1 : END);
    }
    return start;
  });
  const miniStream = Buffer.concat(miniParts);
  const miniStart = allocate(miniStream);
  const miniFat = Buffer.alloc(Math.ceil(miniLinks.length / (sectorSize / 4)) * sectorSize, 0xff);
  miniLinks.forEach((link, index) => miniFat.writeUInt32LE(link, index * 4));
  const miniFatStart = allocate(miniFat);
  const entry = (index: number, name: string, type: number, start: number, size: number, right = FREE, child = FREE): void => {
    const at = index * 128;
    directory.write(name + '\0', at, 'utf16le');
    directory.writeUInt16LE((name.length + 1) * 2, at + 64);
    directory[at + 66] = type;
    directory[at + 67] = 1;
    directory.writeUInt32LE(FREE, at + 68);
    directory.writeUInt32LE(right, at + 72);
    directory.writeUInt32LE(child, at + 76);
    directory.writeUInt32LE(start, at + 116);
    directory.writeUInt32LE(size, at + 120);
  };
  entry(0, 'Root Entry', 5, miniStart, miniStream.length, FREE, entries.length ? 1 : FREE);
  entries.forEach(([name, data], i) => entry(i + 1, name, 2, streamStarts[i]!, data.length, i + 1 < entries.length ? i + 2 : FREE));
  for (let i = 0; i < directory.length / sectorSize; i += 1) directory.copy(sectors[directoryStart + i]!, 0, i * sectorSize, (i + 1) * sectorSize);
  let fatCount = 1;
  let difatCount = 0;
  while (true) {
    const nextDifat = Math.ceil(Math.max(0, fatCount - 109) / (sectorSize / 4 - 1));
    const nextFat = Math.ceil((sectors.length + fatCount + nextDifat) / (sectorSize / 4));
    if (nextFat === fatCount && nextDifat === difatCount) break;
    fatCount = nextFat;
    difatCount = nextDifat;
  }
  const fatStart = sectors.length;
  const difatStart = fatStart + fatCount;
  const fat = Buffer.alloc(fatCount * sectorSize, 0xff);
  links.forEach((link, index) => fat.writeUInt32LE(link, index * 4));
  for (let i = 0; i < fatCount; i += 1) fat.writeUInt32LE(0xfffffffd, (fatStart + i) * 4);
  for (let i = 0; i < difatCount; i += 1) fat.writeUInt32LE(0xfffffffc, (difatStart + i) * 4);
  for (let i = 0; i < fatCount; i += 1) sectors.push(fat.subarray(i * sectorSize, (i + 1) * sectorSize));
  for (let i = 0; i < difatCount; i += 1) {
    const data = Buffer.alloc(sectorSize, 0xff);
    for (let j = 0; j < sectorSize / 4 - 1; j += 1) {
      const index = 109 + i * (sectorSize / 4 - 1) + j;
      if (index < fatCount) data.writeUInt32LE(fatStart + index, j * 4);
    }
    data.writeUInt32LE(i + 1 < difatCount ? difatStart + i + 1 : END, sectorSize - 4);
    sectors.push(data);
  }
  const header = Buffer.alloc(sectorSize);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header);
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(sectorSize === 512 ? 3 : 4, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(sectorSize === 512 ? 9 : 12, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(sectorSize === 512 ? 0 : directory.length / sectorSize, 40);
  header.writeUInt32LE(fatCount, 44);
  header.writeUInt32LE(directoryStart, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(miniFat.length / sectorSize, 64);
  header.writeUInt32LE(difatCount ? difatStart : END, 68);
  header.writeUInt32LE(difatCount, 72);
  for (let i = 0; i < 109; i += 1) header.writeUInt32LE(i < fatCount ? fatStart + i : FREE, 76 + i * 4);
  return Buffer.concat([header, ...sectors]);
}

function wordStreams(options: { encrypted?: boolean; old?: boolean; missingTable?: boolean; table1?: boolean } = {}): Record<string, Buffer> {
  const first = Buffer.from('First paragraph\rSecond paragraph\rCell\x07\x13 MERGEFIELD code\x14Visible\x15\r', 'latin1');
  const second = Buffer.from('雪と café\r', 'utf16le');
  const word = Buffer.alloc(2048);
  word.writeUInt16LE(options.old ? 0xa5dc : 0xa5ec, 0);
  word.writeUInt16LE(options.old ? 0x0065 : 0x00c1, 2);
  word.writeUInt16LE((options.encrypted ? 0x0100 : 0) | (options.table1 ? 0x0200 : 0), 10);
  word.writeUInt16LE(14, 32);
  word.writeUInt16LE(22, 62);
  word.writeUInt16LE(34, 152);
  first.copy(word, 1024);
  second.copy(word, 1280);
  const table = Buffer.alloc(33);
  table[0] = 2;
  table.writeUInt32LE(28, 1);
  table.writeUInt32LE(0, 5);
  table.writeUInt32LE(first.length, 9);
  table.writeUInt32LE(first.length + second.length / 2, 13);
  table.writeUInt32LE(0x40000000 | 2048, 19);
  table.writeUInt32LE(1280, 27);
  word.writeUInt32LE(0, 418);
  word.writeUInt32LE(options.missingTable ? 0 : table.length, 422);
  return { WordDocument: word, [options.table1 ? '1Table' : '0Table']: table };
}

function record(id: number, data = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

function bof(type: number, version = 0x0600): Buffer {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(version, 0);
  data.writeUInt16LE(type, 2);
  return record(0x0809, data);
}

function cell(id: number, row: number, col: number, value: Buffer): Buffer {
  const data = Buffer.alloc(6);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(col, 2);
  return record(id, Buffer.concat([data, value]));
}

function workbook(options: { encrypted?: boolean; old?: boolean } = {}): Buffer {
  const bound = (name: string): Buffer => {
    const data = Buffer.alloc(8 + name.length);
    data[6] = name.length;
    data.write(name, 8, 'latin1');
    return record(0x0085, data);
  };
  const a = bound('Stock');
  const b = bound('Totals');
  const header = Buffer.alloc(13);
  header.writeUInt32LE(2, 0);
  header.writeUInt32LE(1, 4);
  header.writeUInt16LE(6, 8);
  header[10] = 0;
  header.write('Sh', 11, 'latin1');
  const sst = record(0x00fc, header);
  const continuation = record(0x003c, Buffer.concat([Buffer.from([1]), Buffer.from('ared', 'utf16le')]));
  const index = Buffer.alloc(4);
  const number = Buffer.alloc(8);
  number.writeDoubleLE(12.5);
  const rk = Buffer.alloc(4);
  rk.writeUInt32LE((42 << 2) | 2);
  const firstSheet = Buffer.concat([bof(16), cell(0x00fd, 0, 0, index), cell(0x0203, 1, 0, number), record(10)]);
  const secondSheet = Buffer.concat([bof(16), cell(0x00fd, 0, 0, index), cell(0x027e, 1, 0, rk), record(10)]);
  const globals = Buffer.concat([bof(5, options.old ? 0x0500 : 0x0600), a, b, sst, continuation,
    ...(options.encrypted ? [record(0x002f, Buffer.from([0, 0]))] : []), record(10)]);
  globals.writeUInt32LE(globals.length, 24);
  globals.writeUInt32LE(globals.length + firstSheet.length, 24 + a.length);
  return Buffer.concat([globals, firstSheet, secondSheet]);
}

function singleSheet(cells: Buffer[], globals: Buffer[] = []): Buffer {
  const bound = Buffer.alloc(12);
  bound[6] = 4;
  bound.write('Data', 8);
  const prefix = Buffer.concat([bof(5), record(0x0085, bound), ...globals, record(10)]);
  prefix.writeUInt32LE(prefix.length, 24);
  return Buffer.concat([prefix, bof(16), ...cells, record(10)]);
}

async function extract(bytes: Uint8Array, mimeType: string, options: Parameters<typeof createTextExtractor>[0] = {}) {
  return createTextExtractor(options).extract(extractorInput({ bytes, mimeType }));
}

function reason(read: () => unknown): string {
  try { read(); return 'no error'; }
  catch (error) {
    expect(error).toBeInstanceOf(OfficeDocumentUnreadableError);
    return (error as OfficeDocumentUnreadableError).reason;
  }
}

describe('legacy Office', () => {
  test('Word keeps paragraphs, cells, field results and a UTF-16 piece', async () => {
    const output = await extract(compoundFile(wordStreams()), DOC_MIME_TYPE);
    expect(output.status).toBe('indexed');
    expect(output.text).toBe('First paragraph\nSecond paragraph\nCell\tVisible\n雪と café');
    expect(output.derivations?.[0]?.structuralRef?.kind).toBe('whole_file');
  });

  test('Word compressed pieces decode Windows-1252 punctuation', async () => {
    const streams = wordStreams();
    streams.WordDocument![1024] = 0x80;
    streams.WordDocument![1025] = 0x93;
    const output = await extract(compoundFile(streams), DOC_MIME_TYPE);
    expect(output.text).toBe('€“rst paragraph\nSecond paragraph\nCell\tVisible\n雪と café');
  });

  test('Word rejects piece ranges beyond the document', async () => {
    const streams = wordStreams();
    streams['0Table']!.writeUInt32LE(0x40010000, 19);
    expect(await extract(compoundFile(streams), DOC_MIME_TYPE)).toEqual({
      status: 'failed_terminal', errorKind: 'office_document_damaged',
    });
  });

  test('Word selects 1Table, and bounds text with a truncation warning', async () => {
    const output = await extract(compoundFile(wordStreams({ table1: true })), DOC_MIME_TYPE, { maxBoundedTextChars: 15 });
    expect(output.text).toBe('First paragraph');
    expect(output.warnings).toContain('bounded_text_truncated');
  });

  test.each([
    [{ encrypted: true }, 'encrypted'], [{ old: true }, 'unsupported'], [{ missingTable: true }, 'unsupported'],
  ] as const)('Word reports %j as %s', async (options, error) => {
    expect(await extract(compoundFile(wordStreams(options)), DOC_MIME_TYPE)).toEqual({
      status: 'failed_terminal', errorKind: `office_document_${error}`,
    });
  });

  test('BIFF8 sheet names, continued shared strings, NUMBER and RK', async () => {
    const output = await extract(compoundFile({ Workbook: workbook() }), XLS_MIME_TYPE);
    expect(output.status).toBe('indexed');
    expect(output.text).toBe('XLS Stock\nRows: 2\nColumns: 1\nSample:\nShared\n12.5\n\nXLS Totals\nRows: 2\nColumns: 1\nSample:\nShared\n42');
    expect(output.derivations?.map((part) => part.structuralRef?.label)).toEqual(['Stock', 'Totals']);
  });

  test('rich and extended SST strings continue across text and formatting boundaries', async () => {
    const counts = Buffer.alloc(8);
    counts.writeUInt32LE(2, 0);
    counts.writeUInt32LE(2, 4);
    const rich = Buffer.from([4, 0, 0x0d, 2, 0, 3, 0, 0, 0]);
    const sst = record(0x00fc, Buffer.concat([counts, rich, Buffer.from('Ri', 'utf16le')]));
    const first = record(0x003c, Buffer.from([0, 99, 104, 0, 0, 0]));
    const second = record(0x003c, Buffer.concat([Buffer.alloc(8), Buffer.from([5, 0, 0]), Buffer.from('Plain')]));
    const bytes = singleSheet([
      cell(0x00fd, 0, 0, Buffer.from([0, 0, 0, 0])),
      cell(0x00fd, 1, 0, Buffer.from([1, 0, 0, 0])),
    ], [sst, first, second]);
    const output = await extract(compoundFile({ Workbook: bytes }), XLS_MIME_TYPE);
    expect(output.text).toBe('XLS Data\nRows: 2\nColumns: 1\nSample:\nRich\nPlain');
  });

  test('LABEL, MULRK, scaled and floating RK, boolean and error cells', async () => {
    const mulrk = Buffer.alloc(18);
    mulrk.writeUInt16LE(1, 0);
    mulrk.writeUInt32LE(((-7 << 2) | 2) >>> 0, 6);
    mulrk.writeUInt32LE((1234 << 2) | 3, 12);
    mulrk.writeUInt16LE(1, 16);
    const floatRk = Buffer.alloc(4);
    floatRk.writeUInt32LE(0x3ff80000);
    const bytes = singleSheet([
      cell(0x0204, 0, 0, Buffer.from([1, 0, 0, 0xc9])),
      record(0x00bd, mulrk),
      cell(0x0205, 2, 0, Buffer.from([1, 0])),
      cell(0x0205, 2, 1, Buffer.from([7, 1])),
      cell(0x027e, 3, 0, floatRk),
    ]);
    const output = await extract(compoundFile({ Workbook: bytes }), XLS_MIME_TYPE);
    expect(output.text).toBe('XLS Data\nRows: 4\nColumns: 2\nSample:\nÉ\n-7 | 12.34\nTRUE | #DIV/0!\n1.5');
  });

  test('formula cells keep their cached results', async () => {
    const formula = (row: number, col: number, result: Buffer): Buffer => cell(0x0006, row, col,
      Buffer.concat([result, Buffer.alloc(6), Buffer.from([3, 0, 0x1e, 42, 0])]));
    const special = (kind: number, value = 0): Buffer => Buffer.from([kind, 0, value, 0, 0, 0, 0xff, 0xff]);
    const number = Buffer.alloc(8);
    number.writeDoubleLE(42);
    const bytes = singleSheet([
      formula(0, 0, number),
      formula(0, 1, special(0)),
      record(0x04bc, Buffer.alloc(8)),
      record(0x0207, Buffer.concat([Buffer.from([5, 0, 0]), Buffer.from('Total')])),
      formula(1, 0, special(1, 1)),
      formula(1, 1, special(2, 42)),
      formula(1, 2, special(3)),
    ]);
    const output = await extract(compoundFile({ Workbook: bytes }), XLS_MIME_TYPE);
    expect(output.text).toBe('XLS Data\nRows: 2\nColumns: 2\nSample:\n42 | Total\nTRUE | #N/A');
    const orphan = singleSheet([formula(0, 0, special(0))]);
    expect(await extract(compoundFile({ Workbook: orphan }), XLS_MIME_TYPE)).toEqual({
      status: 'failed_terminal', errorKind: 'office_document_damaged',
    });
  });

  test('padding after the last record is ignored; a sheet cut before its end is damaged', async () => {
    const label = cell(0x0204, 0, 0, Buffer.from([2, 0, 0, 0x4f, 0x4b]));
    const padded = Buffer.concat([singleSheet([label]), Buffer.from([0x01, 0x02, 0x03])]);
    expect((await extract(compoundFile({ Workbook: padded }), XLS_MIME_TYPE)).text).toBe('XLS Data\nRows: 1\nColumns: 1\nSample:\nOK');
    const cut = singleSheet([label]).subarray(0, -4);
    expect(await extract(compoundFile({ Workbook: Buffer.concat([cut, Buffer.from([0x0a, 0x00, 0x09])]) }), XLS_MIME_TYPE)).toEqual({
      status: 'failed_terminal', errorKind: 'office_document_damaged',
    });
  });

  test('truncated SST continuation is damaged', async () => {
    const data = Buffer.from([1, 0, 0, 0, 1, 0, 0, 0, 8, 0, 1, 65, 0]);
    const bytes = singleSheet([], [record(0x00fc, data)]);
    expect(await extract(compoundFile({ Workbook: bytes }), XLS_MIME_TYPE)).toEqual({
      status: 'failed_terminal', errorKind: 'office_document_damaged',
    });
  });

  test('duplicate worksheet offsets are damaged', async () => {
    const bytes = workbook();
    bytes.writeUInt32LE(bytes.readUInt32LE(24), 41);
    expect(await extract(compoundFile({ Workbook: bytes }), XLS_MIME_TYPE)).toEqual({
      status: 'failed_terminal', errorKind: 'office_document_damaged',
    });
  });

  test('Book alias and table sample warnings', async () => {
    const output = await extract(compoundFile({ Book: workbook() }), XLS_MIME_TYPE, { maxTableSampleRows: 1 });
    expect(output.warnings).toContain('row_sample_truncated');
    expect(output.text).toContain('Warnings: row_sample_truncated');
    expect(output.text).not.toContain('12.5');
  });

  test.each([[{ encrypted: true }, 'encrypted'], [{ old: true }, 'unsupported']] as const)('Workbook reports %j as %s', async (options, error) => {
    expect(await extract(compoundFile({ Workbook: workbook(options) }), XLS_MIME_TYPE)).toEqual({
      status: 'failed_terminal', errorKind: `office_document_${error}`,
    });
  });
});

describe('compound file bounds', () => {
  test.each([512, 4096])('reads normal and mini streams with %i-byte sectors', (sectorSize) => {
    const file = readCompoundFile(compoundFile({ Large: Buffer.alloc(6000, 65), Tiny: Buffer.from('small') }, sectorSize));
    expect(file.readStream('large')?.length).toBe(6000);
    expect(file.readStream('Tiny')?.toString()).toBe('small');
    expect(file.readStream('absent')).toBeUndefined();
  });

  test('a short last sector reads as zeros', () => {
    const whole = compoundFile({ Large: Buffer.alloc(6000, 65), Tiny: Buffer.from('small') });
    // The last sector is the FAT, whose tail holds only unused entries.
    expect(whole.subarray(-100).every((byte) => byte === 0xff)).toBe(true);
    const file = readCompoundFile(whole.subarray(0, -100));
    expect(file.readStream('Large')?.equals(Buffer.alloc(6000, 65))).toBe(true);
    expect(file.readStream('Tiny')?.toString()).toBe('small');
  });

  test('a stream whose child field is zero still reads', () => {
    const bytes = compoundFile({ Tiny: Buffer.from('small') });
    const directory = (bytes.readUInt32LE(48) + 1) * 512;
    bytes.writeUInt32LE(0, directory + 128 + 76);
    expect(readCompoundFile(bytes).readStream('Tiny')?.toString()).toBe('small');
  });

  test('reads extended DIFAT', () => {
    const file = readCompoundFile(compoundFile({ Large: Buffer.alloc(8 * 1024 * 1024, 65) }));
    expect(file.readStream('Large')?.length).toBe(8 * 1024 * 1024);
  });

  test('truncated and overlong stream chains are damaged', () => {
    const short = compoundFile({ Large: Buffer.alloc(6000) });
    const fat = (short.readUInt32LE(76) + 1) * 512;
    short.writeUInt32LE(END, fat + 4);
    expect(reason(() => readCompoundFile(short).readStream('Large'))).toBe('damaged');
    const extra = compoundFile({ Large: Buffer.alloc(4096), Other: Buffer.alloc(4096) });
    const extraFat = (extra.readUInt32LE(76) + 1) * 512;
    extra.writeUInt32LE(9, extraFat + 8 * 4);
    expect(reason(() => readCompoundFile(extra).readStream('Large'))).toBe('damaged');
  });

  test('oversized stream declarations and directory loops are damaged', () => {
    const huge = compoundFile({ Tiny: Buffer.from('small') });
    huge.writeUInt32LE(64 * 1024 * 1024 + 1, 512 + 128 + 120);
    expect(reason(() => readCompoundFile(huge).readStream('Tiny'))).toBe('damaged');
    const loop = compoundFile({ Tiny: Buffer.from('small') });
    loop.writeUInt32LE(1, 512 + 128 + 72);
    expect(reason(() => readCompoundFile(loop))).toBe('damaged');
  });

  test('looping FAT is damaged', async () => {
    const bytes = compoundFile({ Workbook: Buffer.alloc(4096) });
    const fatOffset = (bytes.readUInt32LE(76) + 1) * 512;
    bytes.writeUInt32LE(1, fatOffset + 4);
    expect(reason(() => readCompoundFile(bytes).readStream('Workbook'))).toBe('damaged');
    expect(await extract(bytes, XLS_MIME_TYPE)).toEqual({ status: 'failed_terminal', errorKind: 'office_document_damaged' });
  });

  test('looping mini FAT, out-of-file sectors and short headers are damaged', () => {
    const bytes = compoundFile({ Tiny: Buffer.alloc(128) });
    const miniFatOffset = (bytes.readUInt32LE(60) + 1) * 512;
    bytes.writeUInt32LE(0, miniFatOffset);
    expect(reason(() => readCompoundFile(bytes).readStream('Tiny'))).toBe('damaged');
    const invalid = compoundFile({ Tiny: Buffer.from('small') });
    invalid.writeUInt32LE(0xfffffff0, 48);
    expect(reason(() => readCompoundFile(invalid))).toBe('damaged');
    expect(reason(() => readCompoundFile(Buffer.alloc(20)))).toBe('damaged');
  });
});

const odt = '<office:document-content><office:body><office:text><text:h>Heading</text:h><text:p>One &amp; two</text:p><text:list><text:list-item><text:p>Entry</text:p></text:list-item></text:list><table:table><table:table-row><table:table-cell><text:p>Cell</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>';
const ods = '<office:document-content><table:table table:name="Stock"><table:table-row><table:table-cell><text:p>Item</text:p></table:table-cell><table:table-cell><text:p>Count</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>Tools</text:p></table:table-cell><table:table-cell office:value="7"/></table:table-row></table:table></office:document-content>';
const odp = '<office:document-content><draw:page draw:name="one"><text:p>First slide</text:p></draw:page><draw:page draw:name="two"><text:p>Second slide</text:p></draw:page></office:document-content>';

function epubParts(): Record<string, string> {
  return {
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    'OPS/book.opf': '<package><manifest><item id="a" href="chapters/a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="chapters/b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
    'OPS/chapters/a.xhtml': '<html><head><title>Hidden title</title><style>hidden style</style></head><body><p>Last &amp; &#x96EA;</p><script>hidden script</script></body></html>',
    'OPS/chapters/b.xhtml': '<html><body><h1>First</h1><p>Chapter&nbsp;two.</p></body></html>',
  };
}

describe('OpenDocument and EPUB', () => {
  test('ODT paragraphs, headings, lists and table cells', async () => {
    const output = await extract(storedZipBytes({ 'content.xml': odt }), ODT_MIME_TYPE);
    expect(output.status).toBe('indexed');
    expect(output.text).toBe('Heading\nOne & two\nEntry\nCell');
  });

  test('ODS tables share the sheet summary path', async () => {
    const output = await extract(storedZipBytes({ 'content.xml': ods }), ODS_MIME_TYPE);
    expect(output.text).toBe('ODS Stock\nRows: 2\nColumns: 2\nSample:\nItem | Count\nTools | 7');
  });

  test('a > inside a quoted attribute stays inside its tag', async () => {
    const content = '<office:document-content><table:table table:name="Calc"><table:table-row><table:table-cell table:formula="of:=IF([.A1]>0;1;0)" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row></table:table></office:document-content>';
    const output = await extract(storedZipBytes({ 'content.xml': content }), ODS_MIME_TYPE);
    expect(output.text).toBe('ODS Calc\nRows: 1\nColumns: 1\nSample:\n1');
  });

  test('ODS repeats rows and cells without expanding empty repeated rows', async () => {
    const content = '<office:document-content><table:table table:name="Repeated"><table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"><text:p>Value</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="1048576"><table:table-cell/></table:table-row></table:table></office:document-content>';
    const output = await extract(storedZipBytes({ 'content.xml': content }), ODS_MIME_TYPE);
    expect(output.text).toBe('ODS Repeated\nRows: 2\nColumns: 2\nSample:\nValue | Value\nValue | Value');
  });

  test('ODS bounds repeated data and safely summarizes many rows', async () => {
    const table = (repeat: string) => `<office:document-content><table:table table:name="Many"><table:table-row table:number-rows-repeated="${repeat}"><table:table-cell><text:p>X</text:p></table:table-cell></table:table-row></table:table></office:document-content>`;
    const output = await extract(storedZipBytes({ 'content.xml': table('150000') }), ODS_MIME_TYPE, { maxTableSampleRows: 1 });
    expect(output.text).toBe('ODS Many\nRows: 150000\nColumns: 1\nSample:\nX\nWarnings: row_sample_truncated');
    expect(await extract(storedZipBytes({ 'content.xml': table('500001') }), ODS_MIME_TYPE)).toEqual({
      status: 'failed_terminal', errorKind: 'office_document_unsupported',
    });
  });

  test('ODP reads each page in order', async () => {
    const output = await extract(storedZipBytes({ 'content.xml': odp }), ODP_MIME_TYPE);
    expect(output.text).toBe('First slide\n\nSecond slide');
    expect(output.derivations?.map((part) => part.structuralRef?.kind)).toEqual(['slide', 'slide']);
  });

  test.each([ODT_MIME_TYPE, ODS_MIME_TYPE, ODP_MIME_TYPE])('encrypted OpenDocument %s', async (mime) => {
    const bytes = storedZipBytes({ 'content.xml': odt, 'META-INF/manifest.xml': '<manifest:manifest><manifest:encryption-data/></manifest:manifest>' });
    expect(await extract(bytes, mime)).toEqual({ status: 'failed_terminal', errorKind: 'office_document_encrypted' });
  });

  test('EPUB follows the spine, strips scripts/styles and decodes entities', async () => {
    const output = await extract(storedZipBytes(epubParts()), EPUB_MIME_TYPE);
    expect(output.status).toBe('indexed');
    expect(output.text).toBe('First\nChapter two.\n\nLast & 雪');
  });

  test('EPUB permits obfuscated fonts and resolves escaped relative chapter paths', async () => {
    const parts = epubParts();
    parts['OPS/book.opf'] = parts['OPS/book.opf']!.replace('</manifest>', '<item id="font" href="font.otf" media-type="font/otf"/></manifest>')
      .replace('chapters/a.xhtml', 'chapters/../chapters/a%20chapter.xhtml');
    parts['OPS/chapters/a chapter.xhtml'] = '<html><body><p>&egrave; &alpha; &apos;text&apos; &#233; &constructor;</p></body></html>';
    parts['META-INF/encryption.xml'] = '<encryption><EncryptedData><CipherData><CipherReference URI="OPS/font.otf"/></CipherData></EncryptedData></encryption>';
    const output = await extract(storedZipBytes(parts), EPUB_MIME_TYPE);
    expect(output.text).toBe("First\nChapter two.\n\nè α 'text' é &constructor;");
  });

  test('EPUB bounds chapter text with a visible warning', async () => {
    const output = await extract(storedZipBytes(epubParts()), EPUB_MIME_TYPE, { maxBoundedTextChars: 5 });
    expect(output.text).toBe('First');
    expect(output.warnings).toContain('bounded_text_truncated');
  });

  test('malformed XML and package traversal are damaged', async () => {
    expect(await extract(storedZipBytes({ 'content.xml': '<text:p>broken <' }), ODT_MIME_TYPE)).toEqual({
      status: 'failed_terminal', errorKind: 'office_document_damaged',
    });
    const parts = epubParts();
    parts['OPS/book.opf'] = parts['OPS/book.opf']!.replace('chapters/a.xhtml', '../../outside.xhtml');
    expect(await extract(storedZipBytes(parts), EPUB_MIME_TYPE)).toEqual({
      status: 'failed_terminal', errorKind: 'office_document_damaged',
    });
  });

  test('EPUB reads loose HTML: unclosed void tags and stray closing tags', async () => {
    const parts = epubParts();
    parts['OPS/chapters/b.xhtml'] = '<html><body><p>One<br>Two</p></div><p>Three<img src="x.png"> four</p></body></html>';
    const output = await extract(storedZipBytes(parts), EPUB_MIME_TYPE);
    expect(output.text).toBe('One\nTwo\nThree four\n\nLast & 雪');
  });

  test('EPUB content encryption is terminal', async () => {
    const parts = epubParts();
    parts['META-INF/encryption.xml'] = '<encryption><EncryptedData><CipherData><CipherReference URI="OPS/chapters/a.xhtml"/></CipherData></EncryptedData></encryption>';
    expect(await extract(storedZipBytes(parts), EPUB_MIME_TYPE)).toEqual({ status: 'failed_terminal', errorKind: 'office_document_encrypted' });
  });

  test('missing content and a broken spine are damaged', async () => {
    expect(await extract(storedZipBytes({ unrelated: 'text' }), ODT_MIME_TYPE)).toEqual({ status: 'failed_terminal', errorKind: 'office_document_damaged' });
    const parts = epubParts();
    delete parts['OPS/chapters/a.xhtml'];
    expect(await extract(storedZipBytes(parts), EPUB_MIME_TYPE)).toEqual({ status: 'failed_terminal', errorKind: 'office_document_damaged' });
  });
});

test.each([
  ['doc', DOC_MIME_TYPE, 'application/msword'],
  ['xls', XLS_MIME_TYPE, 'application/vnd.ms-excel'],
  ['odt', ODT_MIME_TYPE, 'application/vnd.oasis.opendocument.text'],
  ['ods', ODS_MIME_TYPE, 'application/vnd.oasis.opendocument.spreadsheet'],
  ['odp', ODP_MIME_TYPE, 'application/vnd.oasis.opendocument.presentation'],
  ['epub', EPUB_MIME_TYPE, 'application/epub+zip'],
])('%s has a MIME type, a reader, and a scoped reader version', (extension, mime, expected) => {
  expect(mime).toBe(expected);
  expect(fileMimeTypeFromName(`fixture.${extension}`)).toBe(expected);
  expect(fileMimeTypeFromName(`fixture.${extension.toUpperCase()}`)).toBe(expected);
  expect(textLaneAccepts(mime)).toBe(true);
  expect(createTextExtractor().versionFor?.(mime)).toBe(`${TEXT_EXTRACTOR_VERSION}.document-readers-2026-11-11`);
  expect(createTextExtractor().versionFor?.('text/plain')).toBe(TEXT_EXTRACTOR_VERSION);
});
