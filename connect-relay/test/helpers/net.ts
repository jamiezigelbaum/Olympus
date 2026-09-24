import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { encodeLine, readLines } from '../../shared/protocol.ts';

/** The exact ClientHello a real TLS client sends for `servername`. */
export async function captureClientHello(servername: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        resolve(chunk);
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const client = tls.connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, servername });
      client.on('error', () => {});
    });
  });
}

/** Sends raw bytes and returns everything the server sends before it closes. */
export function rawExchange(port: number, bytes: Buffer, timeoutMs = 5_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(bytes));
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw exchange timed out'));
    }, timeoutMs);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
}

export interface ControlConnection {
  next(): Promise<Record<string, unknown>>;
  send(message: object): void;
  closed(): Promise<void>;
  destroy(): void;
}

export function openControl(port: number, controlHost: string, ca: string): ControlConnection {
  const socket = tls.connect({ host: '127.0.0.1', port, servername: controlHost, ca });
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  socket.on('error', () => {});
  readLines(
    socket,
    (message) => {
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queue.push(message);
      return 'continue';
    },
    () => socket.destroy(),
  );
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  return {
    next: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift()!)
        : new Promise((resolve, reject) => {
            waiters.push(resolve);
            closed.then(() => reject(new Error('control connection closed')));
          }),
    send: (message) => socket.write(encodeLine(message)),
    closed: () => closed,
    destroy: () => socket.destroy(),
  };
}

export interface AgentResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A hosted agent: TLS to the relay with SNI `servername`, verifying the install certificate against `ca`. */
export function agentRequest(options: {
  port: number;
  servername: string;
  ca: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: options.port, servername: options.servername, ca: options.ca }, () => {
      const body = options.body ?? '';
      const headers = {
        host: options.servername,
        connection: 'close',
        'content-length': String(Buffer.byteLength(body)),
        ...options.headers,
      };
      socket.write(
        `${options.method ?? 'GET'} ${options.path} HTTP/1.1\r\n${Object.entries(headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join('\r\n')}\r\n\r\n${body}`,
      );
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const [head = '', ...rest] = text.split('\r\n\r\n');
      const [statusLine = '', ...headerLines] = head.split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const colon = line.indexOf(':');
        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      let body = rest.join('\r\n\r\n');
      if (headers['transfer-encoding'] === 'chunked') body = dechunk(body);
      resolve({ status: Number(statusLine.split(' ')[1]), headers, body });
    });
  });
}

function dechunk(body: string): string {
  let out = '';
  let rest = body;
  for (;;) {
    const lineEnd = rest.indexOf('\r\n');
    const size = parseInt(rest.slice(0, lineEnd), 16);
    if (!size) return out;
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

/** A minimal synthetic ClientHello carrying the given host_name entries (for malformed-SNI cases). */
export function syntheticClientHello(hostNames: readonly string[]): Buffer {
  const entries = Buffer.concat(
    hostNames.map((name) => {
      const header = Buffer.from([0, 0, 0]);
      header.writeUInt16BE(name.length, 1);
      return Buffer.concat([header, Buffer.from(name, 'latin1')]);
    }),
  );
  const list = Buffer.concat([Buffer.from([entries.length >> 8, entries.length & 0xff]), entries]);
  const extension = Buffer.concat([Buffer.from([0, 0, list.length >> 8, list.length & 0xff]), list]);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    Buffer.from([extension.length >> 8, extension.length & 0xff]),
    extension,
  ]);
  const handshake = Buffer.concat([Buffer.from([1, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01, handshake.length >> 8, handshake.length & 0xff]), handshake]);
}

/** Opens a raw socket that sends `bytes` (possibly nothing) and reports how and when it closed. */
export function holdOpen(port: number, bytes?: Buffer): { closed: Promise<{ afterMs: number; received: Buffer }>; destroy(): void } {
  const started = Date.now();
  const socket = net.connect(port, '127.0.0.1', () => {
    if (bytes) socket.write(bytes);
  });
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('error', () => {});
  return {
    closed: new Promise((resolve) => socket.on('close', () => resolve({ afterMs: Date.now() - started, received: Buffer.concat(chunks) }))),
    destroy: () => socket.destroy(),
  };
}

/** Sends `bytes` one byte per `intervalMs`, then returns what the server sent before closing. */
export function trickle(port: number, bytes: Buffer, intervalMs = 1): Promise<Buffer> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    let index = 0;
    const timer = setInterval(() => {
      if (index >= bytes.length || socket.destroyed) return clearInterval(timer);
      socket.write(bytes.subarray(index, index + 1));
      index += 1;
    }, intervalMs);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(timer);
      resolve(Buffer.concat(chunks));
    });
  });
}
