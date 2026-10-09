import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OLYMPUS_DASHBOARD_PANEL_PATH,
  OLYMPUS_DASHBOARD_TOOL_METHOD,
  type OlympusDashboardOAuthSource,
} from '../control-ui-contract.ts';
import type { OlympusConfig } from './config.ts';
import { workerAuthTokenFromConfig } from './worker-auth.ts';
import {
  createGatewayCallbackPeerHeader,
  DASHBOARD_GATEWAY_CALLBACK_PEER_HEADER,
  DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER,
} from '../workers/http.ts';

/**
 * The tools the Olympus tab's panel may call through the Gateway: the
 * panel's own (workers/chatgpt/dashboard-contract.ts PANEL_TOOL_NAMES),
 * spelled here so the native plugin does not bundle the ChatGPT contract.
 * The worker checks its own list again (dashboard-panel-tools.ts).
 */
export const OLYMPUS_TAB_TOOL_NAMES = [
  'olympus_dashboard',
  'olympus_connect_source',
  'olympus_scope_list',
  'olympus_scope_set',
  'olympus_disconnect_source',
  'olympus_model_set',
  'olympus_model_retry',
  'olympus_privacy_get',
  'olympus_privacy_set',
  'olympus_sync_source',
] as const;

/** The one tool an operator.read connection may call: the dashboard read. */
const OLYMPUS_TAB_READ_TOOL = 'olympus_dashboard';

/**
 * The framed panel's own policy: its inline script and style, data: images,
 * no network (it talks only through postMessage), framed only by the
 * Control UI on this same Gateway origin.
 */
export const OLYMPUS_PANEL_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

type GatewayErrorCode = 'INVALID_REQUEST' | 'UNAVAILABLE';
type GatewayRespond = (
  ok: boolean,
  payload?: unknown,
  error?: { code: GatewayErrorCode; message: string },
  meta?: Record<string, unknown>,
) => void;

interface GatewayClientLike {
  invalidated?: boolean;
  connect?: { scopes?: unknown };
  /**
   * The browser-origin facts OpenClaw captured for this WebSocket client at
   * the handshake: the Origin header, the Host header it arrived with, and
   * whether the transport was a direct local connection.
   */
  browserOrigin?: { origin?: unknown; requestHost?: unknown; isLocalClient?: unknown };
}

interface GatewayRequestHandlerInput {
  params: Record<string, unknown>;
  client: GatewayClientLike | null;
  respond: GatewayRespond;
  context?: { getRuntimeConfig?: () => unknown };
  signal?: AbortSignal;
}

type GatewayRequestHandler = (input: GatewayRequestHandlerInput) => Promise<void> | void;

export interface OlympusDashboardGatewayApi {
  config?: unknown;
  /** OpenClaw's live config snapshot; `config` is only the registration-time copy. */
  runtime?: { config?: { current?: () => unknown } };
  registerGatewayMethod?(method: string, handler: GatewayRequestHandler, options?: {
    scope?: 'operator.read' | 'operator.write';
    profileAccess?: 'independent' | 'required';
  }): void;
  registerHttpRoute?(route: {
    path: string;
    auth: 'plugin';
    match: 'exact';
    handler(request: IncomingMessage, response: ServerResponse): Promise<boolean | void> | boolean | void;
  }): void;
}

export interface OlympusDashboardGatewayOptions {
  fetchImpl?: DashboardFetch;
}

export type DashboardFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A tool result (the dashboard view model, a picker page) is bounded like the old page reads were. */
const DASHBOARD_TOOL_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const DASHBOARD_TOOL_REQUEST_MAX_BYTES = 256 * 1024;
const DASHBOARD_CONTROL_RESPONSE_MAX_BYTES = 256 * 1024;
const DASHBOARD_PANEL_MAX_BYTES = 2 * 1024 * 1024;
/** The panel HTML changes only with the worker's build; one read serves many opens. */
const DASHBOARD_PANEL_CACHE_MS = 5 * 60_000;
const OAUTH_CALLBACK_URL_MAX_BYTES = 16 * 1024;
const DASHBOARD_TIMEOUT_MAX_MS = 180_000;
const DASHBOARD_TIMEOUT_MIN_MS = 1_000;
const OAUTH_CALLBACK_SOURCES = ['gmail', 'google-drive', 'dropbox', 'x'] as const;
const OAUTH_CALLBACK_RATE_LIMIT_WINDOW_MS = 60_000;
const OAUTH_CALLBACK_RATE_LIMIT_MAX_PER_WINDOW = 30;
const OAUTH_CALLBACK_RATE_LIMIT_MAX_BUCKETS = 1_024;

interface OAuthCallbackRateLimitBucket {
  windowStart: number;
  count: number;
}

class DashboardGatewayInvalidRequestError extends Error {}
class DashboardGatewayUnavailableError extends Error {}

/**
 * Register the Olympus tab's Gateway surface: the panel page its frame loads,
 * the one tool method the panel's calls go through, and the
 * state-authenticated OAuth callbacks.
 */
export function registerOlympusDashboardGateway(
  api: OlympusDashboardGatewayApi,
  config: OlympusConfig,
  options: OlympusDashboardGatewayOptions = {},
): void {
  if (!api.registerGatewayMethod) return;
  const fetchImpl = options.fetchImpl ?? fetch;
  // operator.read to reach the method at all; each tool then needs its own
  // scope: the dashboard read needs read, everything else needs write.
  api.registerGatewayMethod(
    OLYMPUS_DASHBOARD_TOOL_METHOD,
    async ({ params, client, respond, context, signal }) => {
      try {
        const call = parseDashboardToolParams(params);
        const scope = call.name === OLYMPUS_TAB_READ_TOOL ? 'operator.read' : 'operator.write';
        if (!gatewayClientHasScope(client, scope)) {
          respond(false, undefined, { code: 'INVALID_REQUEST', message: scope === 'operator.read' ? 'Operator read scope is required.' : 'Operator write scope is required.' });
          return;
        }
        const gatewayPublicOrigin = resolveNativeOAuthOrigin(currentOpenClawConfig(api, context), client?.browserOrigin);
        if (call.name === 'olympus_connect_source' && !gatewayPublicOrigin) {
          respond(true, gatewayPublicOriginRequiredResult());
          return;
        }
        const result = await requestDashboardTool({
          call,
          config,
          ...(gatewayPublicOrigin ? { gatewayPublicOrigin } : {}),
          fetchImpl,
          ...(signal ? { signal } : {}),
        });
        respond(true, result);
      } catch (error) {
        respondDashboardGatewayError(respond, error);
      }
    },
    { scope: 'operator.read', profileAccess: 'required' },
  );

  registerPanelRoute(api, config, fetchImpl);
  registerOAuthCallbackRoutes(api, config, fetchImpl);
}

export interface DashboardToolCall {
  name: typeof OLYMPUS_TAB_TOOL_NAMES[number];
  arguments: Record<string, unknown>;
}

/** `{name, arguments?}`, the name one of the panel's tools, the arguments an object. */
export function parseDashboardToolParams(value: unknown): DashboardToolCall {
  const record = exactRecord(value, ['name', 'arguments']);
  const name = enumValue(record.name, OLYMPUS_TAB_TOOL_NAMES, 'name');
  const args = record.arguments === undefined ? {} : record.arguments;
  if (!isRecord(args)) throw new DashboardGatewayInvalidRequestError('Dashboard tool arguments must be an object.');
  return { name, arguments: args };
}

/** One panel tool call, forwarded to the worker's POST /dashboard/tools/call with the worker bearer. */
export async function requestDashboardTool(input: {
  call: DashboardToolCall;
  config: OlympusConfig;
  gatewayPublicOrigin?: string;
  fetchImpl?: DashboardFetch;
  signal?: AbortSignal;
  /** Test seam; production callers use the configured, capped worker timeout. */
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const authToken = requireWorkerAuthToken(input.config);
  const encoded = JSON.stringify({ name: input.call.name, arguments: input.call.arguments });
  if (Buffer.byteLength(encoded, 'utf8') > DASHBOARD_TOOL_REQUEST_MAX_BYTES) {
    throw new DashboardGatewayInvalidRequestError('Dashboard tool request is too large.');
  }
  const { response, text } = await boundedWorkerRequest({
    fetchImpl: input.fetchImpl ?? fetch,
    url: workerRootUrl(input.config, '/dashboard/tools/call'),
    init: {
      method: 'POST',
      headers: workerHeaders(authToken, input.gatewayPublicOrigin, true),
      body: encoded,
      redirect: 'error',
    },
    timeoutMs: input.timeoutMs ?? dashboardTimeoutMs(input.config),
    maxResponseBytes: DASHBOARD_TOOL_RESPONSE_MAX_BYTES,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new DashboardGatewayUnavailableError('Olympus dashboard worker returned an invalid response.');
  }
  if (!isRecord(body)) throw new DashboardGatewayUnavailableError('Olympus dashboard worker returned an invalid response.');
  if (response.status < 200 || response.status >= 300) {
    // The worker refused (an unknown tool, models not ready): the panel shows
    // a tool error, not a dead connection.
    const error = isRecord(body.error) ? body.error : {};
    const message = typeof error.message === 'string' ? error.message.slice(0, 400) : 'Olympus could not do that.';
    return { isError: true, content: [{ type: 'text', text: message }], structuredContent: { error: typeof error.code === 'string' ? error.code : 'internal' } };
  }
  return body;
}

/**
 * GET OLYMPUS_DASHBOARD_PANEL_PATH: the panel HTML the tab frames, read from
 * the worker (GET /dashboard/panel) so it is always the running engine's own
 * page. It is the same static page ChatGPT loads and carries no data: the
 * data arrives only through the tool method, under the operator's scopes.
 */
function registerPanelRoute(api: OlympusDashboardGatewayApi, config: OlympusConfig, fetchImpl: DashboardFetch): void {
  if (!api.registerHttpRoute) return;
  let cached: { html: string; at: number } | undefined;
  api.registerHttpRoute({
    path: OLYMPUS_DASHBOARD_PANEL_PATH,
    auth: 'plugin',
    match: 'exact',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.statusCode = 405;
        response.end();
        return true;
      }
      try {
        if (!cached || Date.now() - cached.at > DASHBOARD_PANEL_CACHE_MS) {
          const authToken = requireWorkerAuthToken(config);
          const { response: worker, text } = await boundedWorkerRequest({
            fetchImpl,
            url: workerRootUrl(config, '/dashboard/panel'),
            init: { method: 'GET', headers: workerHeaders(authToken), redirect: 'error' },
            timeoutMs: dashboardTimeoutMs(config),
            maxResponseBytes: DASHBOARD_PANEL_MAX_BYTES,
          });
          if (worker.status !== 200 || !text.startsWith('<!doctype html>')) throw new DashboardGatewayUnavailableError('panel unavailable');
          cached = { html: text, at: Date.now() };
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', OLYMPUS_PANEL_FRAME_CSP);
        response.end(cached.html);
      } catch {
        response.statusCode = 503;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end('Olympus is not reachable right now.');
      }
      return true;
    },
  });
}

export function resolveGatewayPublicOrigin(value: unknown): string | undefined {
  const root = isRecord(value) ? value : undefined;
  const gateway = isRecord(root?.gateway) ? root.gateway : undefined;
  const raw = typeof gateway?.publicOrigin === 'string' ? gateway.publicOrigin.trim() : '';
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    if (url.protocol === 'https:') return url.origin;
    if (url.protocol !== 'http:') return undefined;
    const hostname = url.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One config source for every Gateway path: the call's own runtime config,
 * then OpenClaw's live snapshot, then the registration-time copy. The OAuth
 * start and its callback must agree on `gateway.publicOrigin`, and only the
 * live snapshot follows a config change without a plugin reload.
 */
function currentOpenClawConfig(
  api: OlympusDashboardGatewayApi,
  context?: { getRuntimeConfig?: () => unknown },
): unknown {
  return context?.getRuntimeConfig?.() ?? api.runtime?.config?.current?.() ?? api.config;
}

/**
 * The origin a native OAuth flow returns to.
 *
 * `gateway.publicOrigin` wins whenever it is configured. Without it, a fresh
 * loopback install falls back to the operator's own browser origin, but only
 * when all of these hold for the facts OpenClaw captured at the WebSocket
 * handshake: the transport was a direct local connection (`isLocalClient`),
 * the Origin is plain http on localhost, 127.0.0.1 or [::1] with no path, and
 * the Origin's host equals the Host header the connection arrived with — the
 * same host comparison as OpenClaw's own `isGatewayHostBrowserOrigin`. A
 * browser on the Gateway host or behind the operator's SSH port forward
 * passes; a remote client or an Origin naming some other address does not.
 * Requiring `gateway.publicOrigin` for this case left every fresh install on
 * the bring-your-own walkthrough with a disabled button (beta.5 fresh install
 * on a clean Linux user, 2026-09-24). A provider code then reaches software on
 * the operator's own machine, and the callback route re-derives the same origin
 * from the loopback request it arrives on. Any https or remote origin still
 * needs `gateway.publicOrigin`.
 */
export function resolveNativeOAuthOrigin(openClawConfig: unknown, browserOrigin: unknown): string | undefined {
  return resolveGatewayPublicOrigin(openClawConfig) ?? localLoopbackBrowserOrigin(browserOrigin);
}

function localLoopbackBrowserOrigin(value: unknown): string | undefined {
  if (!isRecord(value) || value.isLocalClient !== true) return undefined;
  const origin = loopbackHttpOrigin(value.origin);
  if (!origin || typeof value.requestHost !== 'string') return undefined;
  const requestHost = value.requestHost.trim().toLowerCase();
  return requestHost && new URL(origin).host === requestHost ? origin : undefined;
}

function loopbackHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw || raw.length > 256) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.username || url.password) return undefined;
    if (url.pathname !== '/' || url.search || url.hash) return undefined;
    return isLoopbackHostname(url.hostname) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const peer = address.trim().toLowerCase();
  return peer === '::1' || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(peer);
}

/**
 * The loopback origin a relay-bounced callback arrived on, when no
 * `gateway.publicOrigin` is configured. It counts only for a plain-http request
 * from a loopback socket peer naming a loopback Host — the shape of a browser on
 * the Gateway host or behind the operator's own port forward. The worker still
 * requires this origin to equal the one signed into the flow's state.
 */
function loopbackCallbackOrigin(request: IncomingMessage): string | undefined {
  if ((request.socket as { encrypted?: boolean } | undefined)?.encrypted === true) return undefined;
  if (!isLoopbackPeer(request.socket?.remoteAddress)) return undefined;
  const host = request.headers?.host;
  if (typeof host !== 'string' || !host || host.length > 256 || /[\s/@?#\\]/.test(host)) return undefined;
  return loopbackHttpOrigin(`http://${host}`);
}

function registerOAuthCallbackRoutes(
  api: OlympusDashboardGatewayApi,
  config: OlympusConfig,
  fetchImpl: DashboardFetch,
): void {
  if (!api.registerHttpRoute) return;
  const callbackRateLimiter = createOAuthCallbackRateLimiter();
  for (const source of OAUTH_CALLBACK_SOURCES) {
    api.registerHttpRoute({
      path: `/oauth/callback/${source}`,
      auth: 'plugin',
      match: 'exact',
      handler: async (request, response) => {
        // Provider redirects are intentionally unauthenticated. Bound the
        // cheap relay work per source and trusted peer before touching the
        // worker; forwarded headers are caller-controlled on this route.
        if (request.method === 'GET'
          && !callbackRateLimiter(`${source}:${trustedCallbackPeer(request)}`, Date.now())) {
          writeCallbackPage(response, false, 410);
          return true;
        }
        await handleOAuthCallback({ request, response, source, config, openClawConfig: currentOpenClawConfig(api), fetchImpl });
        return true;
      },
    });
    api.registerHttpRoute({
      path: `/oauth/callback/${source}/done`,
      auth: 'plugin',
      match: 'exact',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          writeCallbackPage(response, false, 405);
          return true;
        }
        writeCallbackPage(response, true, 200);
        return true;
      },
    });
  }
}

/**
 * Fixed-window callback limiter with a hard bucket bound. This is an abuse
 * control for the unauthenticated provider redirect, not the OAuth state
 * boundary; the relay still verifies the signed state in the worker.
 */
function createOAuthCallbackRateLimiter(): (key: string, now: number) => boolean {
  const buckets = new Map<string, OAuthCallbackRateLimitBucket>();
  return (key: string, now: number): boolean => {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.windowStart >= OAUTH_CALLBACK_RATE_LIMIT_WINDOW_MS) buckets.delete(bucketKey);
    }
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= OAUTH_CALLBACK_RATE_LIMIT_WINDOW_MS) {
      if (!bucket && buckets.size >= OAUTH_CALLBACK_RATE_LIMIT_MAX_BUCKETS) {
        const oldest = buckets.keys().next().value as string | undefined;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      bucket = { windowStart: now, count: 0 };
      buckets.set(key, bucket);
    }
    if (bucket.count >= OAUTH_CALLBACK_RATE_LIMIT_MAX_PER_WINDOW) return false;
    bucket.count += 1;
    return true;
  };
}

/** Node's socket peer is Gateway-owned; X-Forwarded-For is not. */
function trustedCallbackPeer(request: IncomingMessage): string {
  const address = request.socket?.remoteAddress?.trim();
  return address || 'unknown';
}

async function handleOAuthCallback(input: {
  request: IncomingMessage;
  response: ServerResponse;
  source: OlympusDashboardOAuthSource;
  config: OlympusConfig;
  openClawConfig?: unknown;
  fetchImpl: DashboardFetch;
}): Promise<void> {
  if (input.request.method !== 'GET') {
    writeCallbackPage(input.response, false, 405);
    return;
  }
  const publicOrigin = resolveGatewayPublicOrigin(input.openClawConfig) ?? loopbackCallbackOrigin(input.request);
  const authToken = workerAuthTokenFromConfig(input.config);
  if (!publicOrigin || !authToken) {
    writeCallbackPage(input.response, false, 503);
    return;
  }
  let inbound: URL;
  try {
    const raw = input.request.url ?? '';
    if (Buffer.byteLength(raw, 'utf8') > OAUTH_CALLBACK_URL_MAX_BYTES) throw new Error('too large');
    inbound = new URL(raw, publicOrigin);
  } catch {
    writeCallbackPage(input.response, false, 400);
    return;
  }
  if (inbound.pathname !== `/oauth/callback/${input.source}` || !validOAuthCallbackQuery(inbound.searchParams)) {
    writeCallbackPage(input.response, false, 400);
    return;
  }
  const workerUrl = workerRootUrl(input.config, `/oauth/callback/${input.source}`);
  for (const key of ['code', 'state', 'error', 'error_description'] as const) {
    const value = inbound.searchParams.get(key);
    if (value !== null) workerUrl.searchParams.set(key, value);
  }
  try {
    const { response: worker } = await boundedWorkerRequest({
      fetchImpl: input.fetchImpl,
      url: workerUrl,
      init: {
        method: 'GET',
        headers: workerHeaders(
          authToken,
          publicOrigin,
          false,
          createGatewayCallbackPeerHeader(trustedCallbackPeer(input.request), authToken),
        ),
        // The worker's success is a relative redirect to its clean /done URL.
        // Never follow it: doing so could carry the worker bearer into a future
        // redirect-policy regression, and the Gateway returns its own inert page.
        redirect: 'manual',
      },
      timeoutMs: dashboardTimeoutMs(input.config),
      maxResponseBytes: DASHBOARD_CONTROL_RESPONSE_MAX_BYTES,
    });
    const expectedLocation = `/oauth/callback/${input.source}/done`;
    if (worker.status === 303 && worker.headers.get('Location') === expectedLocation) {
      writeCallbackRedirect(input.response, expectedLocation);
      return;
    }
    writeCallbackPage(input.response, false, worker.status);
  } catch {
    writeCallbackPage(input.response, false, 502);
  }
}

function validOAuthCallbackQuery(search: URLSearchParams): boolean {
  // OAuth providers may add response metadata (`scope`, `authuser`, `hd`,
  // `prompt`, and future fields). RFC 6749 requires clients to ignore unknown
  // response parameters. Validate the security-bearing fields and drop the
  // rest when projecting the callback into the worker.
  const known = new Set(['code', 'state', 'error', 'error_description']);
  const limits: Record<string, number> = { code: 8_192, state: 4_096, error: 256, error_description: 2_048 };
  const seen = new Set<string>();
  for (const [key, value] of search) {
    if (!known.has(key)) continue;
    if (seen.has(key) || value.length === 0 || value.length > (limits[key] ?? 0)) return false;
    seen.add(key);
  }
  return seen.has('state') && (seen.has('code') !== seen.has('error'));
}

function writeCallbackPage(response: ServerResponse, ok: boolean, status: number): void {
  const safeStatus = status >= 400 && status <= 599 ? status : ok ? 200 : 400;
  const title = ok ? 'Olympus connection complete' : 'Olympus connection was not completed';
  const detail = ok
    ? 'Return to Olympus in OpenClaw. You can close this tab.'
    : 'Return to Olympus in OpenClaw for the current status, then close this tab.';
  response.statusCode = safeStatus;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:0 1.5rem;color:#202124}h1{font-size:1.35rem}</style></head><body><h1>${title}</h1><p>${detail}</p></body></html>`);
}

function writeCallbackRedirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader('Location', location);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.end();
}

function gatewayClientHasScope(client: GatewayClientLike | null, scope: 'operator.read' | 'operator.write'): boolean {
  if (!client || client.invalidated === true) return false;
  const scopes = Array.isArray(client.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes('operator.admin')
    || scopes.includes(scope)
    || (scope === 'operator.read' && scopes.includes('operator.write'));
}

function respondDashboardGatewayError(respond: GatewayRespond, error: unknown): void {
  if (error instanceof DashboardGatewayInvalidRequestError) {
    respond(false, undefined, { code: 'INVALID_REQUEST', message: error.message });
    return;
  }
  const message = error instanceof DashboardGatewayUnavailableError
    ? error.message
    : 'Olympus dashboard worker is unavailable.';
  respond(false, undefined, { code: 'UNAVAILABLE', message });
}

/** Connect from OpenClaw with nowhere for the provider to send the person back to. */
function gatewayPublicOriginRequiredResult(): Record<string, unknown> {
  return {
    isError: true,
    content: [{ type: 'text', text: 'Set gateway.publicOrigin to the externally reachable Gateway origin before connecting a source from OpenClaw.' }],
    structuredContent: { error: 'gateway_public_origin_required' },
  };
}

function requireWorkerAuthToken(config: OlympusConfig): string {
  const token = workerAuthTokenFromConfig(config);
  if (!token) throw new DashboardGatewayUnavailableError('Olympus worker authentication is not configured.');
  return token;
}

function workerRootUrl(config: OlympusConfig, path: string): URL {
  try {
    const base = new URL(config.email.baseUrl);
    return new URL(path, base.origin);
  } catch {
    throw new DashboardGatewayUnavailableError('Olympus worker URL is not configured correctly.');
  }
}

function workerHeaders(
  authToken: string,
  gatewayPublicOrigin?: string,
  json = false,
  callbackPeerHeader?: string,
): Headers {
  const headers = new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${authToken}`,
  });
  if (json) headers.set('Content-Type', 'application/json');
  if (gatewayPublicOrigin) headers.set(DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER, gatewayPublicOrigin);
  if (callbackPeerHeader) headers.set(DASHBOARD_GATEWAY_CALLBACK_PEER_HEADER, callbackPeerHeader);
  return headers;
}

function dashboardTimeoutMs(config: OlympusConfig): number {
  const configured = Math.round(config.email.requestTimeoutSeconds * 1_000);
  return Math.min(DASHBOARD_TIMEOUT_MAX_MS, Math.max(DASHBOARD_TIMEOUT_MIN_MS, configured));
}

async function boundedWorkerRequest(input: {
  fetchImpl: DashboardFetch;
  url: URL;
  init: RequestInit;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
}): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('dashboard timeout')), input.timeoutMs);
  try {
    const response = await input.fetchImpl(input.url, { ...input.init, signal: controller.signal });
    const text = await readBoundedResponseText(response, input.maxResponseBytes, controller.signal);
    return { response, text };
  } catch (error) {
    if (error instanceof DashboardGatewayUnavailableError) throw error;
    throw new DashboardGatewayUnavailableError('Olympus dashboard worker is unavailable.');
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
  }
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  let rejectAbort!: (error: DashboardGatewayUnavailableError) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new DashboardGatewayUnavailableError('Olympus dashboard worker is unavailable.'));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new DashboardGatewayUnavailableError('Olympus dashboard worker response is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = recordValue(value);
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new DashboardGatewayInvalidRequestError('Dashboard request contains an unknown field.');
  }
  return record;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new DashboardGatewayInvalidRequestError('Dashboard request must be an object.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value === 'string' && values.includes(value)) return value as T[number];
  throw new DashboardGatewayInvalidRequestError(`${label} is invalid.`);
}
