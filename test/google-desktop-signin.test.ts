// Google sign-in on the computer (owner decision 2026-10-13,
// docs/ops/OAUTH_RELAY.md "Google sign-in on the computer").
//
// With Olympus's Desktop client configured, a Google connect returns to this
// engine on loopback with PKCE, and the engine exchanges and refreshes
// directly with Google using the secret that ships in source: no relay, no
// publisher exchange, no secret stored per credential. Connections made
// earlier through the publisher Web client keep refreshing through the
// exchange endpoint, and their rows offer Reconnect Google once.

import { DEFAULT_PROVIDER_IDENTITY_ENDPOINTS } from '../src/core/provider-account-identity.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import type { OAuthFetch } from '../src/core/connect.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { DEFAULT_OAUTH_RELAY_URL } from '../src/core/oauth-relay.ts';
import { googleDesktopClient, googleDesktopClientSecret, isGoogleDesktopClientId } from '../src/core/publisher-oauth-client.ts';
import { PastedCallbackError, finishPastedOAuthCallback, parsePastedOAuthCallback } from '../src/core/oauth-callback-paste.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { readConnectedHandleRegistry, type ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import {
  createEnvCredentialBroker,
  type EnvCredentialHandleDefinition,
  type EnvOAuth2RefreshDefinition,
} from '../src/workers/credential-broker/index.ts';
import { createChatGptHandoffs } from '../src/workers/chatgpt/handoff.ts';
import { mintCredential } from '../connect-relay/shared/tokens.ts';
import { createChatGptSetupBackend } from '../src/workers/chatgpt/setup-backend.ts';
import { callSetupTool } from '../src/workers/chatgpt/setup-tools.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { CONNECT_SOURCE_TOOL_NAME } from '../src/workers/chatgpt/dashboard-contract.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { DASHBOARD_CHATGPT_VOCABULARY } from '../src/workers/dashboard/vocabulary.ts';

const DESKTOP_CLIENT_ID = 'olympus-desktop-client-id-fixture.apps.googleusercontent.com';
const DESKTOP_CLIENT_SECRET = 'olympus-desktop-client-secret-fixture';
const PUBLISHER_WEB_CLIENT_ID = 'olympus-publisher-google-web-client-id-fixture';
const EXCHANGE_URL = 'https://fake-google-exchange.test/exchange/google';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ENGINE_PORT = 8123;
const NOW = new Date('2026-10-13T12:00:00.000Z');

const ENV_NAMES = [
  'OLYMPUS_GOOGLE_DESKTOP_CLIENT_ID',
  'OLYMPUS_GOOGLE_DESKTOP_CLIENT_SECRET',
  'OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID',
  'OLYMPUS_GOOGLE_PUBLISHER_EXCHANGE_URL',
  'OLYMPUS_GOOGLE_PILOT_CLIENT_ID',
] as const;
const dirs: string[] = [];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  delete process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID;
  process.env.OLYMPUS_GOOGLE_PUBLISHER_WEB_CLIENT_ID = PUBLISHER_WEB_CLIENT_ID;
  process.env.OLYMPUS_GOOGLE_PUBLISHER_EXCHANGE_URL = EXCHANGE_URL;
  useDesktopClient(true);
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function useDesktopClient(on: boolean): void {
  if (on) {
    process.env.OLYMPUS_GOOGLE_DESKTOP_CLIENT_ID = DESKTOP_CLIENT_ID;
    process.env.OLYMPUS_GOOGLE_DESKTOP_CLIENT_SECRET = DESKTOP_CLIENT_SECRET;
  } else {
    delete process.env.OLYMPUS_GOOGLE_DESKTOP_CLIENT_ID;
    delete process.env.OLYMPUS_GOOGLE_DESKTOP_CLIENT_SECRET;
  }
}

describe('the Desktop client configuration', () => {
  test('an override needs both halves; the secret is found by client id only', () => {
    expect(googleDesktopClient()).toEqual({ clientId: DESKTOP_CLIENT_ID, clientSecret: DESKTOP_CLIENT_SECRET });
    expect(googleDesktopClientSecret(DESKTOP_CLIENT_ID)).toBe(DESKTOP_CLIENT_SECRET);
    expect(googleDesktopClientSecret(PUBLISHER_WEB_CLIENT_ID)).toBeUndefined();
    expect(googleDesktopClientSecret(undefined)).toBeUndefined();
    expect(isGoogleDesktopClientId(DESKTOP_CLIENT_ID)).toBe(true);
    expect(googleDesktopClient({ OLYMPUS_GOOGLE_DESKTOP_CLIENT_ID: DESKTOP_CLIENT_ID })).toBeUndefined();
  });
});

interface Fixture {
  /** Through the worker's bearer auth, as a browser or dashboard reaches it. */
  fetch: (request: Request) => Promise<Response>;
  /** The worker itself, as in-process callers (the ChatGPT setup backend) reach it. */
  workerFetch: (request: Request) => Promise<Response>;
  secretStore: SecretStore;
  registryPath: string;
  calls: Array<{ url: string; init: RequestInit }>;
}

function fixture(secrets: Record<string, string> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-google-desktop-'));
  dirs.push(dir);
  const secretStore = memorySecretStore(secrets);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const oauthFetch: OAuthFetch = async (url, init) => {
    const urlString = String(url);
    if (isGoogleIdentityLookup(urlString)) return googleIdentityResponse();
    calls.push({ url: urlString, init: (init ?? {}) as RequestInit });
    return Response.json({
      access_token: 'google-access-token-fixture',
      refresh_token: 'google-refresh-token-fixture',
      expires_in: 3599,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      token_type: 'Bearer',
    });
  };
  const registryPath = join(dir, 'handles.json');
  const worker = createEmailSourceWorker({
    sourceIndexStatus: { async status() { return emptyStatus(); } },
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      registryPath,
      secretStore,
      oauthFetch,
      loopbackPort: ENGINE_PORT,
    },
  });
  return {
    fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' }),
    workerFetch: worker.fetch,
    secretStore,
    registryPath,
    calls,
  };
}

async function start(instance: Fixture, origin: string, body: Record<string, string> = {}): Promise<Response> {
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

/** What Google's redirect back to the engine would carry. */
function callbackAddress(authorize: URL, code = 'google-code-fixture'): string {
  const callback = new URL(authorize.searchParams.get('redirect_uri')!);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', authorize.searchParams.get('state')!);
  return callback.toString();
}

describe('a new Google sign-in returns to this computer', () => {
  test('start uses the Desktop client, PKCE, and a loopback redirect on the port the dashboard was reached on', async () => {
    const cases: Array<[origin: string, redirect: string]> = [
      ['http://localhost:18789', 'http://127.0.0.1:18789/oauth/callback/gmail'],
      ['http://127.0.0.1:8010', 'http://127.0.0.1:8010/oauth/callback/gmail'],
      ['http://[::1]:18789', 'http://127.0.0.1:18789/oauth/callback/gmail'],
      // A dashboard that is not itself on loopback names the engine's own port.
      ['https://olympus.example.org', `http://127.0.0.1:${ENGINE_PORT}/oauth/callback/gmail`],
    ];
    for (const [origin, redirect] of cases) {
      const url = await authorizationUrl(await start(fixture(), origin));
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.get('client_id'), origin).toBe(DESKTOP_CLIENT_ID);
      expect(url.searchParams.get('redirect_uri'), origin).toBe(redirect);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('client_secret')).toBeNull();
      expect(url.toString()).not.toContain(DESKTOP_CLIENT_SECRET);
    }
    const drive = await authorizationUrl(await start(fixture(), 'http://127.0.0.1:8010', { source: 'google-drive' }));
    expect(drive.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8010/oauth/callback/google-drive');
  });

  test('the callback exchanges directly with Google using the shipped secret, and stores no secret', async () => {
    const secretWrites: string[] = [];
    const instance = fixture({
      // A stale bring-your-own secret on file must neither be sent nor referenced.
      'gmail.personal.oauth.client_secret': 'stale-byo-secret',
    });
    const store = instance.secretStore;
    const set = store.set.bind(store);
    store.set = async (key, value) => {
      secretWrites.push(key);
      await set(key, value);
    };
    const authorize = await authorizationUrl(await start(instance, 'http://127.0.0.1:8010'));
    const callback = await instance.fetch(new Request(callbackAddress(authorize)));
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/oauth/callback/gmail/done');

    expect(instance.calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_URL]);
    const body = new URLSearchParams(String(instance.calls[0]!.init.body));
    expect(body.get('client_id')).toBe(DESKTOP_CLIENT_ID);
    expect(body.get('client_secret')).toBe(DESKTOP_CLIENT_SECRET);
    expect(body.get('redirect_uri')).toBe(authorize.searchParams.get('redirect_uri'));
    expect(body.get('code_verifier')).toBeTruthy();

    expect(secretWrites.filter((key) => key.endsWith('.oauth.client_secret'))).toEqual([]);
    expect(await instance.secretStore.get('gmail.personal.oauth.client_id')).toBe(DESKTOP_CLIENT_ID);
    const handle = readConnectedHandleRegistry(instance.registryPath).handles.find((candidate) => candidate.provider === 'gmail');
    expect(handle?.oauth2Refresh?.clientSecretSecretRef).toBeUndefined();
    expect(handle?.oauth2Refresh?.exchangeVia).not.toBe('publisher_endpoint');
  });

  test('without a Desktop client, Google keeps the Web client, relay and exchange it used before', async () => {
    useDesktopClient(false);
    const url = await authorizationUrl(await start(fixture(), 'http://127.0.0.1:8010'));
    expect(url.searchParams.get('client_id')).toBe(PUBLISHER_WEB_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(DEFAULT_OAUTH_RELAY_URL);
  });

  test('a sign-in handed to this computer ends with "go back to ChatGPT"', async () => {
    const instance = fixture();
    const authorize = await authorizationUrl(await start(instance, 'http://127.0.0.1:8010', { handback: 'computer' }));
    const callback = await instance.fetch(new Request(callbackAddress(authorize)));
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/oauth/callback/gmail/done?return=chatgpt');
    const chatgpt = await (await instance.fetch(new Request('http://127.0.0.1:8010/oauth/callback/gmail/done?return=chatgpt'))).text();
    expect(chatgpt).toContain('Back to ChatGPT');
    const dashboard = await (await instance.fetch(new Request('http://127.0.0.1:8010/oauth/callback/gmail/done'))).text();
    expect(dashboard).not.toContain('Back to ChatGPT');
  });

  test('Dropbox never signs in on the computer this way', async () => {
    const refused = await start(fixture(), 'http://127.0.0.1:8010', { source: 'dropbox', handback: 'computer' });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe('oauth_handback_unavailable');
  });
});

describe('ChatGPT hands a Google sign-in to the computer', () => {
  test('the setup backend starts a computer sign-in and the tool returns a computer link', async () => {
    const instance = fixture();
    const handoffs = createChatGptHandoffs();
    const posted: Array<Record<string, unknown>> = [];
    const backend = createChatGptSetupBackend({
      workerFetch: async (request) => {
        posted.push(await request.clone().json() as Record<string, unknown>);
        return instance.workerFetch(request);
      },
      handoffs,
      publicUrls: () => ({ relay: 'https://mcp.olympusplugin.ai', installId: 'install_fixture' }) as never,
      sovereignty: { config: loadSovereigntyPreset('no-sensitive'), source: 'preset' },
      credentialPresent: () => false,
      requestReload: () => false,
    });
    const started = await backend.startOAuth('gmail');
    expect(posted.at(-1)).toMatchObject({ source: 'gmail', handback: 'computer' });
    expect(started.onComputer).toBe(true);
    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe(DESKTOP_CLIENT_ID);
    // In-process: the engine's own port.
    expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${ENGINE_PORT}/oauth/callback/gmail`);

    // Dropbox still returns through the relay (this fixture has no relay link, so the engine refuses it).
    await expect(backend.startOAuth('dropbox')).rejects.toThrow('oauth_handback_unavailable');
    expect(posted.at(-1)).toMatchObject({ source: 'dropbox', handback: 'relay' });
  });

  test('the Connect tool mints a computer link and says to open it on the computer', async () => {
    const minted: unknown[] = [];
    const result = await callSetupTool(CONNECT_SOURCE_TOOL_NAME, { source: 'gmail' }, {
      startOAuth: async () => ({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', expiresAt: NOW.toISOString(), onComputer: true }),
      handoffLink: (target: unknown) => {
        minted.push(target);
        return { url: `https://mcp.olympusplugin.ai/go/${mintCredential('handoff', 'abcdefghijklmnopqrstuvwxyz234567')}`, expiresAt: NOW.toISOString() };
      },
    } as never);
    expect(minted).toEqual([{ kind: 'computer', source: 'gmail', location: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }]);
    expect(JSON.stringify(result)).toContain('on the computer where Olympus runs');
  });
});

describe('olympus connect finish', () => {
  test('a pasted callback address completes the sign-in through this engine', async () => {
    const instance = fixture();
    const authorize = await authorizationUrl(await start(instance, 'https://olympus.example.org'));
    const address = callbackAddress(authorize);
    const seen: string[] = [];
    const finish = (input: string) => finishPastedOAuthCallback(input, {
      workerRoot: 'http://127.0.0.1:8010/',
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(String(url));
        return instance.fetch(new Request(String(url), init));
      }) as typeof fetch,
    });
    const result = await finish(`  '${address}'\n`);
    expect(result).toMatchObject({ ok: true, source: 'gmail', connected: true });
    // Only code and state went on, to the engine's own root.
    expect(new URL(seen[0]!).origin).toBe('http://127.0.0.1:8010');
    expect([...new URL(seen[0]!).searchParams.keys()].sort()).toEqual(['code', 'state']);
    expect(instance.calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_URL]);

    // The same address again: the sign-in is spent, and the person is told so.
    const again = await finish(address).then(() => undefined, (error: unknown) => error);
    expect(again).toBeInstanceOf(PastedCallbackError);
    expect(String((again as Error).message)).not.toContain('google-code-fixture');
  });

  test('only a loopback Olympus callback address is accepted, and only its sign-in values are kept', () => {
    const parsed = parsePastedOAuthCallback('http://127.0.0.1:8010/oauth/callback/gmail?code=c&state=s&extra=x');
    expect(parsed.source).toBe('gmail');
    expect(parsed.query.toString()).toBe('code=c&state=s');
    expect(parsePastedOAuthCallback('http://localhost:9/oauth/callback/google-drive?error=access_denied&state=s').source).toBe('google-drive');
    for (const bad of [
      '',
      'not a url',
      'https://127.0.0.1:8010/oauth/callback/gmail?code=c&state=s',
      'http://evil.example/oauth/callback/gmail?code=c&state=s',
      'http://user:pw@127.0.0.1/oauth/callback/gmail?code=c&state=s',
      'http://127.0.0.1:8010/oauth/callback/evil?code=c&state=s',
      'http://127.0.0.1:8010/oauth/callback/gmail?code=c',
      'http://127.0.0.1:8010/oauth/callback/gmail?code=c&code=d&state=s',
    ]) {
      expect(() => parsePastedOAuthCallback(bad), bad).toThrow(PastedCallbackError);
    }
  });

  test('an engine that does not answer gets a plain sentence', async () => {
    const failing = finishPastedOAuthCallback('http://127.0.0.1:8010/oauth/callback/gmail?code=c&state=s', {
      workerRoot: 'http://127.0.0.1:8010',
      fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    await expect(failing).rejects.toThrow('Olympus did not answer at http://127.0.0.1:8010');
  });
});

describe('refresh', () => {
  function refreshHandle(overrides: Partial<EnvOAuth2RefreshDefinition> = {}): EnvCredentialHandleDefinition {
    return {
      handle: 'gmail.personal',
      provider: 'gmail',
      allowedCapabilities: ['gmail.email.sync'],
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      tokenEnvNames: [],
      oauth2Refresh: {
        tokenUrl: GOOGLE_TOKEN_URL,
        clientIdEnvNames: [],
        clientIdSecretRef: 'store:gmail.personal.oauth.client_id',
        refreshTokenSecretRef: 'store:gmail.personal.oauth.refresh_token',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        ...overrides,
      },
    };
  }

  async function refreshOnce(clientId: string, overrides: Partial<EnvOAuth2RefreshDefinition> = {}, extraSecrets: Record<string, string> = {}) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const broker = createEnvCredentialBroker({
      handles: [refreshHandle(overrides)],
      secretStore: memorySecretStore({
        'gmail.personal.oauth.client_id': clientId,
        'gmail.personal.oauth.refresh_token': 'stored-refresh-token-fixture',
        ...extraSecrets,
      }),
      oauth2CacheNamespace: `google-desktop-refresh-${Math.random()}`,
      loadDefaultHandleRegistry: false,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
        return Response.json({ access_token: 'refreshed-access-token-fixture', expires_in: 3599 });
      },
    });
    const session = await broker.issueSession({ handle: 'gmail.personal', capability: 'gmail.email.sync' });
    expect(session.kind).toBe('bearer_token');
    return calls;
  }

  const desktopBasic = `Basic ${Buffer.from(`${DESKTOP_CLIENT_ID}:${DESKTOP_CLIENT_SECRET}`).toString('base64')}`;

  test('a Desktop connection refreshes directly with Google using the shipped secret', async () => {
    const calls = await refreshOnce(DESKTOP_CLIENT_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GOOGLE_TOKEN_URL);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(desktopBasic);
  });

  test('the shipped secret wins over any other secret configured for the handle', async () => {
    const calls = await refreshOnce(
      DESKTOP_CLIENT_ID,
      { clientSecretSecretRef: 'store:gmail.personal.oauth.client_secret' },
      { 'gmail.personal.oauth.client_secret': 'stale-byo-secret' },
    );
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(desktopBasic);
  });

  test('a legacy publisher connection keeps refreshing through the exchange endpoint', async () => {
    const calls = await refreshOnce(PUBLISHER_WEB_CLIENT_ID, { exchangeVia: 'publisher_endpoint' });
    expect(calls.map((call) => call.url)).toEqual([`${EXCHANGE_URL}/refresh`]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ refresh_token: 'stored-refresh-token-fixture' });
    expect(String(calls[0]!.init.body)).not.toContain(DESKTOP_CLIENT_SECRET);
  });
});

describe('Reconnect Google, once, for a legacy connection', () => {
  function gmailView(exchangeVia: 'publisher_endpoint' | undefined) {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: gmailStatus(),
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      connectedHandleRegistry: gmailRegistry(exchangeVia),
      now: NOW,
    });
    // Every stage finished, so the row reads Fresh.
    return {
      ...view,
      sources: view.sources.map((card) => (card.source_id === 'gmail.email'
        ? {
          ...card,
          connection: { ...card.connection, state: 'synced' as const, label: 'synced 41 minutes ago' },
          freshness: { label: 'Last checked 41 minutes ago', hours: 0.68, threshold_hours: 26, stale: false },
          coverage: { indexed_items: 120, content_ready_items: 120, embedded_items: 0, needs_review_items: 0, answer_ready_eligible_items: 120 },
          ingestion_health: { coverage_percent: 100, stuck_count: 0, drain_state: 'enabled' as const, label: '100% covered; nothing stuck' },
          queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
          answer_readiness: { state: 'ready' as const, label: 'Ready for questions' },
        }
        : card)),
    };
  }
  const gmailCard = (view: ReturnType<typeof gmailView>) => view.sources.find((card) => card.source_id === 'gmail.email')!;
  const chatgptGmail = (view: ReturnType<typeof gmailView>) =>
    buildChatGptDashboardViewModel(view, { now: NOW }).sources.find((source) => source.id === 'gmail.email')!;

  test('a Fresh legacy row offers Reconnect Google with one line of copy', () => {
    const view = gmailView('publisher_endpoint');
    expect(gmailCard(view).connection.google_signin_moved).toBe(true);
    const row = chatgptGmail(view);
    expect(row.status).toBe('Fresh');
    expect(row.primary).toEqual({ label: 'Reconnect Google', tool: CONNECT_SOURCE_TOOL_NAME, args: { source: 'gmail' } });
    expect(row.detail).toBe(DASHBOARD_CHATGPT_VOCABULARY.googleSigninMoved);
  });

  test('no nudge for a Desktop connection, or before a Desktop client is configured', () => {
    expect(gmailCard(gmailView(undefined)).connection.google_signin_moved).toBeUndefined();
    expect(chatgptGmail(gmailView(undefined)).primary).toBeUndefined();
    useDesktopClient(false);
    expect(gmailCard(gmailView('publisher_endpoint')).connection.google_signin_moved).toBeUndefined();
  });
});

function gmailRegistry(exchangeVia: 'publisher_endpoint' | undefined): ConnectedHandleRegistry {
  return {
    version: 1,
    handles: [{
      handle: 'gmail.personal',
      provider: 'gmail',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['gmail.email.sync'],
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      oauth2Refresh: {
        tokenUrl: GOOGLE_TOKEN_URL,
        clientIdSecretRef: 'store:gmail.personal.oauth.client_id',
        refreshTokenSecretRef: 'store:gmail.personal.oauth.refresh_token',
        scopes: [],
        ...(exchangeVia ? { exchangeVia } : {}),
      },
      connectedAt: '2026-10-12T10:00:00.000Z',
    }],
  } as ConnectedHandleRegistry;
}

function gmailStatus(): SourceIndexStatusResult {
  return {
    ...emptyStatus(),
    corpora: [{
      corpus_id: 'secure_local.gmail.email',
      family: 'email',
      trust_domain: 'secure_local',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'local_only',
      configured: true,
      provider: 'gmail',
      read_authority: 'legacy_index',
      counts: {
        accounts: 1,
        messages: 120,
        items_with_text: 120,
        qa_eligible_items: 120,
        extraction_jobs_queued: 0,
        extraction_jobs_queued_actionable: 0,
        extraction_jobs_leased_current: 0,
        extraction_jobs_leased_current_actionable: 0,
        extraction_jobs_failed: 0,
        extraction_jobs_failed_actionable: 0,
      },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'secure_local_item_metadata_not_exposed_to_castor',
    }],
  } as unknown as SourceIndexStatusResult;
}

function emptyStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: NOW.toISOString(),
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
    async get(key) { return secrets.get(key); },
    getSync(key) { return secrets.get(key); },
    async set(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); },
    async list() { return [...secrets.keys()].sort(); },
  };
}

function isGoogleIdentityLookup(url: string): boolean {
  return url === DEFAULT_PROVIDER_IDENTITY_ENDPOINTS.gmail
    || url === DEFAULT_PROVIDER_IDENTITY_ENDPOINTS.google_drive
    || url === DEFAULT_PROVIDER_IDENTITY_ENDPOINTS.google_tokeninfo;
}

function googleIdentityResponse(): Response {
  return Response.json({
    emailAddress: 'owner@example.test',
    user: { emailAddress: 'owner@example.test', permissionId: '01234567890123456789' },
    sub: '109876543210987654321',
    scope: 'openid https://www.googleapis.com/auth/gmail.readonly',
  });
}
