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
  PANEL_TOOL_NAMES,
  PRIVACY_GET_TOOL_NAME,
  PRIVACY_SET_TOOL_NAME,
  type DashboardViewModelV1,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import { chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { dashboardHostBridge, type DashboardHostBridgeConfig } from '../src/workers/dashboard/host-bridge.ts';
import { COMPUTER_HOST_PAGE_CSP, DASHBOARD_TOOLS_CALL_PATH, renderComputerHostPage } from '../src/workers/dashboard/host-page.ts';
import { DASHBOARD_COMPUTER_PANEL_COPY, DASHBOARD_HOST_GATE_COPY } from '../src/workers/dashboard/vocabulary.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import type { DashboardPanelTools } from '../src/workers/email-source/dashboard-panel-tools.ts';
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

  test('the computer adds exactly Index faster; ChatGPT\'s conversation tools are on neither list', () => {
    expect([...COMPUTER_HOST_TOOL_NAMES]).toEqual([...PANEL_TOOL_NAMES, INDEX_FASTER_TOOL_NAME]);
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
      expect(html).toContain('data-dashboard-control-gate data-state="locked"');
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
      expect(html).not.toContain('data-dashboard-control-gate');
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

  test('the panel page the OpenClaw tab frames is served to the worker bearer only', async () => {
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

  test('locked: the controls wait with one reason, and the local pages stay one click away', async () => {
    const page = await onHost({ ...COMPUTER, readOnly: true }, model(), { indexFaster: { on: false } });
    expect(page.text()).toContain(C.locked);
    expect(page.win.document.querySelector('section.on-computer')).not.toBeNull();
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
    expect(unlocked).not.toContain('data-dashboard-control-gate');
    expect(unlocked).toContain('csrf-123');
  });

  test('its policy frames nothing else and is framed by nothing', () => {
    expect(COMPUTER_HOST_PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(COMPUTER_HOST_PAGE_CSP).toContain("default-src 'none'");
    expect(COMPUTER_HOST_PAGE_CSP).toContain("connect-src 'self'");
  });
});
