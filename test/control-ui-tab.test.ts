/**
 * The Olympus tab in OpenClaw's Control UI (src/control-ui.ts), unified
 * dashboard phase 4: it frames the panel ChatGPT loads, served by the Gateway
 * at OLYMPUS_DASHBOARD_PANEL_PATH, and answers its calls through one Gateway
 * method under the operator's own scopes.
 *
 * What a live Gateway alone can confirm (the Control UI's own frame policy,
 * the route under a real deployment) is checked after merge; this pins
 * everything the plugin itself decides.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import plugin from '../src/control-ui.ts';
import { OLYMPUS_DASHBOARD_PANEL_PATH, OLYMPUS_DASHBOARD_TOOL_METHOD } from '../src/control-ui-contract.ts';
import {
  DASHBOARD_TOOL_NAME,
  INDEX_FASTER_TOOL_NAME,
  OLYMPUS_HOST_CONTEXT_KEY,
  UNPAIR_SOURCE_TOOL_NAME,
} from '../src/workers/chatgpt/dashboard-contract.ts';

const GLOBALS = ['window', 'document', 'HTMLElement'] as const;
const previous = new Map<string, PropertyDescriptor | undefined>();
let win: Window;

beforeEach(() => {
  // The Control UI served under a base path, as a deployment may do.
  win = new Window({ url: 'https://gateway.test/openclaw/plugins/olympus/dashboard', settings: { disableIframePageLoading: true } });
  const values = { window: win, document: win.document, HTMLElement: win.HTMLElement };
  for (const name of GLOBALS) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }
});

afterEach(async () => {
  for (const name of GLOBALS) {
    const descriptor = previous.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await win.happyDOM.close();
});

type Connection = { connected: boolean; canRead: boolean; canWrite: boolean };

/* eslint-disable @typescript-eslint/no-explicit-any */
function mountTab(connection: Connection) {
  const requests: Array<[string, Record<string, unknown> | undefined]> = [];
  const listeners: Array<() => void> = [];
  let page: any;
  let navigation: any;
  const host = {
    connection,
    async request(method: string, params?: Record<string, unknown>) {
      requests.push([method, params]);
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { ran: params?.name } };
    },
    subscribe(listener: () => void) {
      listeners.push(listener);
      return () => undefined;
    },
    navigation: { openPage: () => undefined, pageHref: () => '' },
    ui: {
      registerPage(registered: any) {
        page = registered;
        return () => undefined;
      },
      registerNavigation(item: any) {
        navigation = item;
        return () => undefined;
      },
    },
  };
  const deactivate = plugin.activate(host as any);
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const controller = page.mount(container, { host, signal: new AbortController().signal, props: {}, presented: true });
  const root = container.shadowRoot!;
  const frame = root.querySelector('iframe') as any;
  // The frame's own window: what the panel posts from and the host posts to.
  const received: Array<Record<string, any>> = [];
  const child = { postMessage: (message: Record<string, any>) => received.push(message) };
  if (frame) Object.defineProperty(frame, 'contentWindow', { configurable: true, get: () => child });
  return {
    page,
    navigation,
    root,
    frame,
    requests,
    received,
    controller,
    deactivate,
    changed: () => listeners.forEach((listener) => listener()),
    send: (message: Record<string, unknown>) => win.dispatchEvent(new win.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: child as any })),
    async reply(id: number) {
      for (let i = 0; i < 20; i += 1) {
        const found = received.find((message) => message.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(`no reply to ${id}`);
    },
  };
}

describe('the Olympus tab', () => {
  test('registers one page and one navigation entry, both named Olympus', () => {
    const tab = mountTab({ connected: true, canRead: true, canWrite: true });
    expect(tab.page.id).toBe('dashboard');
    expect(tab.page.label).toBe('Olympus');
    expect(tab.navigation).toMatchObject({ id: 'dashboard', label: 'Olympus', page: { id: 'dashboard' } });
  });

  test('frames the Gateway\'s panel route, sandboxed to scripts only', () => {
    const tab = mountTab({ connected: true, canRead: true, canWrite: true });
    expect(tab.frame).not.toBeNull();
    expect(tab.frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(tab.frame.getAttribute('title')).toBe('Olympus dashboard');
    // Root-absolute on purpose: Gateway plugin routes are served from the
    // Gateway's root, not under the Control UI's base path, so the frame
    // resolves to the same route wherever the Control UI itself is mounted.
    expect(tab.frame.getAttribute('src')).toBe(OLYMPUS_DASHBOARD_PANEL_PATH);
    expect(new URL(tab.frame.getAttribute('src'), win.location.href).href).toBe(`https://gateway.test${OLYMPUS_DASHBOARD_PANEL_PATH}`);
    expect(tab.frame.hasAttribute('srcdoc')).toBe(false);
  });

  test('without a Gateway connection or read access it says so in one line and frames nothing', () => {
    const offline = mountTab({ connected: false, canRead: false, canWrite: false });
    expect(offline.frame).toBeNull();
    expect(offline.root.querySelector('[role="status"]')?.textContent).toBe('Connect to the OpenClaw Gateway to open Olympus.');
    const noRead = mountTab({ connected: true, canRead: false, canWrite: false });
    expect(noRead.frame).toBeNull();
    expect(noRead.root.querySelector('[role="status"]')?.textContent).toContain('operator.read');
  });

  test('ui/initialize tells the panel it is on OpenClaw, with no computer links', async () => {
    const tab = mountTab({ connected: true, canRead: true, canWrite: true });
    tab.send({ id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26' } });
    const reply = await tab.reply(1);
    expect(reply.result.hostContext[OLYMPUS_HOST_CONTEXT_KEY]).toEqual({ kind: 'openclaw', readOnly: false, links: {} });
  });

  test('a panel tool goes to the one Gateway method, with its name and arguments', async () => {
    const tab = mountTab({ connected: true, canRead: true, canWrite: true });
    tab.send({ id: 2, method: 'tools/call', params: { name: 'olympus_sync_source', arguments: { source_id: 'gmail.email' } } });
    expect((await tab.reply(2)).result.structuredContent).toEqual({ ran: 'olympus_sync_source' });
    expect(tab.requests).toEqual([[OLYMPUS_DASHBOARD_TOOL_METHOD, { name: 'olympus_sync_source', arguments: { source_id: 'gmail.email' } }]]);
  });

  test('the computer\'s own tools are never sent: Index faster and Unpair stay on the computer', async () => {
    const tab = mountTab({ connected: true, canRead: true, canWrite: true });
    tab.send({ id: 3, method: 'tools/call', params: { name: INDEX_FASTER_TOOL_NAME, arguments: { on: true } } });
    tab.send({ id: 4, method: 'tools/call', params: { name: UNPAIR_SOURCE_TOOL_NAME, arguments: { source_id: 'telegram.messages' } } });
    expect((await tab.reply(3)).result.isError).toBe(true);
    expect((await tab.reply(4)).result.isError).toBe(true);
    expect(tab.requests).toEqual([]);
  });

  test('operator.read without operator.write: the panel is told it is read-only and only the dashboard read runs', async () => {
    const tab = mountTab({ connected: true, canRead: true, canWrite: false });
    tab.send({ id: 5, method: 'ui/initialize', params: {} });
    expect((await tab.reply(5)).result.hostContext[OLYMPUS_HOST_CONTEXT_KEY].readOnly).toBe(true);
    tab.send({ id: 6, method: 'tools/call', params: { name: 'olympus_sync_source', arguments: { source_id: 'gmail.email' } } });
    expect((await tab.reply(6)).result.isError).toBe(true);
    tab.send({ id: 7, method: 'tools/call', params: { name: DASHBOARD_TOOL_NAME, arguments: {} } });
    await tab.reply(7);
    expect(tab.requests).toEqual([[OLYMPUS_DASHBOARD_TOOL_METHOD, { name: DASHBOARD_TOOL_NAME, arguments: {} }]]);
  });

  test('a message from anywhere but the frame is ignored', async () => {
    const tab = mountTab({ connected: true, canRead: true, canWrite: true });
    win.dispatchEvent(new win.MessageEvent('message', { data: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: DASHBOARD_TOOL_NAME } }, source: win as any }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tab.requests).toEqual([]);
    expect(tab.received).toEqual([]);
  });

  test('dispose stops answering and clears the tab', async () => {
    const tab = mountTab({ connected: true, canRead: true, canWrite: true });
    tab.controller.dispose();
    tab.send({ id: 9, method: 'tools/call', params: { name: DASHBOARD_TOOL_NAME, arguments: {} } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tab.requests).toEqual([]);
    expect(tab.root.childNodes.length).toBe(0);
    tab.deactivate();
  });
});
