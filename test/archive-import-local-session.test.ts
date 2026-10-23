// Choosing (the picker's listing of this computer's folders), importing,
// declining and removing an archive are the person's, at this
// computer's own dashboard: a local-grade control session alone (workers/
// http.ts), the grade Outside help and Private answers already take. The
// worker bearer is not enough (an agent or the Gateway holds it), nor a
// session the bearer or its launch ticket minted, nor a local mint that
// presents any bearer; the panel's tool path and the worker route refuse
// the same calls; the computer's host page opens the local session before
// the first such tool. Full sequences against the real boundary.

import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { DASHBOARD_LAUNCH_MINT_PATH, DASHBOARD_LAUNCH_REDEEM_PATH, DashboardLaunchTickets } from '../src/core/dashboard-launch.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import {
  ARCHIVE_APPROVE_TOOL_NAME,
  ARCHIVE_BROWSE_TOOL_NAME,
  ARCHIVE_DECLINE_TOOL_NAME,
  ARCHIVE_REMOVE_TOOL_NAME,
  COMPUTER_LOCAL_SESSION_TOOL_NAMES,
  DASHBOARD_TOOL_NAME,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import type { ArchiveImportDashboard } from '../src/workers/archive-import/dashboard.ts';
import { renderComputerHostPage } from '../src/workers/dashboard/host-page.ts';
import { createDashboardPanelTools } from '../src/workers/email-source/dashboard-panel-tools.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  DASHBOARD_ARCHIVE_IMPORT_LOCAL_PATHS,
  DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER,
  DASHBOARD_LOCAL_CONTROL_SESSION_PATH,
  withWorkerBearerAuth,
} from '../src/workers/http.ts';

const TOKEN = 'archive-boundary-worker-secret';
const ORIGIN = 'http://127.0.0.1:28191';
const ARCHIVE_ID = '6a1f0e2d-4c3b-4a59-8e7d-1b2c3d4e5f60';
const REQUEST_ID = '8c3b2a1f-6e5d-4c7b-8a9f-3d4e5f6a7b82';

const windows: Window[] = [];
afterEach(async () => {
  while (windows.length) await windows.pop()!.happyDOM.close();
});
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** The dashboard side, recording what reached it. */
function archives() {
  const reached: string[] = [];
  const dashboard: ArchiveImportDashboard = {
    async browse() { reached.push('browse'); return { nodes: [] }; },
    async approve() { reached.push('approve'); return { ok: true, status: 'started', archive_id: ARCHIVE_ID, name: 'Takeout.mbox' }; },
    decline() { reached.push('decline'); return { ok: true }; },
    remove() { reached.push('remove'); return { ok: true }; },
    approveRemoval() { reached.push('remove'); return { ok: true }; },
    // The agent's side only records requests (archive-import-agent.test.ts); nothing here reaches it.
    agent: {} as ArchiveImportDashboard['agent'],
    view: () => ({ sourceId: 'archive.imports', privateModel: 'ready', archives: [], requests: [] }),
    present: () => ({ archives: 0, importing: false }),
    resume() {},
    idle: () => Promise.resolve(),
    close() {},
  };
  return { dashboard, reached };
}

function fixture() {
  let clock = Date.parse('2026-10-23T12:00:00.000Z');
  const { dashboard, reached } = archives();
  const worker = createEmailSourceWorker({
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      archiveImports: dashboard,
    },
  });
  const fetch = withWorkerBearerAuth((request: Request) => worker.fetch(request), {
    authToken: TOKEN,
    now: () => clock,
    launchTickets: new DashboardLaunchTickets({ now: () => clock }),
  });
  return { fetch, worker, reached, advance: (ms: number) => { clock += ms; } };
}

function cookieOf(response: Response): string {
  const cookie = (response.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
  if (!cookie.startsWith('olympus_dashboard_control=')) throw new Error('no control cookie');
  return cookie;
}

const BODIES: Record<string, unknown> = {
  '/dashboard/archive-import/browse': { parent_key: '/Users/someone' },
  '/dashboard/archive-import/approve': { key: '/Users/someone/Mail exports/Takeout.mbox' },
  '/dashboard/archive-import/decline': { request_id: REQUEST_ID },
  '/dashboard/archive-import/remove': { archive_id: ARCHIVE_ID, acknowledge: true },
};

function post(path: string, headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: JSON.stringify(BODIES[path] ?? {}),
  });
}

async function bearerSession(f: ReturnType<typeof fixture>) {
  const mint = await f.fetch(new Request(`${ORIGIN}/dashboard/control/session`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } }));
  expect(mint.status).toBe(200);
  return { Cookie: cookieOf(mint), 'X-Olympus-CSRF': ((await mint.json()) as { csrf_token: string }).csrf_token };
}

async function launchSession(f: ReturnType<typeof fixture>) {
  const mint = await f.fetch(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_MINT_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } }));
  const { ticket } = (await mint.json()) as { ticket: string };
  const redeemed = await f.fetch(new Request(`${ORIGIN}${DASHBOARD_LAUNCH_REDEEM_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ ticket }),
  }));
  expect(redeemed.status).toBe(200);
  return { Cookie: cookieOf(redeemed), 'X-Olympus-CSRF': ((await redeemed.json()) as { csrf_token: string }).csrf_token };
}

/** The local mint as this computer's browser makes it: same origin, a loopback socket peer, no bearer. */
async function localMint(f: ReturnType<typeof fixture>, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: ORIGIN, ...headers } });
  recordRequestPeer(request, '127.0.0.1');
  return f.fetch(request);
}

async function localSession(f: ReturnType<typeof fixture>) {
  const mint = await localMint(f);
  expect(mint.status).toBe(200);
  return { Cookie: cookieOf(mint), 'X-Olympus-CSRF': ((await mint.json()) as { csrf_token: string }).csrf_token };
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = await response.json().catch(() => undefined) as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

describe('approving, declining and removing an archive take this computer\'s own session', () => {
  test('the worker bearer alone, with a session cookie, or with a forged grade header: refused on every route, nothing reached', async () => {
    const f = fixture();
    const session = await bearerSession(f);
    expect([...DASHBOARD_ARCHIVE_IMPORT_LOCAL_PATHS].sort()).toEqual(Object.keys(BODIES).sort());
    for (const path of DASHBOARD_ARCHIVE_IMPORT_LOCAL_PATHS) {
      const bare = await f.fetch(post(path, { Authorization: `Bearer ${TOKEN}` }));
      expect(bare.status).toBe(403);
      expect(await errorCode(bare)).toBe('mac_dashboard_only');
      expect((await f.fetch(post(path, { Authorization: `Bearer ${TOKEN}`, ...session }))).status).toBe(403);
      expect((await f.fetch(post(path, { Authorization: `Bearer ${TOKEN}`, [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local' }))).status).toBe(403);
    }
    expect(f.reached).toEqual([]);
  });

  test('a session the bearer minted, or its launch ticket redeemed, is refused, the picker\'s listing included', async () => {
    const f = fixture();
    expect(DASHBOARD_ARCHIVE_IMPORT_LOCAL_PATHS).toContain('/dashboard/archive-import/browse');
    for (const session of [await bearerSession(f), await launchSession(f)]) {
      for (const path of DASHBOARD_ARCHIVE_IMPORT_LOCAL_PATHS) {
        const refused = await f.fetch(post(path, session));
        expect(refused.status).toBe(403);
        expect(await errorCode(refused)).toBe('mac_dashboard_only');
      }
    }
    expect(f.reached).toEqual([]);
  });

  test('an agent cannot mint the local session for itself: not with the bearer, not through a proxy, not as another bearer', async () => {
    const f = fixture();
    expect((await localMint(f, { Authorization: `Bearer ${TOKEN}` })).status).toBe(403);
    expect((await localMint(f, { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(403);
    const remote = new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: ORIGIN } });
    recordRequestPeer(remote, '203.0.113.9');
    expect((await f.fetch(remote)).status).toBe(403);
    // A key minted for a connected agent is not the worker bearer here.
    for (const path of DASHBOARD_ARCHIVE_IMPORT_LOCAL_PATHS) {
      expect((await f.fetch(post(path, { Authorization: 'Bearer olympus_agent_key_for_a_connected_agent' }))).status).toBe(401);
    }
    expect(f.reached).toEqual([]);
  });

  test('a local session from this computer\'s browser reaches each route', async () => {
    const f = fixture();
    const session = await localSession(f);
    for (const path of DASHBOARD_ARCHIVE_IMPORT_LOCAL_PATHS) {
      const allowed = await f.fetch(post(path, session));
      expect(allowed.status).toBe(200);
    }
    expect(f.reached).toEqual(['browse', 'approve', 'decline', 'remove']);
  });

  test('the worker route itself refuses a call that carries no local grade (an in-process caller)', async () => {
    const f = fixture();
    for (const path of DASHBOARD_ARCHIVE_IMPORT_LOCAL_PATHS) {
      const direct = await f.worker.fetch(post(path, {}));
      expect(direct.status).toBe(403);
      expect(await errorCode(direct)).toBe('mac_dashboard_only');
    }
    expect(f.reached).toEqual([]);
  });
});

describe('the panel\'s archive tools', () => {
  function panel() {
    const seen: Array<{ path: string; grade: string | null }> = [];
    const tools = createDashboardPanelTools({
      workerFetch: async (request: Request) => {
        seen.push({ path: new URL(request.url).pathname, grade: request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) });
        const path = new URL(request.url).pathname;
        return Response.json(path.endsWith('/approve')
          ? { ok: true, status: 'started', archive_id: ARCHIVE_ID, name: 'Takeout.mbox' }
          : path.endsWith('/browse') ? { ok: true, nodes: [] } : { ok: true });
      },
    } as unknown as Parameters<typeof createDashboardPanelTools>[0]);
    return { tools, seen };
  }
  const calls: Array<[string, Record<string, unknown>]> = [
    [ARCHIVE_BROWSE_TOOL_NAME, { parent_key: '/Users/someone' }],
    [ARCHIVE_APPROVE_TOOL_NAME, { key: '/Users/someone/Mail exports/Takeout.mbox' }],
    [ARCHIVE_DECLINE_TOOL_NAME, { request_id: REQUEST_ID }],
    [ARCHIVE_REMOVE_TOOL_NAME, { archive_id: ARCHIVE_ID }],
  ];

  test('through /dashboard/tools/call with the bearer (the OpenClaw tab) or a bearer\'s session: refused, nothing sent', async () => {
    const { tools, seen } = panel();
    expect([...COMPUTER_LOCAL_SESSION_TOOL_NAMES].sort()).toEqual(calls.map(([name]) => name).sort());
    for (const [name, args] of calls) {
      const result = await tools.call(name, args, { origin: ORIGIN });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: 'mac_dashboard_only' });
    }
    expect(seen).toEqual([]);
  });

  test('with this computer\'s own session: each runs, and carries the grade to the route', async () => {
    const { tools, seen } = panel();
    for (const [name, args] of calls) {
      expect((await tools.call(name, args, { origin: ORIGIN, localSession: true })).isError).toBeUndefined();
    }
    expect(seen).toEqual([
      { path: '/dashboard/archive-import/browse', grade: 'local' },
      { path: '/dashboard/archive-import/approve', grade: 'local' },
      { path: '/dashboard/archive-import/decline', grade: 'local' },
      { path: '/dashboard/archive-import/remove', grade: 'local' },
    ]);
  });
});

describe('the computer\'s host page', () => {
  function hostPage(localSession: boolean, unlock: 'ok' | 'refused' = 'ok') {
    const html = renderComputerHostPage({ panelHtml: '<p></p>', origin: ORIGIN, csrfToken: 'bearer-csrf', ...(localSession ? { localSession: true } : {}) });
    const start = html.indexOf('<script>') + '<script>'.length;
    const script = html.slice(start, html.indexOf('</script>', start));
    const win = new Window({ url: `${ORIGIN}/dashboard`, settings: { disableIframePageLoading: true } });
    windows.push(win);
    win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
    const frame = win.document.getElementById('olympus-panel')!;
    const received: Array<Record<string, any>> = [];
    const child = { postMessage: (message: Record<string, any>) => received.push(message) };
    Object.defineProperty(frame, 'contentWindow', { configurable: true, get: () => child });
    const fetched: Array<{ url: string; csrf?: string; tool?: string; authorization?: string }> = [];
    const fakeFetch = async (url: string, init: RequestInit = {}) => {
      if (url === '/v1/health') return Response.json({});
      const headers = (init.headers ?? {}) as Record<string, string>;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as { name?: string } : {};
      fetched.push({
        url,
        ...(headers['X-Olympus-CSRF'] ? { csrf: headers['X-Olympus-CSRF'] } : {}),
        ...(body.name ? { tool: body.name } : {}),
        ...(headers.Authorization ? { authorization: headers.Authorization } : {}),
      });
      if (url === DASHBOARD_LOCAL_CONTROL_SESSION_PATH) {
        return unlock === 'ok' ? Response.json({ ok: true, csrf_token: 'local-csrf' }) : new Response('{}', { status: 403 });
      }
      return Response.json({ structuredContent: { ok: true } });
    };
    const fakeWindow = {
      setInterval: win.setInterval.bind(win),
      location: { hash: '', pathname: '/dashboard', search: '', href: `${ORIGIN}/dashboard`, origin: ORIGIN, assign: () => undefined, reload: () => undefined },
      history: { replaceState: () => undefined },
      open: () => null,
    };
    new Function('window', 'document', 'fetch', 'navigator', script)(fakeWindow, win.document, fakeFetch, win.navigator);
    const send = (message: Record<string, unknown>) => win.dispatchEvent(new win.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: child as any }));
    return { fetched, received, send };
  }

  test('a launch-link session opens the local session (no bearer) before the picker first lists, then uses it', async () => {
    const page = hostPage(false);
    page.send({ id: 1, method: 'tools/call', params: { name: DASHBOARD_TOOL_NAME, arguments: {} } });
    await settle();
    page.send({ id: 2, method: 'tools/call', params: { name: ARCHIVE_BROWSE_TOOL_NAME, arguments: {} } });
    await settle();
    page.send({ id: 3, method: 'tools/call', params: { name: ARCHIVE_APPROVE_TOOL_NAME, arguments: { key: '/x/Takeout.mbox' } } });
    await settle();
    page.send({ id: 4, method: 'tools/call', params: { name: ARCHIVE_REMOVE_TOOL_NAME, arguments: { archive_id: ARCHIVE_ID } } });
    await settle();
    expect(page.fetched.map(({ url, csrf, tool, authorization }) => ({ url, csrf, tool, authorization }))).toEqual([
      { url: '/dashboard/tools/call', csrf: 'bearer-csrf', tool: DASHBOARD_TOOL_NAME, authorization: undefined },
      { url: DASHBOARD_LOCAL_CONTROL_SESSION_PATH, csrf: undefined, tool: undefined, authorization: undefined },
      { url: '/dashboard/tools/call', csrf: 'local-csrf', tool: ARCHIVE_BROWSE_TOOL_NAME, authorization: undefined },
      { url: '/dashboard/tools/call', csrf: 'local-csrf', tool: ARCHIVE_APPROVE_TOOL_NAME, authorization: undefined },
      { url: '/dashboard/tools/call', csrf: 'local-csrf', tool: ARCHIVE_REMOVE_TOOL_NAME, authorization: undefined },
    ]);
    expect(page.received.find((message) => message.id === 2)!.result).toEqual({ structuredContent: { ok: true } });
  });

  test('a local session already open asks for nothing more; a refused unlock still sends the call, which the tool refuses itself', async () => {
    const local = hostPage(true);
    local.send({ id: 1, method: 'tools/call', params: { name: ARCHIVE_APPROVE_TOOL_NAME, arguments: { key: '/x/Takeout.mbox' } } });
    await settle();
    expect(local.fetched.map((entry) => entry.url)).toEqual(['/dashboard/tools/call']);
    const refused = hostPage(false, 'refused');
    refused.send({ id: 1, method: 'tools/call', params: { name: ARCHIVE_DECLINE_TOOL_NAME, arguments: { request_id: REQUEST_ID } } });
    await settle();
    expect(refused.fetched.map((entry) => [entry.url, entry.csrf])).toEqual([
      [DASHBOARD_LOCAL_CONTROL_SESSION_PATH, undefined],
      ['/dashboard/tools/call', 'bearer-csrf'],
    ]);
  });
});
