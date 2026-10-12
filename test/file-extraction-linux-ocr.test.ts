// Reading scans and pictures of text where Apple Vision is not available.
//
// The OCR commands are probed, not presumed (ocr-capability.ts); the probe picks
// the engine (Vision / ocrmypdf / pdftoppm + tesseract / none); a scanned PDF
// left unread for want of an engine is read once when one works. Everything
// except the last describe block runs against an injected command runner that
// stands in for a machine, so it runs the same on every host and never skips.
// The last block runs the real tools and skips by availability.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  ExtractionCommandError,
  runExtractionCommand,
  type ExtractionCommandRunRequest,
  type ExtractionCommandRunner,
} from '../src/workers/file-extraction/extractors/command-runner.ts';
import {
  OCR_MISSING_TTL_MS,
  OCR_READY_TTL_MS,
  buildOcrProbePdf,
  createOcrCapabilityProbe,
  ocrmypdfArguments,
  probeOcrCapability,
  type OcrCapabilitySnapshot,
} from '../src/workers/file-extraction/extractors/ocr-capability.ts';
import {
  IMAGE_OCR_VERSION_SUFFIX,
  createImageOcr,
  createImageOcrVersionSuffix,
  createOcrRereadPolicy,
  createPdfOcr,
  type OcrEngineOptions,
} from '../src/workers/file-extraction/extractors/ocr.ts';
import { ocrProbeJpeg } from '../src/workers/file-extraction/extractors/ocr-probe-fixture.ts';
import {
  classifyRasterPdfRejection,
  rasterDpiFor,
  rasterPdfOcr,
} from '../src/workers/file-extraction/extractors/pdf-raster-ocr.ts';
import { createTextExtractor } from '../src/workers/file-extraction/extractors/text.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { buildExtractorRegistry, createDefaultExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import { createFileExtractionRunner } from '../src/workers/file-extraction/runner.ts';
import type { ExtractorOutput } from '../src/workers/file-extraction/types.ts';
import { extractorInput } from './fixtures/file-extraction-extractor-fixtures.ts';

const PDF = 'application/pdf';
const PNG = 'image/png';
const SCANNED_PDF = new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures/pdf/scanned-receipt.pdf')));
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

// --- A machine, as a command runner ---------------------------------------

type Tool = 'ok' | 'missing' | 'broken';

interface MachineSpec {
  tesseract: Tool;
  pdftoppm: Tool;
  /** `no_unpaper`: installed, but its `--clean` dependency is not. */
  ocrmypdf: Tool | 'no_unpaper';
  /** Apple Vision through osascript. */
  vision?: 'ok' | 'unavailable';
  pages?: number;
  pageSize?: string;
  /** Pages the real (non-probe) tesseract run fails on. */
  failingPages?: readonly number[];
  /** pdftoppm refuses the document. */
  pdfRefusal?: 'encrypted' | 'invalid';
  /** Tools that pass every probe but are gone when the real file arrives. */
  vanishAfterProbe?: boolean;
}

const enoent = (): Error => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

function fakeMachine(initial: MachineSpec) {
  const spec: MachineSpec = { ...initial };
  const calls: ExtractionCommandRunRequest[] = [];
  let probeDone = false;
  const probeCall = (request: ExtractionCommandRunRequest): boolean => request.args.some((arg) => arg.includes('olympus-ocr-probe-'));
  const runner: ExtractionCommandRunner = async (request) => {
    calls.push(request);
    const probing = probeCall(request);
    if (!probing) probeDone = true;
    const gone = (tool: Tool | 'no_unpaper'): boolean => tool === 'missing' || (spec.vanishAfterProbe === true && !probing && probeDone);
    switch (request.command) {
      case 'pdfinfo': {
        if (gone(spec.pdftoppm)) throw enoent();
        return { stdout: `Pages:          ${spec.pages ?? 1}\nPage size:      ${spec.pageSize ?? '612 x 792 pts (letter)'}\n`, stderr: '' };
      }
      case 'pdftoppm': {
        if (gone(spec.pdftoppm)) throw enoent();
        if (spec.pdftoppm === 'broken') throw new ExtractionCommandError({ command: 'pdftoppm', exitCode: 99, stdout: '', stderr: 'boom' });
        if (spec.pdfRefusal === 'encrypted' && !probing) {
          throw new ExtractionCommandError({ command: 'pdftoppm', exitCode: 1, stdout: '', stderr: 'Command Line Error: Incorrect password' });
        }
        if (spec.pdfRefusal === 'invalid' && !probing) {
          throw new ExtractionCommandError({ command: 'pdftoppm', exitCode: 1, stdout: '', stderr: "Syntax Error: Couldn't read xref table" });
        }
        const first = Number(request.args[request.args.indexOf('-f') + 1]);
        const last = Number(request.args[request.args.indexOf('-l') + 1]);
        const prefix = request.args[request.args.length - 1]!;
        for (let page = first; page <= Math.min(last, spec.pages ?? 1); page += 1) {
          await writeFile(`${prefix}-${page}.png`, new Uint8Array([page]));
        }
        return { stdout: '', stderr: '' };
      }
      case 'tesseract': {
        if (gone(spec.tesseract)) throw enoent();
        if (spec.tesseract === 'broken') return { stdout: 'gibberish', stderr: '' };
        const path = request.args[0]!;
        if (probing) return { stdout: 'OLYMPUS\n', stderr: '' };
        const page = Number(basename(path).replace('page-', '').replace('.png', ''));
        if (spec.failingPages?.includes(page)) {
          throw new ExtractionCommandError({ command: 'tesseract', exitCode: 1, stdout: '', stderr: 'Error: cannot read' });
        }
        return { stdout: basename(path).startsWith('page-') ? `text of page ${page}\n` : 'text in the picture\n', stderr: '' };
      }
      case 'ocrmypdf': {
        if (gone(spec.ocrmypdf === 'no_unpaper' ? 'ok' : spec.ocrmypdf)) throw enoent();
        if (spec.ocrmypdf === 'no_unpaper') {
          throw new ExtractionCommandError({ command: 'ocrmypdf', exitCode: 3, stdout: '', stderr: 'MissingDependencyError: unpaper' });
        }
        if (spec.ocrmypdf === 'broken') throw new ExtractionCommandError({ command: 'ocrmypdf', exitCode: 15, stdout: '', stderr: '' });
        await writeFile(request.args[request.args.indexOf('--sidecar') + 1]!, probing ? 'OLYMPUS\n' : 'text read by ocrmypdf\n');
        return { stdout: '', stderr: '' };
      }
      case '/usr/bin/osascript': {
        if (spec.vision === 'unavailable') {
          throw new ExtractionCommandError({ command: 'osascript', exitCode: 69, stdout: '', stderr: '' });
        }
        return { stdout: JSON.stringify({ totalPages: 1, pages: [{ page: 1, text: 'text read by vision', confidence: 0.9 }] }), stderr: '' };
      }
      default:
        throw enoent();
    }
  };
  return {
    spec,
    calls,
    runner,
    commands: () => calls.map((call) => call.command),
    realCommands: () => calls.filter((call) => !probeCall(call)).map((call) => call.command),
  };
}

const LINUX: OcrEngineOptions = { platform: 'linux' };
const MAC: OcrEngineOptions = { platform: 'darwin', appleVisionScriptPath: '/fake/macos-vision-ocr.js' };
const ALL_TOOLS: MachineSpec = { tesseract: 'ok', pdftoppm: 'ok', ocrmypdf: 'ok' };

function indexedText(output: ExtractorOutput | undefined): string {
  expect(output?.status).toBe('indexed');
  return output && output.status === 'indexed' ? output.text : '';
}

function derivationWarnings(output: ExtractorOutput | undefined): readonly string[] {
  return output && output.status === 'indexed' ? output.derivations?.[0]?.warnings ?? [] : [];
}

// --- The probe --------------------------------------------------------------

describe('OCR capability probe', () => {
  test('the fixture is a JPEG and the probe PDF is well formed with correct cross-reference offsets', () => {
    const jpeg = ocrProbeJpeg();
    expect([...jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const pdf = Buffer.from(buildOcrProbePdf());
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text).toContain('/Filter /DCTDecode');
    const startxref = Number(text.slice(text.lastIndexOf('startxref') + 'startxref'.length).trim().split('\n')[0]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const table = text.slice(startxref).split('\n').filter((line) => line.endsWith(' 00000 n '));
    expect(table).toHaveLength(5);
    table.forEach((line, index) => {
      const offset = Number(line.slice(0, 10));
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
  });

  test('everything installed: ocrmypdf reads PDFs and tesseract reads pictures, proven on the fixture', async () => {
    const machine = fakeMachine(ALL_TOOLS);
    const snapshot = await probeOcrCapability({ commandRunner: machine.runner });
    expect(snapshot).toMatchObject({
      tesseract: 'ok', pdftoppm: 'ok', ocrmypdf: 'ok', pdfEngine: 'ocrmypdf', imageEngine: 'tesseract',
    });
    // The probe runs the lane's real ocrmypdf command, `--clean` included.
    const ocrmypdf = machine.calls.find((call) => call.command === 'ocrmypdf')!;
    const flags = ocrmypdfArguments({ inputPath: 'a', outputPath: 'b', sidecarPath: 'c' });
    expect(ocrmypdf.args.slice(0, flags.length - 3)).toEqual(flags.slice(0, flags.length - 3));
    expect(ocrmypdf.args).toContain('--clean');
  });

  test('no ocrmypdf (Arch, Omarchy): pdftoppm pages read by tesseract are the PDF engine', async () => {
    const snapshot = await probeOcrCapability({ commandRunner: fakeMachine({ ...ALL_TOOLS, ocrmypdf: 'missing' }).runner });
    expect(snapshot).toMatchObject({ ocrmypdf: 'missing', pdfEngine: 'pdftoppm_tesseract', imageEngine: 'tesseract' });
  });

  test('ocrmypdf installed without its --clean dependency does not count: it falls back', async () => {
    const snapshot = await probeOcrCapability({ commandRunner: fakeMachine({ ...ALL_TOOLS, ocrmypdf: 'no_unpaper' }).runner });
    expect(snapshot).toMatchObject({ ocrmypdf: 'failed', pdfEngine: 'pdftoppm_tesseract' });
  });

  test('a tesseract that runs but cannot read the fixture is not an engine, and ocrmypdf is not tried without it', async () => {
    const machine = fakeMachine({ ...ALL_TOOLS, tesseract: 'broken' });
    const snapshot = await probeOcrCapability({ commandRunner: machine.runner });
    expect(snapshot).toMatchObject({
      tesseract: 'failed', ocrmypdf: 'skipped', pdfEngine: undefined, imageEngine: undefined,
    });
    expect(machine.commands()).not.toContain('ocrmypdf');
  });

  test('no tesseract at all: nothing reads, whatever else is installed', async () => {
    const snapshot = await probeOcrCapability({ commandRunner: fakeMachine({ ...ALL_TOOLS, tesseract: 'missing' }).runner });
    expect(snapshot).toMatchObject({ tesseract: 'missing', pdfEngine: undefined, imageEngine: undefined });
  });

  test('tesseract without pdftoppm reads pictures but not scanned PDFs', async () => {
    const snapshot = await probeOcrCapability({
      commandRunner: fakeMachine({ tesseract: 'ok', pdftoppm: 'missing', ocrmypdf: 'missing' }).runner,
    });
    expect(snapshot).toMatchObject({ pdftoppm: 'missing', pdfEngine: undefined, imageEngine: 'tesseract' });
  });

  test('a pdftoppm that cannot render the probe page is not an engine', async () => {
    const snapshot = await probeOcrCapability({
      commandRunner: fakeMachine({ tesseract: 'ok', pdftoppm: 'broken', ocrmypdf: 'missing' }).runner,
    });
    expect(snapshot).toMatchObject({ pdftoppm: 'failed', pdfEngine: undefined, imageEngine: 'tesseract' });
  });

  test('a probe never throws, whatever the runner does', async () => {
    const snapshot = await probeOcrCapability({
      commandRunner: async () => { throw new TypeError('not even an errno'); },
    });
    expect(snapshot).toMatchObject({ tesseract: 'failed', pdfEngine: undefined, imageEngine: undefined });
  });
});

describe('OCR capability cache', () => {
  function counted(results: Array<Partial<OcrCapabilitySnapshot>>, clock: { now: number }) {
    let runs = 0;
    const probe = createOcrCapabilityProbe({
      now: () => clock.now,
      probe: async () => {
        const next = results[Math.min(runs, results.length - 1)]!;
        runs += 1;
        return {
          tesseract: 'missing', pdftoppm: 'missing', ocrmypdf: 'missing',
          pdfEngine: undefined, imageEngine: undefined, ...next, checkedAt: clock.now,
        };
      },
    });
    return { probe, runs: () => runs };
  }

  test('a working engine is trusted for ten minutes, a missing one is looked at again after one', async () => {
    const clock = { now: 1_000 };
    const working = counted([{ imageEngine: 'tesseract', tesseract: 'ok' }], clock);
    await working.probe.snapshot();
    clock.now += OCR_READY_TTL_MS - 1;
    await working.probe.snapshot();
    expect(working.runs()).toBe(1);
    clock.now += 2;
    await working.probe.snapshot();
    expect(working.runs()).toBe(2);

    const missing = counted([{}, { imageEngine: 'tesseract', tesseract: 'ok' }], clock);
    expect((await missing.probe.snapshot()).imageEngine).toBeUndefined();
    clock.now += OCR_MISSING_TTL_MS - 1;
    expect((await missing.probe.snapshot()).imageEngine).toBeUndefined();
    expect(missing.runs()).toBe(1);
    clock.now += 2;
    expect((await missing.probe.snapshot()).imageEngine).toBe('tesseract');
  });

  test('concurrent callers share one probe, peek is synchronous, warm only probes when nothing is fresh', async () => {
    const clock = { now: 5 };
    const lane = counted([{ imageEngine: 'tesseract', tesseract: 'ok' }], clock);
    expect(lane.probe.peek()).toBeUndefined();
    await Promise.all([lane.probe.snapshot(), lane.probe.snapshot(), lane.probe.snapshot()]);
    expect(lane.runs()).toBe(1);
    expect(lane.probe.peek()?.imageEngine).toBe('tesseract');
    lane.probe.warm();
    await lane.probe.snapshot();
    expect(lane.runs()).toBe(1);
  });
});

// --- Engine selection --------------------------------------------------------

const pdfInput = { bytes: new Uint8Array([1, 2, 3]), mimeType: PDF, sizeBytes: 3 };
const imageInput = { bytes: PNG_BYTES, mimeType: PNG, sizeBytes: PNG_BYTES.length };

describe('engine selection: scanned PDFs', () => {
  test('Apple Vision first, with no command probed', async () => {
    const machine = fakeMachine({ ...ALL_TOOLS, vision: 'ok' });
    const output = await createPdfOcr({ commandRunner: machine.runner, engine: MAC })(pdfInput);
    expect(indexedText(output)).toContain('text read by vision');
    expect(derivationWarnings(output)).toContain('ocr_engine_apple_vision');
    expect(machine.commands().every((command) => command === '/usr/bin/osascript')).toBe(true);
  });

  test('ocrmypdf when its real command passes its probe', async () => {
    const machine = fakeMachine(ALL_TOOLS);
    const output = await createPdfOcr({ commandRunner: machine.runner, engine: LINUX })(pdfInput);
    expect(indexedText(output)).toContain('text read by ocrmypdf');
    expect(machine.realCommands()).toEqual(['ocrmypdf']);
  });

  test('pdftoppm and tesseract when ocrmypdf is absent', async () => {
    const machine = fakeMachine({ ...ALL_TOOLS, ocrmypdf: 'missing', pages: 2 });
    const output = await createPdfOcr({ commandRunner: machine.runner, engine: LINUX })(pdfInput);
    expect(indexedText(output)).toBe('--- Page 1 ---\ntext of page 1\n\n--- Page 2 ---\ntext of page 2');
    expect(derivationWarnings(output)).toEqual(expect.arrayContaining([
      'ocr_text', 'ocr_engine_tesseract', 'ocr_source_rasterized_pdf',
    ]));
    expect(machine.realCommands()).not.toContain('ocrmypdf');
  });

  test('pdftoppm and tesseract when ocrmypdf lacks its --clean dependency: the broken command is not used', async () => {
    const machine = fakeMachine({ ...ALL_TOOLS, ocrmypdf: 'no_unpaper' });
    const output = await createPdfOcr({ commandRunner: machine.runner, engine: LINUX })(pdfInput);
    expect(indexedText(output)).toContain('text of page 1');
    expect(machine.realCommands()).not.toContain('ocrmypdf');
  });

  test('Vision unavailable on a Mac falls to the probed command engines', async () => {
    const machine = fakeMachine({ ...ALL_TOOLS, ocrmypdf: 'missing', vision: 'unavailable' });
    const output = await createPdfOcr({ commandRunner: machine.runner, engine: MAC })(pdfInput);
    expect(indexedText(output)).toContain('text of page 1');
  });

  test('no engine: not read (undefined), so the PDF stays visibly ocr_required', async () => {
    const machine = fakeMachine({ tesseract: 'missing', pdftoppm: 'missing', ocrmypdf: 'missing' });
    expect(await createPdfOcr({ commandRunner: machine.runner, engine: LINUX })(pdfInput)).toBeUndefined();
    const text = await createTextExtractor({ pdfOcr: createPdfOcr({ commandRunner: machine.runner, engine: LINUX }) })
      .extract(extractorInput({ bytes: SCANNED_PDF, mimeType: PDF }));
    expect(text.status).toBe('metadata_only');
    expect(text.status === 'metadata_only' ? text.derivations?.[0]?.warnings : []).toContain('ocr_required');
  });

  test('the engine pinned to tesseract runs ocrmypdf directly with no probe, as before', async () => {
    const machine = fakeMachine(ALL_TOOLS);
    await createPdfOcr({ commandRunner: machine.runner, engine: { ...LINUX, preference: 'tesseract' } })(pdfInput);
    expect(machine.commands()).toEqual(['ocrmypdf']);
  });

  test('tools that pass the probe and then vanish leave the PDF unread, not failed', async () => {
    const machine = fakeMachine({ ...ALL_TOOLS, ocrmypdf: 'missing', vanishAfterProbe: true });
    expect(await createPdfOcr({ commandRunner: machine.runner, engine: LINUX })(pdfInput)).toBeUndefined();
  });
});

describe('engine selection: pictures of text', () => {
  test('tesseract reads a picture in the text lane once its probe passes', async () => {
    const machine = fakeMachine(ALL_TOOLS);
    const lane = createTextExtractor({ imageOcr: createImageOcr({ commandRunner: machine.runner, engine: LINUX }) });
    const output = await lane.extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG }));
    expect(indexedText(output)).toBe('text in the picture');
    expect(derivationWarnings(output)).toContain('ocr_text');
    // The contract is the Vision path's: the lane's text, an image_ocr derivation.
    expect(output.status === 'indexed' ? output.derivations?.[0]?.structuralRef?.artifact : undefined).toBe('image_ocr');
  });

  test('tesseract runs with one OpenMP thread per process', async () => {
    const machine = fakeMachine(ALL_TOOLS);
    await createImageOcr({ commandRunner: machine.runner, engine: LINUX })(imageInput);
    const real = machine.calls.filter((call) => call.command === 'tesseract' && !call.args[0]!.includes('olympus-ocr-probe-'));
    expect(real).toHaveLength(1);
    expect(real[0]!.env).toEqual({ OMP_THREAD_LIMIT: '1' });
  });

  test('a tesseract that cannot read the fixture leaves pictures names-only', async () => {
    const machine = fakeMachine({ ...ALL_TOOLS, tesseract: 'broken' });
    const lane = createTextExtractor({ imageOcr: createImageOcr({ commandRunner: machine.runner, engine: LINUX }) });
    expect(await lane.extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG }))).toEqual({ status: 'metadata_only' });
  });

  test('no tesseract: names-only, and the verdict is cached rather than a process per picture', async () => {
    const machine = fakeMachine({ tesseract: 'missing', pdftoppm: 'missing', ocrmypdf: 'missing' });
    const read = createImageOcr({ commandRunner: machine.runner, engine: LINUX });
    expect(await read(imageInput)).toBeUndefined();
    const callsAfterFirst = machine.calls.length;
    expect(await read(imageInput)).toBeUndefined();
    expect(machine.calls.length).toBe(callsAfterFirst);
  });

  test('on a Mac Vision reads pictures and no command is probed; when Vision is unavailable tesseract reads', async () => {
    const withVision = fakeMachine({ ...ALL_TOOLS, vision: 'ok' });
    expect(indexedText(await createImageOcr({ commandRunner: withVision.runner, engine: MAC })(imageInput)))
      .toContain('text read by vision');
    expect(withVision.commands().every((command) => command === '/usr/bin/osascript')).toBe(true);
    const broken = fakeMachine({ ...ALL_TOOLS, vision: 'unavailable' });
    expect(indexedText(await createImageOcr({ commandRunner: broken.runner, engine: MAC })(imageInput)))
      .toBe('text in the picture');
  });

  test('pinned to tesseract, pictures stay names-only in the text lane as before', async () => {
    const machine = fakeMachine(ALL_TOOLS);
    const read = createImageOcr({ commandRunner: machine.runner, engine: { ...LINUX, preference: 'tesseract' } });
    expect(await read(imageInput)).toBeUndefined();
    expect(machine.calls).toEqual([]);
  });

  test('tools that vanish after the probe leave the picture unread, not failed', async () => {
    const machine = fakeMachine({ ...ALL_TOOLS, vanishAfterProbe: true });
    expect(await createImageOcr({ commandRunner: machine.runner, engine: LINUX })(imageInput)).toBeUndefined();
  });
});

// --- The raster engine -------------------------------------------------------

describe('pdftoppm + tesseract engine', () => {
  const base = { inputPath: '/does/not/matter.pdf', mimeType: PDF, sizeBytes: 10 };
  function options(machine: ReturnType<typeof fakeMachine>, extra: Partial<Parameters<typeof rasterPdfOcr>[1]> = {}) {
    return { commandRunner: machine.runner, timeoutMs: 120_000, maxBoundedTextChars: 100_000, ...extra };
  }

  test('pages are rendered in short ranges and the page cap is recorded, not silent', async () => {
    const machine = fakeMachine({ ...ALL_TOOLS, pages: 5 });
    const output = await rasterPdfOcr(base, options(machine, { maxPages: 3, pagesPerRun: 2 }));
    const ranges = machine.calls.filter((call) => call.command === 'pdftoppm')
      .map((call) => `${call.args[call.args.indexOf('-f') + 1]}-${call.args[call.args.indexOf('-l') + 1]}`);
    expect(ranges).toEqual(['1-2', '3-3']);
    expect(indexedText(output)).toContain('--- Page 3 ---');
    expect(indexedText(output)).not.toContain('--- Page 4 ---');
    expect(derivationWarnings(output)).toContain('ocr_pdf_pages_capped');
    expect(output.status === 'indexed' ? output.warnings : []).toContain('ocr_pdf_pages_capped');
    expect(output.status === 'indexed' ? output.derivations?.[0]?.structuralRef : undefined)
      .toMatchObject({ readPages: 3, totalPages: 5 });
  });

  test('renders grayscale PNG at 200 dpi, and lowers it so a poster page stays within the pixel cap', async () => {
    const letter = fakeMachine(ALL_TOOLS);
    await rasterPdfOcr(base, options(letter));
    const args = letter.calls.find((call) => call.command === 'pdftoppm')!.args;
    expect(args[args.indexOf('-r') + 1]).toBe('200');
    expect(args).toEqual(expect.arrayContaining(['-gray', '-png']));
    const poster = fakeMachine({ ...ALL_TOOLS, pageSize: '1440 x 2000 pts (poster)' });
    await rasterPdfOcr(base, options(poster));
    const posterArgs = poster.calls.find((call) => call.command === 'pdftoppm')!.args;
    expect(Number(posterArgs[posterArgs.indexOf('-r') + 1])).toBe(Math.floor((3000 * 72) / 2000));
    expect(rasterDpiFor(undefined, 3000)).toBe(200);
    expect(rasterDpiFor(100_000, 3000)).toBe(72);
  });

  test('a document-wide deadline stops reading and records the cut', async () => {
    const machine = fakeMachine({ ...ALL_TOOLS, pages: 6 });
    let clock = 0;
    const output = await rasterPdfOcr(base, options(machine, {
      pagesPerRun: 2,
      fileDeadlineMs: 1_000,
      now: () => {
        clock += 300;
        return clock;
      },
    }));
    expect(derivationWarnings(output)).toContain('ocr_pdf_time_capped');
    expect(indexedText(output)).toContain('--- Page 1 ---');
    expect(indexedText(output)).not.toContain('--- Page 6 ---');
  });

  test('a page tesseract cannot read is recorded and the rest is kept; every page failing is a failure', async () => {
    const some = await rasterPdfOcr(base, options(fakeMachine({ ...ALL_TOOLS, pages: 3, failingPages: [2] })));
    expect(indexedText(some)).toContain('--- Page 3 ---');
    expect(indexedText(some)).not.toContain('--- Page 2 ---');
    expect(derivationWarnings(some)).toContain('ocr_pdf_page_unreadable');
    await expect(rasterPdfOcr(base, options(fakeMachine({ ...ALL_TOOLS, pages: 2, failingPages: [1, 2] }))))
      .rejects.toBeInstanceOf(ExtractionCommandError);
  });

  test('a PDF the renderer refuses settles terminally with the lane\'s rejection kinds', async () => {
    expect(await rasterPdfOcr(base, options(fakeMachine({ ...ALL_TOOLS, pdfRefusal: 'encrypted' }))))
      .toEqual({ status: 'failed_terminal', errorKind: 'ocrmypdf_pdf_encrypted' });
    expect(await rasterPdfOcr(base, options(fakeMachine({ ...ALL_TOOLS, pdfRefusal: 'invalid' }))))
      .toEqual({ status: 'failed_terminal', errorKind: 'ocrmypdf_pdf_invalid' });
    expect(classifyRasterPdfRejection(new ExtractionCommandError({ command: 'pdftoppm', exitCode: 99, stdout: '', stderr: '' })))
      .toBeUndefined();
    expect(classifyRasterPdfRejection(new ExtractionCommandError({ command: 'ocrmypdf', exitCode: 1, stdout: '', stderr: '' })))
      .toBeUndefined();
  });

  test('pages with no recognizable text settle as a scanned-pdf media descriptor, not as nothing', async () => {
    const machine = fakeMachine(ALL_TOOLS);
    const empty: ExtractionCommandRunner = async (request) => (
      request.command === 'tesseract' ? { stdout: '  \n', stderr: '' } : machine.runner(request)
    );
    const output = await rasterPdfOcr(base, options(machine, { commandRunner: empty }));
    expect(output.status).toBe('metadata_only');
    expect(output.status === 'metadata_only' ? output.derivations?.[0]?.warnings : []).toEqual(expect.arrayContaining(['ocr_empty', 'pdf_image_only']));
  });
});

// --- Recovery ----------------------------------------------------------------

describe('rereading what OCR could not read', () => {
  const LANE = { corpusId: 'secure_local.fake.files', provider: 'fake', accountScope: 'personal', approvedScopeKey: 'fake.personal:/Scans' };

  /**
   * A lane over one scanned PDF, a text extractor wired exactly as the default
   * registry wires it, and a clock the probe cache obeys.
   */
  function setup(spec: MachineSpec) {
    const machine = fakeMachine(spec);
    const clock = { now: 1_000 };
    const capability = createOcrCapabilityProbe({ commandRunner: machine.runner, now: () => clock.now });
    const text = createTextExtractor({
      pdfOcr: createPdfOcr({ commandRunner: machine.runner, engine: { ...LINUX, capability } }),
      ocrReread: createOcrRereadPolicy({ capability }),
    });
    const jobs = new LocalFileExtractionJobStore(':memory:');
    const written: string[] = [];
    const runner = createFileExtractionRunner({
      jobs,
      registry: buildExtractorRegistry([text]),
      corpora: [{
        corpusId: LANE.corpusId,
        trustDomain: 'secure_local',
        source: {
          id: 'fake', corpusId: LANE.corpusId, provider: LANE.provider,
          async listCandidates() { return { candidates: [], done: true }; },
          async fetch() { return { bytes: SCANNED_PDF, mimeType: PDF }; },
        },
        sink: {
          async accept(request) {
            written.push(request.text ?? '');
            return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 };
          },
        },
      }],
    });
    jobs.enqueue({
      refs: [{ ...LANE, providerItemId: 'scan-1', localItemId: 'personal:scan-1', name: 'scan.pdf', mimeType: PDF }],
      extractorKind: text.kind,
      extractorVersion: text.version,
      policyDecision: 'index_allowed',
    });
    return {
      jobs, runner, machine, capability, clock, written,
      run: () => runner.run({ ...LANE }),
      /** Time passes past the missing-engine TTL and the probe is looked at again. */
      async afterInstallProbe() {
        clock.now += OCR_MISSING_TTL_MS + 1;
        capability.warm();
        await capability.snapshot();
      },
    };
  }

  test('missing -> installed -> reread exactly once, unchanged source, then never again', async () => {
    const lane = setup({ tesseract: 'missing', pdftoppm: 'missing', ocrmypdf: 'missing' });
    try {
      const first = await lane.run();
      expect(first.counts.metadata_only).toBe(1);
      expect(lane.written).toEqual([]);

      // Still no OCR: asked, nothing requeued, nothing read.
      const waiting = await lane.run();
      expect(waiting.rereadRequeued).toBeUndefined();
      expect(waiting.leasedJobs).toBe(0);

      // The owner installs tesseract and poppler. The cache goes stale, the
      // probe runs, the next run requeues the scan once and reads it.
      Object.assign(lane.machine.spec, { tesseract: 'ok', pdftoppm: 'ok' });
      await lane.afterInstallProbe();
      const reread = await lane.run();
      expect(reread.rereadRequeued).toBe(1);
      expect(reread.counts.indexed).toBe(1);
      expect(lane.written.join('\n')).toContain('text of page 1');

      const again = await lane.run();
      expect(again.rereadRequeued).toBeUndefined();
      expect(again.leasedJobs).toBe(0);
    } finally {
      lane.jobs.close();
    }
  });

  test('before the first probe finishes the policy answers pending, and ready once the answer is in', async () => {
    const lane = setup({ ...ALL_TOOLS, ocrmypdf: 'missing' });
    try {
      const policy = createOcrRereadPolicy({ capability: lane.capability });
      expect(policy.prepare()).toBe('pending');
      await lane.capability.snapshot();
      expect(policy.prepare()).toBe('ready');
    } finally {
      lane.jobs.close();
    }
  });

  test('OCR that keeps failing does not loop: a failed read is retried by the queue\'s own budget, never requeued by the reread', async () => {
    const lane = setup({ tesseract: 'missing', pdftoppm: 'missing', ocrmypdf: 'missing' });
    try {
      await lane.run();
      // The engines pass their probes, but every real page fails.
      Object.assign(lane.machine.spec, { tesseract: 'ok', pdftoppm: 'ok', failingPages: [1] });
      await lane.afterInstallProbe();
      const reread = await lane.run();
      expect(reread.rereadRequeued).toBe(1);
      expect(reread.counts.indexed ?? 0).toBe(0);
      expect(reread.counts.failed_retryable).toBe(1);
      let requeued = 0;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const result = await lane.run();
        requeued += result.rereadRequeued ?? 0;
      }
      expect(requeued).toBe(0);
      expect(lane.written).toEqual([]);
    } finally {
      lane.jobs.close();
    }
  });

  test('a reader that vanishes between its probe and the read costs one try, not a loop', async () => {
    const lane = setup({ tesseract: 'missing', pdftoppm: 'missing', ocrmypdf: 'missing' });
    try {
      await lane.run();
      Object.assign(lane.machine.spec, { tesseract: 'ok', pdftoppm: 'ok', vanishAfterProbe: true });
      await lane.afterInstallProbe();
      expect((await lane.run()).rereadRequeued).toBe(1);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect((await lane.run()).rereadRequeued).toBeUndefined();
      }
    } finally {
      lane.jobs.close();
    }
  });

  test('items already read are never requeued', async () => {
    const lane = setup(ALL_TOOLS);
    try {
      expect((await lane.run()).counts.indexed).toBe(1);
      await lane.afterInstallProbe();
      const next = await lane.run();
      expect(next.rereadRequeued).toBeUndefined();
      expect(lane.written).toHaveLength(1);
    } finally {
      lane.jobs.close();
    }
  });

  test('the reread policy answers from the cache: pending, unavailable, ready; pinned to tesseract it needs ocrmypdf', () => {
    const snapshot = (over: Partial<OcrCapabilitySnapshot>): OcrCapabilitySnapshot => ({
      tesseract: 'missing', pdftoppm: 'missing', ocrmypdf: 'missing', pdfEngine: undefined, imageEngine: undefined, checkedAt: 1, ...over,
    });
    const policyFor = (seen: OcrCapabilitySnapshot | undefined, preference?: 'tesseract') => createOcrRereadPolicy({
      capability: { snapshot: async () => seen!, peek: () => seen, warm: () => {} },
      ...(preference ? { preference } : {}),
    });
    expect(policyFor(undefined).prepare()).toBe('pending');
    expect(policyFor(snapshot({})).prepare()).toBe('unavailable');
    expect(policyFor(snapshot({ imageEngine: 'tesseract' })).prepare()).toBe('unavailable');
    expect(policyFor(snapshot({ pdfEngine: 'pdftoppm_tesseract' })).prepare()).toBe('ready');
    expect(policyFor(snapshot({ pdfEngine: 'pdftoppm_tesseract' }), 'tesseract').prepare()).toBe('unavailable');
    expect(policyFor(snapshot({ pdfEngine: 'ocrmypdf', ocrmypdf: 'ok' }), 'tesseract').prepare()).toBe('ready');
    const policy = policyFor(snapshot({}));
    expect(policy.unreadWarnings).toEqual(['ocr_required']);
    expect(policy.unreadTerminalErrorKinds).toEqual([]);
  });
});

describe('pictures read again when tesseract starts working', () => {
  const working: OcrCapabilitySnapshot = {
    tesseract: 'ok', pdftoppm: 'ok', ocrmypdf: 'missing', pdfEngine: 'pdftoppm_tesseract', imageEngine: 'tesseract', checkedAt: 1,
  };
  const none: OcrCapabilitySnapshot = { ...working, tesseract: 'missing', pdfEngine: undefined, imageEngine: undefined };
  const probeOf = (seen: OcrCapabilitySnapshot | undefined) => ({ snapshot: async () => seen!, peek: () => seen, warm: () => {} });

  test('image jobs get a new version only while tesseract reads pictures; other media keep theirs', () => {
    let seen: OcrCapabilitySnapshot | undefined = none;
    const suffix = createImageOcrVersionSuffix({
      capability: { snapshot: async () => seen!, peek: () => seen, warm: () => {} },
      platform: 'linux',
    });
    const text = createTextExtractor({ imageOcrVersionSuffix: suffix });
    expect(text.versionFor!('image/png')).toBe(text.version);
    seen = working;
    expect(text.versionFor!('image/png')).toBe(`${text.version}${IMAGE_OCR_VERSION_SUFFIX}`);
    expect(text.versionFor!('image/heic')).toBe(`${text.version}${IMAGE_OCR_VERSION_SUFFIX}`);
    expect(text.versionFor!('application/pdf')).toBe(text.version);
    expect(text.versionFor!(undefined)).toBe(text.version);
    seen = undefined;
    expect(text.versionFor!('image/png')).toBe(text.version);
  });

  test('a Mac that reads with Vision, or an engine pinned to tesseract, never changes a picture\'s version', () => {
    const capability = probeOf(working);
    expect(createImageOcrVersionSuffix({ capability, platform: 'darwin' })()).toBeUndefined();
    expect(createImageOcrVersionSuffix({ capability, platform: 'linux', preference: 'tesseract' })()).toBeUndefined();
    expect(createImageOcrVersionSuffix({ capability, platform: 'linux' })()).toBe(IMAGE_OCR_VERSION_SUFFIX);
  });

  test('without the suffix the lane has no per-type version, exactly as before', () => {
    expect(createTextExtractor().versionFor).toBeUndefined();
  });

  test('the suffixed version is accepted by the job store, and toggling it queues a picture once per version', () => {
    const jobs = new LocalFileExtractionJobStore(':memory:');
    try {
      const text = createTextExtractor({
        imageOcrVersionSuffix: createImageOcrVersionSuffix({ capability: probeOf(working), platform: 'linux' }),
      });
      const ref = {
        corpusId: 'secure_local.fake.files', provider: 'fake', accountScope: 'personal', approvedScopeKey: 'fake.personal:/Pictures',
        providerItemId: 'p1', localItemId: 'personal:p1', name: 'receipt.png', mimeType: PNG,
      };
      const names = jobs.enqueue({ refs: [ref], extractorKind: text.kind, extractorVersion: text.version, policyDecision: 'index_allowed' });
      expect(names.jobsQueued).toBe(1);
      const ocr = jobs.enqueue({ refs: [ref], extractorKind: text.kind, extractorVersion: text.versionFor!(PNG), policyDecision: 'index_allowed' });
      expect(ocr.jobsQueued).toBe(1);
      const again = jobs.enqueue({ refs: [ref], extractorKind: text.kind, extractorVersion: text.versionFor!(PNG), policyDecision: 'index_allowed' });
      expect(again.jobsQueued).toBe(0);
    } finally {
      jobs.close();
    }
  });
});

// --- The real tools ----------------------------------------------------------

const REAL_TOOLS = Boolean(Bun.which('tesseract') && Bun.which('pdftoppm'));

describe('real tesseract and pdftoppm', () => {
  test.skipIf(!REAL_TOOLS)('the probe passes on the real tools, and a picture and a one-page scan read as their known text', async () => {
    const snapshot = await probeOcrCapability();
    expect(snapshot.tesseract).toBe('ok');
    expect(snapshot.imageEngine).toBe('tesseract');
    expect(snapshot.pdfEngine).toBeDefined();

    const capability = createOcrCapabilityProbe();
    const image = await createImageOcr({ engine: { platform: 'linux', capability } })({
      bytes: ocrProbeJpeg(), mimeType: 'image/jpeg', sizeBytes: ocrProbeJpeg().length,
    });
    expect(indexedText(image).toUpperCase()).toContain('OLYMPUS');

    const directory = await mkdtemp(join(tmpdir(), 'olympus-real-ocr-'));
    try {
      const pdfPath = join(directory, 'scan.pdf');
      await writeFile(pdfPath, buildOcrProbePdf());
      const scan = await rasterPdfOcr(
        { inputPath: pdfPath, mimeType: PDF, sizeBytes: 1 },
        { commandRunner: runExtractionCommand, timeoutMs: 60_000, maxBoundedTextChars: 10_000 },
      );
      expect(indexedText(scan).toUpperCase()).toContain('OLYMPUS');
      expect(indexedText(scan)).toContain('--- Page 1 ---');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);

  test.skipIf(!REAL_TOOLS)('the default registry reads the repository\'s real scanned receipt with whichever engine the machine has', async () => {
    const jobs = new LocalFileExtractionJobStore(':memory:');
    const lane = { corpusId: 'secure_local.fake.files', provider: 'fake', accountScope: 'personal', approvedScopeKey: 'fake.personal:/Scans' };
    const written: string[] = [];
    try {
      const runner = createFileExtractionRunner({
        jobs,
        registry: createDefaultExtractorRegistry({ ocr: { capability: createOcrCapabilityProbe() } }),
        corpora: [{
          corpusId: lane.corpusId,
          trustDomain: 'secure_local',
          source: {
            id: 'fake', corpusId: lane.corpusId, provider: lane.provider,
            async listCandidates() {
              return {
                candidates: [{ ...lane, providerItemId: 'scan', localItemId: 'personal:scan', name: 'receipt.pdf', mimeType: PDF }],
                done: true,
              };
            },
            async fetch() { return { bytes: SCANNED_PDF, mimeType: 'application/octet-stream' }; },
          },
          sink: {
            async accept(request) {
              written.push(request.text ?? '');
              return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 };
            },
          },
        }],
      });
      await runner.plan({ ...lane, limit: 10, policyDecision: 'index_allowed' });
      const result = await runner.run({ ...lane, leaseSeconds: 600 });
      expect(result.counts.indexed).toBe(1);
      expect(written.join('\n')).toContain('7731');
    } finally {
      jobs.close();
    }
  }, 180_000);
});
