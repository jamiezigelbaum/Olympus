/**
 * Olympus's Google token-exchange endpoint.
 *
 * Contract and threat model: docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md. In one
 * sentence: this is the smallest possible service that holds
 * `GOOGLE_CLIENT_SECRET` so the open-source Olympus worker never has to.
 *
 * Routes (both POST only):
 *   POST /exchange/google          {code, code_verifier, redirect_uri, state?}
 *   POST /exchange/google/refresh  {refresh_token}
 *
 * Every response — success or failure, from this endpoint or forwarded from
 * Google — is `Cache-Control: no-store` and carries no cookies. Nothing here
 * ever logs a request or response body: see `logRequest` for the one thing
 * that is logged.
 */

import {
  exchangeGoogleAuthorizationCode,
  refreshGoogleAccessToken,
  type GoogleExchangeCredentials,
  type GoogleFetch,
  type GoogleUpstreamOutcome,
} from './google.ts';
import { isAllowedRedirectUri, parseAllowedRedirectUris } from './redirect-allowlist.ts';
import { checkRateLimit, type RateLimitBinding, type RateLimitResult } from './rate-limit.ts';
import { parseExchangeRequest, parseRefreshRequest } from './schema.ts';

export interface Env {
  /** Public identifier — a var, not a secret (see wrangler.toml). */
  GOOGLE_CLIENT_ID: string;
  /** `wrangler secret put GOOGLE_CLIENT_SECRET` — never a var, never committed. */
  GOOGLE_CLIENT_SECRET: string;
  /** Comma-separated exact `redirect_uri` matches, in addition to loopback forms. */
  ALLOWED_REDIRECT_URIS?: string;
  /** Optional: created and bound by the owner. Absent fails open (see rate-limit.ts). */
  RATE_LIMIT_KV?: RateLimitBinding;
  RATE_LIMIT_MAX?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
}

export interface Deps {
  fetchImpl: GoogleFetch;
  now: () => number;
}

const defaultDeps: Deps = { fetchImpl: fetch, now: () => Date.now() };

/** Generous for `{code, code_verifier, redirect_uri, state}` or `{refresh_token}`; tight against abuse payloads. */
const MAX_BODY_BYTES = 8 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_MAX = 20;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

// The one production relay URL (docs/ops/OAUTH_RELAY.md, "Hosting"). This is
// the only `redirect_uri` the publisher web client's authorization requests
// ever use, so it is the sane default allowlist even before the owner sets
// `ALLOWED_REDIRECT_URIS`.
export const DEFAULT_ALLOWED_REDIRECT_URI = 'https://auth.olympusplugin.ai/oauth/callback/';

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, defaultDeps);
  },
};

export async function handleRequest(request: Request, env: Env, deps: Deps = defaultDeps): Promise<Response> {
  const url = new URL(request.url);
  const startedAt = deps.now();
  let outcome: { status: number; error?: string } = { status: 500 };
  try {
    if (request.method !== 'POST') {
      outcome = { status: 405, error: 'method_not_allowed' };
      return errorResponse(405, 'method_not_allowed', 'Only POST is accepted.');
    }
    if (hasBrowserOrigin(request)) {
      // Server-to-server only. A real browser cross-origin POST always
      // carries an `Origin` header; the Olympus worker calling this endpoint
      // never does. No CORS headers are ever returned either way, so a
      // browser call fails even if this check somehow did not fire.
      outcome = { status: 403, error: 'browser_origin_refused' };
      return errorResponse(403, 'browser_origin_refused', 'This endpoint accepts only server-to-server requests.');
    }
    if (url.pathname === '/exchange/google') {
      const response = await handleExchange(request, env, deps);
      outcome = { status: response.status };
      return response;
    }
    if (url.pathname === '/exchange/google/refresh') {
      const response = await handleRefresh(request, env, deps);
      outcome = { status: response.status };
      return response;
    }
    outcome = { status: 404, error: 'not_found' };
    return errorResponse(404, 'not_found', 'Unknown route.');
  } catch {
    // An unexpected exception must never serialize itself (or the `env` /
    // `request` it closed over) into a response. Fixed string only.
    outcome = { status: 500, error: 'internal_error' };
    return errorResponse(500, 'internal_error', 'Unexpected error.');
  } finally {
    logRequest(url.pathname, outcome.status, deps.now() - startedAt);
  }
}

async function handleExchange(request: Request, env: Env, deps: Deps): Promise<Response> {
  const rateLimited = await enforceRateLimit(request, env, deps);
  if (rateLimited) return rateLimited;

  const body = await readBoundedJson(request, MAX_BODY_BYTES);
  if (!body.ok) return errorResponse(body.status, body.error, body.message);

  const parsed = parseExchangeRequest(body.value);
  if (!parsed.ok) return errorResponse(400, parsed.error, parsed.message);

  const allowed = parseAllowedRedirectUris(env.ALLOWED_REDIRECT_URIS, [DEFAULT_ALLOWED_REDIRECT_URI]);
  if (!isAllowedRedirectUri(parsed.value.redirectUri, allowed)) {
    return errorResponse(400, 'redirect_uri_not_allowed', 'redirect_uri is not on the allowlist.');
  }

  // `state` is accepted and validated for shape, then never used again: this
  // endpoint holds no per-user key, so it cannot verify the relay state's
  // HMAC signature. See docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md, "Why state
  // verification is not possible here". It is not forwarded to Google and
  // never logged.

  const outcome = await exchangeGoogleAuthorizationCode(
    credentials(env),
    { code: parsed.value.code, codeVerifier: parsed.value.codeVerifier, redirectUri: parsed.value.redirectUri },
    deps.fetchImpl,
    UPSTREAM_TIMEOUT_MS,
  );
  return respondFromGoogle(outcome);
}

async function handleRefresh(request: Request, env: Env, deps: Deps): Promise<Response> {
  const rateLimited = await enforceRateLimit(request, env, deps);
  if (rateLimited) return rateLimited;

  const body = await readBoundedJson(request, MAX_BODY_BYTES);
  if (!body.ok) return errorResponse(body.status, body.error, body.message);

  const parsed = parseRefreshRequest(body.value);
  if (!parsed.ok) return errorResponse(400, parsed.error, parsed.message);

  const outcome = await refreshGoogleAccessToken(
    credentials(env),
    { refreshToken: parsed.value.refreshToken },
    deps.fetchImpl,
    UPSTREAM_TIMEOUT_MS,
  );
  return respondFromGoogle(outcome);
}

function credentials(env: Env): GoogleExchangeCredentials {
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

function respondFromGoogle(outcome: GoogleUpstreamOutcome): Response {
  if (!outcome.ok) {
    if (outcome.kind === 'timeout') return errorResponse(504, 'upstream_timeout', 'Google token endpoint did not respond in time.');
    if (outcome.kind === 'oversized_response') {
      // Nothing of the body is echoed: an answer this large is not a token
      // response, and repeating any of it would forward whatever produced it.
      return errorResponse(502, 'upstream_response_too_large', 'Google token endpoint returned an oversized response.');
    }
    return errorResponse(502, 'upstream_unreachable', 'Could not reach the Google token endpoint.');
  }
  // Passed through unchanged (docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md): Google's
  // token response never contains this endpoint's own secret, so there is
  // nothing to redact. Headers are rebuilt from scratch rather than copied,
  // so nothing Google or an intermediary set (cookies, caching, infra
  // headers) survives the hop. The body was already read under the upstream
  // deadline and size cap (`postToGoogle`).
  return new Response(outcome.text, {
    status: outcome.status,
    headers: {
      'Content-Type': outcome.contentType ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

async function enforceRateLimit(request: Request, env: Env, deps: Deps): Promise<Response | undefined> {
  const config = {
    maxRequests: positiveIntOr(env.RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
    windowSeconds: positiveIntOr(env.RATE_LIMIT_WINDOW_SECONDS, DEFAULT_RATE_LIMIT_WINDOW_SECONDS),
  };
  const result = await checkRateLimit(env.RATE_LIMIT_KV, `google-exchange:${clientIp(request)}`, config, deps.now());
  if (result.allowed) return undefined;
  return rateLimitedResponse(result);
}

function rateLimitedResponse(result: RateLimitResult): Response {
  const response = errorResponse(429, 'rate_limited', 'Too many requests. Try again shortly.');
  response.headers.set('Retry-After', String(result.resetSeconds));
  return response;
}

function positiveIntOr(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clientIp(request: Request): string {
  // Set by Cloudflare's edge on every real request; a request that lacks it
  // (a local test, a misrouted request) shares one bucket rather than
  // escaping rate limiting entirely.
  return request.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
}

function hasBrowserOrigin(request: Request): boolean {
  return request.headers.get('Origin') !== null;
}

type BoundedBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string; message: string };

async function readBoundedJson(request: Request, maxBytes: number): Promise<BoundedBodyResult> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const declared = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, status: 413, error: 'payload_too_large', message: `Body exceeds ${maxBytes} bytes.` };
    }
  }
  if (!request.body) return { ok: false, status: 400, error: 'invalid_request', message: 'A JSON request body is required.' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413, error: 'payload_too_large', message: `Body exceeds ${maxBytes} bytes.` };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, status: 400, error: 'invalid_request', message: 'Body is not valid UTF-8.' };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'invalid_request', message: 'Body is not valid JSON.' };
  }
}

function errorResponse(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, error_description: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * The ONLY thing this service logs: a path, a status, and a duration. Never a
 * request body, a response body, a header value, an IP, or any field a caller
 * controls — an authorization code, a PKCE verifier, a refresh token, and the
 * relay `state` are all caller-controlled and all stay out of every log line
 * this module writes (docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md, "Hygiene").
 */
function logRequest(pathname: string, status: number, durationMs: number): void {
  console.log(JSON.stringify({ path: pathname, status, duration_ms: Math.round(durationMs) }));
}
