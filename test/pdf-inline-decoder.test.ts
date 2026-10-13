// The inline PDF text reader, which stands in for poppler on a host without it
// (most Macs). It runs inside the worker that also answers questions, so these
// tests pin the two things that must never regress: it stays fast on PDFs full
// of binary (images, fonts) and it reads the same text as before on ordinary
// ones. The time bounds are deliberately generous; the old reader needed
// seconds to minutes on these inputs.

import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, deflateSync } from 'node:zlib';
import {
  extractPdfTextLayer,
  extractPdfTextStreams,
  OfficeDocumentUnreadableError,
  PDF_TEXT_PARTIAL_WARNING,
  readZipEntries,
  readZipEntryText,
} from '../src/workers/file-extraction/extractors/document-formats.ts';
import { createTextExtractor } from '../src/workers/file-extraction/extractors/text.ts';
import { extractorInput } from './fixtures/file-extraction-extractor-fixtures.ts';

const PDF = 'application/pdf';
const ENOENT = () => Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
const TEXT_PDF = new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures/pdf/text-layer.pdf')));
const SCANNED_PDF = new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures/pdf/scanned-receipt.pdf')));

interface TestStream {
  dict: string;
  data: Uint8Array | string;
}

function pdfFromStreams(streams: readonly TestStream[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  streams.forEach((stream, index) => {
    const data = typeof stream.data === 'string' ? Buffer.from(stream.data, 'latin1') : Buffer.from(stream.data);
    parts.push(
      Buffer.from(`${index + 1} 0 obj\n<< ${stream.dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    );
  });
  parts.push(Buffer.from('%%EOF', 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

function flate(content: string | Uint8Array): Buffer {
  return deflateSync(typeof content === 'string' ? Buffer.from(content, 'latin1') : Buffer.from(content));
}

function contentPdf(content: string): Uint8Array {
  return pdfFromStreams([{ dict: '', data: content }]);
}

function pageStream(text: string): TestStream {
  return { dict: '/Filter /FlateDecode', data: flate(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`) };
}

/**
 * Deterministic binary that is poison for a backtracking matcher: dense
 * brackets and parentheses, and no closing bracket or backslash anywhere.
 */
function bracketJunk(bytes: number, seed = 42): Buffer {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 8;
  };
  const specials = [0x5b, 0x28, 0x29, 0x20, 0x28, 0x29];
  const out = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index += 1) {
    const draw = next();
    if (draw % 3 === 0) {
      out[index] = specials[draw % specials.length]!;
    } else {
      const byte = (draw >>> 4) & 0xff;
      out[index] = byte === 0x5d || byte === 0x5c ? 0x80 : byte;
    }
  }
  return out;
}

const IMAGE_DICT = '/Type /XObject /Subtype /Image /Width 2000 /Height 2000 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode';

describe('inline PDF reader: PDFs full of binary', () => {
  test('a large image stream full of brackets and parentheses is skipped, and the page text still reads', () => {
    const bytes = pdfFromStreams([
      { dict: IMAGE_DICT, data: flate(bracketJunk(400_000)) },
      pageStream('Olympus invoice 4471'),
    ]);
    const started = performance.now();
    const texts = extractPdfTextStreams(bytes);
    expect(performance.now() - started).toBeLessThan(500);
    expect(texts).toEqual(['Olympus invoice 4471']);
  });

  test('the same junk in an uncompressed image, a font program and an unmarked stream also reads fast', () => {
    const junk = bracketJunk(300_000, 7);
    const bytes = pdfFromStreams([
      { dict: '/Type /XObject /Subtype /Image /Width 9 /Height 9', data: junk },
      { dict: '/Length1 1000 /Length2 0 /Length3 0 /Filter /FlateDecode', data: flate(junk) },
      { dict: '', data: junk },
      { dict: '/Filter /FlateDecode', data: flate(junk) },
      pageStream('Second page'),
    ]);
    const started = performance.now();
    const texts = extractPdfTextStreams(bytes);
    expect(performance.now() - started).toBeLessThan(500);
    expect(texts).toContain('Second page');
  });

  test('a text object whose array never closes cannot make the scan blow up', () => {
    const groups = '(a) '.repeat(60_000);
    const started = performance.now();
    const texts = extractPdfTextStreams(contentPdf(`BT /F1 12 Tf [${groups} ET`));
    expect(performance.now() - started).toBeLessThan(500);
    expect(texts).toEqual([]);
    const closed = `BT [${groups}] 0 d (done) Tj ET`;
    const startedClosed = performance.now();
    expect(extractPdfTextStreams(contentPdf(closed))).toEqual(['done']);
    expect(performance.now() - startedClosed).toBeLessThan(500);
  });

  test('a scan-like PDF goes through the extractor quickly and is still reported image-only', async () => {
    const bytes = pdfFromStreams([
      { dict: IMAGE_DICT, data: flate(bracketJunk(400_000, 99)) },
    ]);
    const extractor = createTextExtractor({ pdfTextCommand: 'pdftotext', pdfTextCommandRunner: ENOENT });
    const started = performance.now();
    const result = await extractor.extract(extractorInput({ bytes, mimeType: PDF }));
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.status).toBe('metadata_only');
    if (result.status !== 'metadata_only') return;
    expect(result.derivations?.[0]?.warnings).toContain('pdf_image_only');
  });
});

describe('inline PDF reader: which streams are decoded', () => {
  const decoy = flate('BT /F1 12 Tf (DECOY) Tj ET');

  test('streams the dictionary marks as non-text are never read, however the decoy looks', () => {
    const bytes = pdfFromStreams([
      { dict: IMAGE_DICT, data: decoy },
      { dict: '/Subtype /Image /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 >>', data: decoy },
      { dict: '/Length1 2000 /Filter /FlateDecode', data: decoy },
      { dict: '/Subtype /Type1C /Filter /FlateDecode', data: decoy },
      { dict: '/Type /ObjStm /N 5 /First 30 /Filter /FlateDecode', data: decoy },
      { dict: '/Type /XRef /W [1 3 1] /Filter /FlateDecode', data: decoy },
      { dict: '/N 3 /Alternate /DeviceRGB /Filter /FlateDecode', data: decoy },
      { dict: '/Type /Metadata /Subtype /XML', data: 'BT (DECOY) Tj ET' },
      { dict: '/Filter /DCTDecode', data: 'BT (DECOY) Tj ET' },
      pageStream('Real page'),
    ]);
    expect(extractPdfTextStreams(bytes)).toEqual(['Real page']);
  });

  test('a content stream is found even when a sub-dictionary precedes its filter', () => {
    const bytes = pdfFromStreams([
      {
        dict: '/Filter /FlateDecode /DecodeParms << /Predictor 1 >>',
        data: flate('BT (Behind a sub-dictionary) Tj ET'),
      },
    ]);
    expect(extractPdfTextStreams(bytes)).toEqual(['Behind a sub-dictionary']);
  });

  test('a stream with no BT ... ET text object yields nothing, even with show operators in it', () => {
    expect(extractPdfTextStreams(contentPdf('(stray) Tj [(stray)] TJ'))).toEqual([]);
    expect(extractPdfTextStreams(contentPdf('ET (stray) Tj BT'))).toEqual([]);
  });

  test('a filter the reader does not decode is skipped rather than scanned raw', () => {
    const bytes = pdfFromStreams([{ dict: '/Filter /ASCII85Decode', data: 'BT (Hidden) Tj ET' }]);
    expect(extractPdfTextStreams(bytes)).toEqual([]);
  });

  test('uncompressed content outside any recognised stream is still read', () => {
    const bytes = new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj\nBT (Loose content) Tj ET\nendobj\n%%EOF', 'latin1'));
    expect(extractPdfTextStreams(bytes)).toEqual(['Loose content']);
  });
});

describe('inline PDF reader: the text it extracts', () => {
  const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['a literal string', 'BT (Hello) Tj ET', ['Hello']],
    ['escaped parentheses and backslash', 'BT (a\\(b\\)c\\\\d) Tj ET', ['a(b)c\\d']],
    ['octal escapes', 'BT (\\101\\102\\103) Tj ET', ['ABC']],
    ['named escapes', 'BT (one\\ttwo) Tj ET', ['one\ttwo']],
    ['a hex string', 'BT <48656c6c6f> Tj ET', ['Hello']],
    ['a hex string with spaces', 'BT <48 65 6c 6c 6f> Tj ET', ['Hello']],
    ['a UTF-16 hex string', 'BT <FEFF00480069> Tj ET', ['Hi']],
    ['a TJ array with kerning numbers', 'BT [(W) 120 (orld) -250 <21>] TJ ET', ['World!']],
    ['a TJ array with no spaces', 'BT[(Tight)-20(Pack)]TJ ET', ['TightPack']],
    ['the quote operators', "BT (one) ' 1 2 (two) \" ET", ['one\ntwo']],
    ['one line per text object', 'BT (first) Tj ET BT (second) Tj ET', ['first\nsecond']],
    ['a string that is not shown', 'BT (skipped) Td (shown) Tj ET', ['shown']],
    ['a comment between operands', 'BT % (ignored) Tj\n (kept) Tj ET', ['kept']],
    ['tagged content with a property dictionary', '/P << /MCID 0 >> BDC BT (Tagged) Tj ET EMC', ['Tagged']],
    ['nested balanced parentheses', 'BT (a(b)c) Tj ET', ['a(b)c']],
    ['the letters ET inside a string', 'BT (BETTER NET) Tj (after) Tj ET', ['BETTER NET\nafter']],
    ['a line continuation inside a string', 'BT (ab\\\ncd) Tj ET', ['abcd']],
    [
      'an inline image whose data holds brackets and parentheses',
      'BT (Before) Tj ET q BI /W 2 /H 2 /BPC 8 /CS /G ID \u0001[((((\u0002 EI Q BT (After) Tj ET',
      ['Before\nAfter'],
    ],
  ];

  for (const [label, content, expected] of cases) {
    test(`reads ${label}`, () => {
      expect(extractPdfTextStreams(contentPdf(content))).toEqual([...expected]);
    });
  }

  test('reads a Flate stream, a CRLF-terminated stream, and several streams in order', () => {
    const crlf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 20 >>\nstream\r\nBT (Windows) Tj ET\r\nendstream\nendobj\n', 'latin1');
    expect(extractPdfTextStreams(new Uint8Array(crlf))).toEqual(['Windows']);
    expect(extractPdfTextStreams(pdfFromStreams([pageStream('One'), pageStream('Two')]))).toEqual(['One', 'Two']);
  });

  test('the shipped fixtures read exactly as they always did', () => {
    expect(extractPdfTextStreams(TEXT_PDF)).toEqual(['Olympus invoice number 4471 due October']);
    expect(extractPdfTextStreams(SCANNED_PDF)).toEqual([]);
    expect(extractPdfTextLayer(TEXT_PDF).partial).toBe(false);
    expect(extractPdfTextLayer(SCANNED_PDF).partial).toBe(false);
  });
});

describe('inline PDF reader: budgets', () => {
  test('a Flate bomb is cut off at the stream cap and the PDF is flagged partial', () => {
    const bomb = deflateSync(Buffer.alloc(40_000_000));
    expect(bomb.length).toBeLessThan(100_000);
    const bytes = pdfFromStreams([
      pageStream('Before the bomb'),
      { dict: '/Filter /FlateDecode', data: bomb },
      pageStream('After the bomb'),
    ]);
    const started = performance.now();
    const layer = extractPdfTextLayer(bytes);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(layer.partial).toBe(true);
    expect(layer.texts).toEqual(['Before the bomb', 'After the bomb']);
  });

  test('an uncompressed stream past the cap is not scanned', () => {
    const bytes = pdfFromStreams([
      pageStream('Kept'),
      { dict: '', data: Buffer.concat([Buffer.from('BT (Big) Tj ET '), Buffer.alloc(2_000_000, 0x20)]) },
    ]);
    const layer = extractPdfTextLayer(bytes, { maxStreamBytes: 1_000_000 });
    expect(layer.texts).toEqual(['Kept']);
    expect(layer.partial).toBe(true);
  });

  test('the decode time budget stops the reader and keeps what it found', () => {
    const streams = Array.from({ length: 10 }, (_, index) => pageStream(`Page ${index + 1}`));
    let clock = 0;
    const layer = extractPdfTextLayer(pdfFromStreams(streams), {
      maxDecodeMs: 250,
      now: () => {
        clock += 100;
        return clock;
      },
    });
    expect(layer.partial).toBe(true);
    expect(layer.texts.length).toBeGreaterThan(0);
    expect(layer.texts.length).toBeLessThan(10);
    expect(layer.texts).toEqual(streams.slice(0, layer.texts.length).map((_, index) => `Page ${index + 1}`));
  });

  test('the total byte budget stops the reader and keeps what it found', () => {
    const page = `BT (${'x'.repeat(900)}) Tj ET`;
    const streams = Array.from({ length: 6 }, () => ({ dict: '', data: page }));
    const layer = extractPdfTextLayer(pdfFromStreams(streams), { maxTotalBytes: 2_500 });
    expect(layer.partial).toBe(true);
    expect(layer.texts.length).toBe(3);
  });

  test('a PDF read in full is not flagged partial, even when the budget is exactly used', () => {
    const layer = extractPdfTextLayer(pdfFromStreams([pageStream('Only page')]), { maxTotalBytes: 1 });
    expect(layer.partial).toBe(false);
    expect(layer.texts).toEqual(['Only page']);
  });

  test('the extractor indexes the text it found and says the read was partial', async () => {
    const bytes = pdfFromStreams([
      pageStream('Page one text'),
      { dict: '/Filter /FlateDecode', data: deflateSync(Buffer.alloc(20_000_000)) },
    ]);
    const result = await createTextExtractor({ pdfTextCommand: 'pdftotext', pdfTextCommandRunner: ENOENT })
      .extract(extractorInput({ bytes, mimeType: PDF }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('Page one text');
    expect(result.derivations?.[0]?.warnings).toEqual(['pdf_text_layer_only', PDF_TEXT_PARTIAL_WARNING]);
  });
});

describe('zip entries: inflation is bounded by the bytes, not by the declared size', () => {
  function zipWithEntry(input: {
    name: string;
    method: 0 | 8;
    data: Uint8Array;
    declaredUncompressedSize: number;
  }): Uint8Array {
    const name = Buffer.from(input.name, 'utf8');
    const data = Buffer.from(input.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(input.method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(input.declaredUncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(input.method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(input.declaredUncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const centralOffset = local.length + name.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    return new Uint8Array(Buffer.concat([local, name, data, central, name, eocd]));
  }

  function readEntry(zip: Uint8Array, name: string): string | undefined {
    return readZipEntryText(zip, readZipEntries(zip), name);
  }

  function readFailure(zip: Uint8Array, name: string): OfficeDocumentUnreadableError {
    try {
      readEntry(zip, name);
    } catch (error) {
      if (error instanceof OfficeDocumentUnreadableError) return error;
      throw error;
    }
    throw new Error('expected the entry to be refused');
  }

  test('a deflated entry that expands past the cap is refused though it declares a small size', () => {
    const bomb = deflateRawSync(Buffer.alloc(30_000_000));
    const zip = zipWithEntry({ name: 'word/document.xml', method: 8, data: bomb, declaredUncompressedSize: 100 });
    const started = performance.now();
    const failure = readFailure(zip, 'word/document.xml');
    expect(performance.now() - started).toBeLessThan(2000);
    expect(failure.reason).toBe('unsupported');
    expect(failure.message).toContain('exceeds the local extraction cap');
  });

  test('a stored entry larger than the cap is refused though it declares a small size', () => {
    const zip = zipWithEntry({
      name: 'word/document.xml',
      method: 0,
      data: Buffer.alloc(5_000_001, 0x61),
      declaredUncompressedSize: 100,
    });
    const failure = readFailure(zip, 'word/document.xml');
    expect(failure.reason).toBe('unsupported');
  });

  test('ordinary entries, stored and deflated, still read', () => {
    const xml = '<w:t>Quarterly plan</w:t>';
    expect(readEntry(zipWithEntry({
      name: 'a.xml',
      method: 8,
      data: deflateRawSync(Buffer.from(xml)),
      declaredUncompressedSize: xml.length,
    }), 'a.xml')).toBe(xml);
    expect(readEntry(zipWithEntry({
      name: 'a.xml',
      method: 0,
      data: Buffer.from(xml),
      declaredUncompressedSize: xml.length,
    }), 'a.xml')).toBe(xml);
  });

  test('a truncated deflate stream is still reported as damaged, not as too big', () => {
    const good = deflateRawSync(Buffer.from('<w:t>text</w:t>'.repeat(50)));
    const zip = zipWithEntry({
      name: 'a.xml',
      method: 8,
      data: good.subarray(0, good.length - 6),
      declaredUncompressedSize: 750,
    });
    expect(readFailure(zip, 'a.xml').reason).toBe('damaged');
  });
});
