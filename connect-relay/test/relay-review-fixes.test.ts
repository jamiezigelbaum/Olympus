/**
 * Regression proofs for the relay review of 2026-10-02: what a rogue install
 * may serve on the relay origin, upload byte accounting, invalid response
 * heads, pending sockets, registration cost and expiry, the session
 * signature's relay binding, and egress budgets.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient, type RelayClientStatus } from '../client/relay-client.ts';
import { DEMO_AUTHORIZE_PATH, FORWARDED_PATHS } from '../client/forward.ts';
import { loadOrCreateIdentity, type InstallIdentity } from '../client/identity.ts';
import {
  PROTOCOL_VERSION,
  base64url,
  encodeBodyFrame,
  installAuthMessage,
  signInstallMessage,
  solveRegistrationPow,
  verifyRegistrationPow,
} from '../shared/protocol.ts';
import { prefixKey, addressKey } from '../shared/rate-limit.ts';
import { AUTHENTICATED_RESPONSE_HEADER, mintCredential } from '../shared/tokens.ts';
import type { RelayLimits } from '../server/limits.ts';
import { FileInstallRegistry, MemoryInstallRegistry } from '../server/registry.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';
import { createChatGptHandoffHandler, createChatGptHandoffs } from '../../src/workers/chatgpt/handoff.ts';
import { CONNECT_PAGE_SCRIPT_HASH } from '../shared/connect-page.ts';
import { submitThroughScript } from './fixtures/connect-page-browser.ts';

setDefaultTimeout(20_000);

const PUBLIC_HOST = 'mcp.olympus.test';
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
const logLines: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-review-'));
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

async function makeRelay(
  limits: Partial<RelayLimits> = {},
  registry: MemoryInstallRegistry = new MemoryInstallRegistry(),
  extra: { trustProxy?: boolean; now?: () => number } = {},
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

interface Head {
  status: number;
  headers: Array<[string, string]>;
  body?: string;
}

/** An install the attacker controls: registers its own key and answers every request with `answer`. */
async function rogueInstall(relay: RelayHandle, answer: (request: { method: string; path: string }) => Head) {
  const identity = loadOrCreateIdentity(tempDir());
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/v2/connect`);
  socket.binaryType = 'arraybuffer';
  const seen: string[] = [];
  const cancels: number[] = [];
  let ready = false;
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    const message = JSON.parse(event.data);
    if (message.type === 'challenge') {
      void installAuthMessage({ kind: 'register', identity, nonce: message.nonce, powBits: message.pow, relayHost: PUBLIC_HOST })
        .then((auth) => socket.send(JSON.stringify(auth)));
    } else if (message.type === 'ready') {
      ready = true;
    } else if (message.type === 'cancel') {
      cancels.push(message.id);
    } else if (message.type === 'request') {
      seen.push(`${message.method} ${message.path}`);
      const head = answer({ method: message.method, path: message.path });
      socket.send(JSON.stringify({ type: 'response-head', id: message.id, status: head.status, headers: head.headers }));
      if (head.body) socket.send(encodeBodyFrame(message.id, new TextEncoder().encode(head.body)));
      socket.send(JSON.stringify({ type: 'end', id: message.id }));
    }
  });
  cleanups.push(() => socket.close());
  await until(() => ready);
  return { identity, socket, seen, cancels };
}

async function connectClient(relay: RelayHandle, target: string, identity: InstallIdentity = loadOrCreateIdentity(tempDir()), relayHost = PUBLIC_HOST) {
  const statuses: RelayClientStatus[] = [];
  const client = new RelayClient({
    relayHost,
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
  return { client, identity, statuses };
}

const handbackState = (installId: string) =>
  `${Buffer.from(JSON.stringify({ nonce: `${installId}_${'a'.repeat(22)}` })).toString('base64url')}.sig`;

/**
 * One raw session attempt from `xff` (the relay trusts the proxy header):
 * answers the challenge with `answer` and reports the first refusal code,
 * `ready`, or how the socket ended.
 */
function rawSession(
  relay: RelayHandle,
  xff: string,
  answer?: (challenge: { nonce: string; pow: number }) => Promise<unknown> | unknown,
): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/v2/connect`, { headers: { 'x-forwarded-for': xff } } as unknown as string[]);
    cleanups.push(() => socket.close());
    socket.addEventListener('message', async (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'challenge' && answer) socket.send(JSON.stringify(await answer(message)));
      else if (message.type === 'error') resolve(message.code);
      else if (message.type === 'ready') resolve('ready');
    });
    socket.addEventListener('error', () => resolve('error'));
    socket.addEventListener('close', (event) => resolve(`closed:${event.code}`));
  });
}

describe('1: install answers on the relay origin are sandboxed and checked', () => {
  test('PoC: a rogue install\'s script page gets an opaque-origin sandbox; a JavaScript answer and a foreign redirect get 502', async () => {
    const relay = await makeRelay();
    const rogue = await rogueInstall(relay, ({ path }) => {
      if (path.includes('redirect')) return { status: 302, headers: [['location', 'https://evil.example/']] };
      if (path.startsWith('/oauth/callback/')) return { status: 200, headers: [['content-type', 'text/javascript']], body: 'self.onfetch=e=>{}' };
      return {
        status: 200,
        headers: [['content-type', 'text/html'], ['x-content-type-options', 'off'], ['referrer-policy', 'unsafe-url'], ['content-security-policy', "script-src 'unsafe-inline'"]],
        body: '<script>navigator.serviceWorker.register("/oauth/callback/gmail?state=x")</script>',
      };
    });
    const handoff = mintCredential('handoff', rogue.identity.installId);
    const page = await fetch(`${relay.url}/go/${handoff}`, { redirect: 'manual' });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    // Both policies are enforced. The relay's sandboxes the page with an
    // opaque origin and allows exactly one script, the pinned connect-page
    // script, so the install's own `unsafe-inline` runs nothing.
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'unsafe-inline'");
    const relayPolicy = csp.split(', ').find((policy) => policy.startsWith('sandbox'))!;
    expect(relayPolicy).toMatch(/^sandbox allow-scripts allow-forms; default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]+=*';/);
    expect(relayPolicy).toContain(`script-src ${CONNECT_PAGE_SCRIPT_HASH};`);
    expect(relayPolicy).toContain(`form-action https://${PUBLIC_HOST}/go/;`);
    expect(csp).not.toContain('allow-same-origin');

    const state = handbackState(rogue.identity.installId);
    const script = await fetch(`${relay.url}/oauth/callback/gmail?state=${state}`, { redirect: 'manual' });
    expect(script.status).toBe(502);
    expect(script.headers.get('content-type')).toBe('application/json');
    expect(await script.text()).not.toContain('onfetch');
    // The install was told to stop.
    await until(() => rogue.cancels.length === 1);

    const redirect = await fetch(`${relay.url}/oauth/callback/gmail?state=${state}&redirect=1`, { redirect: 'manual' });
    expect(redirect.status).toBe(502);
    expect(redirect.headers.get('location')).toBeNull();
    expect(logLines.join('\n')).toContain('"reason":"response_content_type"');
    expect(logLines.join('\n')).toContain('"reason":"response_redirect"');
    expect(logLines.join('\n')).not.toContain('evil.example');
  });

  test('a service-worker script fetch is refused on every route, before any install sees it', async () => {
    const relay = await makeRelay();
    const rogue = await rogueInstall(relay, () => ({ status: 200, headers: [['content-type', 'text/plain']], body: 'x' }));
    const state = handbackState(rogue.identity.installId);
    for (const path of [`/oauth/callback/gmail?state=${state}`, `/go/${mintCredential('handoff', rogue.identity.installId)}`, '/healthz']) {
      const refused = await fetch(`${relay.url}${path}`, { headers: { 'service-worker': 'script' } });
      expect(refused.status, path).toBe(403);
    }
    expect(rogue.seen).toEqual([]);
  });

  test('browser routes redirect only to the provider sign-ins, the engine\'s loopback port, or the relay', async () => {
    const relay = await makeRelay();
    let location = '';
    const rogue = await rogueInstall(relay, () => ({ status: 302, headers: [['location', location]] }));
    const link = () => `${relay.url}/go/${mintCredential('handoff', rogue.identity.installId)}`;
    const allowed = [
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      'https://www.dropbox.com/oauth2/authorize?client_id=x',
      'http://127.0.0.1:8010/dashboard',
      `https://${PUBLIC_HOST}/oauth/callback/gmail/done`,
      '/oauth/callback/gmail/done',
    ];
    for (const target of allowed) {
      location = target;
      const response = await fetch(link(), { redirect: 'manual' });
      expect(response.status, target).toBe(302);
      expect(response.headers.get('location'), target).toBe(target);
    }
    const refused = [
      'https://evil.example/',
      '//evil.example/x',
      'https://accounts.google.com.evil.example/',
      'http://accounts.google.com/',
      'http://127.0.0.1:9999/',
      'javascript:alert(1)',
      'https://user:pass@accounts.google.com/',
    ];
    for (const target of refused) {
      location = target;
      expect((await fetch(link(), { redirect: 'manual' })).status, target).toBe(502);
    }
    // API routes never redirect, and serve no HTML.
    location = 'https://accounts.google.com/';
    const token = mintCredential('access', rogue.identity.installId);
    const mcp = await fetch(`${relay.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}', redirect: 'manual' });
    expect(mcp.status).toBe(502);
  });

  test('API routes serve JSON, event streams or text only', async () => {
    const relay = await makeRelay();
    let contentType = 'text/html';
    const rogue = await rogueInstall(relay, () => ({ status: 200, headers: [['content-type', contentType]], body: '<p>x</p>' }));
    const token = mintCredential('access', rogue.identity.installId);
    const post = () => fetch(`${relay.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' });
    expect((await post()).status).toBe(502);
    contentType = 'image/svg+xml';
    expect((await post()).status).toBe(502);
    for (const ok of ['application/json', 'application/json; charset=utf-8', 'text/event-stream', 'text/plain']) {
      contentType = ok;
      const response = await post();
      expect(response.status, ok).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain('sandbox');
    }
    // Two content types are refused, not merged.
    const twice = await rogueInstall(relay, () => ({ status: 200, headers: [['content-type', 'application/json'], ['content-type', 'text/html']], body: '{}' }));
    expect((await fetch(`${relay.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${mintCredential('access', twice.identity.installId)}` }, body: '{}' })).status).toBe(502);
  });

  test('the engine\'s own hand-off answers pass: its redirect to the provider and its expired-link page', async () => {
    const handoffs = createChatGptHandoffs();
    const handler = createChatGptHandoffHandler(handoffs);
    const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
    cleanups.push(() => worker.stop(true));
    const relay = await makeRelay();
    const install = await connectClient(relay, `http://127.0.0.1:${worker.port}`);
    await until(() => install.statuses.at(-1)?.state === 'online');
    const target = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=s';
    const link = handoffs.mint(install.identity.installId, { kind: 'redirect', location: target });
    const redirect = await fetch(`${relay.url}/go/${link.id}`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(target);
    const used = await fetch(`${relay.url}/go/${link.id}`, { redirect: 'manual' });
    expect(used.status).toBe(404);
    expect(used.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await used.text()).toContain('expired or was already used');
    expect(used.headers.get('content-security-policy')).toContain("style-src 'unsafe-inline'");
  });

  test('a connect page round trip through the relay: the page, then one sealed POST the relay cannot read', async () => {
    const handoffs = createChatGptHandoffs();
    const received: Array<{ source: string; fields: Record<string, string> }> = [];
    const handler = createChatGptHandoffHandler(handoffs, {
      publicOrigin: () => `https://${PUBLIC_HOST}`,
      submit: async (source, fields) => {
        received.push({ source, fields });
        return { status: 'connected' };
      },
    });
    const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
    cleanups.push(() => worker.stop(true));
    const relay = await makeRelay();
    const install = await connectClient(relay, `http://127.0.0.1:${worker.port}`);
    await until(() => install.statuses.at(-1)?.state === 'online');
    const link = handoffs.mint(install.identity.installId, { kind: 'key_page', source: 'readwise' });
    const page = await fetch(`${relay.url}/go/${link.id}`);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain(CONNECT_PAGE_SCRIPT_HASH);
    const token = 'SENTINEL_RELAY_TOKEN_7f3a';
    const sent = await submitThroughScript(await page.text(), { token });
    expect(sent.body).not.toContain(token);
    const posted = await fetch(`${relay.url}/go/${link.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      body: sent.body,
    });
    expect(posted.status).toBe(200);
    expect(await posted.text()).toContain('Readwise is connected');
    expect(received).toEqual([{ source: 'readwise', fields: { token } }]);
    // Replayed through the relay: spent.
    const replay = await fetch(`${relay.url}/go/${link.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      body: sent.body,
    });
    expect(replay.status).toBe(404);
    expect(received).toHaveLength(1);
    expect(logLines.join('\n')).not.toContain('SENTINEL');
    expect(logLines.join('\n')).not.toContain(sent.body.slice(0, 40));
  });

  test('the relay forwards a /go/ POST only as a small form', async () => {
    const relay = await makeRelay();
    const rogue = await rogueInstall(relay, () => ({ status: 200, headers: [['content-type', 'text/plain']], body: 'ok' }));
    const link = `${relay.url}/go/${mintCredential('handoff', rogue.identity.installId)}`;
    expect((await fetch(link, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(415);
    expect((await fetch(link, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `ct=${'a'.repeat(9000)}` })).status).toBe(413);
    expect((await fetch(link, { method: 'PUT', body: 'x' })).status).toBe(405);
    expect(rogue.seen).toEqual([]);
    expect((await fetch(link, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'ct=a' })).status).toBe(200);
    expect(rogue.seen).toEqual([`POST /go/${link.split('/go/')[1]}`]);
  });

  test('the demo sign-in keeps its origin and may submit its form, but runs no script', async () => {
    const worker = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => request.method === 'POST'
        ? new Response(null, { status: 303, headers: { location: 'https://chatgpt.com/connector_platform_oauth_redirect?code=c' } })
        : new Response('<form method="post"></form>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    cleanups.push(() => worker.stop(true));
    const identity = loadOrCreateIdentity(tempDir());
    const relay = await startRelay({ publicHost: PUBLIC_HOST, registry: new MemoryInstallRegistry(), listen: { host: '127.0.0.1', port: 0 }, demoInstallId: identity.installId });
    cleanups.push(() => relay.close());
    const statuses: RelayClientStatus[] = [];
    const client = new RelayClient({
      relayHost: PUBLIC_HOST,
      relayUrl: `ws://127.0.0.1:${relay.port}/v2/connect`,
      identity,
      target: `http://127.0.0.1:${worker.port}`,
      relaySecret: 'x'.repeat(43),
      forwardedPaths: [...FORWARDED_PATHS, DEMO_AUTHORIZE_PATH],
      onStatus: (status) => statuses.push(status),
    });
    client.start();
    cleanups.push(() => client.stop());
    await until(() => statuses.at(-1)?.state === 'online');
    const page = await fetch(`${relay.url}/connect/demo/authorize?state=s`);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain('sandbox allow-forms allow-same-origin;');
    expect(csp).toContain("script-src 'none'");
    const posted = await fetch(`${relay.url}/connect/demo/authorize`, { method: 'POST', body: 'a=b', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toStartWith('https://chatgpt.com/');
  });

  test('the relay origin is not a panel origin by default', async () => {
    const relay = await makeRelay();
    const rogue = await rogueInstall(relay, () => ({ status: 200, headers: [['content-type', 'application/json']], body: '{}' }));
    const jobId = mintCredential('private', rogue.identity.installId);
    const response = await fetch(`${relay.url}/private/${jobId}`, { method: 'POST', headers: { origin: `https://${PUBLIC_HOST}` }, body: '{}' });
    expect(response.status).toBe(403);
    expect(rogue.seen).toEqual([]);
  });
});

describe('2: upload bytes are charged as they arrive, per address too', () => {
  test('PoC: 64 declared-but-unsent 1 MiB bodies from one address leave the relay serving everyone else', async () => {
    const relay = await makeRelay({}, new MemoryInstallRegistry(), { trustProxy: true });
    // A real install's id, so the body is read with the full 1 MiB cap.
    const rogue = await rogueInstall(relay, () => ({ status: 200, headers: [['content-type', 'application/json']], body: '{}' }));
    const token = mintCredential('access', rogue.identity.installId);
    const sockets: Socket[] = [];
    for (let i = 0; i < 64; i += 1) {
      const socket = new Socket();
      await new Promise<void>((resolve) => socket.connect(relay.port, '127.0.0.1', () => resolve()));
      socket.on('error', () => {});
      socket.write(`POST /mcp HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 203.0.113.1\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 1048576\r\n\r\n{`);
      sockets.push(socket);
      cleanups.push(() => socket.destroy());
    }
    await until(() => relay.status().uploading === 64).catch(() => { throw new Error(`uploading ${relay.status().uploading}`); });
    const victim = await fetch(`${relay.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(victim.status).toBe(200);
  });

  test('one address holds at most a sixteenth of the upload budget; another address is unaffected', async () => {
    const relay = await makeRelay(
      { maxUploadBufferedBytes: 512 * 1024, uploadTimeoutMs: 3_000, uploadIdleTimeoutMs: 3_000, publicRequestsPerIp: { capacity: 1000, refillPerSecond: 0 } },
      new MemoryInstallRegistry(),
      { trustProxy: true },
    );
    // 32 KiB per address: one 20 KiB body (32 KiB buffer) fits; a second does not.
    const held = (xff: string, bytes: number) => {
      const socket = new Socket();
      const state = { received: '' };
      socket.on('data', (data) => (state.received += data.toString('latin1')));
      socket.on('error', () => {});
      socket.connect(relay.port, '127.0.0.1', () => {
        socket.write(`POST /mcp HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: ${xff}\r\nContent-Type: application/json\r\nContent-Length: 65536\r\n\r\n${'x'.repeat(bytes)}`);
      });
      cleanups.push(() => socket.destroy());
      return { status: () => Number(/^HTTP\/1\.1 (\d{3})/.exec(state.received)?.[1] ?? 0) };
    };
    const first = held('203.0.113.9', 20 * 1024);
    await until(() => relay.status().uploading === 1);
    await Bun.sleep(100);
    const second = held('203.0.113.9', 20 * 1024);
    await until(() => second.status() !== 0);
    expect(second.status()).toBe(503);
    expect(first.status()).toBe(0);
    const other = held('198.51.100.20', 20 * 1024);
    await Bun.sleep(200);
    expect(other.status()).toBe(0);
  });

  test('a body for the relay\'s own anonymous /mcp answers is capped small', async () => {
    const relay = await makeRelay();
    const big = await fetch(`${relay.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(100 * 1024) });
    expect(big.status).toBe(413);
    const small = await fetch(`${relay.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect(small.status).toBe(200);
  });
});

describe('3: an invalid response header fails the request at once', () => {
  test('PoC: a CRLF header value answers 502 promptly, tells the install to stop, and leaves nothing in flight', async () => {
    const relay = await makeRelay({ responseHeadTimeoutMs: 60_000 });
    const rogue = await rogueInstall(relay, () => ({ status: 200, headers: [['content-type', 'a\r\nb']] }));
    const startedAt = Date.now();
    const response = await fetch(`${relay.url}/go/${mintCredential('handoff', rogue.identity.installId)}`);
    expect(response.status).toBe(502);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await until(() => rogue.cancels.length === 1);
    expect(relay.status().inFlight).toBe(0);
    for (const bad of [['x-a b', 'v'], ['cache-control', 'a\u0000b'], ['cache-control', ' ']] as const) {
      const other = await rogueInstall(relay, () => ({ status: 200, headers: [['content-type', 'text/plain'], [bad[0], bad[1]]] }));
      // An off-allowlist name is dropped, not refused; an allowlisted bad value is refused.
      const status = (await fetch(`${relay.url}/go/${mintCredential('handoff', other.identity.installId)}`)).status;
      expect(status, JSON.stringify(bad)).toBe(bad[0] === 'x-a b' ? 200 : 502);
    }
    expect(logLines.join('\n')).not.toContain('a\\r\\nb');
  });
});

describe('5: unauthenticated sockets cannot hold session capacity', () => {
  test('PoC: stalled sockets from many addresses do not keep a real install from connecting', async () => {
    const relay = await makeRelay({ maxSessions: 4, maxPendingSockets: 4, authTimeoutMs: 10_000 }, new MemoryInstallRegistry(), { trustProxy: true });
    const held: WebSocket[] = [];
    const closedCodes: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/v2/connect`, { headers: { 'x-forwarded-for': `2001:db8:${i}::1` } } as unknown as string[]);
      socket.addEventListener('close', (event) => closedCodes.push(event.code));
      held.push(socket);
      cleanups.push(() => socket.close());
    }
    await until(() => held.every((socket) => socket.readyState === WebSocket.OPEN));
    const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ ok: true }) });
    cleanups.push(() => worker.stop(true));
    const install = await connectClient(relay, `http://127.0.0.1:${worker.port}`);
    await until(() => install.statuses.at(-1)?.state === 'online');
    // The oldest stalled socket made room.
    await until(() => closedCodes.length >= 1);
    expect(closedCodes[0]).toBe(4000);
    expect(relay.status().online).toBe(1);
  });

  test('connect attempts are limited per IPv6 /48, not per /64', async () => {
    const relay = await makeRelay({ sessionAttemptsPerIp: { capacity: 2, refillPerSecond: 0 } }, new MemoryInstallRegistry(), { trustProxy: true });
    expect(await rawSession(relay, '2001:db8:7:1::1', () => ({ type: 'hello' }))).toBe('unsupported_version');
    expect(await rawSession(relay, '2001:db8:7:2::1', () => ({ type: 'hello' }))).toBe('unsupported_version');
    expect(await rawSession(relay, '2001:db8:7:3::1')).toBe('error');
    expect(await rawSession(relay, '2001:db8:8:1::1', () => ({ type: 'hello' }))).toBe('unsupported_version');
    expect(prefixKey(addressKey('2001:db8:7:3::1'))).toBe('2001:db8:7::/48');
    expect(prefixKey(addressKey('203.0.113.4'))).toBe('203.0.113.4');
  });
});

describe('6: registrations cost work, are budgeted separately for returning installs, and expire unconfirmed', () => {
  test('a register without a sufficient proof of work is refused before any budget is spent', async () => {
    const relay = await makeRelay({ registrationsPerIp: { capacity: 1, refillPerSecond: 0 } }, new MemoryInstallRegistry(), { trustProxy: true });
    const identity = loadOrCreateIdentity(tempDir());
    const unproven = (challenge: { nonce: string }) => ({
      type: 'register',
      v: PROTOCOL_VERSION,
      installId: identity.installId,
      publicKey: identity.publicKeySpki,
      sig: signInstallMessage(identity.privateKey, 'register', challenge.nonce, identity.installId, PUBLIC_HOST),
      pow: '0',
    });
    expect(await rawSession(relay, '203.0.113.30', unproven)).toBe('bad_request');
    // The address's one registration is still there for a proven register.
    const proven = (challenge: { nonce: string; pow: number }) =>
      installAuthMessage({ kind: 'register', identity, nonce: challenge.nonce, powBits: challenge.pow, relayHost: PUBLIC_HOST });
    expect(await rawSession(relay, '203.0.113.30', proven)).toBe('ready');
    expect(logLines.join('\n')).toContain('"reason":"pow"');
  });

  test('the proof of work is bound to the nonce, install and relay host, and a hostile difficulty is refused', async () => {
    const pow = await solveRegistrationPow(12, 'nonce', 'a'.repeat(32), PUBLIC_HOST);
    expect(verifyRegistrationPow(12, 'nonce', 'a'.repeat(32), PUBLIC_HOST, pow)).toBe(true);
    expect(verifyRegistrationPow(12, 'other', 'a'.repeat(32), PUBLIC_HOST, pow)).toBe(false);
    expect(verifyRegistrationPow(12, 'nonce', 'a'.repeat(32), 'other.example', pow)).toBe(false);
    expect(verifyRegistrationPow(12, 'nonce', 'a'.repeat(32), PUBLIC_HOST, '1e3')).toBe(false);
    await expect(solveRegistrationPow(40, 'nonce', 'a'.repeat(32), PUBLIC_HOST)).rejects.toThrow();
  });

  test('new registrations are limited per /48; returning installs have their own budget; exhaustion is logged once', async () => {
    let clock = Date.now();
    const registry = new MemoryInstallRegistry(100_000, () => clock);
    const relay = await makeRelay(
      {
        registrationsPerIp: { capacity: 1, refillPerSecond: 0 },
        registrationsGlobal: { capacity: 2, refillPerSecond: 0 },
        sessionAttemptsPerIp: { capacity: 1000, refillPerSecond: 0 },
      },
      registry,
      { trustProxy: true, now: () => clock },
    );
    logLines.length = 0;
    const register = (identity: InstallIdentity) => (challenge: { nonce: string; pow: number }) =>
      installAuthMessage({ kind: 'register', identity, nonce: challenge.nonce, powBits: challenge.pow, relayHost: PUBLIC_HOST });
    const returning = loadOrCreateIdentity(tempDir());
    expect(await rawSession(relay, '2001:db8:9:1::1', register(returning))).toBe('ready');
    // Same /48, another /64: the address's budget is spent.
    expect(await rawSession(relay, '2001:db8:9:2::1', register(loadOrCreateIdentity(tempDir())))).toBe('rate_limited');
    expect(await rawSession(relay, '198.51.100.40', register(loadOrCreateIdentity(tempDir())))).toBe('ready');
    // The relay-wide new-registration budget is now spent: logged once for the operator.
    expect(await rawSession(relay, '198.51.100.41', register(loadOrCreateIdentity(tempDir())))).toBe('rate_limited');
    expect(await rawSession(relay, '198.51.100.42', register(loadOrCreateIdentity(tempDir())))).toBe('rate_limited');
    expect(logLines.filter((line) => line.includes('"event":"budget_exhausted"') && line.includes('"budget":"registrations"'))).toHaveLength(1);
    // The first install goes away for over 90 days and expires; it comes back on the returning budget.
    for (const cleanup of cleanups.splice(1).reverse()) await cleanup();
    await until(() => relay.status().online === 0);
    clock += 91 * 24 * 60 * 60_000;
    expect(relay.sweep()).toContain(returning.installId);
    expect(await rawSession(relay, '2001:db8:9:1::1', register(returning))).toBe('ready');
    expect(logLines.some((line) => line.includes('"event":"register"') && line.includes('"returning":true'))).toBe(true);
  });

  test('R-2: a registration never confirmed by a hello expires after a day; a confirmed or online one stays', () => {
    let clock = 1_000_000;
    const registry = new MemoryInstallRegistry(100_000, () => clock);
    const [once, hello, online] = [0, 1, 2].map(() => loadOrCreateIdentity(tempDir()));
    for (const identity of [once!, hello!, online!]) registry.register(identity.installId, identity.publicKeySpki);
    registry.confirm(hello!.installId);
    clock += 25 * 60 * 60_000;
    const day = 24 * 60 * 60_000;
    const expired = registry.expire(clock, 90 * day, (id) => id === online!.installId, day);
    expect(expired).toEqual([once!.installId]);
    expect(registry.get(online!.installId)!.confirmed).toBe(true);
    expect(registry.wasRemoved(once!.installId)).toBe(true);
  });

  test('R-2: the file registry keeps confirmation and remembered removals across restarts; older entries load confirmed', () => {
    const path = join(tempDir(), 'registry.jsonl');
    const legacy = loadOrCreateIdentity(tempDir());
    writeFileSync(path, `${JSON.stringify({ op: 'register', installId: legacy.installId, publicKey: legacy.publicKeySpki, at: 1 })}\n`);
    let clock = 10;
    const first = new FileInstallRegistry(path, 100_000, () => clock);
    expect(first.get(legacy.installId)!.confirmed).toBe(true);
    const fresh = loadOrCreateIdentity(tempDir());
    const gone = loadOrCreateIdentity(tempDir());
    first.register(fresh.installId, fresh.publicKeySpki);
    first.register(gone.installId, gone.publicKeySpki);
    clock += 2 * 24 * 60 * 60_000;
    first.confirm(fresh.installId);
    expect(first.expire(clock, Number.POSITIVE_INFINITY, () => false, 24 * 60 * 60_000)).toEqual([gone.installId]);
    return first.flush().then(() => {
      const second = new FileInstallRegistry(path, 100_000, () => clock);
      expect(second.get(fresh.installId)!.confirmed).toBe(true);
      expect(second.wasRemoved(gone.installId)).toBe(true);
      // Compaction preserved all of it.
      const third = new FileInstallRegistry(path, 100_000, () => clock);
      expect(third.get(legacy.installId)!.confirmed).toBe(true);
      expect(third.wasRemoved(gone.installId)).toBe(true);
      expect(third.get(gone.installId)).toBeUndefined();
    });
  });
});

describe('R-4: session signatures are bound to the relay host', () => {
  test('a client configured for another relay host is refused, and a hello signed for another host fails', async () => {
    const relay = await makeRelay();
    const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ ok: true }) });
    cleanups.push(() => worker.stop(true));
    const good = await connectClient(relay, `http://127.0.0.1:${worker.port}`);
    await until(() => good.statuses.at(-1)?.state === 'online');
    const misdirected = await connectClient(relay, `http://127.0.0.1:${worker.port}`, loadOrCreateIdentity(tempDir()), 'other-relay.example');
    await until(() => misdirected.statuses.some((status) => status.state === 'offline' && status.reason.includes('proof of work')));
    // A registered install's hello signed for another host.
    const replayed = await rawSession(relay, '127.0.0.1', (challenge) => ({
      type: 'hello',
      v: PROTOCOL_VERSION,
      installId: good.identity.installId,
      sig: signInstallMessage(good.identity.privateKey, 'hello', challenge.nonce, good.identity.installId, 'other-relay.example'),
    }));
    expect(replayed).toBe('bad_signature');
    const correct = await rawSession(relay, '127.0.0.1', (challenge) =>
      installAuthMessage({ kind: 'hello', identity: good.identity, nonce: challenge.nonce, powBits: challenge.pow, relayHost: PUBLIC_HOST.toUpperCase() }));
    expect(correct).toBe('ready');
  });
});

describe('L1: response bytes are budgeted per address and relay-wide, every lane', () => {
  test('an install that marks itself authenticated is cut off at the address\'s egress budget', async () => {
    const relay = await makeRelay(
      { egressBytesPerIp: { capacity: 10 * 1024, refillPerSecond: 0 } },
      new MemoryInstallRegistry(),
      { trustProxy: true },
    );
    const rogue = await rogueInstall(relay, () => ({
      status: 200,
      headers: [['content-type', 'text/plain'], [AUTHENTICATED_RESPONSE_HEADER, '1']],
      body: 'x'.repeat(8 * 1024),
    }));
    const token = mintCredential('access', rogue.identity.installId);
    const get = (xff: string) => fetch(`${relay.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': xff }, body: '{}' });
    expect((await (await get('203.0.113.50')).text()).length).toBe(8 * 1024);
    // Owner lane now (the install confirmed the token), and still cut off.
    expect((await (await get('203.0.113.50')).text()).length).toBe(0);
    expect((await (await get('198.51.100.50')).text()).length).toBe(8 * 1024);
    expect(logLines.join('\n')).toContain('"reason":"egress_budget"');
    await until(() => relay.status().inFlight === 0);
  });

  test('the relay-wide egress budget cuts every address and is logged once', async () => {
    logLines.length = 0;
    const relay = await makeRelay(
      { egressBytesGlobal: { capacity: 10 * 1024, refillPerSecond: 0 } },
      new MemoryInstallRegistry(),
      { trustProxy: true },
    );
    const rogue = await rogueInstall(relay, () => ({ status: 200, headers: [['content-type', 'text/plain']], body: 'x'.repeat(8 * 1024) }));
    const token = mintCredential('access', rogue.identity.installId);
    const get = (xff: string) => fetch(`${relay.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': xff }, body: '{}' });
    expect((await (await get('203.0.113.60')).text()).length).toBe(8 * 1024);
    expect((await (await get('198.51.100.60')).text()).length).toBe(0);
    expect((await (await get('198.51.100.61')).text()).length).toBe(0);
    expect(logLines.filter((line) => line.includes('"budget":"egress"'))).toHaveLength(1);
  });
});
