export type TimeoutFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function fetchWithTimeout(
  fetchImpl: TimeoutFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const upstreamSignal = init.signal;
  let removeUpstreamAbortListener: (() => void) | undefined;

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort(upstreamSignal.reason);
    } else {
      const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
      upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
      removeUpstreamAbortListener = () => upstreamSignal.removeEventListener('abort', abortFromUpstream);
    }
  }

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    removeUpstreamAbortListener?.();
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The cap on a token-endpoint response body. Every response these helpers
 * read is a small JSON object — a token grant or an `{error,
 * error_description}` refusal — so 64 KiB is orders of magnitude more than
 * any honest answer and still bounds what a hostile or broken endpoint can
 * make this process buffer.
 */
export const DEFAULT_BOUNDED_RESPONSE_LIMIT_BYTES = 64 * 1024;

export class BoundedResponseTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`Response body exceeded the ${limitBytes}-byte cap.`);
    this.name = 'BoundedResponseTooLargeError';
    this.limitBytes = limitBytes;
  }
}

export function isBoundedResponseTooLargeError(error: unknown): error is BoundedResponseTooLargeError {
  return error instanceof BoundedResponseTooLargeError;
}

/**
 * `fetchWithTimeout` plus the body, read under the SAME deadline and under a
 * byte cap.
 *
 * `fetchWithTimeout` clears its timer the moment the response headers arrive,
 * so a peer that answers `200` and then dribbles (or never ends) its body held
 * the caller open indefinitely — the timeout bounded the handshake, not the
 * call. Everything downstream of that read is a token exchange or a token
 * refresh, where the honest answer is a few hundred bytes, so both bounds are
 * enforced here rather than left to the caller to remember.
 *
 * The deadline is raced against the body read rather than left to the abort
 * signal alone: a signal only interrupts a peer that honours it, and an
 * in-process stream (a test double, a buffering proxy library) may not. The
 * signal is still aborted when the deadline or the cap fires, so a real socket
 * is closed rather than abandoned.
 *
 * Timeout surfaces as an `AbortError` — the same shape `isAbortError` already
 * recognises — and an oversized body as `BoundedResponseTooLargeError`.
 * Omitting `timeoutMs` keeps today's unbounded-wait behaviour for a caller
 * that has no deadline to impose, and still applies the byte cap.
 */
export async function fetchBoundedText(
  fetchImpl: TimeoutFetch,
  url: string,
  init: RequestInit,
  options: { timeoutMs?: number; limitBytes?: number } = {},
): Promise<{ response: Response; text: string }> {
  const limitBytes = options.limitBytes ?? DEFAULT_BOUNDED_RESPONSE_LIMIT_BYTES;
  const timeoutMs = options.timeoutMs;
  const deadlineWanted = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!deadlineWanted) {
    const response = await fetchImpl(url, init);
    return { response, text: await readBoundedText(response, limitBytes) };
  }

  const controller = new AbortController();
  const upstreamSignal = init.signal;
  let removeUpstreamAbortListener: (() => void) | undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort(upstreamSignal.reason);
    } else {
      const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
      upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
      removeUpstreamAbortListener = () => upstreamSignal.removeEventListener('abort', abortFromUpstream);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Rejects only when it wins a race below, so it is always handled and never
  // becomes an unhandled rejection; the `finally` clears the timer on every
  // other path before it can fire.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error(`Request exceeded its ${timeoutMs}ms deadline.`);
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      deadline,
    ]);
    const text = await Promise.race([readBoundedText(response, limitBytes, controller), deadline]);
    return { response, text };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeUpstreamAbortListener?.();
  }
}

/**
 * Reads at most `limitBytes` and refuses rather than truncating: a truncated
 * token response would parse as "no access_token" and be reported as a
 * provider fault, which is a worse answer than saying the body was too large.
 */
async function readBoundedText(
  response: Response,
  limitBytes: number,
  controller?: AbortController,
): Promise<string> {
  const body = response.body;
  if (!body) {
    // A response with no stream (a 204, or an in-process double built from a
    // string) still gets the cap applied to what it hands back.
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limitBytes) {
      throw new BoundedResponseTooLargeError(limitBytes);
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        controller?.abort();
        throw new BoundedResponseTooLargeError(limitBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
