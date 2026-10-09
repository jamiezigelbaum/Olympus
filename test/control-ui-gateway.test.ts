import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OLYMPUS_DASHBOARD_PANEL_PATH,
  OLYMPUS_DASHBOARD_TOOL_METHOD,
} from '../src/control-ui-contract.ts';
import { defaultConfig } from '../src/core/config.ts';
import {
  DASHBOARD_PANEL_FAILURE_CACHE_MS,
  OLYMPUS_PANEL_FRAME_CSP,
  OLYMPUS_TAB_TOOL_NAMES,
  parseDashboardToolParams,
  registerOlympusDashboardGateway,
  requestDashboardTool,
  resolveGatewayPublicOrigin,
  resolveNativeOAuthOrigin,
  type DashboardFetch,
} from '../src/core/control-ui-gateway.ts';
import {
  DASHBOARD_GATEWAY_CALLBACK_PEER_HEADER,
  DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER,
} from '../src/workers/http.ts';
import { PANEL_TOOL_NAMES } from '../src/workers/chatgpt/dashboard-contract.ts';
import { dashboardResourceHtml } from '../src/workers/chatgpt/dashboard-resource.ts';

type RegisteredHandler = (input: {
  params: Record<string, unknown>;
  client: { invalidated?: boolean; connect?: { scopes?: unknown } } | null;
  respond: (...args: unknown[]) => void;
  context?: { getRuntimeConfig?: () => unknown };
  signal?: AbortSignal;
}) => Promise<void> | void;

describe('OpenClaw native dashboard Gateway bridge', () => {
  test('registers one tool method, the panel page and the callbacks, with profile custody', () => {
    const methods: Array<{ method: string; options: unknown }> = [];
    const routes: string[] = [];
    registerOlympusDashboardGateway({
      registerGatewayMethod(method, _handler, options) {
        methods.push({ method, options });
      },
      registerHttpRoute(route) {
        routes.push(route.path);
      },
    }, configuredWorker());

    expect(methods).toEqual([
      {
        method: OLYMPUS_DASHBOARD_TOOL_METHOD,
        options: { scope: 'operator.read', profileAccess: 'required' },
      },
    ]);
    expect(routes).toEqual([
      OLYMPUS_DASHBOARD_PANEL_PATH,
      '/oauth/callback/gmail',
      '/oauth/callback/gmail/done',
      '/oauth/callback/google-drive',
      '/oauth/callback/google-drive/done',
      '/oauth/callback/dropbox',
      '/oauth/callback/dropbox/done',
      '/oauth/callback/x',
      '/oauth/callback/x/done',
    ]);
  });

  test('the tab runs exactly the panel\'s tools (the native bundle keeps its own copy of the list)', () => {
    expect([...OLYMPUS_TAB_TOOL_NAMES]).toEqual([...PANEL_TOOL_NAMES]);
  });

  test('the dashboard read needs operator.read and keeps worker auth server-side', async () => {
    const registrations = gatewayRegistrations(async (url, init) => {
      expect(String(url)).toBe('http://source-worker.test/dashboard/tools/call');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer worker-secret');
      expect(headers.get(DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER)).toBe('https://gateway.example');
      expect(JSON.parse(String(init?.body))).toEqual({ name: 'olympus_dashboard', arguments: {} });
      return Response.json({ content: [{ type: 'text', text: 'ok' }], structuredContent: { kind: 'dashboard' } });
    });
    const calls: unknown[][] = [];
    await registrations.methods.get(OLYMPUS_DASHBOARD_TOOL_METHOD)!({
      params: { name: 'olympus_dashboard' },
      client: { connect: { scopes: ['operator.read'] } },
      context: { getRuntimeConfig: () => ({ gateway: { publicOrigin: 'https://gateway.example' } }) },
      respond: (...args) => calls.push(args),
    });
    expect(calls).toEqual([[true, { content: [{ type: 'text', text: 'ok' }], structuredContent: { kind: 'dashboard' } }]]);
    expect(JSON.stringify(calls)).not.toContain('worker-secret');
  });

  test('every other panel tool needs operator.write; a missing scope never reaches the worker', async () => {
    let fetched = 0;
    const registrations = gatewayRegistrations(async () => {
      fetched += 1;
      return Response.json({ content: [] });
    });
    const missing: unknown[][] = [];
    await registrations.methods.get(OLYMPUS_DASHBOARD_TOOL_METHOD)!({
      params: { name: 'olympus_disconnect_source', arguments: { source_id: 'dropbox.files' } },
      client: { connect: { scopes: ['operator.read'] } },
      respond: (...args) => missing.push(args),
    });
    expect(missing).toEqual([[false, undefined, { code: 'INVALID_REQUEST', message: 'Operator write scope is required.' }]]);
    const none: unknown[][] = [];
    await registrations.methods.get(OLYMPUS_DASHBOARD_TOOL_METHOD)!({
      params: { name: 'olympus_dashboard' },
      client: { connect: { scopes: [] } },
      respond: (...args) => none.push(args),
    });
    expect(none).toEqual([[false, undefined, { code: 'INVALID_REQUEST', message: 'Operator read scope is required.' }]]);
    expect(fetched).toBe(0);

    const allowed: unknown[][] = [];
    await registrations.methods.get(OLYMPUS_DASHBOARD_TOOL_METHOD)!({
      params: { name: 'olympus_disconnect_source', arguments: { source_id: 'dropbox.files' } },
      // OpenClaw's operator.write scope implies operator.read.
      client: { connect: { scopes: ['operator.write'] } },
      respond: (...args) => allowed.push(args),
    });
    expect(allowed[0]?.[0]).toBe(true);
    expect(fetched).toBe(1);
  });

  test('only the panel\'s tools pass, with closed params; a worker refusal is a tool error', async () => {
    expect(() => parseDashboardToolParams({ name: 'olympus_search', arguments: {} })).toThrow();
    expect(() => parseDashboardToolParams({ name: 'olympus_index_faster', arguments: { on: true } })).toThrow();
    expect(() => parseDashboardToolParams({ name: 'olympus_dashboard', path: '/arbitrary' })).toThrow('unknown field');
    expect(() => parseDashboardToolParams({ name: 'olympus_dashboard', arguments: 'x' })).toThrow('must be an object');
    expect(parseDashboardToolParams({ name: 'olympus_dashboard' })).toEqual({ name: 'olympus_dashboard', arguments: {} });

    const refused = await requestDashboardTool({
      call: { name: 'olympus_dashboard', arguments: {} },
      config: configuredWorker(),
      fetchImpl: async () => Response.json({ error: { code: 'unknown_tool', message: 'This tool is not available here.' } }, { status: 404 }),
    });
    expect(refused).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'This tool is not available here.' }],
      structuredContent: { error: 'unknown_tool' },
    });
  });

  test('worker deadline remains active while a response body is stalled', async () => {
    const partial = new TextEncoder().encode('{"content":');
    const started = Date.now();
    await expect(requestDashboardTool({
      call: { name: 'olympus_dashboard', arguments: {} },
      config: configuredWorker(),
      timeoutMs: 20,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(partial);
          // Deliberately neither close nor error: headers and one chunk arrive,
          // then the worker body stalls forever.
        },
      })),
    })).rejects.toThrow('worker is unavailable');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('the panel page is the worker\'s own panel, served with a frame-only policy, and fails closed', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let html = '<!doctype html><html><body>panel</body></html>';
    const registrations = gatewayRegistrations(async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
    });
    const route = registrations.routes.get(OLYMPUS_DASHBOARD_PANEL_PATH)!;
    const served = mockResponse();
    await route({ method: 'GET', url: OLYMPUS_DASHBOARD_PANEL_PATH, headers: {} } as unknown as IncomingMessage, served.value);
    expect(served.statusCode()).toBe(200);
    expect(served.body()).toBe(html);
    expect(served.headers.get('content-security-policy')).toBe(OLYMPUS_PANEL_FRAME_CSP);
    expect(OLYMPUS_PANEL_FRAME_CSP).toContain("frame-ancestors 'self'");
    expect(OLYMPUS_PANEL_FRAME_CSP).toContain("default-src 'none'");
    expect(requests[0]?.url).toBe('http://source-worker.test/dashboard/panel');
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer worker-secret');

    const post = mockResponse();
    await route({ method: 'POST', url: OLYMPUS_DASHBOARD_PANEL_PATH, headers: {} } as unknown as IncomingMessage, post.value);
    expect(post.statusCode()).toBe(405);

    html = 'not a page';
    const broken = gatewayRegistrations(async () => new Response(html, { status: 200 }));
    const failed = mockResponse();
    await broken.routes.get(OLYMPUS_DASHBOARD_PANEL_PATH)!({ method: 'GET', url: OLYMPUS_DASHBOARD_PANEL_PATH, headers: {} } as unknown as IncomingMessage, failed.value);
    expect(failed.statusCode()).toBe(503);
    expect(failed.body()).not.toContain('not a page');
  });

  test('the panel route is the Gateway\'s own public route: the frame cannot carry a bearer, and the page has no data', async () => {
    const registered: Array<{ path: string; auth?: unknown; match?: unknown }> = [];
    registerOlympusDashboardGateway({
      registerGatewayMethod() {},
      registerHttpRoute(route) {
        registered.push({ path: route.path, auth: (route as { auth?: unknown }).auth, match: (route as { match?: unknown }).match });
      },
    }, configuredWorker());
    // 'plugin': the plugin answers it itself, with no Gateway auth in front.
    // Safe because it serves only the static panel (the same page ChatGPT
    // loads); every byte of data arrives through the tool method, under the
    // operator's scopes.
    expect(registered.find((route) => route.path === OLYMPUS_DASHBOARD_PANEL_PATH)).toEqual({ path: OLYMPUS_DASHBOARD_PANEL_PATH, auth: 'plugin', match: 'exact' });
    const panel = dashboardResourceHtml();
    expect(panel.startsWith('<!doctype html>')).toBe(true);
    expect(panel).not.toMatch(/"generatedAt"|"sources":\s*\[/);
  });

  test('the frame policy admits the real panel: inline script and style only, nothing fetched, framed by the Control UI\'s own origin', () => {
    const panel = dashboardResourceHtml();
    // Every script and style is inline, and nothing loads from anywhere: the
    // policy has no source for any of it but 'unsafe-inline' and data: images.
    expect(panel).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(panel).not.toMatch(/<link[^>]*rel=["']?stylesheet/i);
    expect(panel).not.toMatch(/<img[^>]*\ssrc=["']?(?!data:)/i);
    expect(panel).toMatch(/<script>/);
    expect(OLYMPUS_PANEL_FRAME_CSP.split('; ')).toEqual([
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      'img-src data:',
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ]);
    // The panel talks to its host by postMessage only: no fetch target, so no connect-src.
    expect(OLYMPUS_PANEL_FRAME_CSP).not.toContain('connect-src');
  });

  test('a worker that is down is asked once, not once per request: failures are remembered briefly and misses share one read', async () => {
    let fetches = 0;
    let release: (() => void) | undefined;
    const registrations = gatewayRegistrations(async () => {
      fetches += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error('worker down');
    });
    const route = registrations.routes.get(OLYMPUS_DASHBOARD_PANEL_PATH)!;
    const request = { method: 'GET', url: OLYMPUS_DASHBOARD_PANEL_PATH, headers: {} } as unknown as IncomingMessage;
    const first = mockResponse();
    const second = mockResponse();
    const both = Promise.all([route(request, first.value), route(request, second.value)]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release?.();
    await both;
    expect([first.statusCode(), second.statusCode()]).toEqual([503, 503]);
    expect(fetches).toBe(1);
    const third = mockResponse();
    await route(request, third.value);
    expect(third.statusCode()).toBe(503);
    expect(fetches).toBe(1);
    expect(DASHBOARD_PANEL_FAILURE_CACHE_MS).toBeLessThanOrEqual(10_000);
  });

  test('the OAuth callback reads OpenClaw\'s live config, like start, not the registration-time copy', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => Promise<boolean | void> | boolean | void>();
    registerOlympusDashboardGateway({
      // Registration-time copy: no publicOrigin yet.
      config: { gateway: {} },
      runtime: { config: { current: () => ({ gateway: { publicOrigin: 'https://gateway.example' } }) } },
      registerGatewayMethod() {},
      registerHttpRoute(route) {
        routes.set(route.path, route.handler);
      },
    }, configuredWorker(), {
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), ...(init ? { init } : {}) });
        return new Response(null, { status: 303, headers: { Location: '/oauth/callback/dropbox/done' } });
      },
    });
    const response = mockResponse();
    await routes.get('/oauth/callback/dropbox')!(callbackRequest('203.0.113.10', '203.0.113.10'), response.value);
    expect(response.statusCode()).toBe(303);
    expect(new Headers(requests[0]?.init?.headers).get(DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER))
      .toBe('https://gateway.example');
  });

  test('Connect fails actionably when the Gateway has no public origin', async () => {
    let fetched = false;
    const registrations = gatewayRegistrations(async () => {
      fetched = true;
      return Response.json({ content: [] });
    }, undefined);
    const calls: unknown[][] = [];
    await registrations.methods.get(OLYMPUS_DASHBOARD_TOOL_METHOD)!({
      params: { name: 'olympus_connect_source', arguments: { source: 'dropbox' } },
      client: { connect: { scopes: ['operator.write'] } },
      context: { getRuntimeConfig: () => ({ gateway: {} }) },
      respond: (...args) => calls.push(args),
    });
    expect(fetched).toBe(false);
    expect(calls).toEqual([[true, expect.objectContaining({
      isError: true,
      structuredContent: { error: 'gateway_public_origin_required' },
    })]]);
  });

  test('without publicOrigin, only an attested loopback browser origin and a loopback callback stand in', async () => {
    const fresh = { gateway: { bind: 'loopback', port: 19989 } };
    // The handshake facts OpenClaw records for a local browser: Origin, the
    // Host it arrived with, and a direct local transport. An SSH port forward
    // looks exactly like this too — sshd connects from loopback.
    const local = (origin: string, requestHost: string, isLocalClient: unknown = true) => ({
      origin, requestHost, isLocalClient,
    });
    expect(resolveNativeOAuthOrigin(fresh, local('http://localhost:19989', 'localhost:19989'))).toBe('http://localhost:19989');
    expect(resolveNativeOAuthOrigin(fresh, local('http://127.0.0.1:19989/', '127.0.0.1:19989'))).toBe('http://127.0.0.1:19989');
    expect(resolveNativeOAuthOrigin(fresh, local('http://[::1]:19989', '[::1]:19989'))).toBe('http://[::1]:19989');
    expect(resolveNativeOAuthOrigin(fresh, local('http://LOCALHOST:19989', 'LocalHost:19989'))).toBe('http://localhost:19989');
    // Refused: a non-local client presenting a loopback-shaped origin.
    expect(resolveNativeOAuthOrigin(fresh, local('http://localhost:19989', 'localhost:19989', false))).toBeUndefined();
    expect(resolveNativeOAuthOrigin(fresh, local('http://localhost:19989', 'localhost:19989', 'true'))).toBeUndefined();
    expect(resolveNativeOAuthOrigin(fresh, { origin: 'http://localhost:19989', requestHost: 'localhost:19989' })).toBeUndefined();
    // Refused: an origin whose host is not the Host the connection arrived on.
    expect(resolveNativeOAuthOrigin(fresh, local('http://localhost:19989', 'localhost:28000'))).toBeUndefined();
    expect(resolveNativeOAuthOrigin(fresh, local('http://localhost:19989', '127.0.0.1:19989'))).toBeUndefined();
    expect(resolveNativeOAuthOrigin(fresh, { origin: 'http://localhost:19989', isLocalClient: true })).toBeUndefined();
    // Refused: anything that is not bare loopback http.
    expect(resolveNativeOAuthOrigin(fresh, local('https://gateway.tailnet.example', 'gateway.tailnet.example'))).toBeUndefined();
    expect(resolveNativeOAuthOrigin(fresh, local('http://192.168.1.20:19989', '192.168.1.20:19989'))).toBeUndefined();
    expect(resolveNativeOAuthOrigin(fresh, local('http://localhost:19989/path', 'localhost:19989'))).toBeUndefined();
    expect(resolveNativeOAuthOrigin(fresh, local('http://user@localhost:19989', 'localhost:19989'))).toBeUndefined();
    expect(resolveNativeOAuthOrigin(fresh, 'http://localhost:19989')).toBeUndefined();
    expect(resolveNativeOAuthOrigin(fresh, undefined)).toBeUndefined();
    // A configured publicOrigin always wins over the browser.
    expect(resolveNativeOAuthOrigin(
      { gateway: { publicOrigin: 'https://gateway.example' } },
      local('http://localhost:19989', 'localhost:19989'),
    )).toBe('https://gateway.example');

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const registrations = gatewayRegistrations(async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(null, { status: 303, headers: { Location: '/oauth/callback/dropbox/done' } });
    }, '');
    const route = registrations.routes.get('/oauth/callback/dropbox')!;
    const callback = (remoteAddress: string, host: string, encrypted = false) => ({
      method: 'GET',
      url: '/oauth/callback/dropbox?code=provider-code&state=signed-state',
      headers: { host },
      socket: { remoteAddress, encrypted },
    } as unknown as IncomingMessage);

    const remotePeer = mockResponse();
    await route(callback('203.0.113.10', 'localhost:19989'), remotePeer.value);
    expect(remotePeer.statusCode()).toBe(503);
    const remoteHost = mockResponse();
    await route(callback('127.0.0.1', 'gateway.example'), remoteHost.value);
    expect(remoteHost.statusCode()).toBe(503);
    const tls = mockResponse();
    await route(callback('127.0.0.1', 'localhost:19989', true), tls.value);
    expect(tls.statusCode()).toBe(503);
    expect(requests).toHaveLength(0);

    const loopback = mockResponse();
    await route(callback('::ffff:127.0.0.1', 'localhost:19989'), loopback.value);
    expect(loopback.statusCode()).toBe(303);
    expect(requests).toHaveLength(1);
    expect(new Headers(requests[0]?.init?.headers).get(DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER))
      .toBe('http://localhost:19989');
  });

  test('OAuth callback relays only the fixed source and bounded query, without following redirects', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const registrations = gatewayRegistrations(async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(null, { status: 303, headers: { Location: '/oauth/callback/dropbox/done' } });
    });
    const route = registrations.routes.get('/oauth/callback/dropbox')!;
    const response = mockResponse();
    await route(
      {
        method: 'GET',
        url: '/oauth/callback/dropbox?code=provider-code&state=signed-state',
        socket: { remoteAddress: '203.0.113.10' },
      } as IncomingMessage,
      response.value,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://source-worker.test/oauth/callback/dropbox?code=provider-code&state=signed-state');
    expect(requests[0]?.init?.redirect).toBe('manual');
    expect(new Headers(requests[0]?.init?.headers).get(DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER))
      .toBe('https://gateway.example');
    const callbackPeerHeader = new Headers(requests[0]?.init?.headers).get(DASHBOARD_GATEWAY_CALLBACK_PEER_HEADER);
    expect(callbackPeerHeader).toMatch(/^203\.0\.113\.10\.[A-Za-z0-9_-]{43}$/);
    expect(response.statusCode()).toBe(303);
    expect(response.headers.get('location')).toBe('/oauth/callback/dropbox/done');
    expect(response.body()).not.toContain('provider-code');
    expect(response.body()).not.toContain('signed-state');

    const withProviderMetadata = mockResponse();
    await route(
      { method: 'GET', url: '/oauth/callback/dropbox?code=c&state=s&scope=openid&authuser=0&hd=example.com&prompt=consent&return_to=https://attacker.test' } as IncomingMessage,
      withProviderMetadata.value,
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe('http://source-worker.test/oauth/callback/dropbox?code=c&state=s');
    expect(withProviderMetadata.statusCode()).toBe(303);

    const polluted = mockResponse();
    await route(
      { method: 'GET', url: '/oauth/callback/dropbox?code=c&state=s&state=other' } as IncomingMessage,
      polluted.value,
    );
    expect(requests).toHaveLength(2);
    expect(polluted.statusCode()).toBe(400);
  });

  test('OAuth callback rate limits per trusted peer and ignores spoofed forwarding headers', async () => {
    let forwarded = 0;
    const registrations = gatewayRegistrations(async () => {
      forwarded += 1;
      return new Response(null, { status: 303, headers: { Location: '/oauth/callback/dropbox/done' } });
    });
    const route = registrations.routes.get('/oauth/callback/dropbox')!;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = mockResponse();
      await route(callbackRequest('203.0.113.10', '203.0.113.20'), response.value);
      expect(response.statusCode()).toBe(303);
    }
    expect(forwarded).toBe(30);

    // Changing X-Forwarded-For cannot evade the bucket owned by the actual
    // socket peer.
    const samePeerSpoof = mockResponse();
    await route(callbackRequest('203.0.113.10', '198.51.100.99'), samePeerSpoof.value);
    expect(samePeerSpoof.statusCode()).toBe(410);
    expect(forwarded).toBe(30);

    // A distinct socket peer retains its own budget even when its forwarding
    // header impersonates the flooded peer.
    const distinctPeer = mockResponse();
    await route(callbackRequest('203.0.113.20', '203.0.113.10'), distinctPeer.value);
    expect(distinctPeer.statusCode()).toBe(303);
    expect(forwarded).toBe(31);
  });

  test('the public origin parser is closed', () => {
    expect(resolveGatewayPublicOrigin({ gateway: { publicOrigin: 'https://gateway.example/' } }))
      .toBe('https://gateway.example');
    expect(resolveGatewayPublicOrigin({ gateway: { publicOrigin: 'http://gateway.example' } })).toBeUndefined();
    expect(resolveGatewayPublicOrigin({ gateway: { publicOrigin: 'https://user:pass@gateway.example' } })).toBeUndefined();
    expect(resolveGatewayPublicOrigin({ gateway: { publicOrigin: 'https://gateway.example/path' } })).toBeUndefined();
  });
});

function configuredWorker() {
  const config = defaultConfig();
  config.worker.authToken = 'worker-secret';
  config.email.baseUrl = 'http://source-worker.test/v1';
  return config;
}

function gatewayRegistrations(fetchImpl: DashboardFetch, publicOrigin: string | undefined = 'https://gateway.example') {
  const methods = new Map<string, RegisteredHandler>();
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => Promise<boolean | void> | boolean | void>();
  registerOlympusDashboardGateway({
    config: { gateway: { ...(publicOrigin ? { publicOrigin } : {}) } },
    registerGatewayMethod(method, handler) {
      methods.set(method, handler as RegisteredHandler);
    },
    registerHttpRoute(route) {
      routes.set(route.path, route.handler);
    },
  }, configuredWorker(), { fetchImpl });
  return { methods, routes };
}

function callbackRequest(remoteAddress: string, forwardedFor: string): IncomingMessage {
  return {
    method: 'GET',
    url: '/oauth/callback/dropbox?code=provider-code&state=signed-state',
    headers: {
      'x-forwarded-for': forwardedFor,
      [DASHBOARD_GATEWAY_CALLBACK_PEER_HEADER]: 'attacker-selected-peer.forged',
    },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function mockResponse() {
  let statusCode = 0;
  let body = '';
  const headers = new Map<string, string>();
  const value = {
    set statusCode(value: number) { statusCode = value; },
    get statusCode() { return statusCode; },
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    end(value?: string) { body += value ?? ''; },
  } as unknown as ServerResponse;
  return { value, statusCode: () => statusCode, body: () => body, headers };
}
