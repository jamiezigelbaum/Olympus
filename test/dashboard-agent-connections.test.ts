/**
 * Setup's "Connect an agent" panel and its three control routes.
 *
 * The routes mint secrets (a pairing code, a connection key) and revoke
 * connections, so the assertions that matter most are custody (the same
 * control session plus CSRF every dashboard control needs), show-once (a
 * secret leaves in exactly one response and never reaches a page), and that
 * the dashboard and `olympus connections` share one store.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { isV04PublicDashboardRoute, V0_4_PUBLIC_PACKAGE_FILES } from '../src/core/public-surface.ts';
import { AGENT_INSTRUCTION_TEXT, AGENT_SKILL_PATH, agentSkillMarkdown } from '../src/core/agent-instructions.ts';
import { requestDashboardControl, parseDashboardControlParams } from '../src/core/control-ui-gateway.ts';
import { defaultConfig } from '../src/core/config.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { AGENT_MINT_LIMIT, withWorkerBearerAuth } from '../src/workers/http.ts';
import { allowedForwardPath, DEFAULT_ALLOWED_PATHS } from '../connect-relay/client/local-endpoint.ts';
import { V0_4_PUBLIC_DASHBOARD_ROUTES } from '../src/core/public-surface.ts';
import {
  DASHBOARD_AGENT_CONTROL_PATHS,
  dashboardAgentsView,
  remoteAccessFromStatus,
  type DashboardAgentConnectionsBackend,
  type DashboardRemoteAccess,
} from '../src/workers/agent-connections.ts';
import { renderDashboardAgentsSection } from '../src/workers/dashboard/agents.ts';
import { parseRemotePublicBaseUrl } from '../src/core/remote-public-url.ts';
import type { RemoteAccessStatusView } from '../src/core/remote-access.ts';
import { mountDashboardController } from '../src/control-ui/browser-controller.ts';
import type { OlympusDashboardControlParams, OlympusDashboardControlResult } from '../src/control-ui-contract.ts';

const ROOT = join(import.meta.dir, '..');
const ORIGIN = 'http://127.0.0.1:17777';
const PUBLIC = 'https://abc123.connect.olympusplugin.ai';
const REMOTE_ON: DashboardRemoteAccess = { state: 'on', mcpUrl: `${PUBLIC}/mcp`, openapiUrl: `${PUBLIC}/openapi.json` };
const NOW = new Date('2026-09-24T12:00:00.000Z');

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function fixtureStore(): RemoteConnectionStore {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-agents-'));
  const store = openRemoteConnectionStore(join(dir, 'private', 'remote-connections.sqlite'));
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

function backend(store: RemoteConnectionStore, access: DashboardRemoteAccess = REMOTE_ON): DashboardAgentConnectionsBackend {
  return { store: () => store, remoteAccess: () => access };
}

function memorySecretStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    label: 'memory',
    get: async (key) => values.get(key),
    getSync: (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
  } as SecretStore;
}

function guardedWorker(agents: DashboardAgentConnectionsBackend) {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-agents-worker-'));
  const worker = createEmailSourceWorker({
    agentConnections: agents,
    sourceIndexStatus: {
      async status() {
        return {
          kind: 'source_index_status',
          generated_at: NOW.toISOString(),
          corpora: [],
          policy: {
            read_only: true,
            raw_source_exposed: false,
            source_packets_exposed: false,
            source_text_returned: false,
            secure_local_item_metadata_exposed: false,
            castor_visible: true,
          },
        } as unknown as SourceIndexStatusResult;
      },
    },
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
        OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
        OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
      })),
      registryPath: join(dir, 'handles.json'),
      secretStore: memorySecretStore(),
      registryAdoptionIntervalMs: 0,
    },
  });
  cleanups.push(() => { worker.close?.(); rmSync(dir, { recursive: true, force: true }); });
  return withWorkerBearerAuth((request: Request) => worker.fetch(request), { authToken: 'worker-secret' });
}

async function controlSession(guarded: (request: Request) => Promise<Response>): Promise<{ cookie: string; csrf: string }> {
  const mint = await guarded(new Request(`${ORIGIN}/dashboard/control/session`, {
    method: 'POST',
    headers: { Authorization: 'Bearer worker-secret', Origin: ORIGIN },
  }));
  expect(mint.status).toBe(200);
  return {
    cookie: mint.headers.get('Set-Cookie')!.split(';')[0]!,
    csrf: ((await mint.json()) as { csrf_token: string }).csrf_token,
  };
}

function post(path: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('agent control routes carry dashboard custody', () => {
  test('are public dashboard control routes', () => {
    for (const path of DASHBOARD_AGENT_CONTROL_PATHS) {
      expect(isV04PublicDashboardRoute('POST', path)).toBe(true);
      expect(isV04PublicDashboardRoute('GET', path)).toBe(false);
    }
  });

  test('refuse no session, a missing CSRF token, a foreign origin and the read-only token', async () => {
    const store = fixtureStore();
    const guarded = guardedWorker(backend(store));
    const { cookie, csrf } = await controlSession(guarded);
    const viewToken = dashboardQueryTokenFromWorkerAuthToken('worker-secret')!;
    for (const path of DASHBOARD_AGENT_CONTROL_PATHS) {
      const body = path.endsWith('keys') ? { name: 'Muse' } : path.endsWith('revoke') ? { connection_id: 'a'.repeat(18) } : {};
      expect((await guarded(post(path, body, { Origin: ORIGIN }))).status).toBe(401);
      expect((await guarded(post(path, body, { Cookie: cookie, Origin: ORIGIN }))).status).toBe(403);
      expect((await guarded(post(path, body, { Cookie: cookie, Origin: 'http://attacker.test', 'X-Olympus-CSRF': csrf }))).status).toBe(403);
      expect((await guarded(post(`${path}?token=${viewToken}`, body, { Origin: ORIGIN }))).status).toBe(401);
      // GET is not a route at all.
      expect((await guarded(new Request(`${ORIGIN}${path}`, { headers: { Authorization: 'Bearer worker-secret' } }))).status).toBe(404);
    }
    // Nothing was created by any refused request.
    expect(store.list()).toEqual([]);
  });

  test('a live session with CSRF creates, lists and revokes; the key is shown once', async () => {
    const store = fixtureStore();
    const guarded = guardedWorker(backend(store));
    const { cookie, csrf } = await controlSession(guarded);
    const custody = { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf };

    const created = await guarded(post('/dashboard/agents/keys', { name: 'Muse' }, custody));
    expect(created.status).toBe(200);
    expect(created.headers.get('Cache-Control')).toBe('no-store');
    const body = await created.json() as { ok: boolean; token: string; connection: { id: string; name: string }; openapi_url: string };
    expect(body.ok).toBe(true);
    expect(body.token).toMatch(/^olympus_conn_[a-f0-9]{18}_/);
    expect(body.connection.name).toBe('Muse');
    expect(body.openapi_url).toBe(`${PUBLIC}/openapi.json`);
    // Same store as `olympus connections`: the token verifies there.
    expect(store.verifyToken(body.token)).toMatchObject({ ok: true });

    // The Setup page lists the connection and never carries the token.
    const page = await guarded(new Request(`${ORIGIN}/dashboard?setup`, { headers: { Authorization: 'Bearer worker-secret' } }));
    const html = await page.text();
    expect(html).toContain(`data-agent-connection="${body.connection.id}"`);
    expect(html).not.toContain(body.token);
    // The secret is everything after `olympus_conn_<18-hex id>_`; it may itself
    // contain `_` (base64url), so splitting on `_` could test a 1-2 character
    // fragment that CSS happens to contain.
    expect(html).not.toContain(body.token.slice('olympus_conn_'.length + 18 + 1));
    // Nor does the JSON view model.
    const json = await (await guarded(new Request(`${ORIGIN}/dashboard.json`, { headers: { Authorization: 'Bearer worker-secret' } }))).text();
    expect(json).not.toContain(body.token);

    const revoked = await guarded(post('/dashboard/agents/revoke', { connection_id: body.connection.id }, custody));
    expect(revoked.status).toBe(200);
    expect(store.verifyToken(body.token)).toEqual({ ok: false, reason: 'revoked' });
    const after = await (await guarded(new Request(`${ORIGIN}/dashboard?setup`, { headers: { Authorization: 'Bearer worker-secret' } }))).text();
    expect(after).not.toContain(`data-agent-connection="${body.connection.id}"`);
  });

  test('the Gateway bearer path reaches the same routes', async () => {
    const store = fixtureStore();
    const guarded = guardedWorker(backend(store));
    const response = await guarded(post('/dashboard/agents/pairing-code', {}, { Authorization: 'Bearer worker-secret' }));
    expect(response.status).toBe(200);
  });
});

describe('agent routes refuse remote-agent credentials and the relay never forwards them', () => {
  test('a connection key or an OAuth access token is not a dashboard credential', async () => {
    const store = fixtureStore();
    const guarded = guardedWorker(backend(store));
    const key = store.create('Muse').token;
    const grant = store.oauth.createGrant({ clientId: 'https://claude.ai/oauth/client.json', displayName: 'Claude', resource: `${PUBLIC}/mcp` });
    for (const token of [key, grant.tokens.accessToken, grant.tokens.refreshToken]) {
      for (const path of DASHBOARD_AGENT_CONTROL_PATHS) {
        const body = path.endsWith('keys') ? { name: 'Evil' } : path.endsWith('revoke') ? { connection_id: grant.connection.id } : {};
        const response = await guarded(post(path, body, { Authorization: `Bearer ${token}`, Origin: ORIGIN }));
        expect(response.status).toBe(401);
      }
    }
    expect(store.list().map((record) => [record.displayName, record.revokedAt]).sort()).toEqual([['Claude', null], ['Muse', null]]);
  });

  test('no /dashboard path is ever on the relay allowlist, however it is spelled', () => {
    expect((DEFAULT_ALLOWED_PATHS as readonly string[]).some((path) => path.startsWith('/dashboard') || path === '/')).toBe(false);
    const probes = [
      ...V0_4_PUBLIC_DASHBOARD_ROUTES.map((route) => route.path),
      ...DASHBOARD_AGENT_CONTROL_PATHS,
      '/dashboard?setup',
      '/mcp/../dashboard/agents/keys',
      '/mcp/%2e%2e/dashboard/agents/keys',
      '/api/v1/tools/..%2F..%2Fdashboard/agents/keys',
      '/connect/authorize/../../dashboard/agents/pairing-code',
      '//dashboard/agents/keys',
      '/DASHBOARD/agents/keys',
    ];
    for (const probe of probes) {
      const forwarded = allowedForwardPath(probe, DEFAULT_ALLOWED_PATHS);
      expect(forwarded === undefined || !forwarded.toLowerCase().includes('dashboard')).toBe(true);
    }
  });
});

describe('minting is rate limited per control session', () => {
  test('refuses the mint past the limit and leaves revoke alone', async () => {
    const store = fixtureStore();
    const guarded = guardedWorker(backend(store));
    const { cookie, csrf } = await controlSession(guarded);
    const custody = { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf };
    for (let index = 0; index < AGENT_MINT_LIMIT; index++) {
      const path = index % 2 === 0 ? '/dashboard/agents/pairing-code' : '/dashboard/agents/keys';
      const response = await guarded(post(path, index % 2 === 0 ? {} : { name: `Agent ${index}` }, custody));
      expect(response.status).toBe(200);
    }
    const limited = await guarded(post('/dashboard/agents/keys', { name: 'One too many' }, custody));
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('agent_mint_rate_limited');
    expect(store.list().some((record) => record.displayName === 'One too many')).toBe(false);
    const first = store.list()[0]!;
    expect((await guarded(post('/dashboard/agents/revoke', { connection_id: first.id }, custody))).status).toBe(200);
  });
});

describe('pairing codes', () => {
  test('are minted from the same store the approval page checks, once', async () => {
    const store = fixtureStore();
    const guarded = guardedWorker(backend(store));
    const response = await guarded(post('/dashboard/agents/pairing-code', {}, { Authorization: 'Bearer worker-secret' }));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as { ok: boolean; code: string; expires_at: string; url: string };
    expect(body.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(body.url).toBe(`${PUBLIC}/mcp`);
    expect(Date.parse(body.expires_at) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(store.oauth.checkPairingCode(body.code)).toMatchObject({ ok: true });
    expect(store.oauth.checkPairingCode(body.code)).toMatchObject({ ok: false });
  });

  test('are refused while remote access is off, and nothing is minted', async () => {
    const store = fixtureStore();
    const guarded = guardedWorker(backend(store, { state: 'off' }));
    const response = await guarded(post('/dashboard/agents/pairing-code', {}, { Authorization: 'Bearer worker-secret' }));
    expect(response.status).toBe(409);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('remote_access_off');
    expect(body.error.message).toContain('Remote access is off');
  });
});

describe('request validation', () => {
  test('rejects extra fields, bad names, bad ids and unknown connections', async () => {
    const store = fixtureStore();
    const guarded = guardedWorker(backend(store));
    const auth = { Authorization: 'Bearer worker-secret' };
    expect((await guarded(post('/dashboard/agents/pairing-code', { extra: 1 }, auth))).status).toBe(400);
    expect((await guarded(post('/dashboard/agents/keys', { name: '   ' }, auth))).status).toBe(400);
    expect((await guarded(post('/dashboard/agents/keys', { name: 'Muse', token: 'x' }, auth))).status).toBe(400);
    expect((await guarded(post('/dashboard/agents/revoke', { connection_id: 'nope' }, auth))).status).toBe(400);
    expect((await guarded(post('/dashboard/agents/revoke', { connection_id: 'b'.repeat(18) }, auth))).status).toBe(404);
    expect(store.list()).toEqual([]);
  });

  test('the Gateway bridge accepts exactly the three actions and maps them to the routes', async () => {
    expect(parseDashboardControlParams({ action: 'mint_agent_pairing_code' })).toEqual({ action: 'mint_agent_pairing_code' });
    expect(parseDashboardControlParams({ action: 'create_agent_key', name: ' Muse ' })).toEqual({ action: 'create_agent_key', name: 'Muse' });
    expect(() => parseDashboardControlParams({ action: 'create_agent_key', name: 'Muse', token: 'x' })).toThrow();
    expect(() => parseDashboardControlParams({ action: 'revoke_agent_connection', connection_id: '../etc' })).toThrow();
    const seen: Array<{ url: string; body: string }> = [];
    const config = defaultConfig();
    config.worker.authToken = 'worker-secret';
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const params: OlympusDashboardControlParams[] = [
      { action: 'mint_agent_pairing_code' },
      { action: 'create_agent_key', name: 'Muse' },
      { action: 'revoke_agent_connection', connection_id: 'c'.repeat(18) },
    ];
    for (const param of params) await requestDashboardControl({ params: param, config, fetchImpl });
    expect(seen.map((entry) => new URL(entry.url).pathname)).toEqual([...DASHBOARD_AGENT_CONTROL_PATHS]);
    expect(seen.map((entry) => JSON.parse(entry.body))).toEqual([{}, { name: 'Muse' }, { connection_id: 'c'.repeat(18) }]);
  });
});

describe('remote access follows the relay status', () => {
  const live = parseRemotePublicBaseUrl(PUBLIC);
  const status = (patch: Partial<RemoteAccessStatusView>) => ({ error: null, mode: 'relay', remote_enabled: true, next_step: null, ...patch }) as RemoteAccessStatusView;
  test('on means the worker is serving a public address now', () => {
    expect(remoteAccessFromStatus({ live: live.enabled ? live.urls : undefined, status: status({}) })).toEqual(REMOTE_ON);
  });
  test('a relay that is enabled but not yet serving is not connected, with its next step', () => {
    expect(remoteAccessFromStatus({ live: undefined, status: status({ next_step: 'Olympus is obtaining its certificate.' }) }))
      .toEqual({ state: 'not_connected', detail: 'Olympus is obtaining its certificate.' });
    expect(render({ state: 'not_connected', detail: 'Olympus is obtaining its certificate.' })).toContain('Olympus is obtaining its certificate.');
  });
  test('a configuration error is invalid, and no status or mode off is off', () => {
    expect(remoteAccessFromStatus({ live: undefined, status: status({ error: 'remote.relayHost and remote.publicBaseUrl are mutually exclusive' }) }))
      .toEqual({ state: 'invalid', detail: 'remote.relayHost and remote.publicBaseUrl are mutually exclusive' });
    expect(remoteAccessFromStatus({ live: undefined, status: undefined })).toEqual({ state: 'off' });
    expect(remoteAccessFromStatus({ live: undefined, status: status({ mode: 'off', remote_enabled: false }) })).toEqual({ state: 'off' });
  });
});

function render(access: DashboardRemoteAccess, store?: RemoteConnectionStore): string {
  const view = store ? dashboardAgentsView(backend(store, access)) : { remoteAccess: access, connections: [] };
  return renderDashboardAgentsSection({ view, now: NOW });
}

describe('the panel', () => {
  test('offers every agent with its own method when remote access is on', () => {
    const html = render(REMOTE_ON);
    for (const label of ['Claude', 'ChatGPT', 'Grok or Grok Bot', 'Muse', 'Grok API', 'Claude Code or Codex', 'Other']) {
      expect(html).toContain(`<span class="name">${label}</span>`);
    }
    const doc = new Window().document;
    doc.body.innerHTML = html;
    const agent = (id: string) => doc.querySelector(`[data-agent="${id}"]`)!;
    for (const id of ['claude', 'chatgpt', 'grok']) {
      expect(agent(id).querySelector('form[data-agent-kind="pair"]')).not.toBeNull();
      expect(agent(id).querySelector('form[data-agent-kind="key"]')).toBeNull();
      expect(agent(id).textContent).toContain(`${PUBLIC}/mcp`);
    }
    expect(agent('muse').querySelector('form[data-agent-kind="key"]')).not.toBeNull();
    expect(agent('muse').textContent).toContain(`${PUBLIC}/openapi.json`);
    expect(agent('grok-api').querySelector('form[data-agent-kind="key"]')).not.toBeNull();
    expect(agent('grok-api').textContent).toContain(`${PUBLIC}/mcp`);
    expect(agent('local').textContent).toContain('olympus serve');
    expect(agent('local').querySelector('form')).toBeNull();
    // Every copy button points at something that exists, and every agent can
    // copy the when-to-ask instructions.
    for (const button of doc.querySelectorAll('[data-copy-target]')) {
      expect(doc.querySelector(button.getAttribute('data-copy-target')!)).not.toBeNull();
    }
    for (const choice of doc.querySelectorAll('[data-agent]')) {
      const id = choice.getAttribute('data-agent');
      expect(doc.querySelector(`#agent-${id}-instructions`)?.textContent).toBe(AGENT_INSTRUCTION_TEXT);
    }
    // Secret fields ship empty; nothing but the controller fills them.
    for (const field of doc.querySelectorAll('[data-agent-secret]')) {
      expect(field.getAttribute('value')).toBeNull();
      expect(field.closest('[data-agent-secret-slot]')!.hasAttribute('hidden')).toBe(true);
    }
    expect(html).toContain('data-remote-access="on"');
    expect(html).not.toMatch(/\d+%/);
  });

  test('says plainly when remote access is off, and still offers local agents', () => {
    for (const access of [{ state: 'off' }, { state: 'not_connected' }, { state: 'invalid', detail: 'OLYMPUS_PUBLIC_BASE_URL must use https.' }] as DashboardRemoteAccess[]) {
      const html = render(access);
      expect(html).toContain(`data-remote-access="${access.state}"`);
      expect(html).toContain('data-remote-unavailable');
      expect(html).not.toContain('data-agent-kind="pair"');
      expect(html).not.toContain('data-agent-kind="key"');
      expect(html).toContain('olympus serve');
    }
    expect(render({ state: 'off' })).toContain('Off. Only agents on this computer can ask Olympus.');
  });

  test('lists active connections with dates and a Revoke control', () => {
    const store = fixtureStore();
    const muse = store.create('Muse');
    const grok = store.create('Grok API');
    store.revoke(grok.connection.id);
    const html = render(REMOTE_ON, store);
    expect(html).toContain('Connected agents — 1');
    expect(html).toContain(`value="${muse.connection.id}"`);
    expect(html).not.toContain(grok.connection.id);
    expect(html).toContain('not used yet');
    expect(html).not.toContain(muse.token);
  });

  test('a hostile connection name is escaped in the list', () => {
    const hostile = '<img src=x onerror="alert(1)">\'"&';
    const html = renderDashboardAgentsSection({
      view: { remoteAccess: REMOTE_ON, connections: [{ id: 'e'.repeat(18), name: hostile, kind: 'bearer', createdAt: NOW.toISOString(), lastUsedAt: null }] },
      now: NOW,
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror="');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    const doc = new Window().document;
    doc.body.innerHTML = html;
    expect(doc.querySelector('img')).toBeNull();
    const row = doc.querySelector('[data-agent-connection]')!;
    expect(row.querySelector('.name')!.textContent).toBe(hostile);
    expect(row.querySelector('form')!.getAttribute('data-confirmation')).toContain(hostile);
    // And through the store, as the worker renders it.
    const store = fixtureStore();
    store.create(hostile);
    const viaStore = renderDashboardAgentsSection({ view: dashboardAgentsView(backend(store)), now: NOW });
    expect(viaStore).not.toContain('<img');
  });

  test('an unreadable connection list is not shown as empty', () => {
    const view = dashboardAgentsView({ store: () => { throw new Error('locked'); }, remoteAccess: () => REMOTE_ON });
    expect(view.unavailable).toBe(true);
    expect(renderDashboardAgentsSection({ view, now: NOW })).toContain('could not read its list');
  });
});

describe('the when-to-ask instructions', () => {
  test('ship as a packaged Agent Skills file equal to the panel text', () => {
    expect(V0_4_PUBLIC_PACKAGE_FILES).toContain(AGENT_SKILL_PATH);
    expect(readFileSync(join(ROOT, AGENT_SKILL_PATH), 'utf8')).toBe(agentSkillMarkdown());
    expect(AGENT_INSTRUCTION_TEXT).toContain('source_answer');
    expect(AGENT_INSTRUCTION_TEXT).not.toContain('source_index_search');
    expect(AGENT_INSTRUCTION_TEXT).not.toContain('source_watch');
  });
});

describe('the controller shows a secret once', () => {
  const GLOBALS = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement',
    'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS'] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  let happy: Window;
  beforeEach(() => {
    happy = new Window({ url: 'https://gateway.test/' });
    for (const name of GLOBALS) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      const value = name === 'window' ? happy : name === 'document' ? happy.document : name === 'navigator' ? happy.navigator : (happy as unknown as Record<string, unknown>)[name];
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
  });
  afterEach(() => {
    for (const name of GLOBALS) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    happy.close();
  });

  function mount(control: (params: OlympusDashboardControlParams) => Promise<OlympusDashboardControlResult>) {
    const root = document.createElement('div');
    root.innerHTML = renderDashboardAgentsSection({ view: { remoteAccess: REMOTE_ON, connections: [] }, now: NOW });
    document.body.append(root);
    const abort = new AbortController();
    let refreshes = 0;
    mountDashboardController({
      root,
      transport: { control },
      navigate: () => undefined,
      refresh: async () => { refreshes++; return undefined; },
      returnUrl: 'https://gateway.test/',
      canWrite: true,
      signal: abort.signal,
      pollIntervalMs: 0,
    });
    cleanups.push(() => abort.abort());
    return { root, refreshes: () => refreshes };
  }

  test('a pairing code lands in a read-only field, never in markup, and Done clears it', async () => {
    const calls: OlympusDashboardControlParams[] = [];
    const { root } = mount(async (params) => {
      calls.push(params);
      return { status: 200, body: { ok: true, code: 'ABCD-EFGH-JKLM', expires_at: NOW.toISOString() } };
    });
    const choice = root.querySelector<HTMLElement>('[data-agent="claude"]')!;
    choice.querySelector<HTMLFormElement>('form[data-agent-kind="pair"]')!.requestSubmit();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(calls).toEqual([{ action: 'mint_agent_pairing_code' }]);
    const field = choice.querySelector<HTMLInputElement>('[data-agent-secret]')!;
    expect(field.value).toBe('ABCD-EFGH-JKLM');
    expect(field.readOnly).toBe(true);
    expect(field.closest<HTMLElement>('[data-agent-secret-slot]')!.hidden).toBe(false);
    expect(root.innerHTML).not.toContain('ABCD-EFGH-JKLM');
    choice.querySelector<HTMLElement>('[data-agent-secret-done]')!.click();
    expect(field.value).toBe('');
    expect(field.closest<HTMLElement>('[data-agent-secret-slot]')!.hidden).toBe(true);
  });

  test('Create key sends the name and shows the key; a refusal shows its message', async () => {
    const calls: OlympusDashboardControlParams[] = [];
    let refuse = false;
    const { root } = mount(async (params) => {
      calls.push(params);
      return refuse
        ? { status: 409, body: { ok: false, error: { message: 'Remote access is off.' } } }
        : { status: 200, body: { ok: true, token: 'olympus_conn_secret' } };
    });
    const muse = root.querySelector<HTMLElement>('[data-agent="muse"]')!;
    const form = muse.querySelector<HTMLFormElement>('form[data-agent-kind="key"]')!;
    form.requestSubmit();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(calls[0]).toEqual({ action: 'create_agent_key', name: 'Muse' });
    expect(muse.querySelector<HTMLInputElement>('[data-agent-secret]')!.value).toBe('olympus_conn_secret');
    expect(muse.querySelector('[data-agent-secret-note]')!.textContent).toContain('cannot show it again');
    refuse = true;
    const claude = root.querySelector<HTMLElement>('[data-agent="claude"]')!;
    claude.querySelector<HTMLFormElement>('form[data-agent-kind="pair"]')!.requestSubmit();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(claude.querySelector('[data-action-message]')!.textContent).toBe('Remote access is off.');
    expect(claude.querySelector<HTMLElement>('[data-agent-secret-slot]')!.hidden).toBe(true);
  });

  test('after Create key the list is refreshed while the key stays on screen', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderDashboardAgentsSection({ view: { remoteAccess: REMOTE_ON, connections: [] }, now: NOW });
    document.body.append(root);
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    const refreshed = renderDashboardAgentsSection({
      view: { remoteAccess: REMOTE_ON, connections: [{ id: 'f'.repeat(18), name: 'Muse', kind: 'bearer', createdAt: NOW.toISOString(), lastUsedAt: null }] },
      now: NOW,
    });
    mountDashboardController({
      root,
      transport: { control: async () => ({ status: 200, body: { ok: true, token: 'olympus_conn_secret' } }) },
      navigate: () => undefined,
      refresh: async () => ({ status: 200, title: 'Olympus', body: refreshed, controller: 'dashboard', can_write: true, signature: 'next', poll_interval_ms: 1000 }),
      returnUrl: 'https://gateway.test/',
      canWrite: true,
      signal: abort.signal,
      pollIntervalMs: 0,
    });
    // The sheet is open with fields in it: a full refresh would be held off.
    root.querySelector<HTMLElement>('[data-sheet-toggle="#agent-connect"]')!.click();
    const muse = root.querySelector<HTMLElement>('[data-agent="muse"]')!;
    muse.querySelector<HTMLFormElement>('form[data-agent-kind="key"]')!.requestSubmit();
    for (let tick = 0; tick < 5; tick++) await Bun.sleep(0);
    expect(root.querySelector('[data-agent-connection]')?.getAttribute('data-agent-connection')).toBe('f'.repeat(18));
    expect(muse.querySelector<HTMLInputElement>('[data-agent-secret]')!.value).toBe('olympus_conn_secret');
    expect(root.querySelector('#agent-connect')!.classList.contains('on')).toBe(true);
  });

  test('Revoke asks first and does nothing when declined', async () => {
    const calls: OlympusDashboardControlParams[] = [];
    const root = document.createElement('div');
    root.innerHTML = renderDashboardAgentsSection({
      view: { remoteAccess: REMOTE_ON, connections: [{ id: 'd'.repeat(18), name: 'Muse', kind: 'bearer', createdAt: NOW.toISOString(), lastUsedAt: null }] },
      now: NOW,
    });
    document.body.append(root);
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    mountDashboardController({
      root,
      transport: { control: async (params) => { calls.push(params); return { status: 200, body: { ok: true, status_message: 'Muse can no longer ask Olympus.' } }; } },
      navigate: () => undefined,
      refresh: async () => undefined,
      returnUrl: 'https://gateway.test/',
      canWrite: true,
      signal: abort.signal,
      pollIntervalMs: 0,
    });
    const form = root.querySelector<HTMLFormElement>('form[data-agent-kind="revoke"]')!;
    let answer = false;
    (happy as unknown as { confirm: () => boolean }).confirm = () => answer;
    form.requestSubmit();
    await Bun.sleep(0);
    expect(calls).toEqual([]);
    answer = true;
    form.requestSubmit();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(calls).toEqual([{ action: 'revoke_agent_connection', connection_id: 'd'.repeat(18) }]);
    expect(form.querySelector('[data-action-message]')!.textContent).toBe('Muse can no longer ask Olympus.');
  });
});
