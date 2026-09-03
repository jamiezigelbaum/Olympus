import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dashboardQueryTokenFromWorkerAuthToken, normalizeWorkerAuthToken } from '../core/worker-auth.ts';

export const DEFAULT_WORKER_BIND_HOST = '127.0.0.1';

export interface WorkerBearerAuthOptions {
  authToken: string | undefined;
  basePath?: string;
  /** Test seam for bounded control-session expiry. */
  now?: () => number;
}

/**
 * How long a browser stays unlocked after one paste of the worker token
 * (owner ruling, 2026-09-02: once the dashboard is set up, the token is not
 * asked for again and again).
 *
 * The session is a STATELESS signed cookie: nonce, issue time, an origin
 * binding, and an HMAC over all of it keyed by the worker token itself.
 * Nothing is stored on the worker, so a restart does not log the browser out;
 * the token never enters the cookie; and rotating the worker token revokes
 * every session at once. The lifetime is FIXED from issue, never slid or
 * re-issued: a stateless cookie that could renew itself would let a copied
 * cookie outlive the browser it was copied from. A month later the owner
 * pastes once more. The Lock control clears this browser's cookie.
 */
export const DASHBOARD_CONTROL_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER = 'X-Olympus-Control-Session-CSRF';
const DASHBOARD_CONTROL_COOKIE = 'olympus_dashboard_control';
const DASHBOARD_CONTROL_SIGNATURE_CONTEXT = 'olympus-dashboard-control-session-v3';
const DASHBOARD_CONTROL_CSRF_CONTEXT = 'olympus-dashboard-control-csrf-v2';
const DASHBOARD_CONTROL_ORIGIN_CONTEXT = 'olympus-dashboard-control-origin-v2';

export function resolveWorkerBindHost(
  env: Record<string, string | undefined>,
  legacyEnvNames: string[] = [],
): string {
  return firstNonEmptyEnv(env, ['OLYMPUS_WORKER_BIND_HOST', ...legacyEnvNames]) ?? DEFAULT_WORKER_BIND_HOST;
}

export function workerAuthTokenFromEnv(env: Record<string, string | undefined>): string | undefined {
  return normalizeWorkerAuthToken(env.OLYMPUS_WORKER_AUTH_TOKEN);
}

export function warnIfWorkerAuthDisabled(
  workerName: string,
  authToken: string | undefined,
  bindHost = DEFAULT_WORKER_BIND_HOST,
): void {
  if (authToken) return;
  if (!isLoopbackBindHost(bindHost)) {
    throw new Error(
      `${workerName} cannot bind to ${bindHost} without OLYMPUS_WORKER_AUTH_TOKEN; set a worker auth token or bind to loopback.`,
    );
  }
  console.warn(
    `[olympus] WARNING: ${workerName} has no OLYMPUS_WORKER_AUTH_TOKEN; only the bare health endpoint is available on ${bindHost}.`,
  );
}

export function withWorkerBearerAuth(
  fetchHandler: (request: Request) => Promise<Response>,
  options: WorkerBearerAuthOptions,
): (request: Request) => Promise<Response> {
  const authToken = normalizeWorkerAuthToken(options.authToken);
  const basePath = normalizeBasePath(options.basePath ?? '/v1');
  const now = options.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    request = withoutDashboardControlContextHeader(request);
    if (isUnauthenticatedHealthRequest(request, basePath)) {
      return fetchHandler(request);
    }
    if (!authToken) {
      return workerAuthRequiredResponse();
    }
    if (isDashboardControlLockRequest(request)) {
      // Lock this browser: proven the same way any control is (cookie, same
      // origin, CSRF), then the cookie is cleared. Copies elsewhere are not
      // reachable from here; rotating the worker token is what revokes those.
      const authorization = authorizeDashboardControlSession(request, authToken, now(), true);
      if (authorization.status === 'origin_mismatch' || authorization.status === 'csrf_mismatch') {
        return dashboardControlForbiddenResponse(authorization.status);
      }
      // No live session, no lock: an unauthenticated route that clears a
      // cookie is a logout-CSRF endpoint, however harmless it looks.
      if (authorization.status !== 'allowed') return unauthorizedWorkerResponse();
      return dashboardControlLockedResponse();
    }
    if (isDashboardControlSessionRequest(request)) {
      if (!hasValidWorkerBearerToken(request.headers.get('Authorization'), authToken)) {
        // Keepalive from a page that is still being worked on. A live session
        // may extend itself with the custody it already proves on every control
        // POST — HttpOnly cookie, matching CSRF token, same origin — so the
        // picker never has to handle the worker bearer to stay alive.
        const renewal = authorizeDashboardControlSession(request, authToken, now(), true);
        if (renewal.status === 'allowed') {
          return dashboardControlSessionResponse(renewal.sessionId, renewal.csrfToken, renewal.expiresAtMs, now());
        }
        if (renewal.status === 'origin_mismatch' || renewal.status === 'csrf_mismatch') {
          return dashboardControlForbiddenResponse(renewal.status);
        }
        return unauthorizedWorkerResponse();
      }
      const origin = sameRequestOrigin(request);
      if (!origin) return dashboardControlForbiddenResponse('origin_mismatch');
      const minted = mintDashboardControlSession(authToken, origin, now());
      return dashboardControlSessionResponse(minted.sessionId, minted.csrfToken, minted.expiresAtMs, now());
    }
    if (isOAuthCallbackRequest(request)) {
      return fetchHandler(request);
    }
    if (isDashboardQueryTokenRequest(request, authToken)) {
      // The dash_ token authorizes reading. A separately minted HttpOnly
      // control session may upgrade this browser's dashboard render without
      // ever putting the worker bearer in the URL or page storage. The internal
      // header is stripped from the incoming request above and injected only
      // after cookie plus same-origin Referer prove the live session.
      const authorization = authorizeDashboardControlSession(request, authToken, now(), false);
      if (authorization.status === 'allowed') {
        const response = await fetchHandler(withDashboardControlContextHeader(request, authorization.csrfToken));
        return withRenewedDashboardControlCookie(response, authorization, now());
      }
      return fetchHandler(request);
    }
    if (hasValidWorkerBearerToken(request.headers.get('Authorization'), authToken)) {
      return fetchHandler(request);
    }
    if (isDashboardControlReadRoute(request)) {
      const authorization = authorizeDashboardControlSession(request, authToken, now(), false);
      if (authorization.status === 'allowed') {
        const response = await fetchHandler(withDashboardControlContextHeader(request, authorization.csrfToken));
        return withRenewedDashboardControlCookie(response, authorization, now());
      }
      if (authorization.status === 'origin_mismatch') {
        return dashboardControlForbiddenResponse(authorization.status);
      }
    }
    if (isDashboardControlRoute(request)) {
      const authorization = authorizeDashboardControlSession(request, authToken, now(), true);
      if (authorization.status === 'allowed') {
        return withRenewedDashboardControlCookie(await fetchHandler(request), authorization, now());
      }
      if (authorization.status === 'origin_mismatch' || authorization.status === 'csrf_mismatch') {
        return dashboardControlForbiddenResponse(authorization.status);
      }
    }
    return unauthorizedWorkerResponse();
  };
}

function isDashboardControlReadRoute(request: Request): boolean {
  if (request.method !== 'GET') return false;
  const path = new URL(request.url).pathname;
  return path === '/dashboard/dispositions' || path === '/dashboard/dispositions.json';
}

function isDashboardControlSessionRequest(request: Request): boolean {
  return request.method === 'POST' && new URL(request.url).pathname === '/dashboard/control/session';
}

function isDashboardControlLockRequest(request: Request): boolean {
  return request.method === 'POST' && new URL(request.url).pathname === '/dashboard/control/session/lock';
}

function dashboardControlLockedResponse(): Response {
  return new Response(JSON.stringify({ ok: true, locked: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': `${DASHBOARD_CONTROL_COOKIE}=; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=0`,
    },
  });
}

function isDashboardControlRoute(request: Request): boolean {
  if (request.method !== 'POST') return false;
  return new Set([
    '/dashboard/dispositions',
    '/dashboard/connect/oauth/start',
    '/dashboard/connect/oauth/cancel',
    '/dashboard/connect/api-key',
    '/dashboard/sync-now',
    '/dashboard/embedding-priority',
    '/dashboard/disconnect',
    '/dashboard/unpair',
  ]).has(new URL(request.url).pathname);
}

interface AuthorizedDashboardControlSession {
  status: 'allowed';
  /** The cookie value to (re)send: the same one, or a re-issued one. */
  sessionId: string;
  csrfToken: string;
  expiresAtMs: number;
}

interface DashboardControlSessionParts {
  nonce: string;
  issuedSeconds: number;
  originTag: string;
  signature: string;
}

function hmacTag(authToken: string, context: string, ...parts: string[]): string {
  const mac = createHmac('sha256', authToken).update(context);
  for (const part of parts) mac.update('\0').update(part);
  return mac.digest('base64url');
}

function dashboardControlOriginTag(authToken: string, origin: string): string {
  return hmacTag(authToken, DASHBOARD_CONTROL_ORIGIN_CONTEXT, origin).slice(0, 22);
}

function dashboardControlSignature(authToken: string, parts: Omit<DashboardControlSessionParts, 'signature'>): string {
  return hmacTag(
    authToken,
    DASHBOARD_CONTROL_SIGNATURE_CONTEXT,
    parts.nonce,
    String(parts.issuedSeconds),
    parts.originTag,
  );
}

function dashboardControlCsrfToken(authToken: string, nonce: string): string {
  return hmacTag(authToken, DASHBOARD_CONTROL_CSRF_CONTEXT, nonce);
}

function encodeDashboardControlSession(parts: DashboardControlSessionParts): string {
  return [parts.nonce, parts.issuedSeconds, parts.originTag, parts.signature].join('.');
}

function decodeDashboardControlSession(value: string): DashboardControlSessionParts | undefined {
  const fields = value.split('.');
  if (fields.length !== 4) return undefined;
  const [nonce, issued, originTag, signature] = fields as [string, string, string, string];
  const issuedSeconds = Number(issued);
  if (!/^[A-Za-z0-9_-]{32}$/.test(nonce)) return undefined;
  if (!/^\d{1,12}$/.test(issued) || !Number.isInteger(issuedSeconds)) return undefined;
  if (!/^[A-Za-z0-9_-]{22}$/.test(originTag) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return undefined;
  return { nonce, issuedSeconds, originTag, signature };
}

function dashboardControlExpiresAtMs(parts: Pick<DashboardControlSessionParts, 'issuedSeconds'>): number {
  return (parts.issuedSeconds + DASHBOARD_CONTROL_SESSION_TTL_SECONDS) * 1000;
}

function mintDashboardControlSession(
  authToken: string,
  origin: string,
  nowMs: number,
): AuthorizedDashboardControlSession {
  const nowSeconds = Math.floor(nowMs / 1000);
  const unsigned = {
    nonce: randomBytes(24).toString('base64url'),
    issuedSeconds: nowSeconds,
    originTag: dashboardControlOriginTag(authToken, origin),
  };
  const parts = { ...unsigned, signature: dashboardControlSignature(authToken, unsigned) };
  return {
    status: 'allowed',
    sessionId: encodeDashboardControlSession(parts),
    csrfToken: dashboardControlCsrfToken(authToken, parts.nonce),
    expiresAtMs: dashboardControlExpiresAtMs(parts),
  };
}

function authorizeDashboardControlSession(
  request: Request,
  authToken: string,
  nowMs: number,
  requireCsrf: boolean,
): AuthorizedDashboardControlSession | { status: 'missing' | 'origin_mismatch' | 'csrf_mismatch' } {
  const cookie = cookieValue(request.headers.get('Cookie'), DASHBOARD_CONTROL_COOKIE);
  if (!cookie) return { status: 'missing' };
  const parts = decodeDashboardControlSession(cookie);
  if (!parts) return { status: 'missing' };
  // Signature first: a cookie this worker's token did not sign is no session
  // at all, whatever else it claims. Then lifetime, then origin, then CSRF.
  const expected = dashboardControlSignature(authToken, parts);
  if (!constantTimeStringEqual(parts.signature, expected)) return { status: 'missing' };
  const expiresAtMs = dashboardControlExpiresAtMs(parts);
  // A cookie dated in the future was not issued by this worker's clock.
  if (expiresAtMs <= nowMs || parts.issuedSeconds * 1000 > nowMs + 5 * 60_000) return { status: 'missing' };
  const origin = sameRequestOrigin(request, !requireCsrf);
  if (origin === undefined) return { status: 'origin_mismatch' };
  if (!constantTimeStringEqual(parts.originTag, dashboardControlOriginTag(authToken, origin))) {
    return { status: 'origin_mismatch' };
  }
  const csrfToken = dashboardControlCsrfToken(authToken, parts.nonce);
  if (requireCsrf) {
    const presented = request.headers.get('X-Olympus-CSRF');
    if (!presented || !constantTimeStringEqual(presented, csrfToken)) return { status: 'csrf_mismatch' };
  }
  // Never re-issued: the cookie the browser holds is the cookie it keeps,
  // with its remaining life, until it expires or is locked.
  return {
    status: 'allowed',
    sessionId: encodeDashboardControlSession(parts),
    csrfToken,
    expiresAtMs,
  };
}

/**
 * A renewed session is worthless if the browser has already dropped the cookie,
 * so every renewal re-sends it with the remaining life as its Max-Age.
 */
function withRenewedDashboardControlCookie(
  response: Response,
  session: AuthorizedDashboardControlSession,
  nowMs: number,
): Response {
  const headers = new Headers(response.headers);
  headers.append(
    'Set-Cookie',
    dashboardControlSessionCookie(session.sessionId, remainingSessionSeconds(session.expiresAtMs, nowMs)),
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function dashboardControlSessionResponse(
  sessionId: string,
  csrfToken: string,
  expiresAtMs: number,
  nowMs: number,
): Response {
  return new Response(JSON.stringify({
    ok: true,
    csrf_token: csrfToken,
    expires_at: new Date(expiresAtMs).toISOString(),
    policy: {
      bearer_token_persisted_in_browser_storage: false,
      http_only_cookie: true,
      csrf_required: true,
      origin_bound: true,
    },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': dashboardControlSessionCookie(sessionId, remainingSessionSeconds(expiresAtMs, nowMs)),
    },
  });
}

function dashboardControlSessionCookie(sessionId: string, maxAgeSeconds: number): string {
  return `${DASHBOARD_CONTROL_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=${maxAgeSeconds}`;
}

function remainingSessionSeconds(expiresAtMs: number, nowMs: number): number {
  return Math.max(1, Math.round((expiresAtMs - nowMs) / 1000));
}

function sameRequestOrigin(request: Request, allowReferer = false): string | undefined {
  const claimed = request.headers.get('Origin')
    ?? (allowReferer ? request.headers.get('Referer') : null);
  if (!claimed || claimed === 'null') return undefined;
  let origin: string;
  try {
    origin = new URL(claimed).origin;
  } catch {
    return undefined;
  }
  const url = new URL(request.url);
  const direct = url.origin;
  const forwardedProto = request.headers.get('X-Forwarded-Proto')?.split(',')[0]?.trim().toLowerCase();
  const forwarded = forwardedProto === 'http' || forwardedProto === 'https'
    ? `${forwardedProto}://${url.host}`
    : direct;
  return origin === forwarded ? origin : undefined;
}

function withoutDashboardControlContextHeader(request: Request): Request {
  if (!request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER);
  return new Request(request, { headers });
}

function withDashboardControlContextHeader(request: Request, csrfToken: string): Request {
  const headers = new Headers(request.headers);
  headers.set(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER, csrfToken);
  return new Request(request, { headers });
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_.-]{32,200}$/.test(value) ? value : undefined;
  }
  return undefined;
}

function dashboardControlForbiddenResponse(reason: 'origin_mismatch' | 'csrf_mismatch'): Response {
  return new Response(JSON.stringify({
    error: {
      code: 'dashboard_control_forbidden',
      status: 403,
      message: reason === 'origin_mismatch'
        ? 'Dashboard control request origin does not match this control session.'
        : 'Dashboard control request is missing the matching CSRF token.',
    },
    policy: {
      raw_runtime_secrets_exposed: false,
      control_session_required: true,
    },
  }), {
    status: 403,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// OAuth providers cannot attach the dashboard bearer token to loopback
// redirects. The callback is authorized by the high-entropy OAuth state that
// the dashboard worker keeps only in memory.
function isOAuthCallbackRequest(request: Request): boolean {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.pathname.startsWith('/oauth/callback/');
}

// Browsers cannot attach Authorization headers from the address bar, so the
// two read-only dashboard GET routes accept a derived dash_ query token.
// Query-token access never receives the worker bearer token and cannot call
// dashboard control routes; operators paste the bearer token in the dashboard
// when they want to connect sources or trigger syncs.
function isDashboardQueryTokenRequest(request: Request, expectedToken: string): boolean {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.pathname !== '/dashboard' && url.pathname !== '/dashboard.json') return false;
  const token = url.searchParams.get('token');
  if (!token) return false;
  const expectedDashboardToken = dashboardQueryTokenFromWorkerAuthToken(expectedToken);
  return Boolean(expectedDashboardToken && constantTimeStringEqual(token, expectedDashboardToken));
}

function isUnauthenticatedHealthRequest(request: Request, basePath: string): boolean {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.pathname === `${basePath}/health` && url.search === '';
}

export function hasValidWorkerBearerToken(header: string | null, expectedToken: string): boolean {
  if (!header) return false;
  const [scheme, ...rest] = header.split(' ');
  if (scheme !== 'Bearer' || rest.length !== 1) return false;
  return constantTimeStringEqual(rest[0] ?? '', expectedToken);
}

function constantTimeStringEqual(actual: string, expected: string): boolean {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  const maxLength = Math.max(actualBytes.byteLength, expectedBytes.byteLength, 1);
  const actualPadded = new Uint8Array(maxLength);
  const expectedPadded = new Uint8Array(maxLength);
  actualPadded.set(actualBytes.slice(0, maxLength));
  expectedPadded.set(expectedBytes.slice(0, maxLength));
  return timingSafeEqual(actualPadded, expectedPadded) && actualBytes.byteLength === expectedBytes.byteLength;
}

function workerAuthRequiredResponse(): Response {
  return new Response(JSON.stringify({
    error: {
      code: 'worker_auth_required',
      status: 503,
      message: 'Worker auth is not configured; set OLYMPUS_WORKER_AUTH_TOKEN before using worker routes.',
    },
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      raw_runtime_secrets_exposed: false,
    },
  }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unauthorizedWorkerResponse(): Response {
  return new Response(JSON.stringify({
    error: {
      code: 'unauthorized',
      status: 401,
      message: 'Worker bearer token does not match this worker. Do not paste the dash_ URL token here.',
    },
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      raw_runtime_secrets_exposed: false,
    },
  }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

function firstNonEmptyEnv(env: Record<string, string | undefined>, names: string[]): string | undefined {
  for (const name of names) {
    const value = optionalEnv(env[name]);
    if (value) return value;
  }
  return undefined;
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
