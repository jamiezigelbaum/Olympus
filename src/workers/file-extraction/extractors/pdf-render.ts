/**
 * PDF rasterization through a local rendering command.
 *
 * Shared by the local vision lane (every page, at a DPI that fits the request
 * cap) and the approved-remote lane (the first page only). Kept out of the
 * format-decoder module because this shells out; the decoders never do.
 *
 * Ported from the production lane, including two behaviours that only exist
 * because real documents needed them:
 *
 *   - The page-count probe is best-effort. A rendering command that cannot
 *     report a page count still renders; the cap is simply applied blind.
 *   - The single-file fallback. Some rendering builds emit `page.jpg` rather
 *     than `page-1.jpg` for a one-page document, and the directory scan finds
 *     nothing; that case reads the single-file name directly rather than
 *     failing the job.
 *
 * Doc comments here are always multi-line blocks, and every regex lives in a
 * named function enrolled in the architecture guard's allowlist.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runExtractionCommand,
  type ExtractionCommandRunner,
} from './command-runner.ts';

export const DEFAULT_PDF_RENDER_TIMEOUT_MS = 120_000;
export const DEFAULT_PDF_RENDER_COMMAND = 'pdftoppm';
export const DEFAULT_PDF_INFO_COMMAND = 'pdfinfo';
export const DEFAULT_PDF_RENDER_DPI = 180;

/**
 * The descending DPI ladder the page-fit backoff walks when a rendered page
 * makes the vision request exceed its byte cap.
 */
export const PDF_RENDER_DPI_STEPS = [180, 150, 120, 100] as const;

const TEMP_DIR_PREFIX = 'olympus-extraction-pdf-render-';

export interface RenderedPdfPage {
  pageNumber: number;
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
  dpi: number;
}

export interface RenderPdfPagesRequest {
  bytes: Uint8Array;
  renderCommand?: string;
  infoCommand?: string;
  renderCommandRunner?: ExtractionCommandRunner;
  infoCommandRunner?: ExtractionCommandRunner;
  timeoutMs?: number;
  maxPages: number;
  outputFormat?: 'jpeg' | 'png';
}

export interface RenderPdfPagesResult {
  pages: RenderedPdfPage[];
  totalPages?: number;
}

export function parsePdfInfoPageCount(stdout: string): number | undefined {
  const match = /^Pages:\s*(\d+)\s*$/im.exec(stdout);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function matchRenderedPageNumber(name: string, outputFormat: 'jpeg' | 'png'): number | undefined {
  const match = outputFormat === 'jpeg'
    ? (/^page-(\d+)\.jpe?g$/i.exec(name) ?? /^page(\d+)\.jpe?g$/i.exec(name))
    : (/^page-(\d+)\.png$/i.exec(name) ?? /^page(\d+)\.png$/i.exec(name));
  if (!match?.[1]) return undefined;
  return Number(match[1]);
}

export async function renderPdfPages(input: RenderPdfPagesRequest): Promise<RenderPdfPagesResult> {
  const renderCommand = input.renderCommand?.trim() || DEFAULT_PDF_RENDER_COMMAND;
  const infoCommand = input.infoCommand?.trim() || DEFAULT_PDF_INFO_COMMAND;
  const renderCommandRunner = input.renderCommandRunner ?? runExtractionCommand;
  const infoCommandRunner = input.infoCommandRunner ?? renderCommandRunner;
  const timeoutMs = input.timeoutMs ?? DEFAULT_PDF_RENDER_TIMEOUT_MS;
  const outputFormat = input.outputFormat ?? 'jpeg';
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    const inputPath = join(tempDir, 'input.pdf');
    const outputPrefix = join(tempDir, 'page');
    await writeFile(inputPath, input.bytes);
    let totalPages: number | undefined;
    try {
      const info = await infoCommandRunner({
        command: infoCommand,
        args: [inputPath],
        timeoutMs,
      });
      totalPages = parsePdfInfoPageCount(info.stdout);
    } catch {
      totalPages = undefined;
    }
    const lastPage = Math.min(input.maxPages, totalPages ?? input.maxPages);
    await renderCommandRunner({
      command: renderCommand,
      args: [
        '-f',
        '1',
        '-l',
        String(lastPage),
        ...(outputFormat === 'jpeg' ? ['-jpeg', '-jpegopt', 'quality=85'] : ['-png']),
        '-r',
        String(DEFAULT_PDF_RENDER_DPI),
        inputPath,
        outputPrefix,
      ],
      timeoutMs,
    });
    const entries = (await readdir(tempDir))
      .map((name) => {
        const pageNumber = matchRenderedPageNumber(name, outputFormat);
        if (pageNumber === undefined) return undefined;
        return { name, pageNumber };
      })
      .filter((value): value is { name: string; pageNumber: number } => Boolean(value))
      .filter((value) => Number.isInteger(value.pageNumber) && value.pageNumber > 0)
      .sort((left, right) => left.pageNumber - right.pageNumber)
      .slice(0, input.maxPages);
    if (entries.length === 0) {
      const singleFilePath = `${outputPrefix}.${outputFormat === 'jpeg' ? 'jpg' : 'png'}`;
      try {
        return {
          pages: [{
            pageNumber: 1,
            bytes: new Uint8Array(await readFile(singleFilePath)),
            mimeType: outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
            dpi: DEFAULT_PDF_RENDER_DPI,
          }],
          ...(totalPages !== undefined ? { totalPages } : {}),
        };
      } catch {
        throw new Error('Local PDF rendering produced no page images.');
      }
    }
    return {
      pages: await Promise.all(entries.map(async (entry) => ({
        pageNumber: entry.pageNumber,
        bytes: new Uint8Array(await readFile(join(tempDir, entry.name))),
        mimeType: outputFormat === 'jpeg' ? 'image/jpeg' as const : 'image/png' as const,
        dpi: DEFAULT_PDF_RENDER_DPI,
      }))),
      ...(totalPages !== undefined ? { totalPages } : {}),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function renderSinglePdfPageForVision(input: {
  bytes: Uint8Array;
  pageNumber: number;
  dpi: number;
  renderCommand: string;
  renderCommandRunner: ExtractionCommandRunner;
  timeoutMs: number;
}): Promise<RenderedPdfPage> {
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    const inputPath = join(tempDir, 'input.pdf');
    const outputPrefix = join(tempDir, 'page');
    const outputPath = `${outputPrefix}.jpg`;
    await writeFile(inputPath, input.bytes);
    await input.renderCommandRunner({
      command: input.renderCommand,
      args: [
        '-f',
        String(input.pageNumber),
        '-l',
        String(input.pageNumber),
        '-singlefile',
        '-jpeg',
        '-jpegopt',
        'quality=85',
        '-r',
        String(input.dpi),
        inputPath,
        outputPrefix,
      ],
      timeoutMs: input.timeoutMs,
    });
    return {
      pageNumber: input.pageNumber,
      bytes: new Uint8Array(await readFile(outputPath)),
      mimeType: 'image/jpeg',
      dpi: input.dpi,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function renderPdfFirstPageForVision(input: {
  bytes: Uint8Array;
  command: string;
  commandRunner: ExtractionCommandRunner;
  timeoutMs: number;
}): Promise<{ bytes: Uint8Array; mimeType: 'image/png' }> {
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    const inputPath = join(tempDir, 'input.pdf');
    const outputPrefix = join(tempDir, 'page');
    const outputPath = `${outputPrefix}.png`;
    await writeFile(inputPath, input.bytes);
    await input.commandRunner({
      command: input.command,
      args: [
        '-f',
        '1',
        '-l',
        '1',
        '-singlefile',
        '-png',
        '-r',
        String(DEFAULT_PDF_RENDER_DPI),
        inputPath,
        outputPrefix,
      ],
      timeoutMs: input.timeoutMs,
    });
    return {
      bytes: new Uint8Array(await readFile(outputPath)),
      mimeType: 'image/png',
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
