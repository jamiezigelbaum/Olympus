/**
 * The guarantees every still-image preparer gives, proven with real pictures
 * and the real tool (docs/design/photo-embeddings.md, "What a prepared photo
 * is"): the same suite runs against `sips` where it exists (macOS) and
 * against `vipsthumbnail` where it exists (Linux with libvips), and skips a
 * tool this machine lacks. The pure logic around them (readiness, admission,
 * settle states, messages) is tested without any tool in
 * still-image-readiness.test.ts and never skips.
 *
 * Each prepared picture is read back with a tool other than the code under
 * test (`vips copy` for libvips output, `sips` for sips output), so the
 * assertions are about pixels, not about what we wrote.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { probeStillImageReadiness, readyStillImageFormats } from '../src/core/still-image-readiness.ts';
import type { StillImageFormat } from '../src/core/still-image-formats.ts';
import { IMAGE_PREPARE_MAX_PIXEL_EDGE, createImagePreparation } from '../src/workers/file-extraction/extractors/image-prepare.ts';
import {
  SIPS_PATH,
  createStillImagePreparer,
  findExecutable,
  type SelectedStillImageTool,
} from '../src/workers/file-extraction/extractors/image-preparers.ts';
import { jpegMetadataSegments } from '../src/workers/file-extraction/extractors/jpeg-metadata.ts';
import { jpegPixelSize } from '../src/core/still-image-formats.ts';
import {
  colourClose,
  decodeJpeg,
  displayedGrid,
  gridsClose,
  imageFixture,
  jpegExifHasGps,
  orientationSwapsAxes,
  pngClaiming,
  quadrantJpegWithMetadata,
  sampleGrid,
  STORED_GRID,
  type DecodedPicture,
  type Rgb,
} from './helpers/image-fixtures.ts';
import { solidPng } from './helpers/solid-png.ts';

const work = mkdtempSync(join(tmpdir(), 'olympus-contract-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface AvailableTool extends SelectedStillImageTool {
  label: string;
}

function availableTools(): AvailableTool[] {
  const tools: AvailableTool[] = [];
  if (process.platform === 'darwin' && existsSync(SIPS_PATH)) tools.push({ kind: 'sips', path: SIPS_PATH, label: 'sips' });
  const vips = findExecutable('vipsthumbnail');
  if (vips) tools.push({ kind: 'vips', path: vips, label: 'vipsthumbnail' });
  return tools;
}

/** A picture's pixels once prepared by `tool`, and the prepared file's bytes. */
async function prepared(
  tool: AvailableTool,
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ bytes: Uint8Array; picture: DecodedPicture } | { settled: string }> {
  const preparation = createImagePreparation({
    cacheDir: join(work, `cache-${tool.kind}`),
    preparer: createStillImagePreparer(tool),
  });
  const result = await preparation({ bytes, mimeType, sizeBytes: bytes.byteLength });
  if (result.kind !== 'media') return { settled: result.kind === 'settled' ? result.output.status : result.kind };
  const picture = decodeJpeg(result.media.path, tool);
  if (!picture) throw new Error(`cannot read back a ${tool.label} result on this machine`);
  return { bytes: new Uint8Array(readFileSync(result.media.path)), picture };
}

async function preparedOrFail(tool: AvailableTool, bytes: Uint8Array, mimeType: string) {
  const result = await prepared(tool, bytes, mimeType);
  if ('settled' in result) throw new Error(`${tool.label} settled as ${result.settled}`);
  return result;
}

const tools = availableTools();
if (tools.length === 0) {
  describe('still-image preparers against a real tool', () => {
    test.skip('neither sips nor vipsthumbnail is installed here (the contract runs where one is)', () => {});
  });
}

const containers: Array<[string, string, StillImageFormat]> = [
  ['quadrants.jpg', 'image/jpeg', 'jpeg'],
  ['quadrants.png', 'image/png', 'png'],
  ['quadrants.gif', 'image/gif', 'gif'],
  ['quadrants.bmp', 'image/bmp', 'bmp'],
  ['quadrants.tiff', 'image/tiff', 'tiff'],
  ['quadrants.webp', 'image/webp', 'webp'],
];

for (const tool of tools) {
  // The result is read back with `vips copy` (libvips) or sips itself.
  const readable = tool.kind === 'sips' || existsSync(join(dirname(tool.path), 'vips'));
  const readiness = probeStillImageReadiness({ tool, vision: 'ready' });
  const ready = readyStillImageFormats(readiness);

  describe.skipIf(!readable)(`${tool.label}: what a prepared photo is`, () => {
    test('the probe finds the formats every host decodes, and only formats it really decoded are ready', () => {
      for (const format of ['jpeg', 'png', 'gif', 'bmp', 'tiff'] as const) expect(ready.has(format)).toBe(true);
      expect(readiness.tool).toBe(tool.kind);
    });

    for (const [name, mimeType, format] of containers) {
      test(`${format}: becomes a JPEG of the same picture, upright, with nothing but pixels`, async () => {
        if (!ready.has(format)) return;
        const result = await preparedOrFail(tool, imageFixture(name), mimeType);
        expect(result.bytes[0]).toBe(0xff);
        expect(result.bytes[1]).toBe(0xd8);
        expect(jpegMetadataSegments(result.bytes)).toEqual([]);
        expect(gridsClose(sampleGrid(result.picture), STORED_GRID, 64)).toBe(true);
        expect(Math.max(result.picture.width, result.picture.height)).toBeLessThanOrEqual(IMAGE_PREPARE_MAX_PIXEL_EDGE);
      });
    }

    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      test(`EXIF orientation ${orientation} in a JPEG is applied to the pixels`, async () => {
        const result = await preparedOrFail(tool, quadrantJpegWithMetadata(orientation), 'image/jpeg');
        expect(sampleGrid(result.picture)).toSatisfy((grid: Rgb[][]) => gridsClose(grid, displayedGrid(orientation), 64));
        const wide = result.picture.width > result.picture.height;
        expect(wide).toBe(!orientationSwapsAxes(orientation));
        // Applied once: the prepared copy says nothing more about orientation.
        expect(jpegMetadataSegments(result.bytes)).toEqual([]);
      });

      test(`orientation ${orientation} in a HEIC (its rotation and mirror) is applied to the pixels`, async () => {
        if (!ready.has('heic')) return;
        const result = await preparedOrFail(tool, imageFixture(`orientation-${orientation}.heic`), 'image/heic');
        expect(sampleGrid(result.picture)).toSatisfy((grid: Rgb[][]) => gridsClose(grid, displayedGrid(orientation), 64));
        expect(result.picture.width > result.picture.height).toBe(!orientationSwapsAxes(orientation));
        expect(jpegMetadataSegments(result.bytes)).toEqual([]);
      });
    }

    for (const [name, mimeType, format] of [
      ['orientation-6.png', 'image/png', 'png'],
      ['orientation-6.webp', 'image/webp', 'webp'],
      ['orientation-6.tiff', 'image/tiff', 'tiff'],
    ] as const) {
      test(`orientation 6 in a ${format} is applied too`, async () => {
        if (!ready.has(format)) return;
        const result = await preparedOrFail(tool, imageFixture(name), mimeType);
        expect(sampleGrid(result.picture)).toSatisfy((grid: Rgb[][]) => gridsClose(grid, displayedGrid(6), 64));
      });
    }

    test('location and every other metadata block are gone: GPS in, none out', async () => {
      const original = quadrantJpegWithMetadata(1);
      expect(jpegExifHasGps(original)).toBe(true);
      expect(jpegMetadataSegments(original)).toEqual(['exif', 'xmp', 'iptc', 'comment']);
      const result = await preparedOrFail(tool, original, 'image/jpeg');
      expect(jpegMetadataSegments(result.bytes)).toEqual([]);
      expect(jpegExifHasGps(result.bytes)).toBe(false);
      expect(Buffer.from(result.bytes).includes('TestMake')).toBe(false);
      if (ready.has('heic')) {
        // The HEIC fixtures carry an Exif item.
        const heic = await preparedOrFail(tool, imageFixture('orientation-1.heic'), 'image/heic');
        expect(jpegMetadataSegments(heic.bytes)).toEqual([]);
      }
    });

    test('colours are converted to sRGB: a Display P3 swatch lands on its sRGB value, with no profile left', async () => {
      const result = await preparedOrFail(tool, imageFixture('display-p3.jpg'), 'image/jpeg');
      // (180, 90, 40) in Display P3 is about (192, 84, 19) in sRGB.
      const centre = result.picture.at(Math.floor(result.picture.width / 2), Math.floor(result.picture.height / 2));
      expect(colourClose(centre, [192, 84, 19], 14)).toBe(true);
      expect(jpegMetadataSegments(result.bytes)).toEqual([]);
    });

    test('transparency is flattened onto white', async () => {
      const result = await preparedOrFail(tool, imageFixture('alpha.png'), 'image/png');
      const { width, height } = result.picture;
      expect(colourClose(result.picture.at(2, 2), [255, 255, 255], 12)).toBe(true);
      expect(colourClose(result.picture.at(width - 3, height - 3), [255, 255, 255], 12)).toBe(true);
      const centre = result.picture.at(Math.floor(width / 2), Math.floor(height / 2));
      expect(centre[0]).toBeGreaterThan(200);
      expect(centre[1]).toBeLessThan(80);
      expect(centre[2]).toBeLessThan(80);
    });

    test('a large picture is shrunk to the long-side limit, keeping its shape; a small one is not stretched into a different shape', async () => {
      const large = solidPng(3000, 2000, [30, 120, 200]);
      const result = await preparedOrFail(tool, large, 'image/png');
      const size = jpegPixelSize(result.bytes)!;
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(IMAGE_PREPARE_MAX_PIXEL_EDGE);
      expect(Math.abs(size.width / size.height - 1.5)).toBeLessThan(0.02);
    });

    test('a decompression bomb is rejected as skipped_too_large before the tool sees it', async () => {
      const bomb = pngClaiming(60_000, 60_000, 4_000);
      const result = await prepared(tool, bomb, 'image/png');
      expect(result).toEqual({ settled: 'skipped_too_large' });
    });

    test('a damaged picture settles as a terminal failure, not a hang or a crash', async () => {
      const damaged = new Uint8Array(imageFixture('quadrants.png'));
      damaged.fill(0x7f, 60, 400);
      const result = await prepared(tool, damaged, 'image/png');
      // Some decoders recover a partial picture; none may throw or hang.
      expect('settled' in result ? result.settled : 'media').toMatch(/failed_terminal|media|too_small/);
    });
  });
}
