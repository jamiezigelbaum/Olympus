/**
 * Bounded request-body reading for the remote agent endpoints (`/mcp` and the
 * OpenAPI tool paths). `request.text()` and `request.json()` buffer the whole
 * body before anyone can measure it, and a chunked body carries no
 * Content-Length to refuse up front, so an authenticated caller could make the
 * worker hold an arbitrarily large body in memory. This reads the stream
 * itself and stops at the cap.
 */

/** A tool call is a question plus filters: a few KiB. Nothing legitimate nears this. */
export const REMOTE_REQUEST_MAX_BODY_BYTES = 256 * 1024;

export type BoundedBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'unreadable' };

export async function readBoundedRequestText(
  request: Request,
  maxBytes: number = REMOTE_REQUEST_MAX_BODY_BYTES,
): Promise<BoundedBodyResult> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return { ok: false, reason: 'too_large' };
  }
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: 'unreadable' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** Whether a Content-Type header names JSON (`application/json`, any parameters). */
export function isJsonContentType(header: string | null): boolean {
  if (!header) return false;
  return header.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}
