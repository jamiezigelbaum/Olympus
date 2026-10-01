/**
 * End to end over loopback: a real relay, real install clients and fake
 * loopback workers. Public callers reach the relay over plain HTTP here; in
 * production Caddy terminates TLS in front of the same server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient, type RelayClientStatus } from '../client/relay-client.ts';
import { DEMO_AUTHORIZE_PATH, FORWARDED_PATHS } from '../client/forward.ts';
import { loadOrCreateIdentity, type InstallIdentity } from '../client/identity.ts';
import { PROTOCOL_VERSION, base64url, installIdForPublicKey, signInstallMessage, spkiOf } from '../shared/protocol.ts';
import { AUTHENTICATED_RESPONSE_HEADER, mintCredential } from '../shared/tokens.ts';
import { createOAuthRelayNonce, signOAuthRelayState } from '../../src/core/oauth-relay.ts';
import type { RelayLimits } from '../server/limits.ts';
import { FileInstallRegistry, MemoryInstallRegistry } from '../server/registry.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';
import generatedDashboard from '../server/generated/chatgpt-dashboard.json';
import generatedSurface from '../server/generated/chatgpt-tools.json';
import generatedPrivateAnswer from '../server/generated/chatgpt-private-answer.json';

setDefaultTimeout(15_000);

const PUBLIC_HOST = 'mcp.olympus.test';

interface WorkerRecord {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface FakeWorker {
  url: string;
  requests: WorkerRecord[];
  aborted: string[];
  stop(): void;
}

const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-v2-'));
  dirs.push(dir);
  return dir;
}

/** A loopback Olympus worker stand-in that records what reached it. */
function fakeWorker(name: string, options: { bigBodyBytes?: number; validToken?: string } = {}): FakeWorker {
  const requests: WorkerRecord[] = [];
  const aborted: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      requests.push({ method: request.method, path: `${url.pathname}${url.search}`, headers, body });
      if (url.pathname === '/mcp') {
        // An engine: a 401 for a credential it does not hold, else it marks the response authenticated.
        if (options.validToken !== undefined && headers.authorization !== `Bearer ${options.validToken}`) {
          return Response.json({ error: 'invalid_token' }, { status: 401 });
        }
        const response = await engineFor(request, url, body);
        const marked = new Headers(response.headers);
        marked.set(AUTHENTICATED_RESPONSE_HEADER, '1');
        return new Response(response.body, { status: response.status, headers: marked });
      }
      return engineFor(request, url, body);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, aborted, stop: () => server.stop(true) };

  async function engineFor(request: Request, url: URL, body: string): Promise<Response> {
    if (url.pathname === '/mcp' && request.method === 'GET') {
      // Server-Sent Events: three events, 150 ms apart.
      let n = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (n > 0) await Bun.sleep(150);
          n += 1;
          controller.enqueue(new TextEncoder().encode(`data: event-${n}\n\n`));
          if (n === 3) controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'leak=1' } });
    }
    if (url.pathname === '/mcp' && body.includes('"slow"')) {
      // Holds the request open until the caller goes away.
      await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
      aborted.push(body);
      return new Response('too late');
    }
    if (url.pathname === '/mcp' && body.includes('"big"')) {
      return new Response('x'.repeat(options.bigBodyBytes ?? 1024), { headers: { 'content-type': 'text/plain' } });
    }
    return Response.json({ worker: name, path: url.pathname, body }, { headers: { 'mcp-session-id': `session-${name}` } });
  }
}

const logLines: string[] = [];

async function makeRelay(
  limits: Partial<RelayLimits> = {},
  registry = new MemoryInstallRegistry(),
  extra: { demoInstallId?: string } = {},
): Promise<RelayHandle> {
  const relay = await startRelay({
    publicHost: PUBLIC_HOST,
    registry,
    listen: { host: '127.0.0.1', port: 0 },
    limits,
    ...extra,
    log: (event, fields) => logLines.push(JSON.stringify({ event, ...fields })),
  });
  cleanups.push(() => relay.close());
  return relay;
}

async function connectInstall(
  relay: RelayHandle,
  worker: FakeWorker,
  identity = loadOrCreateIdentity(tempDir()),
  forwardedPaths?: readonly string[],
) {
  const statuses: RelayClientStatus[] = [];
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const client = new RelayClient({
    relayHost: PUBLIC_HOST,
    relayUrl: `ws://127.0.0.1:${relay.port}/v2/connect`,
    identity,
    target: worker.url,
    relaySecret: secret,
    heartbeatMs: 500,
    backoff: { minMs: 50, maxMs: 200 },
    onStatus: (status) => statuses.push(status),
    ...(forwardedPaths ? { forwardedPaths } : {}),
  });
  client.start();
  cleanups.push(() => client.stop());
  await until(() => statuses.at(-1)?.state === 'online');
  return { client, identity, secret, statuses };
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(10);
  }
}

const rpc = (method: string, params: Record<string, unknown> = {}, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

function mcpPost(relay: RelayHandle, token: string, body: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${relay.url}/mcp`, {
    method: 'POST',
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    body,
  });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('logging', () => {
  test('relay logs carry no token, install id, query string or address', async () => {
    logLines.length = 0;
    const relay = await makeRelay({ requestsPerInstall: { capacity: 1, refillPerSecond: 0.001 } });
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    const token = mintCredential('access', a.identity.installId);
    await mcpPost(relay, token, rpc('ping'));
    await mcpPost(relay, token, rpc('ping'));
    await fetch(`${relay.url}/connect/authorize?client_id=secret-query`);
    await relay.revoke(a.identity.installId);
    expect(logLines.length).toBeGreaterThan(2);
    const all = logLines.join('\n');
    expect(all).not.toContain(a.identity.installId);
    expect(all).not.toContain('oly2');
    expect(all).not.toContain('secret-query');
    expect(all).not.toContain('127.0.0.1');
  });
});

describe('routing', () => {
  test('a bearer token reaches only the install it names, with the relay marker and no forwarding headers', async () => {
    const relay = await makeRelay();
    const workerA = fakeWorker('A');
    const workerB = fakeWorker('B');
    cleanups.push(workerA.stop, workerB.stop);
    const a = await connectInstall(relay, workerA);
    const b = await connectInstall(relay, workerB);

    const response = await mcpPost(relay, mintCredential('access', a.identity.installId), rpc('tools/list'), {
      headers: { 'x-olympus-relay': 'forged', 'x-forwarded-for': '203.0.113.9', forwarded: 'for=203.0.113.9', cookie: 'c=1' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ worker: 'A', path: '/mcp' });
    expect(response.headers.get('mcp-session-id')).toBe('session-A');
    expect(workerB.requests).toHaveLength(0);
    const seen = workerA.requests[0]!;
    expect(seen.headers['x-olympus-relay']).toBe(a.secret);
    expect(seen.headers['x-forwarded-for']).toBeUndefined();
    expect(seen.headers.forwarded).toBeUndefined();
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers.authorization).toStartWith('Bearer oly2.');

    const toB = await mcpPost(relay, mintCredential('access', b.identity.installId), rpc('tools/list'));
    expect(await toB.json()).toMatchObject({ worker: 'B' });
    expect(workerA.requests).toHaveLength(1);
    expect(workerB.requests[0]!.headers['x-olympus-relay']).toBe(b.secret);
  });

  test('token requests route by the code or refresh token prefix; revocation by the token', async () => {
    const relay = await makeRelay();
    const workerA = fakeWorker('A');
    const workerB = fakeWorker('B');
    cleanups.push(workerA.stop, workerB.stop);
    const a = await connectInstall(relay, workerA);
    const b = await connectInstall(relay, workerB);
    const form = (fields: Record<string, string>) =>
      fetch(`${relay.url}/connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });

    const code = await form({ grant_type: 'authorization_code', code: mintCredential('code', a.identity.installId) });
    expect(await code.json()).toMatchObject({ worker: 'A', path: '/connect/token' });
    const refresh = await form({ grant_type: 'refresh_token', refresh_token: mintCredential('refresh', b.identity.installId) });
    expect(await refresh.json()).toMatchObject({ worker: 'B', path: '/connect/token' });
    // A code shaped like a refresh token, or under the wrong grant, routes nowhere.
    const mismatched = await form({ grant_type: 'authorization_code', code: mintCredential('refresh', a.identity.installId) });
    expect(mismatched.status).toBe(400);
    expect(await mismatched.json()).toMatchObject({ error: 'invalid_grant' });

    const revoke = await fetch(`${relay.url}/connect/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: mintCredential('refresh', b.identity.installId) }).toString(),
    });
    expect(await revoke.json()).toMatchObject({ worker: 'B', path: '/connect/revoke' });
    const unknownRevoke = await fetch(`${relay.url}/connect/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=whatever',
    });
    expect(unknownRevoke.status).toBe(200);
    expect(workerA.requests.map((r) => r.path)).toEqual(['/connect/token']);
    expect(workerB.requests.map((r) => r.path)).toEqual(['/connect/token', '/connect/revoke']);
  });

  test('an unroutable or unknown credential gets 401 with the resource metadata pointer', async () => {
    const relay = await makeRelay();
    const stranger = loadOrCreateIdentity(tempDir());
    const unknown = await mcpPost(relay, mintCredential('access', stranger.installId), rpc('initialize'));
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get('www-authenticate')).toBe(
      `Bearer realm="olympus", resource_metadata="https://${PUBLIC_HOST}/.well-known/oauth-protected-resource/mcp", `
        + 'error="invalid_token", error_description="The connection token is not valid or has been revoked."',
    );
    const garbage = await mcpPost(relay, 'olympus_at_notroutable', rpc('initialize'));
    expect(garbage.status).toBe(401);
    expect(garbage.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect((await fetch(`${relay.url}/dashboard`)).status).toBe(404);
  });

  test('a caller with no token gets the relay\'s not-installed surface and never reaches an engine', async () => {
    const relay = await makeRelay();
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    await connectInstall(relay, worker);
    const anonymous = (body: string) => fetch(`${relay.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const init = await (await anonymous(rpc('initialize', { protocolVersion: '2025-11-25' }))).json();
    expect(init.result.protocolVersion).toBe('2025-11-25');
    const list = await (await anonymous(rpc('tools/list'))).json();
    // The engine's full ChatGPT tool set, so ChatGPT's model can pick an
    // answer tool and so start linking.
    expect(list.result.tools).toEqual(generatedSurface.tools);
    expect(list.result.tools.map((tool: { name: string }) => tool.name))
      .toEqual([
        'olympus_dashboard',
        'olympus_search',
        'source_index_status',
        'source_answer',
        'source_answer_result',
        'olympus_connect_source',
        'olympus_scope_list',
        'olympus_scope_set',
        'olympus_disconnect_source',
        'olympus_model_set',
        'olympus_model_retry',
        'olympus_privacy_get',
        'olympus_privacy_set',
      ]);
    for (const tool of list.result.tools) {
      expect(tool.securitySchemes).toEqual(tool.name === 'olympus_dashboard'
        ? [{ type: 'noauth' }, { type: 'oauth2', scopes: [] }]
        : [{ type: 'oauth2', scopes: [] }]);
    }
    const resources = await (await anonymous(rpc('resources/list'))).json();
    // The engine advertises content-versioned URIs (`<base>?v=<hash>`).
    expect(resources.result.resources).toEqual(generatedSurface.resources);
    expect(resources.result.resources).toEqual([
      { uri: expect.stringMatching(/^ui:\/\/olympus\/dashboard\?v=[0-9a-f]{12}$/), name: 'Olympus dashboard', mimeType: 'text/html;profile=mcp-app' },
      { uri: expect.stringMatching(/^ui:\/\/olympus\/private-answer\?v=[0-9a-f]{12}$/), name: 'Olympus private answer', mimeType: 'text/html;profile=mcp-app' },
    ]);
    const panel = await (await anonymous(rpc('resources/read', { uri: 'ui://olympus/private-answer' }))).json();
    expect(panel.result.contents).toEqual(generatedPrivateAnswer.contents);
    const resource = await (await anonymous(rpc('resources/read', { uri: 'ui://olympus/dashboard' }))).json();
    // The dashboard lane's real bundle, not a placeholder.
    expect(resource.result.contents).toEqual(generatedDashboard.contents);
    expect(resource.result.contents[0].mimeType).toBe('text/html;profile=mcp-app');
    expect(resource.result.contents[0].text).toContain('not_installed');
    // Every advertised (versioned) URI reads the same bundle; an unknown one does not.
    for (const advertised of generatedSurface.resources as { uri: string }[]) {
      const read = await (await anonymous(rpc('resources/read', { uri: advertised.uri }))).json();
      expect(read.result.contents.length).toBe(1);
    }
    const unknown = await (await anonymous(rpc('resources/read', { uri: 'ui://olympus/dashboard?v=zzz' }))).json();
    expect(unknown.error.code).toBe(-32002);
    const dashboard = await (await anonymous(rpc('tools/call', { name: 'olympus_dashboard', arguments: {} }))).json();
    expect(dashboard.result.structuredContent).toMatchObject({
      v: 1,
      connection: { state: 'not_installed', action: { id: 'install', href: 'https://olympusplugin.ai/install/' } },
      needsYou: [],
      sources: [],
    });
    expect(dashboard.result._meta).toEqual(generatedSurface.tools[0]!._meta);
    expect(dashboard.result.isError).toBeUndefined();
    // Every oauth2 tool, called without a token: the documented linking
    // trigger (isError + _meta["mcp/www_authenticate"]) on an HTTP 200.
    for (const name of ['source_answer', 'source_answer_result', 'source_index_status']) {
      const call = await anonymous(rpc('tools/call', { name, arguments: { question: 'x', job_id: 'j' } }));
      expect(call.status).toBe(200);
      const engineTool = await call.json();
      expect(engineTool.result.isError).toBe(true);
      expect(engineTool.result._meta['mcp/www_authenticate']).toEqual([
        `Bearer resource_metadata="https://${PUBLIC_HOST}/.well-known/oauth-protected-resource/mcp", error="invalid_token", `
          + 'error_description="Connect Olympus on your Mac to use this tool."',
      ]);
    }
    expect((await fetch(`${relay.url}/mcp`)).status).toBe(405);
    expect(worker.requests).toHaveLength(0);
  });

  test('the domain verification token is served when configured, else 404', async () => {
    let token: string | undefined;
    const relay = await startRelay({
      publicHost: PUBLIC_HOST,
      registry: new MemoryInstallRegistry(),
      listen: { host: '127.0.0.1', port: 0 },
      appsChallenge: () => token,
    });
    cleanups.push(() => relay.close());
    const path = `${relay.url}/.well-known/openai-apps-challenge`;
    expect((await fetch(path)).status).toBe(404);
    token = '  abc123-challenge\n';
    const served = await fetch(path);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('abc123-challenge');
    expect((await fetch(`${(await makeRelay()).url}/.well-known/openai-apps-challenge`)).status).toBe(404);
  });

  test('static OAuth documents, health and the authorize bridge are served by the relay itself', async () => {
    const relay = await makeRelay();
    const prm = await (await fetch(`${relay.url}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toEqual({
      resource: `https://${PUBLIC_HOST}/mcp`,
      authorization_servers: [`https://${PUBLIC_HOST}`],
      bearer_methods_supported: ['header'],
      resource_name: 'Olympus',
    });
    const as = (await (await fetch(`${relay.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(`https://${PUBLIC_HOST}`);
    expect(as.token_endpoint).toBe(`https://${PUBLIC_HOST}/connect/token`);
    expect(as.registration_endpoint).toBeUndefined();
    expect((await fetch(`${relay.url}/healthz`)).status).toBe(200);

    const query = '?response_type=code&client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fclient.json&state=a"<b';
    const bridge = await fetch(`${relay.url}/connect/authorize${query}`);
    expect(bridge.status).toBe(200);
    const html = await bridge.text();
    expect(html).toContain('href="http://127.0.0.1:8010/connect/authorize?response_type=code&amp;client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fclient.json&amp;state=a%22%3Cb"');
    expect(html).toContain('Install Olympus');
    expect(bridge.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('demo sign-in', () => {
  test('without a demo install the bridge offers none and the path is 404', async () => {
    const relay = await makeRelay();
    expect(await (await fetch(`${relay.url}/connect/authorize?state=s`)).text()).not.toContain('demo');
    expect((await fetch(`${relay.url}/connect/demo/authorize?state=s`)).status).toBe(404);
  });

  test('routes only to the configured demo install, and only a demo install forwards it', async () => {
    const demoWorker = fakeWorker('demo');
    const realWorker = fakeWorker('real');
    cleanups.push(demoWorker.stop, realWorker.stop);
    const demoIdentity = loadOrCreateIdentity(tempDir());
    const relay = await makeRelay({}, new MemoryInstallRegistry(), { demoInstallId: demoIdentity.installId });
    await connectInstall(relay, demoWorker, demoIdentity, [...FORWARDED_PATHS, DEMO_AUTHORIZE_PATH]);
    const real = await connectInstall(relay, realWorker);

    const bridge = await (await fetch(`${relay.url}/connect/authorize?state=s`)).text();
    expect(bridge).toContain('href="/connect/demo/authorize?state=s"');
    const page = await fetch(`${relay.url}/connect/demo/authorize?state=s`, { headers: { authorization: `Bearer ${mintCredential('access', real.identity.installId)}` } });
    expect(await page.json()).toMatchObject({ worker: 'demo', path: '/connect/demo/authorize' });
    expect(demoWorker.requests.at(-1)!.path).toBe('/connect/demo/authorize?state=s');
    expect(demoWorker.requests.at(-1)!.headers['x-olympus-relay']).toBeDefined();
    const posted = await fetch(`${relay.url}/connect/demo/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://${PUBLIC_HOST}` },
      body: 'request_id=x&csrf=y',
    });
    expect(posted.status).toBe(200);
    expect(demoWorker.requests.at(-1)!.headers.origin).toBe(`https://${PUBLIC_HOST}`);
    expect(realWorker.requests).toHaveLength(0);
  });

  test('a relay pointed at a non-demo install still cannot reach its demo path', async () => {
    const worker = fakeWorker('real');
    cleanups.push(worker.stop);
    const identity = loadOrCreateIdentity(tempDir());
    const relay = await makeRelay({}, new MemoryInstallRegistry(), { demoInstallId: identity.installId });
    await connectInstall(relay, worker, identity);
    const response = await fetch(`${relay.url}/connect/demo/authorize?state=s`);
    expect(response.status).toBe(404);
    expect(worker.requests).toHaveLength(0);
  });
});

describe('streaming and cancellation', () => {
  test('a Server-Sent Events response streams through before it ends, with cookies dropped', async () => {
    const relay = await makeRelay();
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    const response = await fetch(`${relay.url}/mcp`, {
      headers: { authorization: `Bearer ${mintCredential('access', a.identity.installId)}`, accept: 'text/event-stream' },
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('set-cookie')).toBeNull();
    const reader = response.body!.getReader();
    const started = Date.now();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('event-1');
    // The first event arrives before the later ones are even produced.
    expect(Date.now() - started).toBeLessThan(140);
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('event-3');
  });

  test('a caller that goes away cancels the loopback request', async () => {
    const relay = await makeRelay();
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    const controller = new AbortController();
    const pending = mcpPost(relay, mintCredential('access', a.identity.installId), rpc('tools/call', { name: 'slow' }), { signal: controller.signal });
    await until(() => worker.requests.length === 1);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await until(() => worker.aborted.length === 1);
    await until(() => a.client.activeRequests === 0);
    expect(relay.status().inFlight).toBe(0);
  });
});

describe('offline fallback', () => {
  test('an authorized request for a registered install with no session gets the relay\'s own MCP answers', async () => {
    const relay = await makeRelay();
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    await a.client.stop();
    await until(() => relay.onlineInstalls().length === 0);
    const token = mintCredential('access', a.identity.installId);

    const init = await (await mcpPost(relay, token, rpc('initialize', { protocolVersion: '2025-06-18' }))).json();
    expect(init.result.protocolVersion).toBe('2025-06-18');
    const list = await (await mcpPost(relay, token, rpc('tools/list'))).json();
    expect(list.result.tools).toEqual(generatedSurface.tools);
    const resource = await (await mcpPost(relay, token, rpc('resources/read', { uri: 'ui://olympus/dashboard' }))).json();
    expect(resource.result.contents).toEqual(generatedDashboard.contents);
    const dashboard = await (await mcpPost(relay, token, rpc('tools/call', { name: 'olympus_dashboard', arguments: {} }))).json();
    expect(dashboard.result.structuredContent).toMatchObject({
      v: 1,
      connection: { state: 'mac_offline', action: { id: 'wake_mac', href: 'https://olympusplugin.ai/help/mac-offline/' } },
      needsYou: [],
      sources: [],
      models: { embedding: { kind: 'built_in', state: 'downloading' } },
    });
    expect(typeof dashboard.result.structuredContent.connection.lastSeenAt).toBe('string');
    expect(dashboard.result._meta).toEqual(generatedSurface.tools[0]!._meta);
    const other = await (await mcpPost(relay, token, rpc('tools/call', { name: 'source_answer', arguments: {} }))).json();
    expect(other.error.message).toContain('Your Mac is offline');
    const notification = await mcpPost(relay, token, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(notification.status).toBe(202);
    expect(worker.requests).toHaveLength(0);
  });
});

describe('private answer collection', () => {
  const PANEL = 'https://olympus.web-sandbox.oaiusercontent.com';
  const collect = (relay: RelayHandle, jobId: string, init: { origin?: string; body?: string; method?: string } = {}) =>
    fetch(`${relay.url}/private/${jobId}`, {
      method: init.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(init.origin !== undefined ? { origin: init.origin } : { origin: PANEL }) },
      ...(init.method === 'OPTIONS' || init.method === 'GET' ? {} : { body: init.body ?? JSON.stringify({ v: 1, publicKey: 'k' }) }),
    });

  test('routes a job id to the install it names, with CORS for ChatGPT widget origins only', async () => {
    logLines.length = 0;
    const relay = await makeRelay();
    const workerA = fakeWorker('A');
    const workerB = fakeWorker('B');
    cleanups.push(workerA.stop, workerB.stop);
    const a = await connectInstall(relay, workerA);
    await connectInstall(relay, workerB);
    const jobId = mintCredential('private', a.identity.installId);

    const preflight = await fetch(`${relay.url}/private/${jobId}`, {
      method: 'OPTIONS',
      headers: { origin: PANEL, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(PANEL);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type');
    const badPreflight = await fetch(`${relay.url}/private/${jobId}`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(badPreflight.status).toBe(403);
    expect(badPreflight.headers.get('access-control-allow-origin')).toBeNull();

    const response = await collect(relay, jobId);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(PANEL);
    expect(response.headers.get('vary')).toBe('Origin');
    expect(await response.json()).toMatchObject({ worker: 'A', path: `/private/${jobId}` });
    expect(workerA.requests[0]!.headers['x-olympus-relay']).toBe(a.secret);
    expect(workerA.requests[0]!.headers.origin).toBe(PANEL);
    expect(workerB.requests).toHaveLength(0);
    // The relay's own origin is the panel's dedicated domain.
    expect((await collect(relay, jobId, { origin: `https://${PUBLIC_HOST}` })).status).toBe(200);

    for (const origin of ['https://evil.example', 'null', '', 'https://x.y.web-sandbox.oaiusercontent.com']) {
      const refused = await collect(relay, jobId, { origin });
      expect(refused.status, origin).toBe(403);
      expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await collect(relay, jobId, { method: 'GET' })).status).toBe(405);
    expect(workerA.requests).toHaveLength(2);

    // Wrong shapes and unknown installs never reach any engine.
    expect((await collect(relay, 'nope')).status).toBe(404);
    expect((await collect(relay, mintCredential('access', a.identity.installId))).status).toBe(404);
    expect((await fetch(`${relay.url}/private/${jobId}?x=1`, { method: 'POST', headers: { origin: PANEL } })).status).toBe(404);
    const unknown = await collect(relay, mintCredential('private', 'c'.repeat(32)));
    expect(unknown.status).toBe(410);
    expect(await unknown.json()).toEqual({ status: 'gone' });
    expect(unknown.headers.get('access-control-allow-origin')).toBe(PANEL);
    expect((await collect(relay, jobId, { body: 'x'.repeat(600) })).status).toBe(413);
    expect(workerA.requests).toHaveLength(2);
    expect(workerB.requests).toHaveLength(0);

    const logs = logLines.join('\n');
    expect(logs).not.toContain(jobId.split('.')[2]!);
    expect(logs).not.toContain(a.identity.installId);
  });

  test('an offline Mac answers mac_offline, with CORS, so the panel can say so', async () => {
    const relay = await makeRelay();
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    await a.client.stop();
    await until(() => relay.onlineInstalls().length === 0);
    const response = await collect(relay, mintCredential('private', a.identity.installId));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'mac_offline' });
    expect(response.headers.get('access-control-allow-origin')).toBe(PANEL);
    expect(worker.requests).toHaveLength(0);
  });

  test('collections are rate limited per address', async () => {
    const relay = await makeRelay({ privateFetchesPerIp: { capacity: 2, refillPerSecond: 0.001 } });
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    const jobId = mintCredential('private', a.identity.installId);
    expect((await collect(relay, jobId)).status).toBe(200);
    expect((await collect(relay, jobId)).status).toBe(200);
    const limited = await collect(relay, jobId);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ status: 'rate_limited' });
    expect(limited.headers.get('access-control-allow-origin')).toBe(PANEL);
    expect(worker.requests).toHaveLength(2);
  });
});

describe('limits', () => {
  test('request bodies over the cap are refused before they reach the install', async () => {
    const relay = await makeRelay({ maxRequestBodyBytes: 1024 });
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    const response = await mcpPost(relay, mintCredential('access', a.identity.installId), JSON.stringify({ pad: 'x'.repeat(4096) }));
    expect(response.status).toBe(413);
    expect(worker.requests).toHaveLength(0);
  });

  test('responses over the cap are cut off', async () => {
    const relay = await makeRelay({ maxResponseBodyBytes: 100 * 1024 });
    const worker = fakeWorker('A', { bigBodyBytes: 512 * 1024 });
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    const response = await mcpPost(relay, mintCredential('access', a.identity.installId), rpc('tools/call', { name: 'big' }));
    expect(response.status).toBe(200);
    // Cut off at the cap (plus at most one chunk in flight), never delivered whole.
    const text = await response.text().catch(() => '');
    expect(text.length).toBeLessThan(100 * 1024 + 64 * 1024);
  });

  test('concurrency is capped per install, with the last slot reserved for the dashboard tool', async () => {
    const relay = await makeRelay({ concurrentPerInstall: 2 });
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    const token = mintCredential('access', a.identity.installId);
    // The engine confirms the credential once; from then on it takes the owner lane.
    expect((await mcpPost(relay, token, rpc('ping'))).status).toBe(200);
    const controller = new AbortController();
    const slow = mcpPost(relay, token, rpc('tools/call', { name: 'slow' }), { signal: controller.signal }).catch(() => undefined);
    await until(() => worker.requests.length === 2);
    const busy = await mcpPost(relay, token, rpc('tools/list'));
    expect(busy.status).toBe(503);
    const dashboard = await mcpPost(relay, token, rpc('tools/call', { name: 'olympus_dashboard', arguments: {} }));
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toMatchObject({ worker: 'A' });
    controller.abort();
    await slow;
  });

  test('requests per install are rate limited', async () => {
    const relay = await makeRelay({ requestsPerInstall: { capacity: 2, refillPerSecond: 0.001 } });
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    const token = mintCredential('access', a.identity.installId);
    // The first request confirms the credential (unverified lane, paid by the address).
    expect((await mcpPost(relay, token, rpc('ping'))).status).toBe(200);
    expect((await mcpPost(relay, token, rpc('ping'))).status).toBe(200);
    expect((await mcpPost(relay, token, rpc('ping'))).status).toBe(200);
    expect((await mcpPost(relay, token, rpc('ping'))).status).toBe(429);
  });

  test('registrations and sessions are capped per address', async () => {
    const relay = await makeRelay({ registrationsPerIp: { capacity: 1, refillPerSecond: 0.0001 } });
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    await connectInstall(relay, worker);
    const statuses: RelayClientStatus[] = [];
    const second = new RelayClient({
      relayHost: PUBLIC_HOST,
      relayUrl: `ws://127.0.0.1:${relay.port}/v2/connect`,
      identity: loadOrCreateIdentity(tempDir()),
      target: worker.url,
      relaySecret: 'x'.repeat(43),
      backoff: { minMs: 5_000, maxMs: 5_000 },
      onStatus: (status) => statuses.push(status),
    });
    second.start();
    cleanups.push(() => second.stop());
    await until(() => statuses.some((status) => status.state === 'offline' && status.reason.includes('too many registrations')));
  });
});

describe('sessions and revocation', () => {
  test('a forged hello is refused and names no session', async () => {
    const relay = await makeRelay();
    const victim = loadOrCreateIdentity(tempDir());
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    await connectInstall(relay, worker, victim);
    const impostorKey = generateKeyPairSync('ed25519').privateKey;
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/v2/connect`);
    const messages: string[] = [];
    const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      messages.push(message.type === 'error' ? message.code : message.type);
      if (message.type === 'challenge') {
        socket.send(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, installId: victim.installId, sig: signInstallMessage(impostorKey, 'hello', message.nonce, victim.installId) }));
      }
    });
    await closed;
    expect(messages).toEqual(['challenge', 'bad_signature']);
    expect(relay.onlineInstalls()).toEqual([victim.installId]);
  });

  test('a register for an id not derived from its key is refused', async () => {
    const relay = await makeRelay();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const other = installIdForPublicKey(spkiOf(generateKeyPairSync('ed25519').publicKey));
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/v2/connect`);
    const messages: string[] = [];
    const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      messages.push(message.type === 'error' ? message.code : message.type);
      if (message.type === 'challenge') {
        socket.send(JSON.stringify({
          type: 'register',
          v: PROTOCOL_VERSION,
          installId: other,
          publicKey: base64url(spkiOf(publicKey)),
          sig: signInstallMessage(privateKey, 'register', message.nonce, other),
        }));
      }
    });
    await closed;
    expect(messages).toEqual(['challenge', 'id_mismatch']);
  });

  test('revocation is durable before it is reported, ends the session, and refuses the install', async () => {
    const dir = tempDir();
    const registryPath = join(dir, 'registry.jsonl');
    const relay = await makeRelay({}, new FileInstallRegistry(registryPath));
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    const result = await relay.revoke(a.identity.installId);
    expect(result).toEqual({ installId: a.identity.installId, revoked: true, wasRegistered: true, wasOnline: true });
    expect(readFileSync(registryPath, 'utf8')).toContain(`"op":"revoke","installId":"${a.identity.installId}"`);
    await until(() => a.statuses.some((status) => status.state === 'offline' && status.reason.includes('revoked')));
    const refused = await mcpPost(relay, mintCredential('access', a.identity.installId), rpc('tools/list'));
    expect(refused.status).toBe(401);
    expect(worker.requests).toHaveLength(0);
    // A restart replays the log: the id stays refused.
    const replayed = new FileInstallRegistry(registryPath);
    expect(replayed.isRevoked(a.identity.installId)).toBe(true);
    expect(await relay.restore(a.identity.installId)).toBe(true);
  });

  test('a second session for the same install replaces the first', async () => {
    const relay = await makeRelay();
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const identity: InstallIdentity = loadOrCreateIdentity(tempDir());
    const first = await connectInstall(relay, worker, identity);
    await connectInstall(relay, worker, identity);
    await until(() => first.statuses.some((status) => status.state === 'replaced'));
    expect(relay.onlineInstalls()).toEqual([identity.installId]);
  });
});

describe('setup hand-offs', () => {
  test('a one-time /go link reaches only the install it names, GET only', async () => {
    const relay = await makeRelay();
    const workerA = fakeWorker('A');
    const workerB = fakeWorker('B');
    cleanups.push(workerA.stop, workerB.stop);
    const a = await connectInstall(relay, workerA);
    await connectInstall(relay, workerB);
    const link = `/go/${mintCredential('handoff', a.identity.installId)}`;
    const response = await fetch(`${relay.url}${link}`, { redirect: 'manual' });
    expect(await response.json()).toMatchObject({ worker: 'A', path: link });
    expect(workerB.requests).toHaveLength(0);
    expect(workerA.requests[0]!.headers['x-olympus-relay']).toBe(a.secret);
    expect((await fetch(`${relay.url}${link}`, { method: 'POST' })).status).toBe(405);
  });

  test('an unknown install, a malformed id or an offline Mac gets a plain page, never another engine', async () => {
    const registry = new MemoryInstallRegistry();
    const relay = await makeRelay({}, registry);
    const worker = fakeWorker('A');
    cleanups.push(worker.stop);
    const a = await connectInstall(relay, worker);
    const stranger = loadOrCreateIdentity(tempDir());
    const unknown = await fetch(`${relay.url}/go/${mintCredential('handoff', stranger.installId)}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('expired or was already used');
    expect((await fetch(`${relay.url}/go/${mintCredential('access', a.identity.installId)}`)).status).toBe(404);
    expect((await fetch(`${relay.url}/go/not-an-id`)).status).toBe(404);
    expect(worker.requests).toHaveLength(0);
    // Registered but no live session: the Mac is offline.
    const offline = loadOrCreateIdentity(tempDir());
    registry.register(offline.installId, offline.publicKeySpki);
    const page = await fetch(`${relay.url}/go/${mintCredential('handoff', offline.installId)}`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('offline');
  });

  test('a publisher sign-in callback routes by the install prefix of its state nonce, query intact', async () => {
    const relay = await makeRelay();
    const workerA = fakeWorker('A');
    const workerB = fakeWorker('B');
    cleanups.push(workerA.stop, workerB.stop);
    await connectInstall(relay, workerA);
    const b = await connectInstall(relay, workerB);
    const state = signOAuthRelayState({
      origin: `https://${PUBLIC_HOST}`,
      source: 'gmail',
      nonce: `${b.identity.installId}_${createOAuthRelayNonce()}`,
      iat: Math.floor(Date.now() / 1000),
    }, 'k'.repeat(43));
    const query = new URLSearchParams({ code: 'provider-code', state }).toString();
    const response = await fetch(`${relay.url}/oauth/callback/gmail?${query}`);
    expect(await response.json()).toMatchObject({ worker: 'B', path: '/oauth/callback/gmail' });
    expect(workerB.requests[0]!.path).toBe(`/oauth/callback/gmail?${query}`);
    expect(workerA.requests).toHaveLength(0);
    // A state without an install prefix, or none at all, routes nowhere.
    const plain = signOAuthRelayState({ origin: 'http://127.0.0.1:8010', source: 'gmail', nonce: createOAuthRelayNonce(), iat: 1 }, 'k'.repeat(43));
    expect((await fetch(`${relay.url}/oauth/callback/gmail?code=c&state=${plain}`)).status).toBe(404);
    expect((await fetch(`${relay.url}/oauth/callback/gmail?code=c`)).status).toBe(404);
    expect((await fetch(`${relay.url}/oauth/callback/x?code=c&state=${state}`)).status).toBe(404);
    expect(workerA.requests).toHaveLength(0);
    expect(workerB.requests).toHaveLength(1);
  });
});
