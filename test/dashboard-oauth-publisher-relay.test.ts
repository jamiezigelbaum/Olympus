// Publisher-client mode end to end: the dashboard connects Dropbox through
// Olympus's own registered app and the static callback relay, for a dashboard
// origin the publisher could never have registered.
//
// Everything here runs through `withWorkerBearerAuth`, because the callback is
// the one dashboard route that is deliberately UNAUTHENTICATED — a provider
// redirect is a GET anyone can make — and the auth wrapper is what decides that.
// The fake provider is an injected `oauthFetch`, so the exchange's own
// `redirect_uri` is readable and can be compared with what /start sent: the two
// must be the identical string or the providers refuse the exchange.

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
import { DEFAULT_OAUTH_RELAY_URL } from '../src/core/oauth-relay.ts';
import { dashboardOAuthConnectSheet } from '../src/workers/dashboard/components.ts';
import type { DashboardSourceAction } from '../src/workers/source-dashboard.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';

const PUBLISHER_APP_KEY = 'olympus-publisher-dropbox-app-key';
const DASHBOARD_ORIGIN = 'https://olympus.example.org';

const dirs: string[] = [];
let previousAppKey: string | undefined;

beforeEach(() => {
  previousAppKey = process.env.OLYMPUS_DROPBOX_PUBLISHER_APP_KEY;
  process.env.OLYMPUS_DROPBOX_PUBLISHER_APP_KEY = PUBLISHER_APP_KEY;
});

afterEach(() => {
  if (previousAppKey === undefined) delete process.env.OLYMPUS_DROPBOX_PUBLISHER_APP_KEY;
  else process.env.OLYMPUS_DROPBOX_PUBLISHER_APP_KEY = previousAppKey;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  fetch: (request: Request) => Promise<Response>;
  secretStore: SecretStore;
  exchanges: Array<URLSearchParams>;
}

function fixture(initialSecrets: Record<string, string> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-worker-'));
  dirs.push(dir);
  const secretStore = memorySecretStore(initialSecrets);
  const exchanges: URLSearchParams[] = [];
  const oauthFetch: OAuthFetch = async (_url, init) => {
    exchanges.push(new URLSearchParams(String(init?.body ?? '')));
    return new Response(JSON.stringify({
      access_token: 'dropbox-access-token-fixture',
      refresh_token: 'dropbox-refresh-token-fixture',
      expires_in: 14_400,
      token_type: 'bearer',
      scope: 'files.metadata.read files.content.read sharing.read',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const worker = createEmailSourceWorker({
    sourceIndexStatus: { async status() { return fixtureStatus(); } },
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      registryPath: join(dir, 'handles.json'),
      secretStore,
      oauthFetch,
    },
  });
  return {
    fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' }),
    secretStore,
    exchanges,
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
    body: JSON.stringify({ source: 'dropbox', ...body }),
  }));
}

async function authorizationUrl(started: Response): Promise<URL> {
  expect(started.status).toBe(200);
  return new URL((await started.json()).authorization_url);
}

function statePayload(state: string): Record<string, unknown> {
  const [segment] = state.split('.') as [string];
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('publisher-client relay flow', () => {
  test('start sends the publisher app key, the relay URL, and a signed state naming this dashboard', async () => {
    const instance = fixture();
    const url = await authorizationUrl(await startConnect(instance));

    expect(url.origin).toBe('https://www.dropbox.com');
    expect(url.searchParams.get('client_id')).toBe(PUBLISHER_APP_KEY);
    // The one registered redirect URI, trailing slash included. Providers match
    // the string, not a prefix.
    expect(url.searchParams.get('redirect_uri')).toBe(DEFAULT_OAUTH_RELAY_URL);
    // PKCE still rides along, and the verifier never leaves this worker.
    expect(url.searchParams.get('code_challenge')).toBeTruthy();

    const state = url.searchParams.get('state')!;
    expect(statePayload(state)).toEqual({
      v: 1,
      origin: DASHBOARD_ORIGIN,
      source: 'dropbox',
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
      iat: expect.any(Number),
    });
    // No signing key, no relay URL, no state ever reaches the response body.
    const body = JSON.stringify(await (await startConnect(instance)).json());
    expect(body).not.toContain('relay_state_key');
  });

  test('a relay-bounced callback completes, and the exchange uses the identical redirect_uri', async () => {
    const instance = fixture();
    const started = await authorizationUrl(await startConnect(instance));
    const state = started.searchParams.get('state')!;

    // Exactly the request the relay page builds: the dashboard's own origin,
    // /oauth/callback/<source>, code and state and nothing else.
    const callback = await instance.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=relay-code-1&state=${encodeURIComponent(state)}`,
    ));
    expect(callback.status).toBe(200);

    expect(instance.exchanges).toHaveLength(1);
    expect(instance.exchanges[0]!.get('redirect_uri')).toBe(DEFAULT_OAUTH_RELAY_URL);
    expect(instance.exchanges[0]!.get('redirect_uri'))
      .toBe(started.searchParams.get('redirect_uri'));
    expect(instance.exchanges[0]!.get('code')).toBe('relay-code-1');
    expect(instance.exchanges[0]!.get('code_verifier')).toBeTruthy();
    expect(await instance.secretStore.get('dropbox.personal.oauth.refresh_token'))
      .toBe('dropbox-refresh-token-fixture');
  });

  test('the signing key is worker-local and is minted once', async () => {
    const instance = fixture();
    await startConnect(instance);
    const key = await instance.secretStore.get('dashboard.oauth.relay_state_key');
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await startConnect(instance);
    expect(await instance.secretStore.get('dashboard.oauth.relay_state_key')).toBe(key!);
  });

  test('every relay refusal is indistinguishable from every other', async () => {
    const refusals: Array<{ name: string; path: string; run: () => Promise<Response> }> = [];

    // A tampered signature over an otherwise perfect state.
    refusals.push({
      name: 'bad signature',
      path: 'dropbox',
      run: async () => {
        const instance = fixture();
        const started = await authorizationUrl(await startConnect(instance));
        const [segment, signature] = started.searchParams.get('state')!.split('.') as [string, string];
        const forged = `${segment}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
        return instance.fetch(new Request(
          `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(forged)}`,
        ));
      },
    });

    // The same code and state delivered twice: the attempt is consumed, so the
    // nonce cannot be replayed.
    refusals.push({
      name: 'replayed nonce',
      path: 'dropbox',
      run: async () => {
        const instance = fixture();
        const started = await authorizationUrl(await startConnect(instance));
        const state = started.searchParams.get('state')!;
        const first = await instance.fetch(new Request(
          `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c1&state=${encodeURIComponent(state)}`,
        ));
        expect(first.status).toBe(200);
        return instance.fetch(new Request(
          `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c2&state=${encodeURIComponent(state)}`,
        ));
      },
    });

    // A state minted for this dashboard, delivered to a worker that derives a
    // different origin for itself. The signature is genuine; the origin is not.
    refusals.push({
      name: 'foreign origin',
      path: 'dropbox',
      run: async () => {
        const instance = fixture();
        const started = await authorizationUrl(await startConnect(instance));
        const state = started.searchParams.get('state')!;
        return instance.fetch(new Request(
          `https://other.example.org/oauth/callback/dropbox?code=c&state=${encodeURIComponent(state)}`,
        ));
      },
    });

    // A dropbox state offered on the gmail callback path.
    refusals.push({
      name: 'crossed source',
      path: 'gmail',
      run: async () => {
        const instance = fixture();
        const started = await authorizationUrl(await startConnect(instance));
        const state = started.searchParams.get('state')!;
        return instance.fetch(new Request(
          `${DASHBOARD_ORIGIN}/oauth/callback/gmail?code=c&state=${encodeURIComponent(state)}`,
        ));
      },
    });

    // No state at all, and a state for a flow nobody started.
    refusals.push({
      name: 'unsolicited callback',
      path: 'dropbox',
      run: async () => fixture().fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=aaaa.bbbb`,
      )),
    });

    const answers = new Map<string, Set<string>>();
    for (const refusal of refusals) {
      const response = await refusal.run();
      expect(response.status, refusal.name).toBe(410);
      const page = await response.text();
      // Nothing about which check fired, and no state or code echoed back.
      expect(page, refusal.name).not.toContain('signature');
      expect(page, refusal.name).not.toContain('nonce');
      expect(page, refusal.name).not.toContain('relay');
      const seen = answers.get(refusal.path) ?? new Set<string>();
      seen.add(`${response.status}:${page}`);
      answers.set(refusal.path, seen);
    }
    // One answer for every refusal on a path. The page names the source it was
    // called on, which the caller chose by picking the path — so the gmail
    // refusal is compared with gmail's, and telling the two apart proves
    // nothing about whether either flow exists.
    for (const [path, seen] of answers) expect(seen.size, path).toBe(1);
    const dropbox = [...answers.get('dropbox')!][0]!;
    const gmail = [...answers.get('gmail')!][0]!;
    expect(gmail).toBe(dropbox.replaceAll('dropbox', 'gmail'));
  });

  test('an owner-supplied client id keeps the bring-your-own flow, unsigned state and all', async () => {
    const instance = fixture();
    const url = await authorizationUrl(await startConnect(instance, { client_id: 'owner-dropbox-app-key' }));
    expect(url.searchParams.get('client_id')).toBe('owner-dropbox-app-key');
    expect(url.searchParams.get('redirect_uri')).toBe(`${DASHBOARD_ORIGIN}/oauth/callback/dropbox`);
    // A bring-your-own flow's state is the opaque PKCE state, not a signed
    // relay payload: one segment, nothing to decode.
    expect(url.searchParams.get('state')).not.toContain('.');
    expect(await instance.secretStore.get('dashboard.oauth.relay_state_key')).toBeUndefined();
  });

  test('a client id already on file keeps the bring-your-own flow', async () => {
    const instance = fixture({ 'dropbox.personal.oauth.client_id': 'stored-dropbox-app-key' });
    const url = await authorizationUrl(await startConnect(instance));
    expect(url.searchParams.get('client_id')).toBe('stored-dropbox-app-key');
    expect(url.searchParams.get('redirect_uri')).toBe(`${DASHBOARD_ORIGIN}/oauth/callback/dropbox`);
  });

  test('X is never publisher-owned and never touches the relay', async () => {
    const instance = fixture();
    const refused = await instance.fetch(new Request(`${DASHBOARD_ORIGIN}/dashboard/connect/oauth/start`, {
      method: 'POST',
      headers: { Authorization: 'Bearer dashboard-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'x' }),
    }));
    // No publisher app to fall back on: X still asks for the owner's own client.
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe('oauth_client_id_missing');
  });
});

describe('publisher-mode card', () => {
  async function dashboardJson(instance: Fixture, origin = DASHBOARD_ORIGIN) {
    const response = await instance.fetch(new Request(`${origin}/dashboard.json`, {
      headers: { Authorization: 'Bearer dashboard-secret' },
    }));
    expect(response.status).toBe(200);
    return await response.json();
  }

  function dropboxAction(view: { sources: Array<Record<string, any>> }): Record<string, any> {
    return view.sources.find((source) => source.source_id === 'dropbox.files')!.connection.action;
  }

  test('a publisher-owned source offers Connect with no client id and no walkthrough field', async () => {
    const action = dropboxAction(await dashboardJson(fixture()));
    expect(action.kind).toBe('oauth');
    expect(action.publisher_client).toBe(true);
    expect(action.label).toBe('Connect');
    // The publisher's app key is a public identifier, but the card has no use
    // for it, so it is not on the read-only surface either.
    expect(action.known_client_id).toBeUndefined();
    expect(JSON.stringify(action)).not.toContain(PUBLISHER_APP_KEY);
    expect(JSON.stringify(action)).not.toContain('auth.olympusplugin.ai');
  });

  test('an install with its own app key keeps today’s bring-your-own card', async () => {
    const instance = fixture({ 'dropbox.personal.oauth.client_id': 'stored-dropbox-app-key' });
    const action = dropboxAction(await dashboardJson(instance));
    expect(action.kind).toBe('oauth');
    expect(action.publisher_client).toBeUndefined();
    expect(action.known_client_id).toBe('stored-dropbox-app-key');
    expect(action.callback_registration.required).toBe(true);
  });

  test('with no publisher app configured the card is unchanged', async () => {
    delete process.env.OLYMPUS_DROPBOX_PUBLISHER_APP_KEY;
    const action = dropboxAction(await dashboardJson(fixture()));
    // The shipped default: nothing registered anywhere, so the owner is asked
    // to set up their own app exactly as before.
    expect(action.kind).toBe('needs_setup');
    expect(action.publisher_client).toBeUndefined();
  });

  test('the read-only dashboard surface leaks no key, app key, or state', async () => {
    const instance = fixture();
    const state = (await authorizationUrl(await startConnect(instance))).searchParams.get('state')!;
    const view = JSON.stringify(await dashboardJson(instance));
    expect(view).not.toContain('relay_state_key');
    expect(view).not.toContain(await instance.secretStore.get('dashboard.oauth.relay_state_key')!);
    expect(view).not.toContain(PUBLISHER_APP_KEY);
    // The pending attempt shows as a card that is connecting — never as the
    // state it is waiting on, or either of that state's segments.
    expect(view).not.toContain(state);
    for (const segment of state.split('.')) expect(view).not.toContain(segment);
    expect(view).toContain('awaiting_consent');
  });
});

describe('publisher-mode sheet', () => {
  const instructions = {
    plain_intro: 'Olympus needs a Dropbox app key.',
    agent_prompt: 'Set up Dropbox for Olympus.',
    provider_console_url: 'https://www.dropbox.com/developers/apps',
    diy_summary: 'Or do it yourself',
    diy_steps: [],
    secret_shown_once: false,
    fields: [{ name: 'client_id' as const, label: 'App key', required: true, secret: false }],
  };
  const registration = {
    required: true,
    console: { label: 'Open the Dropbox App Console', url: 'https://www.dropbox.com/developers/apps' },
    app_requirements: 'Create or pick a Scoped access app named Olympus.',
    setting_label: 'OAuth 2 → Redirect URIs',
    redirect_uri: 'https://olympus.example.org/oauth/callback/dropbox',
    finish: 'Copy the App key back into the field below and press Connect.',
  };

  function sheetFor(action: Partial<Extract<DashboardSourceAction, { kind: 'oauth' }>>): string {
    return dashboardOAuthConnectSheet(
      { source_id: 'dropbox.files', label: 'Dropbox' },
      {
        kind: 'oauth',
        source: 'dropbox',
        label: 'Connect',
        instructions,
        callback_registration: registration,
        redirect_uri_to_register: registration.redirect_uri,
        ...action,
      } as Extract<DashboardSourceAction, { kind: 'oauth' }>,
    )!.sheet;
  }

  test('publisher mode leads with Connect alone and keeps bring-your-own one click away', () => {
    const sheet = sheetFor({ publisher_client: true });
    const [lead, disclosure] = sheet.split('<details') as [string, string];
    // Nothing to fill in and nothing to register before the button.
    expect(lead).not.toContain('keyfield');
    expect(lead).not.toContain('Redirect URI');
    expect(lead).not.toContain(registration.redirect_uri);
    expect(lead).toContain('through its own registered app');
    expect(lead).toContain('<button class="btn primary" type="submit">Connect</button>');
    expect(lead).toContain('name="source" value="dropbox"');
    // The whole bring-your-own path survives, behind one disclosure.
    expect(disclosure).toContain('Use my own app instead');
    expect(disclosure).toContain('keyfield');
    expect(disclosure).toContain(registration.redirect_uri);
    expect(disclosure).toContain(registration.setting_label.replace('→', '→'));
  });

  test('bring-your-own mode is exactly what it was', () => {
    const sheet = sheetFor({ known_client_id: 'stored-dropbox-app-key' });
    expect(sheet).not.toContain('Use my own app instead');
    expect(sheet).not.toContain('through its own registered app');
    const [lead] = sheet.split('<details') as [string];
    expect(lead).toContain('keyfield');
    expect(lead).toContain('value="stored-dropbox-app-key"');
  });

  test('every rendered value is escaped', () => {
    const sheet = dashboardOAuthConnectSheet(
      { source_id: 'dropbox.files', label: '<img src=x onerror=alert(1)>' },
      {
        kind: 'oauth',
        source: 'dropbox',
        label: 'Connect',
        publisher_client: true,
        instructions,
      } as Extract<DashboardSourceAction, { kind: 'oauth' }>,
    )!.sheet;
    expect(sheet).not.toContain('<img src=x');
    expect(sheet).toContain('&lt;img src=x onerror=alert(1)&gt;');
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
