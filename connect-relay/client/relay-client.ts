/**
 * The install side of the relay: keeps one authenticated WebSocket session to
 * the relay and serves the requests the relay multiplexes over it by calling
 * the loopback Olympus worker with fetch(), streaming each response back.
 *
 * The client trusts the relay with nothing it does not have to: it forwards
 * only the remote surface (forward.ts), strips inbound relay and forwarding
 * headers, marks every forwarded request with the per-boot relay secret, and
 * bounds request bodies and concurrency itself.
 */
import {
  CONNECT_PATH,
  PROTOCOL_VERSION,
  chunks,
  decodeBodyFrame,
  encodeBodyFrame,
  parseHeaderList,
  parseTextFrame,
  signInstallMessage,
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
  /** e.g. `mcp.olympusplugin.ai`; the client dials `wss://<relayHost>/v2/connect`. */
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
  readonly fetch?: typeof fetch;
}

interface Inbound {
  readonly method: string;
  readonly path: string | undefined;
  readonly headers: Array<[string, string]>;
  readonly body: Uint8Array[];
  bytes: number;
  readonly abort: AbortController;
  started: boolean;
}

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

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data !== 'string') {
        const frame = decodeBodyFrame(new Uint8Array(event.data as ArrayBuffer));
        if (!ready || !frame) return socket.close(4002, 'protocol_error');
        this.onRequestBody(frame.id, frame.payload);
        return;
      }
      const message = parseTextFrame(event.data);
      if (!message) return socket.close(4002, 'protocol_error');
      switch (message.type) {
        case 'challenge': {
          const nonce = String(message.nonce);
          const kind = this.register ? 'register' : 'hello';
          const sig = signInstallMessage(identity.privateKey, kind, nonce, identity.installId);
          this.send(
            kind === 'register'
              ? { type: 'register', v: PROTOCOL_VERSION, installId: identity.installId, publicKey: identity.publicKeySpki, sig }
              : { type: 'hello', v: PROTOCOL_VERSION, installId: identity.installId, sig },
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
          this.failures = 0;
          this.register = false;
          this.startHeartbeat(socket);
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
          if (request && !request.started) this.inbound.delete(id!);
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
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = undefined;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.abortAll();
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
    });
  }

  /** Pings on an interval; a session that has not answered two pings in a row is dead. */
  private startHeartbeat(socket: WebSocket): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const interval = this.options.heartbeatMs ?? 30_000;
    this.lastPongAt = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPongAt > interval * 2 + 1_000) {
        socket.close(4004, 'heartbeat_timeout');
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
    for (const request of this.inbound.values()) request.abort.abort();
    this.inbound.clear();
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
    this.inbound.set(id, {
      method,
      path: FORWARDED_METHODS.has(method) && typeof message.path === 'string'
        ? forwardPath(message.path, this.options.forwardedPaths)
        : undefined,
      headers,
      body: [],
      bytes: 0,
      abort: new AbortController(),
      started: false,
    });
  }

  private onRequestBody(id: number, payload: Uint8Array): void {
    const request = this.inbound.get(id);
    if (!request || request.started) return;
    request.bytes += payload.byteLength;
    if (request.bytes > (this.options.maxRequestBodyBytes ?? 1024 * 1024)) {
      request.started = true;
      this.respondLocally(id, 413, { error: 'payload_too_large' });
      return;
    }
    request.body.push(payload.slice());
  }

  private onRequestEnd(id: number): void {
    const request = this.inbound.get(id);
    if (!request || request.started) return;
    request.started = true;
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
    this.inbound.delete(id);
  }

  private async serve(id: number, request: Inbound, path: string): Promise<void> {
    const fetchImpl = this.options.fetch ?? fetch;
    const body = request.method === 'GET' ? undefined : concat(request.body, request.bytes);
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
      this.inbound.delete(id);
      return;
    }
    if (request.abort.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      this.inbound.delete(id);
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
      this.inbound.delete(id);
    }
  }

  /** Waits while the socket holds more unsent data than the high-water mark. */
  private async drained(): Promise<void> {
    while (this.socket && this.socket.readyState === WebSocket.OPEN && this.socket.bufferedAmount > SEND_HIGH_WATER_BYTES) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
