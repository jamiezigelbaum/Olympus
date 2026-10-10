/**
 * Unified dashboard phase 4 (owner decision 2026-10-09): the ChatGPT panel is
 * the only dashboard. These tests pin the three pieces that make that true on
 * Olympus's own hosts:
 *
 * - the host protocol (workers/dashboard/host-bridge.ts) the computer's
 *   /dashboard and the OpenClaw tab both run: ui/initialize, the tools
 *   allowlist, the locked read, links;
 * - the worker's routes behind it: the host page, the legacy redirects, the
 *   locked banner, POST /dashboard/tools/call under the control session and
 *   its CSRF token;
 * - the panel's computer mode: the "On this computer" section, Change models
 *   enabled, Index faster only while indexing runs, and none of it in ChatGPT.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import {
  COMPUTER_HOST_TOOL_NAMES,
  COMPUTER_META_KEY,
  DASHBOARD_TOOL_NAME,
  INDEX_FASTER_TOOL_NAME,
  OLYMPUS_HOST_CONTEXT_KEY,
  OPEN_UNREADABLE_FILE_TOOL_NAME,
  UNPAIR_SOURCE_TOOL_NAME,
  UNREADABLE_FILES_PAGE_TOOL_NAME,
  PANEL_TOOL_NAMES,
  PRIVACY_GET_TOOL_NAME,
  PRIVACY_SET_TOOL_NAME,
  type DashboardViewModelV1,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import { chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { dashboardHostBridge, type DashboardHostBridgeConfig } from '../src/workers/dashboard/host-bridge.ts';
import { COMPUTER_HOST_PAGE_CSP, DASHBOARD_TOOLS_CALL_PATH, computerOpenTargets, renderComputerHostPage } from '../src/workers/dashboard/host-page.ts';
import { DASHBOARD_COMPUTER_PANEL_COPY, DASHBOARD_HOST_GATE_COPY } from '../src/workers/dashboard/vocabulary.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { computerUnpairEntries, createDashboardPanelTools, type DashboardPanelTools } from '../src/workers/email-source/dashboard-panel-tools.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';

const OPEN_BASE = 'https://olympusplugin.ai/open/';
const ORIGIN = 'http://127.0.0.1:8787';
const LINKS = {
  keys: `${ORIGIN}/dashboard?keys`,
  agents: `${ORIGIN}/dashboard?agents`,
  outsideHelp: `${ORIGIN}/dashboard?outside-help`,
  connector: `${ORIGIN}/dashboard?connector`,
};

const windows: Window[] = [];
afterEach(async () => {
  while (windows.length) await windows.pop()!.happyDOM.close();
});

describe('the panel\'s tool lists', () => {
  test('the privacy names written out in the list are the privacy tools\' own names', () => {
    expect(PANEL_TOOL_NAMES).toContain(PRIVACY_GET_TOOL_NAME);
    expect(PANEL_TOOL_NAMES).toContain(PRIVACY_SET_TOOL_NAME);
  });

  test('the computer adds exactly Index faster, Unpair, and opening and paging unreadable files; ChatGPT\'s conversation tools are on neither list', () => {
    expect([...COMPUTER_HOST_TOOL_NAMES]).toEqual([...PANEL_TOOL_NAMES, INDEX_FASTER_TOOL_NAME, UNPAIR_SOURCE_TOOL_NAME, OPEN_UNREADABLE_FILE_TOOL_NAME, UNREADABLE_FILES_PAGE_TOOL_NAME]);
    expect(PANEL_TOOL_NAMES as readonly string[]).not.toContain(UNPAIR_SOURCE_TOOL_NAME);
    expect(PANEL_TOOL_NAMES as readonly string[]).not.toContain(OPEN_UNREADABLE_FILE_TOOL_NAME);
    for (const name of ['olympus_search', 'olympus_answer', 'olympus_source_status']) {
      expect(COMPUTER_HOST_TOOL_NAMES).not.toContain(name);
    }
  });
});

// ---- the host protocol ------------------------------------------------------

interface Bridge {
  win: Window;
  /** What the host posted to the panel. */
  received: Array<Record<string, any>>;
  calls: Array<[string, Record<string, unknown>]>;
  opened: string[];
  send(message: Record<string, unknown>): void;
  /** The reply to request `id`, once the host has answered. */
  reply(id: number): Promise<Record<string, any>>;
  dispose(): void;
}

function bridge(overrides: Partial<DashboardHostBridgeConfig> = {}, callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>): Bridge {
  const win = new Window({ url: `${ORIGIN}/dashboard` });
  windows.push(win);
  const received: Bridge['received'] = [];
  const calls: Bridge['calls'] = [];
  const opened: string[] = [];
  const child = { postMessage: (message: Record<string, any>) => received.push(message) };
  const frame = { ownerDocument: win.document, contentWindow: child } as unknown as HTMLIFrameElement;
  const handle = dashboardHostBridge({
    contextKey: OLYMPUS_HOST_CONTEXT_KEY,
    kind: 'computer',
    readOnly: false,
    links: LINKS,
    tools: COMPUTER_HOST_TOOL_NAMES,
    readTool: DASHBOARD_TOOL_NAME,
    openTargets: { 'connect/x': `${ORIGIN}/dashboard?keys#olympus-open=connect-x` },
    openBase: OPEN_BASE,
    ...overrides,
  }, {
    frame,
    callTool: callTool ?? (async (name, args) => {
      calls.push([name, args]);
      return { content: [{ type: 'text', text: `ran ${name}` }] };
    }),
    openUrl: (url) => opened.push(url),
  });
  return {
    win,
    received,
    calls,
    opened,
    send: (message) => win.dispatchEvent(new win.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: child as any })),
    async reply(id) {
      for (let i = 0; i < 20; i += 1) {
        const found = received.find((message) => message.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(`no reply to ${id}`);
    },
    dispose: () => handle.dispose(),
  };
}

describe('the host protocol', () => {
  test('ui/initialize returns the theme, fullscreen, and the computer flag with its local links', async () => {
    const host = bridge();
    host.send({ id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26' } });
    const reply = await host.reply(1);
    expect(reply.result.protocolVersion).toBe('2026-01-26');
    expect(reply.result.hostContext.theme).toMatch(/^(light|dark)$/);
    expect(reply.result.hostContext.displayMode).toBe('fullscreen');
    expect(reply.result.hostContext.availableDisplayModes).toEqual(['fullscreen']);
    expect(reply.result.hostContext[OLYMPUS_HOST_CONTEXT_KEY]).toEqual({ kind: 'computer', readOnly: false, links: LINKS });
  });

  test('an open link\'s landing rides in the first ui/initialize reply only', async () => {
    const host = bridge({ landing: { sourceId: 'dropbox.files' } });
    host.send({ id: 30, method: 'ui/initialize', params: { protocolVersion: '2026-01-26' } });
    expect((await host.reply(30)).result.hostContext[OLYMPUS_HOST_CONTEXT_KEY]).toEqual({ kind: 'computer', readOnly: false, links: LINKS, landing: { sourceId: 'dropbox.files' } });
    host.send({ id: 31, method: 'ui/initialize', params: { protocolVersion: '2026-01-26' } });
    expect((await host.reply(31)).result.hostContext[OLYMPUS_HOST_CONTEXT_KEY]).toEqual({ kind: 'computer', readOnly: false, links: LINKS });
  });

  test('tools/call runs a panel tool and returns its result as is', async () => {
    const host = bridge();
    host.send({ id: 2, method: 'tools/call', params: { name: 'olympus_sync_source', arguments: { source: 'gmail' } } });
    expect((await host.reply(2)).result).toEqual({ content: [{ type: 'text', text: 'ran olympus_sync_source' }] });
    expect(host.calls).toEqual([['olympus_sync_source', { source: 'gmail' }]]);
  });

  test('a tool off the panel\'s list is refused without running anything', async () => {
    const host = bridge();
    for (const [id, name] of [[3, 'olympus_search'], [4, 'olympus_answer'], [5, ''], [6, 'constructor']] as const) {
      host.send({ id, method: 'tools/call', params: { name, arguments: {} } });
      expect((await host.reply(id)).result).toEqual({ isError: true, content: [{ type: 'text', text: 'This tool is not available here.' }] });
    }
    expect(host.calls).toEqual([]);
  });

  test('the OpenClaw tab never runs Index faster: only the panel\'s own tools', async () => {
    const host = bridge({ kind: 'openclaw', links: {}, tools: PANEL_TOOL_NAMES, openTargets: {} });
    host.send({ id: 7, method: 'tools/call', params: { name: INDEX_FASTER_TOOL_NAME, arguments: { on: true } } });
    expect((await host.reply(7)).result.isError).toBe(true);
    expect(host.calls).toEqual([]);
  });

  test('locked, only the dashboard read runs; every control says to open dashboard controls', async () => {
    const host = bridge({ readOnly: true });
    host.send({ id: 8, method: 'tools/call', params: { name: 'olympus_disconnect_source', arguments: { source_id: 'gmail.email' } } });
    expect((await host.reply(8)).result).toEqual({ isError: true, content: [{ type: 'text', text: 'Open dashboard controls first.' }] });
    host.send({ id: 9, method: 'tools/call', params: { name: DASHBOARD_TOOL_NAME } });
    expect((await host.reply(9)).result.isError).toBeUndefined();
    expect(host.calls).toEqual([[DASHBOARD_TOOL_NAME, {}]]);
  });

  test('a failed call is a tool error, not a dead panel', async () => {
    const host = bridge({}, async () => { throw new Error('offline'); });
    host.send({ id: 10, method: 'tools/call', params: { name: DASHBOARD_TOOL_NAME } });
    expect((await host.reply(10)).result).toEqual({ isError: true, content: [{ type: 'text', text: 'Could not reach Olympus.' }] });
  });

  test('links open a tab: a local page exactly, an open link at its local page, other https as is, nothing else', async () => {
    const host = bridge();
    host.send({ id: 11, method: 'ui/open-link', params: { url: LINKS.agents } });
    host.send({ id: 12, method: 'ui/open-link', params: { url: `${OPEN_BASE}connect/x/` } });
    host.send({ id: 13, method: 'ui/open-link', params: { url: 'https://example.com/help' } });
    host.send({ id: 14, method: 'ui/open-link', params: { url: 'javascript:alert(1)' } });
    host.send({ id: 15, method: 'ui/open-link', params: { url: `${ORIGIN}/dashboard?keys&evil` } });
    host.send({ id: 16, method: 'ui/open-link', params: { url: 'https://user:pass@example.com/' } });
    expect((await host.reply(11)).result).toEqual({});
    expect((await host.reply(14)).error.code).toBe(-32602);
    expect((await host.reply(15)).error.code).toBe(-32602);
    expect((await host.reply(16)).error.code).toBe(-32602);
    expect(host.opened).toEqual([LINKS.agents, `${ORIGIN}/dashboard?keys#olympus-open=connect-x`, 'https://example.com/help']);
  });

  test('only the framed panel is heard, and an unknown request is answered, not dropped', async () => {
    const host = bridge();
    host.win.dispatchEvent(new host.win.MessageEvent('message', {
      data: { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: DASHBOARD_TOOL_NAME } },
      source: { postMessage() {} } as any,
    }));
    host.send({ id: 21, method: 'ui/something-new' });
    expect((await host.reply(21)).error.code).toBe(-32601);
    expect(host.received.find((message) => message.id === 20)).toBeUndefined();
    expect(host.calls).toEqual([]);
    host.dispose();
    host.send({ id: 22, method: 'ui/initialize' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(host.received.find((message) => message.id === 22)).toBeUndefined();
  });
});

// ---- the worker's routes -----------------------------------------------------

const AUTH = 'computer-host-worker-secret';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-computer-host-'));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const panelTools: DashboardPanelTools = {
    allows: (name) => (COMPUTER_HOST_TOOL_NAMES as readonly string[]).includes(name),
    async call(name, args) {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: `ran ${name}` }], structuredContent: { ran: name } };
    },
  };
  const worker = createEmailSourceWorker({
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('private-cloud-only')),
      registryPath: join(dir, 'handles.json'),
      panelTools,
    },
  });
  const fetch = withWorkerBearerAuth(worker.fetch, { authToken: AUTH });
  return {
    calls,
    fetch,
    close() {
      worker.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function controlSession(fetch: ReturnType<typeof fixture>['fetch']) {
  const response = await fetch(new Request('http://worker.test/dashboard/control/session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${AUTH}`, Origin: 'http://worker.test' },
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as { csrf_token: string };
  return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: body.csrf_token };
}

function toolCall(name: string, headers: Record<string, string>, args: unknown = {}) {
  return new Request(`http://worker.test${DASHBOARD_TOOLS_CALL_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ name, arguments: args }),
  });
}

describe('the computer\'s /dashboard', () => {
  test('is the host page around the exact panel, with its own strict policy', async () => {
    const f = fixture();
    try {
      const response = await f.fetch(new Request('http://worker.test/dashboard', { headers: { Authorization: `Bearer ${AUTH}` } }));
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Security-Policy')).toBe(COMPUTER_HOST_PAGE_CSP);
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      const html = await response.text();
      expect(html).toContain('<iframe class="panel" id="olympus-panel" title="Olympus dashboard" sandbox="allow-scripts" srcdoc="');
      // The srcdoc is the panel ChatGPT loads, attribute-escaped.
      expect(html).toContain('&quot;');
      expect(html).not.toContain(AUTH);
    } finally {
      f.close();
    }
  });

  test('while locked, shows the Open dashboard controls banner and reads through the dash_ token', async () => {
    const f = fixture();
    try {
      const token = dashboardQueryTokenFromWorkerAuthToken(AUTH)!;
      const response = await f.fetch(new Request(`http://worker.test/dashboard?token=${encodeURIComponent(token)}`));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`data-dashboard-control-gate data-state="locked" aria-label="${DASHBOARD_HOST_GATE_COPY.title}">`);
      // It leads with the one-click open link, the terminal command its fallback line.
      expect(html).toContain(`<a class="btn primary" href="olympus://open/dashboard" data-gate-open>${DASHBOARD_HOST_GATE_COPY.open}</a>`);
      expect(html).toContain(`${DASHBOARD_HOST_GATE_COPY.fallbackBefore}<code>olympus dashboard</code>${DASHBOARD_HOST_GATE_COPY.fallbackAfter}`);
      expect(html).toContain(DASHBOARD_HOST_GATE_COPY.button);
      expect(html).toContain('data-locked="true"');
      // The locked read carries the reader's token (the host program reads through it).
      expect(html).toContain('panel-read');
      expect(html).toContain(encodeURIComponent(token));

      const read = await f.fetch(new Request(`http://worker.test/dashboard?panel-read&token=${encodeURIComponent(token)}`));
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ content: [{ type: 'text', text: `ran ${DASHBOARD_TOOL_NAME}` }], structuredContent: { ran: DASHBOARD_TOOL_NAME } });
      expect(f.calls.map((call) => call.name)).toEqual([DASHBOARD_TOOL_NAME]);
    } finally {
      f.close();
    }
  });

  test('with the control session, the banner is gone and the page carries its CSRF token', async () => {
    const f = fixture();
    try {
      const session = await controlSession(f.fetch);
      const response = await f.fetch(new Request('http://worker.test/dashboard', { headers: { Cookie: session.cookie } }));
      expect(response.status).toBe(200);
      const html = await response.text();
      // The banner is there but hidden, for a session that expires while the page is open.
      expect(html).toContain(`data-dashboard-control-gate data-state="locked" aria-label="${DASHBOARD_HOST_GATE_COPY.title}" hidden>`);
      expect(html).toContain('data-locked="false"');
      expect(html).toContain(session.csrf);
    } finally {
      f.close();
    }
  });

  test('every older page\'s address redirects to /dashboard, keeping a dash_ reader\'s token', async () => {
    const f = fixture();
    try {
      const token = dashboardQueryTokenFromWorkerAuthToken(AUTH)!;
      for (const query of ['?source=gmail.email', '?background', '?sensitivity', '?setup', '?privacy', '?embedding-ledger']) {
        const bearer = await f.fetch(new Request(`http://worker.test/dashboard${query}`, { headers: { Authorization: `Bearer ${AUTH}` } }));
        expect(bearer.status).toBe(302);
        expect(bearer.headers.get('Location')).toBe('/dashboard');
        const reader = await f.fetch(new Request(`http://worker.test/dashboard${query}&token=${encodeURIComponent(token)}`));
        expect(reader.status).toBe(302);
        expect(reader.headers.get('Location')).toBe(`/dashboard?token=${encodeURIComponent(token)}`);
      }
      expect((await f.fetch(new Request('http://worker.test/dashboard?setup'))).status).toBe(401);
    } finally {
      f.close();
    }
  });

  test('the worker serves the panel page the Gateway frames to the worker bearer only (the Gateway route itself is public: control-ui-gateway.test.ts)', async () => {
    const f = fixture();
    try {
      const response = await f.fetch(new Request('http://worker.test/dashboard/panel', { headers: { Authorization: `Bearer ${AUTH}` } }));
      expect(response.status).toBe(200);
      expect((await response.text()).startsWith('<!doctype html>')).toBe(true);
      expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
      expect((await f.fetch(new Request('http://worker.test/dashboard/panel'))).status).toBe(401);
    } finally {
      f.close();
    }
  });
});

describe('POST /dashboard/tools/call', () => {
  test('needs the control session and its CSRF token; a dash_ reader and a bare cookie are refused', async () => {
    const f = fixture();
    try {
      const token = dashboardQueryTokenFromWorkerAuthToken(AUTH)!;
      expect((await f.fetch(toolCall(DASHBOARD_TOOL_NAME, {}))).status).toBe(401);
      expect((await f.fetch(new Request(`http://worker.test${DASHBOARD_TOOLS_CALL_PATH}?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: DASHBOARD_TOOL_NAME }),
      }))).status).toBe(401);
      const session = await controlSession(f.fetch);
      const noCsrf = await f.fetch(toolCall(DASHBOARD_TOOL_NAME, { Cookie: session.cookie, Origin: 'http://worker.test' }));
      expect([401, 403]).toContain(noCsrf.status);
      const wrongCsrf = await f.fetch(toolCall(DASHBOARD_TOOL_NAME, { Cookie: session.cookie, Origin: 'http://worker.test', 'X-Olympus-CSRF': 'not-it' }));
      expect([401, 403]).toContain(wrongCsrf.status);
      expect(f.calls).toEqual([]);

      const ok = await f.fetch(toolCall('olympus_sync_source', { Cookie: session.cookie, Origin: 'http://worker.test', 'X-Olympus-CSRF': session.csrf }, { source: 'gmail' }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ content: [{ type: 'text', text: 'ran olympus_sync_source' }], structuredContent: { ran: 'olympus_sync_source' } });
      expect(f.calls).toEqual([{ name: 'olympus_sync_source', args: { source: 'gmail' } }]);
    } finally {
      f.close();
    }
  });

  test('runs only the panel\'s tools, with object arguments', async () => {
    const f = fixture();
    try {
      const session = await controlSession(f.fetch);
      const headers = { Cookie: session.cookie, Origin: 'http://worker.test', 'X-Olympus-CSRF': session.csrf };
      const unknown = await f.fetch(toolCall('olympus_search', headers, { question: 'x' }));
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: 'unknown_tool' } });
      expect((await f.fetch(toolCall(DASHBOARD_TOOL_NAME, headers, ['not', 'an', 'object']))).status).toBe(400);
      const faster = await f.fetch(toolCall(INDEX_FASTER_TOOL_NAME, headers, { on: true }));
      expect(faster.status).toBe(200);
      expect(f.calls.map((call) => call.name)).toEqual([INDEX_FASTER_TOOL_NAME]);
    } finally {
      f.close();
    }
  });
});

// ---- the panel in computer mode ----------------------------------------------

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function model(overrides: Partial<DashboardViewModelV1> = {}): DashboardViewModelV1 {
  return {
    v: 1,
    connection: { state: 'ready' },
    needsYou: [],
    sources: [
      {
        id: 'dropbox', label: 'Dropbox', group: 'cloud', status: 'Working', lastSyncAt: ago(5 * MIN),
        progress: { stage: 'indexing', percent: 40, done: 400, total: 1000, unit: 'files', stalled: false },
      } as DashboardViewModelV1['sources'][number],
    ],
    progress: {
      unit: 'files', phase: 'initial', percent: 40, itemsLeft: 600, stalled: false,
      details: [{ stage: 'Indexing', unit: 'files', done: 400, total: 1000 }],
    },
    models: {
      embedding: { kind: 'built_in', state: 'ready' },
      change: { label: 'Change', tool: DASHBOARD_TOOL_NAME, args: {}, disabledReason: 'Change models in Olympus on your computer.', href: `${OPEN_BASE}fix/models/` },
    } as DashboardViewModelV1['models'],
    generatedAt: ago(0),
    ...overrides,
  };
}

interface Panel {
  win: Window;
  sent: Array<{ id?: number; method?: string; params?: any }>;
  text(): string;
  buttons(): HTMLButtonElement[];
  button(label: string): HTMLButtonElement;
  respond(method: string, result: unknown): void;
}

function panel(): Panel {
  const html = chatgptDashboardPageHtml({ resultTimeoutMs: 5_000 });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://sandbox.test/' });
  windows.push(win);
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const sent: Panel['sent'] = [];
  const parent = { postMessage: (message: any) => sent.push(message) };
  Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  new Function('window', 'document', script)(win, win.document);
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const result: Panel = {
    win,
    sent,
    text: () => win.document.getElementById('app')!.textContent ?? '',
    buttons: () => Array.from(win.document.querySelectorAll('#app button')) as unknown as HTMLButtonElement[],
    button: (label) => {
      const found = result.buttons().find((node) => node.textContent === label);
      if (!found) throw new Error(`no button "${label}" in: ${result.buttons().map((b) => b.textContent).join(' | ')}`);
      return found;
    },
    respond: (method, value) => {
      const request = [...sent].reverse().find((message) => message.method === method && message.id !== undefined);
      if (!request) throw new Error(`no ${method} request`);
      dispatch({ jsonrpc: '2.0', id: request.id, result: value });
    },
  };
  return result;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function onHost(host: Record<string, unknown> | undefined, data: DashboardViewModelV1, meta?: unknown): Promise<Panel> {
  const page = panel();
  await settle();
  page.respond('ui/initialize', {
    protocolVersion: '2026-01-26',
    hostContext: { theme: 'light', displayMode: 'fullscreen', availableDisplayModes: ['fullscreen'], ...(host ? { [OLYMPUS_HOST_CONTEXT_KEY]: host } : {}) },
  });
  await settle();
  const toolResult = { structuredContent: data, ...(meta ? { _meta: { [COMPUTER_META_KEY]: meta } } : {}) };
  if (host) {
    // An Olympus host has no tool result to push: the panel asks for it.
    page.respond('tools/call', toolResult);
  } else {
    page.win.dispatchEvent(new page.win.MessageEvent('message', {
      data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: toolResult },
      source: page.win.parent as any,
    }));
  }
  await settle();
  return page;
}

const COMPUTER = { kind: 'computer', readOnly: false, links: LINKS };
const GMAIL_RECONNECT = {
  id: 'gmail.email', label: 'Gmail', group: 'cloud', status: 'Needs you', lastSyncAt: ago(5 * MIN),
  primary: { label: 'Reconnect', tool: 'olympus_connect_source', args: { source: 'gmail' } },
} as DashboardViewModelV1['sources'][number];
const TELEGRAM = { id: 'telegram.messages', label: 'Telegram', group: 'local', status: 'Fresh', lastSyncAt: ago(MIN) } as DashboardViewModelV1['sources'][number];
const UNPAIR_TELEGRAM = {
  sourceId: 'telegram.messages',
  label: 'Unpair Telegram',
  confirmation: 'Stop new Telegram reads and delete this computer\'s Telegram pairing session. Messages already indexed stay.',
};
const C = DASHBOARD_COMPUTER_PANEL_COPY;

describe('the panel on the computer', () => {
  test('asks for the dashboard itself and ends with On this computer: Keys, Agents, Outside help, Build a connector', async () => {
    const page = await onHost(COMPUTER, model(), { indexFaster: { on: false } });
    const asked = page.sent.filter((message) => message.method === 'tools/call').map((message) => message.params.name);
    expect(asked).toEqual([DASHBOARD_TOOL_NAME]);
    const section = page.win.document.querySelector('section.on-computer')!;
    expect(section).not.toBeNull();
    expect(section.querySelector('h2')!.textContent).toBe(`${C.section} ${C.onlyHere}`);
    const titles = Array.from(section.querySelectorAll('li.row .row-text p:first-child')).map((node) => node.textContent);
    expect(titles).toEqual([C.rows.keys.title, C.rows.agents.title, C.rows.outsideHelp.title, C.rows.connector.title]);
    // It is the last section on the page.
    const sections = Array.from(page.win.document.querySelectorAll('#app section'));
    expect(sections[sections.length - 1]).toBe(section);

    const open = Array.from(section.querySelectorAll('button')).find((node) => node.getAttribute('aria-label') === `${C.open} ${C.rows.agents.title}`)!;
    open.click();
    expect(page.sent.filter((message) => message.method === 'ui/open-link').map((message) => message.params.url)).toEqual([LINKS.agents]);
  });

  test('Change models is enabled and opens the computer\'s models page', async () => {
    const page = await onHost(COMPUTER, model());
    const change = page.button('Change');
    expect(change.disabled).toBe(false);
    expect(page.text()).not.toContain('Change models in Olympus on your computer.');
    change.click();
    expect(page.sent.filter((message) => message.method === 'ui/open-link').map((message) => message.params.url)).toEqual([`${OPEN_BASE}fix/models/`]);
  });

  test('Index faster sits under Progress details only while indexing runs, and calls its tool', async () => {
    const page = await onHost(COMPUTER, model(), { indexFaster: { on: false } });
    const control = page.win.document.querySelector('.index-faster')!;
    expect(control).not.toBeNull();
    expect(control.closest('details')).not.toBeNull();
    const faster = Array.from(control.querySelectorAll('button'))[0]!;
    expect(faster.textContent).toBe(C.indexFaster.on);
    faster.click();
    await settle();
    const calls = page.sent.filter((message) => message.method === 'tools/call').map((message) => message.params);
    expect(calls[calls.length - 1]).toEqual({ name: INDEX_FASTER_TOOL_NAME, arguments: { on: true } });

    const idle = await onHost(COMPUTER, model({
      sources: [{ id: 'dropbox', label: 'Dropbox', group: 'cloud', status: 'Fresh', lastSyncAt: ago(MIN) } as DashboardViewModelV1['sources'][number]],
    }), { indexFaster: { on: false } });
    expect(idle.win.document.querySelector('.index-faster')).toBeNull();

    // No guard facts on this machine (a Mac): nothing to offer.
    const unknown = await onHost(COMPUTER, model());
    expect(unknown.win.document.querySelector('.index-faster')).toBeNull();
  });

  test('locked: the controls are disabled with no reason of their own (the banner says it once), and the local pages stay one click away', async () => {
    const page = await onHost({ ...COMPUTER, readOnly: true }, model({ sources: [GMAIL_RECONNECT] }), { indexFaster: { on: false } });
    expect(page.button('Reconnect').disabled).toBe(true);
    expect(page.text()).not.toContain(C.locked);
    expect(page.win.document.querySelector('section.on-computer')).not.toBeNull();
    expect(Array.from(page.win.document.querySelectorAll('section.on-computer button')).every((node: any) => !node.disabled)).toBe(true);
  });

  test('the OpenClaw tab read-only has no banner, so each control still says why', async () => {
    const page = await onHost({ kind: 'openclaw', readOnly: true, links: {} }, model({ sources: [GMAIL_RECONNECT] }));
    expect(page.button('Reconnect').disabled).toBe(true);
    expect(page.text()).toContain(C.readOnlyOpenClaw);
  });

  test('a paired chat app\'s ⋯ menu offers Unpair on the computer, confirms with the engine\'s own words, and says what it did', async () => {
    const page = await onHost(COMPUTER, model({ sources: [TELEGRAM] }), { unpair: [UNPAIR_TELEGRAM] });
    page.button('Unpair Telegram').click();
    await settle();
    expect(page.text()).toContain(UNPAIR_TELEGRAM.confirmation);
    page.button('Yes, unpair telegram').click();
    await settle();
    const calls = page.sent.filter((message) => message.method === 'tools/call').map((message) => message.params);
    expect(calls[calls.length - 1]).toEqual({ name: UNPAIR_SOURCE_TOOL_NAME, arguments: { source_id: 'telegram.messages' } });
    page.respond('tools/call', { content: [{ type: 'text', text: 'Unpaired. Waiting for the next refresh.' }], structuredContent: { status: 'saved' } });
    await settle();
    // It reads the dashboard again, and keeps Unpair's own sentence on the page.
    const after = page.sent.filter((message) => message.method === 'tools/call').map((message) => message.params.name);
    expect(after[after.length - 1]).toBe(DASHBOARD_TOOL_NAME);
    page.respond('tools/call', { structuredContent: model({ sources: [{ ...TELEGRAM, status: 'Off' }] }) });
    await settle();
    expect(page.text()).toContain('Unpaired. Waiting for the next refresh.');
  });

  test('Unpair\'s refusal is shown beside it, not as a dead panel', async () => {
    const page = await onHost(COMPUTER, model({ sources: [TELEGRAM] }), { unpair: [UNPAIR_TELEGRAM] });
    page.button('Unpair Telegram').click();
    await settle();
    page.button('Yes, unpair telegram').click();
    await settle();
    page.respond('tools/call', { isError: true, content: [{ type: 'text', text: 'This source is finishing a read. Retry Unpair after the current read completes.' }], structuredContent: { error: 'unpair_source_busy' } });
    await settle();
    expect(page.text()).toContain('This source is finishing a read.');
    expect(page.text()).toContain('Telegram');
  });

  test('no Unpair where the computer did not offer it: a source it does not list, or locked', async () => {
    const unlisted = await onHost(COMPUTER, model({ sources: [TELEGRAM] }), { indexFaster: { on: false } });
    expect(unlisted.buttons().some((node) => node.textContent === 'Unpair Telegram')).toBe(false);
    const locked = await onHost({ ...COMPUTER, readOnly: true }, model({ sources: [TELEGRAM] }), { unpair: [UNPAIR_TELEGRAM] });
    expect(locked.button('Unpair Telegram').disabled).toBe(true);
  });
});

const FILE_TOKEN = 'T'.repeat(43);
const UNREADABLE_DROPBOX = {
  id: 'dropbox.files', label: 'Dropbox', group: 'cloud', status: 'Fresh', lastSyncAt: ago(MIN),
  detail: "synced 1m ago · 3 files can't be read",
  unreadable: {
    count: 3, reasons: [{ code: 'damaged_or_unsupported', count: 3 }], names: ['ChatGPT name.pdf'],
    more: { label: 'and 2 more', tool: DASHBOARD_TOOL_NAME, args: {}, href: `${OPEN_BASE}unreadable/dropbox/`, openHref: true },
  },
} as DashboardViewModelV1['sources'][number];
const UNREADABLE_META = { unreadable: [{ sourceId: 'dropbox.files', files: [{ name: 'Q3 deck.key', token: FILE_TOKEN }, { name: 'scan.tiff' }], more: 1 }] };

describe('See why on the computer', () => {
  test('lists the computer\'s own files: each with a token opens through the computer-only tool, the rest plain text', async () => {
    const page = await onHost(COMPUTER, model({ sources: [UNREADABLE_DROPBOX] }), UNREADABLE_META);
    const why = page.win.document.querySelector('details.why')!;
    expect(Array.from(why.querySelectorAll('ul.files li')).map((node) => node.textContent)).toEqual(['Q3 deck.key', 'scan.tiff', 'and 1 more']);
    // The result's ChatGPT names and its "and N more" link give way to the computer's list.
    expect(why.textContent).not.toContain('ChatGPT name.pdf');
    // Q3 deck opens; "and 1 more" pages the rest.
    expect(Array.from(why.querySelectorAll('ul.files button')).map((node) => node.textContent)).toEqual(['Q3 deck.key', 'and 1 more']);
    const open = why.querySelector('ul.files button')! as unknown as HTMLButtonElement;
    expect(open.getAttribute('aria-label')).toBe('Open Q3 deck.key');
    open.click();
    await settle();
    const calls = page.sent.filter((message) => message.method === 'tools/call').map((message) => message.params);
    expect(calls[calls.length - 1]).toEqual({ name: OPEN_UNREADABLE_FILE_TOOL_NAME, arguments: { token: FILE_TOKEN } });
    page.respond('tools/call', { content: [{ type: 'text', text: 'Opening the file\'s page.' }], structuredContent: { status: 'open_link', url: 'https://www.dropbox.com/preview/Q3%20deck.key' } });
    await settle();
    expect(page.sent.filter((message) => message.method === 'ui/open-link').map((message) => message.params.url)).toEqual(['https://www.dropbox.com/preview/Q3%20deck.key']);
    // The token is spent: the dashboard is read again for fresh ones.
    expect(page.sent.filter((message) => message.method === 'tools/call').map((message) => message.params.name)).toEqual([DASHBOARD_TOOL_NAME, OPEN_UNREADABLE_FILE_TOOL_NAME, DASHBOARD_TOOL_NAME]);
  });

  // Codex review of #231 (P2c): past the first page, every file is reachable.
  test('"and N more" reads the next page and lists it under the first, each file opening', async () => {
    const page = await onHost(COMPUTER, model({ sources: [UNREADABLE_DROPBOX] }), UNREADABLE_META);
    const more = () => Array.from(page.win.document.querySelectorAll('details.why ul.files button')).find((node) => /more$/.test(node.textContent ?? '')) as unknown as HTMLButtonElement | undefined;
    more()!.click();
    await settle();
    const calls = page.sent.filter((message) => message.method === 'tools/call').map((message) => message.params);
    expect(calls[calls.length - 1]).toEqual({ name: UNREADABLE_FILES_PAGE_TOOL_NAME, arguments: { source_id: 'dropbox.files', offset: 2 } });
    const NEXT = 'N'.repeat(43);
    page.respond('tools/call', { content: [{ type: 'text', text: '1 more files.' }], structuredContent: { status: 'listed', source_id: 'dropbox.files', offset: 2, files: [{ name: 'page two.pdf', token: NEXT }], more: 0 } });
    await settle();
    const why = page.win.document.querySelector('details.why')!;
    expect(Array.from(why.querySelectorAll('ul.files li')).map((node) => node.textContent)).toEqual(['Q3 deck.key', 'scan.tiff', 'page two.pdf']);
    expect(more()).toBeUndefined();
    (Array.from(why.querySelectorAll('ul.files button')).find((node) => node.textContent === 'page two.pdf') as unknown as HTMLButtonElement).click();
    await settle();
    const last = page.sent.filter((message) => message.method === 'tools/call').map((message) => message.params).at(-1);
    expect(last).toEqual({ name: OPEN_UNREADABLE_FILE_TOOL_NAME, arguments: { token: NEXT } });
  });

  test('a file that is gone says so beside it', async () => {
    const page = await onHost(COMPUTER, model({ sources: [UNREADABLE_DROPBOX] }), UNREADABLE_META);
    (page.win.document.querySelector('details.why ul.files button') as unknown as HTMLButtonElement).click();
    await settle();
    page.respond('tools/call', { isError: true, content: [{ type: 'text', text: 'This file is no longer in the list. Refresh the dashboard.' }], structuredContent: { error: 'gone' } });
    await settle();
    expect(page.text()).toContain('This file is no longer in the list. Refresh the dashboard.');
  });

  test('a forged token is plain text, and a result without the computer\'s list shows the result\'s own names', async () => {
    const forged = await onHost(COMPUTER, model({ sources: [UNREADABLE_DROPBOX] }), { unreadable: [{ sourceId: 'dropbox.files', files: [{ name: 'x.pdf', token: '../../etc' }], more: 0 }] });
    expect(forged.win.document.querySelectorAll('details.why ul.files button').length).toBe(0);
    expect(forged.win.document.querySelector('details.why ul.files')!.textContent).toBe('x.pdf');
    const plain = await onHost(COMPUTER, model({ sources: [UNREADABLE_DROPBOX] }), { indexFaster: { on: false } });
    expect(Array.from(plain.win.document.querySelectorAll('details.why ul.files li')).map((node) => node.textContent)).toEqual(['ChatGPT name.pdf', 'and 2 more']);
  });

  test('ChatGPT never shows the computer\'s list, even if a result carried it', async () => {
    const page = await onHost(undefined, model({ sources: [UNREADABLE_DROPBOX] }), UNREADABLE_META);
    const files = Array.from(page.win.document.querySelectorAll('details.why ul.files li')).map((node) => node.textContent);
    expect(files).toEqual(['ChatGPT name.pdf', 'and 2 more']);
    expect(page.win.document.body.innerHTML).not.toContain(FILE_TOKEN);
  });

  test('an open link lands on that source\'s See why: open, focused, outlined briefly', async () => {
    const page = await onHost({ ...COMPUTER, landing: { sourceId: 'dropbox.files' } }, model({ sources: [TELEGRAM, UNREADABLE_DROPBOX] }), UNREADABLE_META);
    const why = page.win.document.querySelector('details.why')! as unknown as HTMLDetailsElement;
    expect(why.open).toBe(true);
    expect(why.classList.contains('landed')).toBe(true);
    expect(page.win.document.activeElement).toBe(why.querySelector('summary') as never);
    // Only once: a later read does not land again.
    expect(page.win.document.querySelectorAll('.landed').length).toBe(1);
  });

  test('a landing in ChatGPT, or on a source that is not there, does nothing', async () => {
    const chatgpt = await onHost({ kind: 'openclaw', readOnly: false, links: {}, landing: { sourceId: 'dropbox.files' } }, model({ sources: [UNREADABLE_DROPBOX] }));
    expect(chatgpt.win.document.querySelector('.landed')).toBeNull();
    const missing = await onHost({ ...COMPUTER, landing: { sourceId: 'gmail.email' } }, model({ sources: [UNREADABLE_DROPBOX] }));
    expect(missing.win.document.querySelector('.landed')).toBeNull();
    expect((missing.win.document.querySelector('details.why') as unknown as HTMLDetailsElement).open).toBe(false);
  });
});

describe('the same panel in ChatGPT', () => {
  test('has no computer section, keeps Change models disabled with its reason, and never offers Index faster', async () => {
    const page = await onHost(undefined, model(), { indexFaster: { on: false } });
    expect(page.win.document.querySelector('section.on-computer')).toBeNull();
    expect(page.win.document.querySelector('.index-faster')).toBeNull();
    expect(page.button('Change').disabled).toBe(true);
    expect(page.text()).toContain('Change models in Olympus on your computer.');
    expect(page.text()).not.toContain(C.section);
  });

  test('a paired chat app\'s row offers nothing it cannot do there: no Unpair, even if a result carried the computer\'s facts', async () => {
    const page = await onHost(undefined, model({ sources: [TELEGRAM] }), { unpair: [UNPAIR_TELEGRAM] });
    expect(page.buttons().some((node) => (node.textContent ?? '').includes('Unpair'))).toBe(false);
    expect(page.win.document.querySelector('details.menu')).toBeNull();
  });

  test('a forged host context naming a non-http link is ignored', async () => {
    const page = await onHost({ kind: 'computer', readOnly: false, links: { keys: 'javascript:alert(1)' } }, model());
    expect(page.win.document.querySelector('section.on-computer')).toBeNull();
  });
});

describe('the host page renderer', () => {
  test('never names a worker secret, and escapes the panel into srcdoc', () => {
    const html = renderComputerHostPage({ panelHtml: '<p title="a&b">"x"</p>', origin: ORIGIN });
    expect(html).toContain('srcdoc="<p title=&quot;a&amp;b&quot;>&quot;x&quot;</p>"');
    expect(html).toContain('data-dashboard-control-gate data-state="locked"');
    const unlocked = renderComputerHostPage({ panelHtml: '<p></p>', origin: ORIGIN, csrfToken: 'csrf-123' });
    expect(unlocked).toContain('data-state="locked" aria-label="' + DASHBOARD_HOST_GATE_COPY.title + '" hidden>');
    expect(unlocked).toContain('csrf-123');
  });

  test('a See why open link lands on the dashboard itself, named by its token, and the page knows only the closed list', () => {
    const targets = computerOpenTargets(ORIGIN);
    expect(targets['unreadable/dropbox']).toBe(`${ORIGIN}/dashboard#olympus-open=unreadable.dropbox`);
    expect(targets['unreadable/drive']).toBe(`${ORIGIN}/dashboard#olympus-open=unreadable.drive`);
    const html = renderComputerHostPage({ panelHtml: '<p></p>', origin: ORIGIN });
    expect(html).toContain('"unreadable.dropbox":"dropbox.files"');
    expect(html).toContain('"unreadable.whatsapp":"whatsapp.personal.messages"');
  });

  test('its policy frames nothing else and is framed by nothing', () => {
    expect(COMPUTER_HOST_PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(COMPUTER_HOST_PAGE_CSP).toContain("default-src 'none'");
    expect(COMPUTER_HOST_PAGE_CSP).toContain("connect-src 'self'");
  });
});

// ---- Unpair on the computer (dashboard-panel-tools.ts) ------------------------

describe('Unpair through the panel tools', () => {
  function tools(answer: (request: Request) => Response | Promise<Response>) {
    const requests: Array<{ url: string; body: unknown }> = [];
    const panelTools = createDashboardPanelTools({
      surface: () => { throw new Error('Unpair never reaches the ChatGPT surface'); },
      setup: {} as never,
      workerFetch: async (request) => {
        requests.push({ url: request.url, body: await request.clone().json() });
        return await answer(request);
      },
      makeContext: () => { throw new Error('not used'); },
      indexFasterState: async () => undefined,
    });
    return { panelTools, requests };
  }

  test('runs the worker\'s own Unpair route, acknowledged by the panel\'s confirm, and says what it did', async () => {
    const { panelTools, requests } = tools(() => Response.json({ ok: true, status_message: 'Unpaired. Waiting for the next refresh.' }));
    expect(panelTools.allows(UNPAIR_SOURCE_TOOL_NAME)).toBe(true);
    const result = await panelTools.call(UNPAIR_SOURCE_TOOL_NAME, { source_id: 'whatsapp.personal.messages' }, { origin: ORIGIN });
    expect(result).toEqual({ content: [{ type: 'text', text: 'Unpaired. Waiting for the next refresh.' }], structuredContent: { status: 'saved', source_id: 'whatsapp.personal.messages' } });
    expect(requests).toEqual([{ url: 'http://olympus-worker.internal/dashboard/unpair', body: { source_id: 'whatsapp.personal.messages', acknowledge: true } }]);
  });

  test('an incomplete removal\'s own words come back, and a refusal keeps its code and sentence', async () => {
    const partial = tools(() => Response.json({ ok: true, status_message: 'Unpair incomplete — remove by hand: /x' }));
    expect((await partial.panelTools.call(UNPAIR_SOURCE_TOOL_NAME, { source_id: 'telegram.messages' }, { origin: ORIGIN })).content)
      .toEqual([{ type: 'text', text: 'Unpair incomplete — remove by hand: /x' }]);
    const busy = tools(() => Response.json({ ok: false, error: { code: 'unpair_source_busy', message: 'This source is finishing a read.' } }, { status: 409 }));
    expect(await busy.panelTools.call(UNPAIR_SOURCE_TOOL_NAME, { source_id: 'telegram.messages' }, { origin: ORIGIN })).toEqual({
      content: [{ type: 'text', text: 'This source is finishing a read.' }], structuredContent: { error: 'unpair_source_busy' }, isError: true,
    });
  });

  test('only a paired chat app, and nothing else in the arguments, reaches the route', async () => {
    const { panelTools, requests } = tools(() => Response.json({ ok: true }));
    for (const args of [{ source_id: 'gmail.email' }, { source_id: 'telegram.messages', acknowledge: false }, {}, { source_id: 7 }]) {
      expect((await panelTools.call(UNPAIR_SOURCE_TOOL_NAME, args as Record<string, unknown>, { origin: ORIGIN })).isError).toBe(true);
    }
    expect(requests).toEqual([]);
  });

  test('the computer lists only the paired apps the engine says this computer can unpair, with its own words', () => {
    const view = {
      sources: [
        { source_id: 'telegram.messages', connection: { unpair: { source_id: 'telegram.messages', label: 'Unpair Telegram', confirmation: 'Stop new Telegram reads.', provider_unlink_url: 'https://my.telegram.org/auth', provider_unlink_label: 'Telegram active sessions' } } },
        { source_id: 'whatsapp.personal.messages', connection: {} },
        { source_id: 'gmail.email', connection: { unpair: { source_id: 'gmail.email', label: 'Unpair Gmail', confirmation: 'x' } } },
      ],
    } as never;
    expect(computerUnpairEntries(view)).toEqual([{ sourceId: 'telegram.messages', label: 'Unpair Telegram', confirmation: 'Stop new Telegram reads.' }]);
    expect(computerUnpairEntries(undefined)).toEqual([]);
  });
});

// ---- a session that expires while the page is open ---------------------------

describe('the host page when its session expires', () => {
  function hostPage(readToken?: string) {
    const html = renderComputerHostPage({ panelHtml: '<p></p>', origin: ORIGIN, csrfToken: 'csrf-123', ...(readToken ? { readToken } : {}) });
    const start = html.indexOf('<script>') + '<script>'.length;
    const script = html.slice(start, html.indexOf('</script>', start));
    const win = new Window({ url: `${ORIGIN}/dashboard`, settings: { disableIframePageLoading: true } });
    windows.push(win);
    win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
    const frame = win.document.getElementById('olympus-panel')!;
    const received: Array<Record<string, any>> = [];
    const child = { postMessage: (message: Record<string, any>) => received.push(message) };
    Object.defineProperty(frame, 'contentWindow', { configurable: true, get: () => child });
    const assigned: string[] = [];
    const fetched: string[] = [];
    let status = 200;
    const fakeFetch = async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({ structuredContent: { ok: true } }), { status });
    };
    const fakeWindow = {
      location: { hash: '', pathname: '/dashboard', search: '', assign: (url: string) => assigned.push(url), reload: () => assigned.push('reload') },
      history: { replaceState: () => undefined },
      open: () => null,
    };
    new Function('window', 'document', 'fetch', 'navigator', script)(fakeWindow, win.document, fakeFetch, win.navigator);
    const send = (message: Record<string, unknown>) => win.dispatchEvent(new win.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: child as any }));
    return { win, received, assigned, fetched, send, expire: () => { status = 401; } };
  }

  test('without a reader\'s token it locks in place: the banner shows, the panel is told, reads keep the last answer, never a raw 401', async () => {
    const page = hostPage();
    const gate = page.win.document.querySelector('[data-dashboard-control-gate]') as unknown as HTMLElement;
    expect(gate.hidden).toBe(true);
    page.send({ id: 1, method: 'tools/call', params: { name: DASHBOARD_TOOL_NAME, arguments: {} } });
    await settle();
    page.expire();
    page.send({ id: 2, method: 'tools/call', params: { name: 'olympus_sync_source', arguments: { source_id: 'gmail.email' } } });
    await settle();
    expect(gate.hidden).toBe(false);
    expect(page.win.document.body.getAttribute('data-locked')).toBe('true');
    expect(page.assigned).toEqual([]);
    const changed = page.received.filter((message) => message.method === 'ui/notifications/host-context-changed');
    expect(changed[changed.length - 1]!.params[OLYMPUS_HOST_CONTEXT_KEY].readOnly).toBe(true);
    // The read answers from what it last saw; a control is refused without a request.
    const before = page.fetched.length;
    page.send({ id: 3, method: 'tools/call', params: { name: DASHBOARD_TOOL_NAME, arguments: {} } });
    page.send({ id: 4, method: 'tools/call', params: { name: 'olympus_sync_source', arguments: { source_id: 'gmail.email' } } });
    await settle();
    expect(page.received.find((message) => message.id === 3)!.result).toEqual({ structuredContent: { ok: true } });
    expect(page.received.find((message) => message.id === 4)!.result.isError).toBe(true);
    expect(page.fetched.length).toBe(before);
  });

  test('with a reader\'s token it goes to the locked page, which still reads', async () => {
    const page = hostPage('dash_reader');
    page.expire();
    page.send({ id: 1, method: 'tools/call', params: { name: DASHBOARD_TOOL_NAME, arguments: {} } });
    await settle();
    expect(page.assigned).toEqual(['/dashboard?token=dash_reader']);
  });
});
