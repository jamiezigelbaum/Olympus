/**
 * Format decoders: zip container reading, the Office XML dialects, the PDF
 * text-stream decoders, and delimited-table parsing.
 *
 * All of it is a port of the decoder block that has run against the production
 * corpus. Behaviour parity beats elegance here by a wide margin: several of
 * these paths exist because a real document broke a tidier version of them.
 *
 * Two directory rules govern the shape of this file, and this is the file where
 * they bite hardest because it is saturated with regular expressions:
 *
 *   - Every regex lives inside a NAMED function declaration whose name is
 *     enrolled in `ALLOWED_SHARED_REGEX_FUNCTIONS` for this path. There are no
 *     module-level regex constants, because a top-level regex is attributed to
 *     top-level and can never be allowlisted. Small single-purpose predicates
 *     exist here purely to give a regex a name the guard can hold onto.
 *   - Doc comments are always multi-line blocks. A single-line block comment
 *     trips the same regex-literal heuristic.
 */

import { Buffer } from 'node:buffer';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { normalizeExtractedText } from './bounded-text.ts';

const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 5_000_000;

export interface ZipEntryDirectoryRecord {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export function decodeUtf8(bytes: Uint8Array): string {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
}

/**
 * Reject a byte range that looks like a binary payload wearing a text mime.
 *
 * Any NUL in the first 4 KiB is decisive; otherwise more than 5% disallowed
 * control bytes condemns it.
 */
export function isBinaryLike(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    const isAllowedControl = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !isAllowedControl) suspicious += 1;
  }
  return suspicious / sample.byteLength > 0.05;
}

// --- delimited tables ------------------------------------------------------

export function parseDelimitedRows(text: string, delimiter: ',' | '\t'): string[][] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (quoted) {
      if (char === '"' && normalized[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

export function normalizeTableCell(value: string): string {
  return normalizeExtractedText(value).replace(/\|/g, '\\|').slice(0, 500);
}

export function tableSummary(input: {
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  delimiter: ',' | '\t';
}): string {
  const type = input.delimiter === '\t' ? 'TSV' : 'CSV';
  const lines = [
    `${type} table`,
    `Rows: ${input.totalRows}`,
    `Columns: ${input.totalColumns}`,
    'Sample:',
  ];
  for (const row of input.rows) {
    lines.push(row.join(' | '));
  }
  return normalizeExtractedText(lines.join('\n'));
}

export function officeTableSummary(input: {
  label: string;
  rows: string[][];
  maxRows: number;
  maxColumns: number;
}): string {
  const nonEmptyRows = input.rows.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (nonEmptyRows.length === 0) return '';
  const totalColumns = Math.max(...nonEmptyRows.map((row) => row.length));
  const lines = [
    input.label,
    `Rows: ${nonEmptyRows.length}`,
    `Columns: ${totalColumns}`,
    'Sample:',
  ];
  for (const row of nonEmptyRows.slice(0, input.maxRows)) {
    lines.push(row.slice(0, input.maxColumns).map(normalizeTableCell).join(' | '));
  }
  const warnings: string[] = [];
  if (nonEmptyRows.length > input.maxRows) warnings.push('row_sample_truncated');
  if (totalColumns > input.maxColumns) warnings.push('column_sample_truncated');
  if (warnings.length > 0) lines.push(`Warnings: ${warnings.join(', ')}`);
  return normalizeExtractedText(lines.join('\n'));
}

// --- PDF text layer --------------------------------------------------------

export function extractPdfTextStreams(bytes: Uint8Array): string[] {
  const source = decodeLatin1(bytes);
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const texts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(source)) !== null) {
    const streamSource = match[1] ?? '';
    const streamBytes = latin1Bytes(streamSource);
    const dictionaryStart = source.lastIndexOf('<<', match.index);
    const dictionaryEnd = source.lastIndexOf('>>', match.index);
    const dictionary = dictionaryStart >= 0 && dictionaryEnd >= dictionaryStart
      ? source.slice(dictionaryStart, dictionaryEnd + 2)
      : '';
    const decoded = decodePdfStream(streamBytes, dictionary);
    const text = normalizeExtractedText(extractPdfTextOperators(decoded).join('\n'));
    if (text) texts.push(text);
  }

  if (texts.length > 0) return texts;
  return [normalizeExtractedText(extractPdfTextOperators(source).join('\n'))].filter(Boolean);
}

function decodePdfStream(bytes: Uint8Array, dictionary: string): string {
  if (!/\/FlateDecode\b/.test(dictionary)) return decodeLatin1(bytes);
  try {
    return decodeLatin1(inflateSync(bytes));
  } catch {
    try {
      return decodeLatin1(inflateRawSync(bytes));
    } catch {
      return '';
    }
  }
}

function extractPdfTextOperators(content: string): string[] {
  const texts: string[] = [];
  const textObjectPattern = /BT([\s\S]*?)ET/g;
  let match: RegExpExecArray | null;
  while ((match = textObjectPattern.exec(content)) !== null) {
    const block = match[1] ?? '';
    texts.push(...extractPdfTextRuns(block));
  }
  return texts.length > 0 ? texts : extractPdfTextRuns(content);
}

function extractPdfTextRuns(content: string): string[] {
  const texts: string[] = [];
  const tokenPattern = /(\((?:\\.|[^\\()])*\)|<[\da-fA-F\s]+>)\s*(?:Tj|'|")|\[((?:[^\]\\]|\\.|\((?:\\.|[^\\()])*\)|<[\da-fA-F\s]+>)*)\]\s*TJ/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(content)) !== null) {
    const literal = match[1];
    const arrayBody = match[2];
    if (literal) {
      texts.push(decodePdfTextToken(literal));
    } else if (arrayBody) {
      const parts: string[] = [];
      const arrayTokenPattern = /\((?:\\.|[^\\()])*\)|<[\da-fA-F\s]+>/g;
      let tokenMatch: RegExpExecArray | null;
      while ((tokenMatch = arrayTokenPattern.exec(arrayBody)) !== null) {
        parts.push(decodePdfTextToken(tokenMatch[0] ?? ''));
      }
      const joined = parts.join('');
      if (joined) texts.push(joined);
    }
  }
  return texts.map(normalizeExtractedText).filter(Boolean);
}

function decodePdfTextToken(token: string): string {
  if (token.startsWith('<') && token.endsWith('>')) {
    return decodePdfHexString(token.slice(1, -1));
  }
  if (token.startsWith('(') && token.endsWith(')')) {
    return decodePdfLiteralString(token.slice(1, -1));
  }
  return '';
}

function decodePdfHexString(hex: string): string {
  const cleaned = hex.replace(/\s+/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < cleaned.length; index += 2) {
    const pair = cleaned.slice(index, index + 2).padEnd(2, '0');
    const value = Number.parseInt(pair, 16);
    if (!Number.isNaN(value)) bytes.push(value);
  }
  return decodePdfStringBytes(new Uint8Array(bytes));
}

function decodePdfLiteralString(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      bytes.push(value.charCodeAt(index) & 0xff);
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) break;
    if (next === 'n') bytes.push(10);
    else if (next === 'r') bytes.push(13);
    else if (next === 't') bytes.push(9);
    else if (next === 'b') bytes.push(8);
    else if (next === 'f') bytes.push(12);
    else if (next === '\n') {
      index += 1;
      continue;
    } else if (next === '\r') {
      if (value[index + 2] === '\n') index += 1;
      index += 1;
      continue;
    } else if (/[0-7]/.test(next)) {
      const octal = value.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)?.[0] ?? next;
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += octal.length;
      continue;
    } else {
      bytes.push(next.charCodeAt(0) & 0xff);
    }
    index += 1;
  }
  return decodePdfStringBytes(new Uint8Array(bytes));
}

function decodePdfStringBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      text += String.fromCharCode((bytes[index]! << 8) | bytes[index + 1]!);
    }
    return text;
  }
  return decodeLatin1(bytes);
}

function decodeLatin1(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return output;
}

function latin1Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/**
 * Does this PDF look like a scan with no selectable text layer?
 *
 * Decides whether an empty text extraction is reported as an image-only
 * descriptor (route it to OCR or vision) or as an ordinary empty result.
 */
export function pdfAppearsImageOnly(bytes: Uint8Array): boolean {
  const source = decodeLatin1(bytes);
  return /\/Subtype\s*\/Image\b/.test(source)
    || /\/XObject\b[\s\S]{0,500}\/Image\b/.test(source)
    || /\/Filter\s*\/DCTDecode\b/.test(source)
    || /\/Filter\s*\/JPXDecode\b/.test(source);
}

// --- zip container ---------------------------------------------------------

export function readZipEntries(bytes: Uint8Array): Map<string, ZipEntryDirectoryRecord> {
  const entries = new Map<string, ZipEntryDirectoryRecord>();
  const eocdOffset = findZipEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    throw new Error('Office document zip directory was not found.');
  }
  const entryCount = readUint16Le(bytes, eocdOffset + 10);
  const centralDirectoryOffset = readUint32Le(bytes, eocdOffset + 16);
  let offset = centralDirectoryOffset;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (readUint32Le(bytes, offset) !== 0x02014b50) {
      throw new Error('Office document zip directory entry is malformed.');
    }
    const flags = readUint16Le(bytes, offset + 8);
    const method = readUint16Le(bytes, offset + 10);
    const compressedSize = readUint32Le(bytes, offset + 20);
    const uncompressedSize = readUint32Le(bytes, offset + 24);
    const nameLength = readUint16Le(bytes, offset + 28);
    const extraLength = readUint16Le(bytes, offset + 30);
    const commentLength = readUint16Le(bytes, offset + 32);
    const localHeaderOffset = readUint32Le(bytes, offset + 42);
    if ((flags & 0x0001) !== 0) {
      throw new Error('Encrypted Office document zip entries are not supported.');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error('Zip64 Office document entries are not supported in the local extractor.');
    }
    const name = decodeUtf8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!name.endsWith('/')) {
      entries.set(name, {
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntryText(
  bytes: Uint8Array,
  entries: Map<string, ZipEntryDirectoryRecord>,
  name: string,
): string | undefined {
  const entry = entries.get(name);
  if (!entry) return undefined;
  if (entry.uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
    throw new Error('Office document zip entry exceeds the local extraction cap.');
  }
  return decodeZipEntryText(bytes, entry);
}

function decodeZipEntryText(
  bytes: Uint8Array,
  entry: {
    method: number;
    compressedSize: number;
    localHeaderOffset: number;
  },
): string {
  const offset = entry.localHeaderOffset;
  if (readUint32Le(bytes, offset) !== 0x04034b50) {
    throw new Error('Office document zip local entry is malformed.');
  }
  const nameLength = readUint16Le(bytes, offset + 26);
  const extraLength = readUint16Le(bytes, offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.method === 0) return decodeUtf8(compressed);
  if (entry.method === 8) {
    return decodeUtf8(new Uint8Array(inflateRawSync(compressed)));
  }
  throw new Error(`Unsupported Office document zip compression method ${entry.method}.`);
}

function findZipEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.length - 65_558);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (readUint32Le(bytes, offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

// --- Office part-name predicates -------------------------------------------
//
// Each of these exists to give one regex a name the architecture guard can
// allowlist. They were inline filters in the production lane.

export function isWordHeaderPart(name: string): boolean {
  return /^word\/header\d+\.xml$/i.test(name);
}

export function isWordFooterPart(name: string): boolean {
  return /^word\/footer\d+\.xml$/i.test(name);
}

export function isSlidePart(name: string): boolean {
  return /^ppt\/slides\/slide\d+\.xml$/i.test(name);
}

export function isNotesSlidePart(name: string): boolean {
  return /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name);
}

export function isWorksheetPart(name: string): boolean {
  return /^xl\/worksheets\/sheet\d+\.xml$/i.test(name);
}

export function sheetXmlHasFormula(xml: string | undefined): boolean {
  return /<f\b/i.test(xml ?? '');
}

export function officePartNumber(value: string): number {
  return Number.parseInt(/(\d+)(?=\.xml$)/.exec(value)?.[1] ?? '0', 10);
}

export function compareOfficePartNames(left: string, right: string): number {
  return officePartNumber(left) - officePartNumber(right) || left.localeCompare(right);
}

// --- Office XML dialects ---------------------------------------------------

export function extractWordParagraphs(xml: string | undefined): string[] {
  if (!xml) return [];
  return xml
    .split(/<\/w:p>/)
    .map((paragraph) => normalizeExtractedText(extractXmlTagText(paragraph, 'w:t').join('')))
    .filter((paragraph) => paragraph.length > 0);
}

export function extractWordComments(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<w:comment\b[^>]*>([\s\S]*?)<\/w:comment>/g)]
    .map((match) => normalizeExtractedText(extractWordParagraphs(match[1]).join('\n')))
    .filter((comment) => comment.length > 0);
}

export function extractWordTables(xml: string | undefined): string[][][] {
  if (!xml) return [];
  return [...xml.matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g)]
    .map((tableMatch) => [...(tableMatch[1] ?? '').matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)]
      .map((rowMatch) => [...(rowMatch[1] ?? '').matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)]
        .map((cellMatch) => normalizeExtractedText(extractWordParagraphs(cellMatch[1]).join(' ')))))
    .filter((rows) => rows.some((row) => row.some((cell) => cell.trim().length > 0)));
}

export function extractDrawingMlTables(xml: string | undefined): string[][][] {
  if (!xml) return [];
  return [...xml.matchAll(/<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/g)]
    .map((tableMatch) => [...(tableMatch[1] ?? '').matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)]
      .map((rowMatch) => [...(rowMatch[1] ?? '').matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)]
        .map((cellMatch) => normalizeExtractedText(extractXmlTagText(cellMatch[1], 'a:t').join(' ')))))
    .filter((rows) => rows.some((row) => row.some((cell) => cell.trim().length > 0)));
}

export function extractXmlTagText(xml: string | undefined, tagName: string): string[] {
  if (!xml) return [];
  const escapedTagName = escapeRegExp(tagName);
  const matches = xml.matchAll(new RegExp(`<${escapedTagName}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTagName}>`, 'g'));
  return [...matches]
    .map((match) => decodeXmlEntities(stripXmlTags(match[1] ?? '')))
    .map(normalizeExtractedText)
    .filter((value) => value.length > 0);
}

export function firstXmlTagText(xml: string | undefined, tagName: string): string | undefined {
  return extractXmlTagText(xml, tagName)[0];
}

export function extractOfficeDocumentProperties(
  bytes: Uint8Array,
  entries: Map<string, ZipEntryDirectoryRecord>,
): string {
  const coreXml = readZipEntryText(bytes, entries, 'docProps/core.xml');
  const appXml = readZipEntryText(bytes, entries, 'docProps/app.xml');
  const fields: Array<[string, string | undefined]> = [
    ['Title', firstXmlTagText(coreXml, 'dc:title')],
    ['Subject', firstXmlTagText(coreXml, 'dc:subject')],
    ['Description', firstXmlTagText(coreXml, 'dc:description')],
    ['Keywords', firstXmlTagText(coreXml, 'cp:keywords')],
    ['Creator', firstXmlTagText(coreXml, 'dc:creator')],
    ['Last modified by', firstXmlTagText(coreXml, 'cp:lastModifiedBy')],
    ['Created', firstXmlTagText(coreXml, 'dcterms:created')],
    ['Modified', firstXmlTagText(coreXml, 'dcterms:modified')],
    ['Application', firstXmlTagText(appXml, 'Application')],
    ['Company', firstXmlTagText(appXml, 'Company')],
    ['Manager', firstXmlTagText(appXml, 'Manager')],
    ['Category', firstXmlTagText(appXml, 'Category')],
  ];
  return normalizeExtractedText(fields
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n'));
}

export function extractXlsxSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map((match) => normalizeExtractedText(extractXmlTagText(match[1], 't').join(' ')));
}

export function extractXlsxSheetNames(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<sheet\b([^>]*)\/?>/g)]
    .map((match, index) => {
      const name = decodeXmlEntities(/(?:^|\s)name="([^"]+)"/.exec(match[1] ?? '')?.[1] ?? '');
      return normalizeExtractedText(name) || `sheet ${index + 1}`;
    });
}

/**
 * XLSX omits an empty cell entirely, so document order is not column order: the
 * `r=` reference is the only thing that keeps a sparse row under its header.
 *
 * The empty-element arm of the cell pattern matters just as much — Excel writes
 * `<c r="B3" s="2"/>` for a formatted-but-empty cell, and a `>`-only match lets
 * that cell swallow the one after it. A writer that omits `r` altogether still
 * appends in document order.
 */
export function extractXlsxRows(xml: string | undefined, sharedStrings: string[]): string[][] {
  if (!xml) return [];
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)]
    .map((rowMatch) => {
      const row: string[] = [];
      for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cellMatch[1] ?? '';
        const reference = /(?:^|\s)r="([A-Za-z]{1,3})\d+"/.exec(attributes)?.[1];
        const column = xlsxColumnIndex(reference) ?? row.length;
        while (row.length < column) row.push('');
        row[column] = extractXlsxCellValue(attributes, cellMatch[2] ?? '', sharedStrings);
      }
      return row;
    });
}

/**
 * Excel's column ceiling, XFD. Placement fills every skipped column, so an
 * out-of-range reference from a malformed sheet must not drive the fill.
 */
const XLSX_MAX_COLUMNS = 16_384;

/**
 * Decode the letters of an A1-style cell reference to a zero-based column.
 */
function xlsxColumnIndex(letters: string | undefined): number | undefined {
  if (!letters) return undefined;
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index <= XLSX_MAX_COLUMNS ? index - 1 : undefined;
}

function extractXlsxCellValue(attributes: string, body: string, sharedStrings: string[]): string {
  const cellType = /(?:^|\s)t="([^"]+)"/.exec(attributes)?.[1];
  if (cellType === 'inlineStr') {
    return normalizeExtractedText(extractXmlTagText(body, 't').join(' '));
  }
  const formula = normalizeExtractedText(
    decodeXmlEntities(stripXmlTags(/<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1] ?? '')),
  );
  const value = decodeXmlEntities(stripXmlTags(/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''));
  const normalizedValue = cellType === 's'
    ? (() => {
      const index = Number.parseInt(value, 10);
      return Number.isFinite(index) ? sharedStrings[index] ?? '' : '';
    })()
    : normalizeExtractedText(value);
  if (formula) {
    return normalizedValue ? `=${formula} -> ${normalizedValue}` : `=${formula}`;
  }
  if (cellType === 's') {
    return normalizedValue;
  }
  return normalizedValue;
}

function stripXmlTags(input: string): string {
  return input.replace(/<[^>]+>/g, '');
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 16)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function bufferByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
