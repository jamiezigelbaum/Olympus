/**
 * Regression proofs for the relay v2 adversarial review (F1-F5): bodyless
 * responses, ingress before body reads, empty and tiny body frames, forged
 * secrets against a known install, and revocation durability.
 *
 * Every test is bounded: it proves an accounting or cleanup invariant with
 * small limits, never by exhausting memory.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient, type RelayClientStatus } from '../client/relay-client.ts';
import { loadOrCreateIdentity, type InstallIdentity } from '../client/identity.ts';
import { PROTOCOL_VERSION, base64url, decodeBodyFrame, encodeBodyFrame, signInstallMessage } from '../shared/protocol.ts';
import { AUTHENTICATED_RESPONSE_HEADER, mintCredential } from '../shared/tokens.ts';
import { DEFAULT_LIMITS, QueueBudget, type RelayLimits } from '../server/limits.ts';
import { FileInstallRegistry, MemoryInstallRegistry, type LogEntry } from '../server/registry.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';
import { InstallSession } from '../server/session.ts';

setDefaultTimeout(15_000);

const PUBLIC_HOST = 'mcp.olympus.test';
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-hardening-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
}

async function makeRelay(limits: Partial<RelayLimits> = {}, registry: MemoryInstallRegistry = new MemoryInstallRegistry()): Promise<RelayHandle> {
  const relay = await startRelay({ publicHost: PUBLIC_HOST, registry, listen: { host: '127.0.0.1', port: 0 }, limits });
  cleanups.push(() => relay.close());
  return relay;
}

const rpc = (method: string, params: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

function mcpPost(relay: RelayHandle, token: string, body: string): Promise<Response> {
  return fetch(`${relay.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
}

/**
 * An install whose WebSocket the attacker controls: it registers its own key
 * honestly and then answers requests however `onRequest` says.
 */
async function rogueInstall(
  relay: RelayHandle,
  onRequest: (id: number, socket: WebSocket) => void,
): Promise<{ identity: InstallIdentity; socket: WebSocket; closed: () => boolean }> {
  const identity = loadOrCreateIdentity(tempDir());
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/v2/connect`);
  socket.binaryType = 'arraybuffer';
  let ready = false;
  let isClosed = false;
  socket.addEventListener('close', () => {
    isClosed = true;
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    const message = JSON.parse(event.data);
    if (message.type === 'challenge') {
      socket.send(JSON.stringify({
        type: 'register',
        v: PROTOCOL_VERSION,
        installId: identity.installId,
        publicKey: identity.publicKeySpki,
        sig: signInstallMessage(identity.privateKey, 'register', message.nonce, identity.installId),
      }));
    } else if (message.type === 'ready') {
      ready = true;
    } else if (message.type === 'request') {
      onRequest(message.id, socket);
    }
  });
  cleanups.push(() => socket.close());
  await until(() => ready);
  return { identity, socket, closed: () => isClosed };
}

/** A loopback engine stand-in: 401 for any token but `validToken`, an authenticated mark otherwise. */
function engine(validToken: string): { url: string; reached: string[]; stop(): void } {
  const reached: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      reached.push(`${url.pathname} ${body}`);
      if (url.pathname === '/connect/revoke') return new Response(null, { status: 200 });
      if (request.headers.get('authorization') !== `Bearer ${validToken}`) return Response.json({ error: 'invalid_token' }, { status: 401 });
      return Response.json({ ok: true }, { headers: { [AUTHENTICATED_RESPONSE_HEADER]: '1' } });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, reached, stop: () => server.stop(true) };
}

async function connectClient(relay: RelayHandle, target: string, identity = loadOrCreateIdentity(tempDir())): Promise<RelayClient> {
  const statuses: RelayClientStatus[] = [];
  const client = new RelayClient({
    relayHost: PUBLIC_HOST,
    relayUrl: `ws://127.0.0.1:${relay.port}/v2/connect`,
    identity,
    target,
    relaySecret: base64url(crypto.getRandomValues(new Uint8Array(32))),
    heartbeatMs: 500,
    backoff: { minMs: 50, maxMs: 200 },
    onStatus: (status) => statuses.push(status),
  });
  client.start();
  cleanups.push(() => client.stop());
  await until(() => statuses.at(-1)?.state === 'online');
  return client;
}

/** A fake install socket for driving an InstallSession directly. */
function fakeSocket() {
  const text: Array<Record<string, unknown>> = [];
  return {
    text,
    send(data: string | Uint8Array) {
      if (typeof data === 'string') text.push(JSON.parse(data));
      return 1;
    },
    close() {},
  };
}

describe('F1: bodyless responses finish their stream at once', () => {
  test('more than eight 204/304 heads without `end` never leave live streams, and later bodies are dropped', async () => {
    const relay = await makeRelay();
    const answered: number[] = [];
    const rogue = await rogueInstall(relay, (id, socket) => {
      answered.push(id);
      // Never sends `end`; marks itself authenticated so the owner lane (cap 8) is exercised too.
      socket.send(JSON.stringify({ type: 'response-head', id, status: answered.length % 2 ? 204 : 304, headers: [[AUTHENTICATED_RESPONSE_HEADER, '1']] }));
    });
    const token = mintCredential('access', rogue.identity.installId);
    for (let i = 0; i < 12; i += 1) {
      const response = await mcpPost(relay, token, rpc('ping'));
      expect([204, 304]).toContain(response.status);
      expect(relay.status().inFlight).toBe(0);
    }
    // Bodies for every finished stream: not retained, not an error.
    for (const id of answered) rogue.socket.send(encodeBodyFrame(id, new Uint8Array(60 * 1024)));
    rogue.socket.send(JSON.stringify({ type: 'end', id: answered[0] }));
    // A ping round trip proves the relay processed the frames above.
    let pongs = 0;
    rogue.socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string' && JSON.parse(event.data).type === 'pong') pongs += 1;
    });
    rogue.socket.send(JSON.stringify({ type: 'ping' }));
    await until(() => pongs === 1);
    expect(relay.status()).toMatchObject({ inFlight: 0, queuedBytes: 0, online: 1 });
    expect(rogue.closed()).toBe(false);
  });

  test('a bodyless head releases admission once, and frames after it allocate nothing', async () => {
    const socket = fakeSocket();
    const session = new InstallSession('a'.repeat(32), socket, DEFAULT_LIMITS);
    let finished = 0;
    const pending = session.forward({ method: 'POST', path: '/mcp', headers: [], body: new Uint8Array(), signal: new AbortController().signal, onFinish: () => (finished += 1) });
    const id = socket.text.find((m) => m.type === 'request')!.id as number;
    expect(session.onMessage({ type: 'response-head', id, status: 304, headers: [] }, id)).toBe('ok');
    const response = await pending;
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(session.activeStreams).toBe(0);
    expect(finished).toBe(1);
    expect(session.onBody(id, new Uint8Array(1024))).toBe('ok');
    expect(session.onMessage({ type: 'end', id }, id)).toBe('ok');
    expect(session.queuedBytes).toBe(0);
    expect(finished).toBe(1);
  });

  test('a HEAD request\'s response is bodyless even with a 200', async () => {
    const socket = fakeSocket();
    const session = new InstallSession('a'.repeat(32), socket, DEFAULT_LIMITS);
    const pending = session.forward({ method: 'HEAD', path: '/mcp', headers: [], body: new Uint8Array(), signal: new AbortController().signal });
    const id = socket.text.find((m) => m.type === 'request')!.id as number;
    session.onMessage({ type: 'response-head', id, status: 200, headers: [] }, id);
    expect((await pending).body).toBeNull();
    expect(session.activeStreams).toBe(0);
  });

  test('a stalled caller cannot make the relay queue past its budget; the stream is cut and admission released', async () => {
    const socket = fakeSocket();
    const limits = { ...DEFAULT_LIMITS, maxSessionQueuedBytes: 256 * 1024 };
    const budget = new QueueBudget(limits.maxQueuedBytes);
    const session = new InstallSession('a'.repeat(32), socket, limits, budget);
    let finished = 0;
    const pending = session.forward({ method: 'POST', path: '/mcp', headers: [], body: new Uint8Array(), signal: new AbortController().signal, onFinish: () => (finished += 1) });
    const id = socket.text.find((m) => m.type === 'request')!.id as number;
    session.onMessage({ type: 'response-head', id, status: 200, headers: [] }, id);
    await pending; // The caller holds the response and never reads it.
    for (let i = 0; i < 64; i += 1) session.onBody(id, new Uint8Array(64 * 1024));
    expect(session.queuedBytes).toBe(0);
    expect(budget.used).toBe(0);
    expect(session.activeStreams).toBe(0);
    expect(finished).toBe(1);
    expect(socket.text.some((m) => m.type === 'cancel' && m.id === id)).toBe(true);
  });

  test('the relay-wide queue budget is shared by every session', async () => {
    const budget = new QueueBudget(200 * 1024);
    const sockets = [fakeSocket(), fakeSocket()];
    const sessions = sockets.map((socket, n) => new InstallSession(String(n).repeat(32), socket, DEFAULT_LIMITS, budget));
    const ids: number[] = [];
    for (const [n, session] of sessions.entries()) {
      const pending = session.forward({ method: 'POST', path: '/mcp', headers: [], body: new Uint8Array(), signal: new AbortController().signal });
      const id = sockets[n]!.text.find((m) => m.type === 'request')!.id as number;
      ids.push(id);
      session.onMessage({ type: 'response-head', id, status: 200, headers: [] }, id);
      await pending;
    }
    sessions[0]!.onBody(ids[0]!, new Uint8Array(64 * 1024));
    sessions[0]!.onBody(ids[0]!, new Uint8Array(64 * 1024));
    expect(budget.used).toBeGreaterThan(128 * 1024);
    sessions[1]!.onBody(ids[1]!, new Uint8Array(64 * 1024));
    sessions[1]!.onBody(ids[1]!, new Uint8Array(64 * 1024));
    expect(budget.used).toBeLessThanOrEqual(200 * 1024);
    expect(sessions[1]!.activeStreams).toBe(0);
  });
});

/** A raw HTTP request that sends its head and only part of its body. */
async function partialUpload(port: number, headers: Record<string, string>, declared: number, sent: number) {
  let received = '';
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_socket, data) {
        received += new TextDecoder().decode(data);
      },
    },
  });
  const head = [`POST /mcp HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Content-Type: application/json`, `Content-Length: ${declared}`]
    .concat(Object.entries(headers).map(([name, value]) => `${name}: ${value}`))
    .join('\r\n');
  socket.write(`${head}\r\n\r\n${'x'.repeat(sent)}`);
  cleanups.push(() => socket.end());
  return { status: () => Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0) };
}

describe('F2: ingress is admitted and timed before any body byte is read', () => {
  test('one address, any token shape, hits the upload cap; incomplete uploads expire and release it', async () => {
    const relay = await makeRelay({
      uploadsPerIp: 3,
      uploadTimeoutMs: 400,
      uploadIdleTimeoutMs: 300,
      publicRequestsPerIp: { capacity: 1000, refillPerSecond: 0 },
    });
    const victim = await rogueInstall(relay, () => {});
    const forged = `Bearer ${mintCredential('access', victim.identity.installId)}`;
    const uploads = [
      await partialUpload(relay.port, { Authorization: forged }, 32_768, 32_767),
      await partialUpload(relay.port, {}, 32_768, 32_767),
      await partialUpload(relay.port, { Authorization: `Bearer ${mintCredential('access', victim.identity.installId)}` }, 32_768, 100),
    ];
    await until(() => relay.status().uploading === 3);
    const fourth = await partialUpload(relay.port, { Authorization: forged }, 32_768, 10);
    await until(() => fourth.status() !== 0);
    expect(fourth.status()).toBe(429);
    // Unfinished uploads are cut at their deadline and give their tickets back.
    await until(() => uploads.every((upload) => upload.status() !== 0), 3_000);
    expect(uploads.map((upload) => upload.status())).toEqual([408, 408, 408]);
    await until(() => relay.status().uploading === 0);
    expect(relay.status().inFlight).toBe(0);
  });

  test('a fabricated install id is refused from its headers, without reading the body', async () => {
    const relay = await makeRelay({ uploadsPerIp: 1, publicRequestsPerIp: { capacity: 1000, refillPerSecond: 0 } });
    const results: Array<{ status(): number }> = [];
    for (let i = 0; i < 8; i += 1) {
      const fabricated = mintCredential('access', loadOrCreateIdentity(tempDir()).installId);
      results.push(await partialUpload(relay.port, { Authorization: `Bearer ${fabricated}` }, 32_768, 32_767));
    }
    await until(() => results.every((result) => result.status() !== 0));
    expect(results.map((result) => result.status())).toEqual(Array(8).fill(401));
    expect(relay.status().uploading).toBe(0);
  });

  test('fabricated ids still spend the address\'s public budget', async () => {
    const relay = await makeRelay({ publicRequestsPerIp: { capacity: 3, refillPerSecond: 0 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await mcpPost(relay, mintCredential('access', loadOrCreateIdentity(tempDir()).installId), rpc('ping'))).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });
});

describe('F3: empty and tiny body frames cannot grow memory', () => {
  test('an empty body frame is malformed', () => {
    expect(decodeBodyFrame(encodeBodyFrame(7, new Uint8Array()))).toBeUndefined();
  });

  /** A RelayClient with an open fake socket, driven through its frame handlers. */
  function drivenClient(options: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
    const sent: Array<Record<string, unknown>> = [];
    const client = new RelayClient({
      relayHost: PUBLIC_HOST,
      identity: loadOrCreateIdentity(tempDir()),
      target: 'http://127.0.0.1:1',
      relaySecret: 'x'.repeat(43),
      fetch: (() => new Promise(() => {})) as unknown as typeof fetch,
      ...options,
    });
    const internals = client as unknown as {
      socket: unknown;
      onRequest(message: Record<string, unknown>): void;
      onRequestBody(id: number, payload: Uint8Array): boolean;
      onRequestEnd(id: number): void;
    };
    internals.socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: (data: string | Uint8Array) => {
        if (typeof data === 'string') sent.push(JSON.parse(data));
      },
      close() {},
    };
    cleanups.push(() => client.stop());
    return { client, sent, internals };
  }

  test('the client refuses empty frames and holds nothing for them', () => {
    const { client, internals } = drivenClient();
    internals.onRequest({ type: 'request', id: 1, method: 'POST', path: '/mcp', headers: [] });
    for (let i = 0; i < 100_000; i += 1) expect(internals.onRequestBody(1, new Uint8Array())).toBe(false);
    expect(client.bufferedRequestBodyBytes).toBe(0);
  });

  test('tiny frames assemble into one bounded buffer, and too many frames end the request', () => {
    const { client, sent, internals } = drivenClient({ maxRequestFrames: 4096 });
    internals.onRequest({ type: 'request', id: 1, method: 'POST', path: '/mcp', headers: [] });
    for (let i = 0; i < 4096; i += 1) internals.onRequestBody(1, new Uint8Array([120]));
    expect(client.bufferedRequestBodyBytes).toBeLessThanOrEqual(16 * 1024);
    expect(client.activeRequests).toBe(1);
    internals.onRequestBody(1, new Uint8Array([120]));
    expect(sent.find((m) => m.type === 'response-head')).toMatchObject({ id: 1, status: 400 });
    expect(client.activeRequests).toBe(0);
    expect(client.bufferedRequestBodyBytes).toBe(0);
    // Frames after the refusal are dropped without allocation.
    for (let i = 0; i < 1000; i += 1) internals.onRequestBody(1, new Uint8Array([120]));
    expect(client.bufferedRequestBodyBytes).toBe(0);
  });

  test('requests being assembled share one byte budget', () => {
    const { client, sent, internals } = drivenClient({ maxBufferedRequestBytes: 96 * 1024 });
    internals.onRequest({ type: 'request', id: 1, method: 'POST', path: '/mcp', headers: [] });
    internals.onRequest({ type: 'request', id: 2, method: 'POST', path: '/mcp', headers: [] });
    internals.onRequestBody(1, new Uint8Array(60 * 1024));
    internals.onRequestBody(2, new Uint8Array(60 * 1024));
    expect(sent.find((m) => m.type === 'response-head')).toMatchObject({ id: 2, status: 503 });
    expect(client.bufferedRequestBodyBytes).toBeLessThanOrEqual(96 * 1024);
  });

  test('an unfinished request expires locally, whatever the relay keeps sending', async () => {
    const { client, sent, internals } = drivenClient({ requestAssemblyTimeoutMs: 50 });
    internals.onRequest({ type: 'request', id: 1, method: 'POST', path: '/mcp', headers: [] });
    const feeding = setInterval(() => internals.onRequestBody(1, new Uint8Array([1])), 5);
    try {
      await until(() => client.activeRequests === 0, 2_000);
    } finally {
      clearInterval(feeding);
    }
    expect(sent.find((m) => m.type === 'response-head')).toMatchObject({ id: 1, status: 408 });
    expect(client.bufferedRequestBodyBytes).toBe(0);
  });

  test('the relay refuses empty response frames and coalesces tiny ones within its budget', async () => {
    const socket = fakeSocket();
    const session = new InstallSession('a'.repeat(32), socket, DEFAULT_LIMITS);
    const pending = session.forward({ method: 'POST', path: '/mcp', headers: [], body: new Uint8Array(), signal: new AbortController().signal });
    const id = socket.text.find((m) => m.type === 'request')!.id as number;
    session.onMessage({ type: 'response-head', id, status: 200, headers: [] }, id);
    await pending; // Never read.
    expect(session.onBody(id, new Uint8Array())).toBe('protocol_error');
    for (let i = 0; i < 60_000; i += 1) expect(session.onBody(id, new Uint8Array([1]))).toBe('ok');
    // 60,000 bytes in coalescing buffers: a handful of entries, not 60,000.
    expect(session.queuedBytes).toBeLessThan(80 * 1024);
    expect(session.activeStreams).toBe(1);
    // Past the frame cap the stream is cut, and everything it queued is released.
    for (let i = 0; i < 6_000; i += 1) session.onBody(id, new Uint8Array([1]));
    expect(session.activeStreams).toBe(0);
    expect(session.queuedBytes).toBe(0);
  });
});

describe('F4: forged secrets for a known install id do not spend the owner\'s budget', () => {
  test('continuous invalid-token traffic leaves the owner\'s calls, dashboard and revocation working', async () => {
    const relay = await makeRelay({
      requestsPerInstall: { capacity: 6, refillPerSecond: 0.0001 },
      concurrentPerInstall: 2,
      // Attacker and owner share 127.0.0.1 here; in production the address bucket is the attacker's own.
      publicRequestsPerIp: { capacity: 10_000, refillPerSecond: 0 },
    });
    const identity = loadOrCreateIdentity(tempDir());
    const ownerToken = mintCredential('access', identity.installId);
    const worker = engine(ownerToken);
    await connectClient(relay, worker.url, identity);
    // The owner's credential is confirmed by its first answer.
    expect((await mcpPost(relay, ownerToken, rpc('ping'))).status).toBe(200);
    // A sustained burst of forged secrets, sequential and concurrent.
    for (let i = 0; i < 60; i += 1) expect((await mcpPost(relay, mintCredential('access', identity.installId), rpc('ping'))).status).toBe(401);
    const flood = Array.from({ length: 40 }, () => mcpPost(relay, mintCredential('access', identity.installId), rpc('ping')).then((r) => r.status));
    const ownerDuringFlood = await mcpPost(relay, ownerToken, rpc('tools/list'));
    expect(ownerDuringFlood.status).toBe(200);
    for (const status of await Promise.all(flood)) expect([401, 503]).toContain(status);
    // The owner's budget is intact: calls, the dashboard, and revocation.
    for (let i = 0; i < 3; i += 1) expect((await mcpPost(relay, ownerToken, rpc('ping'))).status).toBe(200);
    const dashboard = await mcpPost(relay, ownerToken, rpc('tools/call', { name: 'olympus_dashboard', arguments: {} }));
    expect(dashboard.status).toBe(200);
    const revoke = await fetch(`${relay.url}/connect/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: mintCredential('refresh', identity.installId) }),
    });
    expect(revoke.status).toBe(200);
    expect(worker.reached.some((line) => line.startsWith('/connect/revoke'))).toBe(true);
    // The marker never reaches the public caller.
    expect(dashboard.headers.get(AUTHENTICATED_RESPONSE_HEADER)).toBeNull();
  });

  test('a credential the engine stops accepting loses the owner lane', async () => {
    const relay = await makeRelay({ requestsPerInstall: { capacity: 2, refillPerSecond: 0.0001 }, publicRequestsPerIp: { capacity: 10_000, refillPerSecond: 0 } });
    const identity = loadOrCreateIdentity(tempDir());
    const ownerToken = mintCredential('access', identity.installId);
    let accept = true;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => (accept
        ? Response.json({}, { headers: { [AUTHENTICATED_RESPONSE_HEADER]: '1' } })
        : Response.json({ error: 'invalid_token' }, { status: 401 })),
    });
    cleanups.push(() => server.stop(true));
    await connectClient(relay, `http://127.0.0.1:${server.port}`, identity);
    expect((await mcpPost(relay, ownerToken, rpc('ping'))).status).toBe(200);
    accept = false;
    // Refused by the engine: refunded, and back in the unverified lane, however often it is tried.
    for (let i = 0; i < 10; i += 1) expect((await mcpPost(relay, ownerToken, rpc('ping'))).status).toBe(401);
  });
});

/** A file registry whose next appends fail, or wait on a gate: the persistence seam. */
class FaultyRegistry extends FileInstallRegistry {
  failNext = 0;
  gate: Promise<void> | undefined;
  appends = 0;

  protected override async append(entry: LogEntry): Promise<void> {
    this.appends += 1;
    if (this.gate) await this.gate;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('simulated fsync failure');
    }
    return super.append(entry);
  }
}

describe('F5: revocation and restore are acknowledged only once durable', () => {
  const ID = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), 'olympus-relay-id-')));

  function registry(): { path: string; registry: FaultyRegistry } {
    const path = join(tempDir(), 'registry.jsonl');
    const registry = new FaultyRegistry(path);
    registry.register(ID.installId, ID.publicKeySpki);
    return { path, registry };
  }

  test('a failed revocation write stays refused, is not acknowledged on retry without writing, and survives restart only once written', async () => {
    const { path, registry: r } = registry();
    await r.flush();
    r.failNext = 1;
    await expect(r.revoke(ID.installId)).rejects.toThrow('simulated fsync failure');
    expect(r.isRevoked(ID.installId)).toBe(true);
    expect(r.operatorChangeState(ID.installId)).toBe('failed');
    expect(new FileInstallRegistry(path).isRevoked(ID.installId)).toBe(false);
    const before = r.appends;
    expect(await r.revoke(ID.installId)).toBe(true);
    expect(r.appends).toBe(before + 1);
    expect(r.operatorChangeState(ID.installId)).toBe('durable');
    expect(new FileInstallRegistry(path).isRevoked(ID.installId)).toBe(true);
    // Only now is a further call "already revoked", without another write.
    expect(await r.revoke(ID.installId)).toBe(false);
    expect(r.appends).toBe(before + 1);
  });

  test('concurrent revocations share one pending write and none resolves before it is durable', async () => {
    const { path, registry: r } = registry();
    await r.flush();
    let open!: () => void;
    r.gate = new Promise((resolve) => (open = resolve));
    const before = r.appends;
    let settled = 0;
    const calls = [r.revoke(ID.installId), r.revoke(ID.installId), r.revoke(ID.installId)].map((p) => p.finally(() => (settled += 1)));
    await Bun.sleep(30);
    expect(settled).toBe(0);
    expect(r.isRevoked(ID.installId)).toBe(true);
    expect(r.operatorChangeState(ID.installId)).toBe('pending');
    r.gate = undefined;
    open();
    expect(await Promise.all(calls)).toEqual([true, true, true]);
    expect(r.appends).toBe(before + 1);
    expect(new FileInstallRegistry(path).isRevoked(ID.installId)).toBe(true);
  });

  test('a failed restore keeps the id refused until a retry is durable', async () => {
    const { path, registry: r } = registry();
    await r.revoke(ID.installId);
    r.failNext = 1;
    await expect(r.restore(ID.installId)).rejects.toThrow('simulated fsync failure');
    expect(r.isRevoked(ID.installId)).toBe(true);
    expect(r.register(ID.installId, ID.publicKeySpki)).toBe(false);
    expect(await r.restore(ID.installId)).toBe(true);
    expect(r.isRevoked(ID.installId)).toBe(false);
    expect(new FileInstallRegistry(path).isRevoked(ID.installId)).toBe(false);
  });

  test('the relay ends the live session even when the write fails, and a retry reports success only once durable', async () => {
    const path = join(tempDir(), 'registry.jsonl');
    const r = new FaultyRegistry(path);
    const relay = await makeRelay({}, r);
    const worker = engine('unused');
    const identity = loadOrCreateIdentity(tempDir());
    await connectClient(relay, worker.url, identity);
    await r.flush();
    r.failNext = 1;
    await expect(relay.revoke(identity.installId)).rejects.toThrow('simulated fsync failure');
    expect(relay.onlineInstalls()).not.toContain(identity.installId);
    expect((await mcpPost(relay, mintCredential('access', identity.installId), rpc('ping'))).status).toBe(401);
    expect(new FileInstallRegistry(path).isRevoked(identity.installId)).toBe(false);
    expect(await relay.revoke(identity.installId)).toMatchObject({ revoked: true });
    expect(new FileInstallRegistry(path).isRevoked(identity.installId)).toBe(true);
  });
});
