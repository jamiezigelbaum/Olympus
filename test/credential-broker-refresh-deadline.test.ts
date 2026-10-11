// A direct OAuth refresh has a deadline over the request and the body. A
// source's guarded tasks run one at a time and mint inside that turn
// (source-account-guard.ts), so a token response that never finished held
// every later task of the source behind it (PR #267 review, Astra round 2).

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

describe('a direct refresh has a deadline (PR #267 review, Astra round 2)', () => {
  test('a token endpoint that sends headers and never finishes the body fails the mint at the deadline', async () => {
    const dir = temporaryDir('olympus-refresh-deadline-');
    const registryPath = join(dir, 'handles.json');
    writeRegisteredXHandle(registryPath);
    const store = new MemoryOAuth2StateStore();
    await store.save('x.bookmarks.personal', {
      refreshToken: 'refresh-token-generation-1',
      status: 'available',
    });
    const broker = createEnvCredentialBroker({
      env: X_CLIENT_ENV,
      handleRegistryPath: registryPath,
      oauth2StateStore: store,
      oauth2CacheNamespace: `refresh-deadline-${dir}`,
      oauth2RefreshFailureBackoffMs: 0,
      oauth2RefreshTimeoutMs: 30,
      now: () => new Date('2026-08-18T03:00:00.000Z'),
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"access_token":"')); },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    const failure = await broker.issueSession(X_REQUEST).catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('credential_refresh_failed');
    expect((failure as Error).message).toContain('token endpoint timed out after 30ms');
    // Unanswered, so the provider may have rotated: the marker stands, as for any lost answer.
    expect((await store.load('x.bookmarks.personal'))?.pendingRefreshStartedAt).toBeDefined();
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
