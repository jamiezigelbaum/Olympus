// OLYMPUS_TEST_LANE: deploy
import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxConfinementFetch } from '../src/core/zkapi-confine-fetch.ts';
import { supervise, WATCHDOG_SCRIPT } from '../src/core/consult-transport-zkapi.ts';
import { ZKAPI_CONFINE_FRAMING_CASES } from './helpers/zkapi-confine-framing.ts';

type Handler = (socket: Socket, request: Buffer) => void | Promise<void>;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function mac(token: Buffer, role: 'srv' | 'cli', name: string, ...parts: Buffer[]): Buffer {
  const hmac = createHmac('sha256', token);
  hmac.update(`zkapi-confine/${role}/${name}\0`);
  for (const part of parts) hmac.update(part);
  return hmac.digest();
}

async function daemon(handler: Handler, options: { badProof?: boolean; stallHandshake?: boolean } = {}): Promise<{
  fetch: typeof fetch;
  tokenHex: string;
  socketPath: string;
  httpBytes: () => number;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-zkapi-fetch-'));
  const socketPath = join(dir, 'api.sock');
  const token = randomBytes(32);
  let requestBytes = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffered = Buffer.alloc(0);
    let stage: 'hello' | 'proof' | 'request' | 'handled' = 'hello';
    let clientNonce: Buffer | undefined;
    let serverNonce: Buffer | undefined;
    socket.on('data', async (data) => {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
      buffered = Buffer.concat([buffered, bytes]);
      if (stage === 'hello' && buffered.length >= 16) {
        clientNonce = buffered.subarray(0, 16);
        buffered = buffered.subarray(16);
        if (options.stallHandshake) return;
        serverNonce = randomBytes(16);
        const proof = options.badProof ? Buffer.alloc(32, 0x5a) : mac(token, 'srv', 'api', clientNonce, serverNonce);
        stage = 'proof';
        socket.write(Buffer.concat([serverNonce, proof]));
      }
      if (stage === 'proof' && buffered.length >= 32) {
        const proof = buffered.subarray(0, 32);
        buffered = buffered.subarray(32);
        if (!clientNonce || !serverNonce || !proof.equals(mac(token, 'cli', 'api', clientNonce, serverNonce))) return socket.destroy();
        stage = 'request';
      }
      if (stage === 'request') {
        requestBytes += data.length;
        const headerEnd = buffered.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const head = buffered.subarray(0, headerEnd).toString('latin1');
        const contentLength = Number(/^content-length:\s*(\d+)$/im.exec(head)?.[1] ?? 0);
        const bodyEnd = headerEnd + 4 + contentLength;
        if (buffered.length < bodyEnd) return;
        stage = 'handled';
        await handler(socket, buffered.subarray(0, bodyEnd));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { fetch: linuxConfinementFetch(socketPath, token.toString('hex')), tokenHex: token.toString('hex'), socketPath, httpBytes: () => requestBytes };
}

async function runFramingCase(caseName: string): Promise<{ case: string; outcome: string }> {
  const dir = mkdtempSync(join(tmpdir(), `olympus-zkapi-watchdog-${caseName}-`));
  const watchdog = join(dir, 'watchdog.cjs');
  writeFileSync(watchdog, WATCHDOG_SCRIPT, { mode: 0o700 });
  chmodSync(watchdog, 0o700);
  const lines: string[] = [];
  let resolveExit!: () => void;
  const reported = new Promise<void>((resolve) => { resolveExit = resolve; });
  const handle = supervise(
    'daemon',
    watchdog,
    [process.execPath, join(import.meta.dir, 'helpers', 'zkapi-confine-framing.ts'), caseName],
    process.env,
    (line) => lines.push(line),
    () => resolveExit(),
  );
  handle.go();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reported,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          try { process.kill(-handle.pgid, 'SIGKILL'); } catch {}
          reject(new Error(`${caseName} exceeded its external watchdog deadline`));
        }, 8_000);
      }),
    ]);
    const record = [...lines].reverse().map((line) => {
      try { return JSON.parse(line) as { case?: string; outcome?: string }; } catch { return undefined; }
    }).find((value) => value?.case === caseName);
    if (!record || typeof record.outcome !== 'string') throw new Error(`${caseName} emitted no outcome: ${lines.join('\n')}`);
    return { case: caseName, outcome: record.outcome };
  } finally {
    if (timeout) clearTimeout(timeout);
    try { process.kill(-handle.pgid, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('linuxConfinementFetch', () => {
  test('all 24 prototype framing cases plus Fetch bodyless 205 terminate with strict outcomes', async () => {
    expect(ZKAPI_CONFINE_FRAMING_CASES).toHaveLength(25);
    const outcomes = await Promise.all(ZKAPI_CONFINE_FRAMING_CASES.map(runFramingCase));
    expect(outcomes.filter(({ outcome }) => outcome.startsWith('ok:'))).toEqual([
      { case: 'ok-content-length', outcome: 'ok:OK' },
      { case: 'ok-chunked', outcome: 'ok:OK' },
      { case: 'ok-close-delimited', outcome: 'ok:hi' },
      { case: 'ok-205-bodyless', outcome: 'ok:null:' },
    ]);
    expect(outcomes.filter(({ outcome }) => outcome === 'rejected')).toHaveLength(21);
  }, 10_000);

  test('authenticates before sending HTTP and a wrong peer sees zero HTTP bytes', async () => {
    const peer = await daemon(() => {}, { badProof: true });
    await expect(peer.fetch('http://127.0.0.1/v1/models')).rejects.toThrow(/api_peer_unauthenticated/);
    expect(peer.httpBytes()).toBe(0);
  });

  test('aborts during the handshake', async () => {
    const peer = await daemon(() => {}, { stallHandshake: true });
    const controller = new AbortController();
    const pending = peer.fetch('http://127.0.0.1/v1/models', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('streams a 4 MiB request and response without truncation', async () => {
    const body = Buffer.alloc(4 * 1024 * 1024, 0x6b);
    const peer = await daemon((socket, request) => {
      const headerEnd = request.indexOf('\r\n\r\n');
      const echoed = request.subarray(headerEnd + 4);
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${echoed.length}\r\n\r\n`);
      for (let offset = 0; offset < echoed.length; offset += 64 * 1024) socket.write(echoed.subarray(offset, offset + 64 * 1024));
    });
    const response = await peer.fetch('http://127.0.0.1/v1/echo', { method: 'POST', body });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
  }, 10_000);

  test('aborting an active response stream rejects the reader', async () => {
    const peer = await daemon((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nfirst');
    });
    const controller = new AbortController();
    const response = await peer.fetch('http://127.0.0.1/v1/slow', { signal: controller.signal });
    const reader = response.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('first');
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('never follows redirects', async () => {
    const peer = await daemon((socket) => { socket.end('HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/elsewhere\r\nContent-Length: 0\r\n\r\n'); });
    await expect(peer.fetch('http://127.0.0.1/start')).rejects.toThrow(/redirect/i);
    await expect(peer.fetch('http://127.0.0.1/start', { redirect: 'follow' })).rejects.toThrow(/redirect/i);
  });

  test('rejects non-HTTP, credentials, non-loopback origins, and caller framing headers', async () => {
    const peer = await daemon(() => {});
    await expect(peer.fetch('https://127.0.0.1/')).rejects.toThrow(TypeError);
    await expect(peer.fetch('http://user:pass@127.0.0.1/')).rejects.toThrow(TypeError);
    await expect(peer.fetch('http://example.com/')).rejects.toThrow(TypeError);
    await expect(peer.fetch('http://127.0.0.1/', { headers: { connection: 'keep-alive' } })).rejects.toThrow(TypeError);
    const unboundedBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
    await expect(peer.fetch('http://127.0.0.1/', { method: 'POST', body: unboundedBody })).rejects.toThrow(/streaming request bodies/);
    expect(peer.httpBytes()).toBe(0);
  });

  test('requires one exact 32-byte hexadecimal bridge token', () => {
    expect(() => linuxConfinementFetch('/tmp/api.sock', 'abc')).toThrow(TypeError);
    expect(() => linuxConfinementFetch('/tmp/api.sock', 'g'.repeat(64))).toThrow(TypeError);
  });
});
