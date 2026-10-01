/**
 * Turn on / Turn off remote access from Setup's Agents section.
 *
 * What matters: the toggle carries the same custody as every dashboard
 * control (control cookie, CSRF, same origin) plus its own rate limit; turning
 * it on needs the owner's explicit acceptance of the CA's *current*
 * subscriber agreement, recorded exactly as `olympus connections terms
 * --accept` records it; the config change goes only through OpenClaw's own
 * config write (`api.runtime.config.mutateConfigFile`, in the Gateway); and
 * a relay that is down reads as "not connected" with its reason.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { runConnectionsTermsCommand } from '../src/cli.ts';
import { parseDashboardControlParams } from '../src/core/control-ui-gateway.ts';
import {
  emptyRemoteAccessStatus,
  readTermsAcceptance,
  recordTermsAcceptance,
  remoteAccessDir,
  remoteAccessStatusView,
  writeRemoteAccessStatus,
  type RemoteAccessStatusFile,
} from '../src/core/remote-access.ts';
import {
  handleRemoteAccessConfigRequest,
  REMOTE_ACCESS_CONFIG_ROUTE,
  type OpenClawRuntimeConfigWriter,
} from '../src/core/remote-access-config.ts';
import { parseRemotePublicBaseUrl } from '../src/core/remote-public-url.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  AGENT_MINT_LIMIT,
  REMOTE_ACCESS_TOGGLE_LIMIT,
  withWorkerBearerAuth,
} from '../src/workers/http.ts';
import {
  DASHBOARD_AGENT_REMOTE_ACCESS_PATH,
  handleDashboardAgentRequest,
  LETS_ENCRYPT_REPOSITORY_URL,
  remoteAccessFromStatus,
  type DashboardAgentConnectionsBackend,
  type DashboardRemoteAccess,
  type RemoteAccessConfigWrite,
} from '../src/workers/agent-connections.ts';
import { renderDashboardAgentsSection } from '../src/workers/dashboard/agents.ts';
import { createDashboardRemoteAccessControl, createGatewayRemoteAccessConfigWriter } from '../src/workers/remote-access-control.ts';
import { mountDashboardController } from '../src/control-ui/browser-controller.ts';
import type { OlympusDashboardControlParams, OlympusDashboardControlResult } from '../src/control-ui-contract.ts';

const ROOT = join(import.meta.dir, '..');
const ORIGIN = 'http://127.0.0.1:17777';
const PUBLIC = 'https://abc123.connect.olympusplugin.ai';
const TERMS_V1 = 'https://letsencrypt.org/documents/LE-SA-v1.5.pdf';
const TERMS_V2 = 'https://letsencrypt.org/documents/LE-SA-v1.6.pdf';
const NOW = new Date('2026-09-25T12:00:00.000Z');

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** A throwaway home laid out like a managed install, so the CLI and the dashboard share one state directory. */
function home() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-remote-toggle-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const homeDir = join(root, 'home');
  mkdirSync(join(homeDir, '.config', 'olympus'), { recursive: true });
  writeFileSync(join(homeDir, '.config', 'olympus', 'worker.env'), '', { mode: 0o600 });
  const env = { HOME: homeDir, OLYMPUS_CONFIG: join(root, 'missing-config.json') };
  return { env, dir: remoteAccessDir({ HOME: homeDir }) };
}

function relayStatus(overrides: Partial<RemoteAccessStatusFile> = {}): RemoteAccessStatusFile {
  return {
    ...emptyRemoteAccessStatus('relay'),
    relay_host: 'connect.olympusplugin.ai',
    local_url: 'http://127.0.0.1:28190',
    public_base_url: PUBLIC,
    instance_id: 'instance-1',
    pid: process.pid,
    install_id: 'abc123',
    hostname: 'abc123.connect.olympusplugin.ai',
    relay: { state: 'online', reason: null, retry_in_ms: null },
    certificate: { state: 'serving', not_after: '2026-12-23T00:00:00.000Z', reason: null, retry_in_ms: null },
    terms_url: TERMS_V1,
    ...overrides,
  };
}

/** The dashboard control over a real state directory, with the config write recorded. */
function control(dir: string, options: { fetchTerms?: () => Promise<string | undefined>; write?: RemoteAccessConfigWrite } = {}) {
  const writes: boolean[] = [];
  const fetched: number[] = [];
  const remoteAccessControl = createDashboardRemoteAccessControl({
    dir: () => dir,
    fetchTerms: options.fetchTerms ?? (async () => { fetched.push(1); return TERMS_V1; }),
    setEnabled: async (enabled) => { writes.push(enabled); return options.write ?? { ok: true }; },
    now: () => NOW,
  });
  const backend: DashboardAgentConnectionsBackend = {
    store: () => undefined,
    remoteAccess: () => ({ state: 'off' }),
    remoteAccessControl,
  };
  return { backend, writes, fetched };
}

function guarded(backend: DashboardAgentConnectionsBackend) {
  const worker = createEmailSourceWorker({ agentConnections: backend });
  cleanups.push(() => worker.close?.());
  return withWorkerBearerAuth((request: Request) => worker.fetch(request), { authToken: 'worker-secret' });
}

async function controlSession(fetcher: (request: Request) => Promise<Response>): Promise<{ cookie: string; csrf: string }> {
  const mint = await fetcher(new Request(`${ORIGIN}/dashboard/control/session`, {
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

async function call(backend: DashboardAgentConnectionsBackend, body: unknown) {
  const response = (await handleDashboardAgentRequest(
    post(DASHBOARD_AGENT_REMOTE_ACCESS_PATH, body, {}),
    DASHBOARD_AGENT_REMOTE_ACCESS_PATH,
    backend,
  ))!;
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe('the toggle carries dashboard custody', () => {
  test('refuses no session, a missing CSRF token, a foreign origin and the read-only token, and writes nothing', async () => {
    const { dir } = home();
    writeRemoteAccessStatus(dir, relayStatus());
    const { backend, writes } = control(dir);
    const fetcher = guarded(backend);
    const { cookie, csrf } = await controlSession(fetcher);
    const viewToken = dashboardQueryTokenFromWorkerAuthToken('worker-secret')!;
    const path = DASHBOARD_AGENT_REMOTE_ACCESS_PATH;
    for (const body of [{ enabled: true, accept_terms: { url: TERMS_V1 } }, { enabled: false }]) {
      expect((await fetcher(post(path, body, { Origin: ORIGIN }))).status).toBe(401);
      expect((await fetcher(post(path, body, { Cookie: cookie, Origin: ORIGIN }))).status).toBe(403);
      expect((await fetcher(post(path, body, { Cookie: cookie, Origin: 'http://attacker.test', 'X-Olympus-CSRF': csrf }))).status).toBe(403);
      expect((await fetcher(post(path, body, { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': 'wrong' }))).status).toBe(403);
      expect((await fetcher(post(`${path}?token=${viewToken}`, body, { Origin: ORIGIN }))).status).toBe(401);
      expect((await fetcher(new Request(`${ORIGIN}${path}`, { headers: { Authorization: 'Bearer worker-secret' } }))).status).toBe(404);
    }
    expect(writes).toEqual([]);
    expect(readTermsAcceptance(dir)).toBeUndefined();
  });

  test('a live session with CSRF, and the Gateway bearer, turn it on and off', async () => {
    const { dir } = home();
    writeRemoteAccessStatus(dir, relayStatus());
    const { backend, writes } = control(dir);
    const fetcher = guarded(backend);
    const { cookie, csrf } = await controlSession(fetcher);
    const custody = { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf };
    const on = await fetcher(post(DASHBOARD_AGENT_REMOTE_ACCESS_PATH, { enabled: true, accept_terms: { url: TERMS_V1 } }, custody));
    expect(on.status).toBe(200);
    expect(on.headers.get('Cache-Control')).toBe('no-store');
    expect(await on.json()).toMatchObject({ ok: true, enabled: true, status_message: expect.stringContaining('turning on') });
    const off = await fetcher(post(DASHBOARD_AGENT_REMOTE_ACCESS_PATH, { enabled: false }, { Authorization: 'Bearer worker-secret' }));
    expect(off.status).toBe(200);
    expect(writes).toEqual([true, false]);
  });

  test('is rate limited per control session, on its own budget', async () => {
    const { dir } = home();
    writeRemoteAccessStatus(dir, relayStatus());
    recordTermsAcceptance(dir, TERMS_V1);
    const { backend, writes } = control(dir);
    const fetcher = guarded(backend);
    const { cookie, csrf } = await controlSession(fetcher);
    const custody = { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf };
    for (let index = 0; index < REMOTE_ACCESS_TOGGLE_LIMIT; index++) {
      expect((await fetcher(post(DASHBOARD_AGENT_REMOTE_ACCESS_PATH, { enabled: index % 2 === 1 }, custody))).status).toBe(200);
    }
    const limited = await fetcher(post(DASHBOARD_AGENT_REMOTE_ACCESS_PATH, { enabled: false }, custody));
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('remote_access_rate_limited');
    expect(writes).toHaveLength(REMOTE_ACCESS_TOGGLE_LIMIT);
    // Minting agent codes keeps its own budget (the route then refuses: no store here).
    expect(AGENT_MINT_LIMIT).toBeGreaterThan(0);
    expect((await fetcher(post('/dashboard/agents/keys', { name: 'Muse' }, custody))).status).not.toBe(429);
  });
});

describe('the agreement gates turning it on', () => {
  test('no enable without acceptance: the route names the agreement and writes nothing', async () => {
    const { dir } = home();
    writeRemoteAccessStatus(dir, relayStatus({ certificate: { state: 'awaiting_terms', not_after: null, reason: null, retry_in_ms: null } }));
    const { backend, writes } = control(dir);
    const refused = await call(backend, { enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ ok: false, error: { code: 'terms_required' }, terms: { url: TERMS_V1, read_url: TERMS_V1 } });
    expect(writes).toEqual([]);
    expect(readTermsAcceptance(dir)).toBeUndefined();
  });

  test('explicit acceptance is recorded exactly as olympus connections terms --accept records it', async () => {
    const dashboard = home();
    writeRemoteAccessStatus(dashboard.dir, relayStatus());
    const { backend, writes } = control(dashboard.dir);
    expect((await call(backend, { enabled: true, accept_terms: { url: TERMS_V1 } })).status).toBe(200);
    expect(writes).toEqual([true]);

    const cli = home();
    writeRemoteAccessStatus(cli.dir, relayStatus());
    await runConnectionsTermsCommand(['--accept'], cli.env, { now: () => NOW, fetchTerms: async () => { throw new Error('unused'); } });
    expect(readTermsAcceptance(dashboard.dir)).toEqual(readTermsAcceptance(cli.dir)!);
    expect(readTermsAcceptance(dashboard.dir)).toEqual({ terms_url: TERMS_V1, accepted_at: NOW.toISOString() });
    // And the CLI reads the dashboard's acceptance as its own.
    expect(await runConnectionsTermsCommand([], dashboard.env, { fetchTerms: async () => { throw new Error('unused'); } }))
      .toMatchObject({ url: TERMS_V1, accepted: true });
    // Once accepted, turning it on again needs no second acceptance.
    expect((await call(backend, { enabled: true })).status).toBe(200);
    expect(writes).toEqual([true, true]);
  });

  test('a changed agreement URL needs a new acceptance, and a stale acceptance is refused', async () => {
    const { dir } = home();
    writeRemoteAccessStatus(dir, relayStatus());
    const { backend, writes } = control(dir);
    expect((await call(backend, { enabled: true, accept_terms: { url: TERMS_V1 } })).status).toBe(200);

    // The CA publishes a new agreement; the relay reports it.
    writeRemoteAccessStatus(dir, relayStatus({ terms_url: TERMS_V2, certificate: { state: 'awaiting_terms', not_after: null, reason: null, retry_in_ms: null } }));
    const again = await call(backend, { enabled: true });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'terms_required' }, terms: { url: TERMS_V2 } });
    const stale = await call(backend, { enabled: true, accept_terms: { url: TERMS_V1 } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: 'terms_changed' }, terms: { url: TERMS_V2 } });
    expect(readTermsAcceptance(dir)?.terms_url).toBe(TERMS_V1);
    expect(writes).toEqual([true]);

    expect((await call(backend, { enabled: true, accept_terms: { url: TERMS_V2 } })).status).toBe(200);
    expect(readTermsAcceptance(dir)?.terms_url).toBe(TERMS_V2);
    expect(writes).toEqual([true, true]);
  });

  test('before the relay has run, the agreement comes from the CA directory; a CA with none is accepted against none', async () => {
    const fresh = home();
    const asked = control(fresh.dir);
    expect((await call(asked.backend, { enabled: true })).body).toMatchObject({ error: { code: 'terms_required' }, terms: { url: TERMS_V1 } });
    expect(asked.fetched).toHaveLength(1);

    const none = home();
    writeRemoteAccessStatus(none.dir, relayStatus({ terms_url: null, public_base_url: null, certificate: { state: 'awaiting_terms', not_after: null, reason: null, retry_in_ms: null } }));
    const noUrl = control(none.dir, { fetchTerms: async () => { throw new Error('must not substitute another agreement'); } });
    const shown = await call(noUrl.backend, { enabled: true });
    expect(shown.body).toMatchObject({ error: { code: 'terms_required' }, terms: { url: null, read_url: LETS_ENCRYPT_REPOSITORY_URL } });
    expect((await call(noUrl.backend, { enabled: true, accept_terms: { url: null } })).status).toBe(200);
    expect(readTermsAcceptance(none.dir)).toEqual({ terms_url: null, accepted_at: NOW.toISOString() });

    const offline = home();
    const unreadable = control(offline.dir, { fetchTerms: async () => { throw new Error('offline'); } });
    const failed = await call(unreadable.backend, { enabled: true });
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ error: { code: 'terms_unavailable' } });
    expect(unreadable.writes).toEqual([]);
  });

  test('turning off needs no agreement; malformed requests are refused', async () => {
    const { dir } = home();
    const { backend, writes } = control(dir);
    expect((await call(backend, { enabled: false })).status).toBe(200);
    expect(writes).toEqual([false]);
    for (const body of [{}, { enabled: 'yes' }, { enabled: false, accept_terms: { url: TERMS_V1 } }, { enabled: true, accept_terms: { url: 'http://insecure.test/terms' } },
      { enabled: true, accept_terms: {} }, { enabled: true, extra: 1 }]) {
      expect((await call(backend, body)).status).toBe(400);
    }
    expect(writes).toEqual([false]);
    expect(readTermsAcceptance(dir)).toBeUndefined();
    // The Gateway bridge validates the same shape before it reaches the worker.
    expect(parseDashboardControlParams({ action: 'set_remote_access', enabled: false })).toEqual({ action: 'set_remote_access', enabled: false });
    expect(parseDashboardControlParams({ action: 'set_remote_access', enabled: true, accept_terms: { url: null } }))
      .toEqual({ action: 'set_remote_access', enabled: true, accept_terms: { url: null } });
    expect(() => parseDashboardControlParams({ action: 'set_remote_access', enabled: false, accept_terms: { url: TERMS_V1 } })).toThrow();
    expect(() => parseDashboardControlParams({ action: 'set_remote_access', enabled: true, accept_terms: { url: 'http://x.test' } })).toThrow();
    expect(() => parseDashboardControlParams({ action: 'set_remote_access', enabled: true, relayHost: 'evil.test' })).toThrow();
  });
});

/** A stand-in for OpenClaw's `api.runtime.config`, over an in-memory config. */
function runtimeConfig(initial: Record<string, unknown>, options: { fail?: boolean } = {}) {
  let file = structuredClone(initial);
  const calls: Array<{ afterWrite: unknown }> = [];
  const writer: OpenClawRuntimeConfigWriter = {
    current: () => file,
    mutateConfigFile: async (params) => {
      calls.push({ afterWrite: params.afterWrite });
      if (options.fail) throw new Error('plugins.entries.olympus.config: secret sk-live-123 is invalid');
      const draft = structuredClone(file);
      params.mutate(draft);
      file = draft;
      return { followUp: { mode: 'auto' } };
    },
  };
  return { writer, calls, file: () => file };
}

describe('the config changes only through OpenClaw\'s config write', () => {
  const CONFIG = {
    gateway: { port: 18789 },
    plugins: {
      allow: ['olympus'],
      entries: {
        olympus: { enabled: true, config: { worker: { authToken: { source: 'exec', id: 'olympus/worker' } }, remote: { relayHost: 'connect.olympusplugin.ai' } } },
        other: { enabled: true },
      },
    },
  };

  const request = (runtime: OpenClawRuntimeConfigWriter | undefined, body: unknown, authorization: string | null = 'Bearer worker-secret', method = 'POST') =>
    handleRemoteAccessConfigRequest({ method, authorization, body: JSON.stringify(body), authToken: 'worker-secret', runtimeConfig: runtime });

  test('mutateConfigFile sets remote.enabled and nothing else, and lets the Gateway plan the reload', async () => {
    const runtime = runtimeConfig(CONFIG);
    const result = await request(runtime.writer, { enabled: true });
    expect(result).toEqual({ status: 200, body: { status: 'written', enabled: true, follow_up: 'auto' } });
    expect(runtime.calls).toEqual([{ afterWrite: { mode: 'auto' } }]);
    const expected = structuredClone(CONFIG) as any;
    expected.plugins.entries.olympus.config.remote.enabled = true;
    expect(runtime.file()).toEqual(expected);
    // Already on: nothing is written again.
    expect((await request(runtime.writer, { enabled: true })).body).toEqual({ status: 'unchanged', enabled: true });
    expect(runtime.calls).toHaveLength(1);
    expect((await request(runtime.writer, { enabled: false })).status).toBe(200);
    expected.plugins.entries.olympus.config.remote.enabled = false;
    expect(runtime.file()).toEqual(expected);
  });

  test('an entry with no remote block gets exactly the value openclaw config set would write', async () => {
    const runtime = runtimeConfig({ plugins: { entries: {} } });
    expect((await request(runtime.writer, { enabled: true })).status).toBe(200);
    expect(runtime.file()).toEqual({ plugins: { entries: { olympus: { config: { remote: { enabled: true } } } } } });
  });

  test('refuses anything but the worker bearer and exactly {enabled}', async () => {
    const runtime = runtimeConfig(CONFIG);
    expect((await request(runtime.writer, { enabled: true }, null)).status).toBe(401);
    expect((await request(runtime.writer, { enabled: true }, 'Bearer nope')).status).toBe(401);
    expect((await request(runtime.writer, { enabled: true }, 'Bearer worker-secret', 'GET')).status).toBe(405);
    for (const body of [{}, { enabled: 'true' }, { enabled: true, relayHost: 'evil.test' }, { enabled: true, publicBaseUrl: 'https://evil.test' }, [true]]) {
      expect((await request(runtime.writer, body)).status).toBe(400);
    }
    expect((await handleRemoteAccessConfigRequest({ method: 'POST', authorization: 'Bearer x', body: '{"enabled":true}', runtimeConfig: runtime.writer })).status).toBe(503);
    expect(runtime.calls).toEqual([]);
    expect(runtime.file()).toEqual(CONFIG);
  });

  test('an OpenClaw without mutateConfigFile is told plainly, with the CLI equivalent, and nothing else is tried', async () => {
    const result = await request({ current: () => CONFIG }, { enabled: true });
    expect(result.status).toBe(501);
    expect(result.body).toMatchObject({
      error_kind: 'config_write_unsupported',
      message: expect.stringContaining('openclaw config set plugins.entries.olympus.config.remote.enabled true'),
    });
    expect((await request(undefined, { enabled: false })).status).toBe(501);
  });

  test('a refused write reports a fixed message, never the config text', async () => {
    const runtime = runtimeConfig(CONFIG, { fail: true });
    const result = await request(runtime.writer, { enabled: true });
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('sk-live');
  });

  test('the worker reaches that route over loopback with its bearer, end to end', async () => {
    const runtime = runtimeConfig(CONFIG);
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const setEnabled = createGatewayRemoteAccessConfigWriter({
      authToken: 'worker-secret',
      env: {},
      gatewayConfig: { gateway: { port: 18789 } },
      fetchImpl: async (url, init) => {
        const headers = new Headers(init.headers);
        seen.push({ url, authorization: headers.get('Authorization') });
        const result = await handleRemoteAccessConfigRequest({
          method: init.method ?? '',
          authorization: headers.get('Authorization'),
          body: String(init.body),
          authToken: 'worker-secret',
          runtimeConfig: runtime.writer,
        });
        return new Response(JSON.stringify(result.body), { status: result.status });
      },
    });
    expect(await setEnabled(true)).toEqual({ ok: true });
    expect(seen).toEqual([{ url: `http://127.0.0.1:18789${REMOTE_ACCESS_CONFIG_ROUTE}`, authorization: 'Bearer worker-secret' }]);
    expect((runtime.file() as any).plugins.entries.olympus.config.remote.enabled).toBe(true);
    expect(await setEnabled(true)).toEqual({ ok: true, unchanged: true });

    const old = createGatewayRemoteAccessConfigWriter({
      authToken: 'worker-secret', env: {}, gatewayConfig: {},
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    expect(await old(true)).toMatchObject({ ok: false, status: 501, message: expect.stringContaining('Restart OpenClaw') });
    const down = createGatewayRemoteAccessConfigWriter({
      authToken: 'worker-secret', env: {}, gatewayConfig: {},
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(await down(false)).toMatchObject({ ok: false, code: 'openclaw_unreachable' });
  });

  test('no toggle module writes files or names openclaw.json', () => {
    for (const path of ['src/core/remote-access-config.ts', 'src/workers/remote-access-control.ts', 'src/workers/agent-connections.ts']) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source).not.toMatch(/from 'node:fs'|writeFile|appendFile|openclaw\.json['`]/);
    }
  });
});

describe('remote access that is on but not reachable', () => {
  const live = parseRemotePublicBaseUrl(PUBLIC);
  const view = (file: RemoteAccessStatusFile) => {
    const { dir } = home();
    return remoteAccessStatusView({
      dir,
      status: file,
      urls: { public_base_url: file.public_base_url, public_base_url_source: 'relay', mcp_url: `${PUBLIC}/mcp`, openapi_url: `${PUBLIC}/openapi.json`, oauth_issuer: PUBLIC, local_url: 'http://127.0.0.1:28190' },
      isAlive: () => true,
    });
  };

  test('an outage keeps the address but reads not connected with its reason, and mints no pairing code', async () => {
    const outage = relayStatus({ relay: { state: 'offline', reason: 'connect ECONNREFUSED 203.0.113.9:443', retry_in_ms: 30_000 } });
    // The relay child keeps the served address through an outage.
    expect(outage.public_base_url).toBe(PUBLIC);
    const access = remoteAccessFromStatus({ live: live.enabled ? live.urls : undefined, status: view(outage) });
    expect(access).toEqual({
      state: 'not_connected',
      detail: 'Olympus relay unavailable, so agents in the cloud cannot reach Olympus right now. Olympus keeps trying on its own.',
    });
    const html = renderDashboardAgentsSection({ view: { remoteAccess: access, connections: [] }, now: NOW });
    expect(html).toContain('data-remote-access="not_connected"');
    expect(html).toContain('Olympus relay unavailable');
    expect(html).not.toContain('data-agent-kind="pair"');
    expect(html).toContain('Turn off remote access');

    const backend: DashboardAgentConnectionsBackend = { store: () => { throw new Error('must not open the store'); }, remoteAccess: () => access };
    const response = (await handleDashboardAgentRequest(post('/dashboard/agents/pairing-code', {}, {}), '/dashboard/agents/pairing-code', backend))!;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'remote_access_off', message: expect.stringContaining('Olympus relay unavailable') } });

    // Back online: on again, at the same address.
    expect(remoteAccessFromStatus({ live: live.enabled ? live.urls : undefined, status: view(relayStatus()) }))
      .toEqual({ state: 'on', mcpUrl: `${PUBLIC}/mcp`, openapiUrl: `${PUBLIC}/openapi.json` });
  });

  test('the relay that is not deployed yet reads "Olympus relay unavailable", in the CLI status and the panel', () => {
    const notDeployed = relayStatus({
      public_base_url: null,
      install_id: null,
      hostname: null,
      relay: { state: 'offline', reason: 'getaddrinfo ENOTFOUND relay.connect.olympusplugin.ai', retry_in_ms: 16_000 },
      certificate: { state: 'none', not_after: null, reason: null, retry_in_ms: null },
    });
    const status = view(notDeployed);
    expect(status.next_step).toContain('Olympus relay unavailable (getaddrinfo ENOTFOUND relay.connect.olympusplugin.ai)');
    expect(remoteAccessFromStatus({ live: undefined, status })).toMatchObject({ state: 'not_connected', detail: expect.stringContaining('Olympus relay unavailable') });
  });

  test('awaiting the agreement offers Review agreement beside Turn off', () => {
    const awaiting = relayStatus({ public_base_url: null, certificate: { state: 'awaiting_terms', not_after: null, reason: null, retry_in_ms: null } });
    const access = remoteAccessFromStatus({ live: undefined, status: view(awaiting) });
    expect(access).toMatchObject({ state: 'not_connected', needsTerms: true });
    const doc = new Window().document;
    doc.body.innerHTML = renderDashboardAgentsSection({ view: { remoteAccess: access, connections: [] }, now: NOW });
    expect(doc.querySelector('form[data-agent-kind="remote-on"]')!.textContent).toBe('Review agreement');
    expect(doc.querySelector('form[data-agent-kind="remote-off"]')).not.toBeNull();
    expect(doc.querySelector('[data-remote-terms]')!.hasAttribute('hidden')).toBe(true);
  });
});

describe('the panel renders the toggle', () => {
  const render = (remoteAccess: DashboardRemoteAccess) => {
    const doc = new Window().document;
    doc.body.innerHTML = renderDashboardAgentsSection({ view: { remoteAccess, connections: [] }, now: NOW });
    return doc;
  };

  test('off offers one Turn on button and a hidden agreement panel with a link and a plain summary', () => {
    const doc = render({ state: 'off' });
    const row = doc.querySelector('[data-remote-access="off"]')!;
    expect(row.querySelector('form[data-agent-kind="remote-on"] button')!.textContent).toBe('Turn on remote access');
    expect(row.querySelector('form[data-agent-kind="remote-off"]')).toBeNull();
    const panel = doc.querySelector('[data-remote-terms]')!;
    expect(panel.hasAttribute('hidden')).toBe(true);
    const link = panel.querySelector('[data-remote-terms-link]')!;
    expect(link.getAttribute('href')).toBe(LETS_ENCRYPT_REPOSITORY_URL);
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(panel.textContent).toContain('Subscriber Agreement');
    expect(panel.textContent).toContain('This is a summary, not the agreement');
    expect(panel.querySelector('form[data-agent-kind="remote-accept"]')).not.toBeNull();
  });

  test('on and invalid offer Turn off, with a confirmation, and no agreement panel', () => {
    for (const access of [
      { state: 'on', mcpUrl: `${PUBLIC}/mcp`, openapiUrl: `${PUBLIC}/openapi.json` },
      { state: 'invalid', detail: 'remote.relayHost and remote.publicBaseUrl are mutually exclusive' },
    ] as DashboardRemoteAccess[]) {
      const doc = render(access);
      const off = doc.querySelector('form[data-agent-kind="remote-off"]')!;
      expect(off.getAttribute('data-confirmation')).toContain('Turn off remote access?');
      expect(doc.querySelector('form[data-agent-kind="remote-on"]')).toBeNull();
      expect(doc.querySelector('[data-remote-terms]')).toBeNull();
    }
  });
});

describe('the controller shows the agreement before turning on', () => {
  const GLOBALS = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement',
    'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS'] as const;
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

  function mount(remoteAccess: DashboardRemoteAccess, control: (params: OlympusDashboardControlParams) => Promise<OlympusDashboardControlResult>) {
    const root = document.createElement('div');
    root.innerHTML = renderDashboardAgentsSection({ view: { remoteAccess, connections: [] }, now: NOW });
    document.body.append(root);
    const abort = new AbortController();
    let refreshes = 0;
    const controller = mountDashboardController({
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
    return { root, controller, refreshes: () => refreshes };
  }

  const settle = async () => { for (let tick = 0; tick < 5; tick++) await Bun.sleep(0); };

  test('Turn on opens the agreement; only I accept sends an acceptance, bound to the URL shown', async () => {
    const calls: OlympusDashboardControlParams[] = [];
    const { root, controller, refreshes } = mount({ state: 'off' }, async (params) => {
      calls.push(params);
      if (params.action === 'set_remote_access' && !params.accept_terms) {
        return { status: 409, body: { ok: false, error: { code: 'terms_required', message: 'Read it first.' }, terms: { url: TERMS_V2, read_url: TERMS_V2 } } };
      }
      return { status: 200, body: { ok: true, enabled: true, status_message: 'Remote access is turning on.' } };
    });
    const panel = root.querySelector<HTMLElement>('[data-remote-terms]')!;
    root.querySelector<HTMLFormElement>('form[data-agent-kind="remote-on"]')!.requestSubmit();
    await settle();
    expect(calls).toEqual([{ action: 'set_remote_access', enabled: true }]);
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector<HTMLAnchorElement>('[data-remote-terms-link]')!.href).toBe(TERMS_V2);

    // While the owner reads, the poll does not replace the page under them.
    await controller.refresh();
    expect(refreshes()).toBe(0);

    panel.querySelector<HTMLFormElement>('form[data-agent-kind="remote-accept"]')!.requestSubmit();
    await settle();
    expect(calls[1]).toEqual({ action: 'set_remote_access', enabled: true, accept_terms: { url: TERMS_V2 } });
    expect(panel.hidden).toBe(true);
    expect(root.querySelector('[data-remote-access] [data-action-message]')!.textContent).toBe('Remote access is turning on.');
  });

  test('Not now closes the agreement and sends nothing; an accept form never shown sends nothing', async () => {
    const calls: OlympusDashboardControlParams[] = [];
    const { root } = mount({ state: 'off' }, async (params) => {
      calls.push(params);
      return { status: 409, body: { ok: false, error: { code: 'terms_required', message: 'Read it first.' }, terms: { url: TERMS_V1, read_url: TERMS_V1 } } };
    });
    const panel = root.querySelector<HTMLElement>('[data-remote-terms]')!;
    panel.querySelector<HTMLFormElement>('form[data-agent-kind="remote-accept"]')!.requestSubmit();
    await settle();
    expect(calls).toEqual([]);
    root.querySelector<HTMLFormElement>('form[data-agent-kind="remote-on"]')!.requestSubmit();
    await settle();
    expect(panel.hidden).toBe(false);
    panel.querySelector<HTMLElement>('[data-remote-terms-cancel]')!.click();
    expect(panel.hidden).toBe(true);
    panel.querySelector<HTMLFormElement>('form[data-agent-kind="remote-accept"]')!.requestSubmit();
    await settle();
    expect(calls).toHaveLength(1);
  });

  test('a changed agreement is shown again instead of being accepted', async () => {
    const calls: OlympusDashboardControlParams[] = [];
    const { root } = mount({ state: 'off' }, async (params) => {
      calls.push(params);
      const accepted = params.action === 'set_remote_access' ? params.accept_terms?.url : undefined;
      if (accepted === undefined) {
        return { status: 409, body: { ok: false, error: { code: 'terms_required', message: 'Read it first.' }, terms: { url: TERMS_V1, read_url: TERMS_V1 } } };
      }
      return { status: 409, body: { ok: false, error: { code: 'terms_changed', message: 'Let\'s Encrypt has published a new subscriber agreement.' }, terms: { url: TERMS_V2, read_url: TERMS_V2 } } };
    });
    const panel = root.querySelector<HTMLElement>('[data-remote-terms]')!;
    root.querySelector<HTMLFormElement>('form[data-agent-kind="remote-on"]')!.requestSubmit();
    await settle();
    const accept = panel.querySelector<HTMLFormElement>('form[data-agent-kind="remote-accept"]')!;
    accept.requestSubmit();
    await settle();
    expect(calls[1]).toEqual({ action: 'set_remote_access', enabled: true, accept_terms: { url: TERMS_V1 } });
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector<HTMLAnchorElement>('[data-remote-terms-link]')!.href).toBe(TERMS_V2);
    expect(accept.querySelector('[data-action-message]')!.textContent).toContain('new subscriber agreement');
    accept.requestSubmit();
    await settle();
    expect(calls[2]).toEqual({ action: 'set_remote_access', enabled: true, accept_terms: { url: TERMS_V2 } });
  });

  test('Turn off asks first, and does nothing when declined', async () => {
    const calls: OlympusDashboardControlParams[] = [];
    const { root } = mount({ state: 'on', mcpUrl: `${PUBLIC}/mcp`, openapiUrl: `${PUBLIC}/openapi.json` }, async (params) => {
      calls.push(params);
      return { status: 200, body: { ok: true, enabled: false, status_message: 'Remote access is off.' } };
    });
    const form = root.querySelector<HTMLFormElement>('form[data-agent-kind="remote-off"]')!;
    let answer = false;
    (happy as unknown as { confirm: () => boolean }).confirm = () => answer;
    form.requestSubmit();
    await settle();
    expect(calls).toEqual([]);
    answer = true;
    form.requestSubmit();
    await settle();
    expect(calls).toEqual([{ action: 'set_remote_access', enabled: false }]);
    expect(form.querySelector('[data-action-message]')!.textContent).toBe('Remote access is off.');
  });
});

describe('a public address set in worker.env', () => {
  const live = parseRemotePublicBaseUrl('https://my-tunnel.example');
  const envAccess = remoteAccessFromStatus({ live: live.enabled ? live.urls : undefined, status: undefined, liveOrigin: 'env' });

  test('is on, set by worker.env, from either the worker origin or the status source', () => {
    expect(envAccess).toEqual({
      state: 'on',
      mcpUrl: 'https://my-tunnel.example/mcp',
      openapiUrl: 'https://my-tunnel.example/openapi.json',
      setBy: 'worker_env',
    });
    const viaStatus = remoteAccessFromStatus({
      live: live.enabled ? live.urls : undefined,
      status: { error: null, mode: 'off', remote_enabled: true, next_step: null, public_base_url_source: 'worker_env' },
    });
    expect(viaStatus).toMatchObject({ state: 'on', setBy: 'worker_env' });
  });

  test('offers no Turn off; says where the address comes from and how to remove it', () => {
    const doc = new Window().document;
    doc.body.innerHTML = renderDashboardAgentsSection({ view: { remoteAccess: envAccess, connections: [] }, now: NOW });
    expect(doc.querySelector('form[data-agent-kind="remote-off"]')).toBeNull();
    expect(doc.querySelector('form[data-agent-kind="remote-on"]')).toBeNull();
    const hint = doc.querySelector('[data-remote-set-by="worker_env"]')!.textContent!;
    expect(hint).toContain('set by OLYMPUS_PUBLIC_BASE_URL in worker.env');
    expect(hint).toContain('delete that line from ~/.config/olympus/worker.env');
    expect(hint).toContain('openclaw gateway restart');
  });

  test('the route refuses to toggle it and writes nothing', async () => {
    const { dir } = home();
    writeRemoteAccessStatus(dir, relayStatus());
    recordTermsAcceptance(dir, TERMS_V1);
    const { backend, writes } = control(dir);
    const envBackend = { ...backend, remoteAccess: () => envAccess };
    for (const body of [{ enabled: false }, { enabled: true }]) {
      const refused = await call(envBackend, body);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ ok: false, error: { code: 'set_by_worker_env', message: expect.stringContaining('OLYMPUS_PUBLIC_BASE_URL') } });
    }
    expect(writes).toEqual([]);
  });
});

describe('Turn off reports off only when nothing is still reachable', () => {
  const REMOTE_ON: DashboardRemoteAccess = { state: 'on', mcpUrl: `${PUBLIC}/mcp`, openapiUrl: `${PUBLIC}/openapi.json` };

  test('an unchanged write while an address is still up is not reported as off', async () => {
    const { dir } = home();
    const { backend, writes } = control(dir, { write: { ok: true, unchanged: true } });
    const stillOn = { ...backend, remoteAccess: () => REMOTE_ON };
    const result = await call(stillOn, { enabled: false });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ ok: false, error: { code: 'remote_access_still_reachable', message: expect.stringContaining('abc123.connect.olympusplugin.ai') } });
    expect(JSON.stringify(result.body)).not.toContain('Remote access is off');
    expect(writes).toEqual([false]);
  });

  test('an unchanged write with nothing up says off; a real write says turning off', async () => {
    const { dir } = home();
    const unchanged = control(dir, { write: { ok: true, unchanged: true } });
    expect((await call(unchanged.backend, { enabled: false })).body).toMatchObject({ ok: true, status_message: expect.stringMatching(/^Remote access is off\./) });
    const written = control(dir);
    const on = { ...written.backend, remoteAccess: () => REMOTE_ON };
    expect((await call(on, { enabled: false })).body).toMatchObject({ ok: true, status_message: expect.stringMatching(/^Remote access is turning off\./) });
  });
});

test('the agreement summary does not claim there is no account', () => {
  const html = renderDashboardAgentsSection({ view: { remoteAccess: { state: 'off' }, connections: [] }, now: NOW });
  expect(html).toContain('You don\'t sign up for anything or share an email address.');
  expect(html).not.toContain('create no account');
});
