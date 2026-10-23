import { describe, expect, test } from 'bun:test';
import { handleRequest, type Deps, type Env } from '../src/index.ts';
import { COUNT_KEY, NO_ID_TOKEN_KEY, USER_KEY_PREFIX, subFromIdToken, userKeyForSub } from '../src/user-count.ts';

/**
 * Written from the product spec, not from the implementation:
 *  - the owner needs the number of DISTINCT Google accounts that connected;
 *  - Gmail and Drive for one account, and every reconnect, count once;
 *  - counting is bookkeeping and can never break, change or delay an exchange;
 *  - /exchange/stats is the owner's and answers nobody without the token.
 */

const CLIENT_ID = 'publisher-web-client.apps.googleusercontent.com';
const RELAY_URL = 'https://auth.olympusplugin.ai/oauth/callback/';
const VERIFIER = 'a'.repeat(43);
const STATS_TOKEN = 'owner-stats-token-0123456789';

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function idToken(sub: string, extra: Record<string, unknown> = {}): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iss: 'https://accounts.google.com', sub, ...extra })}.signature`;
}

function tokenResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

class ListingKv {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async list(options: { prefix: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
    return { keys: [...this.store.keys()].filter((name) => name.startsWith(options.prefix)).map((name) => ({ name })), list_complete: true };
  }
}

function env(kv: ListingKv | undefined, overrides: Partial<Env> = {}): Env {
  return {
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'unused-secret',
    GOOGLE_USER_COUNT_OFFSET: '0',
    ...(kv ? { RATE_LIMIT_KV: kv } : {}),
    ...overrides,
  };
}

function exchangeRequest(): Request {
  return new Request('https://auth.olympusplugin.ai/exchange/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'abc123', code_verifier: VERIFIER, redirect_uri: RELAY_URL }),
  });
}

function deps(google: () => Response, waitUntil?: Deps['waitUntil']): Deps {
  return { fetchImpl: async () => google(), now: () => 5_000_000, ...(waitUntil ? { waitUntil } : {}) };
}

async function connect(kv: ListingKv | undefined, sub: string, scope: string, overrides: Partial<Env> = {}): Promise<Response> {
  return handleRequest(
    exchangeRequest(),
    env(kv, overrides),
    deps(() => tokenResponse({ access_token: 'at', scope, id_token: idToken(sub, { email: 'person@example.com' }) })),
  );
}

async function stats(kv: ListingKv | undefined, overrides: Partial<Env> = {}): Promise<Record<string, unknown>> {
  const response = await handleRequest(
    new Request('https://auth.olympusplugin.ai/exchange/stats', { headers: { Authorization: `Bearer ${STATS_TOKEN}` } }),
    env(kv, { STATS_TOKEN, ...overrides }),
    deps(() => tokenResponse({})),
  );
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

describe('distinct user counting', () => {
  test('the same account connecting twice is one user', async () => {
    const kv = new ListingKv();
    await connect(kv, '110000000000000000001', 'gmail.readonly openid');
    await connect(kv, '110000000000000000001', 'gmail.readonly openid');
    expect((await stats(kv)).counted).toBe(1);
  });

  test('Gmail and Drive for the same account are one user', async () => {
    const kv = new ListingKv();
    await connect(kv, '110000000000000000002', 'https://www.googleapis.com/auth/gmail.readonly openid');
    await connect(kv, '110000000000000000002', 'https://www.googleapis.com/auth/drive.readonly openid');
    expect((await stats(kv)).counted).toBe(1);
  });

  test('different accounts each count', async () => {
    const kv = new ListingKv();
    await connect(kv, '110000000000000000003', 'gmail.readonly openid');
    await connect(kv, '110000000000000000004', 'drive.readonly openid');
    await connect(kv, '110000000000000000005', 'drive.readonly openid');
    const report = await stats(kv);
    expect(report.counted).toBe(3);
    expect(report.users).toBe(3);
  });

  test('the configured offset is added to the reported number but not to the tally', async () => {
    const kv = new ListingKv();
    await connect(kv, '110000000000000000006', 'gmail.readonly openid');
    const report = await stats(kv, { GOOGLE_USER_COUNT_OFFSET: '2' });
    expect(report.counted).toBe(1);
    expect(report.users).toBe(3);
  });

  test('the account id and the address are never stored', async () => {
    const kv = new ListingKv();
    const sub = '110000000000000000007';
    await connect(kv, sub, 'gmail.readonly openid');
    const everything = JSON.stringify([...kv.store.entries()]);
    expect(everything).not.toContain(sub);
    expect(everything).not.toContain('person@example.com');
    expect([...kv.store.keys()].some((key) => key.startsWith(USER_KEY_PREFIX))).toBe(true);
  });

  test('the stored key is a keyed hash: a different key gives a different key, the same key the same', async () => {
    const withKeyA = await userKeyForSub('42', 'key-a');
    expect(await userKeyForSub('42', 'key-a')).toBe(withKeyA);
    expect(await userKeyForSub('42', 'key-b')).not.toBe(withKeyA);
    expect(await userKeyForSub('42', undefined)).not.toBe(withKeyA);
    expect(withKeyA).not.toContain('42');
  });

  test('a configured HMAC secret changes the stored key and still counts once', async () => {
    const kv = new ListingKv();
    await connect(kv, '110000000000000000008', 'gmail.readonly openid', { USER_COUNT_HMAC_KEY: 'k' });
    await connect(kv, '110000000000000000008', 'drive.readonly openid', { USER_COUNT_HMAC_KEY: 'k' });
    expect((await stats(kv)).counted).toBe(1);
    expect([...kv.store.keys()]).toContain(await userKeyForSub('110000000000000000008', 'k'));
  });

  test('a refresh never counts', async () => {
    const kv = new ListingKv();
    await handleRequest(
      new Request('https://auth.olympusplugin.ai/exchange/google/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: '1//abc' }),
      }),
      env(kv),
      deps(() => tokenResponse({ access_token: 'at', id_token: idToken('110000000000000000009') })),
    );
    expect([...kv.store.keys()].filter((key) => key.startsWith('google-users:'))).toEqual([]);
  });

  test('a refused exchange never counts', async () => {
    const kv = new ListingKv();
    await handleRequest(
      exchangeRequest(),
      env(kv),
      deps(() => new Response(JSON.stringify({ error: 'invalid_grant', id_token: idToken('110000000000000000010') }), { status: 400 })),
    );
    expect([...kv.store.keys()].filter((key) => key.startsWith(USER_KEY_PREFIX))).toEqual([]);
  });

  test('a sign-in with no account id is tallied separately and not counted as a user', async () => {
    const kv = new ListingKv();
    const response = await handleRequest(exchangeRequest(), env(kv), deps(() => tokenResponse({ access_token: 'at' })));
    expect(response.status).toBe(200);
    const report = await stats(kv);
    expect(report.counted).toBe(0);
    expect(report.exchanges_without_id_token).toBe(1);
    expect(kv.store.get(NO_ID_TOKEN_KEY)).toBe('1');
  });

  test('subFromIdToken reads the sub and refuses anything malformed', () => {
    expect(subFromIdToken(idToken('abc'))).toBe('abc');
    expect(subFromIdToken('not-a-jwt')).toBeUndefined();
    expect(subFromIdToken(`a.${b64url({ nosub: true })}.c`)).toBeUndefined();
    expect(subFromIdToken(`a.${b64url({ sub: 12345 })}.c`)).toBeUndefined();
    expect(subFromIdToken(`a.${b64url({ sub: '' })}.c`)).toBeUndefined();
    expect(subFromIdToken(`a.${b64url({ sub: 'x'.repeat(256) })}.c`)).toBeUndefined();
    expect(subFromIdToken(undefined)).toBeUndefined();
  });
});

describe('counting never breaks, changes or delays an exchange', () => {
  const googleBody = { access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'openid', token_type: 'Bearer', id_token: idToken('110000000000000000011') };

  test('the response body is exactly what Google sent', async () => {
    const kv = new ListingKv();
    const response = await handleRequest(exchangeRequest(), env(kv), deps(() => tokenResponse(googleBody)));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(googleBody));
  });

  test('a KV binding that throws on every call still lets the exchange succeed unchanged', async () => {
    const broken = {
      get: () => Promise.reject(new Error('KV get failed')),
      put: () => Promise.reject(new Error('KV put failed')),
      list: () => Promise.reject(new Error('KV list failed')),
    };
    const response = await handleRequest(
      exchangeRequest(),
      { ...env(undefined), RATE_LIMIT_KV: broken },
      deps(() => tokenResponse(googleBody)),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(googleBody));
  });

  test('a KV that only fails for the user counter still lets the exchange succeed', async () => {
    class CounterBroken extends ListingKv {
      override async get(key: string): Promise<string | null> {
        if (key.startsWith('google-users:')) throw new Error('boom');
        return super.get(key);
      }
    }
    const response = await handleRequest(exchangeRequest(), env(new CounterBroken()), deps(() => tokenResponse(googleBody)));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(googleBody));
  });

  test('no KV binding at all still lets the exchange succeed', async () => {
    const response = await handleRequest(exchangeRequest(), env(undefined), deps(() => tokenResponse(googleBody)));
    expect(response.status).toBe(200);
  });

  test('a malformed id_token never changes the response', async () => {
    const body = { access_token: 'at', id_token: 'garbage' };
    const response = await handleRequest(exchangeRequest(), env(new ListingKv()), deps(() => tokenResponse(body)));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(body));
  });

  test('a waitUntil that throws does not break the exchange', async () => {
    const response = await handleRequest(
      exchangeRequest(),
      env(new ListingKv()),
      deps(() => tokenResponse(googleBody), () => {
        throw new Error('waitUntil unavailable');
      }),
    );
    expect(response.status).toBe(200);
  });

  test('with waitUntil, the response does not wait for a counter that hangs', async () => {
    class HangingCounter extends ListingKv {
      override async get(key: string): Promise<string | null> {
        if (key.startsWith('google-users:')) return new Promise<string | null>(() => undefined);
        return super.get(key);
      }
    }
    const pending: Promise<unknown>[] = [];
    const response = await handleRequest(
      exchangeRequest(),
      env(new HangingCounter()),
      deps(() => tokenResponse(googleBody), (work) => {
        pending.push(work);
      }),
    );
    expect(response.status).toBe(200);
    expect(pending.length).toBe(1);
  });

  test('with waitUntil the count lands once the background work finishes', async () => {
    const kv = new ListingKv();
    const pending: Promise<unknown>[] = [];
    await handleRequest(exchangeRequest(), env(kv), deps(() => tokenResponse(googleBody), (work) => {
      pending.push(work);
    }));
    await Promise.all(pending);
    expect(kv.store.get(COUNT_KEY)).toBe('1');
  });
});

describe('the exchange route', () => {
  test('the exchange route still refuses a browser Origin', async () => {
    const request = new Request('https://auth.olympusplugin.ai/exchange/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{}',
    });
    expect((await handleRequest(request, env(undefined), deps(() => tokenResponse({})))).status).toBe(403);
  });
});

describe('GET /exchange/stats', () => {
  function statsRequest(headers: Record<string, string> = {}, query = ''): Request {
    return new Request(`https://auth.olympusplugin.ai/exchange/stats${query}`, { headers });
  }

  async function run(request: Request, overrides: Partial<Env> = {}, kv: ListingKv | undefined = new ListingKv()): Promise<Response> {
    return handleRequest(request, env(kv, overrides), deps(() => tokenResponse({})));
  }

  test('refuses a request with no token', async () => {
    const response = await run(statsRequest(), { STATS_TOKEN });
    expect(response.status).toBe(401);
  });

  test('refuses a wrong token, as header or as query', async () => {
    expect((await run(statsRequest({ Authorization: 'Bearer wrong-token-wrong-token' }), { STATS_TOKEN })).status).toBe(401);
    expect((await run(statsRequest({}, '?token=wrong-token-wrong-token'), { STATS_TOKEN })).status).toBe(401);
    expect((await run(statsRequest({}, `?token=${STATS_TOKEN}x`), { STATS_TOKEN })).status).toBe(401);
  });

  test('a refusal reveals no number', async () => {
    const kv = new ListingKv();
    kv.store.set(COUNT_KEY, '77');
    const text = await (await run(statsRequest({ Authorization: 'Bearer nope-nope-nope-nope' }), { STATS_TOKEN }, kv)).text();
    expect(text).not.toContain('77');
  });

  test('does not exist until a token is configured, and a token too short to be safe counts as none', async () => {
    expect((await run(statsRequest({ Authorization: `Bearer ${STATS_TOKEN}` }))).status).toBe(404);
    expect((await run(statsRequest({ Authorization: 'Bearer short' }), { STATS_TOKEN: 'short' })).status).toBe(404);
    expect((await run(statsRequest({}, '?token='), { STATS_TOKEN: '' })).status).toBe(404);
  });

  test('accepts the bearer header and answers JSON with users, cap, threshold, state and time', async () => {
    const kv = new ListingKv();
    kv.store.set(COUNT_KEY, '41');
    const response = await run(statsRequest({ Authorization: `Bearer ${STATS_TOKEN}` }), { STATS_TOKEN, GOOGLE_USER_COUNT_OFFSET: '2' }, kv);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ users: 43, cap: 100, full_at: 90, state: 'open' });
    expect(typeof body.generated_at).toBe('string');
  });

  test('accepts ?token= and shows a readable page to a browser', async () => {
    const kv = new ListingKv();
    kv.store.set(COUNT_KEY, '41');
    const response = await run(statsRequest({ Accept: 'text/html,application/xhtml+xml' }, `?token=${STATS_TOKEN}`), { STATS_TOKEN, GOOGLE_USER_COUNT_OFFSET: '2' }, kv);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const page = await response.text();
    expect(page).toContain('43 of 100');
    expect(page).not.toContain(STATS_TOKEN);
  });

  test('says full when the threshold is reached or the override is on', async () => {
    const kv = new ListingKv();
    kv.store.set(COUNT_KEY, '88');
    const full = await run(statsRequest({ Authorization: `Bearer ${STATS_TOKEN}` }), { STATS_TOKEN, GOOGLE_USER_COUNT_OFFSET: '2' }, kv);
    expect((await full.json() as Record<string, unknown>).state).toBe('full');
    const forced = await run(statsRequest({ Authorization: `Bearer ${STATS_TOKEN}` }), { STATS_TOKEN, GOOGLE_SIGNIN_FULL: '1' }, new ListingKv());
    const forcedBody = await forced.json() as Record<string, unknown>;
    expect(forcedBody.state).toBe('full');
    expect(forcedBody.forced_full).toBe(true);
  });

  test('says so when the counter cannot be read, rather than reporting zero', async () => {
    const broken = { get: () => Promise.reject(new Error('down')), put: () => Promise.reject(new Error('down')) };
    const response = await handleRequest(
      statsRequest({ Authorization: `Bearer ${STATS_TOKEN}` }),
      { ...env(undefined, { STATS_TOKEN }), RATE_LIMIT_KV: broken },
      deps(() => tokenResponse({})),
    );
    expect(response.status).toBe(503);
  });

  test('refuses a browser Origin and non-GET methods', async () => {
    expect((await run(statsRequest({ Authorization: `Bearer ${STATS_TOKEN}`, Origin: 'https://evil.example' }), { STATS_TOKEN })).status).toBe(403);
    const post = new Request('https://auth.olympusplugin.ai/exchange/stats', { method: 'POST', headers: { Authorization: `Bearer ${STATS_TOKEN}` } });
    expect((await run(post, { STATS_TOKEN })).status).toBe(405);
  });
});
