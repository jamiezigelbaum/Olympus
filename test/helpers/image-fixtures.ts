// Real pictures and the means to judge a prepared one, for the still-image
// tests (test/still-image-*.test.ts). The fixtures in test/fixtures/images are
// described by test/fixtures/images/generate.py: a 192 x 96 picture of four
// colour quadrants (red, green / blue, white) in every admitted container, one
// HEIC per EXIF orientation written by Apple's encoder, a wide-gamut swatch and
// a picture with transparency.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';

const FIXTURE_DIR = join(import.meta.dir, '..', 'fixtures', 'images');

export function imageFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

export type Rgb = [number, number, number];

/** The four colours of the quadrant fixtures, as stored: top-left, top-right, bottom-left, bottom-right. */
export const RED: Rgb = [255, 0, 0];
export const GREEN: Rgb = [0, 255, 0];
export const BLUE: Rgb = [0, 0, 255];
export const WHITE: Rgb = [255, 255, 255];
export const STORED_GRID: Rgb[][] = [[RED, GREEN], [BLUE, WHITE]];

/**
 * The 2 x 2 grid a viewer shows for a stored grid under EXIF orientation 1 to
 * 8 (checked against a reference implementation of the standard's table).
 */
export function displayedGrid(orientation: number, g: Rgb[][] = STORED_GRID): Rgb[][] {
  switch (orientation) {
    case 1: return [[g[0]![0]!, g[0]![1]!], [g[1]![0]!, g[1]![1]!]];
    case 2: return [[g[0]![1]!, g[0]![0]!], [g[1]![1]!, g[1]![0]!]];
    case 3: return [[g[1]![1]!, g[1]![0]!], [g[0]![1]!, g[0]![0]!]];
    case 4: return [[g[1]![0]!, g[1]![1]!], [g[0]![0]!, g[0]![1]!]];
    case 5: return [[g[0]![0]!, g[1]![0]!], [g[0]![1]!, g[1]![1]!]];
    case 6: return [[g[1]![0]!, g[0]![0]!], [g[1]![1]!, g[0]![1]!]];
    case 7: return [[g[1]![1]!, g[0]![1]!], [g[1]![0]!, g[0]![0]!]];
    case 8: return [[g[0]![1]!, g[1]![1]!], [g[0]![0]!, g[1]![0]!]];
    default: throw new Error(`no such EXIF orientation: ${orientation}`);
  }
}

/** Orientations 5 to 8 turn a landscape picture into a portrait one. */
export function orientationSwapsAxes(orientation: number): boolean {
  return orientation >= 5;
}

// --- JPEG segments -----------------------------------------------------------

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

function segment(marker: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker]), u16(body.length + 2), body]);
}

/** An APP1 EXIF segment with a camera make, the orientation and a GPS position. */
export function exifSegment(orientation: number, options: { gps?: boolean } = {}): Buffer {
  const gps = options.gps !== false;
  const make = Buffer.from('TestMake\0', 'latin1');
  const entries = gps ? 3 : 2;
  const ifd0Size = 2 + entries * 12 + 4;
  const makeOffset = 8 + ifd0Size;
  const gpsOffset = makeOffset + 10; // the make string padded to 10 bytes
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const entry = (tag: number, type: number, count: number, value: Buffer): Buffer => {
    const out = Buffer.alloc(12);
    out.writeUInt16LE(tag, 0);
    out.writeUInt16LE(type, 2);
    out.writeUInt32LE(count, 4);
    value.copy(out, 8);
    return out;
  };
  const long = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const short = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt16LE(n); return b; };
  const ifd0 = Buffer.concat([
    Buffer.from([entries, 0]),
    entry(0x010f, 2, make.length, long(makeOffset)),
    entry(0x0112, 3, 1, short(orientation)),
    ...(gps ? [entry(0x8825, 4, 1, long(gpsOffset))] : []),
    long(0),
  ]);
  const makeData = Buffer.concat([make, Buffer.alloc(10 - make.length)]);
  let tiff = Buffer.concat([header, ifd0, makeData]);
  if (gps) {
    const gpsIfdSize = 2 + 4 * 12 + 4;
    const latOffset = gpsOffset + gpsIfdSize;
    const lonOffset = latOffset + 24;
    const rationals = (d: number, m: number, s: number): Buffer => {
      const out = Buffer.alloc(24);
      [d, 1, m, 1, s, 1].forEach((value, index) => out.writeUInt32LE(value, index * 4));
      return out;
    };
    const gpsIfd = Buffer.concat([
      Buffer.from([4, 0]),
      entry(1, 2, 2, Buffer.from('N\0', 'latin1')),
      entry(2, 5, 3, long(latOffset)),
      entry(3, 2, 2, Buffer.from('W\0', 'latin1')),
      entry(4, 5, 3, long(lonOffset)),
      long(0),
      rationals(40, 26, 46),
      rationals(79, 58, 56),
    ]);
    tiff = Buffer.concat([tiff, gpsIfd]);
  }
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
}

export function xmpSegment(): Buffer {
  const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description exif:GPSLatitude="40,26.7667N"/></rdf:RDF></x:xmpmeta>';
  return segment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0${xml}`, 'latin1'));
}

export function iptcSegment(): Buffer {
  return segment(0xed, Buffer.from('Photoshop 3.0\0' + '8BIM caption: kitchen', 'latin1'));
}

export function commentSegment(): Buffer {
  return segment(0xfe, Buffer.from('taken at home', 'latin1'));
}

/** Inserts segments right after the JPEG's SOI (and its JFIF header, if it has one). */
export function insertJpegSegments(jpeg: Uint8Array, segments: Buffer[]): Uint8Array {
  const bytes = Buffer.from(jpeg);
  let at = 2;
  if (bytes[2] === 0xff && bytes[3] === 0xe0) at = 4 + bytes.readUInt16BE(4);
  return new Uint8Array(Buffer.concat([bytes.subarray(0, at), ...segments, bytes.subarray(at)]));
}

/** The quadrant picture with an EXIF orientation, a GPS position, XMP, IPTC and a comment. */
export function quadrantJpegWithMetadata(orientation: number): Uint8Array {
  return insertJpegSegments(imageFixture('quadrants.jpg'), [
    exifSegment(orientation),
    xmpSegment(),
    iptcSegment(),
    commentSegment(),
  ]);
}

/** Whether a JPEG's EXIF carries a GPS block (tag 0x8825 in the first directory). */
export function jpegExifHasGps(jpeg: Uint8Array): boolean {
  const bytes = Buffer.from(jpeg);
  const at = bytes.indexOf('Exif\0\0', 0, 'latin1');
  if (at < 0) return false;
  const tiff = bytes.subarray(at + 6);
  const little = tiff.toString('latin1', 0, 2) === 'II';
  const read16 = (offset: number) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const read32 = (offset: number) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  const ifd = read32(4);
  const count = read16(ifd);
  for (let index = 0; index < count; index += 1) {
    if (read16(ifd + 2 + index * 12) === 0x8825) return true;
  }
  return false;
}

/** The smallest byte string `jpegPixelSize` and the JPEG checks accept. */
export function stubJpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xda, 0x00, 0x02,
    0xff, 0xd9,
  ]);
}

/**
 * A PNG whose header claims `width` x `height` over a few bytes of image data:
 * a decompression bomb when the claim is large. `padTo` pads it with an
 * ancillary chunk so it clears the small-file floor.
 */
export function pngClaiming(width: number, height: number, padTo = 0): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(64))),
  ];
  const size = parts.reduce((sum, part) => sum + part.length, 0) + 12;
  if (padTo > size) parts.push(chunk('teXt', Buffer.alloc(padTo - size - 12)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}

// --- Judging a prepared picture ----------------------------------------------

export interface DecodedPicture {
  width: number;
  height: number;
  at(x: number, y: number): Rgb;
}

function findSibling(path: string, name: string): string | undefined {
  const candidate = join(dirname(path), name);
  return existsSync(candidate) ? candidate : undefined;
}

function parsePpm(data: Buffer): DecodedPicture {
  // P6 <width> <height> <max> then raw RGB; header fields separated by whitespace.
  let offset = 2;
  const fields: number[] = [];
  while (fields.length < 3) {
    for (;;) {
      while (data[offset] === 0x20 || data[offset] === 0x0a || data[offset] === 0x0d || data[offset] === 0x09) offset += 1;
      // libvips writes a "#vips2ppm - <date>" comment line after the magic.
      if (data[offset] !== 0x23) break;
      while (data[offset] !== 0x0a) offset += 1;
    }
    let end = offset;
    while (data[end]! > 0x20) end += 1;
    fields.push(Number(data.toString('latin1', offset, end)));
    offset = end;
  }
  offset += 1;
  const [width, height] = fields as [number, number, number];
  return {
    width,
    height,
    at: (x, y) => {
      const at = offset + (y * width + x) * 3;
      return [data[at]!, data[at + 1]!, data[at + 2]!];
    },
  };
}

function parseBmp(data: Buffer): DecodedPicture {
  const dataOffset = data.readUInt32LE(10);
  const width = data.readInt32LE(18);
  const rawHeight = data.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const bits = data.readUInt16LE(28);
  const stride = Math.floor((width * bits + 31) / 32) * 4;
  const bytesPerPixel = bits / 8;
  return {
    width,
    height,
    at: (x, y) => {
      const row = rawHeight > 0 ? height - 1 - y : y;
      const at = dataOffset + row * stride + x * bytesPerPixel;
      return [data[at + 2]!, data[at + 1]!, data[at]!];
    },
  };
}

/**
 * Decodes a JPEG into pixels with a tool other than the code under test where
 * one exists (libvips' own `vips copy` for libvips output, `sips` for sips
 * output), or undefined when this machine has neither.
 */
export function decodeJpeg(path: string, tool: { kind: 'sips' | 'vips'; path: string }): DecodedPicture | undefined {
  const directory = mkdtempSync(join(tmpdir(), 'olympus-decode-'));
  try {
    if (tool.kind === 'sips') {
      const out = join(directory, 'out.bmp');
      execFileSync(tool.path, ['-s', 'format', 'bmp', path, '--out', out], { stdio: 'ignore' });
      return parseBmp(readFileSync(out));
    }
    const vips = findSibling(tool.path, 'vips');
    if (!vips) return undefined;
    const out = join(directory, 'out.ppm');
    execFileSync(vips, ['copy', path, out], { stdio: 'ignore' });
    return parsePpm(readFileSync(out));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The colours at the centres of a picture's four quadrants. */
export function sampleGrid(picture: DecodedPicture): Rgb[][] {
  const at = (column: number, row: number): Rgb => picture.at(
    Math.floor(picture.width * (column + 0.5) / 2),
    Math.floor(picture.height * (row + 0.5) / 2),
  );
  return [[at(0, 0), at(1, 0)], [at(0, 1), at(1, 1)]];
}

export function colourClose(actual: Rgb, expected: Rgb, tolerance = 48): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance);
}

export function gridsClose(actual: Rgb[][], expected: Rgb[][], tolerance = 48): boolean {
  return actual.every((row, r) => row.every((value, c) => colourClose(value, expected[r]![c]!, tolerance)));
}
