/**
 * What this machine can read: a real probe of the OCR commands.
 *
 * The text lane used to attempt `ocrmypdf` on every scan and treat a missing
 * command as "no OCR here". That left two gaps on Linux. A host with
 * `tesseract` and `pdftoppm` but no `ocrmypdf` (Arch and Omarchy do not ship
 * it in their repositories) read nothing, and a host whose `ocrmypdf` was
 * installed without its `--clean` dependency (`unpaper`) failed every scan the
 * hard way. Here each command is run once on a tiny generated fixture, and the
 * answer decides which engine reads a PDF:
 *
 *   1. `ocrmypdf`, when its real command (the exact arguments the lane uses,
 *      `--clean` included) reads the fixture;
 *   2. otherwise `pdftoppm` pages read by `tesseract`, when both pass;
 *   3. otherwise nothing, and the file stays visibly `ocr_required`.
 *
 * A picture is read by `tesseract` when the same probe passes. Nothing here
 * looks at the operating system: the question is only whether the tools work.
 *
 * The probe result is cached. A working engine is trusted for ten minutes, a
 * missing one is looked at again after a minute, so an install is noticed
 * without spawning a process per file. The cache is read synchronously by the
 * reread policy, which must not wait.
 *
 * Doc comments here are always multi-line blocks, and this module contains no
 * regular expressions.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runExtractionCommand,
  type ExtractionCommandRunner,
} from './command-runner.ts';
import {
  OCR_PROBE_IMAGE_HEIGHT,
  OCR_PROBE_IMAGE_WIDTH,
  OCR_PROBE_WORD,
  ocrProbeJpeg,
} from './ocr-probe-fixture.ts';

export const OCRMYPDF_COMMAND = 'ocrmypdf';
export const TESSERACT_COMMAND = 'tesseract';
export const PDFTOPPM_COMMAND = 'pdftoppm';
export const PDFINFO_COMMAND = 'pdfinfo';

/**
 * Tesseract spreads one page over every core through OpenMP; the extraction
 * runner already reads several files at a time, and on a four-thread laptop
 * the oversubscription is slower than one thread per process.
 */
export const TESSERACT_ENV: Readonly<Record<string, string>> = { OMP_THREAD_LIMIT: '1' };

export const OCR_READY_TTL_MS = 10 * 60_000;
export const OCR_MISSING_TTL_MS = 60_000;

const PROBE_TESSERACT_TIMEOUT_MS = 30_000;
const PROBE_PDFTOPPM_TIMEOUT_MS = 30_000;
const PROBE_OCRMYPDF_TIMEOUT_MS = 90_000;
const PROBE_TEMP_PREFIX = 'olympus-ocr-probe-';
const PROBE_RENDER_DPI = 150;

export type OcrProbeStatus = 'ok' | 'missing' | 'failed' | 'skipped';
export type OcrPdfCommandEngine = 'ocrmypdf' | 'pdftoppm_tesseract';
export type OcrImageCommandEngine = 'tesseract';

export interface OcrCapabilitySnapshot {
  tesseract: OcrProbeStatus;
  pdftoppm: OcrProbeStatus;
  ocrmypdf: OcrProbeStatus;
  /**
   * The command engine that reads a scanned PDF, best first.
   */
  pdfEngine: OcrPdfCommandEngine | undefined;
  imageEngine: OcrImageCommandEngine | undefined;
  checkedAt: number;
}

/**
 * The exact `ocrmypdf` arguments the lane runs, shared so the probe proves
 * the command the lane will actually use.
 */
export function ocrmypdfArguments(input: {
  inputPath: string;
  outputPath: string;
  sidecarPath: string;
}): string[] {
  return [
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
    input.sidecarPath,
    input.inputPath,
    input.outputPath,
  ];
}

/**
 * The `tesseract` arguments for one picture or page: text on stdout.
 */
export function tesseractArguments(inputPath: string): string[] {
  return [inputPath, 'stdout', '-l', 'eng', '--psm', '3'];
}

function probeWordRead(text: string): boolean {
  let letters = '';
  for (const char of text.toUpperCase()) {
    if ((char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9')) letters += char;
  }
  return letters.includes(OCR_PROBE_WORD);
}

function commandMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * A one-page PDF holding only the fixture picture: no text layer, so every OCR
 * engine has to read pixels. Built in memory with correct cross-reference
 * offsets; the page is sized so the picture is 150 dpi.
 */
export function buildOcrProbePdf(): Uint8Array {
  const jpeg = ocrProbeJpeg();
  const pageWidth = (OCR_PROBE_IMAGE_WIDTH * 72) / PROBE_RENDER_DPI;
  const pageHeight = (OCR_PROBE_IMAGE_HEIGHT * 72) / PROBE_RENDER_DPI;
  const content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Buffer | string): void => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    chunks.push(buffer);
    length += buffer.length;
  };
  push('%PDF-1.4\n');
  const object = (number: number, body: Buffer | string, stream?: Buffer): void => {
    offsets[number] = length;
    push(`${number} 0 obj\n`);
    push(body);
    if (stream) {
      push('\nstream\n');
      push(stream);
      push('\nendstream');
    }
    push('\nendobj\n');
  };
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] `
      + '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
  );
  object(
    4,
    `<< /Type /XObject /Subtype /Image /Width ${OCR_PROBE_IMAGE_WIDTH} /Height ${OCR_PROBE_IMAGE_HEIGHT} `
      + `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    Buffer.from(jpeg),
  );
  object(5, `<< /Length ${content.length} >>`, Buffer.from(content, 'latin1'));
  const xrefOffset = length;
  push(`xref\n0 6\n0000000000 65535 f \n`);
  for (let number = 1; number <= 5; number += 1) {
    push(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

async function probeTesseract(input: {
  runner: ExtractionCommandRunner;
  imagePath: string;
}): Promise<OcrProbeStatus> {
  try {
    const result = await input.runner({
      command: TESSERACT_COMMAND,
      args: tesseractArguments(input.imagePath),
      timeoutMs: PROBE_TESSERACT_TIMEOUT_MS,
      env: TESSERACT_ENV,
    });
    return probeWordRead(result.stdout) ? 'ok' : 'failed';
  } catch (error) {
    return commandMissing(error) ? 'missing' : 'failed';
  }
}

async function probePdftoppm(input: {
  runner: ExtractionCommandRunner;
  directory: string;
  pdfPath: string;
  tesseract: OcrProbeStatus;
}): Promise<OcrProbeStatus> {
  const prefix = join(input.directory, 'render');
  try {
    await input.runner({
      command: PDFTOPPM_COMMAND,
      args: ['-f', '1', '-l', '1', '-r', String(PROBE_RENDER_DPI), '-png', input.pdfPath, prefix],
      timeoutMs: PROBE_PDFTOPPM_TIMEOUT_MS,
    });
  } catch (error) {
    return commandMissing(error) ? 'missing' : 'failed';
  }
  const rendered = (await readdir(input.directory)).filter((name) => name.startsWith('render') && name.endsWith('.png'));
  const first = rendered[0];
  if (!first) return 'failed';
  // The engine is the pair: a page the renderer produced must be one the
  // reader can read, or the pair is not an engine.
  if (input.tesseract === 'ok') {
    const read = await probeTesseract({ runner: input.runner, imagePath: join(input.directory, first) });
    if (read !== 'ok') return 'failed';
  }
  return 'ok';
}

async function probeOcrmypdf(input: {
  runner: ExtractionCommandRunner;
  directory: string;
  pdfPath: string;
}): Promise<OcrProbeStatus> {
  const sidecarPath = join(input.directory, 'probe-sidecar.txt');
  try {
    await input.runner({
      command: OCRMYPDF_COMMAND,
      args: ocrmypdfArguments({
        inputPath: input.pdfPath,
        outputPath: join(input.directory, 'probe-output.pdf'),
        sidecarPath,
      }),
      timeoutMs: PROBE_OCRMYPDF_TIMEOUT_MS,
    });
  } catch (error) {
    return commandMissing(error) ? 'missing' : 'failed';
  }
  try {
    return probeWordRead(await readFile(sidecarPath, 'utf8')) ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

export interface ProbeOcrCapabilityOptions {
  commandRunner?: ExtractionCommandRunner;
  now?: () => number;
}

/**
 * Run every probe once. Never throws: a probe that fails for any reason is a
 * tool that does not work here.
 */
export async function probeOcrCapability(options: ProbeOcrCapabilityOptions = {}): Promise<OcrCapabilitySnapshot> {
  const runner = options.commandRunner ?? runExtractionCommand;
  const now = options.now ?? Date.now;
  let tesseract: OcrProbeStatus = 'failed';
  let pdftoppm: OcrProbeStatus = 'failed';
  let ocrmypdf: OcrProbeStatus = 'failed';
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), PROBE_TEMP_PREFIX));
    const imagePath = join(directory, 'probe.jpg');
    const pdfPath = join(directory, 'probe.pdf');
    await writeFile(imagePath, ocrProbeJpeg());
    await writeFile(pdfPath, buildOcrProbePdf());
    tesseract = await probeTesseract({ runner, imagePath });
    pdftoppm = await probePdftoppm({ runner, directory, pdfPath, tesseract });
    // ocrmypdf drives tesseract; with no working tesseract it cannot read.
    ocrmypdf = tesseract === 'ok' ? await probeOcrmypdf({ runner, directory, pdfPath }) : 'skipped';
  } catch {
    // Left as whatever was decided before the failure.
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  return {
    tesseract,
    pdftoppm,
    ocrmypdf,
    pdfEngine: ocrmypdf === 'ok'
      ? 'ocrmypdf'
      : tesseract === 'ok' && pdftoppm === 'ok' ? 'pdftoppm_tesseract' : undefined,
    imageEngine: tesseract === 'ok' ? 'tesseract' : undefined,
    checkedAt: now(),
  };
}

export interface OcrCapabilityProbe {
  /**
   * The cached answer when it is fresh, else a new probe. Concurrent callers
   * share one probe.
   */
  snapshot(): Promise<OcrCapabilitySnapshot>;
  /**
   * The cached answer, however old, or undefined before the first probe.
   */
  peek(): OcrCapabilitySnapshot | undefined;
  /**
   * The cached answer only while it is fresh (inside its time to live), else
   * undefined. A decision that spends a one-time recovery must use this, not
   * `peek()`: an expired "ready" says nothing about the machine now.
   */
  peekFresh(): OcrCapabilitySnapshot | undefined;
  /**
   * Forget the cached answer, because a command it vouched for proved to be
   * missing when it was run. The next caller probes again.
   */
  invalidate(): void;
  /**
   * Start a probe in the background when there is no fresh answer.
   */
  warm(): void;
}

export interface OcrCapabilityProbeOptions {
  commandRunner?: ExtractionCommandRunner;
  now?: () => number;
  readyTtlMs?: number;
  missingTtlMs?: number;
  /**
   * Replaces the probe itself, for tests.
   */
  probe?: () => Promise<OcrCapabilitySnapshot>;
}

export function createOcrCapabilityProbe(options: OcrCapabilityProbeOptions = {}): OcrCapabilityProbe {
  const now = options.now ?? Date.now;
  const readyTtlMs = options.readyTtlMs ?? OCR_READY_TTL_MS;
  const missingTtlMs = options.missingTtlMs ?? OCR_MISSING_TTL_MS;
  const run = options.probe ?? (() => probeOcrCapability({
    ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
    now,
  }));
  let cached: OcrCapabilitySnapshot | undefined;
  let inFlight: Promise<OcrCapabilitySnapshot> | undefined;
  // Bumped by `invalidate()`: a probe that started before it must not put a
  // possibly stale answer back.
  let generation = 0;

  const fresh = (): boolean => {
    if (!cached) return false;
    // A host that reads pictures but not yet scanned PDFs is still waiting for
    // an install, so it is looked at again as quickly as one with nothing.
    const ttl = cached.pdfEngine ? readyTtlMs : missingTtlMs;
    return now() - cached.checkedAt < ttl;
  };
  const refresh = (): Promise<OcrCapabilitySnapshot> => {
    if (inFlight) return inFlight;
    const startedIn = generation;
    const probing: Promise<OcrCapabilitySnapshot> = run()
      .catch((): OcrCapabilitySnapshot => ({
        tesseract: 'failed',
        pdftoppm: 'failed',
        ocrmypdf: 'failed',
        pdfEngine: undefined,
        imageEngine: undefined,
        checkedAt: now(),
      }))
      .then((snapshot) => {
        if (startedIn === generation) cached = snapshot;
        if (inFlight === probing) inFlight = undefined;
        return snapshot;
      });
    inFlight = probing;
    return probing;
  };
  return {
    async snapshot() {
      if (cached && fresh()) return cached;
      return refresh();
    },
    peek: () => cached,
    peekFresh: () => (cached && fresh() ? cached : undefined),
    invalidate() {
      generation += 1;
      cached = undefined;
      inFlight = undefined;
    },
    warm() {
      if (!fresh()) void refresh();
    },
  };
}

let sharedProbe: OcrCapabilityProbe | undefined;

/**
 * The process-wide probe over the real commands, created on first use. The
 * extraction runtime builds a registry per run; sharing the probe keeps the
 * cache across them.
 */
export function sharedOcrCapabilityProbe(): OcrCapabilityProbe {
  sharedProbe ??= createOcrCapabilityProbe();
  return sharedProbe;
}
