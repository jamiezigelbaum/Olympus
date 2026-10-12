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
  if (bytes.length >= 4 && ((ascii(bytes, 0, 2) === 'II' && bytes[2] === 0x2a && bytes[3] === 0)
    || (ascii(bytes, 0, 2) === 'MM' && bytes[2] === 0 && bytes[3] === 0x2a))) return 'tiff';
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

function tiffDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const data = view(bytes);
  const little = ascii(bytes, 0, 2) === 'II';
  const ifd = data.getUint32(4, little);
  if (ifd + 2 > bytes.length) return undefined;
  const count = data.getUint16(ifd, little);
  let width: number | undefined;
  let height: number | undefined;
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > bytes.length) break;
    const tag = data.getUint16(entry, little);
    if (tag !== 256 && tag !== 257) continue;
    const type = data.getUint16(entry + 2, little);
    const value = type === 3 ? data.getUint16(entry + 8, little) : type === 4 ? data.getUint32(entry + 8, little) : undefined;
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

/** The largest declared `ispe` (image spatial extent): a grid names its tiles and the whole. */
function heicDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const data = view(bytes);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let best: ImageDimensions | undefined;
  let from = 0;
  for (;;) {
    const at = buffer.indexOf('ispe', from, 'latin1');
    if (at < 0 || at + 16 > bytes.length) break;
    const width = data.getUint32(at + 8);
    const height = data.getUint32(at + 12);
    if (!best || width * height > best.width * best.height) best = { width, height };
    from = at + 4;
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
