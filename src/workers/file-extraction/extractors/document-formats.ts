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

/**
 * An Office file these bytes can never yield text from: the container is
 * damaged (a truncated download or copy), password-protected, or uses a zip
 * feature the local reader does not support. Parsing is deterministic, so
 * retrying the same bytes cannot succeed; a changed file is a new job.
 */
export type OfficeDocumentUnreadableReason = 'damaged' | 'encrypted' | 'unsupported';

export class OfficeDocumentUnreadableError extends Error {
  readonly reason: OfficeDocumentUnreadableReason;

  constructor(reason: OfficeDocumentUnreadableReason, message: string) {
    super(message);
    this.name = 'OfficeDocumentUnreadableError';
    this.reason = reason;
  }
}

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
//
// This is the reader a host without poppler uses, which is most Macs, so it
// has to be safe on any PDF a user keeps in a synced folder: photo albums,
// font-heavy brochures, scans. It runs synchronously inside the process that
// also answers questions, so three rules keep it cheap:
//
//   - Only streams that can hold page text are decoded. A stream whose
//     dictionary marks it as an image, an embedded font, an ICC profile, a
//     cross-reference or object stream, and the like is never inflated.
//   - Content streams are read by a single forward pass over their tokens, so
//     the cost is linear in the stream size whatever bytes it holds.
//   - One PDF gets a fixed budget of decoded bytes and decode time. When it
//     runs out, the text found so far is returned and the result is flagged
//     partial rather than the worker waiting for the rest.

export const PDF_TEXT_PARTIAL_WARNING = 'pdf_text_partial';

/**
 * The largest a single stream may grow to when inflated. Page content streams
 * are kilobytes; a stream past this is an image or a deliberate bomb.
 */
export const PDF_TEXT_MAX_STREAM_BYTES = 8_000_000;
/**
 * The most stream bytes (inflated or raw) one PDF may have decoded and
 * scanned: room for a very long text document, not for an archive.
 */
export const PDF_TEXT_MAX_TOTAL_BYTES = 48_000_000;
/**
 * The longest one PDF may keep the worker busy decoding.
 */
export const PDF_TEXT_MAX_DECODE_MS = 1_500;

const PDF_STREAM_DICTIONARY_MAX_BYTES = 65_536;

export interface PdfTextLimits {
  maxStreamBytes?: number;
  maxTotalBytes?: number;
  maxDecodeMs?: number;
  /**
   * A millisecond clock; tests pass a fake one so the time budget is exact.
   */
  now?: () => number;
}

export interface PdfTextLayer {
  texts: string[];
  /**
   * True when the budget stopped the reader before the whole PDF was read, so
   * the text is what was found up to that point.
   */
  partial: boolean;
}

interface PdfDecodeBudget {
  maxStreamBytes: number;
  maxTotalBytes: number;
  deadline: number;
  now: () => number;
  usedBytes: number;
  partial: boolean;
}

interface PdfStreamSpan {
  keywordStart: number;
  dataStart: number;
  dataEnd: number;
  next: number;
}

export function extractPdfTextStreams(bytes: Uint8Array, limits: PdfTextLimits = {}): string[] {
  return extractPdfTextLayer(bytes, limits).texts;
}

export function extractPdfTextLayer(bytes: Uint8Array, limits: PdfTextLimits = {}): PdfTextLayer {
  const now = limits.now ?? (() => performance.now());
  const budget: PdfDecodeBudget = {
    maxStreamBytes: limits.maxStreamBytes ?? PDF_TEXT_MAX_STREAM_BYTES,
    maxTotalBytes: limits.maxTotalBytes ?? PDF_TEXT_MAX_TOTAL_BYTES,
    deadline: now() + (limits.maxDecodeMs ?? PDF_TEXT_MAX_DECODE_MS),
    now,
    usedBytes: 0,
    partial: false,
  };
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const texts: string[] = [];
  const streamRanges: Array<[number, number]> = [];
  let cursor = 0;
  for (;;) {
    const stream = findPdfStream(buffer, cursor);
    if (!stream) break;
    cursor = stream.next;
    streamRanges.push([stream.keywordStart, stream.next]);
    if (pdfBudgetSpent(budget)) {
      budget.partial = true;
      break;
    }
    const dictionary = readPdfStreamDictionary(buffer, stream.keywordStart);
    if (pdfStreamHoldsNoText(dictionary)) continue;
    const content = readPdfStreamContent(buffer, stream, dictionary, budget);
    if (content === undefined) continue;
    const text = normalizeExtractedText(scanPdfTextShows(content).join('\n'));
    if (text) texts.push(text);
  }

  // A file whose streams gave no text may still carry an uncompressed content
  // stream the stream reader did not recognize, so the bytes between the
  // recognized streams are read as content too. The streams themselves are
  // left out: they were already tried, or are known not to hold text.
  if (texts.length === 0 && !budget.partial) {
    let gapStart = 0;
    const boundaries: Array<[number, number]> = [...streamRanges, [buffer.length, buffer.length]];
    for (const [rangeStart, rangeEnd] of boundaries) {
      if (rangeStart - gapStart >= 4) {
        if (pdfBudgetSpent(budget)) {
          budget.partial = true;
          break;
        }
        const length = Math.min(rangeStart - gapStart, budget.maxStreamBytes);
        if (length < rangeStart - gapStart) budget.partial = true;
        const gap = buffer.subarray(gapStart, gapStart + length);
        budget.usedBytes += length;
        if (pdfHasTextObject(gap)) {
          const text = normalizeExtractedText(scanPdfTextShows(gap.toString('latin1')).join('\n'));
          if (text) texts.push(text);
        }
      }
      gapStart = rangeEnd;
    }
  }
  return { texts, partial: budget.partial };
}

function pdfBudgetSpent(budget: PdfDecodeBudget): boolean {
  return budget.usedBytes >= budget.maxTotalBytes || budget.now() > budget.deadline;
}

/**
 * Find the next `stream ... endstream` span at or after `from`. The data runs
 * from the line break after `stream` to the line break before `endstream`.
 */
function findPdfStream(buffer: Buffer, from: number): PdfStreamSpan | undefined {
  let search = from;
  for (;;) {
    const keywordStart = buffer.indexOf('stream', search, 'latin1');
    if (keywordStart < 0) return undefined;
    search = keywordStart + 6;
    // `endstream` ends in the same word, and `...stream` inside prose is not
    // a stream keyword: it must follow whitespace or the closing `>>`.
    const before = keywordStart > 0 ? buffer[keywordStart - 1]! : 0x0a;
    if (!isPdfWhitespaceCode(before) && before !== 0x3e) continue;
    let dataStart = keywordStart + 6;
    if (buffer[dataStart] === 0x0d && buffer[dataStart + 1] === 0x0a) dataStart += 2;
    else if (buffer[dataStart] === 0x0a) dataStart += 1;
    else continue;
    const close = buffer.indexOf('endstream', dataStart, 'latin1');
    if (close < 0) return undefined;
    let dataEnd = close;
    if (dataEnd > dataStart && buffer[dataEnd - 1] === 0x0a) {
      dataEnd -= 1;
      if (dataEnd > dataStart && buffer[dataEnd - 1] === 0x0d) dataEnd -= 1;
    } else if (dataEnd > dataStart && buffer[dataEnd - 1] === 0x0d) {
      dataEnd -= 1;
    }
    return { keywordStart, dataStart, dataEnd, next: close + 9 };
  }
}

/**
 * The dictionary written just before a `stream` keyword, matching nested
 * `<< >>` pairs so a /DecodeParms sub-dictionary does not hide /Filter.
 * Empty when no dictionary precedes the keyword.
 */
function readPdfStreamDictionary(buffer: Buffer, keywordStart: number): string {
  let end = keywordStart;
  while (end > 0 && isPdfWhitespaceCode(buffer[end - 1]!)) end -= 1;
  if (end < 2 || buffer[end - 1] !== 0x3e || buffer[end - 2] !== 0x3e) return '';
  const floor = Math.max(0, end - PDF_STREAM_DICTIONARY_MAX_BYTES);
  let depth = 0;
  let index = end;
  while (index - 2 >= floor) {
    const first = buffer[index - 2];
    const second = buffer[index - 1];
    if (first === 0x3e && second === 0x3e) {
      depth += 1;
      index -= 2;
    } else if (first === 0x3c && second === 0x3c) {
      depth -= 1;
      index -= 2;
      if (depth === 0) return buffer.toString('latin1', index, end);
    } else {
      index -= 1;
    }
  }
  return '';
}

/**
 * Streams the dictionary marks as something other than page content: images,
 * embedded font programs, ICC profiles, cross-reference and object streams,
 * metadata, embedded files and function or shading tables. None can hold the
 * page's text, and most are the large binary part of a PDF.
 */
function pdfStreamHoldsNoText(dictionary: string): boolean {
  return /\/Subtype\s*\/(?:Image|Type1C|CIDFontType0C|OpenType)\b/.test(dictionary)
    || /\/Length[123]\b/.test(dictionary)
    || /\/Type\s*\/(?:XRef|ObjStm|Metadata|EmbeddedFile)\b/.test(dictionary)
    || /\/(?:DCTDecode|JPXDecode|JBIG2Decode|CCITTFaxDecode)\b/.test(dictionary)
    || /\/(?:FunctionType|ShadingType|Alternate)\b/.test(dictionary)
    || /\/N\s+[134]\b/.test(dictionary);
}

function pdfStreamUsesFlate(dictionary: string): boolean {
  return /\/FlateDecode\b/.test(dictionary);
}

function pdfStreamHasFilter(dictionary: string): boolean {
  return /\/Filter\b/.test(dictionary);
}

/**
 * The decoded content of a stream worth scanning, or undefined when it cannot
 * or should not be: a filter this reader does not decode, a stream that does
 * not inflate, one past the size cap, or one with no BT ... ET text object.
 */
function readPdfStreamContent(
  buffer: Buffer,
  stream: PdfStreamSpan,
  dictionary: string,
  budget: PdfDecodeBudget,
): string | undefined {
  const raw = buffer.subarray(stream.dataStart, stream.dataEnd);
  let content: Buffer;
  if (pdfStreamUsesFlate(dictionary)) {
    const inflated = inflatePdfStream(raw, budget.maxStreamBytes);
    if (inflated === 'too_large') {
      budget.partial = true;
      return undefined;
    }
    if (inflated === undefined) return undefined;
    content = inflated;
  } else if (pdfStreamHasFilter(dictionary)) {
    return undefined;
  } else {
    if (raw.length > budget.maxStreamBytes) {
      budget.partial = true;
      return undefined;
    }
    content = raw;
  }
  budget.usedBytes += content.length;
  if (!pdfHasTextObject(content)) return undefined;
  return content.toString('latin1');
}

function inflatePdfStream(raw: Uint8Array, maxOutputLength: number): Buffer | 'too_large' | undefined {
  try {
    return inflateSync(raw, { maxOutputLength });
  } catch (error) {
    if (isInflateOutputLimitError(error)) return 'too_large';
  }
  try {
    return inflateRawSync(raw, { maxOutputLength });
  } catch (error) {
    return isInflateOutputLimitError(error) ? 'too_large' : undefined;
  }
}

/**
 * Inflating past `maxOutputLength` is the one failure that means "too big"
 * rather than "not Flate data".
 */
function isInflateOutputLimitError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_BUFFER_TOO_LARGE';
}

/**
 * Whether the bytes hold a text object: a BT with an ET after it.
 */
function pdfHasTextObject(content: Buffer): boolean {
  const begin = content.indexOf('BT', 0, 'latin1');
  return begin >= 0 && content.indexOf('ET', begin + 2, 'latin1') >= 0;
}

function isPdfWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00;
}

function isPdfDelimiterCode(code: number): boolean {
  return code === 0x28 || code === 0x29 || code === 0x3c || code === 0x3e
    || code === 0x5b || code === 0x5d || code === 0x7b || code === 0x7d
    || code === 0x2f || code === 0x25;
}

function pdfHexDigitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

/**
 * Index just past the `)` that closes the literal string opening at `start`,
 * counting nested parentheses and skipping backslash escapes; -1 when it
 * never closes.
 */
function skipPdfLiteralString(content: string, start: number): number {
  let depth = 0;
  for (let index = start; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 0x5c) {
      index += 1;
    } else if (code === 0x28) {
      depth += 1;
    } else if (code === 0x29) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Index just past the `>` that closes the hex string opening at `start`; -1
 * when the bytes are not a hex string (anything but hex digits and
 * whitespace before a `>`).
 */
function skipPdfHexString(content: string, start: number): number {
  for (let index = start + 1; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 0x3e) return index + 1;
    if (pdfHexDigitValue(code) < 0 && !isPdfWhitespaceCode(code)) return -1;
  }
  return -1;
}

/**
 * Read the strings of a TJ array opening just before `from`, up to its
 * closing bracket; undefined when it never closes.
 */
function readPdfTextArray(content: string, from: number): { text: string; end: number } | undefined {
  const parts: string[] = [];
  let index = from;
  while (index < content.length) {
    const code = content.charCodeAt(index);
    if (code === 0x5d) return { text: parts.join(''), end: index + 1 };
    if (code === 0x28) {
      const end = skipPdfLiteralString(content, index);
      if (end < 0) return undefined;
      parts.push(decodePdfLiteralString(content.slice(index + 1, end - 1)));
      index = end;
    } else if (code === 0x3c && content.charCodeAt(index + 1) !== 0x3c) {
      const end = skipPdfHexString(content, index);
      if (end < 0) {
        index += 1;
      } else {
        parts.push(decodePdfHexString(content.slice(index + 1, end - 1)));
        index = end;
      }
    } else {
      index += 1;
    }
  }
  return undefined;
}

/**
 * Index just past the `EI` that ends the inline image whose data follows
 * `from`; -1 when there is none.
 */
function skipPdfInlineImageData(content: string, from: number): number {
  let search = from;
  for (;;) {
    const found = content.indexOf('EI', search);
    if (found < 0) return -1;
    const beforeIsSpace = found > from && isPdfWhitespaceCode(content.charCodeAt(found - 1));
    const afterIsSpace = found + 2 >= content.length || isPdfWhitespaceCode(content.charCodeAt(found + 2));
    if (beforeIsSpace && afterIsSpace) return found + 2;
    search = found + 2;
  }
}

function pushPdfTextRun(runs: string[], text: string): void {
  const run = normalizeExtractedText(text);
  if (run) runs.push(run);
}

/**
 * The text a content stream shows, in order, one run per show operator: the
 * string before each Tj, ' and ", and the strings of the array before each TJ.
 *
 * One forward pass over the tokens that never revisits a byte, so the cost is
 * linear in the content size whatever the bytes are. As in any PDF lexer, a
 * string or array that never closes swallows the rest of the content.
 */
function scanPdfTextShows(content: string): string[] {
  const runs: string[] = [];
  const length = content.length;
  const noOperand = 0;
  const stringOperand = 1;
  const arrayOperand = 2;
  let operandKind = noOperand;
  let operandText = '';
  let inlineImage = false;
  let index = 0;
  while (index < length) {
    const code = content.charCodeAt(index);
    if (isPdfWhitespaceCode(code)) {
      index += 1;
      continue;
    }
    if (code === 0x28) {
      const end = skipPdfLiteralString(content, index);
      if (end < 0) break;
      operandKind = stringOperand;
      operandText = decodePdfLiteralString(content.slice(index + 1, end - 1));
      index = end;
      continue;
    }
    if (code === 0x3c) {
      if (content.charCodeAt(index + 1) === 0x3c) {
        operandKind = noOperand;
        index += 2;
        continue;
      }
      const end = skipPdfHexString(content, index);
      if (end < 0) {
        operandKind = noOperand;
        index += 1;
      } else {
        operandKind = stringOperand;
        operandText = decodePdfHexString(content.slice(index + 1, end - 1));
        index = end;
      }
      continue;
    }
    if (code === 0x5b) {
      const array = readPdfTextArray(content, index + 1);
      if (!array) break;
      operandKind = arrayOperand;
      operandText = array.text;
      index = array.end;
      continue;
    }
    if (code === 0x25) {
      while (index < length && content.charCodeAt(index) !== 0x0a && content.charCodeAt(index) !== 0x0d) {
        index += 1;
      }
      continue;
    }

    // Anything else ends the run of operands: a name, a number, an operator,
    // or a stray bracket.
    const shown = operandKind;
    operandKind = noOperand;
    let end = index + 1;
    if (code !== 0x2f && isPdfDelimiterCode(code)) {
      index = end;
      continue;
    }
    while (end < length) {
      const next = content.charCodeAt(end);
      if (isPdfWhitespaceCode(next) || isPdfDelimiterCode(next)) break;
      end += 1;
    }
    if (code !== 0x2f) {
      const tokenLength = end - index;
      const second = tokenLength === 2 ? content.charCodeAt(index + 1) : 0;
      if (tokenLength === 1 && (code === 0x27 || code === 0x22)) {
        if (shown === stringOperand) pushPdfTextRun(runs, operandText);
      } else if (tokenLength === 2 && code === 0x54 && second === 0x6a) {
        if (shown === stringOperand) pushPdfTextRun(runs, operandText);
      } else if (tokenLength === 2 && code === 0x54 && second === 0x4a) {
        if (shown === arrayOperand) pushPdfTextRun(runs, operandText);
      } else if (tokenLength === 2 && code === 0x42 && second === 0x49) {
        inlineImage = true;
      } else if (tokenLength === 2 && code === 0x49 && second === 0x44 && inlineImage) {
        inlineImage = false;
        end = skipPdfInlineImageData(content, end);
        if (end < 0) break;
      }
    }
    index = end;
  }
  return runs;
}

function decodePdfHexString(hex: string): string {
  const bytes = new Uint8Array((hex.length >> 1) + 1);
  let count = 0;
  let high = -1;
  for (let index = 0; index < hex.length; index += 1) {
    const digit = pdfHexDigitValue(hex.charCodeAt(index));
    if (digit < 0) continue;
    if (high < 0) {
      high = digit;
    } else {
      bytes[count] = (high << 4) | digit;
      count += 1;
      high = -1;
    }
  }
  // An odd final digit stands for the byte with a zero low nibble.
  if (high >= 0) {
    bytes[count] = high << 4;
    count += 1;
  }
  return decodePdfStringBytes(bytes.subarray(0, count));
}

function decodePdfLiteralString(value: string): string {
  // The common case: no escapes, and not a UTF-16 string. The content was
  // decoded as Latin-1, so every character already is one byte.
  if (value.indexOf('\\') < 0 && !(value.charCodeAt(0) === 0xfe && value.charCodeAt(1) === 0xff)) {
    return value;
  }
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
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
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
    // A password-protected Office file is not a zip at all: Office wraps the
    // encrypted package in a compound-file container.
    if (isCompoundFileContainer(bytes)) {
      throw new OfficeDocumentUnreadableError('encrypted', 'Office document is password-protected.');
    }
    throw new OfficeDocumentUnreadableError('damaged', 'Office document zip directory was not found.');
  }
  const entryCount = readUint16Le(bytes, eocdOffset + 10);
  const centralDirectoryOffset = readUint32Le(bytes, eocdOffset + 16);
  let offset = centralDirectoryOffset;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (readUint32Le(bytes, offset) !== 0x02014b50) {
      throw new OfficeDocumentUnreadableError('damaged', 'Office document zip directory entry is malformed.');
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
      throw new OfficeDocumentUnreadableError('encrypted', 'Encrypted Office document zip entries are not supported.');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new OfficeDocumentUnreadableError(
        'unsupported',
        'Zip64 Office document entries are not supported in the local extractor.',
      );
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
    throw zipEntryExceedsCapError();
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
    throw new OfficeDocumentUnreadableError('damaged', 'Office document zip local entry is malformed.');
  }
  const nameLength = readUint16Le(bytes, offset + 26);
  const extraLength = readUint16Le(bytes, offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
  // The sizes in a zip directory are whatever the file's author wrote, so the
  // cap is enforced on the bytes themselves, not on the declared sizes.
  if (entry.method === 0) {
    if (compressed.length > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) throw zipEntryExceedsCapError();
    return decodeUtf8(compressed);
  }
  if (entry.method === 8) {
    let inflated: Buffer;
    try {
      inflated = inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES });
    } catch (error) {
      if (isInflateOutputLimitError(error)) throw zipEntryExceedsCapError();
      throw new OfficeDocumentUnreadableError('damaged', 'Office document zip entry does not decompress.');
    }
    return decodeUtf8(new Uint8Array(inflated));
  }
  throw new OfficeDocumentUnreadableError(
    'unsupported',
    `Unsupported Office document zip compression method ${entry.method}.`,
  );
}

function zipEntryExceedsCapError(): OfficeDocumentUnreadableError {
  return new OfficeDocumentUnreadableError('unsupported', 'Office document zip entry exceeds the local extraction cap.');
}

function findZipEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.length - 65_558);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (readUint32Le(bytes, offset) === 0x06054b50) return offset;
  }
  return -1;
}

/**
 * The OLE compound-file signature.
 */
function isCompoundFileContainer(bytes: Uint8Array): boolean {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return signature.every((byte, index) => bytes[index] === byte);
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
