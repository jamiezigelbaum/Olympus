/**
 * Which photos a machine reads, decided per format (docs/design/photo-embeddings.md):
 * the capability probe, the ingestion policy, the extractor, the extraction
 * candidates and the status messages all answer from the same per-format
 * readiness. Every test here is pure logic over fakes and fixtures, so none
 * of them skips on any machine; the real tools are exercised by
 * still-image-preparers-contract.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { stillImagePreparationAvailable } from '../src/core/media-cache.ts';
import {
  linuxFamilyFromOsRelease,
  photoSearchInstallCommand,
  photoSearchStatus,
} from '../src/core/photo-search-status.ts';
import {
  defaultDropboxIngestionPolicy,
  loadDropboxIngestionPolicy,
  resolveStillImageFormats,
  unreadStillImageMatch,
} from '../src/core/source-ingestion-policy.ts';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  STILL_IMAGE_FORMATS,
  imageDeclaredDimensions,
  stillImageFormatForExtension,
  type StillImageFormat,
} from '../src/core/still-image-formats.ts';
import { STILL_IMAGE_PROBE_FIXTURES, STILL_IMAGE_PROBE_SIZES } from '../src/core/still-image-probe-fixtures.ts';
import {
  probeStillImageReadiness,
  readyStillImageFormats,
  setStillImageReadiness,
  stillImageReadinessOf,
  type SyncRun,
} from '../src/core/still-image-readiness.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { dropboxCanonicalIngestionMatcher } from '../src/workers/dropbox-files/connector-store.ts';
import { defaultDeferredContentReadinessSql } from '../src/workers/dropbox-files/extraction-readiness.ts';
import {
  ExtractionCommandError,
  ExtractionCommandTimeoutError,
  type ExtractionCommandRunner,
} from '../src/workers/file-extraction/extractors/command-runner.ts';
import {
  IMAGE_PREPARE_ERROR_CACHE_WRITE,
  IMAGE_PREPARE_ERROR_FAILED,
  IMAGE_PREPARE_ERROR_TIMEOUT,
  createImagePreparation,
} from '../src/workers/file-extraction/extractors/image-prepare.ts';
import {
  VIPSTHUMBNAIL_COMMAND,
  createSipsPreparer,
  createVipsPreparer,
  type StillImagePreparer,
} from '../src/workers/file-extraction/extractors/image-preparers.ts';
import { jpegMetadataSegments } from '../src/workers/file-extraction/extractors/jpeg-metadata.ts';
import { IMAGE_MEDIA_VERSION_SUFFIX, createTextExtractor } from '../src/workers/file-extraction/extractors/text.ts';
import { createDefaultExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import { createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
import type { ExtractionItemRef } from '../src/workers/file-extraction/types.ts';
import { imageFixture, pngClaiming, quadrantJpegWithMetadata, stubJpeg } from './helpers/image-fixtures.ts';

const temporaryDirs: string[] = [];
function temporaryDir(prefix = 'olympus-readiness-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}
afterEach(() => {
  setStillImageReadiness(undefined);
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ALL: readonly StillImageFormat[] = STILL_IMAGE_FORMATS;
const withoutHeic = ALL.filter((format) => format !== 'heic');

// --- The probe ----------------------------------------------------------------

/** The path the tool was told to write: after `--out` for sips, `-o` (before its options) for vips. */
function outputPathOf(args: string[]): string {
  const sips = args.indexOf('--out');
  const raw = sips >= 0 ? args[sips + 1]! : args[args.indexOf('-o') + 1]!;
  return raw.includes('[') ? raw.slice(0, raw.indexOf('[')) : raw;
}

/** The picture the tool was told to read: first for vips, before `--out` for sips. */
function inputPathOf(args: string[]): string {
  const sips = args.indexOf('--out');
  return sips >= 0 ? args[sips - 1]! : args[0]!;
}

/** A tool that decodes exactly `decodes`, writing a JPEG of the fixtures' shape. */
function fakeTool(decodes: Iterable<StillImageFormat>, calls: string[][] = []): SyncRun {
  const can = new Set(decodes);
  return (command, args) => {
    calls.push([command, ...args]);
    const format = stillImageFormatForExtension(extname(inputPathOf(args)));
    if (!format || !can.has(format)) return { ok: false };
    const size = STILL_IMAGE_PROBE_SIZES[format];
    writeFileSync(outputPathOf(args), stubJpeg(size.width, size.height));
    return { ok: true };
  };
}

const VIPS_TOOL = { kind: 'vips', path: '/fake/bin/vipsthumbnail' } as const;
const NOW = () => new Date('2026-10-12T00:00:00.000Z');

describe('the per-format probe', () => {
  test('every format a tool decodes is ready, and each was asked about with a picture of its own', () => {
    const calls: string[][] = [];
    const readiness = probeStillImageReadiness({ tool: VIPS_TOOL, run: fakeTool(ALL, calls), vision: 'ready', now: NOW });
    expect(readiness).toMatchObject({ tool: 'vips', toolPath: VIPS_TOOL.path, vision: 'ready', probedAt: '2026-10-12T00:00:00.000Z' });
    expect([...readyStillImageFormats(readiness)]).toEqual([...ALL]);
    expect(calls.map((call) => extname(inputPathOf(call.slice(1)))).sort()).toEqual(
      ['.bmp', '.gif', '.heic', '.jpeg', '.png', '.tif', '.webp'],
    );
    expect(calls.every((call) => call[0] === VIPS_TOOL.path)).toBe(true);
  });

  test('a format the tool cannot decode is not ready, and the others are unaffected', () => {
    const readiness = probeStillImageReadiness({ tool: VIPS_TOOL, run: fakeTool(withoutHeic), vision: 'ready' });
    expect(readiness.formats.heic).toEqual({ ready: false, reason: 'cannot_decode' });
    for (const format of withoutHeic) expect(readiness.formats[format]).toEqual({ ready: true });
    expect([...readyStillImageFormats(readiness)]).toEqual(withoutHeic);
  });

  test('a tool that exits cleanly but writes something else, or nothing, has not decoded the format', () => {
    const wrongShape: SyncRun = (_command, args) => {
      writeFileSync(outputPathOf(args), stubJpeg(24, 24));
      return { ok: true };
    };
    const notJpeg: SyncRun = (_command, args) => {
      writeFileSync(outputPathOf(args), Buffer.from('not a picture at all'));
      return { ok: true };
    };
    const nothing: SyncRun = () => ({ ok: true });
    const throws: SyncRun = () => {
      throw new Error('spawn failed');
    };
    for (const run of [wrongShape, notJpeg, nothing, throws]) {
      const readiness = probeStillImageReadiness({ tool: VIPS_TOOL, run, vision: 'ready' });
      expect(readyStillImageFormats(readiness).size).toBe(0);
      expect(readiness.formats.jpeg.reason).toBe('cannot_decode');
    }
  });

  test('with no tool at all nothing is ready, no command runs, and the reason is the missing tool', () => {
    let ran = 0;
    const readiness = probeStillImageReadiness({ tool: null, run: () => { ran += 1; return { ok: true }; }, vision: 'ready' });
    expect(ran).toBe(0);
    expect(readiness.tool).toBe('none');
    for (const format of ALL) expect(readiness.formats[format]).toEqual({ ready: false, reason: 'no_tool' });
  });

  test('a recorded failure of the image encoder makes every decoded format not ready, and says why', () => {
    const readiness = probeStillImageReadiness({ tool: VIPS_TOOL, run: fakeTool(withoutHeic), vision: 'unavailable' });
    expect(readyStillImageFormats(readiness).size).toBe(0);
    expect(readiness.formats.jpeg).toEqual({ ready: false, reason: 'vision_unavailable' });
    expect(readiness.formats.heic).toEqual({ ready: false, reason: 'cannot_decode' });
    expect(readiness.vision).toBe('unavailable');
  });

  test('an encoder that has not reported yet does not block photos', () => {
    expect(readyStillImageFormats(probeStillImageReadiness({ tool: VIPS_TOOL, run: fakeTool(ALL), vision: 'unknown' })).size).toBe(ALL.length);
  });

  test('the shipped fixtures are real pictures of the format they stand for', () => {
    expect(Object.keys(STILL_IMAGE_PROBE_FIXTURES).sort()).toEqual([...ALL].sort());
    const signatures: Record<StillImageFormat, (bytes: Buffer) => boolean> = {
      jpeg: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8,
      png: (bytes) => bytes.subarray(1, 4).toString('latin1') === 'PNG',
      gif: (bytes) => bytes.subarray(0, 3).toString('latin1') === 'GIF',
      bmp: (bytes) => bytes.subarray(0, 2).toString('latin1') === 'BM',
      tiff: (bytes) => ['II', 'MM'].includes(bytes.subarray(0, 2).toString('latin1')),
      webp: (bytes) => bytes.subarray(8, 12).toString('latin1') === 'WEBP',
      heic: (bytes) => bytes.subarray(4, 8).toString('latin1') === 'ftyp',
    };
    for (const format of ALL) {
      const bytes = Buffer.from(STILL_IMAGE_PROBE_FIXTURES[format], 'base64');
      expect(signatures[format](bytes)).toBe(true);
      // Each is the size the probe expects back; a HEIC smaller than 64 x 64
      // is refused by libheif's security limit even where real photos decode.
      expect(imageDeclaredDimensions(new Uint8Array(bytes))).toEqual(STILL_IMAGE_PROBE_SIZES[format]);
    }
    expect(STILL_IMAGE_PROBE_SIZES.heic.width).toBeGreaterThanOrEqual(64);
    expect(STILL_IMAGE_PROBE_SIZES.heic.height).toBeGreaterThanOrEqual(64);
  });

  test('a plain yes or no still answers, and the old boolean follows the per-format answer', () => {
    setStillImageReadiness(stillImageReadinessOf(false));
    expect(stillImagePreparationAvailable()).toBe(false);
    setStillImageReadiness(stillImageReadinessOf(['png']));
    expect(stillImagePreparationAvailable()).toBe(true);
    setStillImageReadiness(stillImageReadinessOf(true));
    expect([...readyStillImageFormats()]).toEqual([...ALL]);
    expect([...resolveStillImageFormats(true)]).toEqual([...ALL]);
    expect([...resolveStillImageFormats(false)]).toEqual([]);
    expect([...resolveStillImageFormats(['heic'])]).toEqual(['heic']);
  });
});

// --- Admission: the ingestion policy and the readiness ladder -----------------

const NO_EXCLUSIONS = () => ({ [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(temporaryDir(), 'missing-exclusions.json') });

describe('formats the host cannot read stay names-only', () => {
  test('only the unread formats are metadata-only; the others are admitted', () => {
    const policy = defaultDropboxIngestionPolicy({ stillImagesRead: withoutHeic });
    const media = policy.rules.find((rule) => rule.reason === 'media_default_metadata_only')!;
    expect(media.match.mime_type_prefixes).toContain('video/');
    expect(media.match.mime_type_prefixes).toContain('image/heic');
    expect(media.match.mime_type_prefixes).not.toContain('image/');
    expect(media.match.mime_type_prefixes).not.toContain('image/jpeg');
    expect(media.match.extensions).toEqual(expect.arrayContaining(['heic', 'heif']));
    for (const extension of ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'bmp']) {
      expect(media.match.extensions).not.toContain(extension);
    }
    const matcher = dropboxCanonicalIngestionMatcher(policy, NO_EXCLUSIONS());
    expect(matcher.evaluateItem({ path: '/Photos/a.jpg', mimeType: 'image/jpeg' }).disposition).toBe('admit');
    expect(matcher.evaluateItem({ path: '/Photos/a.webp', mimeType: 'image/webp' }).disposition).toBe('admit');
    expect(matcher.evaluateItem({ path: '/Photos/a.heic', mimeType: 'image/heic' }).disposition).toBe('metadata_only');
    expect(matcher.evaluateItem({ path: '/Photos/b.HEIF', mimeType: 'application/octet-stream' }).disposition).toBe('metadata_only');
    expect(matcher.evaluateItem({ path: '/Videos/a.mov', mimeType: 'video/quicktime' }).disposition).toBe('metadata_only');
  });

  test('every format ready leaves only video; none ready defers every image, as before', () => {
    const all = defaultDropboxIngestionPolicy({ stillImagesRead: ALL });
    expect(all.rules.find((rule) => rule.reason === 'media_default_metadata_only')!.match.mime_type_prefixes).toEqual(['video/']);
    expect(unreadStillImageMatch(true)).toEqual({ mimePrefixes: [], extensions: [] });
    const none = defaultDropboxIngestionPolicy({ stillImagesRead: false });
    expect(none.rules.find((rule) => rule.reason === 'media_default_metadata_only')!.match.mime_type_prefixes).toEqual(['image/', 'video/']);
  });

  test('the machine\'s own answer is used when the caller gives none', () => {
    setStillImageReadiness(stillImageReadinessOf(withoutHeic));
    const policy = defaultDropboxIngestionPolicy();
    expect(policy.rules[0]!.match.mime_type_prefixes).toContain('image/heic');
    expect(policy.rules[0]!.match.mime_type_prefixes).not.toContain('image/jpeg');
    expect(defaultDeferredContentReadinessSql()).toContain("'image/heic%'");
  });

  test('the readiness ladder agrees with the policy format by format', () => {
    const sql = defaultDeferredContentReadinessSql(withoutHeic);
    expect(sql).toContain("mime_type_lower LIKE 'image/heic%'");
    expect(sql).toContain("path_lower LIKE '%.heic'");
    expect(sql).toContain("path_lower LIKE '%.heif'");
    expect(sql).not.toContain("'image/%'");
    expect(sql).not.toContain("'image/jpeg%'");
    expect(sql).not.toContain("'%.jpg'");
    expect(sql).not.toContain("'%.png'");
    expect(sql).toContain("'video/%'");
    expect(defaultDeferredContentReadinessSql(false)).toContain("'image/%'");
    expect(defaultDeferredContentReadinessSql(true)).not.toContain('image/');
  });

  test('an owner\'s exclusions still win over a ready format, and a ready format never loosens one', () => {
    const dir = temporaryDir();
    const exclusionsPath = join(dir, 'exclusions.json');
    writeFileSync(exclusionsPath, JSON.stringify({
      schemaVersion: 1,
      rules: [
        { id: 'private-shots', path_prefixes: ['/Private'], reason: 'never read' },
        { id: 'family', mode: 'metadata_only', path_prefixes: ['/Family'], reason: 'names only' },
      ],
    }));
    const matcher = dropboxCanonicalIngestionMatcher(
      defaultDropboxIngestionPolicy({ stillImagesRead: true }),
      { [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: exclusionsPath },
    );
    expect(matcher.evaluateItem({ path: '/Private/a.jpg', mimeType: 'image/jpeg' }).disposition).toBe('exclude');
    expect(matcher.evaluateItem({ path: '/Family/a.png', mimeType: 'image/png' }).disposition).toBe('metadata_only');
    expect(matcher.evaluateItem({ path: '/Photos/a.png', mimeType: 'image/png' }).disposition).toBe('admit');
  });

  test('a policy file the owner wrote is loaded as written, whatever the machine reads', () => {
    const dir = temporaryDir();
    const written = defaultDropboxIngestionPolicy({ stillImagesRead: false });
    written.rules = written.rules.filter((rule) => rule.reason !== 'media_default_metadata_only');
    const policyPath = join(dir, 'dropbox.personal.ingestion.json');
    writeFileSync(policyPath, JSON.stringify(written));
    setStillImageReadiness(stillImageReadinessOf(withoutHeic));
    const loaded = loadDropboxIngestionPolicy({ policyPath });
    expect(loaded.rules.map((rule) => rule.reason)).toEqual(written.rules.map((rule) => rule.reason));
    expect(loaded.rules.some((rule) => rule.reason === 'media_default_metadata_only')).toBe(false);
  });
});

// --- The extractor and the preparation ---------------------------------------

/**
 * A stand-in tool. Writes `output` (or what `behaviour` says) wherever it is
 * told to, whichever tool's command line this is.
 */
function fakeRunner(
  calls: string[][],
  behaviour: 'ok' | 'fail' | 'timeout' | 'missing' | 'not-jpeg' | 'nothing' = 'ok',
  output: (call: number) => Uint8Array = () => stubJpeg(192, 96),
): ExtractionCommandRunner {
  return async (request) => {
    calls.push([request.command, ...request.args]);
    if (behaviour === 'missing') throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    if (behaviour === 'timeout') throw new ExtractionCommandTimeoutError({ command: request.command, timeoutMs: request.timeoutMs });
    if (behaviour === 'fail') throw new ExtractionCommandError({ command: request.command, exitCode: 1, stdout: '', stderr: '' });
    if (behaviour === 'nothing') return { stdout: '', stderr: '' };
    writeFileSync(outputPathOf(request.args), behaviour === 'not-jpeg' ? Buffer.from('nope') : output(calls.length - 1));
    return { stdout: '', stderr: '' };
  };
}

const noProfile = { profileExists: () => false } as const;
const PREPARERS: Array<[string, () => StillImagePreparer]> = [
  ['sips', () => createSipsPreparer({ path: '/fake/sips', ...noProfile })],
  ['vipsthumbnail', () => createVipsPreparer({ path: '/fake/vipsthumbnail' })],
];

describe('the preparation settles every outcome the same way for both tools', () => {
  for (const [name, makePreparer] of PREPARERS) {
    describe(name, () => {
      const picture = () => ({ bytes: imageFixture('quadrants.jpg'), mimeType: 'image/jpeg', sizeBytes: imageFixture('quadrants.jpg').byteLength });
      const prepare = (runner: ExtractionCommandRunner, cacheDir = join(temporaryDir(), 'media-cache')) =>
        createImagePreparation({ cacheDir, preparer: makePreparer(), commandRunner: runner });

      test('a prepared picture is a clean JPEG in the cache', async () => {
        const cacheDir = join(temporaryDir(), 'media-cache');
        const calls: string[][] = [];
        const result = await prepare(fakeRunner(calls, 'ok', () => quadrantJpegWithMetadata(1)), cacheDir)(picture());
        expect(result.kind).toBe('media');
        if (result.kind !== 'media') return;
        expect(result.media.mimeType).toBe('image/jpeg');
        // The tool's output carried EXIF with GPS, XMP, IPTC and a comment; what is stored carries none.
        const stored = new Uint8Array(readFileSync(result.media.path));
        expect(jpegMetadataSegments(stored)).toEqual([]);
        expect(calls[0]![0]).toBe(name === 'sips' ? '/fake/sips' : '/fake/vipsthumbnail');
      });

      test('a missing tool is unavailable; a hang is retryable; a refusal or junk is terminal', async () => {
        expect(await prepare(fakeRunner([], 'missing'))(picture())).toEqual({ kind: 'unavailable' });
        expect(await prepare(fakeRunner([], 'timeout'))(picture()))
          .toEqual({ kind: 'settled', output: { status: 'failed_retryable', errorKind: IMAGE_PREPARE_ERROR_TIMEOUT } });
        for (const behaviour of ['fail', 'not-jpeg', 'nothing'] as const) {
          expect(await prepare(fakeRunner([], behaviour))(picture()))
            .toEqual({ kind: 'settled', output: { status: 'failed_terminal', errorKind: IMAGE_PREPARE_ERROR_FAILED } });
        }
      });

      test('a thumbnail-sized result is too small, and a cache that cannot be written is retryable', async () => {
        expect(await prepare(fakeRunner([], 'ok', () => stubJpeg(32, 32)))(picture())).toEqual({ kind: 'too_small' });
        const notADirectory = join(temporaryDir(), 'a-file');
        writeFileSync(notADirectory, 'x');
        expect(await prepare(fakeRunner([], 'ok'), join(notADirectory, 'media-cache'))(picture()))
          .toEqual({ kind: 'settled', output: { status: 'failed_retryable', errorKind: IMAGE_PREPARE_ERROR_CACHE_WRITE } });
      });

      test('a decompression bomb is skipped before any tool is asked, even a few hundred bytes of one', async () => {
        const calls: string[][] = [];
        const preparation = prepare(fakeRunner(calls));
        const bomb = pngClaiming(60_000, 60_000);
        expect(bomb.byteLength).toBeLessThan(1_024);
        expect(await preparation({ bytes: bomb, mimeType: 'image/png', sizeBytes: bomb.byteLength }))
          .toEqual({ kind: 'settled', output: { status: 'skipped_too_large' } });
        const padded = pngClaiming(60_000, 60_000, 4_000);
        expect(await preparation({ bytes: padded, mimeType: 'image/png', sizeBytes: padded.byteLength }))
          .toEqual({ kind: 'settled', output: { status: 'skipped_too_large' } });
        // A file over the byte limit is skipped too.
        const small = createImagePreparation({ cacheDir: join(temporaryDir(), 'c'), preparer: makePreparer(), commandRunner: fakeRunner(calls), maxInputBytes: 1_000 });
        expect(await small(picture())).toEqual({ kind: 'settled', output: { status: 'skipped_too_large' } });
        expect(calls).toEqual([]);
      });

      test('an icon-sized picture is too small without a tool, by declared size or by bytes', async () => {
        const calls: string[][] = [];
        const preparation = prepare(fakeRunner(calls));
        const icon = pngClaiming(32, 32, 2_000);
        expect(await preparation({ bytes: icon, mimeType: 'image/png', sizeBytes: icon.byteLength })).toEqual({ kind: 'too_small' });
        expect(await preparation({ bytes: new Uint8Array(200), mimeType: 'image/png', sizeBytes: 200 })).toEqual({ kind: 'too_small' });
        expect(calls).toEqual([]);
      });

      test('a format the host cannot decode is unavailable and no tool runs; a ready one is prepared', async () => {
        const calls: string[][] = [];
        const heic = { bytes: imageFixture('orientation-1.heic'), mimeType: 'image/heic', sizeBytes: imageFixture('orientation-1.heic').byteLength };
        const only = new Set<StillImageFormat>(withoutHeic);
        const preparation = createImagePreparation({
          cacheDir: join(temporaryDir(), 'media-cache'),
          preparer: makePreparer(),
          commandRunner: fakeRunner(calls),
          formats: () => only,
        });
        expect(await preparation(heic)).toEqual({ kind: 'unavailable' });
        // The bytes decide, not the label: a HEIC called a JPEG is still unavailable.
        expect(await preparation({ ...heic, mimeType: 'image/jpeg' })).toEqual({ kind: 'unavailable' });
        expect(calls).toEqual([]);
        expect(preparation.ready?.('image/heic')).toBe(false);
        expect(preparation.ready?.('image/jpeg')).toBe(true);
        expect((await preparation(picture())).kind).toBe('media');
        expect(calls.length).toBeGreaterThan(0);
        // The machine's answer is asked each time, so a decoder that arrives is used at once.
        only.add('heic');
        expect(preparation.ready?.('image/heic')).toBe(true);
        expect((await preparation(heic)).kind).toBe('media');
      });
    });
  }
});

describe('what each tool is asked to do', () => {
  test('vipsthumbnail: one command that shrinks, rotates, converts to sRGB, flattens onto white and strips', async () => {
    const calls: string[][] = [];
    const preparer = createVipsPreparer();
    const preparation = createImagePreparation({ cacheDir: join(temporaryDir(), 'c'), preparer, commandRunner: fakeRunner(calls) });
    await preparation({ bytes: imageFixture('quadrants.png'), mimeType: 'image/png', sizeBytes: 4481 });
    expect(calls).toHaveLength(1);
    const [command, input, ...rest] = calls[0]!;
    expect(command).toBe(VIPSTHUMBNAIL_COMMAND);
    expect(input!.endsWith('.png')).toBe(true);
    expect(rest.slice(0, 5)).toEqual(['--size', '1024x1024>', '--rotate', '--export-profile', 'srgb']);
    expect(rest[5]).toBe('-o');
    expect(rest[6]!.endsWith('.jpg[Q=85,strip,background=255]')).toBe(true);
  });

  test('sips: the long-standing first command is unchanged, and a second pass runs only when needed', async () => {
    const sips = createSipsPreparer({ path: '/fake/sips', srgbProfilePath: '/fake/sRGB.icc' });
    const run = async (first: Uint8Array, second: Uint8Array = stubJpeg(192, 96)) => {
      const calls: string[][] = [];
      const preparation = createImagePreparation({
        cacheDir: join(temporaryDir(), 'c'),
        preparer: sips,
        commandRunner: fakeRunner(calls, 'ok', (call) => (call === 0 ? first : second)),
      });
      const result = await preparation({ bytes: imageFixture('quadrants.jpg'), mimeType: 'image/jpeg', sizeBytes: 3977 });
      return { calls, result };
    };

    // Upright and untagged: exactly the one command it has always been given.
    const upright = await run(imageFixture('quadrants.jpg'));
    expect(upright.calls).toHaveLength(1);
    expect(upright.calls[0]!.slice(0, 6)).toEqual(['/fake/sips', '-s', 'format', 'jpeg', '-Z', '1024']);
    expect(upright.calls[0]![7]).toBe('--out');
    expect(upright.result.kind).toBe('media');

    // Tagged for a quarter turn: one more pass turns the pixels.
    const turned = await run(quadrantJpegWithMetadata(6));
    expect(turned.calls).toHaveLength(2);
    expect(turned.calls[1]!.slice(0, 3)).toEqual(['/fake/sips', '-r', '90']);
    expect(turned.calls[1]![turned.calls[1]!.length - 2]).toBe('--out');
    expect(turned.result.kind).toBe('media');

    // A transpose needs a turn and a flip.
    const transposed = await run(quadrantJpegWithMetadata(5));
    expect(transposed.calls[1]!.slice(1, 5)).toEqual(['-r', '270', '-f', 'horizontal']);

    // A wide-gamut profile is converted to sRGB; an sRGB one is left alone.
    const wide = await run(imageFixture('display-p3.jpg'));
    expect(wide.calls).toHaveLength(2);
    expect(wide.calls[1]!.slice(0, 3)).toEqual(['/fake/sips', '-m', '/fake/sRGB.icc']);
  });
});

describe('a format gained later is read once it appears', () => {
  test('the text lane queues a picture again, under the image version, only for a format that is ready', () => {
    const only = new Set<StillImageFormat>(withoutHeic);
    const extractor = createTextExtractor({
      imagePreparation: createImagePreparation({ cacheDir: '/unused', formats: () => only, commandRunner: fakeRunner([]) }),
    });
    expect(extractor.versionFor!('image/jpeg')).toBe(`${extractor.version}${IMAGE_MEDIA_VERSION_SUFFIX}`);
    expect(extractor.versionFor!('image/heic')).toBe(extractor.version);
    expect(extractor.versionFor!('application/pdf')).toBe(extractor.version);
    only.add('heic');
    expect(extractor.versionFor!('image/heic')).toBe(`${extractor.version}${IMAGE_MEDIA_VERSION_SUFFIX}`);
  });

  test('the default registry follows the machine\'s readiness, with no operating-system test', () => {
    const versionOf = (readiness: ReturnType<typeof stillImageReadinessOf>, mimeType: string) => {
      const registry = createDefaultExtractorRegistry({
        media: { cacheDir: join(temporaryDir(), 'media-cache'), readiness },
        ocr: { platform: 'linux' },
      });
      const extractor = registry.get('local_text')!;
      return [extractor.versionFor?.(mimeType), extractor.version] as const;
    };
    const [heicVersion, plain] = versionOf(stillImageReadinessOf(withoutHeic), 'image/heic');
    expect(heicVersion).toBe(plain);
    expect(versionOf(stillImageReadinessOf(withoutHeic), 'image/png')[0]).toBe(`${plain}${IMAGE_MEDIA_VERSION_SUFFIX}`);
    expect(versionOf(stillImageReadinessOf(true), 'image/heic')[0]).toBe(`${plain}${IMAGE_MEDIA_VERSION_SUFFIX}`);
    expect(versionOf(stillImageReadinessOf(false), 'image/png')[0]).toBe(plain);
  });
});

// --- Recovery: a format the host could not read, then can ---------------------

const CORPUS_ID = 'secure_local.fake.files';

function item(id: string, mimeType: string, extension: string): RawItem {
  return {
    identity: { family: 'file', provider: 'fake', accountScope: 'personal', providerItemId: id, localItemId: `local:${id}`, sourceVersion: 'rev-1' },
    mimeType,
    content: { kind: 'metadata_only' },
    metadata: { name: `${id}.${extension}`, pathDisplay: `/Photos/${id}.${extension}` },
    fetchedAt: '2026-10-07T00:00:00.000Z',
  };
}

function connectorFor(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'fake-metadata-sync',
    family: 'file',
    async authenticate() {},
    async *listItems(): AsyncIterable<SourceConnectorListPage> {
      yield { items, done: true };
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      return items.find((candidate) => candidate.identity.localItemId === localItemId)!;
    },
    classificationSignals: () => ({}),
  };
}

function refFor(id: string, mimeType: string): ExtractionItemRef {
  return {
    corpusId: CORPUS_ID,
    provider: 'fake',
    accountScope: 'personal',
    approvedScopeKey: 'scope',
    providerItemId: id,
    localItemId: `local:${id}`,
    sourceVersion: 'rev-1',
    name: id,
    mimeType,
  };
}

function openStore(dbPath: string, stillImagesRead?: boolean | Iterable<StillImageFormat>): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath,
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    ...(stillImagesRead === undefined ? {} : { stillImagesRead }),
  });
}

async function readAsText(store: LocalConnectorStore, id: string, mimeType: string): Promise<void> {
  await createConnectorStoreExtractionSink({
    store,
    classify: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
    syncConnectorId: 'extraction',
    ownerConnectorId: 'fake-connector',
    ownershipKind: 'observed',
  }).accept({
    ref: refFor(id, mimeType),
    text: `Photo ${id}`,
    extractorKind: 'local_text',
    extractorVersion: '1',
    fetchedAt: '2026-10-07T01:00:00.000Z',
  });
}

const listed = (store: LocalConnectorStore) => store.extractionCandidates({ limit: 20, withoutChunksOnly: true }).candidates
  .map((candidate) => candidate.identity.providerItemId).sort();

describe('recovery when a decoder appears', () => {
  test('a HEIC read as text while the host could not decode it is queued once HEIC is ready; a JPEG read with its picture considered is not', async () => {
    const dbPath = join(temporaryDir(), 'store.sqlite');
    const items = [item('kitchen-heic', 'image/heic', 'heic'), item('porch-jpg', 'image/jpeg', 'jpg')];

    // Day one: no HEIC decoder. Both photos are read as text alone.
    const before = openStore(dbPath, withoutHeic);
    try {
      await before.syncFromConnector(connectorFor(items), { fetchContent: false });
      await readAsText(before, 'kitchen-heic', 'image/heic');
      await readAsText(before, 'porch-jpg', 'image/jpeg');
      expect(listed(before)).toEqual([]);
    } finally {
      before.close();
    }

    // Only the JPEG's reading recorded that its picture was considered.
    const db = new Database(dbPath, { readonly: true });
    const reads = db.query('SELECT i.provider_item_id AS id FROM image_media_reads r JOIN items i ON i.item_pk = r.item_pk').all() as Array<{ id: string }>;
    db.close();
    expect(reads.map((row) => row.id)).toEqual(['porch-jpg']);

    // Later: the decoder is installed. The HEIC is listed again; the JPEG is not.
    const after = openStore(dbPath, ALL);
    try {
      expect(listed(after)).toEqual(['kitchen-heic']);
      // Read with its picture considered this time, it is done.
      await readAsText(after, 'kitchen-heic', 'image/heic');
      expect(listed(after)).toEqual([]);
    } finally {
      after.close();
    }
  });

  test('a store that is not told follows the machine\'s own answer as it changes', async () => {
    const dbPath = join(temporaryDir(), 'store.sqlite');
    setStillImageReadiness(stillImageReadinessOf(withoutHeic));
    const store = openStore(dbPath);
    try {
      await store.syncFromConnector(connectorFor([item('beach-heic', 'image/heic', 'heic')]), { fetchContent: false });
      await readAsText(store, 'beach-heic', 'image/heic');
      expect(listed(store)).toEqual([]);
      setStillImageReadiness(stillImageReadinessOf(ALL));
      expect(listed(store)).toEqual(['beach-heic']);
      setStillImageReadiness(stillImageReadinessOf(false));
      expect(listed(store)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

// --- What the owner is told ---------------------------------------------------

const ARCH = 'NAME="Arch Linux"\nID=arch\n';
const OMARCHY = 'NAME="Omarchy"\nID=omarchy\nID_LIKE=arch\n';
const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n';
const FEDORA = 'NAME="Fedora Linux"\nID=fedora\n';
const ROCKY = 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n';
const ALPINE = 'NAME="Alpine Linux"\nID=alpine\n';

describe('photo search status', () => {
  test('the distro family comes from /etc/os-release, quoted or not, by ID or ID_LIKE', () => {
    expect(linuxFamilyFromOsRelease(ARCH)).toBe('arch');
    expect(linuxFamilyFromOsRelease(OMARCHY)).toBe('arch');
    expect(linuxFamilyFromOsRelease(UBUNTU)).toBe('debian');
    expect(linuxFamilyFromOsRelease(FEDORA)).toBe('fedora');
    expect(linuxFamilyFromOsRelease(ROCKY)).toBe('fedora');
    expect(linuxFamilyFromOsRelease(ALPINE)).toBe('other');
    expect(linuxFamilyFromOsRelease(undefined)).toBe('other');
    expect(linuxFamilyFromOsRelease('')).toBe('other');
  });

  test('one command per distro', () => {
    expect(photoSearchInstallCommand('arch')).toBe('sudo pacman -S --needed libvips libheif');
    expect(photoSearchInstallCommand('debian')).toBe('sudo apt install libvips-tools libheif-plugin-libde265');
    expect(photoSearchInstallCommand('fedora')).toContain('dnf install');
    expect(photoSearchInstallCommand('other')).toBeUndefined();
  });

  test('ready: every format, nothing to do', () => {
    const status = photoSearchStatus(stillImageReadinessOf(true), { platform: 'linux', osRelease: ARCH });
    expect(status.state).toBe('ready');
    expect(status.missingFormats).toEqual([]);
    expect(status.remedy).toBeUndefined();
    expect(status.summary).toContain('ready');
  });

  test('partly ready: names the formats that stay names-only, with the one command for this distro', () => {
    const partial = stillImageReadinessOf(withoutHeic);
    const arch = photoSearchStatus(partial, { platform: 'linux', osRelease: OMARCHY });
    expect(arch.state).toBe('partial');
    expect(arch.readyFormats).toEqual(withoutHeic);
    expect(arch.missingFormats).toEqual([{ format: 'heic', reason: 'cannot_decode' }]);
    expect(arch.summary).toContain('HEIC');
    expect(arch.remedy).toContain('sudo pacman -S --needed libvips libheif');
    expect(photoSearchStatus(partial, { platform: 'linux', osRelease: UBUNTU }).remedy)
      .toContain('sudo apt install libvips-tools libheif-plugin-libde265');
    expect(photoSearchStatus(partial, { platform: 'linux', osRelease: FEDORA }).remedy).toContain('dnf install');
    const unknown = photoSearchStatus(partial, { platform: 'linux', osRelease: ALPINE });
    expect(unknown.remedy).toContain('libvips');
    expect(unknown.remedy).toContain('worker restart');
  });

  test('missing: no tool, with the same remedy; on a Mac the answer is macOS, not libvips', () => {
    const missing = stillImageReadinessOf(false);
    const linux = photoSearchStatus(missing, { platform: 'linux', osRelease: ARCH });
    expect(linux.state).toBe('missing');
    expect(linux.readyFormats).toEqual([]);
    expect(linux.summary).toContain('name only');
    expect(linux.remedy).toContain('sudo pacman -S --needed libvips libheif');
    const mac = photoSearchStatus(partialMac(), { platform: 'darwin' });
    expect(mac.state).toBe('partial');
    expect(mac.remedy).toContain('macOS');
    expect(mac.remedy).not.toContain('libvips');
  });

  test('a model whose image encoder did not start is named as the reason, with no package to install', () => {
    const blocked = probeStillImageReadiness({ tool: VIPS_TOOL, run: fakeTool(ALL), vision: 'unavailable' });
    const status = photoSearchStatus(blocked, { platform: 'linux', osRelease: ARCH });
    expect(status.state).toBe('missing');
    expect(status.summary).toContain('image encoder');
    expect(status.remedy).toContain('worker restart');
    expect(status.remedy).not.toContain('pacman');
    expect(status.missingFormats.every((entry) => entry.reason === 'vision_unavailable')).toBe(true);
  });
});

function partialMac() {
  return stillImageReadinessOf(withoutHeic, { tool: 'sips' });
}
