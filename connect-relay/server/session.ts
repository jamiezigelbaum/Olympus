/**
 * The relay's side of one install session: forwards public HTTP requests over
 * the install's WebSocket as framed streams and turns the install's frames
 * back into streaming HTTP responses.
 *
 * Every stream is bounded: the request body is already read and capped by the
 * caller; the response body is capped in bytes, and timed (head, idle, total).
 * When the public caller goes away, or a bound is hit, the install is told to
 * `cancel` so its loopback request stops too.
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
import type { RelayLimits } from './limits.ts';

/** Response headers an install may set on the public response; everything else is dropped. */
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'cache-control',
  'pragma',
  'mcp-session-id',
  'www-authenticate',
  'retry-after',
  'allow',
]);

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
}

interface Stream {
  readonly id: number;
  headSent: boolean;
  bytes: number;
  resolveHead(response: Response): void;
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  timers: { head?: Timer; idle?: Timer; total?: Timer };
  finish(): void;
}

type Timer = ReturnType<typeof setTimeout>;

export class InstallSession {
  private readonly streams = new Map<number, Stream>();
  private nextId = 1;
  private closed = false;

  constructor(
    readonly installId: string,
    private readonly socket: SessionSocket,
    private readonly limits: RelayLimits,
  ) {}

  get open(): boolean {
    return !this.closed;
  }

  get activeStreams(): number {
    return this.streams.size;
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
    if (this.closed) return Promise.resolve(gatewayError(502));
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    return new Promise<Response>((resolve) => {
      const stream: Stream = {
        id,
        headSent: false,
        bytes: 0,
        resolveHead: resolve,
        controller: undefined,
        timers: {},
        finish: () => {
          clearTimeout(stream.timers.head);
          clearTimeout(stream.timers.idle);
          clearTimeout(stream.timers.total);
          this.streams.delete(id);
          request.signal.removeEventListener('abort', onAbort);
        },
      };
      const onAbort = () => this.cancelStream(stream);
      this.streams.set(id, stream);
      request.signal.addEventListener('abort', onAbort, { once: true });
      stream.timers.head = setTimeout(() => this.cancelStream(stream, 504), this.limits.responseHeadTimeoutMs);
      const head: RequestMessage = { type: 'request', id, method: request.method, path: request.path, headers: request.headers };
      this.send(head);
      for (const chunk of chunks(request.body)) this.socket.send(encodeBodyFrame(id, chunk));
      this.send({ type: 'end', id } satisfies EndMessage);
      if (request.signal.aborted) onAbort();
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
    // Frames for a stream already finished (cancelled, timed out) are expected; ignore them.
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
        stream.controller?.close();
        stream.finish();
        return 'ok';
      case 'abort':
        this.failStream(stream, 502);
        return 'ok';
      default:
        return 'protocol_error';
    }
  }

  /** A binary frame from the install. */
  onBody(id: number, payload: Uint8Array): 'ok' | 'protocol_error' {
    const stream = this.streams.get(id);
    if (!stream) return 'ok';
    if (!stream.headSent) return 'protocol_error';
    stream.bytes += payload.byteLength;
    if (stream.bytes > this.limits.maxResponseBodyBytes) {
      this.cancelStream(stream);
      return 'ok';
    }
    this.armIdle(stream);
    stream.controller?.enqueue(payload.slice());
    return 'ok';
  }

  private startBody(stream: Stream, status: number, wireHeaders: Array<[string, string]>): void {
    clearTimeout(stream.timers.head);
    stream.headSent = true;
    const headers = new Headers();
    for (const [name, value] of wireHeaders) if (RESPONSE_HEADER_ALLOWLIST.has(name)) headers.append(name, value);
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        stream.controller = controller;
      },
      cancel: () => this.cancelStream(stream),
    });
    this.armIdle(stream);
    stream.timers.total = setTimeout(() => this.cancelStream(stream), this.limits.responseTotalTimeoutMs);
    stream.resolveHead(new Response(status === 204 || status === 304 ? null : body, { status, headers }));
  }

  private armIdle(stream: Stream): void {
    clearTimeout(stream.timers.idle);
    stream.timers.idle = setTimeout(() => this.cancelStream(stream), this.limits.responseIdleTimeoutMs);
  }

  /** Stops a stream from the relay's side and tells the install to stop too. */
  private cancelStream(stream: Stream, statusIfNoHead = 502): void {
    if (!this.streams.has(stream.id)) return;
    this.send({ type: 'cancel', id: stream.id } satisfies CancelMessage);
    this.failStream(stream, statusIfNoHead);
  }

  private failStream(stream: Stream, statusIfNoHead: number): void {
    if (!this.streams.has(stream.id)) return;
    stream.finish();
    if (!stream.headSent) {
      stream.resolveHead(gatewayError(statusIfNoHead));
      return;
    }
    try {
      stream.controller?.error(new Error('the relayed response was cut off'));
    } catch {
      // Already closed by the consumer.
    }
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
