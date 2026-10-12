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
  createImageOcr,
  createOcrRereadPolicy,
  createPdfOcr,
  type OcrEngineOptions,
} from '../src/workers/file-extraction/extractors/ocr.ts';
import { ocrProbeJpeg } from '../src/workers/file-extraction/extractors/ocr-probe-fixture.ts';
import {
  classifyRasterPdfRejection,
  rasterEdgeFor,
  rasterPdfOcr,
} from '../src/workers/file-extraction/extractors/pdf-raster-ocr.ts';
import { IMAGE_OCR_VERSION_SUFFIX, createTextExtractor } from '../src/workers/file-extraction/extractors/text.ts';
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
  /** Per-page sizes (by page number - 1); pages past the list use `pageSize`. */
  pageSizes?: readonly string[];
  /** pdfinfo fails (the page sizes are unknown). */
  pdfinfoBroken?: boolean;
  /** pdftoppm fails (not past-the-end) when asked for a range starting here or later. */
  renderFailsFromPage?: number;
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
        if (spec.pdfinfoBroken) throw new ExtractionCommandError({ command: 'pdfinfo', exitCode: 1, stdout: '', stderr: 'Syntax Error' });
        const size = (page: number): string => spec.pageSizes?.[page - 1] ?? spec.pageSize ?? '612 x 792 pts (letter)';
        if (request.args.includes('-f')) {
          const last = Math.min(Number(request.args[request.args.indexOf('-l') + 1]), spec.pages ?? 1);
          const lines = Array.from({ length: last }, (_, index) => `Page ${String(index + 1).padStart(4)} size: ${size(index + 1)}\n`);
          return { stdout: `Pages:          ${spec.pages ?? 1}\n${lines.join('')}`, stderr: '' };
        }
        return { stdout: `Pages:          ${spec.pages ?? 1}\nPage size:      ${size(1)}\n`, stderr: '' };
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
        if (spec.renderFailsFromPage !== undefined && first >= spec.renderFailsFromPage && !probing) {
          throw new ExtractionCommandError({ command: 'pdftoppm', exitCode: 3, stdout: '', stderr: 'Syntax Error: something else' });
        }
        if (first > (spec.pages ?? 1)) {
          throw new ExtractionCommandError({
            command: 'pdftoppm', exitCode: 99, stdout: '', stderr: `Wrong page range given: the first page (${first}) can not be after the last page (${spec.pages ?? 1}).`,
          });
        }
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
    const working = counted([{ imageEngine: 'tesseract', pdfEngine: 'pdftoppm_tesseract', tesseract: 'ok' }], clock);
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

  test('a host with pictures but no PDF engine yet is looked at again after one minute, not ten', async () => {
    const clock = { now: 1_000 };
    const partial = counted([{ imageEngine: 'tesseract', tesseract: 'ok' }, { imageEngine: 'tesseract', pdfEngine: 'pdftoppm_tesseract', tesseract: 'ok' }], clock);
    expect((await partial.probe.snapshot()).pdfEngine).toBeUndefined();
    clock.now += OCR_MISSING_TTL_MS + 1;
    expect((await partial.probe.snapshot()).pdfEngine).toBe('pdftoppm_tesseract');
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
    expect(text.status === 'metadata_only' ? text.derivations?.[0]?.warnings : []).toEqual(
      expect.arrayContaining(['ocr_required', 'ocr_unavailable_pdf']),
    );
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
    const output = await lane.extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG }));
    expect(output.status).toBe('metadata_only');
    // Marked as waiting for OCR, so the reread policy can read it later.
    expect(output.status === 'metadata_only' ? output.derivations?.[0]?.warnings : []).toEqual(
      expect.arrayContaining(['ocr_required', 'ocr_unavailable_image']),
    );
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

  const renderArgs = (machine: ReturnType<typeof fakeMachine>) => machine.calls
    .filter((call) => call.command === 'pdftoppm')
    .map((call) => ({
      range: `${call.args[call.args.indexOf('-f') + 1]}-${call.args[call.args.indexOf('-l') + 1]}`,
      edge: Number(call.args[call.args.indexOf('-scale-to') + 1]),
      args: call.args,
      timeoutMs: call.timeoutMs,
    }));

  test('renders grayscale PNG with the renderer scaling the long side: a Letter page at the 200 dpi size, a poster at the cap', async () => {
    const letter = fakeMachine(ALL_TOOLS);
    await rasterPdfOcr(base, options(letter));
    const [first] = renderArgs(letter);
    expect(first!.edge).toBe(Math.ceil((792 * 200) / 72));
    expect(first!.args).toEqual(expect.arrayContaining(['-gray', '-png', '-cropbox']));
    const poster = fakeMachine({ ...ALL_TOOLS, pageSize: '1440 x 2000 pts (poster)' });
    await rasterPdfOcr(base, options(poster));
    expect(renderArgs(poster)[0]!.edge).toBe(3000);
    expect(rasterEdgeFor(undefined, 3000)).toBe(2400);
    expect(rasterEdgeFor(undefined, 1500)).toBe(1500);
  });

  test('the cap is a renderer-level bound on every render: any claimed size, a missing size, and no resolution flag to outgrow it', async () => {
    expect(rasterEdgeFor(10_000, 3000)).toBe(3000);
    expect(rasterEdgeFor(14_400, 3000)).toBe(3000);
    expect(rasterEdgeFor(1_000_000, 3000)).toBe(3000);
    expect(rasterEdgeFor(0.5, 3000)).toBe(2);
    for (const pageSize of ['612 x 792 pts', '14400 x 14400 pts', '1000000 x 3 pts']) {
      const machine = fakeMachine({ ...ALL_TOOLS, pageSize });
      await rasterPdfOcr(base, options(machine));
      for (const render of renderArgs(machine)) {
        expect(render.edge).toBeGreaterThan(0);
        expect(render.edge).toBeLessThanOrEqual(3000);
        expect(render.args).not.toContain('-r');
        // The box pdfinfo measured is the box rendered: a small CropBox inside
        // a huge MediaBox is rendered as its crop, scaled to the target.
        expect(render.args).toContain('-cropbox');
      }
    }
  });

  test('the cap is enforced on every page, not just the first: a larger later page is rendered on its own at a smaller target', async () => {
    const machine = fakeMachine({
      ...ALL_TOOLS,
      pages: 4,
      pageSizes: ['612 x 792 pts', '612 x 792 pts', '5000 x 3000 pts', '612 x 792 pts'],
    });
    const output = await rasterPdfOcr(base, options(machine, { pagesPerRun: 4 }));
    expect(renderArgs(machine).map(({ range, edge }) => ({ range, edge }))).toEqual([
      { range: '1-2', edge: 2200 },
      { range: '3-3', edge: 3000 },
      { range: '4-4', edge: 2200 },
    ]);
    expect(indexedText(output)).toContain('--- Page 4 ---');
  });

  test('when pdfinfo cannot describe the document, the renderer still scales every page to a fixed target under the cap', async () => {
    const machine = fakeMachine({ ...ALL_TOOLS, pdfinfoBroken: true, pages: 2, pageSize: '100000 x 100000 pts' });
    const output = await rasterPdfOcr(base, options(machine, { pdfMaxPixelEdge: 3000 }));
    const renders = renderArgs(machine);
    expect(renders).toHaveLength(1);
    expect(renders[0]!.args).not.toContain('-r');
    expect(renders[0]!.edge).toBe(2400);
    expect(indexedText(output)).toContain('--- Page 1 ---');
    const small = fakeMachine({ ...ALL_TOOLS, pdfinfoBroken: true });
    await rasterPdfOcr(base, options(small, { pdfMaxPixelEdge: 1500 }));
    expect(renderArgs(small)[0]!.edge).toBe(1500);
  });

  test('with no page count, only the renderer\'s past-the-end error ends the document; any other failure is not an end', async () => {
    // Exactly one full range, so the next range starts past the end.
    const ends = fakeMachine({ ...ALL_TOOLS, pdfinfoBroken: true, pages: 8 });
    const whole = await rasterPdfOcr(base, options(ends));
    expect(indexedText(whole)).toContain('--- Page 8 ---');
    expect(renderArgs(ends).map((render) => render.range)).toEqual(['1-8', '9-16']);
    // The same position failing for any other reason is a retryable failure.
    const broken = fakeMachine({ ...ALL_TOOLS, pdfinfoBroken: true, pages: 20, renderFailsFromPage: 9 });
    await expect(rasterPdfOcr(base, options(broken))).rejects.toBeInstanceOf(ExtractionCommandError);
  });

  test('each render group gets what is left of the whole-file deadline, and a spent deadline stops further groups', async () => {
    const machine = fakeMachine({
      ...ALL_TOOLS,
      pages: 3,
      pageSizes: ['612 x 792 pts', '5000 x 3000 pts', '612 x 792 pts'],
    });
    let clock = 0;
    // Each render takes 500 ms of the 1,000 ms the file is allowed.
    const spendingRunner: ExtractionCommandRunner = async (request) => {
      if (request.command === 'pdftoppm') clock += 500;
      return machine.runner(request);
    };
    await expect(rasterPdfOcr(base, options(machine, {
      commandRunner: spendingRunner, pagesPerRun: 3, fileDeadlineMs: 1_000, now: () => clock,
    }))).rejects.toThrow();
    const renders = renderArgs(machine);
    // Three groups were due; the third found no time left and was not started.
    expect(renders.map((render) => render.range)).toEqual(['1-1', '2-2']);
    expect(renders.map((render) => render.timeoutMs)).toEqual([1_000, 500]);
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

  describe('an incomplete read never settles as an ordinary empty scan', () => {
    const blankPages = (machine: ReturnType<typeof fakeMachine>): ExtractionCommandRunner => async (request) => {
      const result = await machine.runner(request);
      return request.command === 'tesseract' ? { ...result, stdout: ' \n' } : result;
    };
    const warningsOf = (output: ExtractorOutput): readonly string[] =>
      output.status === 'metadata_only' ? output.derivations?.[0]?.warnings ?? [] : [];

    test('blank pages cut off by the page cap keep the page-cap warning on the metadata-only output', async () => {
      const machine = fakeMachine({ ...ALL_TOOLS, pages: 5 });
      const output = await rasterPdfOcr(base, options(machine, { commandRunner: blankPages(machine), maxPages: 2, pagesPerRun: 2 }));
      expect(output.status).toBe('metadata_only');
      expect(warningsOf(output)).toEqual(expect.arrayContaining(['ocr_empty', 'ocr_pdf_pages_capped']));
    });

    test('blank pages cut off by the deadline keep the time-cap warning', async () => {
      const machine = fakeMachine({ ...ALL_TOOLS, pages: 6 });
      let clock = 0;
      const output = await rasterPdfOcr(base, options(machine, {
        commandRunner: blankPages(machine),
        pagesPerRun: 2,
        fileDeadlineMs: 1_000,
        now: () => {
          clock += 300;
          return clock;
        },
      }));
      expect(output.status).toBe('metadata_only');
      expect(warningsOf(output)).toEqual(expect.arrayContaining(['ocr_empty', 'ocr_pdf_time_capped']));
    });

    test('a page tesseract failed on, with every other page blank, is a retryable failure, not an empty scan', async () => {
      const machine = fakeMachine({ ...ALL_TOOLS, pages: 3, failingPages: [2] });
      await expect(rasterPdfOcr(base, options(machine, { commandRunner: blankPages(machine) })))
        .rejects.toBeInstanceOf(ExtractionCommandError);
    });

    test('a deadline that passes before any page was looked at is a retryable failure, not an empty scan', async () => {
      const machine = fakeMachine(ALL_TOOLS);
      await expect(rasterPdfOcr(base, options(machine, { fileDeadlineMs: 0 }))).rejects.toThrow();
    });
  });
});

// --- Recovery ----------------------------------------------------------------

describe('rereading what OCR could not read', () => {
  const LANE = { corpusId: 'secure_local.fake.files', provider: 'fake', accountScope: 'personal', approvedScopeKey: 'fake.personal:/Scans' };
  type Kind = 'pdf' | 'image';
  type Setup = Kind | 'both';
  const KINDS: readonly Kind[] = ['pdf', 'image'];
  const READ_TEXT: Record<Kind, string> = { pdf: 'text of page 1', image: 'text in the picture' };

  /**
   * A lane over one scanned PDF or one picture, a text extractor wired exactly
   * as the default registry wires it, and a clock the probe cache obeys.
   */
  function setup(spec: MachineSpec, kind: Setup = 'pdf') {
    const machine = fakeMachine(spec);
    const clock = { now: 1_000 };
    const capability = createOcrCapabilityProbe({ commandRunner: machine.runner, now: () => clock.now });
    const engine = { ...LINUX, capability };
    const text = createTextExtractor({
      pdfOcr: createPdfOcr({ commandRunner: machine.runner, engine }),
      imageOcr: createImageOcr({ commandRunner: machine.runner, engine }),
      ocrReread: createOcrRereadPolicy({ capability }),
    });
    const jobs = new LocalFileExtractionJobStore(':memory:');
    const written: string[] = [];
    const mimeType = kind === 'image' ? PNG : PDF;
    const runner = createFileExtractionRunner({
      jobs,
      registry: buildExtractorRegistry([text]),
      corpora: [{
        corpusId: LANE.corpusId,
        trustDomain: 'secure_local',
        source: {
          id: 'fake', corpusId: LANE.corpusId, provider: LANE.provider,
          async listCandidates() { return { candidates: [], done: true }; },
          async fetch(ref) {
            const picture = ref.providerItemId === 'pic-1' || kind === 'image';
            return { bytes: picture ? PNG_BYTES : SCANNED_PDF, mimeType: picture ? PNG : PDF };
          },
        },
        sink: {
          async accept(request) {
            written.push(request.text ?? '');
            return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 };
          },
        },
      }],
    });
    const enqueue = (providerItemId: string, name: string, itemMime: string) => jobs.enqueue({
      refs: [{ ...LANE, providerItemId, localItemId: `personal:${providerItemId}`, name, mimeType: itemMime }],
      extractorKind: text.kind,
      extractorVersion: text.versionFor?.(itemMime) ?? text.version,
      policyDecision: 'index_allowed',
    });
    if (kind !== 'image') enqueue('item-1', 'scan.pdf', PDF);
    if (kind !== 'pdf') enqueue('pic-1', 'pic.png', PNG);
    return {
      jobs, runner, machine, capability, clock, written, text,
      run: () => runner.run({ ...LANE }),
      /** Time passes past the missing-engine TTL and the probe is looked at again. */
      async afterInstallProbe() {
        clock.now += OCR_MISSING_TTL_MS + 1;
        capability.warm();
        await capability.snapshot();
      },
    };
  }

  const NOTHING_INSTALLED: MachineSpec = { tesseract: 'missing', pdftoppm: 'missing', ocrmypdf: 'missing' };

  for (const kind of KINDS) {
    test(`${kind}: missing -> installed -> reread exactly once, unchanged source, then never again`, async () => {
      const lane = setup(NOTHING_INSTALLED, kind);
      try {
        const first = await lane.run();
        expect(first.counts.metadata_only).toBe(1);
        expect(lane.written).toEqual([]);

        // Still no OCR: asked, nothing requeued, nothing read.
        const waiting = await lane.run();
        expect(waiting.rereadRequeued).toBeUndefined();
        expect(waiting.leasedJobs).toBe(0);

        // The owner installs tesseract and poppler. The cache goes stale, the
        // probe runs, the next run requeues the item once and reads it.
        Object.assign(lane.machine.spec, { tesseract: 'ok', pdftoppm: 'ok' });
        await lane.afterInstallProbe();
        const reread = await lane.run();
        expect(reread.rereadRequeued).toBe(1);
        expect(reread.counts.indexed).toBe(1);
        expect(lane.written.join('\n')).toContain(READ_TEXT[kind]);

        const again = await lane.run();
        expect(again.rereadRequeued).toBeUndefined();
        expect(again.leasedJobs).toBe(0);
      } finally {
        lane.jobs.close();
      }
    });
  }

  test('a picture keeps one stable job identity: no per-capability version, so a flip cannot duplicate or strand it', async () => {
    const lane = setup(NOTHING_INSTALLED, 'image');
    try {
      expect(lane.text.versionFor).toBeUndefined();
      await lane.run();
      Object.assign(lane.machine.spec, { tesseract: 'ok', pdftoppm: 'ok' });
      await lane.afterInstallProbe();
      Object.assign(lane.machine.spec, { tesseract: 'missing' });
      await lane.run();
      Object.assign(lane.machine.spec, { tesseract: 'ok' });
      await lane.afterInstallProbe();
      await lane.run();
      // One job, ever, however the engine came and went, and it was read.
      expect(lane.jobs.counts(LANE).reduce((sum, row) => sum + row.jobs, 0)).toBe(1);
      expect(lane.written.join('\n')).toContain('text in the picture');
    } finally {
      lane.jobs.close();
    }
  });

  test('items settled without OCR carry the OCR-unavailable marker next to ocr_required', async () => {
    const machine = fakeMachine(NOTHING_INSTALLED);
    const engine = { ...LINUX, capability: createOcrCapabilityProbe({ commandRunner: machine.runner }) };
    const text = createTextExtractor({
      pdfOcr: createPdfOcr({ commandRunner: machine.runner, engine }),
      imageOcr: createImageOcr({ commandRunner: machine.runner, engine }),
    });
    for (const [bytes, mimeType, marker] of [
      [SCANNED_PDF, PDF, 'ocr_unavailable_pdf'],
      [PNG_BYTES, PNG, 'ocr_unavailable_image'],
    ] as const) {
      const output = await text.extract(extractorInput({ bytes, mimeType }));
      expect(output.status).toBe('metadata_only');
      expect(output.status === 'metadata_only' ? output.derivations?.[0]?.warnings : []).toEqual(
        expect.arrayContaining(['ocr_required', marker]),
      );
    }
    // A lane with no OCR reader at all settles as it always did.
    expect(await createTextExtractor().extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG })))
      .toEqual({ status: 'metadata_only' });
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
    const lane = setup(NOTHING_INSTALLED);
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

  for (const kind of KINDS) {
    test(`${kind}: a reader that vanishes between its probe and the read forgets the cached answer and keeps the item recoverable`, async () => {
      const lane = setup(NOTHING_INSTALLED, kind);
      try {
        await lane.run();
        Object.assign(lane.machine.spec, { tesseract: 'ok', pdftoppm: 'ok' });
        await lane.afterInstallProbe();
        expect(lane.capability.peekFresh()?.imageEngine).toBe('tesseract');

        // The reader is uninstalled while the cache still vouches for it.
        Object.assign(lane.machine.spec, { tesseract: 'missing', pdftoppm: 'missing' });
        const attempt = await lane.run();
        expect(attempt.rereadRequeued).toBe(1);
        expect(attempt.counts.metadata_only).toBe(1);
        // The missing command at run time invalidated the stale "ready".
        expect(lane.capability.peekFresh()).toBeUndefined();

        // Asked again, the probe now says unavailable: no requeue, no loop.
        await lane.capability.snapshot();
        for (let again = 0; again < 3; again += 1) {
          const result = await lane.run();
          expect(result.rereadRequeued).toBeUndefined();
          expect(result.leasedJobs).toBe(0);
        }

        // The recovery was never spent: reinstalling reads the item.
        Object.assign(lane.machine.spec, { tesseract: 'ok', pdftoppm: 'ok' });
        await lane.afterInstallProbe();
        const recovered = await lane.run();
        expect(recovered.rereadRequeued).toBe(1);
        expect(recovered.counts.indexed).toBe(1);
        expect(lane.written.join('\n')).toContain(READ_TEXT[kind]);
      } finally {
        lane.jobs.close();
      }
    });
  }

  test('an expired "ready" does not spend the recovery: the decision waits for a fresh probe', async () => {
    const lane = setup(NOTHING_INSTALLED);
    try {
      await lane.run();
      Object.assign(lane.machine.spec, { tesseract: 'ok', pdftoppm: 'ok' });
      await lane.afterInstallProbe();
      expect(lane.capability.peek()?.pdfEngine).toBe('pdftoppm_tesseract');

      // Ten minutes pass and the tools are gone, but the old answer is still cached.
      Object.assign(lane.machine.spec, { tesseract: 'missing', pdftoppm: 'missing' });
      lane.clock.now += OCR_READY_TTL_MS + 1;
      expect(lane.capability.peek()?.pdfEngine).toBe('pdftoppm_tesseract');
      expect(lane.capability.peekFresh()).toBeUndefined();
      const stale = await lane.run();
      // Not requeued on the strength of the expired answer.
      expect(stale.rereadRequeued).toBeUndefined();
      expect(stale.leasedJobs).toBe(0);
      await lane.capability.snapshot();
      expect((await lane.run()).rereadRequeued).toBeUndefined();

      // The item was never read and its one recovery is intact.
      Object.assign(lane.machine.spec, { tesseract: 'ok', pdftoppm: 'ok' });
      await lane.afterInstallProbe();
      const recovered = await lane.run();
      expect(recovered.rereadRequeued).toBe(1);
      expect(recovered.counts.indexed).toBe(1);
    } finally {
      lane.jobs.close();
    }
  });

  test('eligibility is per kind: tesseract alone reads the waiting picture, the PDF waits for a PDF engine', async () => {
    const lane = setup(NOTHING_INSTALLED, 'both');
    try {
      expect((await lane.run()).counts.metadata_only).toBe(2);
      // tesseract is installed; poppler and ocrmypdf are not.
      Object.assign(lane.machine.spec, { tesseract: 'ok' });
      await lane.afterInstallProbe();
      expect(lane.capability.peekFresh()).toMatchObject({ imageEngine: 'tesseract', pdfEngine: undefined });
      const picture = await lane.run();
      expect(picture.rereadRequeued).toBe(1);
      expect(picture.counts.indexed).toBe(1);
      const stored = (status: string) => lane.jobs.counts(LANE).filter((row) => row.status === status).reduce((sum, row) => sum + row.jobs, 0);
      expect(stored('indexed')).toBe(1);
      expect(stored('metadata_only')).toBe(1);
      expect(lane.written.join('\n')).toContain('text in the picture');
      // And again: the PDF is still waiting, unspent, and nothing churns.
      for (let again = 0; again < 3; again += 1) expect((await lane.run()).rereadRequeued).toBeUndefined();
      // poppler arrives: now the PDF is read, once.
      Object.assign(lane.machine.spec, { pdftoppm: 'ok' });
      await lane.afterInstallProbe();
      const pdf = await lane.run();
      expect(pdf.rereadRequeued).toBe(1);
      expect(pdf.counts.indexed).toBe(1);
      expect(stored('indexed')).toBe(2);
      expect(lane.written.join('\n')).toContain('text of page 1');
    } finally {
      lane.jobs.close();
    }
  });

  test('readyWarnings names the markers whose reader works, per engine', () => {
    const base: OcrCapabilitySnapshot = {
      tesseract: 'missing', pdftoppm: 'missing', ocrmypdf: 'missing', pdfEngine: undefined, imageEngine: undefined, checkedAt: 1,
    };
    const stub = (seen: OcrCapabilitySnapshot) => ({
      snapshot: async () => seen, peek: () => seen, peekFresh: () => seen, invalidate: () => {}, warm: () => {},
    });
    const ready = (seen: OcrCapabilitySnapshot, preference?: 'tesseract') => createOcrRereadPolicy({
      capability: stub(seen), ...(preference ? { preference } : {}),
    }).readyWarnings!();
    expect(ready(base)).toEqual([]);
    expect(ready({ ...base, imageEngine: 'tesseract' })).toEqual(['ocr_unavailable_image']);
    expect(ready({ ...base, imageEngine: 'tesseract', pdfEngine: 'pdftoppm_tesseract' }))
      .toEqual(['ocr_required', 'ocr_unavailable_pdf', 'ocr_unavailable_image']);
    // Pinned: ocrmypdf runs directly, and pictures are not read in the text lane.
    expect(ready({ ...base, ocrmypdf: 'ok', imageEngine: 'tesseract', pdfEngine: 'ocrmypdf' }, 'tesseract'))
      .toEqual(['ocr_required', 'ocr_unavailable_pdf']);
    expect(createOcrRereadPolicy({ capability: stub({ ...base, imageEngine: 'tesseract' }) }).prepare()).toBe('ready');
  });

  test('pictures settled names-only before OCR existed (no marker) are queued once more under a fixed image version', () => {
    const jobs = new LocalFileExtractionJobStore(':memory:');
    try {
      const none = fakeMachine(NOTHING_INSTALLED);
      const textKind = createTextExtractor().kind;
      const registryFor = (ocr: Record<string, unknown>) => createDefaultExtractorRegistry({
        ocr: { capability: createOcrCapabilityProbe({ commandRunner: none.runner }), ...ocr },
      }).list().find((extractor) => extractor.kind === textKind)!;
      const linux = registryFor({ platform: 'linux' });
      // Fixed: the same whatever is installed, and only images move.
      expect(linux.versionFor!(PNG)).toBe(`${linux.version}${IMAGE_OCR_VERSION_SUFFIX}`);
      expect(linux.versionFor!(PDF)).toBe(linux.version);
      const ref = {
        corpusId: 'secure_local.fake.files', provider: 'fake', accountScope: 'personal', approvedScopeKey: 'fake.personal:/Pictures',
        providerItemId: 'old', localItemId: 'personal:old', name: 'old.png', mimeType: PNG,
      };
      // The job main created, with the plain version, is settled and unmarked.
      expect(jobs.enqueue({ refs: [ref], extractorKind: linux.kind, extractorVersion: linux.version, policyDecision: 'index_allowed' }).jobsQueued).toBe(1);
      expect(jobs.enqueue({ refs: [ref], extractorKind: linux.kind, extractorVersion: linux.versionFor!(PNG), policyDecision: 'index_allowed' }).jobsQueued).toBe(1);
      expect(jobs.enqueue({ refs: [ref], extractorKind: linux.kind, extractorVersion: linux.versionFor!(PNG), policyDecision: 'index_allowed' }).jobsQueued).toBe(0);
      // Nothing is read again where Vision (or a preparation) already reads pictures, or when pinned.
      expect(registryFor({ platform: 'darwin' }).versionFor).toBeUndefined();
      expect(registryFor({ platform: 'darwin', engine: 'auto' }).versionFor).toBeUndefined();
      expect(registryFor({ platform: 'linux', engine: 'tesseract' }).versionFor).toBeUndefined();
    } finally {
      jobs.close();
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

  test('the reread policy answers from a FRESH cache: pending, unavailable, ready; pinned to tesseract it needs ocrmypdf', () => {
    const snapshot = (over: Partial<OcrCapabilitySnapshot>): OcrCapabilitySnapshot => ({
      tesseract: 'missing', pdftoppm: 'missing', ocrmypdf: 'missing', pdfEngine: undefined, imageEngine: undefined, checkedAt: 1, ...over,
    });
    const stub = (seen: OcrCapabilitySnapshot | undefined, fresh = true) => ({
      snapshot: async () => seen!,
      peek: () => seen,
      peekFresh: () => (fresh ? seen : undefined),
      invalidate: () => {},
      warm: () => {},
    });
    const policyFor = (seen: OcrCapabilitySnapshot | undefined, preference?: 'tesseract', fresh = true) => createOcrRereadPolicy({
      capability: stub(seen, fresh),
      ...(preference ? { preference } : {}),
    });
    expect(policyFor(undefined).prepare()).toBe('pending');
    expect(policyFor(snapshot({})).prepare()).toBe('unavailable');
    // Pictures alone are enough to start: their reader works (PDFs wait; see readyWarnings).
    expect(policyFor(snapshot({ imageEngine: 'tesseract' })).prepare()).toBe('ready');
    expect(policyFor(snapshot({ pdfEngine: 'pdftoppm_tesseract' })).prepare()).toBe('ready');
    // An expired answer, however good it was, is not a decision.
    expect(policyFor(snapshot({ pdfEngine: 'pdftoppm_tesseract' }), undefined, false).prepare()).toBe('pending');
    expect(policyFor(snapshot({ pdfEngine: 'pdftoppm_tesseract' }), 'tesseract').prepare()).toBe('unavailable');
    expect(policyFor(snapshot({ pdfEngine: 'ocrmypdf', ocrmypdf: 'ok' }), 'tesseract').prepare()).toBe('ready');
    const policy = policyFor(snapshot({}));
    expect(policy.unreadTerminalErrorKinds).toEqual([]);
    expect(policy.notReadyWarnings).toEqual(['ocr_unavailable_pdf', 'ocr_unavailable_image']);
    expect(policy.unreadWarnings).toEqual(['ocr_required', 'ocr_unavailable_pdf', 'ocr_unavailable_image']);
  });

  test('a stale answer starts a background probe when the policy is asked', async () => {
    const clock = { now: 1_000 };
    let probes = 0;
    const capability = createOcrCapabilityProbe({
      now: () => clock.now,
      probe: async () => {
        probes += 1;
        return {
          tesseract: 'ok', pdftoppm: 'ok', ocrmypdf: 'missing', pdfEngine: 'pdftoppm_tesseract', imageEngine: 'tesseract', checkedAt: clock.now,
        };
      },
    });
    const policy = createOcrRereadPolicy({ capability });
    expect(policy.prepare()).toBe('pending');
    await capability.snapshot();
    expect(policy.prepare()).toBe('ready');
    clock.now += OCR_READY_TTL_MS + 1;
    expect(policy.prepare()).toBe('pending');
    await capability.snapshot();
    expect(probes).toBe(2);
    expect(policy.prepare()).toBe('ready');
  });

  test('invalidating the cache forgets the answer, and a probe that was already running cannot put it back', async () => {
    const clock = { now: 1 };
    let release: (() => void) | undefined;
    let probes = 0;
    const capability = createOcrCapabilityProbe({
      now: () => clock.now,
      probe: async () => {
        probes += 1;
        if (probes === 1) await new Promise<void>((resolve) => { release = resolve; });
        return {
          tesseract: 'ok', pdftoppm: 'ok', ocrmypdf: 'missing', pdfEngine: 'pdftoppm_tesseract', imageEngine: 'tesseract', checkedAt: clock.now,
        };
      },
    });
    const early = capability.snapshot();
    capability.invalidate();
    release?.();
    await early;
    expect(capability.peekFresh()).toBeUndefined();
    await capability.snapshot();
    expect(probes).toBe(2);
    expect(capability.peekFresh()?.imageEngine).toBe('tesseract');
    capability.invalidate();
    expect(capability.peek()).toBeUndefined();
  });

  test('engine pinned to tesseract: the registry offers no picture reader, so pictures are not marked or reread', async () => {
    const machine = fakeMachine(NOTHING_INSTALLED);
    const textKind = createTextExtractor().kind;
    const pinned = createDefaultExtractorRegistry({
      ocr: { engine: 'tesseract', platform: 'linux', capability: createOcrCapabilityProbe({ commandRunner: machine.runner }) },
    });
    const pinnedText = pinned.list().find((extractor) => extractor.kind === textKind)!;
    expect(await pinnedText.extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG }))).toEqual({ status: 'metadata_only' });
    // In auto mode on the same host the picture is marked while OCR is missing.
    const auto = createDefaultExtractorRegistry({
      ocr: { platform: 'linux', capability: createOcrCapabilityProbe({ commandRunner: machine.runner }) },
    });
    const autoText = auto.list().find((extractor) => extractor.kind === textKind)!;
    const marked = await autoText.extract(extractorInput({ bytes: PNG_BYTES, mimeType: PNG }));
    expect(marked.status === 'metadata_only' ? marked.derivations?.[0]?.warnings : []).toContain('ocr_unavailable_image');
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
