import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

const HANDSHAKE_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_HEAD_BYTES = 64 * 1024;
const MAX_HEADER_COUNT = 256;
const MAX_BODY_BYTES = 2 ** 30;
const MAX_CHUNK_BYTES = 2 ** 28;
const MAX_CHUNK_LINE_BYTES = 256;
const MAX_TRAILER_BYTES = 8 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError');
}

function authError(reason: string): Error & { code: string } {
  return Object.assign(new Error(`api_peer_unauthenticated: ${reason}`), { code: 'EAUTH' });
}

function bridgeMac(token: Buffer, role: 'srv' | 'cli', name: string, ...parts: Buffer[]): Buffer {
  const hmac = createHmac('sha256', token);
  hmac.update(`zkapi-confine/${role}/${name}\0`);
  for (const part of parts) hmac.update(part);
  return hmac.digest();
}

function authenticate(socketPath: string, token: Buffer, name: string, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const clientNonce = randomBytes(16);
    let buffered = Buffer.alloc(0);
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.off('data', onData);
      socket.off('close', onClose);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = (): void => fail(abortError());
    const onClose = (): void => fail(authError('closed'));
    const onError = (error: NodeJS.ErrnoException): void => fail(authError(error.code ?? error.message));
    const onData = (data: Buffer): void => {
      if (settled) return;
      buffered = Buffer.concat([buffered, data]);
      if (buffered.length < 48) return;
      if (buffered.length !== 48) {
        fail(authError('unexpected pre-auth bytes'));
        return;
      }
      const serverNonce = buffered.subarray(0, 16);
      const proof = buffered.subarray(16);
      const expected = bridgeMac(token, 'srv', name, clientNonce, serverNonce);
      if (!timingSafeEqual(proof, expected)) {
        fail(authError('bad server proof'));
        return;
      }
      socket.pause();
      socket.write(bridgeMac(token, 'cli', name, clientNonce, serverNonce), (error?: Error | null) => {
        if (error) {
          fail(authError(error.message));
          return;
        }
        if (signal.aborted) {
          fail(abortError());
          return;
        }
        settled = true;
        cleanup();
        resolve(socket);
      });
    };

    const timer = setTimeout(() => fail(authError('timeout')), HANDSHAKE_TIMEOUT_MS);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.on('data', onData);
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => socket.write(clientNonce));
    if (signal.aborted) onAbort();
  });
}

function knownBodyLength(body: BodyInit | null | undefined): number | undefined {
  if (body === undefined || body === null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString());
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

function validateUrl(url: URL): void {
  if (url.protocol !== 'http:') throw new TypeError('linux confinement fetch supports HTTP only');
  if (url.username || url.password) throw new TypeError('linux confinement fetch refuses URL credentials');
  const hostname = url.hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    throw new TypeError('linux confinement fetch supports loopback daemon URLs only');
  }
}

function serializeRequestHead(request: Request, contentLength: number | undefined): Buffer {
  let head = `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search} HTTP/1.1\r\nHost: daemon\r\nConnection: close\r\n`;
  let count = 0;
  for (const [rawName, value] of request.headers) {
    const name = rawName.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) throw new TypeError(`unsupported request header: ${name}`);
    if (!HEADER_NAME.test(rawName) || /[\0\r\n]/.test(value)) throw new TypeError('invalid request header');
    count += 1;
    if (count > MAX_HEADER_COUNT) throw new TypeError('too many request headers');
    head += `${rawName}: ${value}\r\n`;
  }
  if (request.body) {
    if (contentLength === undefined) throw new TypeError('streaming request bodies are unsupported');
    head += `Content-Length: ${contentLength}\r\n`;
  }
  head += '\r\n';
  if (Buffer.byteLength(head, 'latin1') > MAX_RESPONSE_HEAD_BYTES) throw new TypeError('request head too large');
  return Buffer.from(head, 'latin1');
}

function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

async function writeRequestBody(
  socket: Socket,
  request: Request,
  contentLength: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!request.body) return;
  if (contentLength === undefined) throw new TypeError('streaming request bodies are unsupported');
  const reader = request.body.getReader();
  let sent = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      sent += value.byteLength;
      if (sent > MAX_BODY_BYTES || (contentLength !== undefined && sent > contentLength)) {
        throw new TypeError('request body exceeds its bound');
      }
      await writeSocket(socket, value);
    }
    if (sent !== contentLength) throw new TypeError('request body length changed while streaming');
  } finally {
    reader.releaseLock();
  }
}

function parseContentLength(text: string): number | undefined {
  if (!/^[0-9]{1,10}$/.test(text)) return undefined;
  const value = Number(text);
  return value <= MAX_BODY_BYTES ? value : undefined;
}

function validHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return false;
  }
  return true;
}

function exchange(socket: Socket, request: Request, head: Buffer, contentLength: number | undefined, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    type State = 'head' | 'fixed' | 'close' | 'chunk-size' | 'chunk-data' | 'chunk-crlf' | 'trailers' | 'done' | 'failed';
    let state: State = 'head';
    let buffered = Buffer.alloc(0);
    let remaining = 0;
    let totalBodyBytes = 0;
    let trailerBytes = 0;
    let settled = false;
    let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let responseStream: ReadableStream<Uint8Array> | undefined;
    let draining = false;
    let pullWhileDraining = false;
    const active = (): boolean => state !== 'failed' && state !== 'done';

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown): void => {
      if (state === 'failed' || state === 'done') return;
      state = 'failed';
      cleanup();
      socket.destroy();
      if (responseController) {
        try { responseController.error(error); } catch {}
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const finish = (): void => {
      if (state === 'failed' || state === 'done') return;
      state = 'done';
      cleanup();
      try { responseController?.close(); } catch {}
      socket.destroy();
    };
    const onAbort = (): void => fail(abortError());

    const emit = (bytes: Buffer): boolean => {
      if (bytes.length === 0) return true;
      totalBodyBytes += bytes.length;
      if (totalBodyBytes > MAX_BODY_BYTES) {
        fail(new TypeError('response body exceeds its bound'));
        return false;
      }
      responseController!.enqueue(new Uint8Array(bytes));
      if ((responseController!.desiredSize ?? 1) <= 0) {
        socket.pause();
        return false;
      }
      return true;
    };

    const drain = (): void => {
      if (draining || !active()) return;
      draining = true;
      try {
        while (buffered.length > 0 && active()) {
          if (state === 'head') {
            const boundary = buffered.indexOf('\r\n\r\n');
            if (boundary < 0) {
              if (buffered.length > MAX_RESPONSE_HEAD_BYTES) fail(new TypeError('response head too large'));
              break;
            }
            if (boundary + 4 > MAX_RESPONSE_HEAD_BYTES) {
              fail(new TypeError('response head too large'));
              break;
            }
            const lines = buffered.subarray(0, boundary).toString('latin1').split('\r\n');
            buffered = buffered.subarray(boundary + 4);
            const statusMatch = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: ([\x20-\x7e]*))?$/.exec(lines[0] ?? '');
            if (!statusMatch) {
              fail(new TypeError('bad status line'));
              break;
            }
            const status = Number(statusMatch[1]);
            if (status < 200) {
              fail(new TypeError('informational responses are unsupported'));
              break;
            }
            if (lines.length - 1 > MAX_HEADER_COUNT) {
              fail(new TypeError('too many response headers'));
              break;
            }
            const pairs: Array<[string, string]> = [];
            for (const line of lines.slice(1)) {
              const colon = line.indexOf(':');
              const name = line.slice(0, colon);
              const value = line.slice(colon + 1).trim();
              if (colon <= 0 || !HEADER_NAME.test(name) || !validHeaderValue(value)) {
                fail(new TypeError('bad header line'));
                return;
              }
              pairs.push([name.toLowerCase(), value]);
            }
            const values = (name: string): string[] => pairs.filter(([key]) => key === name).map(([, value]) => value);
            const transferEncodings = values('transfer-encoding');
            const contentLengths = values('content-length');
            if (transferEncodings.length > 1 || (transferEncodings.length === 1 && transferEncodings[0]!.toLowerCase() !== 'chunked')) {
              fail(new TypeError('unsupported transfer-encoding'));
              break;
            }
            if (contentLengths.length > 1 && new Set(contentLengths).size !== 1) {
              fail(new TypeError('conflicting content-length'));
              break;
            }
            if (transferEncodings.length > 0 && contentLengths.length > 0) {
              fail(new TypeError('content-length with chunked'));
              break;
            }
            const parsedLength = contentLengths[0] === undefined ? undefined : parseContentLength(contentLengths[0]);
            if (contentLengths[0] !== undefined && parsedLength === undefined) {
              fail(new TypeError('bad content-length'));
              break;
            }
            if (status >= 300 && status < 400) {
              fail(new TypeError('redirect refused'));
              break;
            }
            const bodyless = request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
            if (bodyless && buffered.length > 0) {
              fail(new TypeError('unexpected response body'));
              break;
            }
            responseStream = bodyless ? undefined : new ReadableStream<Uint8Array>({
              start(controller) { responseController = controller; },
              pull() {
                if (draining) {
                  pullWhileDraining = true;
                  return;
                }
                drain();
                if (state !== 'failed' && state !== 'done' && (responseController?.desiredSize ?? 1) > 0) socket.resume();
              },
              cancel() {
                state = 'done';
                cleanup();
                socket.destroy();
              },
            });
            const headers = new Headers();
            for (const [name, value] of pairs) headers.append(name, value);
            const response = new Response(responseStream ?? null, { status, statusText: statusMatch[2] ?? '', headers });
            settled = true;
            resolve(response);
            if (bodyless) {
              finish();
              break;
            }
            if (transferEncodings.length > 0) state = 'chunk-size';
            else if (parsedLength !== undefined) {
              remaining = parsedLength;
              state = 'fixed';
              if (remaining === 0) {
                if (buffered.length > 0) fail(new TypeError('bytes after response body'));
                else finish();
              }
            } else state = 'close';
          } else if (state === 'fixed') {
            const take = Math.min(remaining, buffered.length);
            const chunk = buffered.subarray(0, take);
            buffered = buffered.subarray(take);
            remaining -= take;
            const canContinue = emit(chunk);
            if (!active()) break;
            if (remaining === 0) {
              if (buffered.length > 0) fail(new TypeError('bytes after response body'));
              else finish();
            }
            if (!canContinue) break;
          } else if (state === 'close') {
            const chunk = buffered;
            buffered = Buffer.alloc(0);
            if (!emit(chunk)) break;
          } else if (state === 'chunk-size') {
            const end = buffered.indexOf('\r\n');
            if (end < 0) {
              if (buffered.length > MAX_CHUNK_LINE_BYTES) fail(new TypeError('chunk size line too long'));
              break;
            }
            if (end === 0 || end > MAX_CHUNK_LINE_BYTES) {
              fail(new TypeError(end === 0 ? 'bad chunk size' : 'chunk size line too long'));
              break;
            }
            const line = buffered.subarray(0, end).toString('latin1');
            buffered = buffered.subarray(end + 2);
            if (!/^[0-9a-fA-F]{1,8}$/.test(line)) {
              fail(new TypeError('bad chunk size'));
              break;
            }
            remaining = Number.parseInt(line, 16);
            if (remaining > MAX_CHUNK_BYTES || totalBodyBytes + remaining > MAX_BODY_BYTES) {
              fail(new TypeError('chunk exceeds its bound'));
              break;
            }
            state = remaining === 0 ? 'trailers' : 'chunk-data';
          } else if (state === 'chunk-data') {
            const take = Math.min(remaining, buffered.length);
            const chunk = buffered.subarray(0, take);
            buffered = buffered.subarray(take);
            remaining -= take;
            const canContinue = emit(chunk);
            if (!active()) break;
            if (remaining === 0) state = 'chunk-crlf';
            if (!canContinue) break;
          } else if (state === 'chunk-crlf') {
            if (buffered.length < 2) break;
            if (buffered[0] !== 13 || buffered[1] !== 10) {
              fail(new TypeError('chunk not terminated by CRLF'));
              break;
            }
            buffered = buffered.subarray(2);
            state = 'chunk-size';
          } else if (state === 'trailers') {
            const end = buffered.indexOf('\r\n');
            if (end < 0) {
              if (trailerBytes + buffered.length > MAX_TRAILER_BYTES) fail(new TypeError('response trailers too large'));
              break;
            }
            trailerBytes += end + 2;
            if (trailerBytes > MAX_TRAILER_BYTES) {
              fail(new TypeError('response trailers too large'));
              break;
            }
            const line = buffered.subarray(0, end).toString('latin1');
            buffered = buffered.subarray(end + 2);
            if (line.length === 0) {
              if (buffered.length > 0) fail(new TypeError('bytes after response body'));
              else finish();
              break;
            }
            const colon = line.indexOf(':');
            const name = line.slice(0, colon).toLowerCase();
            const value = line.slice(colon + 1).trim();
            if (colon <= 0 || !HEADER_NAME.test(name) || !validHeaderValue(value)
              || name === 'content-length' || name === 'transfer-encoding' || name === 'trailer') {
              fail(new TypeError('bad trailer line'));
              break;
            }
          }
        }
      } catch (error) {
        fail(error);
      } finally {
        draining = false;
        if (pullWhileDraining) {
          pullWhileDraining = false;
          drain();
          if (active() && (responseController?.desiredSize ?? 1) > 0) socket.resume();
        }
      }
    };

    socket.on('data', (data) => {
      if (state === 'failed' || state === 'done') return;
      const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
      buffered = buffered.length === 0 ? bytes : Buffer.concat([buffered, bytes]);
      drain();
    });
    socket.on('end', () => {
      if (state === 'close') finish();
      else if (state !== 'failed' && state !== 'done') fail(new TypeError(state === 'head' ? 'connection closed before a response' : 'connection closed mid-body'));
    });
    socket.on('close', () => {
      if (state !== 'failed' && state !== 'done') fail(new TypeError('connection closed unexpectedly'));
    });
    socket.on('error', (error) => fail(error));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    socket.resume();
    void (async () => {
      try {
        await writeSocket(socket, head);
        await writeRequestBody(socket, request, contentLength, signal);
      } catch (error) {
        fail(signal.aborted ? abortError() : error);
      }
    })();
  });
}

export function linuxConfinementFetch(socketPath: string, tokenHex: string, name = 'api'): typeof fetch {
  if (!socketPath) throw new TypeError('socket path is required');
  if (!/^[0-9a-fA-F]{64}$/.test(tokenHex)) throw new TypeError('bridge token must be exactly 32 hexadecimal bytes');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new TypeError('invalid bridge name');
  const token = Buffer.from(tokenHex, 'hex');

  const confinedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.redirect === 'follow') throw new TypeError('redirect following is unsupported');
    const request = new Request(input, init);
    const url = new URL(request.url);
    validateUrl(url);
    const length = init?.body !== undefined ? knownBodyLength(init.body) : undefined;
    if (length !== undefined && length > MAX_BODY_BYTES) throw new TypeError('request body exceeds its bound');
    if (request.body && length === undefined) throw new TypeError('streaming request bodies are unsupported');
    const head = serializeRequestHead(request, length);
    const signal = request.signal;
    if (signal.aborted) throw abortError();
    const socket = await authenticate(socketPath, token, name, signal);
    return exchange(socket, request, head, length, signal);
  };

  return confinedFetch as typeof fetch;
}
