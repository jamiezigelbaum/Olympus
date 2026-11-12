import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateIdentity, type InstallIdentity } from '../client/identity.ts';
import { RelayClient } from '../client/relay-client.ts';
import { startRelay, type RelayHandle } from '../server/relay.ts';
import { MemoryInstallRegistry } from '../server/registry.ts';
import { OfflineRequestLog } from '../server/request-log.ts';
import { installTag } from '../server/log.ts';
import { installAuthMessage } from '../shared/protocol.ts';
import { mintCredential, AUTHENTICATED_RESPONSE_HEADER } from '../shared/tokens.ts';
import { parseRequestLogEntry, type RequestLogEntry } from '../shared/request-log.ts';
import { createTestClock, waitFor } from '../../test/helpers/test-clock.ts';

const HOST = 'mcp.olympus.test';
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function identity(): InstallIdentity {
  const dir = mkdtempSync(join(tmpdir(), 'request-log-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return loadOrCreateIdentity(dir);
}
const entry = (status = 200): RequestLogEntry => ({ at: '2026-11-12T12:00:00.000Z', surface: 'default', calls: 'tools/list', status, ms: 1 });
async function relay(): Promise<RelayHandle> {
  const r = await startRelay({ publicHost: HOST, registry: new MemoryInstallRegistry(), listen: { host: '127.0.0.1', port: 0 }, limits: { registrationPowBits: 0 }, log: () => {} });
  cleanup.push(() => r.close());
  return r;
}
async function connect(r: RelayHandle, id: InstallIdentity, logs: RequestLogEntry[]) {
  let online = false;
  const client = new RelayClient({ identity: id, relayHost: HOST, relayUrl: `ws://127.0.0.1:${r.port}/v2/connect`, target: 'http://127.0.0.1:1', relaySecret: 'test-secret',
    backoff: { minMs: 1, maxMs: 2 }, onRequestLog: e => logs.push(e), onStatus: s => { online = s.state === 'online'; },
    fetch: (async () => Response.json({ ok: true }, { headers: { [AUTHENTICATED_RESPONSE_HEADER]: '1' } })) as unknown as typeof fetch,
  });
  cleanup.push(() => client.stop());
  client.start();
  await waitFor(() => online);
  return client;
}
async function request(r: RelayHandle, token: string, method = 'tools/list', surface = '/mcp') {
  const response = await fetch(`${r.url}${surface}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'source_answer', arguments: { question: 'secret-body' } } }) });
  await response.text();
}

test('two installs receive only their own online events and offline rings, immediately after ready', async () => {
  const r = await relay();
  const a = identity(), b = identity();
  const at = mintCredential('access', a.installId), bt = mintCredential('access', b.installId);
  const al: RequestLogEntry[] = [], bl: RequestLogEntry[] = [];
  const ac = await connect(r, a, al), bc = await connect(r, b, bl);
  await request(r, at);
  await request(r, bt, 'initialize', '/openai/mcp');
  await waitFor(() => al.length === 1 && bl.length === 1);
  expect(al[0]).toMatchObject({ install: installTag(a.installId), calls: 'tools/list', surface: 'default' });
  expect(bl[0]).toMatchObject({ install: installTag(b.installId), calls: 'initialize', surface: 'directory' });
  await ac.stop(); await bc.stop();
  await waitFor(() => r.onlineInstalls().length === 0);
  await request(r, at, 'tools/list');
  await request(r, bt, 'ping');
  const ac2 = await connect(r, a, al);
  await waitFor(() => al.length === 2);
  expect(bl).toHaveLength(1);
  const bc2 = await connect(r, b, bl);
  await waitFor(() => bl.length === 2);
  for (const e of al) expect(e.install).toBe(installTag(a.installId));
  for (const e of bl) expect(e.install).toBe(installTag(b.installId));
  // Draining is destructive; reconnect never repeats a delivered ring.
  await ac2.stop();
  await waitFor(() => !r.onlineInstalls().includes(a.installId));
  await connect(r, a, al);
  await request(r, at, 'alice@example.com');
  await waitFor(() => al.length === 3);
  expect(al.at(-1)?.calls).toBe('?');
  for (const forbidden of [a.installId, b.installId, at, bt, 'secret-body', 'alice@example.com', '127.0.0.1']) expect(JSON.stringify([...al, ...bl])).not.toContain(forbidden);
  expect(Object.keys(al[0]!).sort()).toEqual(['at', 'calls', 'credential', 'install', 'lane', 'ms', 'status', 'surface']);
  await bc2.stop();
});

test('old clients receive no new frames, including offline history', async () => {
  const r = await relay(), id = identity();
  const logs: RequestLogEntry[] = [];
  const initial = await connect(r, id, logs);
  await initial.stop(); await waitFor(() => r.onlineInstalls().length === 0);
  const token = mintCredential('access', id.installId);
  await request(r, token);
  const frames: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${r.port}/v2/connect`);
  cleanup.push(() => socket.close());
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    const msg = JSON.parse(String(event.data)); frames.push(msg);
    if (msg.type === 'challenge') void installAuthMessage({ kind: 'hello', identity: id, nonce: msg.nonce, powBits: 0, relayHost: HOST }).then(auth => socket.send(JSON.stringify(auth)));
    if (msg.type === 'request') {
      socket.send(JSON.stringify({ type: 'response-head', id: msg.id, status: 200, headers: [] }));
      socket.send(JSON.stringify({ type: 'end', id: msg.id }));
    }
  });
  await waitFor(() => frames.some(f => f.type === 'ready'));
  await request(r, token);
  socket.send(JSON.stringify({ type: 'ping' }));
  await waitFor(() => frames.some(f => f.type === 'pong'));
  expect(frames.some(f => f.type === 'request-log')).toBe(false);
});

test('old relays without ready.features invoke no callback and get no new control frame', async () => {
  const id = identity(), logs: RequestLogEntry[] = [], received: string[] = [];
  let forwarded = false;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, s) { if (s.upgrade(req)) return; return new Response('no'); }, websocket: {
    open(ws) { ws.send(JSON.stringify({ type: 'challenge', nonce: 'old-relay', v: 2, pow: 0 })); },
    message(ws, raw) {
      if (typeof raw !== 'string') return;
      const msg = JSON.parse(raw); received.push(msg.type);
      if (msg.type === 'hello') {
        ws.send(JSON.stringify({ type: 'ready', installId: id.installId }));
        ws.send(JSON.stringify({ type: 'request-log', ...entry() }));
        ws.send(JSON.stringify({ type: 'request', id: 1, method: 'GET', path: '/mcp', headers: [] }));
        ws.send(JSON.stringify({ type: 'end', id: 1 }));
      }
    },
  } });
  cleanup.push(() => server.stop(true));
  const client = new RelayClient({ identity: id, relayHost: HOST, relayUrl: `ws://127.0.0.1:${server.port}`, target: 'http://127.0.0.1:1', relaySecret: 'test', onRequestLog: e => logs.push(e), fetch: (async () => { forwarded = true; return new Response('okay'); }) as unknown as typeof fetch });
  cleanup.push(() => client.stop()); client.start();
  await waitFor(() => forwarded && received.includes('response-head'));
  expect(logs).toEqual([]);
  expect(received.every(type => ['hello', 'response-head', 'end'].includes(type))).toBe(true);
});

test('offline rings cap each install at 100 and the relay at 20,000, oldest first; expire at 24 hours', async () => {
  const clock = createTestClock();
  const ring = new OfflineRequestLog(clock.now);
  for (let n = 0; n < 105; n++) ring.push('a', entry(200 + n));
  expect(ring.size).toBe(100);
  expect(ring.take('b')).toEqual([]);
  expect(ring.take('a')[0]!.status).toBe(205);
  for (let n = 0; n < 20_001; n++) ring.push(`install-${n}`, entry());
  expect(ring.size).toBe(20_000);
  expect(ring.take('install-0')).toEqual([]);
  expect(ring.take('install-1')).toHaveLength(1);
  await clock.advance(24 * 3600_000 - 1);
  expect(ring.take('install-2')).toHaveLength(1);
  await clock.advance(1);
  ring.sweep(); expect(ring.size).toBe(0);
});

test('wire parser discards extraneous fields and rejects unbounded or client-written methods', () => {
  expect(parseRequestLogEntry({ ...entry(), token: 'secret', address: 'private', body: 'secret' })).toEqual(entry());
  for (const bad of [{ calls: 'question text' }, { calls: 'tools/call:private-text' }, { calls: Array(9).fill('ping').join(',') }, { credential: 'token' }, { at: 'bad' }, { ms: -1 }]) expect(parseRequestLogEntry({ ...entry(), ...bad })).toBeUndefined();
});
