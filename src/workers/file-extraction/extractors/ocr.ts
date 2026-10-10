/**
 * B4 — the local OCR lane.
 *
 * Port of the production OCR extractor: rasterize-and-OCR for PDFs, direct OCR
 * for images, and delegation to the text lane for everything else.
 *
 * Two engines sit behind the one lane. On macOS the default is the built-in
 * one (`apple-vision-ocr.ts`): PDFKit and Vision through the system's own
 * `osascript`, so a fresh Mac reads scans with nothing installed. Everywhere
 * else, when the owner sets the engine to `tesseract`, or when Vision cannot
 * run on a Mac, the lane uses the `ocrmypdf` / `tesseract` commands as before.
 * The kind keeps its historical `local_ocr_tesseract` name because stored jobs,
 * reclassification rules and operator tooling key on it; which engine read a
 * file is recorded on the derivation as the `ocr_engine_apple_vision` warning.
 *
 * The delegation used to be a substring dispatch on the requested kind string.
 * Under an explicit registry it is composition: this extractor constructs a
 * text extractor once and hands the item over. That is why `accepts()` stays as
 * broad as the text lane's while `extract()` keeps the narrow three-way split.
 *
 * The deterministic-rejection classifier is the part of this file that came
 * from real failures rather than from design. A PDF that is encrypted, signed,
 * or structurally damaged will be rejected by the OCR command on every attempt,
 * so it must not consume the retry budget; anything else is transient and must.
 *
 * Doc comments here are always multi-line blocks, and the one regex-bearing
 * function is enrolled in the architecture guard's allowlist.
 */

import type { Extractor, ExtractorInput, ExtractorOutput } from '../types.ts';
import {
  DEFAULT_MAX_BOUNDED_TEXT_CHARS,
  IMAGE_MIME_TYPES,
  PDF_MIME_TYPE,
  boundText,
  buildDerivation,
  mediaDescriptorOutput,
  normalizeExtractedText,
  normalizeMimeType,
} from './bounded-text.ts';
import {
  ExtractionCommandError,
  ExtractionCommandTimeoutError,
  runExtractionCommand,
  type ExtractionCommandRunner,
} from './command-runner.ts';
import {
  createTextExtractor,
  isCommandMissing,
  missingBytesFailure,
  textLaneAccepts,
  type ImageOcr,
  type PdfOcr,
} from './text.ts';
import {
  AppleVisionOcrUnavailableError,
  appleVisionImageOcr,
  appleVisionOcrSelected,
  appleVisionPdfOcr,
  resolveAppleVisionOcrScript,
  type AppleVisionOcrOptions,
  type OcrEnginePreference,
} from './apple-vision-ocr.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OCR_EXTRACTOR_KIND = 'local_ocr_tesseract';
export const OCR_EXTRACTOR_VERSION = 'ocr-v1';
export const DEFAULT_OCR_TIMEOUT_MS = 120_000;
export const OCR_PDF_COMMAND = 'ocrmypdf';
export const OCR_IMAGE_COMMAND = 'tesseract';

const TEMP_DIR_PREFIX = 'olympus-extraction-ocr-';

/**
 * The three deterministic PDF rejections, as data.
 *
 * A job settled with one of these is permanently unreadable BY THIS LANE, and
 * says nothing about whether another lane could read it. That distinction is
 * what a terminal-reclassification rule is built from, so the kinds are
 * exported rather than left as literals inside the classifier: a rule set that
 * spelled them out a second time would drift the first time one changed.
 */
export const OCR_DETERMINISTIC_PDF_REJECTION_KINDS = [
  'ocrmypdf_pdf_encrypted',
  'ocrmypdf_pdf_signed',
  'ocrmypdf_pdf_invalid',
] as const;

export type OcrDeterministicPdfRejectionKind =
  (typeof OCR_DETERMINISTIC_PDF_REJECTION_KINDS)[number];

export interface OcrExtractorOptions {
  kind?: string;
  version?: string;
  maxBoundedTextChars?: number;
  commandRunner?: ExtractionCommandRunner;
  ocrTimeoutMs?: number;
  engine?: OcrEngineOptions;
}

/**
 * Engine selection and the built-in engine's bounds. Every field is optional;
 * the defaults pick Vision on macOS and tesseract elsewhere.
 */
export interface OcrEngineOptions {
  preference?: OcrEnginePreference;
  /**
   * Overrides `process.platform`, for tests.
   */
  platform?: NodeJS.Platform;
  /**
   * Overrides the packaged script lookup; `null` means "not found".
   */
  appleVisionScriptPath?: string | null;
  /**
   * Runs the built-in engine's `osascript`; defaults to the lane's runner.
   */
  appleVisionCommandRunner?: ExtractionCommandRunner;
  maxPages?: number;
  pagesPerRun?: number;
  fileDeadlineMs?: number;
  /**
   * Clock for the whole-file deadline, for tests.
   */
  now?: () => number;
}

/**
 * The engine choice for one lane instance. Vision is tried first when
 * selected; the first time it proves unavailable on this host the instance
 * remembers that and every later file goes straight to tesseract.
 */
interface OcrEngine {
  vision: AppleVisionOcrOptions | undefined;
  markVisionUnavailable(): void;
}

function createOcrEngine(input: {
  options: OcrEngineOptions | undefined;
  commandRunner: ExtractionCommandRunner;
  timeoutMs: number;
  maxBoundedTextChars: number;
}): OcrEngine {
  const options = input.options ?? {};
  let vision: AppleVisionOcrOptions | undefined;
  if (appleVisionOcrSelected(options.preference ?? 'auto', options.platform ?? process.platform)) {
    vision = {
      commandRunner: options.appleVisionCommandRunner ?? input.commandRunner,
      scriptPath: options.appleVisionScriptPath === null
        ? undefined
        : options.appleVisionScriptPath ?? resolveAppleVisionOcrScript(),
      timeoutMs: input.timeoutMs,
      maxBoundedTextChars: input.maxBoundedTextChars,
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      ...(options.pagesPerRun !== undefined ? { pagesPerRun: options.pagesPerRun } : {}),
      ...(options.fileDeadlineMs !== undefined ? { fileDeadlineMs: options.fileDeadlineMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    };
  }
  return {
    get vision() {
      return vision;
    },
    markVisionUnavailable() {
      if (vision) {
        console.error('Built-in macOS scan reading is unavailable on this host; using the tesseract commands.');
      }
      vision = undefined;
    },
  };
}

/**
 * Read with Vision when it is the engine, else answer undefined so the caller
 * runs the tesseract path. Unavailability is remembered, never surfaced as a
 * job failure.
 */
async function withVision(
  engine: OcrEngine,
  read: (vision: AppleVisionOcrOptions) => Promise<ExtractorOutput>,
): Promise<ExtractorOutput | undefined> {
  const vision = engine.vision;
  if (!vision) return undefined;
  try {
    return await read(vision);
  } catch (error) {
    if (error instanceof AppleVisionOcrUnavailableError) {
      engine.markVisionUnavailable();
      return undefined;
    }
    throw error;
  }
}

export function createOcrExtractor(options: OcrExtractorOptions = {}): Extractor {
  const kind = options.kind ?? OCR_EXTRACTOR_KIND;
  const version = options.version ?? OCR_EXTRACTOR_VERSION;
  const maxBoundedTextChars = options.maxBoundedTextChars ?? DEFAULT_MAX_BOUNDED_TEXT_CHARS;
  const commandRunner = options.commandRunner ?? runExtractionCommand;
  const timeoutMs = options.ocrTimeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
  const engine = createOcrEngine({
    options: options.engine,
    commandRunner,
    timeoutMs,
    maxBoundedTextChars,
  });
  const textExtractor = createTextExtractor({
    kind,
    version,
    maxBoundedTextChars,
  });
  return {
    kind,
    version,
    needsBytes: true,
    egress: 'local',
    accepts(mimeType) {
      const normalized = normalizeMimeType(mimeType);
      if (!normalized) return false;
      return normalized === PDF_MIME_TYPE
        || IMAGE_MIME_TYPES.has(normalized)
        || textLaneAccepts(normalized);
    },
    async extract(input: ExtractorInput): Promise<ExtractorOutput> {
      const bytes = input.bytes;
      if (!bytes) return missingBytesFailure();
      const mimeType = normalizeMimeType(input.mimeType ?? input.ref.mimeType);
      const sizeBytes = input.sizeBytes ?? bytes.byteLength;
      const laneInput = { bytes, mimeType: mimeType ?? '', sizeBytes, maxBoundedTextChars, commandRunner, timeoutMs };
      if (mimeType === PDF_MIME_TYPE) {
        return runOcrLane(async () => await withVision(engine, (vision) => visionPdf(laneInput, vision))
          ?? extractPdfOcr(laneInput));
      }
      if (mimeType && IMAGE_MIME_TYPES.has(mimeType)) {
        return runOcrLane(async () => await withVision(engine, (vision) => visionImage(laneInput, vision))
          ?? extractImageOcr(laneInput));
      }
      return textExtractor.extract(input);
    },
  };
}

/**
 * OCR for the text lane's PDFs that have no text layer.
 *
 * The same command and settlement as this lane's own PDF path. Answers
 * undefined when the OCR command is not installed, so a host without it keeps
 * those PDFs visibly `ocr_required` rather than failing them.
 */
export function createPdfOcr(options: {
  maxBoundedTextChars?: number;
  commandRunner?: ExtractionCommandRunner;
  ocrTimeoutMs?: number;
  engine?: OcrEngineOptions;
} = {}): PdfOcr {
  const commandRunner = options.commandRunner ?? runExtractionCommand;
  const maxBoundedTextChars = options.maxBoundedTextChars ?? DEFAULT_MAX_BOUNDED_TEXT_CHARS;
  const timeoutMs = options.ocrTimeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
  const engine = createOcrEngine({ options: options.engine, commandRunner, timeoutMs, maxBoundedTextChars });
  return async ({ bytes, mimeType, sizeBytes }) => {
    const laneInput: OcrLaneInput = {
      bytes,
      mimeType,
      sizeBytes,
      maxBoundedTextChars,
      commandRunner: async (request) => {
        try {
          return await commandRunner(request);
        } catch (error) {
          if (isCommandMissing(error)) throw new OcrUnavailableError();
          throw error;
        }
      },
      timeoutMs,
    };
    try {
      return await runOcrLane(async () => await withVision(engine, (vision) => visionPdf(laneInput, vision))
        ?? extractPdfOcr(laneInput));
    } catch (error) {
      if (error instanceof OcrUnavailableError) return undefined;
      throw error;
    }
  };
}

/**
 * OCR for the text lane's images.
 *
 * Built-in engine only: on a Mac the text lane reads an image's text with
 * Vision, which costs nothing to install. Where only tesseract is available,
 * this answers undefined and images stay names-only in the text lane exactly
 * as before; the explicit OCR lane still reads them with tesseract on request.
 * Also answers undefined when Vision proves unavailable on this host.
 */
export function createImageOcr(options: {
  maxBoundedTextChars?: number;
  commandRunner?: ExtractionCommandRunner;
  ocrTimeoutMs?: number;
  engine?: OcrEngineOptions;
} = {}): ImageOcr {
  const commandRunner = options.commandRunner ?? runExtractionCommand;
  const maxBoundedTextChars = options.maxBoundedTextChars ?? DEFAULT_MAX_BOUNDED_TEXT_CHARS;
  const timeoutMs = options.ocrTimeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
  const engine = createOcrEngine({ options: options.engine, commandRunner, timeoutMs, maxBoundedTextChars });
  return async ({ bytes, mimeType, sizeBytes }) => {
    if (!engine.vision) return undefined;
    const laneInput: OcrLaneInput = { bytes, mimeType, sizeBytes, maxBoundedTextChars, commandRunner, timeoutMs };
    return runOcrLane(() => withVision(engine, (vision) => visionImage(laneInput, vision)));
  };
}

async function visionPdf(input: OcrLaneInput, vision: AppleVisionOcrOptions): Promise<ExtractorOutput> {
  return withTempInput(input.bytes, '.pdf', (inputPath) => appleVisionPdfOcr({
    inputPath,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
  }, vision));
}

async function visionImage(input: OcrLaneInput, vision: AppleVisionOcrOptions): Promise<ExtractorOutput> {
  return withTempInput(input.bytes, imageExtensionForMimeType(input.mimeType), (inputPath) => appleVisionImageOcr({
    inputPath,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
  }, vision));
}

async function withTempInput<T>(
  bytes: Uint8Array,
  extension: string,
  read: (inputPath: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    const inputPath = join(tempDir, `input${extension}`);
    await writeFile(inputPath, bytes);
    return await read(inputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

class OcrUnavailableError extends Error {}

/**
 * The production lane let a transient command failure propagate out of the
 * extractor and be caught one level up, where it settled as a retryable
 * failure. The landed seam expresses the same disposition in-place, so the
 * outcome is unchanged and the category is now explicit.
 */
async function runOcrLane<T extends ExtractorOutput | undefined>(run: () => Promise<T>): Promise<T | ExtractorOutput> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OcrUnavailableError) throw error;
    if (error instanceof ExtractionCommandTimeoutError) {
      return { status: 'failed_retryable', errorKind: 'ocr_command_timeout' };
    }
    return { status: 'failed_retryable', errorKind: 'ocr_command_failed' };
  }
}

interface OcrLaneInput {
  bytes: Uint8Array;
  mimeType: string;
  sizeBytes: number;
  maxBoundedTextChars: number;
  commandRunner: ExtractionCommandRunner;
  timeoutMs: number;
}

async function extractPdfOcr(input: OcrLaneInput): Promise<ExtractorOutput> {
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    const inputPath = join(tempDir, 'input.pdf');
    const outputPath = join(tempDir, 'output.pdf');
    const sidecarPath = join(tempDir, 'sidecar.txt');
    await writeFile(inputPath, input.bytes);
    try {
      await input.commandRunner({
        command: OCR_PDF_COMMAND,
        args: [
          '--force-ocr',
          '--rotate-pages',
          '--deskew',
          '--clean',
          '--jobs',
          '1',
          '--optimize',
          '0',
          '--output-type',
          'pdf',
          '--sidecar',
          sidecarPath,
          inputPath,
          outputPath,
        ],
        timeoutMs: input.timeoutMs,
      });
    } catch (error) {
      const rejectionKind = classifyOcrDeterministicPdfRejection(error);
      if (!rejectionKind) throw error;
      return { status: 'failed_terminal', errorKind: rejectionKind };
    }
    const bounded = boundText(
      normalizeExtractedText(await readFile(sidecarPath, 'utf8')),
      input.maxBoundedTextChars,
    );
    if (!bounded.text) {
      return mediaDescriptorOutput({
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        maxBoundedTextChars: input.maxBoundedTextChars,
        kind: 'media',
        label: 'scanned or image-only pdf',
        warnings: ['ocr_empty', 'pdf_image_only'],
      });
    }
    return {
      status: 'indexed',
      text: bounded.text,
      derivations: [buildDerivation({
        artifact: 'image_ocr',
        structural: { kind: 'whole_file', label: 'pdf ocr text' },
        bounded,
        confidence: 0.5,
        warnings: ['ocr_text', 'ocr_confidence_unavailable', 'ocr_source_rasterized_pdf'],
      })],
      ...(bounded.warnings.length > 0 ? { warnings: [...bounded.warnings] } : {}),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function extractImageOcr(input: OcrLaneInput): Promise<ExtractorOutput> {
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    const inputPath = join(tempDir, `input${imageExtensionForMimeType(input.mimeType)}`);
    await writeFile(inputPath, input.bytes);
    const result = await input.commandRunner({
      command: OCR_IMAGE_COMMAND,
      args: [
        inputPath,
        'stdout',
        '-l',
        'eng',
        '--psm',
        '3',
      ],
      timeoutMs: input.timeoutMs,
    });
    const bounded = boundText(normalizeExtractedText(result.stdout), input.maxBoundedTextChars);
    if (!bounded.text) {
      return mediaDescriptorOutput({
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        maxBoundedTextChars: input.maxBoundedTextChars,
        kind: 'image',
        label: 'image file',
        warnings: ['ocr_empty', 'image_only'],
      });
    }
    return {
      status: 'indexed',
      text: bounded.text,
      derivations: [buildDerivation({
        artifact: 'image_ocr',
        structural: { kind: 'image', label: 'image ocr text' },
        bounded,
        confidence: 0.5,
        warnings: ['ocr_text', 'ocr_confidence_unavailable'],
      })],
      ...(bounded.warnings.length > 0 ? { warnings: [...bounded.warnings] } : {}),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Terminal-versus-retryable for a rejected PDF, ported verbatim.
 *
 * Every branch here is a real failure the OCR command produced against the
 * production corpus. Exit code 8 is its encryption code; the message matches
 * cover the cases where the exit code alone is ambiguous. Anything unmatched
 * returns undefined and stays retryable, which is the safe direction.
 */
export function classifyOcrDeterministicPdfRejection(
  error: unknown,
): OcrDeterministicPdfRejectionKind | undefined {
  if (!(error instanceof Error)) return undefined;
  const commandError = error instanceof ExtractionCommandError ? error : undefined;
  if (commandError && commandError.command !== OCR_PDF_COMMAND) return undefined;
  const detail = [
    error.message,
    commandError?.stderr,
    commandError?.stdout,
  ].filter((value): value is string => Boolean(value)).join('\n').toLowerCase();
  if (commandError?.exitCode === 8 || /\b(encrypted|password[- ]?protected|owner password|user password)\b/.test(detail)) {
    return 'ocrmypdf_pdf_encrypted';
  }
  if (/\b(digitally signed|digital signature|digitalsignatureerror|signature field)\b/.test(detail)) {
    return 'ocrmypdf_pdf_signed';
  }
  if (
    /\b(inputfileerror|invalid pdf|malformed pdf|damaged pdf|not a pdf|no pages found|unable to find trailer dictionary)\b/.test(detail)
    || /\bqpdf\b.*\b(damaged|invalid|linearization|xref)\b/.test(detail)
  ) {
    return 'ocrmypdf_pdf_invalid';
  }
  return undefined;
}

export function imageExtensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/tiff') return '.tiff';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/bmp') return '.bmp';
  if (mimeType === 'image/heic') return '.heic';
  if (mimeType === 'image/heif') return '.heif';
  return '.img';
}
