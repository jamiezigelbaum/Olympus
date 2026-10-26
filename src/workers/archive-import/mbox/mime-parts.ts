/**
 * The MIME structure of one mail message, read from its bytes: every part with
 * a file name, numbered by its part path exactly as Gmail numbers `partId`
 * (the top part is ``; the parts of a multipart are `0`, `1`, …; theirs are
 * `1.0`, `1.1`, …). A child item of a message is keyed by this path, so an
 * attachment an export brings and the one live Gmail lists are the same child
 * (docs/design/child-items.md, "What a child is").
 *
 * Bounded: at most `MAX_PARTS` parts and `MAX_DEPTH` levels of multipart are
 * walked; what lies beyond is not listed. A part of type `message/rfc822` is a
 * leaf: a forwarded message is one attachment, read with its own parts.
 * Nothing is decoded but the sizes; the bytes stay where they are.
 */
import { decodeWords } from 'postal-mime';

const MAX_PARTS = 2_000;
const MAX_DEPTH = 64;
const MAX_HEADER_BYTES = 256 * 1024;

export interface MimeAttachment {
  partId: string;
  filename: string;
  mimeType?: string;
  /** The decoded size of the part's body. */
  size: number;
  /** Inside another part with a file name. */
  nested?: boolean;
}

interface Headers {
  get(name: string): string | undefined;
}

function headerBlockEnd(text: string, from: number, to: number): { headersEnd: number; bodyStart: number } {
  const window = text.slice(from, Math.min(to, from + MAX_HEADER_BYTES));
  if (window.startsWith('\r\n')) return { headersEnd: from, bodyStart: from + 2 };
  if (window.startsWith('\n')) return { headersEnd: from, bodyStart: from + 1 };
  const crlf = window.indexOf('\r\n\r\n');
  const lf = window.indexOf('\n\n');
  if (crlf < 0 && lf < 0) return { headersEnd: Math.min(to, from + window.length), bodyStart: Math.min(to, from + window.length) };
  if (lf >= 0 && (crlf < 0 || lf < crlf)) return { headersEnd: from + lf, bodyStart: from + lf + 2 };
  return { headersEnd: from + crlf, bodyStart: from + crlf + 4 };
}

function parseHeaders(block: string): Headers {
  const map = new Map<string, string>();
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!map.has(name)) map.set(name, line.slice(colon + 1).trim());
  }
  return { get: (name) => map.get(name) };
}

/** `value; a=b; c="d"` → the value and its parameters (names lower-cased, quotes removed). */
function splitParams(header: string): { value: string; params: Map<string, string> } {
  const pieces: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index]!;
    if (char === '"' && header[index - 1] !== '\\') quoted = !quoted;
    if (char === ';' && !quoted) {
      pieces.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  pieces.push(current);
  const params = new Map<string, string>();
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const name = piece.slice(0, eq).trim().toLowerCase();
    let value = piece.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!params.has(name)) params.set(name, value);
  }
  return { value: (pieces[0] ?? '').trim(), params };
}

function percentDecode(value: string, charset: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '%' && /^[0-9a-fA-F]{2}$/.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(char, 'latin1'));
    }
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  }
}

/**
 * A parameter's value, RFC 2231 included: `name*=utf-8''…`, and continuations
 * `name*0=…; name*1*=…`. Falls back to the plain parameter, with encoded words
 * (RFC 2047) decoded, as mail clients write them.
 */
function paramValue(params: Map<string, string>, name: string): string | undefined {
  const extended = params.get(`${name}*`);
  if (extended !== undefined) {
    const match = /^([^']*)'[^']*'(.*)$/.exec(extended);
    return match ? percentDecode(match[2]!, match[1]!) : extended;
  }
  const sections: string[] = [];
  let charset = '';
  for (let index = 0; index < 1_000; index += 1) {
    const encoded = params.get(`${name}*${index}*`);
    const plain = params.get(`${name}*${index}`);
    if (encoded === undefined && plain === undefined) break;
    if (encoded !== undefined) {
      let value = encoded;
      if (index === 0) {
        const match = /^([^']*)'[^']*'(.*)$/.exec(encoded);
        if (match) {
          charset = match[1]!;
          value = match[2]!;
        }
      }
      sections.push(percentDecode(value, charset));
    } else {
      sections.push(plain!);
    }
  }
  if (sections.length > 0) return sections.join('');
  const plain = params.get(name);
  if (plain === undefined) return undefined;
  try {
    return decodeWords(plain);
  } catch {
    return plain;
  }
}

function decodedSize(body: string, encoding: string): number {
  if (encoding === 'base64') {
    const clean = body.replace(/[^A-Za-z0-9+/=]/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  }
  if (encoding === 'quoted-printable') {
    const softBreaks = body.replace(/=\r?\n/g, '');
    return Buffer.byteLength(softBreaks.replace(/=[0-9A-Fa-f]{2}/g, 'x'), 'latin1');
  }
  return body.length;
}

/** Where each part between a multipart's boundary lines starts and ends. */
function multipartBodies(text: string, from: number, to: number, boundary: string): Array<{ start: number; end: number }> {
  const delimiter = `--${boundary}`;
  const bodies: Array<{ start: number; end: number }> = [];
  let partStart: number | undefined;
  let lineStart = from;
  while (lineStart < to) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0 || lineEnd >= to) lineEnd = to;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '').trimEnd();
    if (line === delimiter || line === `${delimiter}--`) {
      if (partStart !== undefined) {
        // The line end before a delimiter belongs to the delimiter.
        let end = lineStart;
        if (end > partStart && text[end - 1] === '\n') end -= 1;
        if (end > partStart && text[end - 1] === '\r') end -= 1;
        bodies.push({ start: partStart, end });
      }
      if (line !== delimiter) return bodies;
      partStart = lineEnd + 1;
    }
    lineStart = lineEnd + 1;
  }
  // No closing delimiter: the last part runs to the end.
  if (partStart !== undefined && partStart < to) bodies.push({ start: partStart, end: to });
  return bodies;
}

/** One part's bytes could not be given within the bound asked. */
export class MimePartTooLargeError extends Error {
  constructor() {
    super('The part is larger than this read may take.');
    this.name = 'MimePartTooLargeError';
  }
}

function decodeBody(body: string, encoding: string): Uint8Array {
  if (encoding === 'base64') return new Uint8Array(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'));
  if (encoding === 'quoted-printable') {
    const joined = body.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let index = 0; index < joined.length; index += 1) {
      const hex = joined.slice(index + 1, index + 3);
      if (joined[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
      } else {
        bytes.push(joined.charCodeAt(index) & 0xff);
      }
    }
    return new Uint8Array(bytes);
  }
  return new Uint8Array(Buffer.from(body, 'latin1'));
}

/**
 * The decoded bytes of the part a part path names, with its declared type;
 * undefined when the message has no such part. A part whose decoded size is
 * over `maxBytes` is refused (MimePartTooLargeError) before it is decoded.
 */
export function mimePartBytes(raw: Uint8Array, partId: string, maxBytes = Number.POSITIVE_INFINITY): { bytes: Uint8Array; mimeType: string } | undefined {
  const text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('latin1');
  let parts = 0;
  const find = (from: number, to: number, path: string, depth: number): { bytes: Uint8Array; mimeType: string } | undefined => {
    parts += 1;
    if (parts > MAX_PARTS) return undefined;
    const { headersEnd, bodyStart } = headerBlockEnd(text, from, to);
    const headers = parseHeaders(text.slice(from, headersEnd));
    const type = splitParams(headers.get('content-type') ?? 'text/plain');
    const mimeType = type.value.toLowerCase() || 'text/plain';
    if (path === partId) {
      const encoding = (headers.get('content-transfer-encoding') ?? '').trim().toLowerCase();
      const body = text.slice(bodyStart, to);
      if (decodedSize(body, encoding) > maxBytes) throw new MimePartTooLargeError();
      return { bytes: decodeBody(body, encoding), mimeType };
    }
    const boundary = type.params.get('boundary');
    if (!mimeType.startsWith('multipart/') || !boundary || depth >= MAX_DEPTH) return undefined;
    if (path !== '' && !partId.startsWith(`${path}.`)) return undefined;
    const bodies = multipartBodies(text, bodyStart, to, boundary);
    for (const [index, body] of bodies.entries()) {
      const childPath = path === '' ? String(index) : `${path}.${index}`;
      if (partId === childPath || partId.startsWith(`${childPath}.`)) return find(body.start, body.end, childPath, depth + 1);
    }
    return undefined;
  };
  return find(0, text.length, '', 0);
}

/** Every part with a file name in a raw message, in tree order. */
export function mimeAttachments(raw: Uint8Array): MimeAttachment[] {
  const text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('latin1');
  const found: MimeAttachment[] = [];
  let parts = 0;
  const walk = (from: number, to: number, partId: string, depth: number, inside: boolean): void => {
    parts += 1;
    if (parts > MAX_PARTS) return;
    const { headersEnd, bodyStart } = headerBlockEnd(text, from, to);
    const headers = parseHeaders(text.slice(from, headersEnd));
    const type = splitParams(headers.get('content-type') ?? 'text/plain');
    const mimeType = type.value.toLowerCase() || 'text/plain';
    const disposition = splitParams(headers.get('content-disposition') ?? '');
    const filename = (paramValue(disposition.params, 'filename') ?? paramValue(type.params, 'name'))?.trim();
    if (filename) {
      const encoding = (headers.get('content-transfer-encoding') ?? '').trim().toLowerCase();
      found.push({
        partId,
        filename,
        mimeType,
        size: decodedSize(text.slice(bodyStart, to), encoding),
        ...(inside ? { nested: true } : {}),
      });
    }
    const boundary = type.params.get('boundary');
    if (mimeType.startsWith('multipart/') && boundary && depth < MAX_DEPTH) {
      multipartBodies(text, bodyStart, to, boundary).forEach((body, index) => {
        walk(body.start, body.end, partId === '' ? String(index) : `${partId}.${index}`, depth + 1, inside || Boolean(filename));
      });
    }
  };
  walk(0, text.length, '', 0, false);
  return found;
}
