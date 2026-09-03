// Shared fixtures for the file-extraction factory's extractor tests.
//
// Everything here is built in-process: no network, no committed binaries, no
// real ocrmypdf/tesseract/pdftoppm/whisper invocation. The zip writer emits
// STORED (method 0) entries, which is enough for the Office decoders and keeps
// the fixtures readable in the test that uses them.

import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import type {
  ExtractionItemRef,
  ExtractorInput,
  ExtractorJobContext,
} from '../../src/workers/file-extraction/types.ts';

export function textBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'utf8'));
}

export function itemRef(overrides: Partial<ExtractionItemRef> = {}): ExtractionItemRef {
  return {
    corpusId: 'test.corpus',
    provider: 'test-provider',
    accountScope: 'primary',
    approvedScopeKey: 'scope-key',
    providerItemId: 'provider-item-1',
    localItemId: 'local-item-1',
    ...overrides,
  };
}

export function jobContext(overrides: Partial<ExtractorJobContext> = {}): ExtractorJobContext {
  return {
    jobId: 'job-1',
    extractorKind: 'local_text',
    extractorVersion: '2026-05-22',
    policyDecision: 'index_allowed',
    attempts: 1,
    leaseExpiresAt: '2026-07-28T00:15:00.000Z',
    ...overrides,
  };
}

export function extractorInput(overrides: {
  bytes?: Uint8Array;
  localPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  ref?: Partial<ExtractionItemRef>;
  job?: Partial<ExtractorJobContext>;
} = {}): ExtractorInput {
  return {
    ref: itemRef(overrides.ref ?? {}),
    job: jobContext(overrides.job ?? {}),
    ...(overrides.bytes !== undefined ? { bytes: overrides.bytes } : {}),
    ...(overrides.localPath !== undefined ? { localPath: overrides.localPath } : {}),
    ...(overrides.mimeType !== undefined ? { mimeType: overrides.mimeType } : {}),
    ...(overrides.sizeBytes !== undefined ? { sizeBytes: overrides.sizeBytes } : {}),
  };
}

export function storedZipBytes(entries: Record<string, string>): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...localParts, centralDirectory, eocd]));
}

/**
 * A PDF whose single uncompressed content stream carries the given text runs.
 */
export function pdfWithTextLayer(runs: readonly string[]): Uint8Array {
  const operators = runs.map((run) => `(${run}) Tj`).join(' ');
  return textBytes([
    '%PDF-1.4',
    '<< /Length 64 >>',
    'stream',
    `BT ${operators} ET`,
    'endstream',
    '%%EOF',
    '',
  ].join('\n'));
}

/**
 * A PDF whose content stream is Flate-compressed, exercising the inflate path
 * as well as the operator decoders.
 */
export function pdfWithFlateTextStream(contentStream: string): Uint8Array {
  const compressed = deflateSync(Buffer.from(contentStream, 'latin1'));
  return new Uint8Array(Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ', 'latin1'),
    Buffer.from(String(compressed.length), 'latin1'),
    Buffer.from(' /Filter /FlateDecode >>\nstream\n', 'latin1'),
    compressed,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]));
}

/**
 * A PDF with no selectable text and the image markers the image-only probe
 * looks for.
 */
export function pdfImageOnly(): Uint8Array {
  return textBytes([
    '%PDF-1.4',
    '<< /Type /XObject /Subtype /Image /Filter /DCTDecode >>',
    '%%EOF',
    '',
  ].join('\n'));
}

/**
 * A PDF with neither a text layer nor any image marker.
 */
export function pdfWithoutContent(): Uint8Array {
  return textBytes([
    '%PDF-1.4',
    '<< /Type /Catalog >>',
    '%%EOF',
    '',
  ].join('\n'));
}
