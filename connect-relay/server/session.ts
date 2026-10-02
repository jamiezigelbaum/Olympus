/**
 * The relay's side of one install session: forwards public HTTP requests over
 * the install's WebSocket as framed streams and turns the install's frames
 * back into streaming HTTP responses.
 *
 * Every stream is bounded: the request body is already read and capped by the
 * caller; the response body is capped in bytes and frames, timed (head, idle,
 * total), and what waits for a slow caller is counted against per-session and
 * relay-wide queue budgets. When the public caller goes away, or a bound is
 * hit, the install is told to `cancel` so its loopback request stops too.
 *
 * A stream ends in exactly one place (`finish`), which is where the caller's
 * admission is released: a bodyless response (204, 205, 304, HEAD) finishes
 * when its head arrives, and a streamed one when the caller has read it all
 * or it is cut off.
 */
import {
  chunks,
  encodeBodyFrame,
  parseHeaderList,
  type CancelMessage,
  type EndMessage,
  type ErrorMessage,
  type RelayToClientMessage,
  type RequestMessage,
} from '../shared/protocol.ts';
import { QueueBudget, type RelayLimits } from './limits.ts';
import { BODYLESS_STATUSES, DEFAULT_RESPONSE_POLICY, checkResponseHead, type ResponsePolicy } from './response-policy.ts';

export interface SessionSocket {
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
}

export interface ForwardRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Array<[string, string]>;
  readonly body: Uint8Array;
  /** Aborts when the public caller goes away. */
  readonly signal: AbortSignal;
  /** What the install may answer on this route (response-policy.ts); API answers when unset. */
  readonly policy?: ResponsePolicy;
  /** The install's response head arrived: its status, and whether it carried the engine's authenticated marker. */
  readonly onHead?: (status: number, authenticated: boolean) => void;
  /** The install's head was refused (a fixed reason code); the caller gets a 502. */
  readonly onRefused?: (reason: string) => void;
  /**
   * Charges `bytes` of response body about to go to the public caller; false
   * cuts the stream off (the relay's egress budgets).
   */
  readonly chargeEgress?: (bytes: number) => boolean;
  /**
   * Called exactly once, when the stream is over on both sides: delivered to
   * the public caller in full, cut off, cancelled, or finished without a body.
   * Admission is released here and nowhere else.
   */
  readonly onFinish?: () => void;
}

/** Below this size, response chunks are copied into a shared buffer instead of queued one by one. */
const COALESCE_BELOW_BYTES = 4 * 1024;
const COALESCE_BUFFER_BYTES = 16 * 1024;
/** What one queued chunk costs beyond its bytes (object, view, array slot), for the budget. */
const QUEUE_ENTRY_OVERHEAD_BYTES = 128;

interface QueueEntry {
  readonly buffer: Uint8Array;
  length: number;
  /** A coalescing buffer still accepting small chunks. */
  open: boolean;
  /** Budget charged for it. */
  readonly cost: number;
}

interface Stream {
  readonly id: number;
  readonly request: ForwardRequest;
  headSent: boolean;
  /** No more body frames are accepted: `end` arrived, or the response has no body. */
  ended: boolean;
  bytes: number;
  frames: number;
  readonly queue: QueueEntry[];
  queuedCost: number;
  /** The public caller is waiting in `pull` with nothing queued. */
  waiting: boolean;
  resolveHead(response: Response): void;
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  timers: { head?: Timer; idle?: Timer; total?: Timer };
  finished: boolean;
  onAbort?: () => void;
}

type Timer = ReturnType<typeof setTimeout>;

export class InstallSession {
  private readonly streams = new Map<number, Stream>();
  private nextId = 1;
  private closed = false;
  /** Budget charged by this session's queued response chunks. */
  private queuedCost = 0;

  constructor(
    readonly installId: string,
    private readonly socket: SessionSocket,
    private readonly limits: RelayLimits,
    private readonly queueBudget: QueueBudget = new QueueBudget(limits.maxQueuedBytes),
  ) {}

  get open(): boolean {
    return !this.closed;
  }

  get activeStreams(): number {
    return this.streams.size;
  }

  /** Response bytes (plus per-chunk overhead) queued for this session's slow callers. */
  get queuedBytes(): number {
    return this.queuedCost;
  }

  send(message: RelayToClientMessage | ErrorMessage): void {
    if (!this.closed) this.socket.send(JSON.stringify(message));
  }

  /** Ends the session: every open stream fails, and the socket closes with `code`. */
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of [...this.streams.values()]) this.failStream(stream, 502);
    this.socket.close(code, reason);
  }

  /** The socket closed underneath us. */
  socketClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of [...this.streams.values()]) this.failStream(stream, 502);
  }

  forward(request: ForwardRequest): Promise<Response> {
    if (this.closed) {
      request.onFinish?.();
      return Promise.resolve(gatewayError(502));
    }
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    return new Promise<Response>((resolve) => {
      const stream: Stream = {
        id,
        request,
        headSent: false,
        ended: false,
        bytes: 0,
        frames: 0,
        queue: [],
        queuedCost: 0,
        waiting: false,
        resolveHead: resolve,
        controller: undefined,
        timers: {},
        finished: false,
      };
      stream.onAbort = () => this.cancelStream(stream);
      this.streams.set(id, stream);
      request.signal.addEventListener('abort', stream.onAbort, { once: true });
      stream.timers.head = setTimeout(() => this.cancelStream(stream, 504), this.limits.responseHeadTimeoutMs);
      const head: RequestMessage = { type: 'request', id, method: request.method, path: request.path, headers: request.headers };
      this.send(head);
      for (const chunk of chunks(request.body)) this.socket.send(encodeBodyFrame(id, chunk));
      this.send({ type: 'end', id } satisfies EndMessage);
      if (request.signal.aborted) stream.onAbort();
    });
  }

  /** A text frame from the install, after authentication. */
  onMessage(message: Record<string, unknown>, id: number | undefined): 'ok' | 'protocol_error' {
    if (message.type === 'ping') {
      this.send({ type: 'pong' });
      return 'ok';
    }
    if (id === undefined) return 'protocol_error';
    const stream = this.streams.get(id);
    // Frames for a stream already finished (cancelled, timed out, bodyless) are expected; ignore them.
    if (!stream) return message.type === 'response-head' || message.type === 'end' || message.type === 'abort' ? 'ok' : 'protocol_error';
    switch (message.type) {
      case 'response-head': {
        const headers = parseHeaderList(message.headers);
        const status = typeof message.status === 'number' && Number.isInteger(message.status) ? message.status : 0;
        if (stream.headSent || !headers || status < 200 || status > 599) return 'protocol_error';
        this.startBody(stream, status, headers);
        return 'ok';
      }
      case 'end':
        if (!stream.headSent) return 'protocol_error';
        stream.ended = true;
        clearTimeout(stream.timers.idle);
        // Whatever is still queued goes out first; the stream finishes when it drains.
        if (stream.queue.length === 0) this.closeBody(stream);
        return 'ok';
      case 'abort':
        this.failStream(stream, 502);
        return 'ok';
      default:
        return 'protocol_error';
    }
  }

  /** A binary frame from the install. Nothing is allocated for a frame the stream will not deliver. */
  onBody(id: number, payload: Uint8Array): 'ok' | 'protocol_error' {
    if (payload.byteLength === 0) return 'protocol_error';
    const stream = this.streams.get(id);
    if (!stream) return 'ok';
    if (!stream.headSent || stream.ended) return 'protocol_error';
    stream.bytes += payload.byteLength;
    stream.frames += 1;
    if (stream.bytes > this.limits.maxResponseBodyBytes || stream.frames > this.limits.maxResponseFrames) {
      this.cancelStream(stream);
      return 'ok';
    }
    if (stream.request.chargeEgress && !stream.request.chargeEgress(payload.byteLength)) {
      this.cancelStream(stream);
      return 'ok';
    }
    this.armIdle(stream);
    if (stream.waiting && stream.controller) {
      // The caller is reading: hand the chunk straight over.
      stream.waiting = false;
      stream.controller.enqueue(payload.slice());
      return 'ok';
    }
    if (!this.enqueue(stream, payload)) this.cancelStream(stream);
    return 'ok';
  }

  /** Queues a chunk for a caller that is not reading yet; false when a queue budget is spent. */
  private enqueue(stream: Stream, payload: Uint8Array): boolean {
    const last = stream.queue.at(-1);
    if (payload.byteLength < COALESCE_BELOW_BYTES && last?.open && last.length + payload.byteLength <= last.buffer.byteLength) {
      last.buffer.set(payload, last.length);
      last.length += payload.byteLength;
      return true;
    }
    if (last) last.open = false;
    const small = payload.byteLength < COALESCE_BELOW_BYTES;
    const size = small ? COALESCE_BUFFER_BYTES : payload.byteLength;
    const cost = size + QUEUE_ENTRY_OVERHEAD_BYTES;
    if (this.queuedCost + cost > this.limits.maxSessionQueuedBytes || this.queueBudget.used + cost > this.queueBudget.max) return false;
    const buffer = small ? new Uint8Array(COALESCE_BUFFER_BYTES) : payload.slice();
    if (small) buffer.set(payload);
    stream.queue.push({ buffer, length: payload.byteLength, open: small, cost });
    stream.queuedCost += cost;
    this.queuedCost += cost;
    this.queueBudget.used += cost;
    return true;
  }

  /** The public caller asks for more. */
  private pull(stream: Stream, controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (stream.finished) return;
    const entry = stream.queue.shift();
    if (entry) {
      this.uncharge(stream, entry.cost);
      controller.enqueue(entry.length === entry.buffer.byteLength ? entry.buffer : entry.buffer.subarray(0, entry.length));
      if (stream.ended && stream.queue.length === 0) this.closeBody(stream);
      return;
    }
    if (stream.ended) {
      this.closeBody(stream);
      return;
    }
    stream.waiting = true;
  }

  private uncharge(stream: Stream, cost: number): void {
    stream.queuedCost -= cost;
    this.queuedCost -= cost;
    this.queueBudget.used -= cost;
  }

  private startBody(stream: Stream, status: number, wireHeaders: Array<[string, string]>): void {
    const bodyless = BODYLESS_STATUSES.has(status) || stream.request.method === 'HEAD';
    // Checked before anything reaches the caller: a refused head (a header
    // the platform would reject, a content type or redirect the route does
    // not allow) fails the stream with a 502 and stops the install's side.
    const checked = checkResponseHead(stream.request.policy ?? DEFAULT_RESPONSE_POLICY, status, wireHeaders, bodyless);
    if (!checked.ok) {
      stream.request.onRefused?.(checked.reason);
      this.cancelStream(stream);
      return;
    }
    clearTimeout(stream.timers.head);
    stream.headSent = true;
    const { headers, authenticated } = checked;
    stream.request.onHead?.(status, authenticated);
    if (bodyless) {
      // No body will ever be read: the mux stream is complete now. Any body
      // frames or `end` the install still sends find no stream and are dropped.
      stream.ended = true;
      stream.resolveHead(new Response(null, { status, headers }));
      this.finish(stream);
      return;
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          stream.controller = controller;
        },
        pull: (controller) => this.pull(stream, controller),
        cancel: () => this.cancelStream(stream),
      },
      // Nothing is buffered inside the stream itself: every queued byte is in `stream.queue`, where it is counted.
      { highWaterMark: 0 },
    );
    this.armIdle(stream);
    stream.timers.total = setTimeout(() => this.cancelStream(stream), this.limits.responseTotalTimeoutMs);
    stream.resolveHead(new Response(body, { status, headers }));
  }

  private armIdle(stream: Stream): void {
    clearTimeout(stream.timers.idle);
    stream.timers.idle = setTimeout(() => this.cancelStream(stream), this.limits.responseIdleTimeoutMs);
  }

  /** The body was delivered in full. */
  private closeBody(stream: Stream): void {
    try {
      stream.controller?.close();
    } catch {
      // Already closed or cancelled by the consumer.
    }
    this.finish(stream);
  }

  /** Stops a stream from the relay's side and tells the install to stop too. */
  private cancelStream(stream: Stream, statusIfNoHead = 502): void {
    if (stream.finished) return;
    this.send({ type: 'cancel', id: stream.id } satisfies CancelMessage);
    this.failStream(stream, statusIfNoHead);
  }

  private failStream(stream: Stream, statusIfNoHead: number): void {
    if (stream.finished) return;
    if (!stream.headSent) {
      stream.resolveHead(gatewayError(statusIfNoHead));
    } else {
      // Bun ends an errored response body the same way as a closed one; close
      // it rather than log a stack per cut-off stream.
      try {
        stream.controller?.close();
      } catch {
        // Already closed or cancelled by the consumer.
      }
    }
    this.finish(stream);
  }

  /** The one place a stream ends: timers, queued bytes, the abort listener, and admission. */
  private finish(stream: Stream): void {
    if (stream.finished) return;
    stream.finished = true;
    stream.ended = true;
    clearTimeout(stream.timers.head);
    clearTimeout(stream.timers.idle);
    clearTimeout(stream.timers.total);
    this.uncharge(stream, stream.queuedCost);
    stream.queue.length = 0;
    this.streams.delete(stream.id);
    if (stream.onAbort) stream.request.signal.removeEventListener('abort', stream.onAbort);
    stream.request.onFinish?.();
  }
}

export function gatewayError(status: number): Response {
  const message = status === 504
    ? 'Olympus on your Mac did not answer in time.'
    : 'The connection to Olympus on your Mac was interrupted.';
  return new Response(JSON.stringify({ error: status === 504 ? 'gateway_timeout' : 'bad_gateway', message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
