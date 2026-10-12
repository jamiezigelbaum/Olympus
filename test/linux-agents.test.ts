import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderDashboardAgentsPage } from '../src/workers/dashboard/pages/local.ts';
import { renderDashboardAgentsSection } from '../src/workers/dashboard/agents.ts';
import { renderLoopbackConsentPage } from '../src/workers/remote-oauth/consent-page.ts';
import { createRemoteOAuthHandler } from '../src/workers/remote-oauth/handler.ts';
import { openRemoteConnectionStore } from '../src/core/remote-connections.ts';
import { parseRemotePublicBaseUrl } from '../src/core/remote-public-url.ts';
import { registerPinnedClient } from '../connect-relay/server/client-registration.ts';
import type { DashboardRemoteAccess } from '../src/workers/agent-connections.ts';
import { resolveAgentApprovalHost } from '../src/core/remote-open.ts';
import { authenticateRemoteRequest } from '../src/workers/remote-mcp.ts';
import { credentialInstallId } from '../connect-relay/shared/tokens.ts';
import { DASHBOARD_AGENT_KEYS_PATH, handleDashboardAgentRequest } from '../src/workers/agent-connections.ts';
import { loadConfig } from '../src/core/config.ts';
import { resolveLinuxEngineLayout, publishLinuxEngineReceipt } from '../src/core/linux-engine-layout.ts';

test.skipIf(process.platform !== 'linux')('Linux CLI and local agents discover stored engine config through the shared receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-agent-config-'));
  try {
    const runtime = join(root, 'run'); mkdirSync(runtime, { mode: 0o700 });
    const env = { HOME: root, XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(root, 'data') };
    const layout = resolveLinuxEngineLayout(env);
    publishLinuxEngineReceipt(layout);
    mkdirSync(dirname(layout.unitPath), { recursive: true, mode: 0o700 });
    writeFileSync(layout.unitPath, '[Unit]\nDescription=fixture\n', { mode: 0o600 });
    writeFileSync(layout.configPath, JSON.stringify({ email: { baseUrl: 'http://127.0.0.1:8123/v1' }, sourceIndex: { enabled: false }, remote: { enabled: false } }), { mode: 0o600 });
    const loaded = loadConfig({ ...env, XDG_CONFIG_HOME: join(root, 'wrong-config'), XDG_DATA_HOME: join(root, 'wrong-data') });
    expect(loaded.email.baseUrl).toBe('http://127.0.0.1:8123/v1');
    expect(loaded.sourceIndex.enabled).toBe(false);
    expect(loaded.remote?.enabled).toBe(false);
    writeFileSync(layout.configPath, '{broken', { mode: 0o600 });
    expect(() => loadConfig(env)).toThrow('not valid JSON');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('production agent handoff resolves the owner socket on desktops and headless hosts', () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-approval-'));
  try {
    for (const desktopReady of [() => true, () => false]) {
      const host = resolveAgentApprovalHost({ platform: 'linux', port: 8010, desktopReady,
        env: { HOME: root, XDG_RUNTIME_DIR: root }, fileEnv: { OLYMPUS_SERVER_SSH_TARGET: 'owner-target' } });
      expect(host.approvalHandoff?.()).toBe(`ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8010:${root}/olympus/worker.sock owner-target`);
      expect(section(render(host), 'chatgpt')).toContain('Copy approval handoff');
    }
    expect(resolveAgentApprovalHost({ platform: 'linux', port: 8010, env: {}, desktopReady: () => false }).approvalHandoff?.()).toBeUndefined();
    expect(resolveAgentApprovalHost({ platform: 'darwin', port: 8010, env: {} })).toEqual({ platform: 'darwin' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const mac = JSON.parse(readFileSync(new URL('./fixtures/linux-agents/mac.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-12T00:00:00Z');
const access = mac.accesses[0] as DashboardRemoteAccess;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const render = (host: Record<string, unknown>, remoteAccess = access) => renderDashboardAgentsSection({view:{remoteAccess, connections:[]}, now, ...host});
const section = (html: string, id: string) => html.split(`data-agent="${id}"`)[1]?.split('</details>')[0] ?? '';

test('Mac connect output stays byte-for-byte equal to pre-change fixtures in every remote state', () => {
  for (let i = 0; i < mac.accesses.length; i++) expect(render({platform:'darwin'}, mac.accesses[i])).toBe(mac.agents[i]);
  const page = renderLoopbackConsentPage({platform:'darwin',requestId:'fixture-request',csrf:'fixture-csrf',clientName:'ChatGPT',verifiedHost:'chatgpt.com',redirectHost:'chatgpt.com',redirectOrigin:'https://chatgpt.com'});
  page.body = page.body.replace(/nonce="[^"]+"/g,'nonce="NONCE"');
  page.headers['Content-Security-Policy'] = page.headers['Content-Security-Policy']!.replace(/nonce-[^']+/g,'nonce-NONCE');
  expect(page).toEqual(mac.consent);
});

const clients = [
  ['chatgpt','ChatGPT','https://chatgpt.com/connector_platform_oauth_redirect'],
  ['claude','Claude','https://claude.ai/api/mcp/auth_callback'],
  ['grok','Grok','https://grok.com/connectors-oauth-exchange-code/'],
  ['grok-bot','Grok Bot','https://www.cursor.com/agents/mcp/oauth/callback'],
  ['cursor','Cursor','https://www.cursor.com/agents/mcp/oauth/callback'],
] as const;
for (const [id, name, redirect] of clients) {
  test(`Linux ${name}: relay registration, desktop/headless steps, consent and PKCE exchange`, async () => {
    const desktop = section(render({platform:'linux', headless:false}), id);
    expect(desktop).toContain('this computer');
    expect(desktop).toContain('browser');
    expect(desktop).not.toContain('Mac');
    expect(desktop).not.toContain('Get pairing code');
    const handoff = 'ssh -N -L 127.0.0.1:8010:/run/user/1000/olympus/worker.sock owner-target';
    const headless = section(render({platform:'linux', headless:true, approvalHandoff:() => handoff}), id);
    expect(headless).toContain(handoff);
    expect(headless).toContain('SSH socket forward');
    expect(headless).not.toContain('page opens only here');
    const unavailable = section(render({platform:'linux',headless:true,approvalHandoff:() => undefined}), id);
    expect(unavailable).toContain('not ready');
    expect(unavailable).not.toContain('ssh -N');

    const registered = registerPinnedClient(JSON.stringify({redirect_uris:[redirect]}), 1);
    expect(registered.ok).toBe(true);
    if (!registered.ok) throw new Error('registration refused');
    const dir = mkdtempSync(join(tmpdir(),'linux-agent-'));
    cleanup.push(() => rmSync(dir,{recursive:true,force:true}));
    const store = openRemoteConnectionStore(join(dir,'connections.sqlite'));
    cleanup.push(() => store.close());
    const parsed = parseRemotePublicBaseUrl('https://relay.example', 'a'.repeat(32));
    if (!parsed.enabled) throw new Error('fixture URLs refused');
    // Handler behavior only. OPENER owns the authenticated socket transport;
    // injected peer here deliberately does NOT claim second-UID isolation.
    const handler = createRemoteOAuthHandler({platform:'linux',publicUrls:parsed.urls,connections:() => store,peerAddress:() => '127.0.0.1'});
    const verifier = 'v'.repeat(50);
    const query = new URLSearchParams({response_type:'code',client_id:String(registered.body.client_id),redirect_uri:redirect,code_challenge:new Bun.CryptoHasher('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state:'fixture-state'});
    const response = await handler(new Request(`http://127.0.0.1:8010/connect/authorize?${query}`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Olympus on this computer');
    expect(html).not.toContain('this Mac');
    const body = new URLSearchParams({request_id:/name="request_id" value="([^"]+)"/.exec(html)![1]!,csrf:/name="csrf" value="([^"]+)"/.exec(html)![1]!,action:'approve'});
    const post = () => handler(new Request('http://127.0.0.1:8010/connect/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',cookie:response.headers.get('set-cookie')!.split(';')[0]!,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'navigate'},body}));
    const approved = await post();
    expect(approved.status).toBe(303);
    const callback = new URL(approved.headers.get('location')!);
    expect(callback.origin+callback.pathname).toBe(redirect);
    expect(callback.searchParams.get('state')).toBe('fixture-state');
    expect((await post()).status).toBe(400);
    const tokens = await handler(new Request('https://relay.example/connect/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:String(registered.body.client_id),redirect_uri:redirect,code:callback.searchParams.get('code')!,code_verifier:verifier})}));
    expect(tokens.status).toBe(200);
    expect((await tokens.json() as any).access_token).toBeTruthy();
  });
}

test('Linux local coding agents use the standalone installer; keys and Other require the owner tunnel', () => {
  const html = render({platform:'linux',headless:false});
  const local = section(html,'local');
  expect(local).toContain('Linux installer');
  expect(local).toContain('~/.local/bin/olympus');
  expect(local).toContain('claude mcp add olympus');
  expect(local).toContain('codex mcp add olympus');
  expect(local).not.toContain('Mac');
  expect(html).not.toContain('your OpenClaw agent');
  expect(section(html, 'grok-api')).toContain('Create key');
  expect(section(html, 'grok-api')).not.toContain('needs your own tunnel');
  for (const id of ['other']) {
    expect(section(html,id)).toContain('needs your own tunnel');
    const tunnel = section(render({platform:'linux'},mac.accesses[1]),id);
    expect(tunnel).toContain('Create key');
    expect(tunnel).toContain('bearer token');
  }
});

test('Linux Grok API owner key routes through the relay and remains install-bound and revocable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linux-routed-key-'));
  const store = openRemoteConnectionStore(join(dir, 'connections.sqlite'));
  const installId = 'a'.repeat(32);
  try {
    const response = await handleDashboardAgentRequest(new Request(`http://localhost${DASHBOARD_AGENT_KEYS_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Grok API', agent: 'grok-api' }),
    }), DASHBOARD_AGENT_KEYS_PATH, { store: () => store, remoteAccess: () => access, relayInstallId: () => installId });
    const body = await response!.json() as { token: string; connection: { id: string } };
    expect(credentialInstallId('access', body.token)).toBe(installId);
    const parsed = parseRemotePublicBaseUrl('https://relay.example', installId);
    if (!parsed.enabled) throw new Error('invalid fixture');
    const request = new Request('https://relay.example/mcp', { headers: { Authorization: `Bearer ${body.token}` } });
    const options = { connections: () => store, publicUrls: parsed.urls };
    expect(authenticateRemoteRequest(request, options)).toMatchObject({ ok: true, connection: { kind: 'bearer', provider: 'xai' } });
    expect(authenticateRemoteRequest(request, options, 'directory').ok).toBe(false);
    expect(authenticateRemoteRequest(request, { ...options, publicUrls: { ...parsed.urls, installId: 'b'.repeat(32) } }).ok).toBe(false);
    store.revoke(body.connection.id);
    expect(authenticateRemoteRequest(request, options).ok).toBe(false);
    const macKey = store.create('legacy fixture');
    expect(macKey.token).toStartWith('olympus_conn_');
    expect(store.verifyToken(macKey.token).ok).toBe(true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Linux refusal is host-neutral; Mac refusal remains exact', async () => {
  const urls = parseRemotePublicBaseUrl('https://relay.example','a'.repeat(32));
  if (!urls.enabled) throw new Error('fixture');
  for (const platform of ['linux','darwin'] as const) {
    const handler = createRemoteOAuthHandler({platform,publicUrls:urls.urls,connections:() => {throw new Error('must not open store');}});
    const response = await handler(new Request('https://relay.example/connect/authorize'));
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain(platform === 'linux' ? 'Approve on this computer' : 'Approve on the Mac where Olympus runs: open the link from ChatGPT on that Mac.');
    if (platform === 'linux') expect(html).not.toContain('Mac');
  }
});

test('Linux Other through an owner tunnel: registered client, pairing approval and key custody', async () => {
  const dir = mkdtempSync(join(tmpdir(),'linux-other-'));
  cleanup.push(() => rmSync(dir,{recursive:true,force:true}));
  const store = openRemoteConnectionStore(join(dir,'connections.sqlite'));
  cleanup.push(() => store.close());
  const parsed = parseRemotePublicBaseUrl('https://tunnel.example');
  if (!parsed.enabled) throw new Error('fixture');
  const handler = createRemoteOAuthHandler({platform:'linux',publicUrls:parsed.urls,connections:() => store});
  const registration = await handler(new Request('https://tunnel.example/connect/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Other',redirect_uris:['https://agent.example/callback']})}));
  expect(registration.status).toBe(201);
  const {client_id} = await registration.json() as {client_id:string};
  const verifier = 'v'.repeat(50);
  const query = new URLSearchParams({response_type:'code',client_id,redirect_uri:'https://agent.example/callback',code_challenge:new Bun.CryptoHasher('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  const page = await handler(new Request(`https://tunnel.example/connect/authorize?${query}`));
  const html = await page.text();
  expect(html).toContain('pairing_code');
  expect(html).toContain('your own computer');
  const approved = await handler(new Request('https://tunnel.example/connect/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:'https://tunnel.example',Cookie:page.headers.get('set-cookie')!.split(';')[0]!},body:new URLSearchParams({request_id:/name="request_id" value="([^"]+)"/.exec(html)![1]!,csrf:/name="csrf" value="([^"]+)"/.exec(html)![1]!,action:'approve',pairing_code:store.oauth.mintPairingCode().code})}));
  expect(approved.status).toBe(303);
  const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
  const tokens = await handler(new Request('https://tunnel.example/connect/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id,redirect_uri:'https://agent.example/callback',code,code_verifier:verifier})}));
  expect(tokens.status).toBe(200);
  // Keys have no OAuth approval: owner dashboard custody is covered by
  // dashboard-agent-connections.test.ts, and the same store backs the CLI.
  for (const name of ['Grok API','Other']) {
    const key = store.create(name);
    expect(store.verifyToken(key.token).ok).toBe(true);
    expect(JSON.stringify(store.list())).not.toContain(key.token);
    store.revoke(key.connection.id);
    expect(store.verifyToken(key.token).ok).toBe(false);
  }
});


test('actual Agents page carries the OPENER seam, escapes it, and Mac never calls it', () => {
  const handoff = 'ssh -N -L 127.0.0.1:8010:<socket> <target>';
  const html = renderDashboardAgentsPage({agents:{remoteAccess:access,connections:[]},now,agentConnectHost:{platform:'linux',headless:true,approvalHandoff:() => handoff}});
  expect(html).toContain('127.0.0.1:8010:&lt;socket&gt; &lt;target&gt;');
  expect(html).not.toContain('<socket>');
  expect(render({platform:'darwin',headless:true,approvalHandoff:() => {throw new Error('Mac must not ask for a Linux handoff');}})).toBe(mac.agents[0]);
  const tunnel = render({platform:'linux',headless:true,approvalHandoff:() => handoff},mac.accesses[1]);
  for (const id of ['chatgpt','claude','grok','grok-bot','cursor','other']) {
    expect(section(tunnel,id)).toContain('SSH socket forward');
    expect(section(tunnel,id)).toContain('pairing code');
  }
});

test('Linux registration refusal changes only the host noun', async () => {
  const parsed = parseRemotePublicBaseUrl('https://relay.example','a'.repeat(32));
  if (!parsed.enabled) throw new Error('fixture');
  for (const platform of ['linux','darwin'] as const) {
    const handler = createRemoteOAuthHandler({platform,publicUrls:parsed.urls,connections:() => {throw new Error('must not open store');}});
    const response = await handler(new Request('https://relay.example/connect/register',{method:'POST'}));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({error:'access_denied',error_description:`Registration is available only on this ${platform === 'linux' ? 'computer' : 'Mac'}.`});
  }
});
