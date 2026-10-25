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
 * The text lane (`createPdfOcr`, `createImageOcr`) does not presume the
 * commands work: it probes them (`ocr-capability.ts`) and reads a scanned PDF
 * with `ocrmypdf` when its real command passes, else with `pdftoppm` pages read
 * by `tesseract` (`pdf-raster-ocr.ts`), and a picture with `tesseract`. The
 * explicit OCR lane below keeps running the commands directly, as requested.
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

import type { Extractor, ExtractorInput, ExtractorOutput, ExtractorRereadPolicy } from '../types.ts';
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
  OCR_UNAVAILABLE_IMAGE_WARNING,
  OCR_FAILED_IMAGE_WARNING,
  OCR_UNAVAILABLE_PDF_WARNING,
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
import {
  OCRMYPDF_COMMAND,
  TESSERACT_COMMAND,
  TESSERACT_ENV,
  createOcrCapabilityProbe,
  ocrmypdfArguments,
  sharedOcrCapabilityProbe,
  tesseractArguments,
  type OcrCapabilityProbe,
} from './ocr-capability.ts';
import { rasterPdfOcr } from './pdf-raster-ocr.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCUMENT_READER_MAX_INPUT_BYTES } from './input-limits.ts';

export const OCR_EXTRACTOR_KIND = 'local_ocr_tesseract';
export const OCR_EXTRACTOR_VERSION = 'ocr-v1';
export const DEFAULT_OCR_TIMEOUT_MS = 120_000;
export const OCR_PDF_COMMAND = OCRMYPDF_COMMAND;
export const OCR_IMAGE_COMMAND = TESSERACT_COMMAND;

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
  /**
   * The probe that decides which command engine reads (see
   * `ocr-capability.ts`). Defaults to a process-wide probe over the real
   * commands, or, when a command runner is injected, one over that runner.
   * Registry wiring passes one probe to every lane so they agree.
   */
  capability?: OcrCapabilityProbe;
}

/**
 * The engine choice for one lane instance. Vision is tried first when
 * selected; the first time it proves unavailable on this host the instance
 * remembers that and every later file goes straight to tesseract.
 */
interface OcrEngine {
  vision: AppleVisionOcrOptions | undefined;
  markVisionUnavailable(): void;
  /**
   * The owner set the engine to `tesseract`: run the installed commands
   * directly, exactly as before the probe existed (no probe, no fallback
   * engine, and a picture stays names-only in the text lane).
   */
  pinned: boolean;
  capability: OcrCapabilityProbe;
  limits: RasterLimits;
}

interface RasterLimits {
  maxPages?: number;
  pagesPerRun?: number;
  fileDeadlineMs?: number;
  now?: () => number;
}

function createOcrEngine(input: {
  options: OcrEngineOptions | undefined;
  commandRunner: ExtractionCommandRunner;
  commandRunnerInjected: boolean;
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
    pinned: options.preference === 'tesseract',
    capability: options.capability
      ?? (input.commandRunnerInjected
        ? createOcrCapabilityProbe({ commandRunner: input.commandRunner })
        : sharedOcrCapabilityProbe()),
    limits: {
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      ...(options.pagesPerRun !== undefined ? { pagesPerRun: options.pagesPerRun } : {}),
      ...(options.fileDeadlineMs !== undefined ? { fileDeadlineMs: options.fileDeadlineMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    },
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

/**
 * When the text lane's unread scans and pictures are read again. An item the
 * text lane settled because no OCR engine ran carries `ocr_required` and a
 * marker for its kind (`ocr_unavailable_pdf` / `ocr_unavailable_image`): it was
 * never read, so it is requeued whenever ITS reader works, without spending the
 * once-ever requeue (only items settled before the markers existed spend it).
 *
 * Readiness is per kind. A picture needs the image engine (tesseract passing
 * its probe), a scanned PDF the PDF engine (`ocrmypdf`, or `pdftoppm` plus
 * tesseract), so installing tesseract alone reads pictures while PDFs wait;
 * `readyWarnings()` tells the runner which markers have a ready reader.
 *
 * The runner asks `prepare()` only when such items exist. It is synchronous
 * and answers from a FRESH probe only (an expired answer starts a probe and
 * answers `pending`). Vision is deliberately not consulted: a Mac that reads
 * with Vision settles nothing unread, and one whose Vision is broken is not
 * made ready by a file existing. Pinned to `tesseract`, the worker runs
 * `ocrmypdf` directly and reads no pictures in the text lane.
 */
export function createOcrRereadPolicy(options: {
  capability: OcrCapabilityProbe;
  preference?: OcrEnginePreference;
}): ExtractorRereadPolicy {
  const pinned = options.preference === 'tesseract';
  const readyKinds = (): { pdf: boolean; image: boolean } | undefined => {
    const seen = options.capability.peekFresh();
    if (!seen) return undefined;
    return pinned
      ? { pdf: seen.ocrmypdf === 'ok', image: false }
      : { pdf: seen.pdfEngine !== undefined, image: seen.imageEngine !== undefined };
  };
  return {
    unreadWarnings: ['ocr_required', OCR_UNAVAILABLE_PDF_WARNING, OCR_UNAVAILABLE_IMAGE_WARNING, OCR_FAILED_IMAGE_WARNING],
    unreadTerminalErrorKinds: [],
    notReadyWarnings: [OCR_UNAVAILABLE_PDF_WARNING, OCR_UNAVAILABLE_IMAGE_WARNING],
    prepare() {
      const ready = readyKinds();
      if (!ready) {
        options.capability.warm();
        return 'pending';
      }
      return ready.pdf || ready.image ? 'ready' : 'unavailable';
    },
    readyWarnings() {
      const ready = readyKinds();
      return [
        // Legacy scans carry only `ocr_required`; they are PDFs.
        ...(ready?.pdf ? ['ocr_required', OCR_UNAVAILABLE_PDF_WARNING] : []),
        ...(ready?.image ? [OCR_UNAVAILABLE_IMAGE_WARNING, OCR_FAILED_IMAGE_WARNING] : []),
      ];
    },
  };
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
    commandRunnerInjected: options.commandRunner !== undefined,
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
    input: { kind: 'bytes', maxInputBytes: DOCUMENT_READER_MAX_INPUT_BYTES },
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
  const engine = createOcrEngine({
    options: options.engine,
    commandRunner,
    commandRunnerInjected: options.commandRunner !== undefined,
    timeoutMs,
    maxBoundedTextChars,
  });
  return async ({ bytes, mimeType, sizeBytes }) => {
    const laneInput = commandLaneInput({
      bytes, mimeType, sizeBytes, maxBoundedTextChars, commandRunner, timeoutMs, capability: engine.capability,
    });
    try {
      return await runOcrLane(async () => await withVision(engine, (vision) => visionPdf(laneInput, vision))
        ?? await commandPdfOcr(engine, laneInput));
    } catch (error) {
      if (error instanceof OcrUnavailableError) return undefined;
      throw error;
    }
  };
}

/**
 * OCR for the text lane's images.
 *
 * On a Mac the text lane reads an image's text with Vision, which costs
 * nothing to install. Everywhere else, and on a Mac where Vision proves
 * unavailable, it reads with `tesseract` once the capability probe has seen
 * tesseract read a fixture (`ocr-capability.ts`): checking the binary exists
 * is not enough. Without a working tesseract it answers undefined and images
 * stay names-only in the text lane, marked as waiting for OCR (the text
 * extractor adds the marker), and are read again by the reread policy once
 * tesseract works. With the engine pinned to `tesseract` it answers
 * undefined as it always did, and the registry does not offer it to the text
 * lane at all, so those pictures are not marked.
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
  const engine = createOcrEngine({
    options: options.engine,
    commandRunner,
    commandRunnerInjected: options.commandRunner !== undefined,
    timeoutMs,
    maxBoundedTextChars,
  });
  return async ({ bytes, mimeType, sizeBytes, preparedImage }) => {
    if (!engine.vision && engine.pinned) return undefined;
    const laneInput = commandLaneInput({
      bytes, mimeType, sizeBytes, maxBoundedTextChars, commandRunner, timeoutMs, capability: engine.capability,
    });
    try {
      return await runOcrLane(async () => {
        // Vision's native decoder reads HEIC and keeps the original resolution.
        const vision = await withVision(engine, (reader) => visionImage(laneInput, reader));
        if (vision) return vision;
        // Command engines cannot read every original format (notably HEIC).
        // Use the already decoded JPEG, including when Vision fell back.
        const decoded = preparedImage ? await readFile(preparedImage.path) : undefined;
        return commandImageOcr(engine, decoded
          ? { ...laneInput, bytes: decoded, mimeType: 'image/jpeg', sizeBytes: decoded.byteLength }
          : laneInput);
      });
    } catch (error) {
      if (error instanceof OcrUnavailableError) return undefined;
      throw error;
    }
  };
}

/**
 * The lane input for the text lane's command engines: a command that is not
 * installed at all is "no OCR here" (undefined), not a failed job.
 */
function commandLaneInput(input: {
  bytes: Uint8Array;
  mimeType: string;
  sizeBytes: number;
  maxBoundedTextChars: number;
  commandRunner: ExtractionCommandRunner;
  timeoutMs: number;
  /**
   * The probe that vouched for the commands: a command that turns out to be
   * missing means its answer is wrong, so it is forgotten.
   */
  capability: OcrCapabilityProbe;
}): OcrLaneInput {
  const { capability, ...laneInput } = input;
  return {
    ...laneInput,
    commandRunner: async (request) => {
      try {
        return await input.commandRunner(request);
      } catch (error) {
        if (isCommandMissing(error)) {
          capability.invalidate();
          throw new OcrUnavailableError();
        }
        throw error;
      }
    },
  };
}

/**
 * Read a scanned PDF with the command engine the probe selected. Throws
 * `OcrUnavailableError` when none works, which the caller turns into
 * "not read" so the PDF stays visibly `ocr_required` and is read again later.
 */
async function commandPdfOcr(engine: OcrEngine, input: OcrLaneInput): Promise<ExtractorOutput> {
  if (engine.pinned) return extractPdfOcr(input);
  const { pdfEngine } = await engine.capability.snapshot();
  if (pdfEngine === 'ocrmypdf') return extractPdfOcr(input);
  if (pdfEngine === 'pdftoppm_tesseract') {
    return withTempInput(input.bytes, '.pdf', (inputPath) => rasterPdfOcr({
      inputPath,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    }, {
      commandRunner: input.commandRunner,
      timeoutMs: input.timeoutMs,
      maxBoundedTextChars: input.maxBoundedTextChars,
      ...engine.limits,
    }));
  }
  throw new OcrUnavailableError();
}

async function commandImageOcr(engine: OcrEngine, input: OcrLaneInput): Promise<ExtractorOutput> {
  if (engine.pinned) throw new OcrUnavailableError();
  const { imageEngine } = await engine.capability.snapshot();
  if (imageEngine !== 'tesseract') throw new OcrUnavailableError();
  return extractImageOcr({ ...input, env: TESSERACT_ENV });
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
  /**
   * Extra environment for the OCR command; the explicit lane sets none.
   */
  env?: Readonly<Record<string, string>>;
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
        args: ocrmypdfArguments({ inputPath, outputPath, sidecarPath }),
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
      args: tesseractArguments(inputPath),
      timeoutMs: input.timeoutMs,
      ...(input.env ? { env: input.env } : {}),
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
