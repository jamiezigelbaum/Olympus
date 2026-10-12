/**
 * The still-image formats Olympus prepares for media search
 * (docs/design/photo-embeddings.md), the one table every lane reads: the
 * ingestion policy, the readiness ladder, the extraction candidates, the
 * preparation itself and the doctor.
 *
 * Shared by media type, never by source. Everything here is pure: no tool is
 * run, nothing is read from the machine. A format is a family of media types
 * and file extensions that one decoder answers for (HEIC and HEIF are one
 * format; so are TIF and TIFF).
 *
 * The header readers bound a picture's size BEFORE any decoder sees it. A
 * file that is a few kilobytes on disk can declare billions of pixels (a
 * decompression bomb); reading the declared size out of the first bytes is
 * cheap, needs no tool, and holds on every machine alike.
 */

export const STILL_IMAGE_FORMATS = ['jpeg', 'png', 'heic', 'webp', 'gif', 'tiff', 'bmp'] as const;
export type StillImageFormat = (typeof STILL_IMAGE_FORMATS)[number];

const FORMAT_MIME_TYPES: Readonly<Record<StillImageFormat, readonly string[]>> = {
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  png: ['image/png', 'image/x-png'],
  heic: ['image/heic', 'image/heif'],
  webp: ['image/webp'],
  gif: ['image/gif'],
  tiff: ['image/tiff', 'image/tif'],
  bmp: ['image/bmp', 'image/x-ms-bmp'],
};

const FORMAT_EXTENSIONS: Readonly<Record<StillImageFormat, readonly string[]>> = {
  jpeg: ['jpeg', 'jpg'],
  png: ['png'],
  heic: ['heic', 'heif'],
  webp: ['webp'],
  gif: ['gif'],
  tiff: ['tif', 'tiff'],
  bmp: ['bmp'],
};

/** The media types (and prefixes) one format answers for. */
export function stillImageMimeTypes(format: StillImageFormat): readonly string[] {
  return FORMAT_MIME_TYPES[format];
}

/** The file extensions (no dot, lower case) one format answers for. */
export function stillImageExtensions(format: StillImageFormat): readonly string[] {
  return FORMAT_EXTENSIONS[format];
}

/** Every admitted still-image extension, sorted. */
export function allStillImageExtensions(): string[] {
  return STILL_IMAGE_FORMATS.flatMap((format) => [...FORMAT_EXTENSIONS[format]]).sort();
}

/** The format a media type belongs to, or undefined (SVG, ICO, video, a PDF). */
export function stillImageFormatForMimeType(mimeType: string | undefined): StillImageFormat | undefined {
  const value = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (!value) return undefined;
  for (const format of STILL_IMAGE_FORMATS) {
    if (FORMAT_MIME_TYPES[format].includes(value)) return format;
  }
  return undefined;
}

/** The format a file extension (with or without the dot) belongs to. */
export function stillImageFormatForExtension(extension: string): StillImageFormat | undefined {
  const trimmed = extension.trim();
  const value = (trimmed.startsWith('.') ? trimmed.slice(1) : trimmed).toLowerCase();
  for (const format of STILL_IMAGE_FORMATS) {
    if (FORMAT_EXTENSIONS[format].includes(value)) return format;
  }
  return undefined;
}

/** The file extension, with its dot, a temp copy of a format is named with. */
export function stillImageFileExtension(format: StillImageFormat): string {
  return `.${FORMAT_EXTENSIONS[format][0]}`;
}

const HEIC_BRANDS: ReadonlySet<string> = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'heif',
]);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let index = start; index < start + length && index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index]!);
  }
  return out;
}

/**
 * The format the first bytes say a file is, or undefined when they say none
 * of the admitted ones. A provider's media type can be wrong (a HEIC served
 * as `image/jpeg`); the bytes are what a decoder will meet.
 */
export function stillImageFormatFromBytes(bytes: Uint8Array): StillImageFormat | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'png';
  if (bytes.length >= 6 && ascii(bytes, 0, 4) === 'GIF8') return 'gif';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  // Classic TIFF is version 42, BigTIFF (64-bit offsets, files over 4 GB) 43.
  if (bytes.length >= 4 && ((ascii(bytes, 0, 2) === 'II' && (bytes[2] === 0x2a || bytes[2] === 0x2b) && bytes[3] === 0)
    || (ascii(bytes, 0, 2) === 'MM' && bytes[2] === 0 && (bytes[3] === 0x2a || bytes[3] === 0x2b)))) return 'tiff';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp' && HEIC_BRANDS.has(ascii(bytes, 8, 4))) return 'heic';
  return undefined;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Upper bound on the pixels one picture may declare (16,384 x 16,384). A
 * 200-megapixel phone sensor fits; a decompression bomb does not.
 */
export const IMAGE_MAX_DECLARED_PIXELS = 16_384 * 16_384;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Width and height from a JPEG's start-of-frame segment, or undefined when
 * the header cannot be walked.
 */
export function jpegPixelSize(bytes: Uint8Array): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

/**
 * Width and height from a TIFF's first directory. Classic TIFF (version 42)
 * has 12-byte entries with 32-bit offsets; BigTIFF (version 43) has 20-byte
 * entries with 64-bit counts and offsets, so it needs its own reader: a file
 * only the first reader understood would declare no size at all.
 */
function tiffDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const data = view(bytes);
  const little = ascii(bytes, 0, 2) === 'II';
  const big = data.getUint16(2, little) === 43;
  if (big && (bytes.length < 16 || data.getUint16(4, little) !== 8)) return undefined;
  const ifdOffset = big ? Number(data.getBigUint64(8, little)) : data.getUint32(4, little);
  const countSize = big ? 8 : 2;
  const entrySize = big ? 20 : 12;
  if (!Number.isSafeInteger(ifdOffset) || ifdOffset + countSize > bytes.length) return undefined;
  const count = big ? Number(data.getBigUint64(ifdOffset, little)) : data.getUint16(ifdOffset, little);
  let width: number | undefined;
  let height: number | undefined;
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + countSize + index * entrySize;
    if (entry + entrySize > bytes.length) break;
    const tag = data.getUint16(entry, little);
    if (tag !== 256 && tag !== 257) continue;
    const type = data.getUint16(entry + 2, little);
    const valueAt = entry + (big ? 12 : 8);
    const value = type === 3 ? data.getUint16(valueAt, little)
      : type === 4 ? data.getUint32(valueAt, little)
        : big && type === 16 ? Number(data.getBigUint64(valueAt, little))
          : undefined;
    if (value === undefined) continue;
    if (tag === 256) width = value;
    else height = value;
  }
  return width !== undefined && height !== undefined ? { width, height } : undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8 ') {
    return {
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    return {
      width: 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)),
      height: 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10)),
    };
  }
  if (chunk === 'VP8X') {
    return {
      width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
      height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
    };
  }
  return undefined;
}

interface Box {
  type: string;
  /** Index of the first byte after the box's header. */
  body: number;
  /** Index just past the box. */
  end: number;
}

/** The most boxes one level of a HEIF file is walked for. */
const MAX_BOXES_PER_LEVEL = 4_096;

/**
 * The boxes (ISO base media file format) laid end to end in `[start, end)`.
 * A box that does not fit its container ends the walk: nothing past a
 * malformed size is believed.
 */
function boxesIn(bytes: Uint8Array, start: number, end: number): Box[] {
  const data = view(bytes);
  const boxes: Box[] = [];
  let at = start;
  while (at + 8 <= end && boxes.length < MAX_BOXES_PER_LEVEL) {
    let size = data.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      const wide = data.getBigUint64(at + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(wide);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    boxes.push({ type: ascii(bytes, at + 4, 4), body: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

/**
 * The largest `ispe` (image spatial extent) property a HEIF file declares:
 * a grid names its tiles and the whole. Only genuine properties count: the
 * file is walked as boxes (`meta` > `iprp` > `ipco` > `ispe`), so four bytes
 * spelling "ispe" inside coded image data or metadata are not read as one.
 */
function heicDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const data = view(bytes);
  let best: ImageDimensions | undefined;
  const meta = boxesIn(bytes, 0, bytes.length).find((box) => box.type === 'meta');
  if (!meta) return undefined;
  // `meta` is a full box: four bytes of version and flags come first.
  for (const iprp of boxesIn(bytes, meta.body + 4, meta.end).filter((box) => box.type === 'iprp')) {
    for (const ipco of boxesIn(bytes, iprp.body, iprp.end).filter((box) => box.type === 'ipco')) {
      for (const property of boxesIn(bytes, ipco.body, ipco.end)) {
        if (property.type !== 'ispe' || property.end - property.body < 12) continue;
        const width = data.getUint32(property.body + 4);
        const height = data.getUint32(property.body + 8);
        if (!best || width * height > best.width * best.height) best = { width, height };
      }
    }
  }
  return best;
}

/**
 * The size a picture declares in its header, or undefined when the bytes are
 * not an admitted format or the header cannot be read.
 */
export function imageDeclaredDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const format = stillImageFormatFromBytes(bytes);
  try {
    switch (format) {
      case 'jpeg':
        return jpegPixelSize(bytes);
      case 'png':
        return bytes.length >= 24 ? { width: view(bytes).getUint32(16), height: view(bytes).getUint32(20) } : undefined;
      case 'gif':
        return bytes.length >= 10 ? { width: view(bytes).getUint16(6, true), height: view(bytes).getUint16(8, true) } : undefined;
      case 'bmp': {
        if (bytes.length < 26) return undefined;
        const data = view(bytes);
        return data.getUint32(14, true) === 12
          ? { width: data.getUint16(18, true), height: data.getUint16(20, true) }
          : { width: Math.abs(data.getInt32(18, true)), height: Math.abs(data.getInt32(22, true)) };
      }
      case 'tiff':
        return tiffDimensions(bytes);
      case 'webp':
        return webpDimensions(bytes);
      case 'heic':
        return heicDimensions(bytes);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Whether a picture's header declares more pixels than any decoder is asked to hold. */
export function imageDeclaresTooManyPixels(bytes: Uint8Array, maxPixels = IMAGE_MAX_DECLARED_PIXELS): boolean {
  const size = imageDeclaredDimensions(bytes);
  return size !== undefined && size.width * size.height > maxPixels;
}
