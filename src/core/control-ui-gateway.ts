import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OLYMPUS_DASHBOARD_CONTROL_METHOD,
  OLYMPUS_DASHBOARD_READ_METHOD,
  OLYMPUS_DASHBOARD_VIEWS,
  type OlympusDashboardControlParams,
  type OlympusDashboardControlResult,
  type OlympusDashboardOAuthSource,
  type OlympusDashboardReadParams,
  type OlympusDashboardReadResult,
  type OlympusDashboardSourceId,
} from '../control-ui-contract.ts';
import type { OlympusConfig } from './config.ts';
import { workerAuthTokenFromConfig } from './worker-auth.ts';
import {
  createGatewayCallbackPeerHeader,
  DASHBOARD_GATEWAY_CALLBACK_PEER_HEADER,
  DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER,
} from '../workers/http.ts';

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

const DASHBOARD_READ_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const DASHBOARD_CONTROL_RESPONSE_MAX_BYTES = 256 * 1024;
const DASHBOARD_CONTROL_REQUEST_MAX_BYTES = 256 * 1024;
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

/** Register the two scoped RPC methods and the state-authenticated OAuth callbacks. */
export function registerOlympusDashboardGateway(
  api: OlympusDashboardGatewayApi,
  config: OlympusConfig,
  options: OlympusDashboardGatewayOptions = {},
): void {
  if (!api.registerGatewayMethod) return;
  const fetchImpl = options.fetchImpl ?? fetch;
  api.registerGatewayMethod(
    OLYMPUS_DASHBOARD_READ_METHOD,
    async ({ params, client, respond, context, signal }) => {
      if (!gatewayClientHasScope(client, 'operator.read')) {
        respond(false, undefined, { code: 'INVALID_REQUEST', message: 'Operator read scope is required.' });
        return;
      }
      try {
        const result = await requestDashboardRead({
          params: parseDashboardReadParams(params),
          canWrite: gatewayClientHasScope(client, 'operator.write'),
          config,
          openClawConfig: context?.getRuntimeConfig?.() ?? api.config,
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

  api.registerGatewayMethod(
    OLYMPUS_DASHBOARD_CONTROL_METHOD,
    async ({ params, client, respond, context, signal }) => {
      if (!gatewayClientHasScope(client, 'operator.write')) {
        respond(false, undefined, { code: 'INVALID_REQUEST', message: 'Operator write scope is required.' });
        return;
      }
      try {
        const parsed = parseDashboardControlParams(params);
        const openClawConfig = context?.getRuntimeConfig?.() ?? api.config;
        const gatewayPublicOrigin = resolveGatewayPublicOrigin(openClawConfig);
        if (parsed.action === 'start_oauth' && !gatewayPublicOrigin) {
          respond(true, gatewayPublicOriginRequiredResult());
          return;
        }
        const result = await requestDashboardControl({
          params: parsed,
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
    { scope: 'operator.write', profileAccess: 'required' },
  );

  registerOAuthCallbackRoutes(api, config, fetchImpl);
}

export async function requestDashboardRead(input: {
  params: OlympusDashboardReadParams;
  canWrite: boolean;
  config: OlympusConfig;
  openClawConfig?: unknown;
  fetchImpl?: DashboardFetch;
  signal?: AbortSignal;
  /** Test seam; production callers use the configured, capped worker timeout. */
  timeoutMs?: number;
}): Promise<OlympusDashboardReadResult> {
  const authToken = requireWorkerAuthToken(input.config);
  const url = workerRootUrl(input.config, '/dashboard/ui');
  url.searchParams.set('native', '1');
  url.searchParams.set('view', input.params.view);
  url.searchParams.set('can_write', input.canWrite ? '1' : '0');
  if (input.params.source_id !== undefined) url.searchParams.set('source_id', input.params.source_id);
  const headers = workerHeaders(authToken, resolveGatewayPublicOrigin(input.openClawConfig));
  const { response, text: body } = await boundedWorkerRequest({
    fetchImpl: input.fetchImpl ?? fetch,
    url,
    init: { method: 'GET', headers, redirect: 'error' },
    timeoutMs: input.timeoutMs ?? dashboardTimeoutMs(input.config),
    maxResponseBytes: DASHBOARD_READ_RESPONSE_MAX_BYTES,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) {
    throw new DashboardGatewayUnavailableError(`Olympus dashboard worker returned HTTP ${response.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new DashboardGatewayUnavailableError('Olympus dashboard worker returned an invalid response.');
  }
  return parseDashboardReadResult(parsed, input.canWrite);
}

export async function requestDashboardControl(input: {
  params: OlympusDashboardControlParams;
  config: OlympusConfig;
  gatewayPublicOrigin?: string;
  fetchImpl?: DashboardFetch;
  signal?: AbortSignal;
  /** Test seam; production callers use the configured, capped worker timeout. */
  timeoutMs?: number;
}): Promise<OlympusDashboardControlResult> {
  const authToken = requireWorkerAuthToken(input.config);
  const mapped = dashboardControlWorkerRequest(input.params);
  const encoded = JSON.stringify(mapped.body);
  if (Buffer.byteLength(encoded, 'utf8') > DASHBOARD_CONTROL_REQUEST_MAX_BYTES) {
    throw new DashboardGatewayInvalidRequestError('Dashboard control request is too large.');
  }
  const { response, text } = await boundedWorkerRequest({
    fetchImpl: input.fetchImpl ?? fetch,
    url: workerRootUrl(input.config, mapped.path),
    init: {
      method: 'POST',
      headers: workerHeaders(authToken, input.gatewayPublicOrigin, true),
      body: encoded,
      redirect: 'error',
    },
    timeoutMs: input.timeoutMs ?? dashboardTimeoutMs(input.config),
    maxResponseBytes: DASHBOARD_CONTROL_RESPONSE_MAX_BYTES,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  let body: unknown;
  try {
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new DashboardGatewayUnavailableError('Olympus dashboard worker returned an invalid response.');
  }
  if (!isRecord(body)) {
    throw new DashboardGatewayUnavailableError('Olympus dashboard worker returned an invalid response.');
  }
  return { status: response.status, body };
}

export function parseDashboardReadParams(value: unknown): OlympusDashboardReadParams {
  const record = exactRecord(value, ['view', 'source_id']);
  if (!OLYMPUS_DASHBOARD_VIEWS.includes(record.view as never)) {
    throw new DashboardGatewayInvalidRequestError('Unknown Olympus dashboard view.');
  }
  const view = record.view as OlympusDashboardReadParams['view'];
  const sourceId = record.source_id === undefined ? undefined : boundedString(record.source_id, 256, 'source_id');
  if (view === 'source' && sourceId === undefined) {
    throw new DashboardGatewayInvalidRequestError('source_id is required for the source view.');
  }
  if (view !== 'source' && sourceId !== undefined) {
    throw new DashboardGatewayInvalidRequestError('source_id is allowed only for the source view.');
  }
  return { view, ...(sourceId ? { source_id: sourceId } : {}) };
}

export function parseDashboardControlParams(value: unknown): OlympusDashboardControlParams {
  const outer = recordValue(value);
  const action = outer.action;
  if (action === 'save_dispositions') {
    const record = exactRecord(outer, ['action', 'source', 'edits']);
    const source = boundedString(record.source, 256, 'source');
    if (!Array.isArray(record.edits) || record.edits.length === 0 || record.edits.length > 1_000) {
      throw new DashboardGatewayInvalidRequestError('edits must contain between 1 and 1000 changes.');
    }
    const edits = record.edits.map((entry) => {
      const edit = exactRecord(entry, ['path', 'state']);
      const path = boundedString(edit.path, 4_096, 'path', false);
      if (edit.state !== 'ingest' && edit.state !== 'metadata_only' && edit.state !== 'exclude') {
        throw new DashboardGatewayInvalidRequestError('Unknown source disposition state.');
      }
      return { path, state: edit.state as 'ingest' | 'metadata_only' | 'exclude' };
    });
    return { action, source, edits };
  }
  if (action === 'start_oauth') {
    const record = exactRecord(outer, ['action', 'source', 'client_id', 'client_secret']);
    const source = enumValue(record.source, OAUTH_CALLBACK_SOURCES, 'source');
    const clientId = optionalBoundedString(record.client_id, 2_048, 'client_id', false);
    const clientSecret = optionalBoundedString(record.client_secret, 8_192, 'client_secret', false);
    return { action, source, ...(clientId ? { client_id: clientId } : {}), ...(clientSecret ? { client_secret: clientSecret } : {}) };
  }
  if (action === 'cancel_oauth') {
    const record = exactRecord(outer, ['action', 'source']);
    return { action, source: enumValue(record.source, OAUTH_CALLBACK_SOURCES, 'source') };
  }
  if (action === 'connect_api_key') {
    const record = exactRecord(outer, ['action', 'source', 'api_key']);
    return {
      action,
      source: enumValue(record.source, ['venice', 'readwise'] as const, 'source'),
      api_key: boundedString(record.api_key, 8_192, 'api_key', false),
    };
  }
  if (action === 'sync_now') {
    const record = exactRecord(outer, ['action', 'source']);
    return {
      action,
      source: enumValue(record.source, ['gmail', 'google-drive', 'dropbox', 'x', 'readwise'] as const, 'source'),
    };
  }
  if (action === 'set_embedding_priority') {
    const record = exactRecord(outer, ['action', 'on']);
    if (typeof record.on !== 'boolean') throw new DashboardGatewayInvalidRequestError('on must be true or false.');
    return { action, on: record.on };
  }
  if (action === 'disconnect') {
    const record = exactRecord(outer, ['action', 'source_id', 'acknowledge']);
    if (record.acknowledge !== true) throw new DashboardGatewayInvalidRequestError('Disconnect acknowledgement is required.');
    return {
      action,
      source_id: enumValue(record.source_id, [
        'gmail.email',
        'google_drive.docs',
        'dropbox.files',
        'x.bookmarks',
        'telegram.messages',
        'whatsapp.personal.messages',
        'readwise.library',
      ] as const, 'source_id') as OlympusDashboardSourceId,
      acknowledge: true,
    };
  }
  if (action === 'unpair') {
    const record = exactRecord(outer, ['action', 'source_id', 'acknowledge']);
    if (record.acknowledge !== true) throw new DashboardGatewayInvalidRequestError('Unpair acknowledgement is required.');
    return {
      action,
      source_id: enumValue(record.source_id, ['telegram.messages', 'whatsapp.personal.messages'] as const, 'source_id'),
      acknowledge: true,
    };
  }
  throw new DashboardGatewayInvalidRequestError('Unknown Olympus dashboard control action.');
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
        await handleOAuthCallback({ request, response, source, config, openClawConfig: api.config, fetchImpl });
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
  const publicOrigin = resolveGatewayPublicOrigin(input.openClawConfig);
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

function dashboardControlWorkerRequest(params: OlympusDashboardControlParams): {
  path: string;
  body: Record<string, unknown>;
} {
  switch (params.action) {
    case 'save_dispositions':
      return { path: '/dashboard/dispositions', body: { source: params.source, edits: params.edits } };
    case 'start_oauth':
      return {
        path: '/dashboard/connect/oauth/start',
        body: {
          source: params.source,
          ...(params.client_id ? { client_id: params.client_id } : {}),
          ...(params.client_secret ? { client_secret: params.client_secret } : {}),
        },
      };
    case 'cancel_oauth':
      return { path: '/dashboard/connect/oauth/cancel', body: { source: params.source } };
    case 'connect_api_key':
      return { path: '/dashboard/connect/api-key', body: { source: params.source, api_key: params.api_key } };
    case 'sync_now':
      return { path: '/dashboard/sync-now', body: { source: params.source } };
    case 'set_embedding_priority':
      return { path: '/dashboard/embedding-priority', body: { on: params.on } };
    case 'disconnect':
      return { path: '/dashboard/disconnect', body: { source_id: params.source_id, acknowledge: true } };
    case 'unpair':
      return { path: '/dashboard/unpair', body: { source_id: params.source_id, acknowledge: true } };
  }
}

function parseDashboardReadResult(value: unknown, expectedCanWrite: boolean): OlympusDashboardReadResult {
  const record = exactRecord(value, [
    'status',
    'title',
    'body',
    'controller',
    'can_write',
    'signature',
    'poll_interval_ms',
  ]);
  if (!Number.isInteger(record.status) || (record.status as number) < 100 || (record.status as number) > 599) {
    throw new DashboardGatewayUnavailableError('Olympus dashboard worker returned an invalid response.');
  }
  const title = boundedString(record.title, 256, 'title', false);
  const body = boundedString(record.body, DASHBOARD_READ_RESPONSE_MAX_BYTES, 'body', false);
  if (containsExecutableMarkup(body)) {
    throw new DashboardGatewayUnavailableError('Olympus dashboard worker returned executable markup.');
  }
  if (record.controller !== 'dashboard' && record.controller !== 'dispositions') {
    throw new DashboardGatewayUnavailableError('Olympus dashboard worker returned an invalid response.');
  }
  if (record.can_write !== expectedCanWrite) {
    throw new DashboardGatewayUnavailableError('Olympus dashboard worker returned mismatched control authority.');
  }
  const signature = boundedString(record.signature, 128, 'signature');
  if (!Number.isInteger(record.poll_interval_ms)
    || (record.poll_interval_ms as number) < 1_000
    || (record.poll_interval_ms as number) > 300_000) {
    throw new DashboardGatewayUnavailableError('Olympus dashboard worker returned an invalid response.');
  }
  return {
    status: record.status as number,
    title,
    body,
    controller: record.controller,
    can_write: expectedCanWrite,
    signature,
    poll_interval_ms: record.poll_interval_ms as number,
  };
}

function containsExecutableMarkup(html: string): boolean {
  return /<(?:script|style|iframe|object|embed|link|meta|base)\b/i.test(html)
    || /\son[a-z]+\s*=/i.test(html)
    || /\b(?:href|src)\s*=\s*["']?\s*javascript:/i.test(html);
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

function gatewayPublicOriginRequiredResult(): OlympusDashboardControlResult {
  return {
    status: 409,
    body: {
      error: {
        code: 'gateway_public_origin_required',
        status: 409,
        message: 'Set gateway.publicOrigin to the externally reachable Gateway origin before connecting an OAuth source from OpenClaw.',
      },
      policy: { guessed_browser_origin: false, arbitrary_return_to_accepted: false },
    },
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

function boundedString(
  value: unknown,
  maxLength: number,
  label: string,
  trim = true,
): string {
  if (typeof value !== 'string') throw new DashboardGatewayInvalidRequestError(`${label} must be a string.`);
  const normalized = trim ? value.trim() : value;
  if (!normalized.trim() || normalized.length > maxLength || normalized.includes('\0')) {
    throw new DashboardGatewayInvalidRequestError(`${label} is invalid.`);
  }
  return normalized;
}

function optionalBoundedString(
  value: unknown,
  maxLength: number,
  label: string,
  trim = true,
): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, maxLength, label, trim);
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value === 'string' && values.includes(value)) return value as T[number];
  throw new DashboardGatewayInvalidRequestError(`${label} is invalid.`);
}
