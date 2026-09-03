import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  CredentialBrokerError,
  JsonCredentialOAuth2StateStore,
  createEnvCredentialBroker,
  type CredentialOAuth2HandleState,
  type CredentialOAuth2StateStore,
} from '../src/workers/credential-broker/index.ts';
import { readConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';

const X_REQUEST = {
  handle: 'x.bookmarks.personal',
  provider: 'x' as const,
  capability: 'x.bookmarks.sync',
  trustDomain: 'internal' as const,
};

const X_CLIENT_ENV = {
  OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_ID: 'x-client-id-fixture',
  OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_SECRET: 'x-client-secret-fixture',
};

// Generated here and discarded with the process; no real key may be a fixture.
const THROWAWAY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'olympus-fixture-project',
  private_key_id: 'fixture-key-id',
  private_key: THROWAWAY.privateKey,
  client_email: 'olympus-secure@olympus-fixture-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Recovery from `reauth_required` is a human re-consent, so every path that
 * writes it has to be an outcome the provider actually proved. These cases pin
 * the three that were not.
 */
describe('a transient refusal never latches a live credential handle', () => {
  test('a rate-limited token endpoint stays retryable on the attempt after it', async () => {
    const dir = temporaryDir('olympus-marker-rate-limit-');
    const registryPath = join(dir, 'handles.json');
    writeRegisteredXHandle(registryPath);
    const store = new MemoryOAuth2StateStore();
    await store.save('x.bookmarks.personal', {
      refreshToken: 'refresh-token-generation-1',
      status: 'available',
    });
    const clock = { now: new Date('2026-07-28T03:00:00.000Z') };
    let attempts = 0;
    const broker = createEnvCredentialBroker({
      env: X_CLIENT_ENV,
      handleRegistryPath: registryPath,
      oauth2StateStore: store,
      oauth2CacheNamespace: `marker-rate-limit-${dir}`,
      now: () => clock.now,
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: 'rate_limit_exceeded' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          access_token: 'access-token-generation-2',
          expires_in: 7200,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const first = await broker.issueSession(X_REQUEST).catch((reason: unknown) => reason);
    expect((first as CredentialBrokerError).code).toBe('credential_refresh_failed');
    // A 429 is decided before the grant is read, so no token was issued and the
    // write-ahead marker is retired with it. Left standing, it made the NEXT
    // attempt write reauth_required for a handle that was merely rate-limited.
    expect((await store.load('x.bookmarks.personal'))?.pendingRefreshStartedAt).toBeUndefined();

    clock.now = new Date('2026-07-28T03:01:00.000Z');
    const second = await broker.issueSession(X_REQUEST);

    expect(second.kind).toBe('bearer_token');
    expect(attempts).toBe(2);
    expect((await store.load('x.bookmarks.personal'))?.status).toBe('available');
    expect(readConnectedHandleRegistry(registryPath).handles[0]?.backendState?.status)
      .toBeUndefined();
  });

  test('a token-endpoint outage keeps the in-flight marker standing', async () => {
    const store = new MemoryOAuth2StateStore();
    await store.save('x.bookmarks.personal', {
      refreshToken: 'refresh-token-generation-1',
      status: 'available',
    });
    const broker = createEnvCredentialBroker({
      env: X_CLIENT_ENV,
      loadDefaultHandleRegistry: false,
      oauth2StateStore: store,
      oauth2CacheNamespace: 'marker-outage',
      now: () => new Date('2026-07-28T03:00:00.000Z'),
      fetch: async () => new Response('upstream unavailable', { status: 503 }),
    });

    await expect(broker.issueSession(X_REQUEST)).rejects.toMatchObject({
      code: 'credential_refresh_failed',
    });

    // A 5xx can land after the provider already committed a rotation, so the
    // outcome is genuinely unknown and the marker must survive.
    expect((await store.load('x.bookmarks.personal'))?.pendingRefreshStartedAt)
      .toBe('2026-07-28T03:00:00.000Z');
  });

  test('a clock-skew invalid_grant is retryable, not a delegation refusal', async () => {
    const dir = temporaryDir('olympus-marker-jwt-skew-');
    const registryPath = join(dir, 'handles.json');
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      handles: [{
        handle: 'gmail.personal.delegated',
        provider: 'gmail',
        accountRole: 'personal',
        trustDomain: 'secure_local',
        allowedCapabilities: ['gmail.email.sync'],
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        connectedAt: '2026-07-28T10:00:00.000Z',
      }],
    }));
    const store = new MemoryOAuth2StateStore();
    const broker = createEnvCredentialBroker({
      env: { OLYMPUS_CREDENTIAL_GOOGLE_OLYMPUS_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON, OLYMPUS_CREDENTIAL_GOOGLE_PERSONAL_SUBJECT: 'owner-personal@example.test', OLYMPUS_CREDENTIAL_GOOGLE_BUSINESS_SUBJECT: 'owner-business@example.test' },
      handleRegistryPath: registryPath,
      oauth2StateStore: store,
      oauth2CacheNamespace: 'marker-jwt-skew',
      oauth2RefreshFailureBackoffMs: 0,
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      // What Google answers when the host clock has not been stepped by NTP
      // yet: the same error code as a genuine delegation refusal.
      fetch: async () => new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim.',
      }), { status: 400 }),
    });

    const error = await broker.issueSession({
      handle: 'gmail.personal.delegated',
      provider: 'gmail',
      capability: 'gmail.email.sync',
      trustDomain: 'secure_local',
    }).catch((reason: unknown) => reason);

    // No product path clears a stamped delegated handle, so a skewed clock
    // used to kill Gmail and Drive ingestion until someone hand-edited JSON.
    expect((error as CredentialBrokerError).code).toBe('credential_refresh_failed');
    expect(String(error)).not.toContain('PRIVATE KEY');
    await expect(store.load('gmail.personal.delegated')).resolves.toBeUndefined();
    expect(readConnectedHandleRegistry(registryPath).handles[0]?.backendState?.status)
      .toBeUndefined();
  });

  test('a reconnect that installs a new refresh token retires the stale marker', async () => {
    const dir = temporaryDir('olympus-marker-reconnect-');
    const statePath = join(dir, 'credential-broker.json');
    const store = new JsonCredentialOAuth2StateStore(statePath);
    await store.save('x.bookmarks.personal', {
      refreshToken: 'refresh-token-generation-1',
      status: 'available',
      pendingRefreshStartedAt: '2026-07-28T03:00:00.000Z',
    });

    // Exactly what the connect flow writes: no mention of the marker, which the
    // store's read-modify-write then carried onto the brand-new token.
    await store.save('x.bookmarks.personal', {
      refreshToken: 'refresh-token-generation-2',
      scopes: ['tweet.read', 'bookmark.read', 'offline.access'],
      status: 'available',
      updatedAt: '2026-07-28T03:05:00.000Z',
    });

    expect((await store.load('x.bookmarks.personal'))?.pendingRefreshStartedAt).toBeUndefined();
    expect(readFileSync(statePath, 'utf8')).not.toContain('pendingRefreshStartedAt');

    const broker = createEnvCredentialBroker({
      env: X_CLIENT_ENV,
      loadDefaultHandleRegistry: false,
      oauth2StateStore: store,
      oauth2CacheNamespace: `marker-reconnect-${dir}`,
      now: () => new Date('2026-07-28T03:10:00.000Z'),
      fetch: async () => new Response(JSON.stringify({
        access_token: 'access-token-generation-3',
        expires_in: 7200,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    const session = await broker.issueSession(X_REQUEST);

    expect(session.kind).toBe('bearer_token');
    expect((await store.load('x.bookmarks.personal'))?.status).toBe('available');
  });

  test('an in-flight marker still fences the token it was written for', async () => {
    const dir = temporaryDir('olympus-marker-same-token-');
    const statePath = join(dir, 'credential-broker.json');
    const store = new JsonCredentialOAuth2StateStore(statePath);
    await store.save('x.bookmarks.personal', {
      refreshToken: 'refresh-token-generation-1',
      status: 'available',
      pendingRefreshStartedAt: '2026-07-28T03:00:00.000Z',
    });

    // A save that does not install a different token settles nothing, so the
    // fence against presenting a possibly-spent token has to survive it.
    await store.save('x.bookmarks.personal', { scopes: ['tweet.read'] });

    expect((await store.load('x.bookmarks.personal'))?.pendingRefreshStartedAt)
      .toBe('2026-07-28T03:00:00.000Z');
  });
});

function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(dir);
  return dir;
}

function writeRegisteredXHandle(registryPath: string): void {
  writeFileSync(registryPath, JSON.stringify({
    version: 1,
    handles: [{
      handle: 'x.bookmarks.personal',
      provider: 'x',
      accountRole: 'personal',
      trustDomain: 'internal',
      allowedCapabilities: ['x.bookmarks.sync'],
      scopes: ['tweet.read', 'bookmark.read', 'offline.access'],
      connectedAt: '2026-07-20T12:00:00.000Z',
      providerAccountId: '1234567890',
    }],
  }));
}

class MemoryOAuth2StateStore implements CredentialOAuth2StateStore {
  private readonly states = new Map<string, CredentialOAuth2HandleState>();

  async load(handle: string): Promise<CredentialOAuth2HandleState | undefined> {
    return this.states.get(handle);
  }

  async save(handle: string, state: CredentialOAuth2HandleState): Promise<void> {
    this.states.set(handle, { ...this.states.get(handle), ...state });
  }
}
