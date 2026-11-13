import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionRequestStore, connectionRequestsPath, connectionRequestsView, readConnectionRequests, requestCredentialTag, RELAY_REQUEST_LOG_PATH, type ConnectionRequest } from '../src/core/connection-requests.ts';
import { credentialLogTag } from '../connect-relay/server/log.ts';
import type { RequestLogEntry } from '../connect-relay/shared/request-log.ts';
import { openRemoteConnectionStore, resolveRemoteConnectionsDbPathForCli } from '../src/core/remote-connections.ts';
import { runConnectionsCommand } from '../src/cli.ts';
import { CLAUDE_CLIENT_ID, CHATGPT_CLIENT_ID } from '../src/workers/remote-oauth/pinned-clients.ts';
import { renderDashboardAgentsSection } from '../src/workers/dashboard/agents.ts';
import { dashboardAgentsView } from '../src/workers/agent-connections.ts';
import { createRelaySurfacesHandler, withRelaySurfacesRoute } from '../src/workers/relay-surfaces.ts';
import { createTestClock } from './helpers/test-clock.ts';
import { waitFor } from './helpers/test-clock.ts';
import { startRelayRuntime } from '../src/core/remote-relay-runtime.ts';
import { startRelay } from '../connect-relay/server/relay.ts';
import { MemoryInstallRegistry } from '../connect-relay/server/registry.ts';
import { mintCredential, AUTHENTICATED_RESPONSE_HEADER } from '../connect-relay/shared/tokens.ts';
import { createRemoteMcpHandler } from '../src/workers/remote-mcp.ts';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function dir() { const root = mkdtempSync(join(tmpdir(), 'connection-requests-')); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root; }
const NOW = new Date('2026-11-12T14:00:00.000Z');
const entry = (override: Partial<RequestLogEntry> = {}): RequestLogEntry => ({ at: NOW.toISOString(), surface: 'default', credential: '01234567', calls: 'tools/list', status: 200, ms: 2, ...override });
const row = (override: Partial<ConnectionRequest> = {}): ConnectionRequest => ({ ...entry(), app: 'Claude', source: 'relay', ...override });

test('engine rotates memory and the atomic owner-only JSON snapshot at 200, preserving newest timestamps on an offline flush', async () => {
  const root = dir(), path = connectionRequestsPath(join(root, 'connections.sqlite'));
  const store = new ConnectionRequestStore(path, () => 'Claude');
  const clock = createTestClock(NOW.getTime());
  for (let n = 0; n < 205; n++) {
    store.record(entry({ at: clock.date().toISOString(), ms: n }), 'relay');
    await clock.advance(1);
  }
  store.record(entry({ at: '2026-11-11T13:00:00.000Z' }), 'relay');
  await store.flush();
  expect(store.list()).toHaveLength(200);
  expect(store.list()[0]!.ms).toBe(5);
  expect(store.list().at(-1)!.ms).toBe(204);
  expect(readConnectionRequests(path)).toEqual(store.list());
  expect(new ConnectionRequestStore(path).list()).toEqual(store.list());
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(existsSync(`${path}.tmp`)).toBe(false);
  const copy = store.list(); copy[0]!.app = 'changed';
  expect(store.list()[0]!.app).toBe('Claude');
});

test('maps relay tags from OAuth access digests and bearer digests, never persists tokens or digests; unknown tags stay unknown', async () => {
  const root = dir(), db = openRemoteConnectionStore(join(root, 'connections.sqlite'));
  cleanup.push(() => db.close());
  const grant = (clientId: string, displayName: string) => db.oauth.createGrant({ clientId, displayName, resource: 'https://example.test/mcp' });
  const claude = grant(CLAUDE_CLIENT_ID, 'Claude');
  const chatgpt = grant(CHATGPT_CLIENT_ID, 'ChatGPT');
  const bearer = db.create('Grok');
  const store = new ConnectionRequestStore(join(root, 'requests.json'), tag => db.requestLogCredentials().find(r => requestCredentialTag(r.tokenHash) === tag)?.displayName);
  for (const token of [claude.tokens.accessToken, chatgpt.tokens.accessToken, bearer.token]) {
    const digest = createHash('sha256').update(token).digest();
    expect(requestCredentialTag(digest)).toBe(credentialLogTag(digest));
    store.record(entry({ credential: credentialLogTag(digest) }), 'relay');
  }
  store.record(entry({ credential: 'deadbeef' }), 'relay');
  store.record(entry(), 'engine', 'Claude', true);
  await store.flush();
  expect(store.list().map(r => r.app)).toEqual(['Claude', 'ChatGPT', 'Grok', 'an unknown connection', 'Claude']);
  expect(store.list().at(-1)).toMatchObject({ source: 'engine', relayed: true });
  const persisted = readFileSync(store.path, 'utf8');
  for (const secret of [claude.tokens.accessToken, claude.tokens.refreshToken, chatgpt.tokens.accessToken, bearer.token, createHash('sha256').update(bearer.token).digest('hex')]) expect(persisted).not.toContain(secret);
});

test('deterministic app readings, newest 20 rows, failures, and no double count of relay and engine observations', () => {
  const rows = [row(), row({ source: 'engine', relayed: true }), row({ at: '2026-11-12T13:10:00Z', status: 503 }), row({ app: 'ChatGPT', calls: 'initialize' }), row({ app: 'Grok', at: '2026-11-12T12:00:00Z' })];
  const view = connectionRequestsView(rows, ['Claude', 'ChatGPT', 'Grok'], NOW);
  expect(view.readings).toEqual([
    'Claude asked for the tool list 2 times in the last hour; 1 request failed.',
    "ChatGPT has not asked for Olympus's tool list in the last hour of recorded history.",
    "Grok has not asked for Olympus's tool list in the last hour of recorded history.",
  ]);
  expect(connectionRequestsView([row()], [], NOW).readings).toEqual(['Claude asked for the tool list 1 time in the last hour; all answered.']);
  expect(connectionRequestsView([row({ source: 'engine', relayed: true })], [], NOW).readings).toEqual(['Claude asked for the tool list 1 time in the last hour; all answered.']);
  expect(view.requests[0]).toMatchObject({ app: 'Claude', asked: 'Tool list', result: 'Answered (200) — relay' });
  expect(view.requests.at(-1)!.app).toBe('Grok');
  expect(connectionRequestsView(Array.from({ length: 30 }, (_, n) => row({ at: new Date(NOW.getTime() - n).toISOString() })), [], NOW).requests).toHaveLength(20);
});

test('dashboard uses the shared readings, existing cards, and escaped app names', () => {
  const requests = [row({ app: '<script>bad</script>' })];
  const view = dashboardAgentsView({ store: () => undefined, requests: () => requests, remoteAccess: () => ({ state: 'off' }) });
  const html = renderDashboardAgentsSection({ view, now: NOW });
  expect(html).toContain('Recent requests from your AI apps');
  expect(html).toContain('Tool list');
  expect(html).toContain('Answered (200) — relay');
  expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
  expect(html).not.toContain('<script>bad</script>');
  expect(html).toContain('attncard plain');
});

test('CLI requests reads the same persisted list without starting the engine; status reports its last observation', async () => {
  const root = dir();
  const env = { HOME: root, OLYMPUS_CONFIG: join(root, 'missing.json') };
  const dbPath = resolveRemoteConnectionsDbPathForCli(env);
  expect(runConnectionsCommand(['requests'], env)).toMatchObject({ kind: 'connection_requests', requests: [], summary: 'No requests recorded yet.' });
  expect(existsSync(dbPath)).toBe(false);
  const store = new ConnectionRequestStore(connectionRequestsPath(dbPath));
  store.record(entry(), 'relay', 'Claude'); await store.flush();
  const result = runConnectionsCommand(['requests'], env);
  expect(result.requests).toEqual(connectionRequestsView(store.list()).requests);
  expect(runConnectionsCommand(['status'], env).recent_requests).toBe('1 recent request observation; latest 2026-11-12T14:00:00.000Z (relay).');
  expect(() => runConnectionsCommand(['requests', 'extra'], env)).toThrow('Usage: olympus connections requests');
});

test('malformed snapshots are ignored and disk failure cannot break in-memory diagnostics', async () => {
  const root = dir(), path = join(root, 'history.json');
  writeFileSync(path, 'bad json'); expect(readConnectionRequests(path)).toEqual([]);
  writeFileSync(path, JSON.stringify([{ ...row(), calls: 'secret-question' }])); expect(readConnectionRequests(path)).toEqual([]);
  const store = new ConnectionRequestStore(join(path, 'unwritable'));
  store.record(entry(), 'engine', 'Claude'); await store.flush();
  expect(store.list()).toHaveLength(1);
});

test('child-to-engine ingestion accepts only the per-boot secret, bounded batches, and sanitized fields', async () => {
  const collected: RequestLogEntry[] = [];
  const handler = withRelaySurfacesRoute(createRelaySurfacesHandler({ connections: () => undefined, publicUrls: () => undefined, isRelayed: req => req.headers.get('x-olympus-relay') === 'secret', requestLog: e => collected.push(e) }), async () => new Response('rest', { status: 299 }));
  const post = (body: unknown, secret = 'secret') => handler(new Request(`http://127.0.0.1${RELAY_REQUEST_LOG_PATH}`, { method: 'POST', headers: { 'x-olympus-relay': secret }, body: JSON.stringify(body) }));
  expect((await post([entry()], 'wrong')).status).toBe(404);
  expect((await post(Array(101).fill(entry()))).status).toBe(400);
  expect((await post([{ ...entry(), calls: 'secret' }])).status).toBe(400);
  expect((await post([entry({ calls: '?'.repeat(129 * 1024) })])).status).toBe(400);
  expect(collected).toEqual([]);
  expect((await post([{ ...entry(), body: 'not retained', token: 'not retained' }])).status).toBe(200);
  expect(collected).toEqual([entry()]);
  expect((await handler(new Request('http://127.0.0.1/other'))).status).toBe(299);
});

test('relay runtime passes callbacks to the engine with its secret and retains a failed handoff for retry', async () => {
  const root = dir();
  const relay = await startRelay({ publicHost: 'mcp.olympus.test', registry: new MemoryInstallRegistry(), listen: { host: '127.0.0.1', port: 0 }, limits: { registrationPowBits: 0 }, log: () => {} });
  cleanup.push(() => relay.close());
  let attempts = 0, accept = false;
  const collected: RequestLogEntry[] = [], secrets: string[] = [];
  const runtime = await startRelayRuntime({
    env: { HOME: root, OLYMPUS_RELAY_HOST: 'mcp.olympus.test', OLYMPUS_RELAY_TARGET: 'http://127.0.0.1:8010' }, instanceId: 'request-history-test',
    relayUrl: `ws://127.0.0.1:${relay.port}/v2/connect`, backoff: { minMs: 1, maxMs: 2 },
    fetch: (async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === RELAY_REQUEST_LOG_PATH) {
        attempts++;
        if (!accept) return new Response('booting', { status: 503 });
        secrets.push(new Headers(init?.headers).get('x-olympus-relay')!);
        collected.push(...JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      }
      if (new URL(input).pathname === '/relay/surfaces') return Response.json({ v: 1, entries: [] });
      return Response.json({ ok: true }, { headers: { [AUTHENTICATED_RESPONSE_HEADER]: '1' } });
    }) as unknown as typeof fetch,
  });
  cleanup.push(() => runtime.stop());
  await waitFor(() => relay.onlineInstalls().includes(runtime.client.installId));
  const token = mintCredential('access', runtime.client.installId);
  const send = async (method: string) => {
    const response = await fetch(`${relay.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) });
    await response.text();
  };
  await send('tools/list');
  await waitFor(() => attempts === 1);
  accept = true;
  await send('ping');
  await waitFor(() => collected.length === 2);
  expect(collected.map(e => e.calls)).toEqual(['tools/list', 'ping']);
  expect(secrets.every(secret => /^[A-Za-z0-9_-]{43}$/.test(secret))).toBe(true);
});

test('a failed engine observer cannot change the MCP response', async () => {
  const handler = createRemoteMcpHandler({ connections: () => undefined, makeOperationContext: () => { throw new Error('must not run'); }, log: () => {}, onRequestLog: () => { throw new Error('diagnostic failed'); } });
  expect((await handler(new Request('http://127.0.0.1/mcp', { method: 'POST' }))).status).toBe(401);
});
