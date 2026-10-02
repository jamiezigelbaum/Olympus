/**
 * Built-in scan reading on macOS: the OCR lane's zero-install engine.
 *
 * A fresh Mac has no OCR command installed, but it ships PDFKit and Vision.
 * The packaged JXA script `scripts/macos-vision-ocr.js` drives both through
 * `/usr/bin/osascript -l JavaScript`, which every Mac has: PDFKit renders a
 * page to a bitmap, Vision's accurate recognizer reads it on-device with
 * automatic language detection. No Xcode, no Homebrew, no network, and no
 * privacy permission is requested.
 *
 * This module is the engine, not the lane. It reads a file that the lane has
 * already written to a private temp directory and answers an
 * `ExtractorOutput`, or throws `AppleVisionOcrUnavailableError` when this host
 * cannot run the engine at all, which tells the lane to fall back to the
 * tesseract commands. Everything else it throws is a transient command failure
 * that the lane settles as retryable.
 *
 * Bounds. A PDF is read in short page ranges, one `osascript` process per
 * range, so memory is bounded by a range rather than by the document and every
 * process runs under the lane's command timeout. Reading stops at the page
 * cap, at the text cap, or at the whole-file deadline, and the cut is recorded
 * as a warning rather than discarded.
 *
 * Doc comments here are always multi-line blocks, and this module contains no
 * regular expressions.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractorOutput } from '../types.ts';
import {
  appendWarning,
  boundText,
  buildDerivation,
  mediaDescriptorOutput,
  normalizeExtractedText,
} from './bounded-text.ts';
import {
  ExtractionCommandError,
  ExtractionCommandTimeoutError,
  type ExtractionCommandRunner,
} from './command-runner.ts';

export const APPLE_VISION_OCR_SCRIPT = 'scripts/macos-vision-ocr.js';
export const APPLE_VISION_OSASCRIPT = '/usr/bin/osascript';
export const APPLE_VISION_ENGINE_WARNING = 'ocr_engine_apple_vision';
export const DEFAULT_APPLE_VISION_MAX_PAGES = 100;
export const DEFAULT_APPLE_VISION_PAGES_PER_RUN = 8;
export const DEFAULT_APPLE_VISION_PDF_MAX_PIXEL_EDGE = 3000;
export const DEFAULT_APPLE_VISION_IMAGE_MAX_PIXEL_EDGE = 4096;
export const DEFAULT_APPLE_VISION_FILE_DEADLINE_MS = 600_000;

/**
 * The script's exit codes, mirrored from the header of
 * `scripts/macos-vision-ocr.js`. Any other non-zero exit is transient.
 */
export const APPLE_VISION_EXIT_INPUT_UNREADABLE = 65;
export const APPLE_VISION_EXIT_PDF_LOCKED = 66;
export const APPLE_VISION_EXIT_ENGINE_UNAVAILABLE = 69;

/**
 * Which OCR engine the lane uses. `auto` reads with Vision on macOS and with
 * tesseract/ocrmypdf everywhere else, or when Vision cannot run on this Mac;
 * `tesseract` keeps the installed commands even on a Mac.
 */
export type OcrEnginePreference = 'auto' | 'tesseract';
export const OCR_ENGINE_PREFERENCES: readonly OcrEnginePreference[] = ['auto', 'tesseract'];

export class AppleVisionOcrUnavailableError extends Error {
  constructor(reason: string) {
    super(`Built-in macOS scan reading is unavailable: ${reason}.`);
    this.name = 'AppleVisionOcrUnavailableError';
  }
}

export interface AppleVisionOcrOptions {
  commandRunner: ExtractionCommandRunner;
  /**
   * Absolute path of the packaged script. Undefined means it was not found,
   * which makes the engine unavailable rather than failing jobs.
   */
  scriptPath: string | undefined;
  /**
   * Per-process timeout: one page range, or one image.
   */
  timeoutMs: number;
  maxBoundedTextChars: number;
  maxPages?: number;
  pagesPerRun?: number;
  pdfMaxPixelEdge?: number;
  imageMaxPixelEdge?: number;
  fileDeadlineMs?: number;
  osascriptPath?: string;
  now?: () => number;
}

export interface AppleVisionOcrInput {
  inputPath: string;
  mimeType: string;
  sizeBytes: number;
}

interface ScriptPage {
  page: number;
  text: string;
  confidence: number;
  unreadable?: boolean;
}

interface ScriptResult {
  totalPages: number;
  pages: ScriptPage[];
}

/**
 * Find the packaged script by walking up from this module.
 *
 * The same code runs from `src/workers/file-extraction/extractors/` in a
 * checkout and from the bundled `dist/index.js` in an installed package, so
 * the package root is the nearest ancestor that holds the script rather than a
 * fixed number of levels up.
 */
export function resolveAppleVisionOcrScript(
  moduleUrl: string = import.meta.url,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  let directory = dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, APPLE_VISION_OCR_SCRIPT);
    if (exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * Whether the lane should try Vision first on this host.
 */
export function appleVisionOcrSelected(
  preference: OcrEnginePreference,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return preference === 'auto' && platform === 'darwin';
}

/**
 * Parse the engine preference from configuration. Unknown values are an
 * error, not a silent default, so a typo cannot quietly change engines.
 */
export function parseOcrEnginePreference(value: string | undefined): OcrEnginePreference | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if ((OCR_ENGINE_PREFERENCES as readonly string[]).includes(normalized)) {
    return normalized as OcrEnginePreference;
  }
  throw new Error(`OCR engine must be one of ${OCR_ENGINE_PREFERENCES.join(', ')}; got ${value}.`);
}

/**
 * Read a scanned PDF page range by page range.
 */
export async function appleVisionPdfOcr(
  input: AppleVisionOcrInput,
  options: AppleVisionOcrOptions,
): Promise<ExtractorOutput> {
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_APPLE_VISION_MAX_PAGES));
  const pagesPerRun = Math.max(1, Math.floor(options.pagesPerRun ?? DEFAULT_APPLE_VISION_PAGES_PER_RUN));
  const maxPixelEdge = options.pdfMaxPixelEdge ?? DEFAULT_APPLE_VISION_PDF_MAX_PIXEL_EDGE;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.fileDeadlineMs ?? DEFAULT_APPLE_VISION_FILE_DEADLINE_MS);
  const pages: ScriptPage[] = [];
  let totalPages: number | undefined;
  let chars = 0;
  let stopReason: 'pages' | 'text' | 'time' | undefined;
  let firstPage = 1;
  for (;;) {
    const lastPage = Math.min(firstPage + pagesPerRun - 1, maxPages, totalPages ?? maxPages);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      stopReason = 'time';
      break;
    }
    const result = await runScript({
      args: ['pdf', input.inputPath, String(firstPage), String(lastPage), String(maxPixelEdge)],
      timeoutMs: Math.min(options.timeoutMs, remainingMs),
      options,
      deterministic: 'pdf',
    }).catch((error: unknown) => {
      // A deadline-shortened run that times out after pages were read keeps
      // what was read; a full-length timeout is the lane's ordinary failure.
      if (error instanceof ExtractionCommandTimeoutError && pages.length > 0 && remainingMs < options.timeoutMs) {
        return undefined;
      }
      throw error;
    });
    if (!result) {
      stopReason = 'time';
      break;
    }
    if ('settled' in result) return result.settled;
    totalPages = result.totalPages;
    for (const page of result.pages) {
      pages.push(page);
      chars += page.text.length;
    }
    if (lastPage >= totalPages) break;
    if (lastPage >= maxPages) {
      stopReason = 'pages';
      break;
    }
    if (chars >= options.maxBoundedTextChars) {
      stopReason = 'text';
      break;
    }
    firstPage = lastPage + 1;
  }

  const read = pages.filter((page) => normalizeExtractedText(page.text).length > 0);
  if (read.length === 0) {
    return mediaDescriptorOutput({
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      maxBoundedTextChars: options.maxBoundedTextChars,
      kind: 'media',
      label: 'scanned or image-only pdf',
      warnings: ['ocr_empty', 'pdf_image_only', APPLE_VISION_ENGINE_WARNING],
    });
  }
  const joined = read
    .map((page) => `--- Page ${page.page} ---\n${normalizeExtractedText(page.text)}`)
    .join('\n\n');
  const bounded = boundText(joined, options.maxBoundedTextChars);
  let warnings: string[] = ['ocr_text', APPLE_VISION_ENGINE_WARNING, 'ocr_source_rasterized_pdf'];
  if (stopReason === 'pages') warnings = appendWarning(warnings, 'ocr_pdf_pages_capped');
  if (stopReason === 'time') warnings = appendWarning(warnings, 'ocr_pdf_time_capped');
  if (pages.some((page) => page.unreadable)) warnings = appendWarning(warnings, 'ocr_pdf_page_unreadable');
  const derivation = buildDerivation({
    artifact: 'image_ocr',
    structural: { kind: 'whole_file', label: 'pdf ocr text' },
    bounded,
    confidence: weightedConfidence(read),
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
        ...(totalPages !== undefined ? { totalPages } : {}),
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

/**
 * Read one image.
 */
export async function appleVisionImageOcr(
  input: AppleVisionOcrInput,
  options: AppleVisionOcrOptions,
): Promise<ExtractorOutput> {
  const maxPixelEdge = options.imageMaxPixelEdge ?? DEFAULT_APPLE_VISION_IMAGE_MAX_PIXEL_EDGE;
  const result = await runScript({
    args: ['image', input.inputPath, String(maxPixelEdge)],
    timeoutMs: options.timeoutMs,
    options,
    deterministic: 'image',
  });
  if ('settled' in result) return result.settled;
  const page = result.pages[0];
  const bounded = boundText(normalizeExtractedText(page?.text ?? ''), options.maxBoundedTextChars);
  if (!page || !bounded.text) {
    return mediaDescriptorOutput({
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      maxBoundedTextChars: options.maxBoundedTextChars,
      kind: 'image',
      label: 'image file',
      warnings: ['ocr_empty', 'image_only', APPLE_VISION_ENGINE_WARNING],
    });
  }
  return {
    status: 'indexed',
    text: bounded.text,
    derivations: [buildDerivation({
      artifact: 'image_ocr',
      structural: { kind: 'image', label: 'image ocr text' },
      bounded,
      confidence: weightedConfidence([page]),
      warnings: ['ocr_text', APPLE_VISION_ENGINE_WARNING],
    })],
    ...(bounded.warnings.length > 0 ? { warnings: [...bounded.warnings] } : {}),
  };
}

/**
 * Run the script once and classify the outcome.
 *
 * Deterministic refusals settle the job here (`settled`). The kinds for a PDF
 * deliberately reuse the lane's historical `ocrmypdf_pdf_*` names: the
 * terminal-reclassification rules that hand a refused PDF to the vision lane,
 * the readiness ledger and stored jobs all key on them, and they name the
 * lane's rejection class whichever engine produced it.
 */
async function runScript(input: {
  args: string[];
  timeoutMs: number;
  options: AppleVisionOcrOptions;
  deterministic: 'pdf' | 'image';
}): Promise<ScriptResult | { settled: ExtractorOutput }> {
  const scriptPath = input.options.scriptPath;
  if (!scriptPath) throw new AppleVisionOcrUnavailableError('the packaged script was not found');
  let stdout: string;
  try {
    ({ stdout } = await input.options.commandRunner({
      command: input.options.osascriptPath ?? APPLE_VISION_OSASCRIPT,
      args: ['-l', 'JavaScript', scriptPath, ...input.args],
      timeoutMs: input.timeoutMs,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new AppleVisionOcrUnavailableError('osascript is not present');
    }
    if (error instanceof ExtractionCommandError) {
      if (error.exitCode === APPLE_VISION_EXIT_ENGINE_UNAVAILABLE) {
        throw new AppleVisionOcrUnavailableError('Vision text recognition is not available on this macOS');
      }
      if (error.exitCode === APPLE_VISION_EXIT_PDF_LOCKED && input.deterministic === 'pdf') {
        return { settled: { status: 'failed_terminal', errorKind: 'ocrmypdf_pdf_encrypted' } };
      }
      if (error.exitCode === APPLE_VISION_EXIT_INPUT_UNREADABLE) {
        return {
          settled: {
            status: 'failed_terminal',
            errorKind: input.deterministic === 'pdf' ? 'ocrmypdf_pdf_invalid' : 'ocr_image_unreadable',
          },
        };
      }
    }
    throw error;
  }
  return parseScriptResult(stdout);
}

/**
 * Validate the script's JSON. A malformed answer is a transient failure, never
 * an empty document: indexing nothing would hide a broken engine.
 */
export function parseScriptResult(stdout: string): ScriptResult {
  const parsed = JSON.parse(stdout) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('OCR script answered no object.');
  const record = parsed as { totalPages?: unknown; pages?: unknown };
  const totalPages = Number(record.totalPages);
  if (!Number.isInteger(totalPages) || totalPages < 1 || !Array.isArray(record.pages)) {
    throw new Error('OCR script answered an unexpected shape.');
  }
  const pages: ScriptPage[] = record.pages.map((entry: unknown) => {
    const page = entry as { page?: unknown; text?: unknown; confidence?: unknown; unreadable?: unknown };
    const pageNumber = Number(page.page);
    if (!Number.isInteger(pageNumber) || typeof page.text !== 'string') {
      throw new Error('OCR script answered an unexpected page.');
    }
    const confidence = Number(page.confidence);
    return {
      page: pageNumber,
      text: page.text,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
      ...(page.unreadable === true ? { unreadable: true } : {}),
    };
  });
  return { totalPages, pages };
}

function weightedConfidence(pages: readonly ScriptPage[]): number {
  let weighted = 0;
  let weight = 0;
  for (const page of pages) {
    weighted += page.confidence * page.text.length;
    weight += page.text.length;
  }
  return weight > 0 ? Math.round((weighted / weight) * 1000) / 1000 : 0;
}
