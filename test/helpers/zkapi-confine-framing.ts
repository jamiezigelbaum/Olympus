import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxConfinementFetch } from '../../src/core/zkapi-confine-fetch.ts';

const CRLF = '\r\n';
const head = (...headers: string[]): string =>
  `HTTP/1.1 200 OK${CRLF}${headers.join(CRLF)}${headers.length > 0 ? CRLF : ''}${CRLF}`;

const CASES = {
  'ok-content-length': { want: 'ok', raw: head('Content-Length: 2') + 'OK' },
  'ok-chunked': { want: 'ok', raw: head('Transfer-Encoding: chunked') + `2${CRLF}OK${CRLF}0${CRLF}${CRLF}` },
  'ok-close-delimited': { want: 'ok', raw: head() + 'hi', end: true },
  'ok-205-bodyless': { want: 'ok', raw: `HTTP/1.1 205 Reset Content${CRLF}Content-Length: 0${CRLF}${CRLF}` },
  'cl-nope': { raw: head('Content-Length: nope') + 'X' },
  'cl-negative': { raw: head('Content-Length: -1') + 'X' },
  'cl-exponent': { raw: head('Content-Length: 1e3') + 'X' },
  'cl-hex-prefix': { raw: head('Content-Length: 0x10') + 'X' },
  'cl-space-inside': { raw: head('Content-Length: 1 2') + 'X' },
  'cl-huge': { raw: head('Content-Length: 99999999999999999999') + 'X' },
  'cl-over-bound': { raw: head('Content-Length: 4294967296') + 'X' },
  'cl-conflicting': { raw: head('Content-Length: 2', 'Content-Length: 3') + 'OK' },
  'cl-and-chunked': { raw: head('Content-Length: 2', 'Transfer-Encoding: chunked') + `2${CRLF}OK${CRLF}0${CRLF}${CRLF}` },
  'te-unsupported': { raw: head('Transfer-Encoding: gzip, chunked') + 'X' },
  'chunk-nonhex': { raw: head('Transfer-Encoding: chunked') + `zz${CRLF}OK${CRLF}` },
  'chunk-empty-size': { raw: head('Transfer-Encoding: chunked') + `${CRLF}OK${CRLF}` },
  'chunk-trailing-junk': { raw: head('Transfer-Encoding: chunked') + `2zz${CRLF}OK${CRLF}0${CRLF}${CRLF}` },
  'chunk-negative': { raw: head('Transfer-Encoding: chunked') + `-2${CRLF}OK${CRLF}` },
  'chunk-huge': { raw: head('Transfer-Encoding: chunked') + `FFFFFFFFFFFF${CRLF}OK${CRLF}` },
  'chunk-over-bound': { raw: head('Transfer-Encoding: chunked') + `40000000${CRLF}OK${CRLF}` },
  'chunk-missing-crlf': { raw: head('Transfer-Encoding: chunked') + `2${CRLF}OKxx0${CRLF}${CRLF}` },
  'chunk-line-unterminated': { raw: head('Transfer-Encoding: chunked') + 'A'.repeat(4096) },
  'header-no-colon': { raw: head('Content-Length 2') + 'OK' },
  'header-empty-name': { raw: head(': 2') + 'OK' },
  'status-garbage': { raw: `HTTP/9.9 abc${CRLF}${CRLF}` },
} as const;

export const ZKAPI_CONFINE_FRAMING_CASES = Object.keys(CASES);

function mac(token: Buffer, role: 'srv' | 'cli', name: string, ...parts: Buffer[]): Buffer {
  const hmac = createHmac('sha256', token);
  hmac.update(`zkapi-confine/${role}/${name}\0`);
  for (const part of parts) hmac.update(part);
  return hmac.digest();
}

function serveCase(socket: Socket, token: Buffer, framingCase: (typeof CASES)[keyof typeof CASES]): void {
  let buffered = Buffer.alloc(0);
  let stage: 'hello' | 'proof' | 'request' | 'responded' = 'hello';
  let clientNonce: Buffer | undefined;
  let serverNonce: Buffer | undefined;
  socket.on('error', () => {});
  socket.on('data', (data) => {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    buffered = Buffer.concat([buffered, bytes]);
    if (stage === 'hello' && buffered.length >= 16) {
      clientNonce = buffered.subarray(0, 16);
      serverNonce = randomBytes(16);
      buffered = buffered.subarray(16);
      stage = 'proof';
      socket.write(Buffer.concat([serverNonce, mac(token, 'srv', 'api', clientNonce, serverNonce)]));
    }
    if (stage === 'proof' && buffered.length >= 32) {
      const proof = buffered.subarray(0, 32);
      buffered = buffered.subarray(32);
      if (!clientNonce || !serverNonce || !proof.equals(mac(token, 'cli', 'api', clientNonce, serverNonce))) {
        socket.destroy();
        return;
      }
      stage = 'request';
    }
    if (stage === 'request' && buffered.includes('\r\n\r\n')) {
      stage = 'responded';
      socket.write(Buffer.from(framingCase.raw, 'latin1'));
      if ('end' in framingCase && framingCase.end) socket.end();
    }
  });
}

async function main(): Promise<void> {
  const caseName = process.argv[2] as keyof typeof CASES | undefined;
  const framingCase = caseName ? CASES[caseName] : undefined;
  if (!caseName || !framingCase) process.exit(2);
  const dir = mkdtempSync(join(tmpdir(), 'olympus-zkapi-framing-'));
  const socketPath = join(dir, 'api.sock');
  const token = randomBytes(32);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    serveCase(socket, token, framingCase);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  let outcome: string;
  try {
    const response = await linuxConfinementFetch(socketPath, token.toString('hex'))('http://127.0.0.1/');
    const bodyKind = caseName === 'ok-205-bodyless' ? (response.body === null ? 'null:' : 'stream:') : '';
    outcome = `ok:${bodyKind}${await response.text()}`;
  } catch {
    outcome = 'rejected';
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ case: caseName, outcome }));
}

if (import.meta.main) await main();
