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
