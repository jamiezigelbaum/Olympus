// X's app is a confidential client: its token exchange must authenticate with
// HTTP Basic. The dashboard's secret plumbing was Google-only — an owner-
// supplied X client secret was silently discarded before the flow ever saw it,
// the exchange went out with client_id in the body alone, and X refused it with
// 401 unauthorized_client "Missing valid authorization header" (live, both
// reconnect attempts, 2026-08-19). These tests pin the whole path: the secret
// reaches the exchange as Basic auth, both app credentials persist at start so
// a flow that dies at the provider costs nothing, and a start with no secret
// anywhere refuses instead of minting an authorize URL whose exchange is doomed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import type { OAuthFetch } from '../src/core/connect.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface XWorkerFixture {
  fetch: (request: Request) => Promise<Response>;
  secretStore: SecretStore;
  exchanges: Array<{ authorization: string | null; body: URLSearchParams }>;
}

function xWorkerFixture(initialSecrets: Record<string, string>): XWorkerFixture {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-x-oauth-'));
  dirs.push(dir);
  const secretStore = memorySecretStore(initialSecrets);
  const exchanges: XWorkerFixture['exchanges'] = [];
  const oauthFetch: OAuthFetch = async (url, init) => {
    if (String(url).includes('/2/users/me')) {
      return new Response(JSON.stringify({ data: { id: '882404022' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    exchanges.push({
      authorization: new Headers(init?.headers as HeadersInit | undefined).get('authorization'),
      body: new URLSearchParams(String(init?.body ?? '')),
    });
    return new Response(JSON.stringify({
      access_token: 'x-access-token-fixture',
      refresh_token: 'x-refresh-token-fixture',
      expires_in: 7200,
      token_type: 'bearer',
      scope: 'bookmark.read users.read offline.access',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const worker = createEmailSourceWorker({
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      registryPath: join(dir, 'handles.json'),
      secretStore,
      oauthFetch,
    },
  });
  return { fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' }), secretStore, exchanges };
}

async function startXConnect(
  fixture: XWorkerFixture,
  body: Record<string, string>,
): Promise<Response> {
  return fixture.fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer dashboard-secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'x',
      return_to: 'http://worker.test/dashboard?token=dashboard-return-token',
      ...body,
    }),
  }));
}

const expectedBasic = `Basic ${Buffer.from('x-client-id-fixture:x-client-secret-fixture').toString('base64')}`;

describe('dashboard X OAuth exchange', () => {
  test('an owner-supplied secret reaches the exchange as HTTP Basic and both app credentials persist at start', async () => {
    const fixture = xWorkerFixture({});
    const started = await startXConnect(fixture, {
      client_id: 'x-client-id-fixture',
      client_secret: 'x-client-secret-fixture',
    });
    expect(started.status).toBe(200);
    // Persisted at start, not at completion: the flow that dies at the
    // provider must not cost the owner a re-paste of either value.
    expect(await fixture.secretStore.get('x.personal.oauth.client_id')).toBe('x-client-id-fixture');
    expect(await fixture.secretStore.get('x.personal.oauth.client_secret')).toBe('x-client-secret-fixture');

    const state = new URL((await started.json()).authorization_url).searchParams.get('state')!;
    const callback = await fixture.fetch(new Request(
      `http://worker.test/oauth/callback/x?code=x-code-1&state=${state}`,
    ));
    expect(callback.status).toBe(200);

    expect(fixture.exchanges).toHaveLength(1);
    expect(fixture.exchanges[0]!.authorization).toBe(expectedBasic);
    // Basic auth carries the client identity; a body client_id alongside it is
    // the mixed mode some providers reject. PKCE still rides in the body.
    expect(fixture.exchanges[0]!.body.get('client_id')).toBeNull();
    expect(fixture.exchanges[0]!.body.get('code_verifier')).toBeTruthy();
    expect(await fixture.secretStore.get('x.personal.oauth.refresh_token')).toBe('x-refresh-token-fixture');
  });

  test('a reconnect finds the stored app credentials without the owner re-pasting them', async () => {
    const fixture = xWorkerFixture({
      'x.personal.oauth.client_id': 'x-client-id-fixture',
      'x.personal.oauth.client_secret': 'x-client-secret-fixture',
    });
    const started = await startXConnect(fixture, {});
    expect(started.status).toBe(200);
    const state = new URL((await started.json()).authorization_url).searchParams.get('state')!;
    expect((await fixture.fetch(new Request(
      `http://worker.test/oauth/callback/x?code=x-code-2&state=${state}`,
    ))).status).toBe(200);
    expect(fixture.exchanges).toHaveLength(1);
    expect(fixture.exchanges[0]!.authorization).toBe(expectedBasic);
  });

  test('provider error prose never reaches the failure page in any encoding', async () => {
    // R61/R61B: the provider echoes the stored secrets in forms no value list
    // fully enumerates — short raw, base64url, lowercase percent-encoding, and
    // a Google secret on an X page. The page speaks only the allowlisted code.
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-x-oauth-'));
    dirs.push(dir);
    const secretStore = memorySecretStore({
      'x.personal.oauth.client_id': 'x-client-id-fixture',
      'x.personal.oauth.client_secret': 'short-x-secret',
      'google.personal.oauth.client_secret': 'google-secret',
    });
    const echoes = [
      'short-x-secret',
      Buffer.from('short-x-secret').toString('base64url'),
      'short%2dx%2dsecret',
      'google-secret',
    ];
    const oauthFetch: OAuthFetch = async () => new Response(JSON.stringify({
      error: 'invalid_client',
      error_description: `Rejected credential material: ${echoes.join(' / ')}.`,
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath: join(dir, 'handles.json'),
        secretStore,
        oauthFetch,
      },
    });
    const fixture: XWorkerFixture = {
      fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' }),
      secretStore,
      exchanges: [],
    };

    const started = await startXConnect(fixture, {});
    expect(started.status).toBe(200);
    const state = new URL((await started.json()).authorization_url).searchParams.get('state')!;
    const callback = await fixture.fetch(new Request(
      `http://worker.test/oauth/callback/x?code=x-code-3&state=${state}`,
    ));
    const page = await callback.text();

    expect(callback.status).toBe(400);
    for (const echo of echoes) {
      expect(page).not.toContain(echo);
    }
    expect(page).not.toContain('Rejected credential material');
    expect(page).toContain('invalid_client');
  });

  test('a provider redirect error param outside the allowlist is never repeated', async () => {
    const fixture = xWorkerFixture({
      'x.personal.oauth.client_id': 'x-client-id-fixture',
      'x.personal.oauth.client_secret': 'x-client-secret-fixture',
    });
    const started = await startXConnect(fixture, {});
    expect(started.status).toBe(200);
    // The callback route is unauthenticated, so it now refuses to read — let
    // alone record — anything without this flow's own state. The probe carries
    // it, which is what puts this test back on the allowlist path it is about.
    const state = new URL((await started.json()).authorization_url).searchParams.get('state')!;
    const callback = await fixture.fetch(new Request(
      `http://worker.test/oauth/callback/x?error=x-client-secret-fixture-was-rejected&state=${encodeURIComponent(state)}`,
    ));
    const page = await callback.text();

    expect(callback.status).toBe(400);
    expect(page).not.toContain('x-client-secret-fixture');
    expect(page).toContain('an unrecognized error');
  });

  test('api-key validator text never reaches the response in any encoding', async () => {
    // R61C: enumerating transformed key encodings is not a boundary guarantee
    // (`abc%2d12` slipped a variant list). Validator text is not relayed at
    // all; a fixed sentence is the entire vocabulary.
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-x-oauth-'));
    dirs.push(dir);
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath: join(dir, 'handles.json'),
        secretStore: memorySecretStore({}),
        connectApiKey: async () => {
          throw new Error('Provider rejected key abc12 (also seen as abc%2d12)');
        },
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const response = await fetch(new Request('http://worker.test/dashboard/connect/api-key', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'readwise', api_key: 'abc-12' }),
    }));
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).not.toContain('abc12');
    expect(body).not.toContain('abc%2d12');
    expect(body).not.toContain('Provider rejected');
    expect(body).toContain('Validating the readwise API key failed.');
  });

  test('an off-origin authorization URL is refused, never relayed', async () => {
    // R61E: the starter is injectable and its URL is one the owner's browser
    // will follow. Only the source's own provider origin is relayed.
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-x-oauth-'));
    dirs.push(dir);
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath: join(dir, 'handles.json'),
        secretStore: memorySecretStore({
          'x.personal.oauth.client_id': 'x-client-id-fixture',
          'x.personal.oauth.client_secret': 'x-client-secret-fixture',
        }),
        startExternalOAuthConnection: async () => ({
          ok: true as const,
          source: 'x' as const,
          authorizationUrl: 'https://attacker.test/authorize?echo=x-client-secret-fixture',
          redirectUri: 'http://127.0.0.1:8010/oauth/callback/x',
          state: 'state-fixture',
          startedAt: '2026-07-02T12:00:00.000Z',
          expiresAt: '2026-07-02T12:10:00.000Z',
          completeCallback: async () => {
            throw new Error('not used');
          },
          cancel() {},
        }),
      },
    });
    const fixture: XWorkerFixture = {
      fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' }),
      secretStore: memorySecretStore({}),
      exchanges: [],
    };

    const started = await startXConnect(fixture, {});
    const body = await started.text();
    expect(started.status).toBe(502);
    expect(body).toContain('oauth_start_invalid');
    expect(body).not.toContain('attacker.test');
    expect(body).not.toContain('x-client-secret-fixture');
  });

  test('a starter-claimed expiry outside the honest window is replaced, not relayed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-x-oauth-'));
    dirs.push(dir);
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath: join(dir, 'handles.json'),
        secretStore: memorySecretStore({
          'x.personal.oauth.client_id': 'x-client-id-fixture',
          'x.personal.oauth.client_secret': 'x-client-secret-fixture',
        }),
        startExternalOAuthConnection: async () => ({
          ok: true as const,
          source: 'x' as const,
          authorizationUrl: 'https://x.com/i/oauth2/authorize?state=state-fixture',
          redirectUri: 'http://127.0.0.1:8010/oauth/callback/x',
          state: 'state-fixture',
          startedAt: 'not-a-timestamp',
          expiresAt: '2099-01-01T00:00:00.000Z',
          completeCallback: async () => {
            throw new Error('not used');
          },
          cancel() {},
        }),
      },
    });
    const fixture: XWorkerFixture = {
      fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' }),
      secretStore: memorySecretStore({}),
      exchanges: [],
    };

    const started = await startXConnect(fixture, {});
    expect(started.status).toBe(200);
    const payload = await started.json();
    const expiresIn = Date.parse(payload.expires_at) - Date.now();
    expect(expiresIn).toBeGreaterThan(0);
    expect(expiresIn).toBeLessThanOrEqual(30 * 60_000);
  });

  test('a callback completer error outside the bounded vocabulary collapses to fixed prose', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-x-oauth-'));
    dirs.push(dir);
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath: join(dir, 'handles.json'),
        secretStore: memorySecretStore({
          'x.personal.oauth.client_id': 'x-client-id-fixture',
          'x.personal.oauth.client_secret': 'x-client-secret-fixture',
        }),
        startExternalOAuthConnection: async () => ({
          ok: true as const,
          source: 'x' as const,
          authorizationUrl: 'https://x.com/i/oauth2/authorize?state=state-fixture',
          redirectUri: 'http://127.0.0.1:8010/oauth/callback/x',
          state: 'state-fixture',
          startedAt: '2026-07-02T12:00:00.000Z',
          expiresAt: '2026-07-02T12:10:00.000Z',
          completeCallback: async () => {
            throw new Error('Provider rejected callback code abc-12');
          },
          cancel() {},
        }),
      },
    });
    const fixture: XWorkerFixture = {
      fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' }),
      secretStore: memorySecretStore({}),
      exchanges: [],
    };

    const started = await startXConnect(fixture, {});
    expect(started.status).toBe(200);
    const callback = await fixture.fetch(new Request(
      'http://worker.test/oauth/callback/x?code=x-code-4&state=state-fixture',
    ));
    const page = await callback.text();

    expect(callback.status).toBe(400);
    expect(page).not.toContain('abc-12');
    expect(page).not.toContain('Provider rejected');
    expect(page).toContain('Connecting x failed partway through');
  });

  test('a crafted exchange-shaped message with an unlisted code is not repeated', async () => {
    // The shape alone admits arbitrary lowercase content; the embedded code
    // must itself pass the OAuth allowlist.
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-x-oauth-'));
    dirs.push(dir);
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath: join(dir, 'handles.json'),
        secretStore: memorySecretStore({
          'x.personal.oauth.client_id': 'x-client-id-fixture',
          'x.personal.oauth.client_secret': 'x-client-secret-fixture',
        }),
        startExternalOAuthConnection: async () => ({
          ok: true as const,
          source: 'x' as const,
          authorizationUrl: 'https://x.com/i/oauth2/authorize?state=state-fixture',
          redirectUri: 'http://127.0.0.1:8010/oauth/callback/x',
          state: 'state-fixture',
          startedAt: '2026-07-02T12:00:00.000Z',
          expiresAt: '2026-07-02T12:10:00.000Z',
          completeCallback: async () => {
            throw new Error('OAuth token exchange failed with status 400 (smuggled_lowercase_payload).');
          },
          cancel() {},
        }),
      },
    });
    const fixture: XWorkerFixture = {
      fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' }),
      secretStore: memorySecretStore({}),
      exchanges: [],
    };

    const started = await startXConnect(fixture, {});
    expect(started.status).toBe(200);
    const callback = await fixture.fetch(new Request(
      'http://worker.test/oauth/callback/x?code=x-code-5&state=state-fixture',
    ));
    const page = await callback.text();

    expect(callback.status).toBe(400);
    expect(page).not.toContain('smuggled_lowercase_payload');
    expect(page).toContain('Connecting x failed partway through');
  });

  test('connector-returned handle strings never reach the api-key success response', async () => {
    // R61D: the injectable connect boundary is hostile on success too — an
    // implementation echoing the key through `handles` must not be relayed.
    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-x-oauth-'));
    dirs.push(dir);
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath: join(dir, 'handles.json'),
        secretStore: memorySecretStore({}),
        connectApiKey: async () => ({
          ok: true as const,
          source: 'readwise' as const,
          handles: ['Provider accepted abc-12', 'readwise.personal'],
          registryPath: join(dir, 'handles.json'),
          secretRefs: [],
        }),
      },
    });
    const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const response = await fetch(new Request('http://worker.test/dashboard/connect/api-key', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'readwise', api_key: 'abc-12' }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.handles).toEqual(['readwise.personal']);
  });

  test('a start with no secret anywhere refuses instead of minting a doomed authorize URL', async () => {
    const fixture = xWorkerFixture({ 'x.personal.oauth.client_id': 'x-client-id-fixture' });
    const started = await startXConnect(fixture, {});
    expect(started.status).toBe(409);
    expect(await started.text()).toContain('oauth_client_secret_missing');
    expect(fixture.exchanges).toHaveLength(0);
  });
});

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
