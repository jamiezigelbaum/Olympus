/**
 * What a prepared picture may carry besides its pixels.
 *
 * The media cache holds one JPEG per photo and nothing else about the photo
 * is meant to travel with it: not where it was taken (EXIF GPS), not the
 * camera, not a thumbnail of the original, not an editing history (XMP,
 * IPTC), not a profile naming a colour space the reader will not apply.
 * These helpers read the few facts the preparation needs from a JPEG
 * (the EXIF orientation, the colour profile) and remove the rest without
 * touching the compressed image data, so removal never costs quality.
 *
 * Pure byte work: no tool runs and nothing is read from the machine. Doc
 * comments in this directory are always multi-line blocks, and this module
 * contains no regular expressions.
 */

const SOI = 0xd8;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP13 = 0xed;
const APP14 = 0xee;
const COM = 0xfe;

export interface JpegSegment {
  marker: number;
  /**
   * Index of the 0xFF that starts the segment.
   */
  start: number;
  /**
   * Index just past the segment's last byte.
   */
  end: number;
}

function text(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let index = start; index < start + length && index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index]!);
  }
  return out;
}

/**
 * The marker segments before the scan data, in order, or undefined when the
 * bytes are not a JPEG whose header can be walked.
 */
export function jpegHeaderSegments(bytes: Uint8Array): JpegSegment[] | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return undefined;
  const segments: JpegSegment[] = [];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start: offset, end: offset + 2 });
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;
    segments.push({ marker, start: offset, end: offset + 2 + length });
    if (marker === SOS) return segments;
    offset += 2 + length;
  }
  return undefined;
}

function payload(bytes: Uint8Array, segment: JpegSegment): Uint8Array {
  return bytes.subarray(segment.start + 4, segment.end);
}

/**
 * The EXIF orientation (1 to 8) the first APP1 EXIF segment names, or 1 when
 * there is none, it is unreadable, or it is not a valid orientation. 1 is
 * "upright", which is also what every reader assumes without the tag.
 */
export function jpegExifOrientation(bytes: Uint8Array): number {
  const segments = jpegHeaderSegments(bytes);
  if (!segments) return 1;
  for (const segment of segments) {
    if (segment.marker !== APP1) continue;
    const body = payload(bytes, segment);
    if (text(body, 0, 6) !== 'Exif\0\0') continue;
    const orientation = tiffOrientation(body.subarray(6));
    if (orientation !== undefined) return orientation;
  }
  return 1;
}

/**
 * The orientation tag out of a TIFF block (a JPEG's EXIF payload after its
 * header, or a TIFF file itself), or undefined when absent or invalid.
 */
export function tiffOrientation(tiff: Uint8Array): number | undefined {
  if (tiff.length < 8) return undefined;
  const marker = text(tiff, 0, 2);
  const little = marker === 'II';
  if (!little && marker !== 'MM') return undefined;
  const data = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (data.getUint16(2, little) !== 42) return undefined;
  const ifd = data.getUint32(4, little);
  if (ifd + 2 > tiff.length) return undefined;
  const count = data.getUint16(ifd, little);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.length) return undefined;
    if (data.getUint16(entry, little) !== 0x0112) continue;
    if (data.getUint16(entry + 2, little) !== 3) return undefined;
    const value = data.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : undefined;
  }
  return undefined;
}

/**
 * The embedded ICC profile (APP2 chunks joined in order), or undefined when
 * the JPEG carries none.
 */
export function jpegIccProfile(bytes: Uint8Array): Uint8Array | undefined {
  const segments = jpegHeaderSegments(bytes);
  if (!segments) return undefined;
  const chunks: Array<{ index: number; data: Uint8Array }> = [];
  for (const segment of segments) {
    if (segment.marker !== APP2) continue;
    const body = payload(bytes, segment);
    if (text(body, 0, 12) !== 'ICC_PROFILE\0' || body.length < 14) continue;
    chunks.push({ index: body[12]!, data: body.subarray(14) });
  }
  if (chunks.length === 0) return undefined;
  chunks.sort((left, right) => left.index - right.index);
  const total = chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
  const profile = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    profile.set(chunk.data, at);
    at += chunk.data.length;
  }
  return profile;
}

/**
 * Whether an ICC profile names itself sRGB. The profile's description text
 * is what says so ("sRGB IEC61966-2.1" and its relatives); a wide-gamut
 * profile (Display P3, Adobe RGB) does not contain the word.
 */
export function iccProfileIsSrgb(profile: Uint8Array): boolean {
  return text(profile, 0, Math.min(profile.length, 4096)).includes('sRGB');
}

/**
 * The colour space an ICC profile is for ('RGB ', 'GRAY', 'CMYK', ...),
 * four characters from its header, or undefined when too short to say.
 */
export function iccProfileColorSpace(profile: Uint8Array): string | undefined {
  return profile.length >= 20 ? text(profile, 16, 4) : undefined;
}

/**
 * Names of the metadata segments a JPEG carries ('exif', 'xmp', 'icc',
 * 'iptc', 'comment', or 'app<n>'), in order. Empty when it carries only
 * pixels. Used to prove a prepared copy is clean.
 */
export function jpegMetadataSegments(bytes: Uint8Array): string[] {
  const segments = jpegHeaderSegments(bytes) ?? [];
  const names: string[] = [];
  for (const segment of segments) {
    const body = payload(bytes, segment);
    if (segment.marker === APP1) {
      names.push(text(body, 0, 6) === 'Exif\0\0' ? 'exif' : text(body, 0, 28).startsWith('http://ns.adobe.com/xap') ? 'xmp' : 'app1');
    } else if (segment.marker === APP2) {
      names.push(text(body, 0, 12) === 'ICC_PROFILE\0' ? 'icc' : 'app2');
    } else if (segment.marker === APP13) {
      names.push('iptc');
    } else if (segment.marker === COM) {
      names.push('comment');
    } else if (segment.marker === APP0) {
      if (text(body, 0, 5) !== 'JFIF\0') names.push('app0');
    } else if (segment.marker > APP2 && segment.marker <= 0xef && segment.marker !== APP14) {
      names.push(`app${segment.marker - APP0}`);
    }
  }
  return names;
}

function keepsSegment(bytes: Uint8Array, segment: JpegSegment): boolean {
  const { marker } = segment;
  if (marker === COM) return false;
  if (marker === APP0) {
    // The JFIF header is structure; a JFXX extension holds a thumbnail.
    return text(payload(bytes, segment), 0, 5) === 'JFIF\0';
  }
  // The Adobe APP14 segment says how to read the colour channels.
  if (marker >= APP1 && marker <= 0xef) return marker === APP14;
  return true;
}

/**
 * The same JPEG without its metadata segments (EXIF and the GPS inside it,
 * XMP, IPTC, ICC profile, comments, thumbnails, vendor blocks). The scan
 * data is copied verbatim, so the picture is bit-for-bit what it was. Bytes
 * that are not a JPEG with a readable header come back unchanged.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const segments = jpegHeaderSegments(bytes);
  if (!segments) return bytes;
  const dropped = segments.filter((segment) => !keepsSegment(bytes, segment));
  if (dropped.length === 0) return bytes;
  let length = bytes.length;
  for (const segment of dropped) length -= segment.end - segment.start;
  const out = new Uint8Array(length);
  let at = 0;
  let from = 0;
  for (const segment of dropped) {
    out.set(bytes.subarray(from, segment.start), at);
    at += segment.start - from;
    from = segment.end;
  }
  out.set(bytes.subarray(from), at);
  return out;
}
