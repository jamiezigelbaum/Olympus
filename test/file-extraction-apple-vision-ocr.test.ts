// Built-in scan reading on macOS: the OCR lane's Vision engine.
//
// Two halves. The first drives the engine through an injected command runner,
// so engine selection, page-range bounding, deterministic failure
// classification and the tesseract fallback are proven on every platform. The
// second runs the real packaged script against an image-only PDF and a PNG it
// generates on the spot; it needs PDFKit and Vision, so it runs only on macOS.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APPLE_VISION_OCR_SCRIPT,
  APPLE_VISION_OSASCRIPT,
  appleVisionOcrSelected,
  parseOcrEnginePreference,
  parseScriptResult,
  resolveAppleVisionOcrScript,
} from '../src/workers/file-extraction/extractors/apple-vision-ocr.ts';
import {
  ExtractionCommandError,
  ExtractionCommandTimeoutError,
  type ExtractionCommandRunRequest,
  type ExtractionCommandRunner,
} from '../src/workers/file-extraction/extractors/command-runner.ts';
import {
  createImageOcr,
  createOcrExtractor,
  createPdfOcr,
} from '../src/workers/file-extraction/extractors/ocr.ts';
import { createTextExtractor } from '../src/workers/file-extraction/extractors/text.ts';
import { createDefaultExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import { extractorInput, pdfImageOnly, textBytes } from './fixtures/file-extraction-extractor-fixtures.ts';

const ROOT = join(import.meta.dir, '..');
const PDF_MIME = 'application/pdf';
const PNG_MIME = 'image/png';
const DARWIN = { platform: 'darwin' as const, appleVisionScriptPath: '/pkg/scripts/macos-vision-ocr.js' };
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function scriptError(exitCode: number): ExtractionCommandError {
  return new ExtractionCommandError({ command: APPLE_VISION_OSASCRIPT, exitCode, stdout: '', stderr: '' });
}

/**
 * A fake osascript that answers each page range with one line per page, and
 * records every invocation. Commands other than osascript are refused as
 * missing, so a test sees exactly which engine ran.
 */
function fakeVision(totalPages: number, pageText = (page: number) => `page ${page} text`): {
  runner: ExtractionCommandRunner;
  calls: ExtractionCommandRunRequest[];
} {
  const calls: ExtractionCommandRunRequest[] = [];
  const runner: ExtractionCommandRunner = async (request) => {
    calls.push(request);
    if (request.command !== APPLE_VISION_OSASCRIPT) {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    }
    const [, , , mode, , first, last] = request.args;
    if (mode === 'image') {
      return {
        stdout: JSON.stringify({ engine: 'apple_vision', totalPages: 1, pages: [{ page: 1, text: 'Label  42 mg', confidence: 0.9 }] }),
        stderr: '',
      };
    }
    const pages = [];
    for (let page = Number(first); page <= Math.min(Number(last), totalPages); page += 1) {
      pages.push({ page, text: pageText(page), confidence: 0.8 });
    }
    return { stdout: JSON.stringify({ engine: 'apple_vision', totalPages, pages }), stderr: '' };
  };
  return { runner, calls };
}

describe('apple vision ocr: engine selection', () => {
  test('auto reads with Vision on macOS only; tesseract is honoured everywhere', () => {
    expect(appleVisionOcrSelected('auto', 'darwin')).toBe(true);
    expect(appleVisionOcrSelected('auto', 'linux')).toBe(false);
    expect(appleVisionOcrSelected('tesseract', 'darwin')).toBe(false);
  });

  test('the engine preference parses strictly', () => {
    expect(parseOcrEnginePreference(undefined)).toBeUndefined();
    expect(parseOcrEnginePreference(' ')).toBeUndefined();
    expect(parseOcrEnginePreference('Tesseract')).toBe('tesseract');
    expect(parseOcrEnginePreference('auto')).toBe('auto');
    expect(() => parseOcrEnginePreference('vision')).toThrow('OCR engine must be one of');
  });

  test('the packaged script resolves from a checkout module and from the bundled dist entry', () => {
    const expected = join(ROOT, APPLE_VISION_OCR_SCRIPT);
    expect(existsSync(expected)).toBe(true);
    expect(resolveAppleVisionOcrScript()).toBe(expected);
    expect(resolveAppleVisionOcrScript(pathToFileURL(join(ROOT, 'dist', 'index.js')).href)).toBe(expected);
    expect(resolveAppleVisionOcrScript(pathToFileURL('/nowhere/dist/index.js').href, () => false)).toBeUndefined();
  });

  test('a malformed script answer is an error, never an empty document', () => {
    expect(() => parseScriptResult('not json')).toThrow();
    expect(() => parseScriptResult(JSON.stringify({ totalPages: 0, pages: [] }))).toThrow();
    expect(() => parseScriptResult(JSON.stringify({ totalPages: 1, pages: [{ page: 1 }] }))).toThrow();
    expect(parseScriptResult(JSON.stringify({ totalPages: 2, pages: [{ page: 1, text: 'a', confidence: 3 }] })))
      .toEqual({ totalPages: 2, pages: [{ page: 1, text: 'a', confidence: 1 }] });
  });
});

describe('apple vision ocr: the lane on macOS (fake osascript)', () => {
  test('a scanned PDF is read in bounded page ranges with page markers', async () => {
    const { runner, calls } = fakeVision(5);
    const result = await createOcrExtractor({
      commandRunner: runner,
      engine: { ...DARWIN, pagesPerRun: 2 },
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect(calls.map((call) => call.args.slice(3, 6))).toEqual([
      ['pdf', expect.any(String), '1'],
      ['pdf', expect.any(String), '3'],
      ['pdf', expect.any(String), '5'],
    ]);
    expect(calls.map((call) => call.args[6])).toEqual(['2', '4', '5']);
    expect(calls[0]!.args.slice(0, 3)).toEqual(['-l', 'JavaScript', DARWIN.appleVisionScriptPath]);
    expect(result.text).toBe([1, 2, 3, 4, 5].map((page) => `--- Page ${page} ---\npage ${page} text`).join('\n\n'));
    const derivation = result.derivations![0]!;
    expect(derivation.confidence).toBe(0.8);
    expect(derivation.warnings).toEqual(['ocr_text', 'ocr_engine_apple_vision', 'ocr_source_rasterized_pdf']);
    expect(derivation.structuralRef).toMatchObject({ artifact: 'image_ocr', readPages: 5, totalPages: 5 });
    expect(result.warnings).toBeUndefined();
  });

  test('the page cap stops reading and is recorded', async () => {
    const { runner, calls } = fakeVision(50);
    const result = await createOcrExtractor({
      commandRunner: runner,
      engine: { ...DARWIN, maxPages: 3, pagesPerRun: 2 },
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect(calls.map((call) => call.args.slice(5, 7))).toEqual([['1', '2'], ['3', '3']]);
    expect(result.warnings).toEqual(['ocr_pdf_pages_capped']);
    expect(result.derivations![0]!.warnings).toContain('ocr_pdf_pages_capped');
    expect(result.derivations![0]!.structuralRef).toMatchObject({ readPages: 3, totalPages: 50 });
  });

  test('the text cap stops reading further page ranges', async () => {
    const { runner, calls } = fakeVision(20, () => 'x'.repeat(100));
    const result = await createOcrExtractor({
      commandRunner: runner,
      maxBoundedTextChars: 150,
      engine: { ...DARWIN, pagesPerRun: 2 },
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect(calls).toHaveLength(1);
    expect(result.text).toHaveLength(150);
    expect(result.warnings).toEqual(['bounded_text_truncated']);
  });

  test('the whole-file deadline keeps what was read and says so', async () => {
    let clock = 0;
    const { runner, calls } = fakeVision(30);
    const timed: ExtractionCommandRunner = async (request) => {
      clock += 400;
      return runner(request);
    };
    const result = await createOcrExtractor({
      commandRunner: timed,
      engine: { ...DARWIN, pagesPerRun: 2, fileDeadlineMs: 1000, now: () => clock },
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    // Each run gets only the time left in the file's budget.
    expect(calls.map((call) => call.timeoutMs)).toEqual([1000, 600, 200]);
    expect(result.warnings).toEqual(['ocr_pdf_time_capped']);
    expect(result.derivations![0]!.structuralRef).toMatchObject({ readPages: 6, totalPages: 30 });
  });

  test('a page range with no text anywhere is an honest names-only descriptor', async () => {
    const { runner } = fakeVision(2, () => '');
    const result = await createOcrExtractor({ commandRunner: runner, engine: DARWIN })
      .extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('metadata_only');
    if (result.status !== 'metadata_only') throw new Error('expected metadata_only');
    expect(result.derivations?.[0]?.warnings).toEqual(['ocr_empty', 'pdf_image_only', 'ocr_engine_apple_vision']);
  });

  test('an image is read whole and carries the engine warning', async () => {
    const { runner, calls } = fakeVision(1);
    const result = await createOcrExtractor({ commandRunner: runner, engine: DARWIN })
      .extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG_MIME }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect(calls[0]!.args[3]).toBe('image');
    expect(calls[0]!.args[4]!.endsWith('.png')).toBe(true);
    expect(result.text).toBe('Label  42 mg');
    expect(result.derivations![0]!.warnings).toEqual(['ocr_text', 'ocr_engine_apple_vision']);
  });

  test('deterministic refusals settle terminally with the lane rejection kinds', async () => {
    const refusing = (exitCode: number): ExtractionCommandRunner => async () => {
      throw scriptError(exitCode);
    };
    const pdf = (exitCode: number) => createOcrExtractor({ commandRunner: refusing(exitCode), engine: DARWIN })
      .extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(await pdf(66)).toEqual({ status: 'failed_terminal', errorKind: 'ocrmypdf_pdf_encrypted' });
    expect(await pdf(65)).toEqual({ status: 'failed_terminal', errorKind: 'ocrmypdf_pdf_invalid' });
    expect(await pdf(1)).toEqual({ status: 'failed_retryable', errorKind: 'ocr_command_failed' });
    const image = await createOcrExtractor({ commandRunner: refusing(65), engine: DARWIN })
      .extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG_MIME }));
    expect(image).toEqual({ status: 'failed_terminal', errorKind: 'ocr_image_unreadable' });
  });

  test('a timeout is retryable', async () => {
    const runner: ExtractionCommandRunner = async (request) => {
      throw new ExtractionCommandTimeoutError({ command: request.command, timeoutMs: request.timeoutMs });
    };
    expect(await createOcrExtractor({ commandRunner: runner, engine: DARWIN })
      .extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME })))
      .toEqual({ status: 'failed_retryable', errorKind: 'ocr_command_timeout' });
  });

  test('Vision unavailable on this Mac falls back to tesseract, and is remembered', async () => {
    const calls: string[] = [];
    const runner: ExtractionCommandRunner = async (request) => {
      calls.push(request.command);
      if (request.command === APPLE_VISION_OSASCRIPT) throw scriptError(69);
      return { stdout: 'tesseract text', stderr: '' };
    };
    const extractor = createOcrExtractor({ commandRunner: runner, engine: DARWIN });
    const first = await extractor.extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG_MIME }));
    const second = await extractor.extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG_MIME }));
    expect(first).toMatchObject({ status: 'indexed', text: 'tesseract text' });
    expect(second).toMatchObject({ status: 'indexed', text: 'tesseract text' });
    expect(calls).toEqual([APPLE_VISION_OSASCRIPT, 'tesseract', 'tesseract']);
  });

  test('a missing packaged script falls back without failing the job', async () => {
    const calls: string[] = [];
    const runner: ExtractionCommandRunner = async (request) => {
      calls.push(request.command);
      return { stdout: 'tesseract text', stderr: '' };
    };
    const result = await createOcrExtractor({
      commandRunner: runner,
      engine: { platform: 'darwin', appleVisionScriptPath: null },
    }).extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG_MIME }));
    expect(result).toMatchObject({ status: 'indexed', text: 'tesseract text' });
    expect(calls).toEqual(['tesseract']);
  });

  test('the tesseract preference never runs osascript on a Mac', async () => {
    const calls: string[] = [];
    const runner: ExtractionCommandRunner = async (request) => {
      calls.push(request.command);
      return { stdout: 'tesseract text', stderr: '' };
    };
    await createOcrExtractor({ commandRunner: runner, engine: { ...DARWIN, preference: 'tesseract' } })
      .extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG_MIME }));
    expect(calls).toEqual(['tesseract']);
  });
});

describe('apple vision ocr: the text lane routes scans and images to it', () => {
  test('a PDF with no text layer and an image are read by the built-in engine', async () => {
    const { runner } = fakeVision(1);
    const lane = createTextExtractor({
      pdfOcr: createPdfOcr({ commandRunner: runner, engine: DARWIN }),
      imageOcr: createImageOcr({ commandRunner: runner, engine: DARWIN }),
    });
    expect(await lane.extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME })))
      .toMatchObject({ status: 'indexed', text: '--- Page 1 ---\npage 1 text' });
    expect(await lane.extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG_MIME })))
      .toMatchObject({ status: 'indexed', text: 'Label  42 mg' });
  });

  test('off macOS an image stays names-only in the text lane, as before', async () => {
    const calls: string[] = [];
    const runner: ExtractionCommandRunner = async (request) => {
      calls.push(request.command);
      return { stdout: 'never', stderr: '' };
    };
    const lane = createTextExtractor({
      imageOcr: createImageOcr({ commandRunner: runner, engine: { platform: 'linux' } }),
    });
    expect(await lane.extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG_MIME })))
      .toEqual({ status: 'metadata_only' });
    expect(calls).toEqual([]);
  });

  test('neither engine available leaves a scan visibly ocr_required', async () => {
    const missing: ExtractionCommandRunner = async () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    };
    const lane = createTextExtractor({ pdfOcr: createPdfOcr({ commandRunner: missing, engine: DARWIN }) });
    const result = await lane.extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('metadata_only');
    if (result.status !== 'metadata_only') throw new Error('expected metadata_only');
    expect(result.derivations?.[0]?.warnings).toContain('ocr_required');
  });
});

// ---------------------------------------------------------------------------
// Real engine, macOS only.

const FIXTURE_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('PDFKit');
function run(argv) {
  const pdfPath = argv[0];
  const pngPath = argv[1];
  const lines = ['Olympus scan reading fixture', 'Hemoglobin  14.2  g/dL', 'La cebolla y el ajo son buenos para la salud.'];
  const document = $.PDFDocument.alloc.init;
  for (let index = 0; index < 2; index += 1) {
    const image = $.NSImage.alloc.initWithSize($.NSMakeSize(612, 792));
    image.lockFocus;
    $.NSColor.whiteColor.setFill;
    $.NSRectFill($.NSMakeRect(0, 0, 612, 792));
    const attributes = $.NSDictionary.dictionaryWithObjectForKey($.NSFont.systemFontOfSize(22), $.NSFontAttributeName);
    lines.forEach((line, row) => $(line + ' page ' + (index + 1)).drawAtPointWithAttributes($.NSMakePoint(50, 700 - row * 40), attributes));
    image.unlockFocus;
    document.insertPageAtIndex($.PDFPage.alloc.initWithImage(image), index);
    if (index === 0) {
      const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
      bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(pngPath, true);
    }
  }
  return document.writeToFile(pdfPath) ? 'ok' : 'failed';
}
`;

describe.skipIf(process.platform !== 'darwin')('apple vision ocr: the real engine on this Mac', () => {
  test('reads a generated image-only PDF and PNG through the text lane, with nothing installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-vision-ocr-test-'));
    return (async () => {
      try {
        const fixtureScript = join(dir, 'fixture.js');
        const pdfPath = join(dir, 'scan.pdf');
        const pngPath = join(dir, 'scan.png');
        writeFileSync(fixtureScript, FIXTURE_SCRIPT);
        const generated = spawnSync(APPLE_VISION_OSASCRIPT, ['-l', 'JavaScript', fixtureScript, pdfPath, pngPath], {
          encoding: 'utf8',
        });
        expect(generated.stdout.trim()).toBe('ok');
        const pdfBytes = new Uint8Array(readFileSync(pdfPath));
        const pngBytes = new Uint8Array(readFileSync(pngPath));
        // Image-only: no font resources, and the plain text lane finds no text.
        expect(Buffer.from(pdfBytes).toString('latin1')).not.toContain('/Font');
        const plain = await createTextExtractor().extract(extractorInput({ bytes: pdfBytes, mimeType: PDF_MIME }));
        expect(plain.status).not.toBe('indexed');

        // The default registry's text lane, as the runner selects it.
        const lane = createDefaultExtractorRegistry().get('local_text')!;
        const pdf = await lane.extract(extractorInput({ bytes: pdfBytes, mimeType: PDF_MIME }));
        expect(pdf.status).toBe('indexed');
        if (pdf.status !== 'indexed') throw new Error('expected indexed');
        expect(pdf.text).toContain('--- Page 1 ---');
        expect(pdf.text).toContain('--- Page 2 ---');
        expect(pdf.text).toContain('Hemoglobin');
        expect(pdf.text).toContain('14.2');
        expect(pdf.text).toContain('cebolla');
        expect(pdf.derivations![0]!.warnings).toContain('ocr_engine_apple_vision');
        expect(pdf.derivations![0]!.structuralRef).toMatchObject({ readPages: 2, totalPages: 2 });

        const png = await lane.extract(extractorInput({ bytes: pngBytes, mimeType: PNG_MIME }));
        expect(png.status).toBe('indexed');
        if (png.status !== 'indexed') throw new Error('expected indexed');
        expect(png.text).toContain('Olympus scan reading fixture');
        // A table row's label and value stay on one line.
        expect(png.text.split('\n').some((line) => line.includes('Hemoglobin') && line.includes('14.2'))).toBe(true);

        // Undecodable input is refused deterministically by the real script.
        const garbage = await lane.extract(extractorInput({ bytes: textBytes('not an image'), mimeType: PNG_MIME }));
        expect(garbage).toEqual({ status: 'failed_terminal', errorKind: 'ocr_image_unreadable' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
  }, 60_000);
});
