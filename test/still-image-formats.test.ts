/**
 * The still-image format table and the byte-level checks every lane shares
 * (src/core/still-image-formats.ts, jpeg-metadata.ts). Pure: no tool runs, so
 * none of these skip on any machine.
 */
import { describe, expect, test } from 'bun:test';
import {
  IMAGE_MAX_DECLARED_PIXELS,
  STILL_IMAGE_FORMATS,
  allStillImageExtensions,
  imageDeclaredDimensions,
  jpegPixelSize,
  stillImageExtensions,
  stillImageFormatForExtension,
  stillImageFormatForMimeType,
  stillImageFormatFromBytes,
  stillImageMimeTypes,
} from '../src/core/still-image-formats.ts';
import { DEFAULT_STILL_IMAGE_EXTENSIONS } from '../src/core/source-ingestion-policy.ts';
import { IMAGE_MIME_TYPES } from '../src/workers/file-extraction/extractors/bounded-text.ts';
import {
  iccProfileColorSpace,
  iccProfileIsSrgb,
  jpegExifOrientation,
  jpegIccProfile,
  jpegMetadataSegments,
  stripJpegMetadata,
} from '../src/workers/file-extraction/extractors/jpeg-metadata.ts';
import {
  commentSegment,
  exifSegment,
  imageFixture,
  insertJpegSegments,
  iptcSegment,
  jpegExifHasGps,
  pngClaiming,
  quadrantJpegWithMetadata,
  stubJpeg,
  xmpSegment,
} from './helpers/image-fixtures.ts';

describe('the format table', () => {
  test('every text-lane image type belongs to exactly one admitted format, and the extension list agrees with the policy', () => {
    for (const mimeType of IMAGE_MIME_TYPES) {
      expect(stillImageFormatForMimeType(mimeType)).toBeDefined();
    }
    expect([...STILL_IMAGE_FORMATS]).toEqual(['jpeg', 'png', 'heic', 'webp', 'gif', 'tiff', 'bmp']);
    expect(allStillImageExtensions()).toEqual([...DEFAULT_STILL_IMAGE_EXTENSIONS]);
    for (const format of STILL_IMAGE_FORMATS) {
      for (const extension of stillImageExtensions(format)) {
        expect(stillImageFormatForExtension(extension)).toBe(format);
        expect(stillImageFormatForExtension(`.${extension.toUpperCase()}`)).toBe(format);
      }
      for (const mimeType of stillImageMimeTypes(format)) expect(stillImageFormatForMimeType(`${mimeType}; charset=x`)).toBe(format);
    }
    expect(stillImageFormatForMimeType('image/heif')).toBe('heic');
    expect(stillImageFormatForMimeType('image/svg+xml')).toBeUndefined();
    expect(stillImageFormatForMimeType('video/mp4')).toBeUndefined();
    expect(stillImageFormatForMimeType(undefined)).toBeUndefined();
  });

  test('the first bytes name the format whatever the label says', () => {
    expect(stillImageFormatFromBytes(imageFixture('quadrants.jpg'))).toBe('jpeg');
    expect(stillImageFormatFromBytes(imageFixture('quadrants.png'))).toBe('png');
    expect(stillImageFormatFromBytes(imageFixture('quadrants.gif'))).toBe('gif');
    expect(stillImageFormatFromBytes(imageFixture('quadrants.bmp'))).toBe('bmp');
    expect(stillImageFormatFromBytes(imageFixture('quadrants.tiff'))).toBe('tiff');
    expect(stillImageFormatFromBytes(imageFixture('quadrants.webp'))).toBe('webp');
    expect(stillImageFormatFromBytes(imageFixture('orientation-6.heic'))).toBe('heic');
    expect(stillImageFormatFromBytes(new Uint8Array(64))).toBeUndefined();
    expect(stillImageFormatFromBytes(new Uint8Array(0))).toBeUndefined();
  });
});

describe('declared size, read from the header before any decoder runs', () => {
  test('each format reports the size its fixture has', () => {
    for (const name of ['quadrants.jpg', 'quadrants.png', 'quadrants.gif', 'quadrants.bmp', 'quadrants.tiff', 'quadrants.webp', 'orientation-1.heic', 'orientation-6.heic']) {
      expect(imageDeclaredDimensions(imageFixture(name))).toEqual({ width: 192, height: 96 });
    }
    expect(jpegPixelSize(imageFixture('quadrants.jpg'))).toEqual({ width: 192, height: 96 });
    expect(imageDeclaredDimensions(imageFixture('alpha.png'))).toEqual({ width: 128, height: 128 });
    expect(imageDeclaredDimensions(new Uint8Array(100))).toBeUndefined();
  });

  test('a few bytes that claim billions of pixels declare them', () => {
    const bomb = pngClaiming(60_000, 60_000);
    expect(bomb.byteLength).toBeLessThan(200);
    const size = imageDeclaredDimensions(bomb)!;
    expect(size.width * size.height).toBeGreaterThan(IMAGE_MAX_DECLARED_PIXELS);
    // A 200-megapixel phone picture is within the bound.
    const phone = imageDeclaredDimensions(pngClaiming(16_320, 12_240))!;
    expect(phone.width * phone.height).toBeLessThanOrEqual(IMAGE_MAX_DECLARED_PIXELS);
  });

  test('a WebP and a TIFF header are read for their canvas size too', () => {
    // VP8X: canvas size is stored minus one in 24 bits.
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8X', 12, 'latin1');
    webp.writeUIntLE(40_000 - 1, 24, 3);
    webp.writeUIntLE(40_000 - 1, 27, 3);
    expect(imageDeclaredDimensions(new Uint8Array(webp))).toEqual({ width: 40_000, height: 40_000 });
  });
});

describe('what a JPEG carries besides its pixels', () => {
  test('the EXIF orientation, GPS, XMP, IPTC and comment are all found, and all removed', () => {
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const original = quadrantJpegWithMetadata(orientation);
      expect(jpegExifOrientation(original)).toBe(orientation);
      expect(jpegExifHasGps(original)).toBe(true);
      expect(jpegMetadataSegments(original)).toEqual(['exif', 'xmp', 'iptc', 'comment']);

      const stripped = stripJpegMetadata(original);
      expect(jpegMetadataSegments(stripped)).toEqual([]);
      expect(jpegExifOrientation(stripped)).toBe(1);
      expect(Buffer.from(stripped).includes('TestMake')).toBe(false);
      expect(Buffer.from(stripped).includes('GPS')).toBe(false);
      // The image data is carried over untouched, so the size and the scan are the same.
      expect(jpegPixelSize(stripped)).toEqual({ width: 192, height: 96 });
      expect(stripped.byteLength).toBeLessThan(original.byteLength);
      const scan = (bytes: Uint8Array) => Buffer.from(bytes).subarray(Buffer.from(bytes).indexOf(Buffer.from([0xff, 0xda])));
      expect(scan(stripped).equals(scan(original))).toBe(true);
    }
  });

  test('a clean JPEG comes back as the same bytes, and a non-JPEG is left alone', () => {
    const clean = imageFixture('quadrants.jpg');
    expect(jpegMetadataSegments(clean)).toEqual([]);
    expect(stripJpegMetadata(clean)).toBe(clean);
    const png = imageFixture('quadrants.png');
    expect(stripJpegMetadata(png)).toBe(png);
    expect(jpegExifOrientation(png)).toBe(1);
  });

  test('an unusable orientation reads as upright', () => {
    expect(jpegExifOrientation(insertJpegSegments(imageFixture('quadrants.jpg'), [exifSegment(0)]))).toBe(1);
    expect(jpegExifOrientation(insertJpegSegments(imageFixture('quadrants.jpg'), [exifSegment(9)]))).toBe(1);
    expect(jpegExifOrientation(stubJpeg(10, 10))).toBe(1);
    // Segments without an EXIF header are not metadata of ours to read.
    expect(jpegMetadataSegments(insertJpegSegments(imageFixture('quadrants.jpg'), [xmpSegment(), iptcSegment(), commentSegment()])))
      .toEqual(['xmp', 'iptc', 'comment']);
  });

  test('the colour profile is read, told apart as sRGB or not, and removed', () => {
    const swatch = imageFixture('display-p3.jpg');
    expect(jpegMetadataSegments(swatch)).toEqual(['icc']);
    const profile = jpegIccProfile(swatch)!;
    expect(iccProfileColorSpace(profile)).toBe('RGB ');
    expect(iccProfileIsSrgb(profile)).toBe(false);
    expect(jpegIccProfile(stripJpegMetadata(swatch))).toBeUndefined();
    expect(jpegIccProfile(imageFixture('quadrants.jpg'))).toBeUndefined();
    const srgb = new Uint8Array(128);
    srgb.set(Buffer.from('RGB ', 'latin1'), 16);
    srgb.set(Buffer.from('sRGB IEC61966-2.1', 'latin1'), 60);
    expect(iccProfileIsSrgb(srgb)).toBe(true);
  });
});
