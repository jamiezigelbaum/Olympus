/**
 * B3 — the local text lane.
 *
 * Port of the production text content extractor: WordprocessingML,
 * SpreadsheetML, DrawingML, the PDF text layer (inline decoder or a local
 * command), delimited tables, and plain text. Nothing here reaches the network.
 *
 * Two differences from the lane it replaces, both forced by the landed seam and
 * neither a behaviour change:
 *
 *   - Artifacts no longer carry `extractor_kind` / `extractor_version`. That
 *     provenance lives on the job row now, stamped once by the runner, instead
 *     of being copied onto every derived slice.
 *   - The image branch no longer substring-matches the requested kind string to
 *     decide whether to emit a descriptor. It is a constructor option, so the
 *     decision is made once at registration instead of re-derived per job.
 *
 * Doc comments here are always multi-line blocks, and every regex in this
 * directory lives inside a named, allowlisted function — which is why the
 * decoders live in `document-formats.ts` and this file has none of its own.
 */

import type { ExtractionDerivation, Extractor, ExtractorInput, ExtractorOutput } from '../types.ts';
import {
  DEFAULT_MAX_BOUNDED_TEXT_CHARS,
  DEFAULT_MAX_TABLE_SAMPLE_COLUMNS,
  DEFAULT_MAX_TABLE_SAMPLE_ROWS,
  DOCX_MIME_TYPE,
  IMAGE_MIME_TYPES,
  PDF_MIME_TYPE,
  PPTX_MIME_TYPE,
  TABLE_MIME_TYPES,
  TEXT_MIME_TYPES,
  XLSX_MIME_TYPE,
  appendBoundedTextWarnings,
  boundText,
  buildDerivation,
  mediaDescriptorOutput,
  normalizeExtractedText,
  normalizeMimeType,
  type BoundedText,
} from './bounded-text.ts';
import {
  runExtractionCommand,
  type ExtractionCommandRunner,
} from './command-runner.ts';
import {
  compareOfficePartNames,
  decodeUtf8,
  extractDrawingMlTables,
  extractOfficeDocumentProperties,
  extractPdfTextStreams,
  extractWordComments,
  extractWordParagraphs,
  extractWordTables,
  extractXlsxRows,
  extractXlsxSharedStrings,
  extractXlsxSheetNames,
  extractXmlTagText,
  isBinaryLike,
  isNotesSlidePart,
  isSlidePart,
  isWordFooterPart,
  isWordHeaderPart,
  isWorksheetPart,
  officePartNumber,
  officeTableSummary,
  parseDelimitedRows,
  pdfAppearsImageOnly,
  readZipEntries,
  readZipEntryText,
  sheetXmlHasFormula,
  tableSummary,
  normalizeTableCell,
  type ZipEntryDirectoryRecord,
} from './document-formats.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEXT_EXTRACTOR_KIND = 'local_text';
export const TEXT_EXTRACTOR_VERSION = '2026-05-22';
export const DEFAULT_PDF_TEXT_TIMEOUT_MS = 120_000;

const TEMP_DIR_PREFIX = 'olympus-extraction-pdf-text-';
const DOCUMENT_BODY_LABEL = 'document body';

export interface TextExtractorOptions {
  kind?: string;
  version?: string;
  maxBoundedTextChars?: number;
  maxTableSampleRows?: number;
  maxTableSampleColumns?: number;
  pdfTextCommand?: string;
  pdfTextCommandRunner?: ExtractionCommandRunner;
  pdfTextTimeoutMs?: number;
  /**
   * Emit a media descriptor for an image instead of declining it.
   *
   * The production lane decided this per job by testing the requested kind
   * string for `visual` or `media_descriptor`. Under an explicit registry the
   * decision belongs to registration: a kind that wants descriptors registers
   * an instance with this set, and the default `local_text` instance does not.
   */
  imageMediaDescriptor?: boolean;
}

interface DerivedSlice {
  derivation: ExtractionDerivation;
  text: string;
  label?: string;
}

interface FormatContext {
  bytes: Uint8Array;
  mimeType: string | undefined;
  sizeBytes: number;
  maxBoundedTextChars: number;
  maxTableSampleRows: number;
  maxTableSampleColumns: number;
}

export function createTextExtractor(options: TextExtractorOptions = {}): Extractor {
  const kind = options.kind ?? TEXT_EXTRACTOR_KIND;
  const version = options.version ?? TEXT_EXTRACTOR_VERSION;
  const maxBoundedTextChars = options.maxBoundedTextChars ?? DEFAULT_MAX_BOUNDED_TEXT_CHARS;
  const maxTableSampleRows = options.maxTableSampleRows ?? DEFAULT_MAX_TABLE_SAMPLE_ROWS;
  const maxTableSampleColumns = options.maxTableSampleColumns ?? DEFAULT_MAX_TABLE_SAMPLE_COLUMNS;
  const pdfTextCommand = options.pdfTextCommand?.trim() || undefined;
  const pdfTextCommandRunner = options.pdfTextCommandRunner ?? runExtractionCommand;
  const pdfTextTimeoutMs = options.pdfTextTimeoutMs ?? DEFAULT_PDF_TEXT_TIMEOUT_MS;
  const imageMediaDescriptor = options.imageMediaDescriptor ?? false;
  return {
    kind,
    version,
    needsBytes: true,
    egress: 'local',
    accepts(mimeType) {
      return textLaneAccepts(mimeType);
    },
    async extract(input: ExtractorInput): Promise<ExtractorOutput> {
      const bytes = input.bytes;
      if (!bytes) return missingBytesFailure();
      const mimeType = normalizeMimeType(input.mimeType ?? input.ref.mimeType);
      const context: FormatContext = {
        bytes,
        mimeType,
        sizeBytes: input.sizeBytes ?? bytes.byteLength,
        maxBoundedTextChars,
        maxTableSampleRows,
        maxTableSampleColumns,
      };
      if (mimeType === DOCX_MIME_TYPE) {
        return structuredExtractionOrFailure(() => extractDocx(context));
      }
      if (mimeType === XLSX_MIME_TYPE) {
        return structuredExtractionOrFailure(() => extractXlsx(context));
      }
      if (mimeType === PPTX_MIME_TYPE) {
        return structuredExtractionOrFailure(() => extractPptx(context));
      }
      if (mimeType === PDF_MIME_TYPE) {
        return extractPdfText({
          context,
          ...(pdfTextCommand ? { command: pdfTextCommand } : {}),
          commandRunner: pdfTextCommandRunner,
          timeoutMs: pdfTextTimeoutMs,
        });
      }
      if (mimeType && IMAGE_MIME_TYPES.has(mimeType)) {
        if (!imageMediaDescriptor) {
          return { status: 'metadata_only' };
        }
        return mediaDescriptorOutput({
          mimeType,
          sizeBytes: context.sizeBytes,
          maxBoundedTextChars,
          kind: 'image',
          label: 'image file',
          warnings: ['ocr_required', 'image_only'],
        });
      }
      if (!mimeType || !TEXT_MIME_TYPES.has(mimeType)) {
        return { status: 'skipped_unsupported' };
      }
      if (isBinaryLike(bytes)) {
        return { status: 'skipped_unsupported' };
      }
      const text = decodeUtf8(bytes);
      if (TABLE_MIME_TYPES.has(mimeType)) {
        return extractDelimitedText({
          context,
          text,
          delimiter: mimeType === 'text/tab-separated-values' ? '\t' : ',',
        });
      }
      const bounded = boundText(normalizeExtractedText(text), maxBoundedTextChars);
      if (!bounded.text) {
        return { status: 'empty_output' };
      }
      return {
        status: 'indexed',
        text: bounded.text,
        derivations: [buildDerivation({
          artifact: 'text',
          structural: { kind: 'whole_file' },
          bounded,
        })],
        ...(bounded.warnings.length > 0 ? { warnings: [...bounded.warnings] } : {}),
      };
    },
  };
}

/**
 * Broad on purpose: the OCR lane composes this extractor for anything that is
 * neither a PDF nor an image, so the accepted set has to cover everything the
 * text lane can read.
 */
export function textLaneAccepts(mimeType: string | undefined): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) return false;
  return normalized === PDF_MIME_TYPE
    || normalized === DOCX_MIME_TYPE
    || normalized === XLSX_MIME_TYPE
    || normalized === PPTX_MIME_TYPE
    || IMAGE_MIME_TYPES.has(normalized)
    || TEXT_MIME_TYPES.has(normalized);
}

/**
 * The runner promises bytes to any extractor declaring `needsBytes`. This is
 * the invariant-violation branch, which the production input type could not
 * even express because its `bytes` field was required.
 */
export function missingBytesFailure(): ExtractorOutput {
  return { status: 'failed_terminal', errorKind: 'extractor_input_missing_bytes' };
}

/**
 * A malformed container throws out of the decoders. The production lane caught
 * it here and reported a retryable failure carrying the exception message;
 * `errorKind` is a bounded categorical token on the landed seam, so the message
 * is dropped and the category is kept.
 */
function structuredExtractionOrFailure(extract: () => ExtractorOutput): ExtractorOutput {
  try {
    return extract();
  } catch {
    return { status: 'failed_retryable', errorKind: 'structured_extraction_failed' };
  }
}

function joinedOutput(
  slices: readonly DerivedSlice[],
  joinedText: string,
  maxBoundedTextChars: number,
): ExtractorOutput {
  const bounded = boundText(normalizeExtractedText(joinedText), maxBoundedTextChars);
  if (!bounded.text) {
    return { status: 'empty_output' };
  }
  return {
    status: 'indexed',
    text: bounded.text,
    derivations: slices.map((slice) => slice.derivation),
    ...(bounded.warnings.length > 0 ? { warnings: bounded.warnings } : {}),
  };
}

// --- WordprocessingML ------------------------------------------------------

function extractDocx(context: FormatContext): ExtractorOutput {
  const entries = readZipEntries(context.bytes);
  const sections: Array<{ label: string; index?: number; paragraphs: string[] }> = [];
  sections.push({
    label: DOCUMENT_BODY_LABEL,
    paragraphs: extractWordParagraphs(readZipEntryText(context.bytes, entries, 'word/document.xml')),
  });
  sections.push({
    label: 'footnotes',
    paragraphs: extractWordParagraphs(readZipEntryText(context.bytes, entries, 'word/footnotes.xml')),
  });
  sections.push({
    label: 'endnotes',
    paragraphs: extractWordParagraphs(readZipEntryText(context.bytes, entries, 'word/endnotes.xml')),
  });
  for (const name of [...entries.keys()].filter(isWordHeaderPart).sort(compareOfficePartNames)) {
    sections.push({
      label: 'header',
      index: officePartNumber(name),
      paragraphs: extractWordParagraphs(readZipEntryText(context.bytes, entries, name)),
    });
  }
  for (const name of [...entries.keys()].filter(isWordFooterPart).sort(compareOfficePartNames)) {
    sections.push({
      label: 'footer',
      index: officePartNumber(name),
      paragraphs: extractWordParagraphs(readZipEntryText(context.bytes, entries, name)),
    });
  }
  sections.push({
    label: 'comments',
    paragraphs: extractWordComments(readZipEntryText(context.bytes, entries, 'word/comments.xml')),
  });
  const documentXml = readZipEntryText(context.bytes, entries, 'word/document.xml');
  const slices: DerivedSlice[] = [];
  for (const section of sections) {
    const bounded = boundText(
      normalizeExtractedText(section.paragraphs.join('\n')),
      context.maxBoundedTextChars,
    );
    if (!bounded.text) continue;
    const label = section.index !== undefined ? `${section.label} ${section.index}` : section.label;
    slices.push({
      text: bounded.text,
      label,
      derivation: buildDerivation({
        artifact: 'text',
        structural: {
          kind: section.label === DOCUMENT_BODY_LABEL ? 'whole_file' : 'section',
          label,
          ...(section.index !== undefined ? { index: section.index } : {}),
        },
        bounded,
      }),
    });
  }
  const propertiesSlice = officeDocumentPropertiesSlice(context, entries);
  if (propertiesSlice) slices.push(propertiesSlice);
  for (const [tableIndex, rows] of extractWordTables(documentXml).entries()) {
    const tableNumber = tableIndex + 1;
    const bounded = boundText(officeTableSummary({
      label: `DOCX table ${tableNumber}`,
      rows,
      maxRows: DEFAULT_MAX_TABLE_SAMPLE_ROWS,
      maxColumns: DEFAULT_MAX_TABLE_SAMPLE_COLUMNS,
    }), context.maxBoundedTextChars);
    if (!bounded.text) continue;
    slices.push({
      text: bounded.text,
      label: `table ${tableNumber}`,
      derivation: buildDerivation({
        artifact: 'table',
        structural: { kind: 'range', index: tableNumber, label: `table ${tableNumber}` },
        bounded,
      }),
    });
  }
  const joined = slices
    .map((slice) => (slice.label === DOCUMENT_BODY_LABEL ? slice.text : `${slice.label}\n${slice.text}`))
    .join('\n\n');
  return joinedOutput(slices, joined, context.maxBoundedTextChars);
}

function officeDocumentPropertiesSlice(
  context: FormatContext,
  entries: Map<string, ZipEntryDirectoryRecord>,
): DerivedSlice | undefined {
  const bounded = boundText(
    extractOfficeDocumentProperties(context.bytes, entries),
    context.maxBoundedTextChars,
  );
  if (!bounded.text) return undefined;
  return {
    text: bounded.text,
    label: 'document properties',
    derivation: buildDerivation({
      artifact: 'text',
      structural: { kind: 'section', label: 'document properties' },
      bounded,
      warnings: ['office_document_properties'],
    }),
  };
}

// --- PDF text layer --------------------------------------------------------

async function extractPdfText(input: {
  context: FormatContext;
  command?: string;
  commandRunner: ExtractionCommandRunner;
  timeoutMs: number;
}): Promise<ExtractorOutput> {
  if (input.command) {
    return extractPdfTextWithCommand({
      context: input.context,
      command: input.command,
      commandRunner: input.commandRunner,
      timeoutMs: input.timeoutMs,
    });
  }
  const streamTexts = extractPdfTextStreams(input.context.bytes);
  const bounded = boundText(
    normalizeExtractedText(streamTexts.join('\n')),
    input.context.maxBoundedTextChars,
  );
  return pdfTextExtractionResult({
    context: input.context,
    bounded,
    warnings: ['pdf_text_layer_only'],
  });
}

async function extractPdfTextWithCommand(input: {
  context: FormatContext;
  command: string;
  commandRunner: ExtractionCommandRunner;
  timeoutMs: number;
}): Promise<ExtractorOutput> {
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    const inputPath = join(tempDir, 'input.pdf');
    await writeFile(inputPath, input.context.bytes);
    const result = await input.commandRunner({
      command: input.command,
      args: [
        '-layout',
        '-enc',
        'UTF-8',
        '-nopgbrk',
        inputPath,
        '-',
      ],
      timeoutMs: input.timeoutMs,
    });
    const bounded = boundText(
      normalizeExtractedText(result.stdout),
      input.context.maxBoundedTextChars,
    );
    return pdfTextExtractionResult({
      context: input.context,
      bounded,
      warnings: ['pdf_text_layer_only', 'pdf_text_poppler'],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function pdfTextExtractionResult(input: {
  context: FormatContext;
  bounded: BoundedText;
  warnings: readonly string[];
}): ExtractorOutput {
  if (!input.bounded.text) {
    if (pdfAppearsImageOnly(input.context.bytes)) {
      return mediaDescriptorOutput({
        mimeType: input.context.mimeType,
        sizeBytes: input.context.sizeBytes,
        maxBoundedTextChars: input.context.maxBoundedTextChars,
        kind: 'media',
        label: 'scanned or image-only pdf',
        warnings: ['ocr_required', 'pdf_image_only', 'no_selectable_text_layer'],
      });
    }
    return { status: 'empty_output' };
  }
  return {
    status: 'indexed',
    text: input.bounded.text,
    derivations: [buildDerivation({
      artifact: 'text',
      structural: { kind: 'whole_file', label: 'pdf text layer' },
      bounded: input.bounded,
      warnings: input.warnings,
    })],
    ...(input.bounded.warnings.length > 0 ? { warnings: [...input.bounded.warnings] } : {}),
  };
}

// --- DrawingML presentations ----------------------------------------------

function extractPptx(context: FormatContext): ExtractorOutput {
  const entries = readZipEntries(context.bytes);
  const slideEntries = [...entries.keys()].filter(isSlidePart).sort(compareOfficePartNames);
  const slices: DerivedSlice[] = [];
  const textBlocks: string[] = [];
  const propertiesSlice = officeDocumentPropertiesSlice(context, entries);
  if (propertiesSlice) {
    slices.push(propertiesSlice);
    textBlocks.push(`document properties\n${propertiesSlice.text}`);
  }
  for (const [slideIndex, name] of slideEntries.entries()) {
    const slideNumber = slideIndex + 1;
    const slideXml = readZipEntryText(context.bytes, entries, name);
    const text = normalizeExtractedText(extractXmlTagText(slideXml, 'a:t').join('\n'));
    if (text) {
      const bounded = boundText(text, context.maxBoundedTextChars);
      textBlocks.push(`Slide ${slideNumber}\n${bounded.text}`);
      slices.push({
        text: bounded.text,
        label: `slide ${slideNumber}`,
        derivation: buildDerivation({
          artifact: 'slide',
          structural: { kind: 'slide', index: slideNumber, label: `slide ${slideNumber}` },
          bounded,
        }),
      });
    }
    for (const [tableIndex, rows] of extractDrawingMlTables(slideXml).entries()) {
      const tableNumber = tableIndex + 1;
      const bounded = boundText(officeTableSummary({
        label: `PPTX slide ${slideNumber} table ${tableNumber}`,
        rows,
        maxRows: DEFAULT_MAX_TABLE_SAMPLE_ROWS,
        maxColumns: DEFAULT_MAX_TABLE_SAMPLE_COLUMNS,
      }), context.maxBoundedTextChars);
      if (!bounded.text) continue;
      textBlocks.push(`Slide ${slideNumber} table ${tableNumber}\n${bounded.text}`);
      slices.push({
        text: bounded.text,
        label: `slide ${slideNumber} table ${tableNumber}`,
        derivation: buildDerivation({
          artifact: 'table',
          structural: {
            kind: 'range',
            index: tableNumber,
            label: `slide ${slideNumber} table ${tableNumber}`,
          },
          bounded,
        }),
      });
    }
  }
  for (const name of [...entries.keys()].filter(isNotesSlidePart).sort(compareOfficePartNames)) {
    const slideNumber = officePartNumber(name);
    const text = normalizeExtractedText(
      extractXmlTagText(readZipEntryText(context.bytes, entries, name), 'a:t').join('\n'),
    );
    if (!text) continue;
    const bounded = boundText(text, context.maxBoundedTextChars);
    textBlocks.push(`Slide ${slideNumber} notes\n${bounded.text}`);
    slices.push({
      text: bounded.text,
      label: `slide ${slideNumber} notes`,
      derivation: buildDerivation({
        artifact: 'slide',
        structural: { kind: 'slide', index: slideNumber, label: `slide ${slideNumber} notes` },
        bounded,
      }),
    });
  }
  return joinedOutput(slices, textBlocks.join('\n\n'), context.maxBoundedTextChars);
}

// --- SpreadsheetML ---------------------------------------------------------

function extractXlsx(context: FormatContext): ExtractorOutput {
  const entries = readZipEntries(context.bytes);
  const sharedStrings = extractXlsxSharedStrings(
    readZipEntryText(context.bytes, entries, 'xl/sharedStrings.xml'),
  );
  const sheetNames = extractXlsxSheetNames(readZipEntryText(context.bytes, entries, 'xl/workbook.xml'));
  const sheetEntries = [...entries.keys()].filter(isWorksheetPart).sort(compareOfficePartNames);
  const slices: DerivedSlice[] = [];
  const textBlocks: string[] = [];
  const propertiesSlice = officeDocumentPropertiesSlice(context, entries);
  if (propertiesSlice) {
    slices.push(propertiesSlice);
    textBlocks.push(`document properties\n${propertiesSlice.text}`);
  }
  for (const [sheetIndex, name] of sheetEntries.entries()) {
    const sheetNumber = sheetIndex + 1;
    const sheetXml = readZipEntryText(context.bytes, entries, name);
    const rows = extractXlsxRows(sheetXml, sharedStrings)
      .filter((row) => row.some((cell) => cell.trim().length > 0));
    if (rows.length === 0) continue;
    const sheetLabel = sheetNames[sheetIndex] ?? `sheet ${sheetNumber}`;
    const columnCount = Math.max(...rows.map((row) => row.length));
    const sampledRows = rows
      .slice(0, context.maxTableSampleRows)
      .map((row) => row.slice(0, context.maxTableSampleColumns).map(normalizeTableCell));
    const warnings: string[] = [];
    if (rows.length > context.maxTableSampleRows) warnings.push('row_sample_truncated');
    if (columnCount > context.maxTableSampleColumns) warnings.push('column_sample_truncated');
    if (sheetXmlHasFormula(sheetXml)) warnings.push('formula_values_static');
    const text = replaceTableSummaryLabel(
      tableSummary({
        rows: sampledRows,
        totalRows: rows.length,
        totalColumns: columnCount,
        delimiter: '\t',
      }),
      `XLSX ${sheetLabel}`,
    );
    const bounded = boundText(text, context.maxBoundedTextChars);
    textBlocks.push(bounded.text);
    slices.push({
      text: bounded.text,
      label: sheetLabel,
      derivation: buildDerivation({
        artifact: 'sheet',
        structural: { kind: 'sheet', index: sheetNumber, label: sheetLabel },
        bounded,
        warnings,
      }),
    });
  }
  return joinedOutput(slices, textBlocks.join('\n\n'), context.maxBoundedTextChars);
}

/**
 * Swap the generic delimited-table heading for the sheet's own name.
 *
 * The production lane did this with an anchored replace on the summary's first
 * line. Expressed here as a prefix swap so the file keeps no regex of its own.
 */
function replaceTableSummaryLabel(summary: string, label: string): string {
  const heading = 'TSV table';
  return summary.startsWith(heading) ? `${label}${summary.slice(heading.length)}` : summary;
}

// --- delimited text --------------------------------------------------------

function extractDelimitedText(input: {
  context: FormatContext;
  text: string;
  delimiter: ',' | '\t';
}): ExtractorOutput {
  const { context } = input;
  const rows = parseDelimitedRows(input.text, input.delimiter);
  const nonEmptyRows = rows.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (nonEmptyRows.length === 0) {
    return { status: 'empty_output' };
  }
  const columnCount = Math.max(...nonEmptyRows.map((row) => row.length));
  const sampledRows = nonEmptyRows
    .slice(0, context.maxTableSampleRows)
    .map((row) => row.slice(0, context.maxTableSampleColumns).map(normalizeTableCell));
  const normalizedText = tableSummary({
    rows: sampledRows,
    totalRows: nonEmptyRows.length,
    totalColumns: columnCount,
    delimiter: input.delimiter,
  });
  const bounded = boundText(normalizedText, context.maxBoundedTextChars);
  if (!bounded.text) {
    return { status: 'empty_output' };
  }
  const warnings: string[] = [];
  if (nonEmptyRows.length > context.maxTableSampleRows) warnings.push('row_sample_truncated');
  if (columnCount > context.maxTableSampleColumns) warnings.push('column_sample_truncated');
  return {
    status: 'indexed',
    text: bounded.text,
    derivations: [buildDerivation({
      artifact: 'table',
      structural: {
        kind: 'range',
        label: `rows 1-${sampledRows.length}, columns 1-${Math.min(columnCount, context.maxTableSampleColumns)}`,
      },
      bounded,
      warnings,
    })],
    ...(bounded.warnings.length > 0
      ? { warnings: appendBoundedTextWarnings(undefined, bounded) }
      : {}),
  };
}
