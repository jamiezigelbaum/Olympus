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
import { startExternalOAuthSourceConnection } from '../src/core/connect.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { DEFAULT_OAUTH_RELAY_URL, googlePublisherExchangeUrl, googlePublisherExchangeRefreshUrl } from '../src/core/oauth-relay.ts';
import { DEFAULT_GOOGLE_PUBLISHER_WEB_CLIENT_ID } from '../src/core/publisher-oauth-client.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import {
  readConnectedHandleRegistry,
  writeConnectedHandleRegistry,
} from '../src/workers/credential-broker/connected-handles.ts';
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
  /** Secret-store contents this install already holds before the connect. */
  secrets?: Record<string, string>;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-google-exchange-worker-'));
  dirs.push(dir);
  const secretStore = memorySecretStore(options.secrets ?? {});
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

// Codex round 1 on 5cb644b9, MAJOR 1. `resolveOAuthClientSecret` searches the
// `google`/`gmail`/`google-drive` namespaces for ANY stored Google secret and
// falls back to the pilot client's env secret, none of which is checked
// against the client id actually in use. While it ran BEFORE the publisher
// route was decided, a stranger's secret was resolved, copied under this
// source's own key, and referenced from the handle registry — giving a
// publisher credential (which has no secret, by construction) a
// `clientSecretSecretRef` pointing at someone else's.
describe('the publisher path never touches a client secret it does not own', () => {
  const STALE_SECRETS = {
    'google.personal.oauth.client_secret': 'stale-google-namespace-secret',
    'google-drive.personal.oauth.client_secret': 'stale-drive-namespace-secret',
  };
  let previousPilotSecret: string | undefined;

  beforeEach(() => {
    previousPilotSecret = process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET;
    process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET = 'stale-pilot-env-secret';
  });

  afterEach(() => {
    restoreEnv('OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET', previousPilotSecret);
  });

  test('a stale secret under any Google namespace is neither sent, copied, nor referenced', async () => {
    const instance = fixture({ secrets: { ...STALE_SECRETS } });
    const started = await authorizationUrl(await startConnect(instance));
    const state = started.searchParams.get('state')!;
    const callback = await instance.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/gmail?code=relay-code-1&state=${encodeURIComponent(state)}`,
    ));
    expect(callback.status).toBe(303);

    // Not sent: not in the JSON body, not in a header, not anywhere on the wire.
    const wire = JSON.stringify(instance.calls);
    for (const stale of [...Object.values(STALE_SECRETS), 'stale-pilot-env-secret']) {
      expect(wire).not.toContain(stale);
    }
    expect(JSON.parse(String(instance.calls[0]!.init.body))).not.toHaveProperty('client_secret');

    // Not copied: the connect must not mint a secret under the source's own
    // key out of one that belongs to a different registration.
    expect(await instance.secretStore.get('gmail.personal.oauth.client_secret')).toBeUndefined();
    // ...and the ones it found are left exactly as they were.
    expect(await instance.secretStore.get('google.personal.oauth.client_secret'))
      .toBe(STALE_SECRETS['google.personal.oauth.client_secret']);

    // Not referenced: nothing in the registry tells a later refresh to go
    // looking for a secret this credential does not have.
    const registry = readConnectedHandleRegistry(instance.registryPath);
    const handle = registry.handles.find((entry) => entry.handle === 'gmail.personal');
    expect(handle?.oauth2Refresh?.clientSecretSecretRef).toBeUndefined();
    expect(handle?.oauth2Refresh?.exchangeVia).toBe('publisher_endpoint');
    expect(JSON.stringify(registry)).not.toContain('client_secret');
  });

  test('a bring-your-own Google connect still keeps the secret its own registration was issued with', async () => {
    // The same resolver, on the path it exists for: an owner-registered client
    // id whose secret is on file must still reach the exchange.
    const instance = fixture({
      secrets: {
        'gmail.personal.oauth.client_id': 'owner-registered-byo-client-id',
        'gmail.personal.oauth.client_secret': 'owner-registered-byo-client-secret',
      },
    });
    const started = await authorizationUrl(await startConnect(instance));
    expect(started.searchParams.get('client_id')).toBe('owner-registered-byo-client-id');
    const state = started.searchParams.get('state')!;
    await instance.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/gmail?code=byo-code-1&state=${encodeURIComponent(state)}`,
    ));

    expect(instance.calls).toHaveLength(1);
    expect(instance.calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    const params = new URLSearchParams(String(instance.calls[0]!.init.body ?? ''));
    expect(params.get('client_secret')).toBe('owner-registered-byo-client-secret');
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
      // Owns no registry: never let a test reach the default handles.json.
      loadDefaultHandleRegistry: false,
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
      // Owns no registry: never let a test reach the default handles.json.
      loadDefaultHandleRegistry: false,
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
      // Owns no registry: never let a test reach the default handles.json.
      loadDefaultHandleRegistry: false,
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
      // Owns no registry: never let a test reach the default handles.json.
      loadDefaultHandleRegistry: false,
      fetch: async () => {
        throw new Error('network is down');
      },
    });

    await expect(broker.issueSession({ handle: 'gmail.personal', capability: 'gmail.email.sync' }))
      .rejects.toBeInstanceOf(CredentialBrokerError);
  });
});

// Codex round 1 on 5cb644b9, MAJOR 2. A credential connected before
// `exchangeVia` existed is recognised only by its stored client id. If that
// recognition is against the CURRENT default, the day the default rotates
// every such credential silently falls to the direct-Google branch, which has
// no secret to send, is refused, and latches the handle into reauth — a dead
// source the user never touched. Two independent defences are tested here: the
// published set is append-only, and the field is written durably on first use.
describe('legacy publisher credentials survive a client-id rotation', () => {
  let previousWebId: string | undefined;

  beforeEach(() => {
    previousWebId = process.env.OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID;
  });

  afterEach(() => {
    restoreEnv('OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID', previousWebId);
  });

  function legacyRegistry(registryPath: string, clientIdKey: string): void {
    writeConnectedHandleRegistry({
      version: 1,
      handles: [{
        handle: 'gmail.personal',
        provider: 'gmail',
        accountRole: 'personal',
        trustDomain: 'secure_local',
        allowedCapabilities: ['gmail.email.sync'],
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        oauth2Refresh: {
          tokenUrl: 'https://oauth2.googleapis.com/token',
          clientIdSecretRef: `store:${clientIdKey}`,
          refreshTokenSecretRef: 'store:gmail.personal.oauth.refresh_token',
          scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          // No `exchangeVia`: this is the pre-migration shape.
        },
        connectedAt: '2026-09-01T00:00:00.000Z',
      }],
    }, registryPath);
  }

  function refreshingBroker(options: {
    registryPath: string;
    secretStore: SecretStore;
    calls: Array<{ url: string }>;
    namespace: string;
    env?: Record<string, string | undefined>;
  }) {
    return createEnvCredentialBroker({
      handleRegistryPath: options.registryPath,
      secretStore: options.secretStore,
      oauth2CacheNamespace: options.namespace,
      env: options.env ?? {},
      fetch: async (url) => {
        options.calls.push({ url: String(url) });
        return new Response(JSON.stringify({ access_token: 'refreshed-access-token-fixture', expires_in: 3599 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
  }

  test('the first refresh of a legacy handle writes exchangeVia, and a later rotation cannot unroute it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-google-exchange-legacy-'));
    dirs.push(dir);
    const registryPath = join(dir, 'handles.json');
    legacyRegistry(registryPath, 'gmail.personal.oauth.client_id');
    const secretStore = memorySecretStore({
      'gmail.personal.oauth.client_id': PUBLISHER_WEB_CLIENT_ID,
      'gmail.personal.oauth.refresh_token': 'stored-refresh-token-fixture',
    });
    process.env.OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID = PUBLISHER_WEB_CLIENT_ID;

    const first: Array<{ url: string }> = [];
    await refreshingBroker({
      registryPath,
      secretStore,
      calls: first,
      namespace: `legacy-migrate-${dir}`,
      // This install's publisher id, as the broker sees it.
      env: { OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID: PUBLISHER_WEB_CLIENT_ID },
    }).issueSession({ handle: 'gmail.personal', capability: 'gmail.email.sync' });
    expect(first).toEqual([{ url: EXCHANGE_REFRESH_URL }]);

    // Durable, not re-derived: the fact is now on disk.
    const migrated = readConnectedHandleRegistry(registryPath).handles
      .find((handle) => handle.handle === 'gmail.personal');
    expect(migrated?.oauth2Refresh?.exchangeVia).toBe('publisher_endpoint');

    // Now rotate the publisher client id out from under the stored one. The
    // value-match no longer holds; the written field is what keeps this
    // credential refreshing instead of dying at Google with no secret.
    const afterRotation: Array<{ url: string }> = [];
    await refreshingBroker({
      registryPath,
      secretStore,
      calls: afterRotation,
      namespace: `legacy-rotated-${dir}`,
      // The rotation: nothing this install can see still names the stored id.
      env: { OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID: 'rotated-publisher-web-client-id' },
    }).issueSession({ handle: 'gmail.personal', capability: 'gmail.email.sync' });
    expect(afterRotation).toEqual([{ url: EXCHANGE_REFRESH_URL }]);
  });

  test('a published-but-superseded client id still routes to the endpoint with no migration at all', async () => {
    // The rotation happened before this install ever refreshed, so no
    // migration has run and the stored id is not the current one. It is still
    // an id Olympus published, which is what `GOOGLE_PUBLISHER_WEB_CLIENT_IDS`
    // is for.
    const calls: Array<{ url: string }> = [];
    const secretStore = memorySecretStore({
      'gmail.personal.oauth.client_id': DEFAULT_GOOGLE_PUBLISHER_WEB_CLIENT_ID,
      'gmail.personal.oauth.refresh_token': 'stored-refresh-token-fixture',
    });
    const broker = createEnvCredentialBroker({
      handles: [{
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
        },
      }],
      secretStore,
      oauth2CacheNamespace: `legacy-published-${Math.random()}`,
      // Owns no registry: never let a test reach the default handles.json.
      loadDefaultHandleRegistry: false,
      // The current id is NOT the stored one: only the append-only published
      // set can recognise this credential.
      env: { OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID: 'rotated-publisher-web-client-id' },
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
});

// Codex round 1 on 5cb644b9, MAJOR 3. `fetchWithTimeout` cleared its timer the
// moment the response headers arrived, so the deadline bounded the handshake
// and not the call: a peer that answered and then dribbled its body held
// connect (or a refresh) open indefinitely, and an unbounded `response.text()`
// would buffer whatever it did send.
describe('the exchange and refresh bodies are read under the deadline and a byte cap', () => {
  function neverEndingBody(): Response {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"access_token":"'));
        // ...and never closes.
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  async function publisherExchange(response: () => Response): Promise<() => Promise<unknown>> {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-google-exchange-bounded-'));
    dirs.push(dir);
    const pending = await startExternalOAuthSourceConnection({
      source: 'gmail',
      clientId: PUBLISHER_WEB_CLIENT_ID,
      redirectUri: DEFAULT_OAUTH_RELAY_URL,
      state: 'AAAA.BBBB',
      secretStore: memorySecretStore(),
      registryPath: join(dir, 'handles.json'),
      openBrowser: false,
      tokenExchangeTimeoutMs: 250,
      fetch: async () => response(),
    });
    // A thunk, not the promise: awaiting the helper must not be what surfaces
    // the rejection, or `expect(...).rejects` never sees it.
    return () => pending.completeCallback({ state: 'AAAA.BBBB', code: 'bounded-code-1' });
  }

  test('a body that never ends fails the exchange on its own deadline instead of hanging', async () => {
    const run = await publisherExchange(neverEndingBody);
    const started = Date.now();
    await expect(run()).rejects.toThrow(/timed out/);
    // The deadline was 250ms; anything near the old behaviour would sit here
    // until the process gave up.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  test('an oversized exchange response is refused without repeating any of it', async () => {
    const marker = 'A'.repeat(80 * 1024);
    const run = await publisherExchange(() => new Response(`{"marker":"${marker}"}`, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(run()).rejects.toThrow(/oversized response/);
  }, 15_000);

  test('an oversized refresh response is a bounded broker refusal, not an unbounded read', async () => {
    const secretStore = memorySecretStore({
      'gmail.personal.oauth.client_id': PUBLISHER_WEB_CLIENT_ID,
      'gmail.personal.oauth.refresh_token': 'stored-refresh-token-fixture',
    });
    const broker = createEnvCredentialBroker({
      handles: [{
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
          exchangeVia: 'publisher_endpoint',
          scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        },
      }],
      secretStore,
      oauth2CacheNamespace: `bounded-refresh-${Math.random()}`,
      // Owns no registry: never let a test reach the default handles.json.
      loadDefaultHandleRegistry: false,
      env: { OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID: PUBLISHER_WEB_CLIENT_ID },
      fetch: async () => new Response('B'.repeat(80 * 1024), { status: 200 }),
    });

    await expect(broker.issueSession({ handle: 'gmail.personal', capability: 'gmail.email.sync' }))
      .rejects.toBeInstanceOf(CredentialBrokerError);
  });

  test('the direct-to-provider refresh lane is capped too', async () => {
    const secretStore = memorySecretStore({
      'gmail.personal.oauth.client_id': 'owner-registered-byo-client-id',
      'gmail.personal.oauth.refresh_token': 'stored-refresh-token-fixture',
    });
    const broker = createEnvCredentialBroker({
      handles: [{
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
        },
      }],
      secretStore,
      oauth2CacheNamespace: `bounded-direct-refresh-${Math.random()}`,
      // Owns no registry: never let a test reach the default handles.json.
      loadDefaultHandleRegistry: false,
      env: {},
      // A bring-your-own client id: this lane goes straight to Google.
      fetch: async () => new Response('C'.repeat(80 * 1024), { status: 200 }),
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
