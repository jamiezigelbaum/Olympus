/**
 * The install side of the relay: keeps one authenticated WebSocket session to
 * the relay and serves the requests the relay multiplexes over it by calling
 * the loopback Olympus worker with fetch(), streaming each response back.
 *
 * The client trusts the relay with nothing it does not have to: it forwards
 * only the remote surface (forward.ts), strips inbound relay and forwarding
 * headers, marks every forwarded request with the per-boot relay secret, and
 * bounds request bodies and concurrency itself: each request's body is
 * assembled into one buffer (no per-frame objects, so tiny or empty frames
 * cost nothing extra), capped in bytes and frames, charged to a budget across
 * all requests, and given a local deadline that does not depend on the relay.
 */
import {
  CONNECT_PATH,
  PROTOCOL_VERSION,
  chunks,
  decodeBodyFrame,
  encodeBodyFrame,
  installAuthMessage,
  parseHeaderList,
  parseTextFrame,
  streamId,
  type ClientToRelayMessage,
} from '../shared/protocol.ts';
import { FORWARDED_METHODS, forwardPath, forwardRequestHeaders, forwardResponseHeaders } from './forward.ts';
import type { InstallIdentity } from './identity.ts';

export type RelayClientStatus =
  | { state: 'connecting' }
  | { state: 'online'; installId: string; connectedAt: number }
  | { state: 'offline'; reason: string; retryInMs: number }
  | { state: 'replaced'; retryInMs: number }
  | { state: 'stopped' };

export interface RelayClientOptions {
  /**
   * e.g. `mcp.olympusplugin.ai`; the client dials `wss://<relayHost>/v2/connect`
   * and binds its session signature to this name.
   */
  readonly relayHost: string;
  /** Test seam: the full session URL (e.g. `ws://127.0.0.1:<port>/v2/connect`). */
  readonly relayUrl?: string;
  readonly identity: InstallIdentity;
  /** Loopback Olympus worker origin, e.g. `http://127.0.0.1:8010`. */
  readonly target: string;
  /** Per-boot secret sent as `x-olympus-relay` on every forwarded request. */
  readonly relaySecret: string;
  readonly onStatus?: (status: RelayClientStatus) => void;
  readonly heartbeatMs?: number;
  /**
   * Time a connection has to be authenticated (`ready`) before it is given up
   * and retried (default 20 s). Without it, a connect or handshake that a
   * restarting relay or its proxy never answers would hang the client in
   * `connecting` for good.
   */
  readonly handshakeTimeoutMs?: number;
  readonly backoff?: { readonly minMs: number; readonly maxMs: number };
  /** After another process takes over this install's session (default 5 minutes). */
  readonly replacedBackoffMs?: number;
  /** After the relay operator revoked this install (default 6 hours; the operator may restore it). */
  readonly revokedBackoffMs?: number;
  /** Requests served at once; more are answered 503 locally (default 32). */
  readonly maxConcurrent?: number;
  /** Paths forwarded to the worker (default FORWARDED_PATHS; a demo install adds its sign-in path). */
  readonly forwardedPaths?: readonly string[];
  /** Request body cap (default 1 MiB, the relay's own). */
  readonly maxRequestBodyBytes?: number;
  /** Body frames one request may arrive in (default 4096; the relay sends 64 KiB frames). */
  readonly maxRequestFrames?: number;
  /** Request body bytes held at once across all requests being assembled (default 16 MiB). */
  readonly maxBufferedRequestBytes?: number;
  /** Time a request has, from its head, to arrive in full (default 60 s). */
  readonly requestAssemblyTimeoutMs?: number;
  readonly fetch?: typeof fetch;
}

interface Inbound {
  readonly method: string;
  readonly path: string | undefined;
  readonly headers: Array<[string, string]>;
  /** The body so far, in one buffer that grows by doubling; `bytes` of it are filled. */
  buffer: Uint8Array<ArrayBuffer>;
  bytes: number;
  frames: number;
  readonly abort: AbortController;
  started: boolean;
  assembly: ReturnType<typeof setTimeout> | undefined;
}

const INITIAL_BODY_BUFFER_BYTES = 16 * 1024;

/** Above this much unsent data, response streaming waits for the socket to drain. */
const SEND_HIGH_WATER_BYTES = 4 * 1024 * 1024;

export class RelayClient {
  private socket: WebSocket | undefined;
  private stopped = true;
  private register = false;
  private failures = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly inbound = new Map<number, Inbound>();
  /** Bytes allocated for request bodies across `inbound`. */
  private bufferedRequestBytes = 0;
  private lastPongAt = 0;

  constructor(private readonly options: RelayClientOptions) {
    const target = new URL(options.target);
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
      throw new Error('the relay client only forwards to a loopback http:// worker');
    }
  }

  get installId(): string {
    return this.options.identity.installId;
  }

  /** Requests being served right now. */
  get activeRequests(): number {
    return this.inbound.size;
  }

  /** Bytes allocated for request bodies being assembled or served. */
  get bufferedRequestBodyBytes(): number {
    return this.bufferedRequestBytes;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.abortAll();
    this.socket?.close(1000, 'stopping');
    this.socket = undefined;
    this.options.onStatus?.({ state: 'stopped' });
  }

  private sessionUrl(): string {
    return this.options.relayUrl ?? `wss://${this.options.relayHost}${CONNECT_PATH}`;
  }

  private connect(): void {
    if (this.stopped) return;
    this.options.onStatus?.({ state: 'connecting' });
    const socket = new WebSocket(this.sessionUrl());
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    let reason = 'connection closed';
    let replaced = false;
    let revoked = false;
    let ready = false;
    const { identity } = this.options;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * The session is over: schedule the next attempt. Runs once per socket,
     * whether the socket reported its close or the client gave up on it (a
     * handshake or heartbeat timeout), so a reconnect never waits on a close
     * event a dead connection may not deliver.
     */
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(handshakeTimer);
      if (this.socket === socket) {
        this.socket = undefined;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        this.abortAll();
      }
      if (this.stopped) return;
      if (replaced) {
        const retryInMs = this.options.replacedBackoffMs ?? 5 * 60_000;
        this.options.onStatus?.({ state: 'replaced', retryInMs });
        this.schedule(retryInMs);
        return;
      }
      if (revoked) {
        // Retrying sooner cannot help; ask again rarely in case it was restored.
        const retryInMs = this.options.revokedBackoffMs ?? 6 * 60 * 60_000;
        this.options.onStatus?.({ state: 'offline', reason, retryInMs });
        this.schedule(retryInMs);
        return;
      }
      if (this.register && this.failures === 0) {
        // First contact with this relay: register right away.
        this.failures = 1;
        this.schedule(0);
        return;
      }
      this.failures += 1;
      const { minMs, maxMs } = this.options.backoff ?? { minMs: 1_000, maxMs: 60_000 };
      const delay = Math.min(maxMs, minMs * 2 ** Math.min(this.failures - 1, 16));
      const jittered = Math.round(delay / 2 + Math.random() * (delay / 2));
      this.options.onStatus?.({ state: 'offline', reason, retryInMs: jittered });
      this.schedule(jittered);
    };
    const abandon = (code: number, why: string, describe: string): void => {
      reason = describe;
      try {
        socket.close(code, why);
      } catch {
        // Already closing; finish() below does not depend on it.
      }
      finish();
    };
    handshakeTimer = setTimeout(
      () => abandon(4000, 'handshake_timeout', 'the relay did not answer'),
      this.options.handshakeTimeoutMs ?? 20_000,
    );
    // The socket keeps the process alive while it matters; this timer must not.
    handshakeTimer.unref?.();

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data !== 'string') {
        const frame = decodeBodyFrame(new Uint8Array(event.data as ArrayBuffer));
        if (!ready || !frame || !this.onRequestBody(frame.id, frame.payload)) return socket.close(4002, 'protocol_error');
        return;
      }
      const message = parseTextFrame(event.data);
      if (!message) return socket.close(4002, 'protocol_error');
      switch (message.type) {
        case 'challenge': {
          const kind = this.register ? 'register' : 'hello';
          // A register solves the relay's proof of work first (a fraction of
          // a second); a relay asking for an unreasonable one is given up on.
          void installAuthMessage({
            kind,
            identity,
            nonce: String(message.nonce),
            powBits: typeof message.pow === 'number' ? message.pow : 0,
            relayHost: this.options.relayHost,
          }).then(
            (auth) => {
              if (this.socket === socket) this.send(auth);
            },
            () => abandon(4002, 'protocol_error', 'the relay asked for an unreasonable registration proof of work'),
          );
          return;
        }
        case 'ready':
          if (message.installId !== identity.installId) {
            reason = 'relay answered for another install';
            socket.close(4002, 'protocol_error');
            return;
          }
          ready = true;
          clearTimeout(handshakeTimer);
          this.failures = 0;
          this.register = false;
          this.startHeartbeat(() => abandon(4004, 'heartbeat_timeout', 'the relay stopped answering'));
          this.options.onStatus?.({ state: 'online', installId: identity.installId, connectedAt: Date.now() });
          return;
        case 'pong':
          this.lastPongAt = Date.now();
          return;
        case 'request':
          if (ready) this.onRequest(message);
          return;
        case 'end': {
          const id = streamId(message.id);
          if (ready && id !== undefined) this.onRequestEnd(id);
          return;
        }
        case 'cancel': {
          const id = streamId(message.id);
          const request = id === undefined ? undefined : this.inbound.get(id);
          request?.abort.abort();
          // Not yet started: nothing else will clean it up.
          if (request && !request.started) this.drop(id!);
          return;
        }
        case 'error':
          reason = String(message.message ?? message.code);
          if (message.code === 'unregistered') this.register = true;
          if (message.code === 'replaced') replaced = true;
          if (message.code === 'revoked') revoked = true;
          return;
        default:
          return;
      }
    });
    socket.addEventListener('error', () => {
      reason = 'could not reach the relay';
    });
    socket.addEventListener('close', () => finish());
  }

  /** Pings on an interval; a session that has not answered two pings in a row is dead. */
  private startHeartbeat(onTimeout: () => void): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const interval = this.options.heartbeatMs ?? 30_000;
    this.lastPongAt = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPongAt > interval * 2 + 1_000) {
        onTimeout();
        return;
      }
      this.send({ type: 'ping' });
    }, interval);
  }

  private schedule(delayMs: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
  }

  private send(message: ClientToRelayMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private sendBody(id: number, payload: Uint8Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeBodyFrame(id, payload));
  }

  private abortAll(): void {
    for (const id of [...this.inbound.keys()]) {
      this.inbound.get(id)!.abort.abort();
      this.drop(id);
    }
  }

  /** The one way a request leaves `inbound`: its deadline and its buffered bytes go with it. */
  private drop(id: number, expected?: Inbound): void {
    const request = this.inbound.get(id);
    if (!request || (expected && request !== expected)) return;
    clearTimeout(request.assembly);
    this.bufferedRequestBytes -= request.buffer.byteLength;
    this.inbound.delete(id);
  }

  private onRequest(message: Record<string, unknown>): void {
    const id = streamId(message.id);
    const headers = parseHeaderList(message.headers);
    const method = typeof message.method === 'string' ? message.method.toUpperCase() : '';
    if (id === undefined || !headers || this.inbound.has(id)) return;
    // Requests still receiving their body count too, so a relay cannot make
    // this process hold an unbounded number of half-sent requests.
    if (this.inbound.size >= (this.options.maxConcurrent ?? 32)) {
      this.respondLocally(id, 503, { error: 'busy', message: 'Olympus is busy. Try again shortly.' });
      return;
    }
    const request: Inbound = {
      method,
      path: FORWARDED_METHODS.has(method) && typeof message.path === 'string'
        ? forwardPath(message.path, this.options.forwardedPaths, method)
        : undefined,
      headers,
      buffer: new Uint8Array(new ArrayBuffer(0)),
      bytes: 0,
      frames: 0,
      abort: new AbortController(),
      started: false,
      assembly: undefined,
    };
    // A relay that never finishes sending a request does not get to keep it.
    request.assembly = setTimeout(() => {
      if (this.inbound.get(id) !== request || request.started) return;
      request.started = true;
      this.respondLocally(id, 408, { error: 'request_timeout', message: 'The request did not arrive in time.' });
    }, this.options.requestAssemblyTimeoutMs ?? 60_000);
    this.inbound.set(id, request);
  }

  /** A body frame; false only for a frame no correct relay sends (the session is then closed). */
  private onRequestBody(id: number, payload: Uint8Array): boolean {
    if (payload.byteLength === 0) return false;
    const request = this.inbound.get(id);
    if (!request || request.started) return true;
    request.frames += 1;
    const needed = request.bytes + payload.byteLength;
    const maxBytes = this.options.maxRequestBodyBytes ?? 1024 * 1024;
    if (needed > maxBytes) {
      request.started = true;
      this.respondLocally(id, 413, { error: 'payload_too_large' });
      return true;
    }
    if (request.frames > (this.options.maxRequestFrames ?? 4096)) {
      request.started = true;
      this.respondLocally(id, 400, { error: 'request_too_fragmented' });
      return true;
    }
    if (needed > request.buffer.byteLength) {
      const size = Math.min(maxBytes, Math.max(request.buffer.byteLength * 2, INITIAL_BODY_BUFFER_BYTES, needed));
      const growth = size - request.buffer.byteLength;
      if (this.bufferedRequestBytes + growth > (this.options.maxBufferedRequestBytes ?? 16 * 1024 * 1024)) {
        request.started = true;
        this.respondLocally(id, 503, { error: 'busy', message: 'Olympus is busy. Try again shortly.' });
        return true;
      }
      const grown = new Uint8Array(new ArrayBuffer(size));
      grown.set(request.buffer.subarray(0, request.bytes));
      request.buffer = grown;
      this.bufferedRequestBytes += growth;
    }
    request.buffer.set(payload, request.bytes);
    request.bytes = needed;
    return true;
  }

  private onRequestEnd(id: number): void {
    const request = this.inbound.get(id);
    if (!request || request.started) return;
    request.started = true;
    clearTimeout(request.assembly);
    if (!request.path) {
      this.respondLocally(id, 404, { error: 'not_found', message: 'This Olympus address only serves its remote agent endpoints.' });
      return;
    }
    void this.serve(id, request, request.path);
  }

  private respondLocally(id: number, status: number, body: unknown): void {
    this.send({ type: 'response-head', id, status, headers: [['content-type', 'application/json'], ['cache-control', 'no-store']] });
    this.sendBody(id, new TextEncoder().encode(JSON.stringify(body)));
    this.send({ type: 'end', id });
    this.drop(id);
  }

  private async serve(id: number, request: Inbound, path: string): Promise<void> {
    const fetchImpl = this.options.fetch ?? fetch;
    const body = request.method === 'GET' ? undefined : request.buffer.subarray(0, request.bytes);
    let response: Response;
    try {
      response = await fetchImpl(`${this.options.target}${path}`, {
        method: request.method,
        headers: forwardRequestHeaders(request.headers, this.options.relaySecret),
        ...(body ? { body } : {}),
        signal: request.abort.signal,
        redirect: 'manual',
      });
    } catch {
      if (!request.abort.signal.aborted) {
        this.respondLocally(id, 502, { error: 'worker_unavailable', message: 'Olympus is running but its local worker did not answer.' });
      }
      this.drop(id, request);
      return;
    }
    if (request.abort.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      this.drop(id, request);
      return;
    }
    this.send({ type: 'response-head', id, status: response.status, headers: forwardResponseHeaders(response.headers) });
    try {
      if (response.body) {
        const reader = response.body.getReader();
        const onAbort = () => void reader.cancel().catch(() => {});
        request.abort.signal.addEventListener('abort', onAbort, { once: true });
        for (;;) {
          const { done, value } = await reader.read();
          if (done || request.abort.signal.aborted) break;
          for (const chunk of chunks(value)) this.sendBody(id, chunk);
          await this.drained();
        }
        request.abort.signal.removeEventListener('abort', onAbort);
      }
      if (!request.abort.signal.aborted) this.send({ type: 'end', id });
    } catch {
      if (!request.abort.signal.aborted) this.send({ type: 'abort', id });
    } finally {
      this.drop(id, request);
    }
  }

  /** Waits while the socket holds more unsent data than the high-water mark. */
  private async drained(): Promise<void> {
    while (this.socket && this.socket.readyState === WebSocket.OPEN && this.socket.bufferedAmount > SEND_HIGH_WATER_BYTES) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
