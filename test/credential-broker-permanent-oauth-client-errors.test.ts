// `invalid_client`, `unauthorized_client` and `access_denied` are refusals of
// the client registration or of the authorization itself: a human has to change
// something in the provider's console before any refresh can succeed. They
// arrive as 401/403, which the marker-retirement branch reads as "no token was
// issued" and returns to `available` -- so before this was classified, every
// retry window re-spent the same dead refresh and no durable operator-visible
// state ever appeared. The service-account lane already classified the same
// three as terminal.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  CredentialBrokerError,
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

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a permanent OAuth client refusal leaves the retry lane', () => {
  for (const [status, providerError] of [
    [401, 'invalid_client'],
    [403, 'unauthorized_client'],
    [403, 'access_denied'],
  ] as const) {
    test(`a ${status} ${providerError} latches reauth_required instead of retrying forever`, async () => {
      const dir = temporaryDir(`olympus-permanent-${providerError}-`);
      const registryPath = join(dir, 'handles.json');
      writeRegisteredXHandle(registryPath);
      const store = new MemoryOAuth2StateStore();
      await store.save('x.bookmarks.personal', {
        refreshToken: 'refresh-token-generation-1',
        status: 'available',
      });
      let attempts = 0;
      const broker = createEnvCredentialBroker({
        env: X_CLIENT_ENV,
        handleRegistryPath: registryPath,
        oauth2StateStore: store,
        oauth2CacheNamespace: `permanent-${providerError}-${dir}`,
        oauth2RefreshFailureBackoffMs: 0,
        now: () => new Date('2026-08-18T03:00:00.000Z'),
        fetch: async () => {
          attempts += 1;
          return new Response(JSON.stringify({
            error: providerError,
            error_description: 'the client is not authorized for this grant',
          }), { status, headers: { 'Content-Type': 'application/json' } });
        },
      });

      const first = await broker.issueSession(X_REQUEST).catch((reason: unknown) => reason);
      expect(first).toBeInstanceOf(CredentialBrokerError);
      expect((first as CredentialBrokerError).code).toBe('credential_reauth_required');

      const state = await store.load('x.bookmarks.personal');
      expect(state?.status).toBe('reauth_required');
      expect(state?.pendingRefreshStartedAt).toBeUndefined();
      expect(readConnectedHandleRegistry(registryPath).handles[0]?.backendState?.status)
        .toBe('reauth_required');

      // The dead client is not re-presented to the provider on the next window.
      const second = await broker.issueSession(X_REQUEST).catch((reason: unknown) => reason);
      expect((second as CredentialBrokerError).code).toBe('credential_reauth_required');
      expect(attempts).toBe(1);
    });
  }

  test('a rate limit carrying no permanent provider error stays retryable', async () => {
    const dir = temporaryDir('olympus-permanent-rate-limit-');
    const registryPath = join(dir, 'handles.json');
    writeRegisteredXHandle(registryPath);
    const store = new MemoryOAuth2StateStore();
    await store.save('x.bookmarks.personal', {
      refreshToken: 'refresh-token-generation-1',
      status: 'available',
    });
    let attempts = 0;
    const broker = createEnvCredentialBroker({
      env: X_CLIENT_ENV,
      handleRegistryPath: registryPath,
      oauth2StateStore: store,
      oauth2CacheNamespace: `permanent-rate-limit-${dir}`,
      oauth2RefreshFailureBackoffMs: 0,
      now: () => new Date('2026-08-18T03:00:00.000Z'),
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

    await expect(broker.issueSession(X_REQUEST)).rejects.toMatchObject({
      code: 'credential_refresh_failed',
    });
    const second = await broker.issueSession(X_REQUEST);

    expect(second.kind).toBe('bearer_token');
    expect((await store.load('x.bookmarks.personal'))?.status).toBe('available');
    expect(readConnectedHandleRegistry(registryPath).handles[0]?.backendState?.status)
      .toBeUndefined();
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
