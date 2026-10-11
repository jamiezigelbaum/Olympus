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

// Statuses whose Response may not carry a body; they are returned as received.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * `fetch` with one deadline over the request AND the body, for a caller that
 * reads the body itself (`text()`, `arrayBuffer()`) and has no byte cap to
 * impose in this layer.
 *
 * The returned Response's body is relayed through a stream that fails with an
 * `AbortError` once the deadline passes, whether the peer never answers, never
 * sends another chunk, or ignores the abort signal: the read is raced against
 * the deadline, and the upstream body is cancelled. A writer awaiting the body
 * therefore always settles, which is what lets a lane that runs its tasks one
 * at a time (source-account-guard.ts) move on to the next one (PR #267
 * review, Astra). A body nobody reads is aborted when the deadline passes.
 */
export async function fetchWithBodyDeadline(
  fetchImpl: TimeoutFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetchImpl(url, init);
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
  const settle = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    removeUpstreamAbortListener?.();
    removeUpstreamAbortListener = undefined;
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timer = undefined;
      const error = new Error(`Request exceeded its ${timeoutMs}ms deadline.`);
      error.name = 'AbortError';
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  // Rejects only into the races below or into nothing: never unhandled.
  deadline.catch(() => undefined);

  let response: Response;
  try {
    response = await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), deadline]);
  } catch (error) {
    settle();
    throw error;
  }
  if (!response.body || NULL_BODY_STATUSES.has(response.status)) {
    settle();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) {
          settle();
          stream.close();
          return;
        }
        if (value) stream.enqueue(value);
      } catch (error) {
        settle();
        // Fail the reader first: an upstream whose cancel never settles must
        // not hold the caller past its deadline (PR #267 review, Astra round 2).
        stream.error(error);
        reader.cancel().catch(() => undefined);
      }
    },
    cancel(reason) {
      settle();
      controller.abort();
      reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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

  // When the deadline wins the race below, the read is still in flight and
  // still holds the stream's lock. An abort only ends it if the peer honours
  // the signal, so the reader is recorded here and cancelled explicitly in the
  // `finally` — otherwise a stream that ignores `AbortSignal` leaves a pending
  // read against a permanently locked body (Codex round 2 on 98d4a946).
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      deadline,
    ]);
    const read = readBoundedText(response, limitBytes, controller, (reader) => {
      activeReader = reader;
    });
    // The race may abandon this promise. Attaching a handler now means an
    // abandoned rejection is never an unhandled one.
    read.catch(() => undefined);
    const text = await Promise.race([read, deadline]);
    return { response, text };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeUpstreamAbortListener?.();
    // Awaited only until the next macrotask: a cancel that settles at once has
    // unlocked the body by then, and one that never settles must not hold the
    // caller past its deadline (PR #267 review, Astra round 2).
    if (activeReader) {
      await Promise.race([
        releaseBodyReader(activeReader),
        new Promise<void>((resolve) => { setTimeout(resolve, 0); }),
      ]);
    }
  }
}

/**
 * Cancel then unlock, each independently guarded: a reader may already have
 * been cancelled by the read loop, already released, or belong to a stream
 * that errored. Cancelling first is what settles any pending read, which is
 * what makes `releaseLock` legal and the body unlocked afterwards.
 */
async function releaseBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Already cancelled, or the stream errored: nothing left to release it from.
  }
  try {
    reader.releaseLock();
  } catch {
    // Already released.
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
  onReader?: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
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
  onReader?.(reader);
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

    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  } finally {
    // Every exit — read to completion, over the cap, or abandoned by the
    // deadline — leaves the body unlocked rather than held by a reader nobody
    // owns any more.
    await releaseBodyReader(reader);
  }
}
