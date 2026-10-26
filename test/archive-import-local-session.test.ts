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
  ARCHIVE_DECLINE_TOOL_NAME,
  ARCHIVE_REMOVE_TOOL_NAME,
  ARCHIVE_STOP_TOOL_NAME,
  ARCHIVE_UPLOAD_CANCEL_TOOL_NAME,
  ARCHIVE_UPLOAD_START_TOOL_NAME,
  ARCHIVE_UPLOAD_STATUS_TOOL_NAME,
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
const UPLOAD_ID = '5d4c3b2a1f0e4d9c8b7a6f5e4d3c2b1a';

const windows: Window[] = [];
afterEach(async () => {
  while (windows.length) await windows.pop()!.happyDOM.close();
});
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** The dashboard side, recording what reached it. */
function archives() {
  const reached: string[] = [];
  const dashboard: ArchiveImportDashboard = {
    upload: {
      start() { reached.push('upload-start'); return { uploadId: UPLOAD_ID }; },
      async receive(_uploadId, _path, body) { reached.push('upload-file'); await new Response(body).arrayBuffer(); return { bytes: 1 }; },
      status() { reached.push('upload-status'); return { state: 'idle', files: 0, bytes: 0 }; },
      cancel() { reached.push('upload-cancel'); return { cancelled: true }; },
    },
    async approve() { reached.push('approve'); return { ok: true, status: 'started', archive_id: ARCHIVE_ID, name: 'Takeout.mbox' }; },
    decline() { reached.push('decline'); return { ok: true }; },
    remove() { reached.push('remove'); return { ok: true }; },
    stop() { reached.push('stop'); return { ok: true }; },
    sourceImports: () => [],
    archiveSources: () => [],
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
  '/dashboard/archive-import/upload-start': {},
  // The file's own bytes are the body of this one (post() below); the JSON here is never read.
  '/dashboard/archive-import/upload-file': {},
  '/dashboard/archive-import/upload-status': { upload_id: UPLOAD_ID },
  '/dashboard/archive-import/upload-cancel': { upload_id: UPLOAD_ID },
  '/dashboard/archive-import/approve': { upload_id: UPLOAD_ID },
  '/dashboard/archive-import/decline': { request_id: REQUEST_ID },
  '/dashboard/archive-import/remove': { archive_id: ARCHIVE_ID, acknowledge: true },
  '/dashboard/archive-import/stop': { archive_id: ARCHIVE_ID },
};

function post(path: string, headers: Record<string, string>): Request {
  // One file of an upload is its own bytes, with its place under the dropped folder in a header.
  if (path === '/dashboard/archive-import/upload-file') {
    return new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Origin: ORIGIN, 'X-Olympus-Upload-Id': UPLOAD_ID, 'X-Olympus-Upload-Path': encodeURIComponent('Export/a.json'), ...headers },
      body: 'the file',
    });
  }
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

  test('a session the bearer minted, or its launch ticket redeemed, is refused, an upload included', async () => {
    const f = fixture();
    expect(DASHBOARD_ARCHIVE_IMPORT_LOCAL_PATHS).toContain('/dashboard/archive-import/upload-file');
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
    expect(f.reached).toEqual(['upload-start', 'upload-file', 'upload-status', 'upload-cancel', 'approve', 'decline', 'remove', 'stop']);
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
          : path.endsWith('/upload-start') ? { ok: true, upload_id: UPLOAD_ID }
            : path.endsWith('/upload-status') ? { ok: true, state: 'receiving', files: 1, bytes: 5 } : { ok: true });
      },
    } as unknown as Parameters<typeof createDashboardPanelTools>[0]);
    return { tools, seen };
  }
  const calls: Array<[string, Record<string, unknown>]> = [
    [ARCHIVE_UPLOAD_START_TOOL_NAME, {}],
    [ARCHIVE_UPLOAD_STATUS_TOOL_NAME, { upload_id: UPLOAD_ID }],
    [ARCHIVE_UPLOAD_CANCEL_TOOL_NAME, { upload_id: UPLOAD_ID }],
    [ARCHIVE_APPROVE_TOOL_NAME, { upload_id: UPLOAD_ID }],
    [ARCHIVE_DECLINE_TOOL_NAME, { request_id: REQUEST_ID }],
    [ARCHIVE_REMOVE_TOOL_NAME, { archive_id: ARCHIVE_ID }],
    [ARCHIVE_STOP_TOOL_NAME, { archive_id: ARCHIVE_ID }],
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
      { path: '/dashboard/archive-import/upload-start', grade: 'local' },
      { path: '/dashboard/archive-import/upload-status', grade: 'local' },
      { path: '/dashboard/archive-import/upload-cancel', grade: 'local' },
      { path: '/dashboard/archive-import/approve', grade: 'local' },
      { path: '/dashboard/archive-import/decline', grade: 'local' },
      { path: '/dashboard/archive-import/remove', grade: 'local' },
      { path: '/dashboard/archive-import/stop', grade: 'local' },
    ]);
  });
});

describe('a source\'s own Import an archive names its card', () => {
  test('the panel forwards source_id with an upload, and refuses it alone or with a request', async () => {
    const bodies: unknown[] = [];
    const tools = createDashboardPanelTools({
      workerFetch: async (request: Request) => {
        bodies.push(await request.json());
        return Response.json({ ok: true, status: 'started', archive_id: ARCHIVE_ID, name: 'result.json' });
      },
    } as unknown as Parameters<typeof createDashboardPanelTools>[0]);
    const context = { origin: ORIGIN, localSession: true };
    expect((await tools.call(ARCHIVE_APPROVE_TOOL_NAME, { upload_id: UPLOAD_ID, source_id: 'telegram.messages' }, context)).isError).toBeUndefined();
    expect(bodies).toEqual([{ upload_id: UPLOAD_ID, source_id: 'telegram.messages' }]);
    // A path on this computer is not something the panel can name any more.
    expect((await tools.call(ARCHIVE_APPROVE_TOOL_NAME, { key: '/Users/someone/result.json' }, context)).isError).toBe(true);
    for (const args of [{ source_id: 'telegram.messages' }, { request_id: REQUEST_ID, source_id: 'telegram.messages' }, { upload_id: UPLOAD_ID, source_id: 7 }]) {
      const refused = await tools.call(ARCHIVE_APPROVE_TOOL_NAME, args, context);
      expect(refused.isError).toBe(true);
    }
    expect(bodies).toHaveLength(1);
  });

  test('the route hands the card to the approval; with a request id it is refused', async () => {
    const seen: unknown[] = [];
    const { dashboard } = archives();
    dashboard.approve = async (request) => { seen.push(request); return { ok: true, status: 'started', archive_id: ARCHIVE_ID, name: 'result.json' }; };
    const worker = createEmailSourceWorker({
      sourceDashboard: { sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})), archiveImports: dashboard },
    });
    const fetch = withWorkerBearerAuth((request: Request) => worker.fetch(request), {
      authToken: TOKEN,
      now: () => Date.parse('2026-10-23T12:00:00.000Z'),
      launchTickets: new DashboardLaunchTickets({ now: () => Date.parse('2026-10-23T12:00:00.000Z') }),
    });
    const mint = new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: ORIGIN } });
    recordRequestPeer(mint, '127.0.0.1');
    const minted = await fetch(mint);
    const session = { Cookie: cookieOf(minted), 'X-Olympus-CSRF': ((await minted.json()) as { csrf_token: string }).csrf_token };
    const approve = (body: unknown) => fetch(new Request(`${ORIGIN}/dashboard/archive-import/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...session }, body: JSON.stringify(body),
    }));
    expect((await approve({ upload_id: UPLOAD_ID, source_id: 'telegram.messages' })).status).toBe(200);
    expect(seen).toEqual([{ uploadId: UPLOAD_ID, sourceId: 'telegram.messages' }]);
    // A path is not an approval any more: the worker takes an upload or a request.
    expect((await approve({ key: '/Users/someone/result.json' })).status).toBe(400);
    expect((await approve({ request_id: REQUEST_ID, source_id: 'telegram.messages' })).status).toBe(400);
    expect(seen).toHaveLength(1);
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
    // The browser's XMLHttpRequest, as far as one upload uses it: what was sent, and the means to answer or break it.
    interface FakeXhr { method?: string; url?: string; headers: Record<string, string>; body?: unknown; status: number; responseText: string; aborted: boolean }
    const xhrs: Array<FakeXhr & { progress(loaded: number): void; finish(status: number, text?: string): void; fail(): void }> = [];
    class FakeXMLHttpRequest {
      headers: Record<string, string> = {};
      status = 0;
      responseText = '';
      aborted = false;
      method?: string;
      url?: string;
      body?: unknown;
      upload: { onprogress?: (event: { loaded: number }) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      constructor() {
        const self = this;
        xhrs.push(Object.assign(this, {
          progress: (loaded: number) => self.upload.onprogress?.({ loaded }),
          finish: (status: number, text = '{}') => { self.status = status; self.responseText = text; self.onload?.(); },
          fail: () => self.onerror?.(),
        }) as never);
      }
      open(method: string, url: string) { this.method = method; this.url = url; }
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      send(body: unknown) { this.body = body; }
      abort() { this.aborted = true; this.onabort?.(); }
    }
    new Function('window', 'document', 'fetch', 'navigator', 'XMLHttpRequest', script)(fakeWindow, win.document, fakeFetch, win.navigator, FakeXMLHttpRequest);
    const send = (message: Record<string, unknown>) => win.dispatchEvent(new win.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: child as any }));
    return { fetched, received, send, xhrs };
  }

  test('a launch-link session opens the local session (no bearer) before the first upload begins, then uses it', async () => {
    const page = hostPage(false);
    page.send({ id: 1, method: 'tools/call', params: { name: DASHBOARD_TOOL_NAME, arguments: {} } });
    await settle();
    page.send({ id: 2, method: 'tools/call', params: { name: ARCHIVE_UPLOAD_START_TOOL_NAME, arguments: {} } });
    await settle();
    page.send({ id: 3, method: 'tools/call', params: { name: ARCHIVE_APPROVE_TOOL_NAME, arguments: { upload_id: UPLOAD_ID } } });
    await settle();
    page.send({ id: 4, method: 'tools/call', params: { name: ARCHIVE_REMOVE_TOOL_NAME, arguments: { archive_id: ARCHIVE_ID } } });
    await settle();
    expect(page.fetched.map(({ url, csrf, tool, authorization }) => ({ url, csrf, tool, authorization }))).toEqual([
      { url: '/dashboard/tools/call', csrf: 'bearer-csrf', tool: DASHBOARD_TOOL_NAME, authorization: undefined },
      { url: DASHBOARD_LOCAL_CONTROL_SESSION_PATH, csrf: undefined, tool: undefined, authorization: undefined },
      { url: '/dashboard/tools/call', csrf: 'local-csrf', tool: ARCHIVE_UPLOAD_START_TOOL_NAME, authorization: undefined },
      { url: '/dashboard/tools/call', csrf: 'local-csrf', tool: ARCHIVE_APPROVE_TOOL_NAME, authorization: undefined },
      { url: '/dashboard/tools/call', csrf: 'local-csrf', tool: ARCHIVE_REMOVE_TOOL_NAME, authorization: undefined },
    ]);
    expect(page.received.find((message) => message.id === 2)!.result).toEqual({ structuredContent: { ok: true } });
  });

  test('a local session already open asks for nothing more; a refused unlock still sends the call, which the tool refuses itself', async () => {
    const local = hostPage(true);
    local.send({ id: 1, method: 'tools/call', params: { name: ARCHIVE_APPROVE_TOOL_NAME, arguments: { upload_id: UPLOAD_ID } } });
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

  const FILE = { size: 8, slice: () => undefined, name: 'a.json' };
  const uploadRequest = (id: number, over: Record<string, unknown> = {}) => ({
    id, method: 'olympus/upload-file',
    params: { upload_id: UPLOAD_ID, path: 'Export 2026/ü chat/a.json', modified: 1_760_000_000_123.4, file: FILE, ...over },
  });

  test('a file the panel hands over is sent to the upload route as its own request: the file is the body, the path travels encoded in a header, and progress goes back', async () => {
    const page = hostPage(true);
    page.send(uploadRequest(7));
    await settle();
    expect(page.xhrs).toHaveLength(1);
    const sent = page.xhrs[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/dashboard/archive-import/upload-file');
    expect(sent.body).toBe(FILE);
    expect(sent.headers).toEqual({
      'X-Olympus-CSRF': 'bearer-csrf',
      'X-Olympus-Upload-Id': UPLOAD_ID,
      'X-Olympus-Upload-Path': encodeURIComponent('Export 2026/ü chat/a.json'),
      'X-Olympus-Upload-Modified': '1760000000123',
      // A file that fits in one piece is the whole file, begun and ended in one request.
      'X-Olympus-Upload-Offset': '0',
      'X-Olympus-Upload-Final': '1',
      'Content-Type': 'application/octet-stream',
    });
    sent.progress(5);
    sent.finish(200, '{"ok":true,"bytes":8}');
    await settle();
    expect(page.received.filter((message) => message.method === 'olympus/upload-progress')).toEqual([
      { jsonrpc: '2.0', method: 'olympus/upload-progress', params: { request: 7, loaded: 5 } },
    ]);
    expect(page.received.find((message) => message.id === 7)!.result).toEqual({ ok: true });
  });

  test('a file larger than a piece goes as pieces, one request at a time in order, each written before the next is sent, with progress counted across them', async () => {
    const MIB = 1024 * 1024;
    const pieces: Array<[number, number]> = [];
    const big = { size: 20 * MIB, slice: (from: number, to: number) => { pieces.push([from, to]); return { from, to }; }, name: 'big.json' };
    const page = hostPage(true);
    page.send(uploadRequest(30, { file: big }));
    await settle();
    // Only the first piece is out; the others wait for it.
    expect(page.xhrs).toHaveLength(1);
    expect(page.xhrs[0]!.body).toEqual({ from: 0, to: 8 * MIB });
    expect([page.xhrs[0]!.headers['X-Olympus-Upload-Offset'], page.xhrs[0]!.headers['X-Olympus-Upload-Final']]).toEqual(['0', '0']);
    page.xhrs[0]!.progress(3 * MIB);
    page.xhrs[0]!.finish(200, '{"ok":true}');
    await settle();
    expect(page.xhrs).toHaveLength(2);
    expect(page.xhrs[1]!.body).toEqual({ from: 8 * MIB, to: 16 * MIB });
    expect([page.xhrs[1]!.headers['X-Olympus-Upload-Offset'], page.xhrs[1]!.headers['X-Olympus-Upload-Final']]).toEqual([String(8 * MIB), '0']);
    page.xhrs[1]!.progress(MIB);
    page.xhrs[1]!.finish(200, '{"ok":true}');
    await settle();
    expect(page.xhrs).toHaveLength(3);
    expect(page.xhrs[2]!.body).toEqual({ from: 16 * MIB, to: 20 * MIB });
    expect([page.xhrs[2]!.headers['X-Olympus-Upload-Offset'], page.xhrs[2]!.headers['X-Olympus-Upload-Final']]).toEqual([String(16 * MIB), '1']);
    // Every piece names the same file.
    expect(new Set(page.xhrs.map((entry) => entry.headers['X-Olympus-Upload-Path'])).size).toBe(1);
    // Not answered until the last piece is.
    expect(page.received.find((message) => message.id === 30)).toBeUndefined();
    page.xhrs[2]!.finish(200, '{"ok":true}');
    await settle();
    expect(page.received.find((message) => message.id === 30)!.result).toEqual({ ok: true });
    // Progress is the bytes of the whole file: earlier pieces and what the current one has sent.
    expect(page.received.filter((message) => message.method === 'olympus/upload-progress').map((message) => (message.params as { loaded: number }).loaded)).toEqual([3 * MIB, 9 * MIB]);
  });

  test('a piece the engine refuses ends the file, and no further piece is sent; an abort between pieces sends none', async () => {
    const MIB = 1024 * 1024;
    const big = (name: string) => ({ size: 20 * MIB, slice: () => ({}), name });
    const page = hostPage(true);
    page.send(uploadRequest(31, { file: big('a.json') }));
    await settle();
    page.xhrs[0]!.finish(409, JSON.stringify({ error: { code: 'bad_offset', message: 'A part of a file arrived out of order. Choose the folder again.' } }));
    await settle();
    expect(page.xhrs).toHaveLength(1);
    expect(page.received.find((message) => message.id === 31)!.result).toEqual({ ok: false, message: 'A part of a file arrived out of order. Choose the folder again.' });
    page.send(uploadRequest(32, { file: big('b.json'), path: 'b.json' }));
    await settle();
    expect(page.xhrs).toHaveLength(2);
    // The first piece is written and the second is on its way when the person cancels: it is stopped, and no third is sent.
    page.xhrs[1]!.finish(200, '{"ok":true}');
    await settle();
    expect(page.xhrs).toHaveLength(3);
    page.send({ method: 'olympus/upload-abort', params: { upload_id: UPLOAD_ID } });
    await settle();
    expect(page.xhrs).toHaveLength(3);
    expect(page.xhrs[2]!.aborted).toBe(true);
    expect(page.received.find((message) => message.id === 32)!.result).toEqual({ ok: false, cancelled: true });
  });

  test('a launch-link session opens the local session first, and the file goes out under that session\'s token', async () => {
    const page = hostPage(false);
    page.send(uploadRequest(8));
    await settle();
    expect(page.fetched.map((entry) => entry.url)).toEqual([DASHBOARD_LOCAL_CONTROL_SESSION_PATH]);
    expect(page.xhrs[0]!.headers['X-Olympus-CSRF']).toBe('local-csrf');
  });

  test('the engine\'s own sentence for a refused file goes back to the panel; a dropped connection is a plain failure', async () => {
    const page = hostPage(true);
    page.send(uploadRequest(9));
    page.send(uploadRequest(10, { path: 'b.json' }));
    await settle();
    page.xhrs[0]!.finish(507, JSON.stringify({ error: { code: 'disk_full', message: 'This computer has no space left for it.' } }));
    page.xhrs[1]!.fail();
    await settle();
    expect(page.received.find((message) => message.id === 9)!.result).toEqual({ ok: false, message: 'This computer has no space left for it.' });
    expect(page.received.find((message) => message.id === 10)!.result).toEqual({ ok: false });
  });

  test('an abort stops every file of that upload in flight, answers them as cancelled, and sends none after it', async () => {
    const page = hostPage(true);
    page.send(uploadRequest(11));
    page.send(uploadRequest(12, { path: 'b.json' }));
    await settle();
    page.send({ method: 'olympus/upload-abort', params: { upload_id: UPLOAD_ID } });
    await settle();
    expect(page.xhrs.map((entry) => entry.aborted)).toEqual([true, true]);
    expect(page.received.filter((message) => message.id === 11 || message.id === 12).map((message) => message.result)).toEqual([
      { ok: false, cancelled: true }, { ok: false, cancelled: true },
    ]);
    page.send(uploadRequest(13, { path: 'c.json' }));
    await settle();
    expect(page.xhrs).toHaveLength(2);
    expect(page.received.find((message) => message.id === 13)!.result).toEqual({ ok: false, cancelled: true });
  });

  test('a request that is not a file of an upload is refused and sends nothing: no id, a path too long, no file, or an id that is not an upload\'s', async () => {
    const page = hostPage(true);
    page.send(uploadRequest(14, { upload_id: '../../etc' }));
    page.send(uploadRequest(15, { path: '' }));
    page.send(uploadRequest(16, { path: 'x'.repeat(5000) }));
    page.send(uploadRequest(17, { file: 'a string' }));
    await settle();
    expect(page.xhrs).toEqual([]);
    for (const id of [14, 15, 16, 17]) expect(page.received.find((message) => message.id === id)!.result).toEqual({ ok: false });
  });
});
