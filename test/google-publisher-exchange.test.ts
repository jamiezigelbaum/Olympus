// Google's publisher flow through the token-exchange endpoint.
//
// `docs/ops/GOOGLE_EXCHANGE_ENDPOINT.md` ("Worker-side integration") is the
// contract this exercises: a non-loopback Google connect goes out with the
// publisher **Web** client and a signed relay state exactly like Dropbox
// already does (`test/dashboard-oauth-publisher-relay.test.ts`), but its token
// exchange and refresh are delegated to a publisher-side endpoint instead of
// talking to Google directly, because a Web-application client is
// confidential and Olympus ships as public source. Three things this suite
// has to prove that the Dropbox suite cannot: the exchange goes to the
// endpoint (not to Google) with a JSON body and no `client_secret`, the
// loopback Desktop pilot client is completely unaffected, and refresh routes
// on stored provenance (`exchangeVia`) rather than by re-deriving it from the
// client id every time.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import type { OAuthFetch } from '../src/core/connect.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { googlePublisherExchangeUrl, googlePublisherExchangeRefreshUrl } from '../src/core/oauth-relay.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { readConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import {
  createEnvCredentialBroker,
  CredentialBrokerError,
  type EnvCredentialHandleDefinition,
  type EnvOAuth2RefreshDefinition,
} from '../src/workers/credential-broker/index.ts';

const PUBLISHER_WEB_CLIENT_ID = 'olympus-publisher-google-web-client-id-fixture';
const PILOT_CLIENT_ID = 'olympus-pilot-google-desktop-client-id-fixture';
const EXCHANGE_URL = 'https://fake-google-exchange.test/exchange/google';
const EXCHANGE_REFRESH_URL = `${EXCHANGE_URL}/refresh`;
const DASHBOARD_ORIGIN = 'https://olympus.example.org';

const dirs: string[] = [];
let previousWebClientId: string | undefined;
let previousExchangeUrl: string | undefined;

beforeEach(() => {
  previousWebClientId = process.env.OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID;
  previousExchangeUrl = process.env.OLYMPUS_GOOGLE_PUBLISHER_EXCHANGE_URL;
  process.env.OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID = PUBLISHER_WEB_CLIENT_ID;
  process.env.OLYMPUS_GOOGLE_PUBLISHER_EXCHANGE_URL = EXCHANGE_URL;
});

afterEach(() => {
  restoreEnv('OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID', previousWebClientId);
  restoreEnv('OLYMPUS_GOOGLE_PUBLISHER_EXCHANGE_URL', previousExchangeUrl);
  delete process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

// Config accessors read `process.env` on every call, so the fixture's env
// overrides above are what `googlePublisherExchangeUrl()` sees too — the
// constants above and this helper must always agree.
test('the exchange URL config the fixture relies on really does read the env override', () => {
  expect(googlePublisherExchangeUrl()).toBe(EXCHANGE_URL);
  expect(googlePublisherExchangeRefreshUrl()).toBe(EXCHANGE_REFRESH_URL);
});

interface Fixture {
  fetch: (request: Request) => Promise<Response>;
  secretStore: SecretStore;
  registryPath: string;
  /** Every call this fixture's `oauthFetch` received, in order. */
  calls: Array<{ url: string; init: RequestInit }>;
}

interface FixtureOptions {
  /** What the fake exchange endpoint answers. Defaults to a healthy token response. */
  exchangeResponse?: () => Response;
  /** What a direct-to-Google call answers, for the loopback scenarios. */
  googleDirectResponse?: () => Response;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-google-exchange-worker-'));
  dirs.push(dir);
  const secretStore = memorySecretStore();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const exchangeResponse = options.exchangeResponse ?? (() => new Response(JSON.stringify({
    access_token: 'google-access-token-fixture',
    refresh_token: 'google-refresh-token-fixture',
    expires_in: 3599,
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    token_type: 'Bearer',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const googleDirectResponse = options.googleDirectResponse ?? (() => new Response(JSON.stringify({
    access_token: 'google-direct-access-token-fixture',
    refresh_token: 'google-direct-refresh-token-fixture',
    expires_in: 3599,
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    token_type: 'Bearer',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const oauthFetch: OAuthFetch = async (url, init) => {
    const urlString = String(url);
    calls.push({ url: urlString, init: (init ?? {}) as RequestInit });
    if (urlString === EXCHANGE_URL || urlString === EXCHANGE_REFRESH_URL) return exchangeResponse();
    return googleDirectResponse();
  };
  const registryPath = join(dir, 'handles.json');
  const worker = createEmailSourceWorker({
    sourceIndexStatus: { async status() { return fixtureStatus(); } },
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      registryPath,
      secretStore,
      oauthFetch,
    },
  });
  return {
    fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' }),
    secretStore,
    registryPath,
    calls,
  };
}

async function startConnect(
  instance: Fixture,
  body: Record<string, string> = {},
  origin = DASHBOARD_ORIGIN,
): Promise<Response> {
  return instance.fetch(new Request(`${origin}/dashboard/connect/oauth/start`, {
    method: 'POST',
    headers: { Authorization: 'Bearer dashboard-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'gmail', ...body }),
  }));
}

async function authorizationUrl(started: Response): Promise<URL> {
  expect(started.status).toBe(200);
  return new URL((await started.json()).authorization_url);
}

describe('publisher Google flow through the relay (non-loopback dashboard)', () => {
  test('start sends the publisher web client id, the relay URL, and a signed state', async () => {
    const instance = fixture();
    const url = await authorizationUrl(await startConnect(instance));

    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe(PUBLISHER_WEB_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe('https://auth.olympusplugin.ai/oauth/callback/');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  test('the exchange POSTs JSON to the endpoint, with redirect_uri equal to the relay URL and no client_secret anywhere', async () => {
    const instance = fixture();
    const started = await authorizationUrl(await startConnect(instance));
    const state = started.searchParams.get('state')!;

    const callback = await instance.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/gmail?code=relay-code-1&state=${encodeURIComponent(state)}`,
    ));
    expect(callback.status).toBe(303);

    expect(instance.calls).toHaveLength(1);
    const call = instance.calls[0]!;
    expect(call.url).toBe(EXCHANGE_URL);
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      code: 'relay-code-1',
      code_verifier: expect.any(String),
      redirect_uri: 'https://auth.olympusplugin.ai/oauth/callback/',
      state,
    });
    expect(body.redirect_uri).toBe(started.searchParams.get('redirect_uri'));
    expect('client_secret' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('client_secret');

    expect(await instance.secretStore.get('gmail.personal.oauth.refresh_token'))
      .toBe('google-refresh-token-fixture');
    expect(await instance.secretStore.get('gmail.personal.oauth.client_id'))
      .toBe(PUBLISHER_WEB_CLIENT_ID);
    // No secret ever reaches the store for this path: the exchange endpoint
    // holds the confidential half, and it is never sent to this worker.
    expect(await instance.secretStore.get('gmail.personal.oauth.client_secret')).toBeUndefined();
  });

  test('the connected handle records exchangeVia: publisher_endpoint for refresh to find later', async () => {
    const instance = fixture();
    const started = await authorizationUrl(await startConnect(instance));
    const state = started.searchParams.get('state')!;
    await instance.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/gmail?code=relay-code-1&state=${encodeURIComponent(state)}`,
    ));

    const registry = readConnectedHandleRegistry(instance.registryPath);
    const handle = registry.handles.find((entry) => entry.handle === 'gmail.personal');
    expect(handle?.oauth2Refresh?.exchangeVia).toBe('publisher_endpoint');
    expect(handle?.oauth2Refresh?.clientIdSecretRef).toBe('store:gmail.personal.oauth.client_id');
    expect(handle?.oauth2Refresh?.clientSecretSecretRef).toBeUndefined();
  });

  test.each([
    ['400 invalid_request from the endpoint itself', 400, { error: 'invalid_request', error_description: 'Schema violation.' }],
    ['401 from a forwarded provider refusal', 401, { error: 'invalid_client' }],
    ['502 upstream_unreachable', 502, { error: 'upstream_unreachable' }],
    ['504 upstream_timeout', 504, { error: 'upstream_timeout' }],
  ])('%s renders as an ordinary connect refusal, never a crash or a leaked secret', async (_name, status, payload) => {
    const instance = fixture({
      exchangeResponse: () => new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    });
    const started = await authorizationUrl(await startConnect(instance));
    const state = started.searchParams.get('state')!;
    const callback = await instance.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/gmail?code=relay-code-1&state=${encodeURIComponent(state)}`,
    ));
    // The worker's own outward status is fixed at 400 for every exchange
    // failure (matching every other provider's refusal today); the real
    // endpoint status rides inside the rendered reason text instead.
    expect(callback.status).toBe(400);
    const body = await callback.text();
    expect(body).toContain('Could not connect gmail');
    expect(body).toContain(String(status));
    expect(body.toLowerCase()).not.toContain('client_secret');
    expect(body).not.toContain(PUBLISHER_WEB_CLIENT_ID);

    // The attempt is spent, not left dangling for a second exchange.
    const replay = await instance.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/gmail?code=relay-code-2&state=${encodeURIComponent(state)}`,
    ));
    expect(replay.status).toBe(410);
  });
});

describe('publisher Google flow on a loopback dashboard keeps the Desktop pilot client', () => {
  beforeEach(() => {
    process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID = PILOT_CLIENT_ID;
  });

  test('start uses the pilot client id and a loopback redirect, never the relay or the exchange endpoint', async () => {
    const instance = fixture();
    const started = await instance.fetch(new Request('http://127.0.0.1:8010/dashboard/connect/oauth/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer dashboard-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'gmail' }),
    }));
    const url = await authorizationUrl(started);
    expect(url.searchParams.get('client_id')).toBe(PILOT_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8010/oauth/callback/gmail');

    const state = url.searchParams.get('state')!;
    const callback = await instance.fetch(new Request(
      `http://127.0.0.1:8010/oauth/callback/gmail?code=loopback-code-1&state=${encodeURIComponent(state)}`,
    ));
    expect(callback.status).toBe(303);

    // A form-encoded POST straight to Google's own token endpoint, exactly as
    // before this feature existed -- never JSON, never the exchange endpoint.
    expect(instance.calls).toHaveLength(1);
    const call = instance.calls[0]!;
    expect(call.url).toBe('https://oauth2.googleapis.com/token');
    const params = new URLSearchParams(String(call.init.body ?? ''));
    expect(params.get('client_id')).toBe(PILOT_CLIENT_ID);
    expect(params.get('redirect_uri')).toBe('http://127.0.0.1:8010/oauth/callback/gmail');
    expect(params.has('client_secret')).toBe(false);

    const registry = readConnectedHandleRegistry(instance.registryPath);
    const handle = registry.handles.find((entry) => entry.handle === 'gmail.personal');
    expect(handle?.oauth2Refresh?.exchangeVia).toBeUndefined();
  });
});

describe('Google publisher OAuth2 refresh routes on stored provenance', () => {
  let previousRefreshWebClientId: string | undefined;

  beforeEach(() => {
    previousRefreshWebClientId = process.env.OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID;
    process.env.OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID = PUBLISHER_WEB_CLIENT_ID;
  });

  afterEach(() => {
    restoreEnv('OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID', previousRefreshWebClientId);
  });

  function refreshHandle(overrides: Partial<EnvOAuth2RefreshDefinition> = {}): EnvCredentialHandleDefinition {
    return {
      handle: 'gmail.personal',
      provider: 'gmail',
      allowedCapabilities: ['gmail.email.sync'],
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      tokenEnvNames: [],
      oauth2Refresh: {
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientIdEnvNames: [],
        clientIdSecretRef: 'store:gmail.personal.oauth.client_id',
        refreshTokenSecretRef: 'store:gmail.personal.oauth.refresh_token',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        ...overrides,
      },
    };
  }

  test('a credential minted through the publisher endpoint refreshes through it, as JSON, with no client_secret', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const secretStore = memorySecretStore({
      'gmail.personal.oauth.client_id': PUBLISHER_WEB_CLIENT_ID,
      'gmail.personal.oauth.refresh_token': 'stored-refresh-token-fixture',
    });
    const broker = createEnvCredentialBroker({
      handles: [refreshHandle({ exchangeVia: 'publisher_endpoint' })],
      secretStore,
      oauth2CacheNamespace: `google-publisher-refresh-${Math.random()}`,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
        return new Response(JSON.stringify({
          access_token: 'refreshed-access-token-fixture',
          expires_in: 3599,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const session = await broker.issueSession({ handle: 'gmail.personal', capability: 'gmail.email.sync' });
    expect(session.kind).toBe('bearer_token');
    if (session.kind === 'bearer_token') expect(session.token).toBe('refreshed-access-token-fixture');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(EXCHANGE_REFRESH_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ refresh_token: 'stored-refresh-token-fixture' });
  });

  test('a credential connected before exchangeVia existed still finds the endpoint by client id', async () => {
    const calls: Array<{ url: string }> = [];
    const secretStore = memorySecretStore({
      'gmail.personal.oauth.client_id': PUBLISHER_WEB_CLIENT_ID,
      'gmail.personal.oauth.refresh_token': 'stored-refresh-token-fixture',
    });
    const broker = createEnvCredentialBroker({
      // No `exchangeVia` on this handle -- the pre-migration shape.
      handles: [refreshHandle()],
      secretStore,
      oauth2CacheNamespace: `google-publisher-refresh-fallback-${Math.random()}`,
      fetch: async (url) => {
        calls.push({ url: String(url) });
        return new Response(JSON.stringify({ access_token: 'refreshed-access-token-fixture', expires_in: 3599 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await broker.issueSession({ handle: 'gmail.personal', capability: 'gmail.email.sync' });
    expect(calls).toEqual([{ url: EXCHANGE_REFRESH_URL }]);
  });

  test('a bring-your-own Google credential refreshes directly with Google, form-encoded, unaffected', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const secretStore = memorySecretStore({
      'gmail.personal.oauth.client_id': 'owner-registered-byo-client-id',
      'gmail.personal.oauth.client_secret': 'owner-registered-byo-client-secret',
      'gmail.personal.oauth.refresh_token': 'stored-refresh-token-fixture',
    });
    const broker = createEnvCredentialBroker({
      handles: [refreshHandle({ clientSecretSecretRef: 'store:gmail.personal.oauth.client_secret' })],
      secretStore,
      oauth2CacheNamespace: `google-byo-refresh-${Math.random()}`,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
        return new Response(JSON.stringify({ access_token: 'refreshed-access-token-fixture', expires_in: 3599 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await broker.issueSession({ handle: 'gmail.personal', capability: 'gmail.email.sync' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('owner-registered-byo-client-id:owner-registered-byo-client-secret').toString('base64')}`,
    );
  });

  test('a timeout or network failure reaching the endpoint surfaces as an ordinary refresh failure, not a hang', async () => {
    const secretStore = memorySecretStore({
      'gmail.personal.oauth.client_id': PUBLISHER_WEB_CLIENT_ID,
      'gmail.personal.oauth.refresh_token': 'stored-refresh-token-fixture',
    });
    const broker = createEnvCredentialBroker({
      handles: [refreshHandle({ exchangeVia: 'publisher_endpoint' })],
      secretStore,
      oauth2CacheNamespace: `google-publisher-refresh-network-fail-${Math.random()}`,
      fetch: async () => {
        throw new Error('network is down');
      },
    });

    await expect(broker.issueSession({ handle: 'gmail.personal', capability: 'gmail.email.sync' }))
      .rejects.toBeInstanceOf(CredentialBrokerError);
  });
});

function fixtureStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-09-03T00:00:00.000Z',
    corpora: [],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  } as unknown as SourceIndexStatusResult;
}

function memorySecretStore(initial: Record<string, string> = {}): SecretStore {
  const secrets = new Map(Object.entries(initial));
  return {
    label: 'memory',
    async get(key) {
      return secrets.get(key);
    },
    getSync(key) {
      return secrets.get(key);
    },
    async set(key, value) {
      secrets.set(key, value);
    },
    async delete(key) {
      secrets.delete(key);
    },
    async list() {
      return [...secrets.keys()].sort();
    },
  };
}
