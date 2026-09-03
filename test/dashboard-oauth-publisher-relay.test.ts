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

import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import type { OAuthFetch, ExternalPendingOAuthConnection } from '../src/core/connect.ts';
import { startExternalOAuthSourceConnection } from '../src/core/connect.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import {
  createOAuthRelayStateKey,
  signOAuthRelayState,
  DEFAULT_OAUTH_RELAY_URL,
  OAUTH_RELAY_STATE_TTL_MS,
} from '../src/core/oauth-relay.ts';
import { DEFAULT_DROPBOX_PUBLISHER_APP_KEY } from '../src/core/publisher-oauth-client.ts';
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

function fixture(
  initialSecrets: Record<string, string> = {},
  options: { attemptExpiresInMs?: number } = {},
): Fixture {
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
      // Only used by the 'expired state' scenario below: the real starter,
      // with its honest ~10-minute expiry replaced by a near-immediate one, so
      // the test can wait a few milliseconds instead of ten real minutes to
      // reach a genuinely expired attempt.
      ...(options.attemptExpiresInMs === undefined ? {} : {
        startExternalOAuthConnection: async (
          connectOptions: Parameters<typeof startExternalOAuthSourceConnection>[0],
        ): Promise<ExternalPendingOAuthConnection> => {
          const pending = await startExternalOAuthSourceConnection(connectOptions);
          return { ...pending, expiresAt: new Date(Date.now() + options.attemptExpiresInMs!).toISOString() };
        },
      }),
    },
  });
  return {
    fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' }),
    secretStore,
    exchanges,
  };
}

/** The `current` signing key this worker has actually minted, for forging test states. */
async function currentRelayKey(instance: Fixture): Promise<string> {
  const raw = await instance.secretStore.get('dashboard.oauth.relay_state_key');
  return (JSON.parse(raw!) as { current: string }).current;
}

/**
 * A signed state built directly from the wire format, bypassing
 * `signOAuthRelayState`'s type — which will not construct a payload missing a
 * required field or carrying the wrong type. An attacker (or a state a buggy
 * older worker minted) is not bound by that type either, so this is how a
 * "validly signed but malformed payload" is actually produced on the wire.
 */
function rawRelayState(payload: unknown, key: string): string {
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', Buffer.from(key, 'base64url')).update(segment, 'ascii').digest('base64url');
  return `${segment}.${signature}`;
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

  test('a relay-bounced callback redirects to a query-free done page, and the exchange uses the identical redirect_uri', async () => {
    const instance = fixture();
    const started = await authorizationUrl(await startConnect(instance));
    const state = started.searchParams.get('state')!;

    // Exactly the request the relay page builds: the dashboard's own origin,
    // /oauth/callback/<source>, code and state and nothing else.
    const callback = await instance.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=relay-code-1&state=${encodeURIComponent(state)}`,
    ));
    // MINOR 2, Codex round 2: the success page used to render directly at this
    // URL, which still carried the (already-spent) code and state — and
    // therefore landed in this tab's browser history despite `no-store`, which
    // only keeps a response out of the disk cache. A 303 to a clean same-origin
    // URL is what actually keeps them out of history.
    expect(callback.status).toBe(303);
    const location = callback.headers.get('Location')!;
    expect(location).toBe('/oauth/callback/dropbox/done');
    expect(location).not.toContain('code');
    expect(location).not.toContain('state');
    expect(callback.headers.get('Referrer-Policy')).toBe('no-referrer');

    const done = await instance.fetch(new Request(`${DASHBOARD_ORIGIN}${location}`));
    expect(done.status).toBe(200);
    expect(done.headers.get('Referrer-Policy')).toBe('no-referrer');
    const donePage = await done.text();
    expect(donePage).toContain('Connected dropbox');
    expect(donePage).not.toContain('relay-code-1');
    expect(donePage).not.toContain(state);

    expect(instance.exchanges).toHaveLength(1);
    expect(instance.exchanges[0]!.get('redirect_uri')).toBe(DEFAULT_OAUTH_RELAY_URL);
    expect(instance.exchanges[0]!.get('redirect_uri'))
      .toBe(started.searchParams.get('redirect_uri'));
    expect(instance.exchanges[0]!.get('code')).toBe('relay-code-1');
    expect(instance.exchanges[0]!.get('code_verifier')).toBeTruthy();
    expect(await instance.secretStore.get('dropbox.personal.oauth.refresh_token'))
      .toBe('dropbox-refresh-token-fixture');
  });

  test('the signing key is worker-local, minted once, and stored as current/previous/rotatedAt material', async () => {
    const instance = fixture();
    await startConnect(instance);
    const raw = await instance.secretStore.get('dashboard.oauth.relay_state_key');
    // JSON, not a bare key string: the shape rotation needs (MINOR 3).
    const material = JSON.parse(raw!);
    expect(material.current).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(material.previous).toBeUndefined();
    expect(material.rotatedAt).toBeUndefined();
    await startConnect(instance);
    expect(await instance.secretStore.get('dashboard.oauth.relay_state_key')).toBe(raw!);
  });

  // MAJOR 2, Codex round 2 on 7863a735: the previous refusal suite grouped
  // refusals by internal reason and never compared raw bytes, which is exactly
  // how MAJOR 1 (the missing-result oracle) got through. Every scenario the
  // review named is exercised here against a LIVE attempt where the review says
  // "against a live attempt", and every one is asserted BYTE-IDENTICAL — status
  // and full body — to the same "no attempt" baseline.
  test('every named refusal is byte-identical to the "no attempt" baseline', async () => {
    const baselineResponse = await fixture().fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=aaaa.bbbb`,
    ));
    expect(baselineResponse.status).toBe(410);
    const baseline = { status: baselineResponse.status, body: await baselineResponse.text() };
    expect(baseline.body).not.toContain('signature');
    expect(baseline.body).not.toContain('nonce');
    expect(baseline.body).not.toContain('relay');

    async function scenario(name: string, run: () => Promise<Response>): Promise<void> {
      const response = await run();
      expect(response.status, name).toBe(baseline.status);
      expect(await response.text(), name).toBe(baseline.body);
    }

    // A live attempt plus its decoded payload and the actual signing key this
    // worker minted, so a scenario can forge a payload field and re-sign it
    // exactly the way a worker running an older or buggy build might.
    async function liveDropboxAttempt(): Promise<{ instance: Fixture; key: string; payload: Record<string, unknown> }> {
      const instance = fixture();
      const started = await authorizationUrl(await startConnect(instance));
      return {
        instance,
        key: await currentRelayKey(instance),
        payload: statePayload(started.searchParams.get('state')!),
      };
    }

    await scenario('missing state', async () => {
      const { instance } = await liveDropboxAttempt();
      return instance.fetch(new Request(`${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c`));
    });

    await scenario('wrong state', async () => {
      const { instance } = await liveDropboxAttempt();
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent('unrelated.state')}`,
      ));
    });

    await scenario('bad signature', async () => {
      const { instance, payload } = await liveDropboxAttempt();
      const forged = rawRelayState(payload, createOAuthRelayStateKey());
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(forged)}`,
      ));
    });

    await scenario('unsupported version', async () => {
      const { instance, key, payload } = await liveDropboxAttempt();
      const resigned = signOAuthRelayState({ ...(payload as any), v: 2 }, key);
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(resigned)}`,
      ));
    });

    await scenario('validly-signed malformed payload', async () => {
      const { instance, key, payload } = await liveDropboxAttempt();
      // A correctly signed segment whose payload fails shape validation — the
      // one case `signOAuthRelayState`'s own type cannot construct, because an
      // attacker (or an older buggy worker) is not bound by it.
      const { nonce: _nonce, ...withoutNonce } = payload;
      const forged = rawRelayState(withoutNonce, key);
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(forged)}`,
      ));
    });

    await scenario('nonce mismatch against a live attempt', async () => {
      const { instance, key, payload } = await liveDropboxAttempt();
      const resigned = signOAuthRelayState({ ...(payload as any), nonce: `${payload.nonce}x` }, key);
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(resigned)}`,
      ));
    });

    await scenario('source mismatch against a live attempt', async () => {
      const { instance, key, payload } = await liveDropboxAttempt();
      // Same nonce as the live dropbox attempt — so this reaches the source
      // check rather than failing on the nonce first — but a different
      // `source` field, delivered back to the SAME (dropbox) path.
      const resigned = signOAuthRelayState({ ...(payload as any), source: 'gmail' }, key);
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(resigned)}`,
      ));
    });

    await scenario('stale iat', async () => {
      const { instance, key, payload } = await liveDropboxAttempt();
      const stale = (payload.iat as number) - Math.ceil(OAUTH_RELAY_STATE_TTL_MS / 1000) - 60;
      const resigned = signOAuthRelayState({ ...(payload as any), iat: stale }, key);
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(resigned)}`,
      ));
    });

    await scenario('future iat', async () => {
      const { instance, key, payload } = await liveDropboxAttempt();
      const future = (payload.iat as number) + Math.ceil(OAUTH_RELAY_STATE_TTL_MS / 1000) + 60;
      const resigned = signOAuthRelayState({ ...(payload as any), iat: future }, key);
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(resigned)}`,
      ));
    });

    await scenario('foreign origin', async () => {
      const { instance, key, payload } = await liveDropboxAttempt();
      const resigned = signOAuthRelayState({ ...(payload as any), origin: 'https://attacker.example' }, key);
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(resigned)}`,
      ));
    });

    await scenario('replayed nonce', async () => {
      const instance = fixture();
      const started = await authorizationUrl(await startConnect(instance));
      const state = started.searchParams.get('state')!;
      const first = await instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c1&state=${encodeURIComponent(state)}`,
      ));
      expect(first.status).toBe(303);
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c2&state=${encodeURIComponent(state)}`,
      ));
    });

    await scenario('expired state', async () => {
      const instance = fixture({}, { attemptExpiresInMs: 5 });
      const started = await authorizationUrl(await startConnect(instance));
      const state = started.searchParams.get('state')!;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(state)}`,
      ));
    });

    // MAJOR 1, Codex round 2: the case that got through review 1. A perfectly
    // valid, unexpired, unconsumed, correctly signed state carrying NEITHER
    // `code` nor `error` used to reach its own 400 that also deleted the
    // attempt — reachable by anyone who knew a live state string with the
    // result parameters stripped off, letting them tell "this attempt exists"
    // from "it doesn't" and cancel a live attempt by omission alone.
    await scenario('valid state with neither code nor error', async () => {
      const { instance, payload } = await liveDropboxAttempt();
      const state = signOAuthRelayState(payload as any, await currentRelayKey(instance));
      return instance.fetch(new Request(
        `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?state=${encodeURIComponent(state)}`,
      ));
    });
  });

  // MINOR 1, Codex round 2: a provider-error callback didn't consume the
  // nonce, so the identical signed state stayed replayable — with a REAL code
  // this time — until the attempt's own ten-minute expiry.
  test('a state is consumed by a provider error, not just by success', async () => {
    const instance = fixture();
    const started = await authorizationUrl(await startConnect(instance));
    const state = started.searchParams.get('state')!;

    const errorCallback = await instance.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?error=access_denied&state=${encodeURIComponent(state)}`,
    ));
    expect(errorCallback.status).toBe(400);
    expect(await errorCallback.text()).toContain('access_denied');

    // The identical state, now with a real code attached, must be refused —
    // not exchanged — even though the attempt record itself is still on file
    // (kept so the dashboard can show what was refused).
    const replay = await instance.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=late-code&state=${encodeURIComponent(state)}`,
    ));
    expect(replay.status).toBe(410);
    expect(instance.exchanges).toHaveLength(0);

    // The dashboard still reads the provider's refusal off the kept attempt.
    const view = await (await instance.fetch(new Request(`${DASHBOARD_ORIGIN}/dashboard.json`, {
      headers: { Authorization: 'Bearer dashboard-secret' },
    }))).json();
    const dropbox = view.sources.find((source: any) => source.source_id === 'dropbox.files');
    expect(dropbox.connection.provider_refusal?.code).toBe('access_denied');
  });

  // MINOR 3, Codex round 2: rotation wasn't implemented — the worker cached one
  // key and verification checked only that one. Seeding the secret store
  // directly simulates an out-of-band key roll (there is no HTTP rotation
  // route in this change) and proves the WIRED loader — not just the pure
  // function in oauth-relay.ts — honors the one-flow-TTL grace window.
  test('a key rotated out-of-band verifies within its TTL and is refused past it', async () => {
    const oldKey = createOAuthRelayStateKey();
    const newKey = createOAuthRelayStateKey();

    // Attempts are in-memory and process-local, so within a single running
    // worker every attempt IT creates is always signed with whatever `current`
    // key that process has cached — there is no natural way for a live
    // in-process attempt to have been minted under a key that process now
    // calls `previous`. The realistic trigger the contract's grace window
    // protects is a flow that started under the OLD key just before an
    // operator rotated it (typically adopted on the worker's next restart):
    // this attempt's OWN recorded state was genuinely signed with the old key,
    // even though the process that eventually sees the callback has since
    // moved on. `startExternalOAuthConnection` is the seam that lets a test
    // construct that shape directly, by resigning the exact payload the real
    // start route produced (redirect_uri, nonce, origin, source, iat all come
    // from the untouched call beneath it) with the old key instead.
    async function attemptSignedWith(key: string, keyMaterial: { current: string; previous: string; rotatedAt: string }) {
      const dir = mkdtempSync(join(tmpdir(), 'olympus-relay-worker-'));
      dirs.push(dir);
      const secretStore = memorySecretStore({ 'dashboard.oauth.relay_state_key': JSON.stringify(keyMaterial) });
      const captured: { state?: string } = {};
      const oauthFetch: OAuthFetch = async () => new Response(JSON.stringify({
        access_token: 'dropbox-access-token-fixture',
        refresh_token: 'dropbox-refresh-token-fixture',
        expires_in: 14_400,
        token_type: 'bearer',
        scope: 'files.metadata.read files.content.read sharing.read',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const worker = createEmailSourceWorker({
        sourceIndexStatus: { async status() { return fixtureStatus(); } },
        sourceDashboard: {
          sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
          registryPath: join(dir, 'handles.json'),
          secretStore,
          oauthFetch,
          // Resigning BEFORE the real starter runs — not overriding its
          // returned `pending.state` afterward — matters: `connect.ts`'s own
          // `completeCallback` closes over whatever `state` it was called
          // with and checks the callback's `state` against THAT, independent
          // of `dashboardOAuthStateMatches` and the relay verification. All
          // three must see the same old-key-signed string, and the only way
          // to get there is to hand the resigned state to the real starter,
          // exactly as an old-key-signing worker would have.
          startExternalOAuthConnection: async (
            connectOptions: Parameters<typeof startExternalOAuthSourceConnection>[0],
          ): Promise<ExternalPendingOAuthConnection> => {
            const [segment] = connectOptions.state!.split('.') as [string];
            const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
            const resigned = signOAuthRelayState(payload, key);
            captured.state = resigned;
            return startExternalOAuthSourceConnection({ ...connectOptions, state: resigned });
          },
        },
      });
      const fetchWithAuth = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });
      await startConnect({ fetch: fetchWithAuth, secretStore, exchanges: [] });
      return { fetch: fetchWithAuth, state: captured.state! };
    }

    const withinTtl = await attemptSignedWith(oldKey, {
      current: newKey,
      previous: oldKey,
      rotatedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const accepted = await withinTtl.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(withinTtl.state)}`,
    ));
    expect(accepted.status).toBe(303);

    const pastTtl = await attemptSignedWith(oldKey, {
      current: newKey,
      previous: oldKey,
      rotatedAt: new Date(Date.now() - OAUTH_RELAY_STATE_TTL_MS - 1_000).toISOString(),
    });
    const refused = await pastTtl.fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=${encodeURIComponent(pastTtl.state)}`,
    ));
    expect(refused.status).toBe(410);

    const baseline = await fixture().fetch(new Request(
      `${DASHBOARD_ORIGIN}/oauth/callback/dropbox?code=c&state=aaaa.bbbb`,
    ));
    expect(await refused.text()).toBe(await baseline.text());
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

describe('publisher-mode card', () => {
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

  test('the shipped Dropbox default enables the publisher card with no override configured', async () => {
    // The owner created the Dropbox app "Olympus-Plugin" 2026-09-03 and its key
    // is now the literal default in publisher-oauth-client.ts. This is the
    // out-of-the-box shape: no OLYMPUS_DROPBOX_PUBLISHER_APP_KEY override, no
    // dashboard-registered client id, nothing but what the repository ships.
    delete process.env.OLYMPUS_DROPBOX_PUBLISHER_APP_KEY;
    expect(DEFAULT_DROPBOX_PUBLISHER_APP_KEY).toBeTruthy();
    const action = dropboxAction(await dashboardJson(fixture()));
    expect(action.kind).toBe('oauth');
    expect(action.publisher_client).toBe(true);
    expect(action.label).toBe('Connect');
    // No PREFILLED client id — the whole point of publisher mode — even
    // though `instructions.fields` still names the bring-your-own field for
    // the disclosure. And the app key itself is a public identifier the card
    // has no use for, so it stays off the read-only surface exactly like the
    // env-var case.
    expect(action.known_client_id).toBeUndefined();
    expect(JSON.stringify(action)).not.toContain(DEFAULT_DROPBOX_PUBLISHER_APP_KEY);

    // And it is not just a label: pressing Connect with nothing else
    // configured actually goes out to Dropbox with this exact key.
    const instance = fixture();
    const url = await authorizationUrl(await startConnect(instance));
    expect(url.origin).toBe('https://www.dropbox.com');
    expect(url.searchParams.get('client_id')).toBe(DEFAULT_DROPBOX_PUBLISHER_APP_KEY);
    expect(url.searchParams.get('redirect_uri')).toBe(DEFAULT_OAUTH_RELAY_URL);
  });

  test('a dashboard-registered client id still overrides the shipped default', async () => {
    // The default shipping a real key must not foreclose bring-your-own: an
    // owner who registered their own app before this key existed, or who
    // wants their own for any reason, keeps getting it.
    delete process.env.OLYMPUS_DROPBOX_PUBLISHER_APP_KEY;
    const instance = fixture({ 'dropbox.personal.oauth.client_id': 'stored-dropbox-app-key' });
    const action = dropboxAction(await dashboardJson(instance));
    expect(action.kind).toBe('oauth');
    expect(action.publisher_client).toBeUndefined();
    expect(action.known_client_id).toBe('stored-dropbox-app-key');
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

  test('the real shipped-default Dropbox action renders with no client-id field', async () => {
    // Not a synthetic action — the actual `DashboardSourceAction` this install
    // produces with nothing configured but the repository's own shipped
    // Dropbox default, run through the exact same sheet builder the dashboard
    // page uses.
    delete process.env.OLYMPUS_DROPBOX_PUBLISHER_APP_KEY;
    const view = await dashboardJson(fixture());
    const action = dropboxAction(view);
    expect(action.kind).toBe('oauth');
    expect(action.publisher_client).toBe(true);

    const sheet = dashboardOAuthConnectSheet(
      { source_id: 'dropbox.files', label: 'Dropbox' },
      action as Extract<DashboardSourceAction, { kind: 'oauth' }>,
    )!.sheet;
    const [lead, disclosure] = sheet.split('<details') as [string, string];
    // No Client ID field, no App key to paste, nothing to fill in before the
    // one button — and the key itself never appears anywhere on the page,
    // public identifier or not.
    expect(lead).not.toContain('keyfield');
    expect(lead).toContain('<button class="btn primary" type="submit">Connect</button>');
    expect(sheet).not.toContain(DEFAULT_DROPBOX_PUBLISHER_APP_KEY);
    // Bring-your-own is still one click away, with the real walkthrough this
    // shipped app's OWN redirect URI produces.
    expect(disclosure).toContain('Use my own app instead');
    expect(disclosure).toContain('keyfield');
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
