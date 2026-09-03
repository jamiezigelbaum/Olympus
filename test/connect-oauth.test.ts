import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  connectApiKeySource,
  connectOAuthSourceDetached,
  connectOAuthSource,
  listDetachedOAuthStates,
  runDetachedOAuthLifecycle,
  startExternalOAuthSourceConnection,
  writeDetachedOAuthState,
  type OAuthFetch,
} from '../src/core/connect.ts';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import { EncryptedFileSecretStore, type SecretStore } from '../src/core/secret-store.ts';
import {
  CredentialBrokerError,
  JsonCredentialOAuth2StateStore,
  createEnvCredentialBroker,
  safeCredentialSessionAudit,
} from '../src/workers/credential-broker/index.ts';
import {
  readConnectedHandleRegistry,
  upsertConnectedHandle,
} from '../src/workers/credential-broker/connected-handles.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';

describe('olympus connect OAuth authorization-code flow', () => {
  test('connect verbs preserve credential contention as a typed retryable refusal', async () => {
    const busy = new CredentialBrokerError(
      'credential_refresh_busy',
      'Credential storage is busy.',
      { handle: 'venice.personal', capability: 'venice.connect' },
    );
    const store = {
      label: 'busy-fixture',
      async get() {
        return undefined;
      },
      async set() {
        throw busy;
      },
      async delete() {},
      async list() {
        return [];
      },
    } satisfies SecretStore;

    const error = await connectApiKeySource({
      source: 'venice',
      apiKey: 'venice-key-fixture',
      secretStore: store,
      fetch: async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    }).catch((reason: unknown) => reason);

    expect(error).toBe(busy);
    expect(error).toMatchObject({
      code: 'credential_refresh_busy',
      retryable: true,
      retryAfterMs: 30_000,
    });
  });

  test('production-shaped brokers load connected handles from the default registry with explicit env', async () => {
    await withTemporaryHome(async (home) => {
      const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/authorize') {
          const redirectUri = url.searchParams.get('redirect_uri') ?? '';
          const state = url.searchParams.get('state') ?? '';
          response.writeHead(302, { Location: `${redirectUri}?code=${url.searchParams.get('client_id')}-code&state=${state}` }).end();
          return;
        }
        if (url.pathname === '/token') {
          const body = await readRequestBody(request);
          const params = new URLSearchParams(body);
          const auth = request.headers.authorization ?? '';
          const clientId = params.get('client_id') ?? (auth ? 'x-client-id' : 'unknown-client-id');
          const refreshToken = params.get('refresh_token') ?? '';
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            access_token: refreshToken ? `${refreshToken}.access` : `${clientId}.access`,
            refresh_token: refreshToken || `${clientId}.refresh`,
            expires_in: 3600,
          }));
          return;
        }
        if (url.pathname === '/2/users/me') {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            data: { id: '1234567890', username: 'fixture' },
          }));
          return;
        }
        if (url.pathname === '/api/v2/auth/') {
          response.writeHead(204).end();
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('mock server did not bind');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        const child = await runChildScript(productionDefaultRegistryBrokerScript(), {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: home,
            OLYMPUS_SECRET_STORE_BACKEND: 'file',
            OLYMPUS_TEST_CONNECT_BASE_URL: baseUrl,
            OLYMPUS_CONNECT_READWISE_AUTH_URL: `${baseUrl}/api/v2/auth/`,
          },
        });
        expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
      } finally {
        server.close();
      }
    });
  }, 15_000);

  test('terminal OAuth refresh failures mark registry reauth without marking transient failures', async () => {
    const terminal = await connectAndRefreshWithMode('gmail', 'invalid_grant');
    expect(terminal.error).toMatchObject({
      code: 'credential_reauth_required',
      handle: 'gmail.personal',
    });
    const terminalRegistry = readConnectedHandleRegistry(terminal.registryPath);
    expect(terminalRegistry.handles.find((handle) => handle.handle === 'gmail.personal')?.backendState)
      .toMatchObject({ kind: 'oauth2_refresh', status: 'reauth_required' });
    const terminalDashboard = buildSourceDashboardViewModel({
      sourceIndexStatus: emptyDashboardStatus(),
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      connectedHandleRegistry: terminalRegistry,
      oauthClientIds: { gmail: 'gmail-client-id' },
      oauthClientSecretAvailability: { gmail: true },
      now: new Date('2026-07-07T12:00:00.000Z'),
    });
    expect(terminalDashboard.sources.find((source) => source.source_id === 'gmail.email')?.connection)
      .toMatchObject({ state: 'reauth_required', label: 'reauth required' });
    terminal.cleanup();

    const transient = await connectAndRefreshWithMode('dropbox', 'server_error');
    expect(transient.error).toMatchObject({
      code: 'credential_refresh_failed',
      handle: 'dropbox.personal',
    });
    const transientRegistry = readConnectedHandleRegistry(transient.registryPath);
    expect(transientRegistry.handles.find((handle) => handle.handle === 'dropbox.personal')?.backendState)
      .toBeUndefined();
    transient.cleanup();
  });

  test('completes loopback PKCE OAuth and derives a store-backed broker handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-oauth-test-'));
    const registryPath = join(dir, 'handles.json');
    const credentialBrokerStatePath = join(dir, 'credential-broker-state.json');
    writeFileSync(credentialBrokerStatePath, JSON.stringify({
      version: 1,
      handles: {
        'dropbox.personal': {
          refreshToken: 'stale-dropbox-refresh-token',
          status: 'reauth_required',
          updatedAt: '2026-07-01T12:00:00.000Z',
        },
        'gmail.personal': {
          refreshToken: 'unchanged-gmail-refresh-token',
          status: 'reauth_required',
          updatedAt: '2026-07-01T12:00:00.000Z',
        },
      },
    }));
    const store = new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    });
    const tokenRequests: string[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        response.writeHead(302, {
          Location: `${redirectUri}?code=mock-code-fixture&state=${state}`,
        }).end();
        return;
      }
      if (url.pathname === '/token') {
        const body = await readRequestBody(request);
        tokenRequests.push(body);
        const params = new URLSearchParams(body);
        if (params.get('grant_type') === 'authorization_code') {
          expect(params.get('code')).toBe('mock-code-fixture');
          expect(params.get('code_verifier')).toBeTruthy();
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            access_token: 'oauth-access-token-fixture',
            refresh_token: 'oauth-refresh-token-fixture',
            expires_in: 3600,
            scope: 'files.metadata.read files.content.read sharing.read',
          }));
          return;
        }
        if (params.get('grant_type') === 'refresh_token') {
          expect(params.get('refresh_token')).toBe('oauth-refresh-token-fixture');
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            access_token: 'refreshed-access-token-fixture',
            refresh_token: 'rotated-refresh-token-fixture',
            expires_in: 3600,
            scope: 'files.metadata.read files.content.read sharing.read',
          }));
          return;
        }
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const result = await connectOAuthSource({
        source: 'dropbox',
        clientId: 'dropbox-client-id-fixture',
        clientSecret: 'dropbox-client-secret-fixture',
        authUrl: `${baseUrl}/authorize`,
        tokenUrl: `${baseUrl}/token`,
        registryPath,
        oauth2StateStore: new JsonCredentialOAuth2StateStore(credentialBrokerStatePath),
        secretStore: store,
        openBrowser: false,
        onAuthorizationUrl: async (url) => {
          const authResponse = await fetch(url, { redirect: 'manual' });
          const location = authResponse.headers.get('location');
          if (!location) throw new Error('mock authorization did not redirect');
          await fetch(location);
        },
        now: () => new Date('2026-07-02T12:00:00.000Z'),
      });

      expect(result).toEqual({
        ok: true,
        source: 'dropbox',
        handles: ['dropbox.personal'],
        registryPath,
        oauth2StateWrite: 'updated',
        secretRefs: [
          'store:dropbox.personal.oauth.client_id',
          'store:dropbox.personal.oauth.refresh_token',
        ],
      });
      expect(readFileSync(registryPath, 'utf8')).not.toContain('oauth-refresh-token-fixture');
      expect(JSON.parse(readFileSync(credentialBrokerStatePath, 'utf8'))).toMatchObject({
        handles: {
          'dropbox.personal': {
            refreshToken: 'oauth-refresh-token-fixture',
            status: 'available',
            updatedAt: '2026-07-02T12:00:00.000Z',
          },
          'gmail.personal': {
            refreshToken: 'unchanged-gmail-refresh-token',
            status: 'reauth_required',
            updatedAt: '2026-07-01T12:00:00.000Z',
          },
        },
      });

      const broker = createEnvCredentialBroker({
        env: {},
        handleRegistryPath: registryPath,
        secretStore: store,
        oauth2StateStore: new JsonCredentialOAuth2StateStore(credentialBrokerStatePath),
        oauth2CacheNamespace: 'test-connect-oauth-refresh',
        now: () => new Date('2026-07-02T12:10:00.000Z'),
      });
      const status = await broker.status?.('dropbox.personal');
      const session = await broker.issueSession({
        handle: 'dropbox.personal',
        provider: 'dropbox',
        capability: 'dropbox.files.sync',
        trustDomain: 'secure_local',
      });

      expect(status).toMatchObject({ handle: 'dropbox.personal', status: 'available', rawCredentialExposed: false });
      expect(session).toMatchObject({
        kind: 'bearer_token',
        token: 'refreshed-access-token-fixture',
      });
      expect(await store.get('dropbox.personal.oauth.refresh_token')).toBe('rotated-refresh-token-fixture');
      expect(await store.get('dropbox.personal.oauth.client_secret')).toBeUndefined();
      expect(JSON.stringify(safeCredentialSessionAudit(session))).not.toContain('refreshed-access-token-fixture');
      expect(JSON.stringify(safeCredentialSessionAudit(session))).not.toContain('rotated-refresh-token-fixture');
      expect(tokenRequests).toHaveLength(2);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses provider-aware token exchange authentication and authorization parameters', async () => {
    const cases = [
      {
        source: 'gmail' as const,
        clientId: 'google-client-id-fixture',
        clientSecret: 'google-client-secret-fixture',
        expectedSecretInBody: true,
        expectedBasic: undefined,
        expectedTokenAccessType: undefined,
        expectGoogleAuthParams: true,
      },
      {
        source: 'x' as const,
        clientId: 'x-client-id-fixture',
        clientSecret: 'x-client-secret-fixture',
        expectedSecretInBody: false,
        expectedBasic: `Basic ${Buffer.from('x-client-id-fixture:x-client-secret-fixture').toString('base64')}`,
        expectedTokenAccessType: undefined,
        expectGoogleAuthParams: false,
      },
      {
        source: 'dropbox' as const,
        clientId: 'dropbox-client-id-fixture',
        clientSecret: 'google-poison-secret-fixture',
        expectedSecretInBody: false,
        expectedBasic: undefined,
        expectedTokenAccessType: 'offline',
        expectGoogleAuthParams: false,
      },
    ];

    for (const item of cases) {
      const dir = mkdtempSync(join(tmpdir(), `olympus-connect-oauth-matrix-${item.source}-`));
      const registryPath = join(dir, 'handles.json');
      const store = new EncryptedFileSecretStore({
        encryptedFilePath: join(dir, 'secrets.enc'),
        keyFilePath: join(dir, 'secrets.key'),
      });
      const tokenRequests: Array<{ authorization: string | null; body: string }> = [];
      const authRequests: URL[] = [];
      const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/authorize') {
          authRequests.push(url);
          const redirectUri = url.searchParams.get('redirect_uri') ?? '';
          const state = url.searchParams.get('state') ?? '';
          response.writeHead(302, { Location: `${redirectUri}?code=${item.source}-code-fixture&state=${state}` }).end();
          return;
        }
        if (url.pathname === '/token') {
          const body = await readRequestBody(request);
          tokenRequests.push({
            authorization: request.headers.authorization ?? null,
            body,
          });
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            access_token: `${item.source}-access-token-fixture`,
            refresh_token: `${item.source}-refresh-token-fixture`,
            expires_in: 3600,
          }));
          return;
        }
        if (url.pathname === '/2/users/me') {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            data: { id: '9876543210', username: 'fixture' },
          }));
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('mock server did not bind');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        const result = await connectOAuthSource({
          source: item.source,
          clientId: item.clientId,
          clientSecret: item.clientSecret,
          authUrl: `${baseUrl}/authorize`,
          tokenUrl: `${baseUrl}/token`,
          registryPath,
          secretStore: store,
          openBrowser: false,
          onAuthorizationUrl: async (url) => {
            const authResponse = await fetch(url, { redirect: 'manual' });
            const location = authResponse.headers.get('location');
            if (!location) throw new Error('mock authorization did not redirect');
            await fetch(location);
          },
        });

        expect(authRequests).toHaveLength(1);
        expect(result.oauth2StateWrite).toBe('not_configured');
        expect(authRequests[0]!.searchParams.get('access_type')).toBe(item.expectGoogleAuthParams ? 'offline' : null);
        expect(authRequests[0]!.searchParams.get('prompt')).toBe(item.expectGoogleAuthParams ? 'consent' : null);
        expect(authRequests[0]!.searchParams.get('token_access_type')).toBe(item.expectedTokenAccessType ?? null);
        expect(tokenRequests).toHaveLength(1);
        expect(tokenRequests[0]!.authorization).toBe(item.expectedBasic ?? null);
        const params = new URLSearchParams(tokenRequests[0]!.body);
        expect(params.get('grant_type')).toBe('authorization_code');
        expect(params.get('code')).toBe(`${item.source}-code-fixture`);
        expect(params.get('code_verifier')).toBeTruthy();
        expect(params.get('client_secret')).toBe(item.expectedSecretInBody ? item.clientSecret : null);
        expect(params.get('client_id')).toBe(item.expectedBasic ? null : item.clientId);
      } finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('role-scopes non-default Dropbox and X OAuth handles', async () => {
    for (const item of [
      { source: 'dropbox' as const, accountRole: 'work' },
      { source: 'x' as const, accountRole: 'research' },
    ]) {
      const dir = mkdtempSync(join(tmpdir(), `olympus-connect-role-scope-${item.source}-`));
      const registryPath = join(dir, 'handles.json');
      const store = new EncryptedFileSecretStore({
        encryptedFilePath: join(dir, 'secrets.enc'),
        keyFilePath: join(dir, 'secrets.key'),
      });
      const server = await oauthServer({
        tokenStatus: 200,
        tokenBody: {
          access_token: `${item.source}-access-token-fixture`,
          refresh_token: `${item.source}-refresh-token-fixture`,
          expires_in: 3600,
        },
      });
      try {
        const result = await connectOAuthSource({
          source: item.source,
          accountRole: item.accountRole,
          clientId: `${item.source}-client-id-fixture`,
          ...(item.source === 'x' ? { clientSecret: 'x-client-secret-fixture' } : {}),
          authUrl: `${server.baseUrl}/authorize`,
          tokenUrl: `${server.baseUrl}/token`,
          registryPath,
          secretStore: store,
          openBrowser: false,
          onAuthorizationUrl: async (url) => {
            const authResponse = await fetch(url, { redirect: 'manual' });
            const location = authResponse.headers.get('location');
            if (!location) throw new Error('mock authorization did not redirect');
            await fetch(location);
          },
        });
        const expectedHandle = item.source === 'dropbox' ? 'dropbox.work' : 'x.bookmarks.research';
        expect(result.handles).toEqual([expectedHandle]);
        expect(result.secretRefs).toContain(`store:${item.source}.${item.accountRole}.oauth.refresh_token`);
        const registry = readConnectedHandleRegistry(registryPath);
        expect(registry.handles.map((handle) => handle.handle)).toEqual([expectedHandle]);
        if (item.source === 'x') {
          expect(registry.handles[0]?.providerAccountId).toBe('2468135790');
        }
      } finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('OAuth connect refuses a second account for one provider before storing its grant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-oauth-cardinality-'));
    const registryPath = join(dir, 'handles.json');
    const store = new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    });
    const server = await oauthServer({
      tokenStatus: 200,
      tokenBody: {
        access_token: 'dropbox-access-token-fixture',
        refresh_token: 'dropbox-refresh-token-fixture',
        expires_in: 3600,
      },
    });
    try {
      const personal = await startExternalOAuthSourceConnection({
        source: 'dropbox',
        clientId: 'dropbox-client-id-fixture',
        authUrl: `${server.baseUrl}/authorize`,
        tokenUrl: `${server.baseUrl}/token`,
        redirectUri: 'http://127.0.0.1:17777/oauth/callback/dropbox',
        registryPath,
        secretStore: store,
      });
      await personal.completeCallback({ state: personal.state, code: 'personal-code-fixture' });

      const work = await startExternalOAuthSourceConnection({
        source: 'dropbox',
        accountRole: 'work',
        clientId: 'dropbox-client-id-fixture',
        authUrl: `${server.baseUrl}/authorize`,
        tokenUrl: `${server.baseUrl}/token`,
        redirectUri: 'http://127.0.0.1:17777/oauth/callback/dropbox',
        registryPath,
        secretStore: store,
      });
      await expect(work.completeCallback({ state: work.state, code: 'work-code-fixture' }))
        .rejects.toThrow('one connected account per provider');
      expect(await store.get('dropbox.work.oauth.refresh_token')).toBeUndefined();
      expect(readConnectedHandleRegistry(registryPath).handles.map((handle) => handle.handle))
        .toEqual(['dropbox.personal']);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('OAuth connect judges account cardinality against the provider being connected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-oauth-cardinality-scope-'));
    const registryPath = join(dir, 'handles.json');
    const store = new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    });
    // A registry that already violates the rule for an unrelated provider —
    // two GCP account roles, which connect-gcp upserts without the assert.
    for (const accountRole of ['personal', 'work']) {
      upsertConnectedHandle({
        handle: `gcp.${accountRole}`,
        provider: 'gcp',
        accountRole,
        allowedCapabilities: ['gcp.projects.read'],
        scopes: [],
        connectedAt: '2026-08-20T12:00:00.000Z',
      }, registryPath);
    }
    const server = await oauthServer({
      tokenStatus: 200,
      tokenBody: {
        access_token: 'dropbox-access-token-fixture',
        refresh_token: 'dropbox-refresh-token-fixture',
        expires_in: 3600,
      },
    });
    try {
      const pending = await startExternalOAuthSourceConnection({
        source: 'dropbox',
        clientId: 'dropbox-client-id-fixture',
        authUrl: `${server.baseUrl}/authorize`,
        tokenUrl: `${server.baseUrl}/token`,
        redirectUri: 'http://127.0.0.1:17777/oauth/callback/dropbox',
        registryPath,
        secretStore: store,
      });
      const result = await pending.completeCallback({ state: pending.state, code: 'dropbox-code-fixture' });

      expect(result.handles).toEqual(['dropbox.personal']);
      expect(readConnectedHandleRegistry(registryPath).handles.map((handle) => handle.handle).sort())
        .toEqual(['dropbox.personal', 'gcp.personal', 'gcp.work']);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Google token exchange carries a client secret the install already holds', async () => {
    const cases = [
      {
        label: 'stored under the connecting source key',
        source: 'gmail' as const,
        stored: { 'gmail.personal.oauth.client_secret': 'gmail-stored-secret-fixture' },
        expected: 'gmail-stored-secret-fixture',
      },
      {
        label: 'stored by an earlier combined Google connect',
        source: 'gmail' as const,
        stored: { 'google.personal.oauth.client_secret': 'google-stored-secret-fixture' },
        expected: 'google-stored-secret-fixture',
      },
      {
        label: 'supplied for the shared pilot client by the operator',
        source: 'google-drive' as const,
        stored: {},
        pilotEnvSecret: 'pilot-shared-secret-fixture',
        expected: 'pilot-shared-secret-fixture',
      },
      {
        // A Google secret must never answer for another provider's exchange.
        label: 'never borrowed by a non-Google source',
        source: 'dropbox' as const,
        stored: { 'google.personal.oauth.client_secret': 'google-stored-secret-fixture' },
        pilotEnvSecret: 'pilot-shared-secret-fixture',
        expected: null,
      },
    ] as Array<{
      label: string;
      source: 'gmail' | 'google-drive' | 'dropbox';
      stored: Record<string, string>;
      pilotEnvSecret?: string;
      expected: string | null;
    }>;

    for (const item of cases) {
      const dir = mkdtempSync(join(tmpdir(), `olympus-connect-oauth-secret-${item.source}-`));
      const registryPath = join(dir, 'handles.json');
      const store = new EncryptedFileSecretStore({
        encryptedFilePath: join(dir, 'secrets.enc'),
        keyFilePath: join(dir, 'secrets.key'),
      });
      for (const [key, value] of Object.entries(item.stored)) await store.set(key, value);
      const previousPilotSecret = process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET;
      if (item.pilotEnvSecret) process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET = item.pilotEnvSecret;
      else delete process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET;
      const tokenBodies: string[] = [];
      const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/authorize') {
          const redirectUri = url.searchParams.get('redirect_uri') ?? '';
          const state = url.searchParams.get('state') ?? '';
          response.writeHead(302, { Location: `${redirectUri}?code=${item.source}-code-fixture&state=${state}` }).end();
          return;
        }
        if (url.pathname === '/token') {
          tokenBodies.push(await readRequestBody(request));
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            access_token: `${item.source}-access-token-fixture`,
            refresh_token: `${item.source}-refresh-token-fixture`,
            expires_in: 3600,
          }));
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('mock server did not bind');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        // No clientSecret argument: the v0.4 setup copy asks only for a client id.
        const result = await connectOAuthSource({
          source: item.source,
          clientId: `${item.source}-client-id-fixture`,
          authUrl: `${baseUrl}/authorize`,
          tokenUrl: `${baseUrl}/token`,
          registryPath,
          secretStore: store,
          openBrowser: false,
          onAuthorizationUrl: async (url) => {
            const authResponse = await fetch(url, { redirect: 'manual' });
            const location = authResponse.headers.get('location');
            if (!location) throw new Error('mock authorization did not redirect');
            await fetch(location);
          },
        });

        expect(tokenBodies).toHaveLength(1);
        expect(new URLSearchParams(tokenBodies[0]!).get('client_secret')).toBe(item.expected);
        const secretKey = `${item.source}.personal.oauth.client_secret`;
        const handle = readConnectedHandleRegistry(registryPath).handles[0]!;
        if (item.expected === null) {
          expect(await store.get(secretKey)).toBeUndefined();
          expect(handle.oauth2Refresh?.clientSecretSecretRef).toBeUndefined();
        } else {
          // Refresh reads the secret back through the registry ref, so a
          // resolved secret has to be recorded, not just spent once.
          expect(await store.get(secretKey)).toBe(item.expected);
          expect(result.secretRefs).toContain(`store:${secretKey}`);
          expect(handle.oauth2Refresh?.clientSecretSecretRef).toBe(`store:${secretKey}`);
        }
      } finally {
        if (previousPilotSecret === undefined) delete process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET;
        else process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET = previousPilotSecret;
        server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('keeps X registry metadata-only when the local OAuth state store owns refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-x-local-state-owner-'));
    const registryPath = join(dir, 'handles.json');
    const statePath = join(dir, 'credential-broker-state.json');
    const store = new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    });
    const server = await oauthServer({
      tokenStatus: 200,
      tokenBody: {
        access_token: 'x-local-owner-access-token-fixture',
        refresh_token: 'x-local-owner-refresh-token-fixture',
        expires_in: 3600,
      },
    });
    try {
      const result = await connectOAuthSource({
        source: 'x',
        clientId: 'x-client-id-fixture',
        clientSecret: 'x-client-secret-fixture',
        authUrl: `${server.baseUrl}/authorize`,
        tokenUrl: `${server.baseUrl}/token`,
        registryPath,
        oauth2StateStore: new JsonCredentialOAuth2StateStore(statePath),
        secretStore: store,
        openBrowser: false,
        onAuthorizationUrl: async (url) => {
          const authResponse = await fetch(url, { redirect: 'manual' });
          const location = authResponse.headers.get('location');
          if (!location) throw new Error('mock authorization did not redirect');
          await fetch(location);
        },
      });

      expect(result.oauth2StateWrite).toBe('updated');
      const handle = readConnectedHandleRegistry(registryPath).handles[0]!;
      expect(handle).toMatchObject({
        handle: 'x.bookmarks.personal',
        provider: 'x',
        providerAccountId: '2468135790',
      });
      expect(handle.oauth2Refresh).toBeUndefined();
      expect(handle.tokenSecretRefs).toBeUndefined();
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        handles: {
          'x.bookmarks.personal': {
            refreshToken: 'x-local-owner-refresh-token-fixture',
            providerAccountId: '2468135790',
            status: 'available',
          },
        },
      });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('times out browser authorization waits without storing credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-oauth-timeout-test-'));
    const registryPath = join(dir, 'handles.json');
    const writes: string[] = [];
    let authorizationUrl = '';
    const secretStore: SecretStore = {
      label: 'memory-test-store',
      async get() {
        return undefined;
      },
      async set(key) {
        writes.push(key);
      },
      async delete() {},
      async list() {
        return [...writes];
      },
    };

    try {
      await expect(connectOAuthSource({
        source: 'dropbox',
        clientId: 'dropbox-client-id-fixture',
        registryPath,
        secretStore,
        openBrowser: false,
        authorizationTimeoutMs: 20,
        onAuthorizationUrl: (url) => {
          authorizationUrl = url;
        },
      })).rejects.toThrow('OAuth authorization timed out after 20 ms');

      expect(authorizationUrl).toContain('https://www.dropbox.com/oauth2/authorize');
      expect(writes).toEqual([]);
      expect(existsSync(registryPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('times out token exchange without storing credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-oauth-token-timeout-test-'));
    const registryPath = join(dir, 'handles.json');
    const writes: string[] = [];
    const secretStore: SecretStore = {
      label: 'memory-test-store',
      async get() {
        return undefined;
      },
      async set(key) {
        writes.push(key);
      },
      async delete() {},
      async list() {
        return [...writes];
      },
    };

    try {
      await expect(connectOAuthSource({
        source: 'dropbox',
        clientId: 'dropbox-client-id-fixture',
        tokenUrl: 'http://token.test/oauth',
        registryPath,
        secretStore,
        openBrowser: false,
        tokenExchangeTimeoutMs: 20,
        onAuthorizationUrl: async (authorizationUrl) => {
          const url = new URL(authorizationUrl);
          const redirectUri = url.searchParams.get('redirect_uri');
          const state = url.searchParams.get('state');
          if (!redirectUri || !state) throw new Error('authorization URL missing loopback callback fields');
          await fetch(`${redirectUri}?code=mock-code-fixture&state=${state}`);
        },
        fetch: hangingFetch,
      })).rejects.toThrow('OAuth token exchange timed out after 20 ms');

      expect(writes).toEqual([]);
      expect(existsSync(registryPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failed X identity lookup removes the unregistered client id and refresh token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-x-identity-cleanup-'));
    const registryPath = join(dir, 'handles.json');
    const store = new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    });
    const fetchImpl: OAuthFetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/token') {
        return new Response(JSON.stringify({
          access_token: 'x-access-token-fixture',
          refresh_token: 'x-refresh-token-fixture',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === '/2/users/me') {
        return new Response(JSON.stringify({ error: 'provider unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('', { status: 404 });
    };
    try {
      await expect(connectOAuthSource({
        source: 'x',
        clientId: 'x-client-id-fixture',
        clientSecret: 'x-client-secret-fixture',
        authUrl: 'https://x.test/authorize',
        tokenUrl: 'https://x.test/token',
        registryPath,
        secretStore: store,
        fetch: fetchImpl,
        openBrowser: false,
        onAuthorizationUrl: async (authorizationUrl) => {
          const url = new URL(authorizationUrl);
          const redirectUri = url.searchParams.get('redirect_uri');
          const state = url.searchParams.get('state');
          if (!redirectUri || !state) throw new Error('authorization URL missing loopback callback fields');
          await fetch(`${redirectUri}?code=x-code-fixture&state=${state}`);
        },
      })).rejects.toThrow('X did not confirm the connected user id');

      expect(await store.list()).toEqual([]);
      expect(existsSync(registryPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Readwise API token connect validates before storing credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-readwise-validate-'));
    const registryPath = join(dir, 'handles.json');
    const store = new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    });
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const invalidFetch: OAuthFetch = async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return new Response('', { status: 401 });
    };
    try {
      await expect(connectApiKeySource({
        source: 'readwise',
        apiKey: 'bad-readwise-token-fixture',
        registryPath,
        secretStore: store,
        fetch: invalidFetch,
        readwiseAuthUrl: 'https://readwise.test/api/v2/auth/',
      })).rejects.toThrow('Readwise rejected the API token');

      expect(await store.get('readwise.personal.token')).toBeUndefined();
      expect(existsSync(registryPath)).toBe(false);
      expect(calls).toEqual([{
        url: 'https://readwise.test/api/v2/auth/',
        authorization: 'Token bad-readwise-token-fixture',
      }]);

      const validFetch: OAuthFetch = async () => new Response('', { status: 204 });
      const result = await connectApiKeySource({
        source: 'readwise',
        apiKey: 'good-readwise-token-fixture',
        registryPath,
        secretStore: store,
        fetch: validFetch,
        readwiseAuthUrl: 'https://readwise.test/api/v2/auth/',
      });
      const registry = readConnectedHandleRegistry(registryPath);

      expect(result.handles).toEqual(['readwise.personal']);
      expect(await store.get('readwise.personal.token')).toBe('good-readwise-token-fixture');
      expect(registry.handles[0]).toMatchObject({
        handle: 'readwise.personal',
        provider: 'readwise',
        trustDomain: 'internal',
        allowedCapabilities: ['readwise.sync'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Notion integration token connect validates before storing credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-notion-validate-'));
    const registryPath = join(dir, 'handles.json');
    const store = new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    });
    const calls: Array<{
      url: string;
      authorization: string | null;
      notionVersion: string | null;
    }> = [];
    const invalidFetch: OAuthFetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get('authorization'),
        notionVersion: headers.get('notion-version'),
      });
      return new Response(JSON.stringify({ code: 'unauthorized' }), { status: 401 });
    };
    try {
      await expect(connectApiKeySource({
        source: 'notion',
        apiKey: 'bad-notion-token-fixture',
        registryPath,
        secretStore: store,
        fetch: invalidFetch,
        notionBaseUrl: 'https://api.notion.test/v1',
        notionVersion: '2026-01-01',
      })).rejects.toThrow('Notion rejected the integration token');

      expect(await store.get('notion.personal.integration_token')).toBeUndefined();
      expect(existsSync(registryPath)).toBe(false);
      expect(calls).toEqual([{
        url: 'https://api.notion.test/v1/users/me',
        authorization: 'Bearer bad-notion-token-fixture',
        notionVersion: '2026-01-01',
      }]);

      const validFetch: OAuthFetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          authorization: headers.get('authorization'),
          notionVersion: headers.get('notion-version'),
        });
        return new Response(JSON.stringify({ object: 'user', id: 'notion-user-fixture' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const result = await connectApiKeySource({
        source: 'notion',
        apiKey: 'good-notion-token-fixture',
        accountRole: 'solon',
        registryPath,
        secretStore: store,
        fetch: validFetch,
        notionBaseUrl: 'https://api.notion.test/v1',
      });
      const registry = readConnectedHandleRegistry(registryPath);

      expect(result.handles).toEqual(['notion.solon']);
      expect(result.secretRefs).toEqual(['store:notion.solon.integration_token']);
      expect(result.next).toContain('OLYMPUS_DOMAIN_EXPERT_NOTION_TOKEN');
      expect(result.next).toContain('Share each target page or database');
      expect(await store.get('notion.solon.integration_token')).toBe('good-notion-token-fixture');
      expect(registry.handles[0]).toMatchObject({
        handle: 'notion.solon',
        provider: 'notion',
        accountRole: 'solon',
        trustDomain: 'internal',
        allowedCapabilities: ['domain_expert.notion_import'],
        tokenSecretRefs: ['store:notion.solon.integration_token'],
      });
      expect(calls[1]).toEqual({
        url: 'https://api.notion.test/v1/users/me',
        authorization: 'Bearer good-notion-token-fixture',
        notionVersion: '2022-06-28',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Venice API key connect probes models before storing credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-venice-validate-'));
    const store = new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    });
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl: OAuthFetch = async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ data: [{ id: 'e2ee-glm-5-2-p' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await connectApiKeySource({
        source: 'venice',
        apiKey: 'venice-api-key-fixture',
        secretStore: store,
        fetch: fetchImpl,
        veniceModelsUrl: 'https://api.venice.test/api/v1/models',
      });

      expect(result.secretRefs).toEqual(['store:venice.api_key']);
      expect(await store.get('venice.api_key')).toBe('venice-api-key-fixture');
      expect(calls).toEqual([{
        url: 'https://api.venice.test/api/v1/models',
        authorization: 'Bearer venice-api-key-fixture',
      }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detached lifecycle writes pending then connected state without storing tokens in state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-oauth-detached-test-'));
    const registryPath = join(dir, 'handles.json');
    const statePath = join(dir, 'pending-oauth', 'dropbox.personal.json');
    const logPath = join(dir, 'oauth.log');
    const store = new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    });
    const server = await oauthServer({
      tokenStatus: 200,
      tokenBody: {
        access_token: 'detached-access-token-fixture',
        refresh_token: 'detached-refresh-token-fixture',
        expires_in: 3600,
      },
    });
    try {
      let pendingJson = '';
      const finalState = await runDetachedOAuthLifecycle({
        source: 'dropbox',
        clientId: 'dropbox-client-id-fixture',
        authUrl: `${server.baseUrl}/authorize`,
        tokenUrl: `${server.baseUrl}/token`,
        registryPath,
        secretStore: store,
        openBrowser: false,
        statePath,
        logPath,
        pid: 12345,
        now: () => new Date('2026-07-07T12:00:00.000Z'),
        onAuthorizationUrl: async (authorizationUrl) => {
          pendingJson = readFileSync(statePath, 'utf8');
          const authResponse = await fetch(authorizationUrl, { redirect: 'manual' });
          const location = authResponse.headers.get('location');
          if (!location) throw new Error('mock authorization did not redirect');
          await fetch(location);
        },
      });

      expect(JSON.parse(pendingJson)).toMatchObject({
        source: 'dropbox',
        accountRole: 'personal',
        status: 'pending',
        pid: 12345,
        logPath,
      });
      expect(pendingJson).toContain('authorizationUrl');
      expect(finalState).toMatchObject({
        source: 'dropbox',
        accountRole: 'personal',
        status: 'connected',
        handles: ['dropbox.personal'],
        handleId: 'dropbox.personal',
      });
      const finalJson = readFileSync(statePath, 'utf8');
      expect(finalJson).not.toContain('detached-access-token-fixture');
      expect(finalJson).not.toContain('detached-refresh-token-fixture');
      expect(pendingJson).not.toContain('detached-access-token-fixture');
      expect(pendingJson).not.toContain('detached-refresh-token-fixture');
      expect(await store.get('dropbox.personal.oauth.refresh_token')).toBe('detached-refresh-token-fixture');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detached parent timeout reports the requested source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-oauth-detached-parent-timeout-'));
    try {
      await expect(connectOAuthSourceDetached({
        source: 'x',
        accountRole: 'research',
        clientId: 'x-client-id-fixture',
        stateDir: join(dir, 'state'),
        logDir: join(dir, 'logs'),
        childArgv: [process.execPath, '--eval', ''],
        parentWaitMs: 20,
        openBrowser: false,
      })).rejects.toThrow('Detached OAuth child for x/research did not publish');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detached lifecycle records token exchange failures without leaking tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-oauth-detached-fail-test-'));
    const statePath = join(dir, 'pending-oauth', 'dropbox.personal.json');
    const server = await oauthServer({
      tokenStatus: 500,
      tokenBody: {
        error: 'server_error',
        error_description: 'provider said no',
        access_token: 'must-not-leak-token-shaped-value-1234567890',
      },
    });
    try {
      const finalState = await runDetachedOAuthLifecycle({
        source: 'dropbox',
        clientId: 'dropbox-client-id-fixture',
        authUrl: `${server.baseUrl}/authorize`,
        tokenUrl: `${server.baseUrl}/token`,
        openBrowser: false,
        statePath,
        logPath: join(dir, 'oauth.log'),
        onAuthorizationUrl: async (authorizationUrl) => {
          const authResponse = await fetch(authorizationUrl, { redirect: 'manual' });
          const location = authResponse.headers.get('location');
          if (!location) throw new Error('mock authorization did not redirect');
          await fetch(location);
        },
      });

      expect(finalState.status).toBe('failed');
      expect(finalState.reason).toContain('OAuth token exchange failed with status 500');
      // The allowlisted code is all a provider gets to say; its description is
      // prose that can echo credential material (R61/R61B) and never records.
      expect(finalState.reason).toContain('server_error');
      expect(finalState.reason).not.toContain('provider said no');
      expect(finalState.reason).not.toContain('must-not-leak-token-shaped-value-1234567890');
      expect(readFileSync(statePath, 'utf8')).not.toContain('must-not-leak-token-shaped-value-1234567890');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detached lifecycle records authorization expiry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-oauth-detached-expired-test-'));
    const statePath = join(dir, 'pending-oauth', 'dropbox.personal.json');
    try {
      const finalState = await runDetachedOAuthLifecycle({
        source: 'dropbox',
        clientId: 'dropbox-client-id-fixture',
        openBrowser: false,
        statePath,
        logPath: join(dir, 'oauth.log'),
        authorizationTimeoutMs: 20,
      });

      expect(finalState.status).toBe('expired');
      expect(finalState.reason).toContain('OAuth authorization timed out after 20 ms');
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'expired' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status reports a dead detached child for non-terminal state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-oauth-dead-status-test-'));
    const stateDir = join(dir, 'pending-oauth');
    try {
      writeDetachedOAuthState(join(stateDir, 'dropbox.personal.json'), {
        source: 'dropbox',
        accountRole: 'personal',
        status: 'pending',
        authorizationUrl: 'https://example.test/oauth',
        port: 49152,
        pid: 999999,
        startedAt: '2026-07-07T12:00:00.000Z',
        expiresAt: '2026-07-07T12:10:00.000Z',
        logPath: join(dir, 'oauth.log'),
      });

      expect(listDetachedOAuthStates({ stateDir, pidAlive: () => false })).toEqual([
        expect.objectContaining({
          source: 'dropbox',
          accountRole: 'personal',
          status: 'died',
          logPath: join(dir, 'oauth.log'),
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function readRequestBody(request: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const hangingFetch = Object.assign(
  async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const guard = setTimeout(() => reject(new Error('token exchange did not receive an abort signal')), 250);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(guard);
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => {
      clearTimeout(guard);
      reject(abortError());
    }, { once: true });
  }),
  { preconnect() {} },
) as typeof fetch;

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

async function oauthServer(options: { tokenStatus: number; tokenBody: Record<string, unknown> }): Promise<{
  baseUrl: string;
  close: () => void;
}> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      response.writeHead(302, { Location: `${redirectUri}?code=mock-code-fixture&state=${state}` }).end();
      return;
    }
    if (url.pathname === '/token') {
      response.writeHead(options.tokenStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify(options.tokenBody));
      return;
    }
    if (url.pathname === '/2/users/me') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        data: { id: '2468135790', username: 'fixture' },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => server.close(),
  };
}

async function connectAndRefreshWithMode(
  source: 'gmail' | 'dropbox',
  refreshMode: 'invalid_grant' | 'server_error',
): Promise<{
  registryPath: string;
  error: unknown;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), `olympus-refresh-${refreshMode}-${source}-`));
  const registryPath = join(dir, 'handles.json');
  const store = new EncryptedFileSecretStore({
    encryptedFilePath: join(dir, 'secrets.enc'),
    keyFilePath: join(dir, 'secrets.key'),
  });
  let refreshAttempted = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      response.writeHead(302, { Location: `${redirectUri}?code=${source}-code&state=${state}` }).end();
      return;
    }
    if (url.pathname === '/token') {
      const body = await readRequestBody(request);
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'authorization_code') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          access_token: `${source}-access-token`,
          refresh_token: `${source}-refresh-token`,
          expires_in: 3600,
        }));
        return;
      }
      refreshAttempted = true;
      if (refreshMode === 'invalid_grant') {
        response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Refresh token expired or revoked.',
        }));
        return;
      }
      response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        error: 'server_error',
        error_description: 'Try again later.',
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await connectOAuthSource({
    source,
    clientId: `${source}-client-id`,
    ...(source === 'gmail' ? { clientSecret: `${source}-client-secret` } : {}),
    authUrl: `${baseUrl}/authorize`,
    tokenUrl: `${baseUrl}/token`,
    registryPath,
    secretStore: store,
    openBrowser: false,
    onAuthorizationUrl: async (url) => {
      const authResponse = await fetch(url, { redirect: 'manual' });
      const location = authResponse.headers.get('location');
      if (!location) throw new Error('mock authorization did not redirect');
      await fetch(location);
    },
  });
  const broker = createEnvCredentialBroker({
    env: {},
    handleRegistryPath: registryPath,
    secretStore: store,
    oauth2RefreshFailureBackoffMs: 0,
    oauth2CacheNamespace: `test-${source}-${refreshMode}-${Date.now()}`,
  });
  const request = source === 'gmail'
    ? {
      handle: 'gmail.personal',
      provider: 'gmail' as const,
      capability: 'gmail.email.sync',
      trustDomain: 'secure_local' as const,
    }
    : {
      handle: 'dropbox.personal',
      provider: 'dropbox' as const,
      capability: 'dropbox.files.sync',
      trustDomain: 'secure_local' as const,
    };
  let error: unknown;
  try {
    await broker.issueSession(request);
  } catch (caught) {
    error = caught;
  }
  expect(refreshAttempted).toBe(true);
  if (!error) throw new Error('Expected OAuth refresh to fail.');
  return {
    registryPath,
    error,
    cleanup: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function emptyDashboardStatus() {
  return {
    kind: 'source_index_status' as const,
    generated_at: '2026-07-07T12:00:00.000Z',
    corpora: [],
    policy: {
      read_only: true as const,
      raw_source_exposed: false as const,
      source_packets_exposed: false as const,
      source_text_returned: false as const,
      secure_local_item_metadata_exposed: false as const,
      castor_visible: true as const,
    },
  };
}

async function withTemporaryHome(callback: (home: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-connect-default-home-'));
  try {
    await callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runChildScript(script: string, options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--eval', script], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  return {
    status,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

function productionDefaultRegistryBrokerScript(): string {
  return `
import { connectApiKeySource, connectGuidedSession, connectOAuthSource } from './src/core/connect.ts';
import { createEnvCredentialBroker } from './src/workers/credential-broker/index.ts';

const baseUrl = process.env.OLYMPUS_TEST_CONNECT_BASE_URL;
if (!baseUrl) throw new Error('Missing OLYMPUS_TEST_CONNECT_BASE_URL.');
const brokerBeforeConnect = createEnvCredentialBroker({ env: { ...process.env } });

async function completeBrowserRedirect(url) {
  const authResponse = await fetch(url, { redirect: 'manual' });
  const location = authResponse.headers.get('location');
  if (!location) throw new Error('mock authorization did not redirect');
  await fetch(location);
}

for (const source of ['dropbox', 'x']) {
  await connectOAuthSource({
    source,
    clientId: source === 'x' ? 'x-client-id' : 'dropbox-client-id',
    ...(source === 'x' ? { clientSecret: 'x-client-secret' } : {}),
    authUrl: baseUrl + '/authorize',
    tokenUrl: baseUrl + '/token',
    openBrowser: false,
    onAuthorizationUrl: completeBrowserRedirect,
  });
}
await connectApiKeySource({
  source: 'readwise',
  apiKey: 'readwise-api-token-fixture',
});
await connectGuidedSession({
  source: 'telegram',
  sessionPath: '/tmp/olympus-test-telegram.session',
  sessionReady: true,
});

async function expectSessionWithBroker(broker, request, expected) {
  const session = await broker.issueSession(request);
  for (const [key, value] of Object.entries(expected)) {
    if (session[key] !== value) {
      throw new Error(\`Expected \${request.handle} \${key}=\${value}, got \${session[key]}\`);
    }
  }
}

async function expectSession(request, expected) {
  await expectSessionWithBroker(createEnvCredentialBroker({ env: { ...process.env } }), request, expected);
}

await expectSessionWithBroker(brokerBeforeConnect, {
  handle: 'dropbox.personal',
  provider: 'dropbox',
  capability: 'dropbox.files.sync',
  trustDomain: 'secure_local',
}, { kind: 'bearer_token', token: 'dropbox-client-id.refresh.access' });
await expectSession({
  handle: 'dropbox.personal',
  provider: 'dropbox',
  capability: 'dropbox.files.sync',
  trustDomain: 'secure_local',
}, { kind: 'bearer_token', token: 'dropbox-client-id.refresh.access' });
await expectSession({
  handle: 'x.bookmarks.personal',
  provider: 'x',
  capability: 'x.bookmarks.sync',
  trustDomain: 'internal',
}, { kind: 'bearer_token', token: 'x-client-id.refresh.access' });
await expectSession({
  handle: 'readwise.personal',
  provider: 'readwise',
  capability: 'readwise.sync',
  trustDomain: 'internal',
}, { kind: 'bearer_token', token: 'readwise-api-token-fixture' });
await expectSession({
  handle: 'telegram.personal',
  provider: 'telegram',
  capability: 'telegram.messages.sync',
  trustDomain: 'secure_local',
}, {
  kind: 'mtproto_session',
  mtprotoProfileId: 'telegram_personal',
  runtimeEndpointId: 'telegram_local_telethon_reader',
});
`;
}
