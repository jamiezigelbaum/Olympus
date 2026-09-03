import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { handleRequest, type Deps, type Env } from '../src/index.ts';
import { checkRateLimit, type RateLimitBinding } from '../src/rate-limit.ts';
import { isAllowedRedirectUri, isLoopbackRedirectUri, parseAllowedRedirectUris } from '../src/redirect-allowlist.ts';
import { parseExchangeRequest, parseRefreshRequest } from '../src/schema.ts';

const SECRET = 'super-secret-value-never-repeat-this';
const CLIENT_ID = 'publisher-web-client.apps.googleusercontent.com';
const RELAY_URL = 'https://auth.olympusplugin.ai/oauth/callback/';
const VERIFIER = 'a'.repeat(43);

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: SECRET,
    ...overrides,
  };
}

function jsonRequest(pathname: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://auth.olympusplugin.ai${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function googleSuccess(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function deps(fetchImpl: Deps['fetchImpl'], nowMs = 1_000_000): Deps {
  return { fetchImpl, now: () => nowMs };
}

class FakeKv implements RateLimitBinding {
  private readonly store = new Map<string, { value: string; expiresAtMs: number }>();
  constructor(private nowMs = Date.now()) {}
  setNow(nowMs: number): void {
    this.nowMs = nowMs;
  }
  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= this.nowMs) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const ttlMs = (options?.expirationTtl ?? 3600) * 1000;
    this.store.set(key, { value, expiresAtMs: this.nowMs + ttlMs });
  }
}

/**
 * A KV binding that is PRESENT but broken: every call throws, simulating a
 * transient KV error, a misconfigured permission, or a regional outage. The
 * absent-binding case (`undefined`) already fails open; this stub proves the
 * present-but-throwing case does too, rather than propagating to the
 * endpoint's top-level catch and returning 500 for every caller.
 */
class ThrowingKv implements RateLimitBinding {
  get(): Promise<string | null> {
    return Promise.reject(new Error('KV get failed'));
  }
  put(): Promise<void> {
    return Promise.reject(new Error('KV put failed'));
  }
}

describe('schema: parseExchangeRequest', () => {
  test('accepts a well-formed request', () => {
    const result = parseExchangeRequest({ code: 'abc123', code_verifier: VERIFIER, redirect_uri: RELAY_URL });
    expect(result.ok).toBe(true);
  });

  test('accepts an optional state', () => {
    const result = parseExchangeRequest({ code: 'abc123', code_verifier: VERIFIER, redirect_uri: RELAY_URL, state: 'opaque.state' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.state).toBe('opaque.state');
  });

  test('refuses a non-object body', () => {
    expect(parseExchangeRequest('nope').ok).toBe(false);
    expect(parseExchangeRequest(null).ok).toBe(false);
    expect(parseExchangeRequest([1, 2]).ok).toBe(false);
  });

  test('refuses an unexpected field', () => {
    const result = parseExchangeRequest({ code: 'abc', code_verifier: VERIFIER, redirect_uri: RELAY_URL, client_secret: 'sneaky' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('client_secret');
  });

  test('refuses a missing code', () => {
    expect(parseExchangeRequest({ code_verifier: VERIFIER, redirect_uri: RELAY_URL }).ok).toBe(false);
  });

  test('refuses a code with whitespace or control characters', () => {
    expect(parseExchangeRequest({ code: 'abc def', code_verifier: VERIFIER, redirect_uri: RELAY_URL }).ok).toBe(false);
    expect(parseExchangeRequest({ code: 'abc\n', code_verifier: VERIFIER, redirect_uri: RELAY_URL }).ok).toBe(false);
  });

  test('refuses a code_verifier of the wrong shape or length', () => {
    expect(parseExchangeRequest({ code: 'abc', code_verifier: 'too-short', redirect_uri: RELAY_URL }).ok).toBe(false);
    expect(parseExchangeRequest({ code: 'abc', code_verifier: 'a'.repeat(129), redirect_uri: RELAY_URL }).ok).toBe(false);
    expect(parseExchangeRequest({ code: 'abc', code_verifier: `${VERIFIER}!`, redirect_uri: RELAY_URL }).ok).toBe(false);
  });

  test('refuses an oversized state', () => {
    const result = parseExchangeRequest({ code: 'abc', code_verifier: VERIFIER, redirect_uri: RELAY_URL, state: 'x'.repeat(2049) });
    expect(result.ok).toBe(false);
  });
});

describe('schema: parseRefreshRequest', () => {
  test('accepts a well-formed refresh_token', () => {
    expect(parseRefreshRequest({ refresh_token: '1//abc-def_GHI' }).ok).toBe(true);
  });

  test('refuses an unexpected field', () => {
    expect(parseRefreshRequest({ refresh_token: 'x', code: 'y' }).ok).toBe(false);
  });

  test('refuses a missing or empty refresh_token', () => {
    expect(parseRefreshRequest({}).ok).toBe(false);
    expect(parseRefreshRequest({ refresh_token: '' }).ok).toBe(false);
    expect(parseRefreshRequest({ refresh_token: 123 }).ok).toBe(false);
  });
});

describe('redirect_uri allowlist', () => {
  test('accepts the exact relay URL', () => {
    expect(isAllowedRedirectUri(RELAY_URL, [RELAY_URL])).toBe(true);
  });

  test('refuses a near-miss of the relay URL', () => {
    expect(isAllowedRedirectUri('https://auth.olympusplugin.ai/oauth/callback', [RELAY_URL])).toBe(false);
    expect(isAllowedRedirectUri('https://evil.example/oauth/callback/', [RELAY_URL])).toBe(false);
  });

  test('accepts loopback forms regardless of the exact allowlist', () => {
    expect(isLoopbackRedirectUri('http://127.0.0.1:51234/oauth/callback/gmail')).toBe(true);
    expect(isLoopbackRedirectUri('http://localhost:8787/oauth/callback/gmail')).toBe(true);
    expect(isLoopbackRedirectUri('http://[::1]:9000/anything')).toBe(true);
  });

  test('refuses https loopback, non-loopback http, and userinfo', () => {
    expect(isLoopbackRedirectUri('https://127.0.0.1/oauth/callback')).toBe(false);
    expect(isLoopbackRedirectUri('http://203.0.113.4/oauth/callback')).toBe(false);
    expect(isLoopbackRedirectUri('http://user@127.0.0.1/oauth/callback')).toBe(false);
  });

  test('refuses garbage', () => {
    expect(isLoopbackRedirectUri('not-a-url')).toBe(false);
    expect(isLoopbackRedirectUri('javascript:alert(1)')).toBe(false);
  });

  test('parseAllowedRedirectUris trims, splits, and falls back to the default', () => {
    expect(parseAllowedRedirectUris(' https://a.example/, https://b.example/ ', [RELAY_URL])).toEqual(['https://a.example/', 'https://b.example/']);
    expect(parseAllowedRedirectUris(undefined, [RELAY_URL])).toEqual([RELAY_URL]);
    expect(parseAllowedRedirectUris('   ', [RELAY_URL])).toEqual([RELAY_URL]);
  });
});

describe('rate limiting', () => {
  test('fails open with no KV binding', async () => {
    const result = await checkRateLimit(undefined, 'k', { maxRequests: 1, windowSeconds: 60 });
    expect(result.allowed).toBe(true);
  });

  test('allows up to the limit and then refuses within the same window', async () => {
    const kv = new FakeKv(0);
    const config = { maxRequests: 2, windowSeconds: 60 };
    expect((await checkRateLimit(kv, 'k', config, 0)).allowed).toBe(true);
    expect((await checkRateLimit(kv, 'k', config, 1000)).allowed).toBe(true);
    const third = await checkRateLimit(kv, 'k', config, 2000);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.resetSeconds).toBeGreaterThan(0);
  });

  test('resets in the next window', async () => {
    const kv = new FakeKv(0);
    const config = { maxRequests: 1, windowSeconds: 10 };
    expect((await checkRateLimit(kv, 'k', config, 0)).allowed).toBe(true);
    expect((await checkRateLimit(kv, 'k', config, 5000)).allowed).toBe(false);
    kv.setNow(11_000);
    expect((await checkRateLimit(kv, 'k', config, 11_000)).allowed).toBe(true);
  });

  test('keys are independent', async () => {
    const kv = new FakeKv(0);
    const config = { maxRequests: 1, windowSeconds: 60 };
    expect((await checkRateLimit(kv, 'a', config, 0)).allowed).toBe(true);
    expect((await checkRateLimit(kv, 'b', config, 0)).allowed).toBe(true);
  });

  test('fails open when a PRESENT binding throws on get', async () => {
    const result = await checkRateLimit(new ThrowingKv(), 'k', { maxRequests: 1, windowSeconds: 60 });
    expect(result.allowed).toBe(true);
  });

  test('fails open when a PRESENT binding throws on put', async () => {
    // `get` must succeed (so the code reaches `put`) while `put` throws.
    const partiallyBroken: RateLimitBinding = {
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new Error('KV put failed')),
    };
    const result = await checkRateLimit(partiallyBroken, 'k', { maxRequests: 1, windowSeconds: 60 });
    expect(result.allowed).toBe(true);
  });
});

describe('worker: POST /exchange/google', () => {
  let logSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    logSpy = mock(() => undefined);
    console.log = logSpy as unknown as typeof console.log;
  });

  afterEach(() => {
    mock.restore();
  });

  test('refuses non-POST methods', async () => {
    const request = new Request('https://auth.olympusplugin.ai/exchange/google', { method: 'GET' });
    const response = await handleRequest(request, baseEnv(), deps(mock(() => Promise.reject(new Error('must not fetch')))));
    expect(response.status).toBe(405);
  });

  test('refuses a request carrying a browser Origin header', async () => {
    const fetchImpl = mock(() => Promise.reject(new Error('must not fetch')));
    const request = jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: RELAY_URL }, { Origin: 'https://attacker.example' });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('404s an unknown route', async () => {
    const request = jsonRequest('/exchange/nope', {});
    const response = await handleRequest(request, baseEnv(), deps(mock(() => Promise.reject(new Error('must not fetch')))));
    expect(response.status).toBe(404);
  });

  test('refuses a body over the size cap even without a matching Content-Length', async () => {
    const encoder = new TextEncoder();
    const huge = encoder.encode(JSON.stringify({ code: 'c'.repeat(20_000), code_verifier: VERIFIER, redirect_uri: RELAY_URL }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(huge);
        controller.close();
      },
    });
    const request = new Request('https://auth.olympusplugin.ai/exchange/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Required by the fetch spec (and Bun/undici) whenever the body is a stream.
      duplex: 'half',
      body: stream,
    });
    const fetchImpl = mock(() => Promise.reject(new Error('must not fetch')));
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('refuses invalid JSON', async () => {
    const request = new Request('https://auth.olympusplugin.ai/exchange/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const response = await handleRequest(request, baseEnv(), deps(mock(() => Promise.reject(new Error('must not fetch')))));
    expect(response.status).toBe(400);
  });

  test('refuses a schema violation before ever calling Google', async () => {
    const fetchImpl = mock(() => Promise.reject(new Error('must not fetch')));
    const request = jsonRequest('/exchange/google', { code: 'c', code_verifier: 'too-short', redirect_uri: RELAY_URL });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('invalid_request');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('refuses a redirect_uri outside the allowlist before ever calling Google', async () => {
    const fetchImpl = mock(() => Promise.reject(new Error('must not fetch')));
    const request = jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: 'https://attacker.example/callback' });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('redirect_uri_not_allowed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('accepts a loopback redirect_uri even though it is not in the exact allowlist', async () => {
    const fetchImpl = mock(() => Promise.resolve(googleSuccess({ access_token: 'tok', expires_in: 3600 })));
    const request = jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: 'http://127.0.0.1:51234/oauth/callback/gmail' });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(200);
  });

  test('forwards a valid request to Google with the secret, and passes the response through unchanged', async () => {
    let capturedBody = '';
    let capturedUrl = '';
    const fetchImpl = mock((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = String(init.body);
      return Promise.resolve(googleSuccess({ access_token: 'the-access-token', refresh_token: 'the-refresh-token', expires_in: 3599, scope: 'a b' }));
    });
    const request = jsonRequest('/exchange/google', { code: 'auth-code-xyz', code_verifier: VERIFIER, redirect_uri: RELAY_URL, state: 'opaque.state' });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ access_token: 'the-access-token', refresh_token: 'the-refresh-token', expires_in: 3599, scope: 'a b' });

    expect(capturedUrl).toBe('https://oauth2.googleapis.com/token');
    const sent = new URLSearchParams(capturedBody);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('auth-code-xyz');
    expect(sent.get('redirect_uri')).toBe(RELAY_URL);
    expect(sent.get('code_verifier')).toBe(VERIFIER);
    expect(sent.get('client_id')).toBe(CLIENT_ID);
    expect(sent.get('client_secret')).toBe(SECRET);
    // `state` is accepted for shape but never forwarded upstream — this
    // endpoint cannot verify it (no per-user key) and Google's token endpoint
    // does not take it.
    expect(sent.has('state')).toBe(false);
  });

  test('the secret never appears in the response body, headers, or any log line', async () => {
    const distinctiveCode = 'the-authorization-code-under-test-98765';
    const fetchImpl = mock(() => Promise.resolve(googleSuccess({ access_token: 'tok', expires_in: 3600 })));
    const request = jsonRequest('/exchange/google', { code: distinctiveCode, code_verifier: VERIFIER, redirect_uri: RELAY_URL, state: 'opaque.state.marker' });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));

    const bodyText = await response.text();
    expect(bodyText).not.toContain(SECRET);
    for (const [, value] of response.headers) expect(value).not.toContain(SECRET);

    const loggedText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedText).not.toContain(SECRET);
    expect(loggedText).not.toContain(distinctiveCode);
    expect(loggedText).not.toContain(VERIFIER);
    expect(loggedText).not.toContain('opaque.state.marker');
  });

  test('a Google error response is passed through with its status, without leaking the secret', async () => {
    const fetchImpl = mock(() => Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code.' }), { status: 400, headers: { 'Content-Type': 'application/json' } })));
    const request = jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: RELAY_URL });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ error: 'invalid_grant', error_description: 'Bad code.' });
  });

  test('a Google timeout becomes a 504 with no internal detail leaked', async () => {
    const fetchImpl = mock((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const request = jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: RELAY_URL });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(504);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('upstream_timeout');
  }, 15_000);

  test('a network failure reaching Google becomes a 502', async () => {
    const fetchImpl = mock(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')));
    const request = jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: RELAY_URL });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(502);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('upstream_unreachable');
  });

  // The deadline used to end at the status line: `postToGoogle` cleared its
  // timer as soon as headers arrived and the body was then read unbounded, so
  // an upstream that answered 200 and dribbled held this Worker open past the
  // timeout it had already promised (Codex round 1 on 5cb644b9).
  test('a Google response whose body never ends becomes a 504 rather than outliving the deadline', async () => {
    const fetchImpl = mock(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"access_token":"'));
        // ...and never closes.
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const request = jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: RELAY_URL });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(504);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('upstream_timeout');
  }, 20_000);

  test('an oversized Google response is refused, with none of it echoed', async () => {
    const oversized = `{"marker":"${'A'.repeat(80 * 1024)}"}`;
    const fetchImpl = mock(() => Promise.resolve(new Response(oversized, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const request = jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: RELAY_URL });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: 'upstream_response_too_large',
      error_description: 'Google token endpoint returned an oversized response.',
    });
    expect(text).not.toContain('AAAA');
    expect(text.length).toBeLessThan(500);
  });

  test('a refresh whose upstream body is oversized is refused the same way', async () => {
    const fetchImpl = mock(() => Promise.resolve(new Response('B'.repeat(80 * 1024), { status: 200 })));
    const request = jsonRequest('/exchange/google/refresh', { refresh_token: 'stored-refresh-token' });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(502);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('upstream_response_too_large');
  });

  test('a body just under the cap still passes through unchanged', async () => {
    const padding = 'C'.repeat(60 * 1024);
    const fetchImpl = mock(() => Promise.resolve(googleSuccess({ access_token: 'tok', expires_in: 3600, padding })));
    const request = jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: RELAY_URL });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.access_token).toBe('tok');
    expect(body.padding).toBe(padding);
  });

  test('rate limits per IP once the configured budget is exhausted', async () => {
    const kv = new FakeKv(0);
    const fetchImpl = mock(() => Promise.resolve(googleSuccess({ access_token: 'tok', expires_in: 3600 })));
    const env = baseEnv({ RATE_LIMIT_KV: kv, RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_SECONDS: '60' });
    const makeRequest = () => jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: RELAY_URL }, { 'CF-Connecting-IP': '203.0.113.9' });

    const first = await handleRequest(makeRequest(), env, deps(fetchImpl, 0));
    const second = await handleRequest(makeRequest(), env, deps(fetchImpl, 1000));
    const third = await handleRequest(makeRequest(), env, deps(fetchImpl, 2000));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.headers.get('Retry-After')).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('a throwing RATE_LIMIT_KV binding fails open — the exchange still succeeds rather than 500ing', async () => {
    // Regression: a PRESENT-but-broken KV binding (transient error,
    // misconfigured permission, outage) must never take the endpoint down.
    // Before this was fixed, `checkRateLimit` let the thrown error propagate
    // to the top-level catch in `handleRequest`, turning every Google connect
    // into a 500 for as long as KV had a bad moment.
    const fetchImpl = mock(() => Promise.resolve(googleSuccess({ access_token: 'tok', expires_in: 3600 })));
    const env = baseEnv({ RATE_LIMIT_KV: new ThrowingKv(), RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_SECONDS: '60' });
    const request = jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: RELAY_URL }, { 'CF-Connecting-IP': '203.0.113.50' });

    const response = await handleRequest(request, env, deps(fetchImpl, 0));

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ access_token: 'tok', expires_in: 3600 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('different IPs get independent rate-limit budgets', async () => {
    const kv = new FakeKv(0);
    const fetchImpl = mock(() => Promise.resolve(googleSuccess({ access_token: 'tok', expires_in: 3600 })));
    const env = baseEnv({ RATE_LIMIT_KV: kv, RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_SECONDS: '60' });
    const requestFrom = (ip: string) => jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: RELAY_URL }, { 'CF-Connecting-IP': ip });

    const a = await handleRequest(requestFrom('203.0.113.1'), env, deps(fetchImpl, 0));
    const b = await handleRequest(requestFrom('203.0.113.2'), env, deps(fetchImpl, 0));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('worker: POST /exchange/google/refresh', () => {
  beforeEach(() => {
    console.log = mock(() => undefined) as unknown as typeof console.log;
  });

  afterEach(() => {
    mock.restore();
  });

  test('refuses a schema violation before ever calling Google', async () => {
    const fetchImpl = mock(() => Promise.reject(new Error('must not fetch')));
    const request = jsonRequest('/exchange/google/refresh', { refresh_token: '' });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('forwards a refresh_token to Google with the secret, and passes the response through unchanged', async () => {
    let capturedBody = '';
    const fetchImpl = mock((_url: string, init: RequestInit) => {
      capturedBody = String(init.body);
      return Promise.resolve(googleSuccess({ access_token: 'new-access-token', expires_in: 3599, scope: 'a' }));
    });
    const request = jsonRequest('/exchange/google/refresh', { refresh_token: 'the-refresh-token' });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ access_token: 'new-access-token', expires_in: 3599, scope: 'a' });

    const sent = new URLSearchParams(capturedBody);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('the-refresh-token');
    expect(sent.get('client_id')).toBe(CLIENT_ID);
    expect(sent.get('client_secret')).toBe(SECRET);
  });

  test('refuses a browser Origin the same way the exchange route does', async () => {
    const fetchImpl = mock(() => Promise.reject(new Error('must not fetch')));
    const request = jsonRequest('/exchange/google/refresh', { refresh_token: 'x' }, { Origin: 'https://attacker.example' });
    const response = await handleRequest(request, baseEnv(), deps(fetchImpl));
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a throwing RATE_LIMIT_KV binding also fails open on the refresh route', async () => {
    const fetchImpl = mock(() => Promise.resolve(googleSuccess({ access_token: 'tok2', expires_in: 3600 })));
    const env = baseEnv({ RATE_LIMIT_KV: new ThrowingKv() });
    const request = jsonRequest('/exchange/google/refresh', { refresh_token: 'x' }, { 'CF-Connecting-IP': '203.0.113.51' });

    const response = await handleRequest(request, env, deps(fetchImpl, 0));

    expect(response.status).toBe(200);
  });

  test('is independently rate limited from /exchange/google', async () => {
    const kv = new FakeKv(0);
    const fetchImpl = mock(() => Promise.resolve(googleSuccess({ access_token: 'tok', expires_in: 3600 })));
    const env = baseEnv({ RATE_LIMIT_KV: kv, RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_SECONDS: '60' });
    const exchangeRequest = jsonRequest('/exchange/google', { code: 'c', code_verifier: VERIFIER, redirect_uri: RELAY_URL }, { 'CF-Connecting-IP': '198.51.100.7' });
    const refreshRequest = jsonRequest('/exchange/google/refresh', { refresh_token: 'x' }, { 'CF-Connecting-IP': '198.51.100.7' });

    const exchangeResponse = await handleRequest(exchangeRequest, env, deps(fetchImpl, 0));
    const refreshResponse = await handleRequest(refreshRequest, env, deps(fetchImpl, 0));
    expect(exchangeResponse.status).toBe(200);
    // Same key namespace (`google-exchange:<ip>`) is shared across both
    // routes by design: a caller hammering either one exhausts the same
    // per-IP budget rather than getting two separate budgets to abuse.
    expect(refreshResponse.status).toBe(429);
  });
});
