import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRemoteConnectionStore } from '../src/core/remote-connections.ts';
import { authenticateRemoteRequest } from '../src/workers/remote-mcp.ts';
import { createFrontGate } from '../src/workers/engine-split/runtime.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'private-agent-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = openRemoteConnectionStore(join(root, 'connections.sqlite'));
  cleanup.push(() => store.close());
  return store;
}
const request = (token: string) => new Request('http://127.0.0.1/mcp', { headers: { Authorization: `Bearer ${token}` } });

test('a key is accepted only on its route, survives reopening, and revocation kills it', () => {
  const store = storeFixture();
  for (const route of ['loopback', 'tailnet'] as const) {
    const key = store.create('Second account', { route });
    expect(store.verifyToken(key.token).ok).toBe(false);
    expect(store.verifyToken(key.token, route).ok).toBe(true);
    expect(store.verifyToken(key.token, route === 'loopback' ? 'tailnet' : 'loopback').ok).toBe(false);
    const reopened = openRemoteConnectionStore(store.dbPath);
    expect(reopened.list().find(r => r.id === key.connection.id)?.route).toBe(route);
    reopened.close();
    expect(authenticateRemoteRequest(request(key.token), { connections: () => store }).ok).toBe(false);
    store.revoke(key.connection.id);
    expect(store.verifyToken(key.token, route).ok).toBe(false);
  }
  const ordinary = store.create('Own tunnel');
  expect(store.verifyToken(ordinary.token).ok).toBe(true);
  expect(store.verifyToken(ordinary.token, 'loopback').ok).toBe(false);
});

import { createPrivateAgentListeners, isPrivateAgentBindAddress, isTailscaleInterfaceName } from '../src/workers/private-agent-listeners.ts';
import { createInProcessOperationContext } from '../src/workers/remote-mcp.ts';
import { defaultConfig } from '../src/core/config.ts';

const mcp = {
  makeOperationContext: (caller: Parameters<typeof createInProcessOperationContext>[0]['caller'], signal: AbortSignal) => createInProcessOperationContext({
    config: defaultConfig(), sourceIndexReadEnabled: true, caller, signal,
    workerFetch: async () => Response.json({}),
  }),
};

test('bind validation admits only exact loopback or Tailscale IP ranges', () => {
  for (const address of ['0.0.0.0', '::', 'localhost', '192.168.1.2', '8.8.8.8', '100.63.255.255', '100.128.0.0', 'fd7a:115c:a1e1::1', '::ffff:100.64.0.1']) {
    expect(isPrivateAgentBindAddress('tailnet', address)).toBe(false);
    expect(isPrivateAgentBindAddress('loopback', address)).toBe(false);
  }
  for (const address of ['100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1']) expect(isPrivateAgentBindAddress('tailnet', address)).toBe(true);
  expect(isPrivateAgentBindAddress('loopback', '127.0.0.1')).toBe(true);
  expect(isPrivateAgentBindAddress('tailnet', '127.0.0.1')).toBe(false);
});

test('real loopback listener is off by default, serves only remote MCP with route keys, and stops after last revoke', async () => {
  const store = storeFixture();
  const manager = createPrivateAgentListeners({ connections: () => store, mcp, privacyPending: () => false, addresses: () => [], port: 0 });
  cleanup.push(() => manager.close());
  manager.refresh();
  expect(manager.view().loopback.listening).toBe(false);
  const key = store.create('OpenClaw', { route: 'loopback' });
  const second = store.create('Hermes', { route: 'loopback' });
  manager.refresh();
  const url = manager.view().loopback.urls[0]!;
  expect(new URL(url).hostname).toBe('127.0.0.1');
  const post = async (token?: string, path = '/mcp') => fetch(new URL(path, url), { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect((await post()).status).toBe(401);
  expect((await post(store.create('Tailnet', { route: 'tailnet' }).token)).status).toBe(401);
  expect((await post(store.create('Public').token)).status).toBe(401);
  expect((await post('worker-secret')).status).toBe(401);
  const response = await post(key.token);
  expect(response.status).toBe(200);
  const tools = (await response.json() as any).result.tools.map((t: any) => t.name);
  expect(tools).toContain('source_answer');
  expect(tools).not.toContain('olympus_dashboard');
  for (const path of ['/dashboard', '/dashboard/agents/keys', '/connect/authorize', '/dashboard/control/session', '/v1/health', '/openai/mcp', '/api/v1/tools/source_answer', '/openapi.json']) {
    expect((await post(key.token, path)).status).toBe(404);
  }
  store.revoke(key.connection.id);
  manager.refresh();
  expect(manager.view().loopback.listening).toBe(true);
  expect((await post(key.token)).status).toBe(401);
  store.revoke(second.connection.id);
  manager.refresh();
  expect(manager.view().loopback.listening).toBe(false);
  await expect(fetch(url)).rejects.toThrow();
});

test('tailnet absence, address changes and disappearing interfaces fail closed without broader binds', async () => {
  const store = storeFixture();
  let addresses: string[] = [];
  const binds: string[] = [];
  const stopped: string[] = [];
  const handlers = new Map<string, (r: Request) => Promise<Response>>();
  const manager = createPrivateAgentListeners({ connections: () => store, mcp, privacyPending: () => false,
    addresses: () => addresses,
    listen: (address, handler) => { binds.push(address); handlers.set(address, handler); return { port: 17841, stop: () => { stopped.push(address); } }; },
  });
  cleanup.push(() => manager.close());
  expect(manager.view().tailnet.state).toBe('absent');
  expect(manager.view().tailnet.message).toBe("Tailscale isn't running on this computer");
  const key = store.create('Tailnet agent', { route: 'tailnet' });
  addresses = ['192.168.1.2', '0.0.0.0', '::', '100.64.0.2', 'fd7a:115c:a1e0::2'];
  manager.refresh();
  expect(binds).toEqual(['100.64.0.2', 'fd7a:115c:a1e0::2']);
  const handler = handlers.get('100.64.0.2')!;
  expect((await handler(request(key.token))).status).toBe(405);
  expect((await handler(request(store.create('Loopback', { route: 'loopback' }).token))).status).toBe(401);
  addresses = ['100.64.0.3']; manager.refresh();
  expect(stopped).toContain('100.64.0.2');
  expect(stopped).toContain('fd7a:115c:a1e0::2');
  expect(manager.view().tailnet.urls).toEqual(['http://100.64.0.3:17841/mcp']);
  addresses = [];
  // A request also rechecks the interfaces; it cannot use a stale listener.
  expect((await handlers.get('100.64.0.3')!(request(key.token))).status).toBe(503);
  expect(manager.view().tailnet.listening).toBe(false);
  expect(manager.view().loopback.listening).toBe(true);
  store.revoke(key.connection.id); manager.refresh();
  addresses = ['100.64.0.4']; manager.refresh();
  expect(binds).not.toContain('100.64.0.4');
});

import { dashboardAgentsView, handleDashboardAgentRequest } from '../src/workers/agent-connections.ts';
import { renderDashboardAgentsSection } from '../src/workers/dashboard/agents.ts';

test('dashboard creates private keys with no relay or OAuth and shows routes and unavailable Tailscale', async () => {
  const store = storeFixture();
  const manager = createPrivateAgentListeners({ connections: () => store, mcp, privacyPending: () => false, addresses: () => [], port: 0 });
  cleanup.push(() => manager.close());
  const backend = { store: () => store, remoteAccess: () => ({ state: 'off' as const }), privateListeners: manager,
    relayInstallId: () => 'relay-install-id' };
  const post = (body: unknown, path = '/dashboard/agents/keys') => handleDashboardAgentRequest(new Request(`http://127.0.0.1${path}`, {
    method: 'POST', body: JSON.stringify(body),
  }), path, backend);
  const absent = await post({ name: 'Tailnet', route: 'tailnet', agent: 'other' });
  expect(absent?.status).toBe(409);
  expect(store.list()).toHaveLength(0);
  const minted = await post({ name: 'OpenClaw as ai', route: 'loopback', agent: 'other' });
  expect(minted?.status).toBe(200);
  expect(minted?.headers.get('Cache-Control')).toBe('no-store');
  const body = await minted!.json() as any;
  expect(body.token).toStartWith('olympus_conn_');
  expect(body.mcp_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  expect(body.connection.route).toBe('loopback');
  expect(manager.view().loopback.listening).toBe(true);
  for (const platform of ['darwin', 'linux'] as const) {
    const html = renderDashboardAgentsSection({ view: dashboardAgentsView(backend), now: new Date(), platform });
    expect(html).toContain('Agent on another account of this computer');
    expect(html).toContain('Agent on my tailnet');
    expect(html).toContain('Tailscale isn&#39;t running on this computer');
    expect(html).toContain('OpenClaw'); expect(html).toContain('Hermes'); expect(html).toContain('Other MCP client');
    expect(html).toContain('data-private-route="loopback"');
    expect(html).toContain('another account');
    expect(html).not.toContain(body.token);
    const tailnetSection = html.split('data-agent="private-tailnet"')[1]!.split('</details>')[0]!;
    expect(tailnetSection).not.toContain('Create key');
  }
  const revoked = await post({ connection_id: body.connection.id }, '/dashboard/agents/revoke');
  expect(revoked?.status).toBe(200);
  expect(manager.view().loopback.listening).toBe(false);
});

test('unsupported workers hide private choices and refuse private key creation', async () => {
  const store = storeFixture();
  const backend = { store: () => store, remoteAccess: () => ({ state: 'off' as const }) };
  const html = renderDashboardAgentsSection({ view: dashboardAgentsView(backend), now: new Date() });
  expect(html).not.toContain('data-private-route');
  const path = '/dashboard/agents/keys';
  const response = await handleDashboardAgentRequest(new Request(`http://127.0.0.1${path}`, { method: 'POST',
    body: JSON.stringify({ name: 'Hidden', route: 'loopback' }) }), path, backend);
  expect(response?.status).toBe(501);
  expect(store.list()).toHaveLength(0);
});

import { Database } from 'bun:sqlite';
import { assertSqliteSchemaCanOpen } from '../src/core/sqlite-migrations.ts';

test('schema 3 migrates existing keys to remote and refuses older readers after route binding', () => {
  const store = storeFixture();
  const key = store.create('Existing agent');
  const revoked = store.create('Already revoked'); store.revoke(revoked.connection.id);
  const old = new Database(store.dbPath);
  old.exec("ALTER TABLE remote_connections DROP COLUMN route; UPDATE schema_version SET version = 3 WHERE store_id = 'remote-connections';");
  old.close();
  const upgraded = openRemoteConnectionStore(store.dbPath);
  cleanup.push(() => upgraded.close());
  expect(upgraded.list().every(r => r.route === 'remote')).toBe(true);
  expect(upgraded.verifyToken(key.token).ok).toBe(true);
  expect(upgraded.verifyToken(key.token, 'loopback').ok).toBe(false);
  expect(upgraded.verifyToken(revoked.token).ok).toBe(false);
  const db = new Database(store.dbPath);
  try { expect(() => assertSqliteSchemaCanOpen(db, 'remote-connections', 3)).toThrow('only knows schema_version 3'); }
  finally { db.close(); }
});

test('store and interface failures stop private listeners, failed binds never retry a wider address', () => {
  const store = storeFixture();
  store.create('Tailnet', { route: 'tailnet' }); store.create('Second account', { route: 'loopback' });
  let failStore = false;
  let failInterfaces = false;
  let failBind = false;
  const attempted: string[] = [];
  const stopped: string[] = [];
  const manager = createPrivateAgentListeners({ connections: () => { if (failStore) throw new Error(); return store; }, mcp,
    privacyPending: () => false,
    addresses: () => { if (failInterfaces) throw new Error(); return ['100.64.0.1']; },
    listen: address => { attempted.push(address); if (failBind) throw new Error('Address unavailable'); return { port: 17841, stop: () => { stopped.push(address); } }; },
  });
  cleanup.push(() => manager.close());
  expect(manager.view().tailnet.listening).toBe(true);
  failInterfaces = true; manager.refresh();
  expect(stopped).toContain('100.64.0.1');
  expect(manager.view().tailnet.state).toBe('unavailable');
  expect(manager.view().loopback.listening).toBe(true);
  failStore = true; manager.refresh();
  expect(stopped).toContain('127.0.0.1');
  expect(manager.view().loopback.listening).toBe(false);
  failInterfaces = false; failStore = false; failBind = true; manager.refresh();
  expect(manager.view().tailnet.state).toBe('unavailable');
  expect(attempted.every(a => a === '100.64.0.1' || a === '127.0.0.1')).toBe(true);
});

test('private connections authenticate before the first-run privacy gate and cannot enable OAuth or the ChatGPT surface', async () => {
  const store = storeFixture(); const key = store.create('Second account', { route: 'loopback' });
  // The production shared object carries publicUrls too. Private listeners
  // must select only the remote MCP fields, even when extra fields are passed.
  const shared = { ...mcp, publicUrls: () => { throw new Error('Public resource must never be read'); },
    chatgpt: { servesRequest: () => { throw new Error('ChatGPT surface must never be selected'); } } };
  const manager = createPrivateAgentListeners({ connections: () => store, mcp: shared, privacyPending: () => true, port: 0, addresses: () => [] });
  cleanup.push(() => manager.close());
  const url = manager.view().loopback.urls[0]!;
  const post = (token?: string, method = 'tools/list') => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'source_answer', arguments: { question: 'What did I save?' } } }),
  });
  const refused = await post();
  expect(refused.status).toBe(401);
  expect(refused.headers.get('WWW-Authenticate')).not.toContain('resource_metadata');
  expect((await post(key.token)).status).toBe(200);
  const blocked = await post(key.token, 'tools/call');
  expect(await blocked.text()).toContain('privacy_choice_required');
});

test('a failed dashboard bind revokes the unshown key and leaves no private listener', async () => {
  const store = storeFixture();
  const manager = createPrivateAgentListeners({ connections: () => store, mcp, privacyPending: () => false,
    addresses: () => ['100.64.0.8'], listen: () => { throw new Error('Busy port'); } });
  cleanup.push(() => manager.close());
  const path = '/dashboard/agents/keys';
  const response = await handleDashboardAgentRequest(new Request(`http://127.0.0.1${path}`, {
    method: 'POST', body: JSON.stringify({ name: 'No address', route: 'tailnet' }),
  }), path, { store: () => store, remoteAccess: () => ({ state: 'off' }), privateListeners: manager });
  expect(response?.status).toBe(503);
  expect(await response!.text()).not.toContain('olympus_conn_');
  expect(store.list()).toHaveLength(1);
  expect(store.list()[0]!.revokedAt).not.toBeNull();
  expect(manager.view().tailnet.listening).toBe(false);
});

test('only Tailscale interfaces are considered, never a carrier-grade NAT address on an ordinary interface', () => {
  expect(isTailscaleInterfaceName('tailscale0', 'linux')).toBe(true);
  expect(isTailscaleInterfaceName('eth0', 'linux')).toBe(false);
  expect(isTailscaleInterfaceName('utun4', 'darwin')).toBe(true);
  expect(isTailscaleInterfaceName('en0', 'darwin')).toBe(false);
});

test('in the engine split, the private listeners pass the front\'s read gate a source-data delete closes', async () => {
  const store = storeFixture();
  const key = store.create('Loopback agent', { route: 'loopback' });
  const handlers = new Map<string, (r: Request) => Promise<Response>>();
  const gate = createFrontGate();
  const manager = createPrivateAgentListeners({ connections: () => store, mcp, privacyPending: () => false, addresses: () => [],
    listen: (address, handler) => { handlers.set(address, handler); return { port: 17841, stop: () => {} }; },
    gate: (handler) => gate.wrap(handler),
  });
  cleanup.push(() => manager.close());
  manager.refresh();
  const handler = handlers.get('127.0.0.1')!;
  expect((await handler(request(key.token))).status).not.toBe(503);
  gate.close();
  const closed = await handler(request(key.token));
  expect(closed.status).toBe(503);
  expect(await closed.json()).toMatchObject({ error: { code: 'worker_restarting' } });
});
