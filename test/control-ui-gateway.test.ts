import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OLYMPUS_DASHBOARD_CONTROL_METHOD,
  OLYMPUS_DASHBOARD_READ_METHOD,
} from '../src/control-ui-contract.ts';
import { defaultConfig } from '../src/core/config.ts';
import {
  parseDashboardControlParams,
  parseDashboardReadParams,
  registerOlympusDashboardGateway,
  requestDashboardRead,
  resolveGatewayPublicOrigin,
  type DashboardFetch,
} from '../src/core/control-ui-gateway.ts';
import { DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER } from '../src/workers/http.ts';

type RegisteredHandler = (input: {
  params: Record<string, unknown>;
  client: { invalidated?: boolean; connect?: { scopes?: unknown } } | null;
  respond: (...args: unknown[]) => void;
  context?: { getRuntimeConfig?: () => unknown };
  signal?: AbortSignal;
}) => Promise<void> | void;

describe('OpenClaw native dashboard Gateway bridge', () => {
  test('registers read and write RPCs with exact scopes and profile custody', () => {
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
        method: OLYMPUS_DASHBOARD_READ_METHOD,
        options: { scope: 'operator.read', profileAccess: 'required' },
      },
      {
        method: OLYMPUS_DASHBOARD_CONTROL_METHOD,
        options: { scope: 'operator.write', profileAccess: 'required' },
      },
    ]);
    expect(routes).toEqual([
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

  test('read RPC derives write presentation from the live client and keeps worker auth server-side', async () => {
    const registrations = gatewayRegistrations(async (url, init) => {
      expect(String(url)).toBe('http://source-worker.test/dashboard/ui?native=1&view=source&can_write=1&source_id=dropbox.files');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer worker-secret');
      expect(headers.get(DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER)).toBe('https://gateway.example');
      return Response.json({
        status: 200,
        title: 'Dropbox',
        body: '<main class="frame">Dropbox</main>',
        controller: 'dashboard',
        can_write: true,
        signature: 'a'.repeat(64),
        poll_interval_ms: 5_000,
      });
    });
    const calls: unknown[][] = [];
    await registrations.methods.get(OLYMPUS_DASHBOARD_READ_METHOD)!({
      params: { view: 'source', source_id: 'dropbox.files' },
      // OpenClaw's operator.write scope implies operator.read.
      client: { connect: { scopes: ['operator.write'] } },
      context: { getRuntimeConfig: () => ({ gateway: { publicOrigin: 'https://gateway.example' } }) },
      respond: (...args) => calls.push(args),
    });
    expect(calls).toEqual([[true, expect.objectContaining({ can_write: true, title: 'Dropbox' })]]);
    expect(JSON.stringify(calls)).not.toContain('worker-secret');
  });

  test('callbacks defensively reject missing scopes and executable worker markup', async () => {
    const registrations = gatewayRegistrations(async () => Response.json({
      status: 200,
      title: 'Olympus',
      body: '<main>ok</main><script>alert(1)</script>',
      controller: 'dashboard',
      can_write: false,
      signature: 'b'.repeat(64),
      poll_interval_ms: 5_000,
    }));
    const missing: unknown[][] = [];
    await registrations.methods.get(OLYMPUS_DASHBOARD_READ_METHOD)!({
      params: { view: 'home' },
      client: { connect: { scopes: [] } },
      respond: (...args) => missing.push(args),
    });
    expect(missing).toEqual([[false, undefined, {
      code: 'INVALID_REQUEST',
      message: 'Operator read scope is required.',
    }]]);

    const executable: unknown[][] = [];
    await registrations.methods.get(OLYMPUS_DASHBOARD_READ_METHOD)!({
      params: { view: 'home' },
      client: { connect: { scopes: ['operator.read'] } },
      respond: (...args) => executable.push(args),
    });
    expect(executable).toEqual([[false, undefined, {
      code: 'UNAVAILABLE',
      message: 'Olympus dashboard worker returned executable markup.',
    }]]);
  });

  test('worker deadline remains active while a response body is stalled', async () => {
    const partial = new TextEncoder().encode('{"status":200');
    const started = Date.now();
    await expect(requestDashboardRead({
      params: { view: 'home' },
      canWrite: false,
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

  test('write RPC maps only declared actions and never forwards caller headers or routes', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const registrations = gatewayRegistrations(async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return Response.json({ ok: true, source: 'readwise', policy: { api_key_returned: false } });
    });
    const calls: unknown[][] = [];
    await registrations.methods.get(OLYMPUS_DASHBOARD_CONTROL_METHOD)!({
      params: { action: 'connect_api_key', source: 'readwise', api_key: 'rk-secret' },
      client: { connect: { scopes: ['operator.write'] } },
      context: { getRuntimeConfig: () => ({ gateway: { publicOrigin: 'https://gateway.example' } }) },
      respond: (...args) => calls.push(args),
    });
    expect(requests[0]?.url).toBe('http://source-worker.test/dashboard/connect/api-key');
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer worker-secret');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ source: 'readwise', api_key: 'rk-secret' });
    expect(calls).toEqual([[true, {
      status: 200,
      body: { ok: true, source: 'readwise', policy: { api_key_returned: false } },
    }]]);
    expect(JSON.stringify(calls)).not.toContain('rk-secret');

    expect(() => parseDashboardControlParams({
      action: 'connect_api_key',
      source: 'readwise',
      api_key: 'key',
      path: '/arbitrary',
    })).toThrow('unknown field');
  });

  test('OAuth start fails actionably when Gateway public origin is absent', async () => {
    let fetched = false;
    const registrations = gatewayRegistrations(async () => {
      fetched = true;
      return Response.json({ ok: true });
    }, undefined);
    const calls: unknown[][] = [];
    await registrations.methods.get(OLYMPUS_DASHBOARD_CONTROL_METHOD)!({
      params: { action: 'start_oauth', source: 'dropbox' },
      client: { connect: { scopes: ['operator.write'] } },
      context: { getRuntimeConfig: () => ({ gateway: {} }) },
      respond: (...args) => calls.push(args),
    });
    expect(fetched).toBe(false);
    expect(calls).toEqual([[true, expect.objectContaining({
      status: 409,
      body: expect.objectContaining({ error: expect.objectContaining({ code: 'gateway_public_origin_required' }) }),
    })]]);
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
      { method: 'GET', url: '/oauth/callback/dropbox?code=provider-code&state=signed-state' } as IncomingMessage,
      response.value,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://source-worker.test/oauth/callback/dropbox?code=provider-code&state=signed-state');
    expect(requests[0]?.init?.redirect).toBe('manual');
    expect(new Headers(requests[0]?.init?.headers).get(DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER))
      .toBe('https://gateway.example');
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

  test('read/action schemas and public origin parser are closed', () => {
    expect(parseDashboardReadParams({ view: 'embedding_ledger' })).toEqual({ view: 'embedding_ledger' });
    expect(() => parseDashboardReadParams({ view: 'source' })).toThrow('source_id is required');
    expect(() => parseDashboardReadParams({ view: 'home', source_id: 'x' })).toThrow('only for the source view');
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
