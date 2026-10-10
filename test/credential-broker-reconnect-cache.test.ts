// A reconnect must never be served a token minted from the grant it replaced.
//
// 2026-10-10, reviewer demo: Dropbox was connected with one account, then at
// once with another. The second connect replaced the refresh token, but the
// broker's process cache (keyed by handle and capability only) kept handing the
// worker the first account's access token for the rest of its four-hour life,
// and 14,806 of the first account's files were indexed under the second
// account's credential.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretStore } from '../src/core/secret-store.ts';
import { upsertConnectedHandle } from '../src/workers/credential-broker/connected-handles.ts';
import {
  createEnvCredentialBroker,
  invalidateMintedCredentialSessions,
} from '../src/workers/credential-broker/index.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REQUEST = {
  handle: 'dropbox.personal',
  provider: 'dropbox' as const,
  capability: 'dropbox.files.sync',
  trustDomain: 'secure_local' as const,
};

function memorySecretStore(initial: Record<string, string>): SecretStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    label: 'memory',
    values,
    async get(key) { return values.get(key); },
    getSync(key) { return values.get(key); },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list() { return [...values.keys()]; },
  };
}

function writeDropboxGrant(registryPath: string, connectedAt: string, providerAccountId?: string): void {
  upsertConnectedHandle({
    handle: 'dropbox.personal',
    provider: 'dropbox',
    accountRole: 'personal',
    trustDomain: 'secure_local',
    allowedCapabilities: ['dropbox.files.sync'],
    scopes: ['files.metadata.read', 'files.content.read', 'sharing.read', 'account_info.read'],
    oauth2Refresh: {
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      clientIdSecretRef: 'store:dropbox.personal.oauth.client_id',
      refreshTokenSecretRef: 'store:dropbox.personal.oauth.refresh_token',
    },
    connectedAt,
    ...(providerAccountId ? { providerAccountId } : {}),
  }, registryPath);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-reconnect-cache-'));
  dirs.push(dir);
  const registryPath = join(dir, 'handles.json');
  const secretStore = memorySecretStore({
    'dropbox.personal.oauth.client_id': 'dropbox-client-id-fixture',
    'dropbox.personal.oauth.refresh_token': 'refresh-token-account-a',
  });
  const mints: string[] = [];
  const broker = createEnvCredentialBroker({
    env: {},
    handleRegistryPath: registryPath,
    secretStore,
    oauth2CacheNamespace: `reconnect-cache-${dir}`,
    now: () => new Date('2026-10-10T22:41:00.000Z'),
    fetch: async (_url, init) => {
      const refreshToken = new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '';
      mints.push(refreshToken);
      return new Response(JSON.stringify({
        access_token: `access-for-${refreshToken}`,
        expires_in: 14_400,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { registryPath, secretStore, mints, broker };
}

describe('minted access tokens are bound to the grant that minted them', () => {
  test('a reconnect with a different account mints from the new grant at once', async () => {
    const { registryPath, secretStore, mints, broker } = fixture();
    writeDropboxGrant(registryPath, '2026-10-10T22:41:00.000Z', 'dbid:account-a');

    const first = await broker.issueSession(REQUEST);
    expect(first.kind === 'bearer_token' && first.token).toBe('access-for-refresh-token-account-a');
    // Still cached within the same grant: no second mint.
    await broker.issueSession(REQUEST);
    expect(mints).toEqual(['refresh-token-account-a']);

    // The second connect, a minute later, as the dashboard writes it.
    await secretStore.set('dropbox.personal.oauth.refresh_token', 'refresh-token-account-b');
    writeDropboxGrant(registryPath, '2026-10-10T22:42:00.000Z', 'dbid:account-b');

    const second = await broker.issueSession(REQUEST);
    expect(second.kind === 'bearer_token' && second.token).toBe('access-for-refresh-token-account-b');
    expect(mints).toEqual(['refresh-token-account-a', 'refresh-token-account-b']);
  });

  test('a reconnect that records no account id still changes the grant', async () => {
    const { registryPath, secretStore, broker } = fixture();
    writeDropboxGrant(registryPath, '2026-10-10T22:41:00.000Z');
    await broker.issueSession(REQUEST);

    await secretStore.set('dropbox.personal.oauth.refresh_token', 'refresh-token-account-b');
    writeDropboxGrant(registryPath, '2026-10-10T22:42:00.000Z');

    const session = await broker.issueSession(REQUEST);
    expect(session.kind === 'bearer_token' && session.token).toBe('access-for-refresh-token-account-b');
  });

  test('a refresh in flight across a reconnect is discarded, never served or persisted (Codex round 1 #3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-reconnect-inflight-'));
    dirs.push(dir);
    const registryPath = join(dir, 'handles.json');
    writeDropboxGrant(registryPath, '2026-10-10T22:41:00.000Z', 'dbid:account-a');
    const secretStore = memorySecretStore({
      'dropbox.personal.oauth.client_id': 'dropbox-client-id-fixture',
      'dropbox.personal.oauth.refresh_token': 'refresh-token-account-a',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const broker = createEnvCredentialBroker({
      env: {},
      handleRegistryPath: registryPath,
      secretStore,
      oauth2CacheNamespace: `reconnect-inflight-${dir}`,
      now: () => new Date('2026-10-10T22:41:00.000Z'),
      fetch: async (_url, init) => {
        calls += 1;
        const refreshToken = new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '';
        if (calls === 1) await gate;
        return new Response(JSON.stringify({
          access_token: `access-for-${refreshToken}`,
          // A rotating provider hands back a new refresh token for the OLD grant.
          refresh_token: `rotated-${refreshToken}`,
          expires_in: 14_400,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const inFlight = broker.issueSession(REQUEST).catch((reason: unknown) => reason);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await secretStore.set('dropbox.personal.oauth.refresh_token', 'refresh-token-account-b');
    writeDropboxGrant(registryPath, '2026-10-10T22:42:00.000Z', 'dbid:account-b');
    release();

    const superseded = await inFlight;
    expect((superseded as { code?: string }).code).toBe('credential_refresh_busy');
    expect(secretStore.values.get('dropbox.personal.oauth.refresh_token')).toBe('refresh-token-account-b');
    const next = await broker.issueSession(REQUEST);
    expect(next.kind === 'bearer_token' && next.token).toBe('access-for-refresh-token-account-b');
  });

  test('an environment-supplied refresh token that changes is a new cache identity (Codex round 1 #5)', async () => {
    const env: Record<string, string | undefined> = {
      OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_OAUTH2_CLIENT_ID: 'dropbox-client-id-fixture',
      OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_OAUTH2_REFRESH_TOKEN: 'env-refresh-token-a',
    };
    const broker = createEnvCredentialBroker({
      env,
      loadDefaultHandleRegistry: false,
      oauth2CacheNamespace: `reconnect-env-${Math.random()}`,
      now: () => new Date('2026-10-10T22:41:00.000Z'),
      fetch: async (_url, init) => {
        const refreshToken = new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '';
        return new Response(JSON.stringify({ access_token: `access-for-${refreshToken}`, expires_in: 14_400 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const first = await broker.issueSession(REQUEST);
    expect(first.kind === 'bearer_token' && first.token).toBe('access-for-env-refresh-token-a');
    env.OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_OAUTH2_REFRESH_TOKEN = 'env-refresh-token-b';
    const second = await broker.issueSession(REQUEST);
    expect(second.kind === 'bearer_token' && second.token).toBe('access-for-env-refresh-token-b');
  });

  test('invalidation drops a cached token even when the grant looks unchanged', async () => {
    const { registryPath, secretStore, mints, broker } = fixture();
    writeDropboxGrant(registryPath, '2026-10-10T22:41:00.000Z', 'dbid:account-a');
    await broker.issueSession(REQUEST);
    await secretStore.set('dropbox.personal.oauth.refresh_token', 'refresh-token-rotated');

    invalidateMintedCredentialSessions('dropbox.personal');

    const session = await broker.issueSession(REQUEST);
    expect(session.kind === 'bearer_token' && session.token).toBe('access-for-refresh-token-rotated');
    expect(mints).toEqual(['refresh-token-account-a', 'refresh-token-rotated']);
  });
});
