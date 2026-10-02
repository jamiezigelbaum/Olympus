/**
 * Codex review of 2026-10-02, relay findings:
 *
 * - Mixed versions connect whichever side deploys first: an install from
 *   before the host-bound signature talks to a current relay (legacy window),
 *   and a current install talks to a relay from before it (one fallback to
 *   the scheme-2 form). Proof of work is asked only of new install ids.
 * - Request bodies stay charged to the upload budget for as long as the relay
 *   holds them (admission wait, forwarding, waiting for the install's answer),
 *   not only while they upload.
 * - One challenge per handshake, and its proof of work stops when the
 *   handshake is given up on.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient, type RelayClientStatus } from '../client/relay-client.ts';
import { loadOrCreateIdentity, type InstallIdentity } from '../client/identity.ts';
import {
  AUTH_BOUND,
  AUTH_LEGACY,
  PROTOCOL_VERSION,
  PowCancelledError,
  base64url,
  encodeBodyFrame,
  installAuthMessage,
  installIdForPublicKey,
  newNonce,
  publicKeyFromSpki,
  signInstallMessage,
  solveRegistrationPow,
  spkiOf,
  verifyInstallMessage,
} from '../shared/protocol.ts';
import { mintCredential } from '../shared/tokens.ts';
import type { RelayLimits } from '../server/limits.ts';
import { MemoryInstallRegistry } from '../server/registry.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';

setDefaultTimeout(30_000);

const PUBLIC_HOST = 'mcp.olympus.test';
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
const logLines: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-compat-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  logLines.length = 0;
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

async function makeRelay(
  limits: Partial<RelayLimits> = {},
  registry: MemoryInstallRegistry = new MemoryInstallRegistry(),
  extra: { trustProxy?: boolean } = {},
): Promise<RelayHandle> {
  const relay = await startRelay({
    publicHost: PUBLIC_HOST,
    registry,
    listen: { host: '127.0.0.1', port: 0 },
    limits,
    log: (event, fields) => logLines.push(JSON.stringify({ event, ...fields })),
    ...extra,
  });
  cleanups.push(() => relay.close());
  return relay;
}

function startClient(url: string, identity: InstallIdentity, extra: { handshakeTimeoutMs?: number } = {}) {
  const statuses: RelayClientStatus[] = [];
  const client = new RelayClient({
    relayHost: PUBLIC_HOST,
    relayUrl: url,
    identity,
    target: 'http://127.0.0.1:9',
    relaySecret: base64url(crypto.getRandomValues(new Uint8Array(32))),
    heartbeatMs: 500,
    backoff: { minMs: 50, maxMs: 200 },
    ...extra,
    onStatus: (status) => statuses.push(status),
  });
  client.start();
  cleanups.push(() => client.stop());
  return { client, statuses };
}

/**
 * An install from before the host binding, as it was shipped: it answers a
 * challenge with `hello` signed over (domain, kind, nonce, id), registers
 * with the same signature and no proof of work when told it is unregistered,
 * and knows nothing of `auth`.
 */
function oldClient(url: string, identity: InstallIdentity): Promise<string> {
  const attempt = (kind: 'hello' | 'register'): Promise<string> => new Promise((resolve) => {
    const socket = new WebSocket(url);
    cleanups.push(() => socket.close());
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'challenge') {
        const sig = signInstallMessage(identity.privateKey, kind, message.nonce, identity.installId, PUBLIC_HOST, AUTH_LEGACY);
        socket.send(JSON.stringify(kind === 'hello'
          ? { type: 'hello', v: PROTOCOL_VERSION, installId: identity.installId, sig }
          : { type: 'register', v: PROTOCOL_VERSION, installId: identity.installId, publicKey: identity.publicKeySpki, sig }));
      } else if (message.type === 'ready') {
        resolve('ready');
      } else if (message.type === 'error') {
        resolve(message.code);
      }
    });
    socket.addEventListener('close', () => resolve('closed'));
  });
  return attempt('hello').then((outcome) => (outcome === 'unregistered' ? attempt('register') : outcome));
}

/**
 * A relay from before the host binding, reduced to its handshake: a
 * challenge with no `pow` and no `auth`, and the scheme-2 verifier only. It
 * ignores fields it does not know, as that relay did.
 */
async function oldRelay() {
  const registry = new Map<string, string>();
  const answers: Array<Record<string, unknown>> = [];
  const sockets = new Set<ServerWebSocket<{ nonce: string }>>();
  const server = Bun.serve<{ nonce: string }, never>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, srv) {
      return srv.upgrade(request, { data: { nonce: newNonce() } }) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: 'challenge', v: PROTOCOL_VERSION, nonce: ws.data.nonce }));
      },
      message(ws, data) {
        const message = JSON.parse(String(data));
        if (message.type === 'ping') return void ws.send(JSON.stringify({ type: 'pong' }));
        answers.push(message);
        const fail = (code: string) => {
          ws.send(JSON.stringify({ type: 'error', code, message: code }));
          ws.close(4000, code);
        };
        if (message.v !== PROTOCOL_VERSION) return fail('unsupported_version');
        let publicKey: string | undefined;
        if (message.type === 'register') {
          const key = publicKeyFromSpki(message.publicKey);
          if (installIdForPublicKey(spkiOf(key)) !== message.installId) return fail('id_mismatch');
          if (!verifyInstallMessage(key, 'register', ws.data.nonce, message.installId, PUBLIC_HOST, message.sig, AUTH_LEGACY)) return fail('bad_signature');
          registry.set(message.installId, message.publicKey);
          publicKey = message.publicKey;
        } else {
          publicKey = registry.get(message.installId);
          if (!publicKey) return fail('unregistered');
          if (!verifyInstallMessage(publicKeyFromSpki(publicKey), 'hello', ws.data.nonce, message.installId, PUBLIC_HOST, message.sig, AUTH_LEGACY)) {
            return fail('bad_signature');
          }
        }
        ws.send(JSON.stringify({ type: 'ready', installId: message.installId }));
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  // Not awaited: Bun's forced stop can wait on a socket the server closed itself.
  cleanups.push(() => void server.stop(true));
  return {
    url: `ws://127.0.0.1:${server.port}/v2/connect`,
    answers,
    registry,
    dropAll: () => { for (const ws of sockets) ws.close(1001, 'restart'); },
  };
}

describe('mixed-version handshake: deploy order does not matter', () => {
  test('old install -> new relay: a registered install connects with its pre-binding signature during the legacy window', async () => {
    const registry = new MemoryInstallRegistry();
    const identity = loadOrCreateIdentity(tempDir());
    // Registered by the old relay; the registry carries over to the new one.
    registry.register(identity.installId, identity.publicKeySpki);
    const relay = await makeRelay({}, registry);
    expect(await oldClient(`ws://127.0.0.1:${relay.port}/v2/connect`, identity)).toBe('ready');
    expect(relay.onlineInstalls()).toEqual([identity.installId]);
    expect(logLines.some((line) => line.includes('"event":"session_ready"') && line.includes('"legacy_auth":true'))).toBe(true);
  });

  test('old install -> new relay: an expired (returning) install re-registers with no proof of work; a new id still needs it', async () => {
    let clock = Date.now();
    const registry = new MemoryInstallRegistry(100_000, () => clock);
    const returning = loadOrCreateIdentity(tempDir());
    registry.register(returning.installId, returning.publicKeySpki);
    clock += 91 * 24 * 60 * 60_000;
    registry.expire(clock, 90 * 24 * 60 * 60_000, () => false);
    expect(registry.wasRemoved(returning.installId)).toBe(true);
    const relay = await makeRelay({}, registry);
    const url = `ws://127.0.0.1:${relay.port}/v2/connect`;
    expect(await oldClient(url, returning)).toBe('ready');
    expect(registry.get(returning.installId)).toBeDefined();
    // A brand-new id from an old install cannot pay the proof of work: refused before any budget is spent.
    expect(await oldClient(url, loadOrCreateIdentity(tempDir()))).toBe('bad_request');
    expect(logLines.join('\n')).toContain('"reason":"pow"');
  });

  test('a closed legacy window refuses the pre-binding signature; scheme 3 still connects', async () => {
    const registry = new MemoryInstallRegistry();
    const identity = loadOrCreateIdentity(tempDir());
    registry.register(identity.installId, identity.publicKeySpki);
    const relay = await makeRelay({ acceptLegacyAuth: false }, registry);
    const url = `ws://127.0.0.1:${relay.port}/v2/connect`;
    expect(await oldClient(url, identity)).toBe('bad_signature');
    const current = startClient(url, identity);
    await until(() => current.statuses.at(-1)?.state === 'online');
    expect(logLines.some((line) => line.includes('legacy_auth'))).toBe(false);
  });

  test('new install -> old relay: scheme 3 is rejected once, the install falls back to scheme 2 and comes online', async () => {
    const old = await oldRelay();
    const identity = loadOrCreateIdentity(tempDir());
    const install = startClient(old.url, identity);
    await until(() => install.statuses.at(-1)?.state === 'online');
    // hello(3) -> unregistered; register(3) -> bad_signature; register(2) -> ready.
    expect(old.answers.map((answer) => `${answer.type}:${answer.auth ?? AUTH_LEGACY}`)).toEqual([
      `hello:${AUTH_BOUND}`,
      `register:${AUTH_BOUND}`,
      `register:${AUTH_LEGACY}`,
    ]);
    // The legacy register is the old wire form: no auth, no proof of work.
    expect(Object.keys(old.answers[2]!).sort()).toEqual(['installId', 'publicKey', 'sig', 'type', 'v']);
    // A reconnect to the same relay goes straight to scheme 2.
    old.dropAll();
    await until(() => old.answers.length === 4 && install.statuses.at(-1)?.state === 'online');
    expect(old.answers[3]).toMatchObject({ type: 'hello' });
    expect(old.answers[3]!.auth).toBeUndefined();
  });

  test('new install -> new relay: scheme 3 only, never the legacy form', async () => {
    const relay = await makeRelay();
    const install = startClient(`ws://127.0.0.1:${relay.port}/v2/connect`, loadOrCreateIdentity(tempDir()));
    await until(() => install.statuses.at(-1)?.state === 'online');
    expect(logLines.some((line) => line.includes('legacy_auth'))).toBe(false);
  });

  test('an install that signs scheme 3 without naming it (released between binding and negotiation) connects', async () => {
    const relay = await makeRelay();
    const identity = loadOrCreateIdentity(tempDir());
    const outcome = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/v2/connect`);
      cleanups.push(() => socket.close());
      socket.addEventListener('message', async (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === 'challenge') {
          const auth = await installAuthMessage({ kind: 'register', identity, nonce: message.nonce, powBits: message.pow, relayHost: PUBLIC_HOST });
          const { auth: _named, ...unnamed } = auth;
          socket.send(JSON.stringify(unnamed));
        } else if (message.type === 'ready' || message.type === 'error') {
          resolve(message.type === 'ready' ? 'ready' : message.code);
        }
      });
    });
    expect(outcome).toBe('ready');
  });

  test('the challenge advertises scheme 3; an answer naming an unknown scheme is refused', async () => {
    const relay = await makeRelay();
    const identity = loadOrCreateIdentity(tempDir());
    const outcome = await new Promise<{ challenge: Record<string, unknown>; code: string }>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/v2/connect`);
      cleanups.push(() => socket.close());
      let challenge: Record<string, unknown> = {};
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === 'challenge') {
          challenge = message;
          socket.send(JSON.stringify({
            type: 'hello',
            v: PROTOCOL_VERSION,
            installId: identity.installId,
            sig: signInstallMessage(identity.privateKey, 'hello', message.nonce, identity.installId, PUBLIC_HOST),
            auth: 9,
          }));
        } else if (message.type === 'error') {
          resolve({ challenge, code: message.code });
        }
      });
    });
    expect(outcome.challenge.auth).toBe(AUTH_BOUND);
    expect(outcome.code).toBe('unsupported_version');
  });

  test('a relay that advertises scheme 3 and rejects the signature gets no downgrade', async () => {
    const identity = loadOrCreateIdentity(tempDir());
    // A registered install whose scheme-3 hello is rejected (it signs for another relay host).
    const registry = new MemoryInstallRegistry();
    registry.register(identity.installId, identity.publicKeySpki);
    const other = await makeRelay({}, registry);
    const statuses: RelayClientStatus[] = [];
    const client = new RelayClient({
      relayHost: 'other-relay.example',
      relayUrl: `ws://127.0.0.1:${other.port}/v2/connect`,
      identity,
      target: 'http://127.0.0.1:9',
      relaySecret: base64url(crypto.getRandomValues(new Uint8Array(32))),
      backoff: { minMs: 50, maxMs: 100 },
      onStatus: (status) => statuses.push(status),
    });
    client.start();
    cleanups.push(() => client.stop());
    await until(() => statuses.filter((status) => status.state === 'offline').length >= 3);
    expect(statuses.some((status) => status.state === 'online')).toBe(false);
    expect(logLines.some((line) => line.includes('legacy_auth'))).toBe(false);
    expect(other.onlineInstalls()).toEqual([]);
  });
});

describe('request bodies are charged for as long as the relay holds them', () => {
  /** A raw HTTP request whose status line is read as it arrives. */
  function rawPost(port: number, xff: string, headers: string, body: string) {
    const socket = new Socket();
    const state = { received: '' };
    socket.on('data', (data) => (state.received += data.toString('latin1')));
    socket.on('error', () => {});
    socket.connect(port, '127.0.0.1', () => {
      socket.write(`POST /mcp HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: ${xff}\r\n${headers}Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    });
    cleanups.push(() => socket.destroy());
    return { status: () => Number(/^HTTP\/1\.1 (\d{3})/.exec(state.received)?.[1] ?? 0) };
  }

  /** An install that holds every request until `release()`, then answers 200. */
  async function slowInstall(relay: RelayHandle) {
    const identity = loadOrCreateIdentity(tempDir());
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/v2/connect`);
    socket.binaryType = 'arraybuffer';
    const pending: number[] = [];
    let ready = false;
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data);
      if (message.type === 'challenge') {
        void installAuthMessage({ kind: 'register', identity, nonce: message.nonce, powBits: message.pow, relayHost: PUBLIC_HOST })
          .then((auth) => socket.send(JSON.stringify(auth)));
      } else if (message.type === 'ready') {
        ready = true;
      } else if (message.type === 'end') {
        pending.push(message.id);
      }
    });
    cleanups.push(() => socket.close());
    await until(() => ready);
    return {
      identity,
      pending,
      release() {
        for (const id of pending.splice(0)) {
          socket.send(JSON.stringify({ type: 'response-head', id, status: 200, headers: [['content-type', 'application/json']] }));
          socket.send(encodeBodyFrame(id, new TextEncoder().encode('{}')));
          socket.send(JSON.stringify({ type: 'end', id }));
        }
      },
    };
  }

  test('PoC: a body forwarded to an install stays charged until its stream ends, so one address cannot exceed its cap by waiting', async () => {
    // 512 KiB relay-wide: 32 KiB per address.
    const relay = await makeRelay(
      { maxUploadBufferedBytes: 512 * 1024, publicRequestsPerIp: { capacity: 1000, refillPerSecond: 0 }, responseHeadTimeoutMs: 20_000 },
      new MemoryInstallRegistry(),
      { trustProxy: true },
    );
    const install = await slowInstall(relay);
    const auth = `Authorization: Bearer ${mintCredential('access', install.identity.installId)}\r\n`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { pad: 'x'.repeat(20 * 1024) } });
    const first = rawPost(relay.port, '203.0.113.70', auth, body);
    await until(() => install.pending.length === 1);
    // Uploaded, forwarded, unanswered: no longer uploading, still held.
    expect(relay.status().uploading).toBe(0);
    expect(relay.status().heldRequestBytes).toBe(body.length);
    // The same address's next body does not fit beside it.
    const second = rawPost(relay.port, '203.0.113.70', auth, body);
    await until(() => second.status() !== 0);
    expect(second.status()).toBe(503);
    expect(first.status()).toBe(0);
    // Another address is unaffected.
    const other = rawPost(relay.port, '198.51.100.70', auth, body);
    await until(() => install.pending.length === 2);
    install.release();
    await until(() => first.status() === 200 && other.status() === 200);
    await until(() => relay.status().heldRequestBytes === 0 && relay.status().inFlight === 0);
  });

  test('a body waiting for an admission slot is charged; refused, offline and answered requests release it', async () => {
    const relay = await makeRelay(
      {
        unverifiedConcurrentPerInstall: 1,
        unverifiedPerAddress: 1,
        unverifiedQueuePerAddress: 2,
        unverifiedQueueWaitMs: 300,
        publicRequestsPerIp: { capacity: 1000, refillPerSecond: 0 },
      },
      new MemoryInstallRegistry(),
      { trustProxy: true },
    );
    const install = await slowInstall(relay);
    const auth = `Authorization: Bearer ${mintCredential('access', install.identity.installId)}\r\n`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'y'.repeat(1000) });
    const holding = rawPost(relay.port, '203.0.113.80', auth, body);
    await until(() => install.pending.length === 1);
    const waiting = rawPost(relay.port, '203.0.113.80', auth, body);
    await until(() => relay.status().heldRequestBytes === 2 * body.length);
    // The waiter gives up (503) and its body is released; the forwarded one is still held.
    await until(() => waiting.status() !== 0);
    expect(waiting.status()).toBe(503);
    expect(relay.status().heldRequestBytes).toBe(body.length);
    install.release();
    await until(() => holding.status() === 200);
    await until(() => relay.status().heldRequestBytes === 0);
    // An offline install's answer comes from the relay; nothing stays held.
    const offlineRegistry = new MemoryInstallRegistry();
    const offlineId = loadOrCreateIdentity(tempDir());
    offlineRegistry.register(offlineId.installId, offlineId.publicKeySpki);
    const offlineRelay = await makeRelay({}, offlineRegistry);
    const offline = await fetch(`${offlineRelay.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mintCredential('access', offlineId.installId)}`, 'content-type': 'application/json' },
      body,
    });
    expect(offline.status).toBe(200);
    await offline.text();
    expect(offlineRelay.status().heldRequestBytes).toBe(0);
  });
});

describe('one challenge per handshake; its proof of work stops with the handshake', () => {
  test('a cancelled solve rejects at once and does no more work', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const solving = solveRegistrationPow(22, 'nonce', 'a'.repeat(32), PUBLIC_HOST, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(solving).rejects.toBeInstanceOf(PowCancelledError);
    expect(Date.now() - started).toBeLessThan(1_000);
    const aborted = new AbortController();
    aborted.abort();
    const identity = loadOrCreateIdentity(tempDir());
    await expect(installAuthMessage({ kind: 'register', identity, nonce: 'n', powBits: 22, relayHost: PUBLIC_HOST, signal: aborted.signal }))
      .rejects.toBeInstanceOf(PowCancelledError);
  });

  /** A hostile relay: sends `challenges` max-difficulty challenges and never answers. */
  async function hostileRelay(challenges: number) {
    const closes: number[] = [];
    const answers: unknown[] = [];
    const server = Bun.serve<undefined, never>({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, srv) => (srv.upgrade(request, { data: undefined }) ? undefined : new Response('no', { status: 400 })),
      websocket: {
        open(ws) {
          for (let i = 0; i < challenges; i += 1) ws.send(JSON.stringify({ type: 'challenge', v: PROTOCOL_VERSION, nonce: newNonce(), pow: 22, auth: AUTH_BOUND }));
        },
        message(_ws, data) {
          answers.push(data);
        },
        close(_ws, code) {
          closes.push(code);
        },
      },
    });
    cleanups.push(() => server.stop(true));
    return { url: `ws://127.0.0.1:${server.port}/v2/connect`, closes, answers };
  }

  /** CPU milliseconds this process spends over `ms` of wall time. */
  async function cpuOver(ms: number): Promise<number> {
    const before = process.cpuUsage();
    await Bun.sleep(ms);
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
  }

  test('a second challenge on one handshake closes the session as a protocol error', async () => {
    const hostile = await hostileRelay(2);
    const install = startClient(hostile.url, loadOrCreateIdentity(tempDir()));
    // The client registers on first contact only after `unregistered`; force a register to make the challenge costly.
    (install.client as unknown as { register: boolean }).register = true;
    await until(() => hostile.closes.length >= 1);
    expect(hostile.closes[0]).toBe(4002);
    await install.client.stop();
    // Nothing keeps solving once the client has stopped.
    expect(await cpuOver(400)).toBeLessThan(200);
  });

  test('a handshake timeout and a stop each cancel the solver', async () => {
    const hostile = await hostileRelay(1);
    const identity = loadOrCreateIdentity(tempDir());
    const statuses: RelayClientStatus[] = [];
    const client = new RelayClient({
      relayHost: PUBLIC_HOST,
      relayUrl: hostile.url,
      identity,
      target: 'http://127.0.0.1:9',
      relaySecret: base64url(crypto.getRandomValues(new Uint8Array(32))),
      handshakeTimeoutMs: 150,
      backoff: { minMs: 60_000, maxMs: 60_000 },
      onStatus: (status) => statuses.push(status),
    });
    (client as unknown as { register: boolean }).register = true;
    client.start();
    cleanups.push(() => client.stop());
    await until(() => statuses.some((status) => status.state === 'offline'));
    // Timed out and waiting a minute to retry: the 22-bit solve (seconds of CPU) is not running.
    expect(await cpuOver(500)).toBeLessThan(250);
    expect(hostile.answers).toEqual([]);

    const second = await hostileRelay(1);
    const stopping = new RelayClient({
      relayHost: PUBLIC_HOST,
      relayUrl: second.url,
      identity,
      target: 'http://127.0.0.1:9',
      relaySecret: base64url(crypto.getRandomValues(new Uint8Array(32))),
      handshakeTimeoutMs: 60_000,
    });
    (stopping as unknown as { register: boolean }).register = true;
    stopping.start();
    await Bun.sleep(100);
    await stopping.stop();
    expect(await cpuOver(500)).toBeLessThan(250);
    expect(second.answers).toEqual([]);
  });
});
