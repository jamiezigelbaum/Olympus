/**
 * Reading a scanned PDF without `ocrmypdf`: rasterize with `pdftoppm`, read
 * each page with `tesseract`.
 *
 * `ocrmypdf` is not in the Arch repositories (Arch and Omarchy have it from the
 * AUR only), while `pdftoppm` and `tesseract` are. This is the engine for a
 * host that has those two. It answers the same `ExtractorOutput` as the other
 * engines, with the same bounds as the built-in macOS engine: the same page
 * cap, pages per run, whole-file deadline, and the longest page edge.
 *
 * Bounds. Pages are rendered in short ranges, so memory is bounded by a range
 * rather than by the document, and every process runs under the lane's command
 * timeout. Reading stops at the page cap, at the text cap, or at the whole-file
 * deadline, and the cut is recorded as a warning rather than discarded. The
 * longest-edge pixel cap is enforced on EVERY page: the render resolution of
 * each page is lowered from that page's own size (consecutive pages that
 * share a resolution are rendered together), and when the page sizes are not
 * known (`pdfinfo` failed) the renderer is asked to scale the long edge to a
 * fixed size instead, so a poster-sized page can never produce an enormous
 * bitmap.
 *
 * A PDF the renderer refuses (encrypted, damaged) settles terminally with the
 * lane's historical `ocrmypdf_pdf_*` kinds, because the terminal
 * reclassification rules that hand a refused PDF to the vision lane key on
 * them, whichever engine produced the refusal.
 *
 * Doc comments here are always multi-line blocks, and this module contains no
 * regular expressions.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtractorOutput } from '../types.ts';
import {
  appendWarning,
  boundText,
  buildDerivation,
  mediaDescriptorOutput,
  normalizeExtractedText,
} from './bounded-text.ts';
import {
  DEFAULT_APPLE_VISION_FILE_DEADLINE_MS,
  DEFAULT_APPLE_VISION_MAX_PAGES,
  DEFAULT_APPLE_VISION_PAGES_PER_RUN,
  DEFAULT_APPLE_VISION_PDF_MAX_PIXEL_EDGE,
} from './apple-vision-ocr.ts';
import {
  ExtractionCommandError,
  ExtractionCommandTimeoutError,
  type ExtractionCommandRunner,
} from './command-runner.ts';
import {
  PDFINFO_COMMAND,
  PDFTOPPM_COMMAND,
  TESSERACT_COMMAND,
  TESSERACT_ENV,
  tesseractArguments,
} from './ocr-capability.ts';
import { parsePdfInfoPageCount } from './pdf-render.ts';

export const RASTER_OCR_ENGINE_WARNING = 'ocr_engine_tesseract';
export const DEFAULT_RASTER_OCR_DPI = 200;
const MIN_RASTER_OCR_DPI = 1;
/**
 * The long edge, in pixels, when page sizes are unknown: a Letter or A4 page
 * at roughly 200 dpi, never above the configured cap.
 */
const UNKNOWN_SIZE_RASTER_EDGE = 2400;
const RASTER_PAGE_PREFIX = 'page';
const RASTER_TEMP_PREFIX = 'olympus-extraction-raster-ocr-';

export interface RasterPdfOcrOptions {
  commandRunner: ExtractionCommandRunner;
  /**
   * Per-process timeout: one page range render, or one page read.
   */
  timeoutMs: number;
  maxBoundedTextChars: number;
  maxPages?: number;
  pagesPerRun?: number;
  pdfMaxPixelEdge?: number;
  fileDeadlineMs?: number;
  now?: () => number;
}

export interface RasterPdfOcrInput {
  inputPath: string;
  mimeType: string;
  sizeBytes: number;
}

interface PdfInfo {
  totalPages?: number;
  /**
   * The long edge of each page in points, by page number, for the pages
   * `pdfinfo` described (the first `maxPages`).
   */
  pageLongEdges: Map<number, number>;
}

function parseSizePoints(text: string): number | undefined {
  const [first, second] = text.split('x');
  const width = Number.parseFloat(first ?? '');
  const height = Number.parseFloat(second ?? '');
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return Math.max(width, height);
  }
  return undefined;
}

/**
 * `pdfinfo -f 1 -l N` prints `Page    3 size: 612 x 792 pts (letter)` for each
 * page; without `-f` it prints one `Page size:` line for the first page.
 */
function parsePageSizes(stdout: string): Map<number, number> {
  const sizes = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    if (line.startsWith('Page size:')) {
      const edge = parseSizePoints(line.slice('Page size:'.length));
      if (edge !== undefined && !sizes.has(1)) sizes.set(1, edge);
      continue;
    }
    const words = line.trim().split(' ').filter((word) => word.length > 0);
    if (words[0] !== 'Page' || words[2] !== 'size:') continue;
    const page = Number(words[1]);
    const edge = parseSizePoints(words.slice(3).join(' '));
    if (Number.isInteger(page) && page > 0 && edge !== undefined) sizes.set(page, edge);
  }
  return sizes;
}

async function readPdfInfo(input: {
  inputPath: string;
  maxPages: number;
  options: RasterPdfOcrOptions;
}): Promise<PdfInfo> {
  try {
    const { stdout } = await input.options.commandRunner({
      command: PDFINFO_COMMAND,
      args: ['-f', '1', '-l', String(input.maxPages), input.inputPath],
      timeoutMs: input.options.timeoutMs,
    });
    const totalPages = parsePdfInfoPageCount(stdout);
    return {
      ...(totalPages !== undefined ? { totalPages } : {}),
      pageLongEdges: parsePageSizes(stdout),
    };
  } catch {
    // Best effort, as in the other renderer: a page count is an optimization,
    // and the unknown-size render path still enforces the pixel cap.
    return { pageLongEdges: new Map() };
  }
}

/**
 * The render resolution for one page: the default, lowered (to as little as 1
 * dpi) when that page's long edge would exceed the pixel cap at the default.
 */
export function rasterDpiFor(longEdgePoints: number | undefined, maxPixelEdge: number): number {
  if (longEdgePoints === undefined) return DEFAULT_RASTER_OCR_DPI;
  const fitting = Math.floor((maxPixelEdge * 72) / longEdgePoints);
  return Math.max(MIN_RASTER_OCR_DPI, Math.min(DEFAULT_RASTER_OCR_DPI, fitting));
}

/**
 * How one page is rendered: at a resolution, or scaled to a long edge when
 * its size is unknown.
 */
function renderSpecFor(longEdgePoints: number | undefined, maxPixelEdge: number): string[] {
  if (longEdgePoints === undefined) {
    return ['-scale-to', String(Math.max(1, Math.min(maxPixelEdge, UNKNOWN_SIZE_RASTER_EDGE)))];
  }
  return ['-r', String(rasterDpiFor(longEdgePoints, maxPixelEdge))];
}

/**
 * Terminal-versus-retryable for a PDF the renderer refused. `pdftoppm` exits 1
 * when it cannot open the file, and says "Incorrect password" when it is
 * encrypted. Anything else is a transient failure and stays retryable.
 */
export function classifyRasterPdfRejection(
  error: unknown,
): 'ocrmypdf_pdf_encrypted' | 'ocrmypdf_pdf_invalid' | undefined {
  if (!(error instanceof ExtractionCommandError) || error.command !== PDFTOPPM_COMMAND) return undefined;
  const detail = `${error.stderr}\n${error.stdout}`.toLowerCase();
  if (detail.includes('incorrect password') || detail.includes('encrypted')) return 'ocrmypdf_pdf_encrypted';
  if (error.exitCode === 1) return 'ocrmypdf_pdf_invalid';
  return undefined;
}

function renderedPageNumber(name: string): number | undefined {
  const lead = `${RASTER_PAGE_PREFIX}-`;
  if (!name.startsWith(lead) || !name.endsWith('.png')) return undefined;
  const number = Number(name.slice(lead.length, -'.png'.length));
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

interface ReadPage {
  page: number;
  text: string;
  unreadable?: boolean;
}

/**
 * Read a scanned PDF page range by page range.
 */
export async function rasterPdfOcr(
  input: RasterPdfOcrInput,
  options: RasterPdfOcrOptions,
): Promise<ExtractorOutput> {
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_APPLE_VISION_MAX_PAGES));
  const pagesPerRun = Math.max(1, Math.floor(options.pagesPerRun ?? DEFAULT_APPLE_VISION_PAGES_PER_RUN));
  const maxPixelEdge = options.pdfMaxPixelEdge ?? DEFAULT_APPLE_VISION_PDF_MAX_PIXEL_EDGE;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.fileDeadlineMs ?? DEFAULT_APPLE_VISION_FILE_DEADLINE_MS);
  const info = await readPdfInfo({ inputPath: input.inputPath, maxPages, options });
  const tempDir = await mkdtemp(join(tmpdir(), RASTER_TEMP_PREFIX));
  const pages: ReadPage[] = [];
  let attempted = 0;
  let failed = 0;
  let lastFailure: unknown;
  let chars = 0;
  let stopReason: 'pages' | 'text' | 'time' | undefined;
  try {
    let firstPage = 1;
    rangeLoop: for (;;) {
      const lastPage = Math.min(firstPage + pagesPerRun - 1, maxPages, info.totalPages ?? maxPages);
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        stopReason = 'time';
        break;
      }
      try {
        // Consecutive pages that render the same way go in one process.
        let groupStart = firstPage;
        while (groupStart <= lastPage) {
          const spec = renderSpecFor(info.pageLongEdges.get(groupStart), maxPixelEdge);
          let groupEnd = groupStart;
          while (
            groupEnd < lastPage
            && renderSpecFor(info.pageLongEdges.get(groupEnd + 1), maxPixelEdge).join(' ') === spec.join(' ')
          ) groupEnd += 1;
          await options.commandRunner({
            command: PDFTOPPM_COMMAND,
            args: [
              '-f', String(groupStart),
              '-l', String(groupEnd),
              ...spec,
              '-gray',
              '-png',
              input.inputPath,
              join(tempDir, RASTER_PAGE_PREFIX),
            ],
            timeoutMs: Math.min(options.timeoutMs, remainingMs),
          });
          groupStart = groupEnd + 1;
        }
      } catch (error) {
        const rejection = classifyRasterPdfRejection(error);
        if (rejection) return { status: 'failed_terminal', errorKind: rejection };
        // A deadline-shortened render that times out after pages were read
        // keeps what was read; a full-length timeout is the lane's ordinary failure.
        if (error instanceof ExtractionCommandTimeoutError && pages.length > 0 && remainingMs < options.timeoutMs) {
          stopReason = 'time';
          break;
        }
        // Without a page count, a range past the last page is how the renderer
        // says the document ended.
        if (info.totalPages === undefined && firstPage > 1 && error instanceof ExtractionCommandError) break;
        throw error;
      }
      const files = (await readdir(tempDir))
        .map((name) => ({ name, page: renderedPageNumber(name) }))
        .filter((entry): entry is { name: string; page: number } => entry.page !== undefined)
        .sort((left, right) => left.page - right.page);
      if (files.length === 0) {
        // The document ended before this range (page count was unknown).
        if (firstPage === 1) throw new Error('Local PDF rendering produced no page images.');
        break;
      }
      for (const file of files) {
        const left = deadline - now();
        if (left <= 0) {
          stopReason = 'time';
          break rangeLoop;
        }
        attempted += 1;
        const path = join(tempDir, file.name);
        try {
          const { stdout } = await options.commandRunner({
            command: TESSERACT_COMMAND,
            args: tesseractArguments(path),
            timeoutMs: Math.min(options.timeoutMs, left),
            env: TESSERACT_ENV,
          });
          pages.push({ page: file.page, text: stdout });
          chars += stdout.length;
        } catch (error) {
          if (error instanceof ExtractionCommandTimeoutError && pages.length > 0 && left < options.timeoutMs) {
            stopReason = 'time';
            break rangeLoop;
          }
          // Do not mistake a missing reader for an unreadable page.
          if (!(error instanceof ExtractionCommandError || error instanceof ExtractionCommandTimeoutError)) throw error;
          failed += 1;
          lastFailure = error;
          pages.push({ page: file.page, text: '', unreadable: true });
        }
        await rm(path, { force: true });
      }
      const renderedLast = files[files.length - 1]!.page;
      if (info.totalPages !== undefined ? renderedLast >= info.totalPages : renderedLast < lastPage) break;
      if (renderedLast >= maxPages) {
        stopReason = 'pages';
        break;
      }
      if (chars >= options.maxBoundedTextChars) {
        stopReason = 'text';
        break;
      }
      firstPage = renderedLast + 1;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  // A command failure that left nothing read means the reader is broken or
  // the document was only partly looked at, not that the pages are empty:
  // settle as a transient failure rather than index nothing. This covers
  // every page failing and also some failing while the rest were blank.
  const read = pages.filter((page) => normalizeExtractedText(page.text).length > 0);
  if (read.length === 0 && failed > 0) throw lastFailure;
  // The deadline passed before a single page was looked at: nothing was read.
  if (pages.length === 0) throw new Error('Local PDF rendering ran out of time before any page was read.');

  // Warnings that say the read was cut short or partial, on whichever output
  // is settled, so an incomplete read never looks like an ordinary one.
  const incompleteWarnings = (): string[] => [
    ...(stopReason === 'pages' ? ['ocr_pdf_pages_capped'] : []),
    ...(stopReason === 'time' ? ['ocr_pdf_time_capped'] : []),
    ...(pages.some((page) => page.unreadable) ? ['ocr_pdf_page_unreadable'] : []),
  ];
  if (read.length === 0) {
    return mediaDescriptorOutput({
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      maxBoundedTextChars: options.maxBoundedTextChars,
      kind: 'media',
      label: 'scanned or image-only pdf',
      warnings: ['ocr_empty', 'pdf_image_only', RASTER_OCR_ENGINE_WARNING, ...incompleteWarnings()],
    });
  }
  const joined = read
    .map((page) => `--- Page ${page.page} ---\n${normalizeExtractedText(page.text)}`)
    .join('\n\n');
  const bounded = boundText(joined, options.maxBoundedTextChars);
  let warnings: string[] = [
    'ocr_text',
    RASTER_OCR_ENGINE_WARNING,
    'ocr_confidence_unavailable',
    'ocr_source_rasterized_pdf',
  ];
  if (stopReason === 'pages') warnings = appendWarning(warnings, 'ocr_pdf_pages_capped');
  if (stopReason === 'time') warnings = appendWarning(warnings, 'ocr_pdf_time_capped');
  if (pages.some((page) => page.unreadable)) warnings = appendWarning(warnings, 'ocr_pdf_page_unreadable');
  const derivation = buildDerivation({
    artifact: 'image_ocr',
    structural: { kind: 'whole_file', label: 'pdf ocr text' },
    bounded,
    confidence: 0.5,
    warnings,
  });
  const capped = stopReason === 'pages' || stopReason === 'time';
  return {
    status: 'indexed',
    text: bounded.text,
    derivations: [{
      ...derivation,
      structuralRef: {
        ...derivation.structuralRef,
        readPages: pages.length,
        ...(info.totalPages !== undefined ? { totalPages: info.totalPages } : {}),
      },
    }],
    ...(capped || bounded.warnings.length > 0
      ? {
          warnings: [
            ...(stopReason === 'pages' ? ['ocr_pdf_pages_capped'] : []),
            ...(stopReason === 'time' ? ['ocr_pdf_time_capped'] : []),
            ...bounded.warnings,
          ],
        }
      : {}),
  };
}
