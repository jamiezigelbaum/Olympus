import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  CredentialBrokerError,
  JsonCredentialOAuth2StateStore,
  createEnvCredentialBroker,
} from '../src/workers/credential-broker/index.ts';
import {
  clearConnectedHandleReauthRequired,
  markConnectedHandleReauthRequired,
  readConnectedHandleRegistry,
} from '../src/workers/credential-broker/connected-handles.ts';

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

describe('x-oauth2:seed-state recovers a registry-marked X handle', () => {
  test('a state-only reseed stays refused; the seed script clears the mark and the handle issues', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-seed-state-'));
    const registryPath = join(dir, 'handles.json');
    const statePath = join(dir, 'oauth2-state.json');
    writeRegisteredXHandle(registryPath);
    const broker = (namespace: string) => createEnvCredentialBroker({
      env: X_CLIENT_ENV,
      handleRegistryPath: registryPath,
      oauth2StateStore: new JsonCredentialOAuth2StateStore(statePath),
      oauth2CacheNamespace: `x-seed-state-${namespace}-${dir}`,
      oauth2RefreshFailureBackoffMs: 0,
      now: () => new Date('2026-09-22T03:00:00.000Z'),
      fetch: async () => new Response(
        JSON.stringify({ access_token: 'access-token-after-reseed', expires_in: 7200 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    });
    try {
      markConnectedHandleReauthRequired('x.bookmarks.personal', registryPath, new Date('2026-09-22T02:00:00.000Z'));
      await new JsonCredentialOAuth2StateStore(statePath).save('x.bookmarks.personal', {
        refreshToken: 'refresh-token-state-only',
        status: 'available',
      });
      const refused = await broker('state-only').issueSession(X_REQUEST).catch((reason: unknown) => reason);
      expect((refused as CredentialBrokerError).code).toBe('credential_reauth_required');

      const seed = Bun.spawnSync([process.execPath, 'scripts/x-oauth2-seed-state.ts'], {
        cwd: `${import.meta.dir}/..`,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: dir,
          OLYMPUS_CREDENTIAL_BROKER_STATE_PATH: statePath,
          OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: registryPath,
          OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_REFRESH_TOKEN: 'refresh-token-reseeded',
          OLYMPUS_SOURCE_INDEX_X_USER_ID: '1234567890',
        },
      });
      expect(seed.exitCode, seed.stderr.toString()).toBe(0);
      const stdout = seed.stdout.toString();
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        status: 'available',
        registry_reauth_mark_cleared: true,
        raw_credential_exposed: false,
      });
      expect(stdout).not.toContain('refresh-token-reseeded');
      expect(readConnectedHandleRegistry(registryPath).handles[0]?.backendState).toBeUndefined();

      const session = await broker('reseeded').issueSession(X_REQUEST);
      expect(session).toMatchObject({ token: 'access-token-after-reseed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('clearing the mark keeps backend state the mark did not create and preserves unknown entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-seed-clear-'));
    const registryPath = join(dir, 'handles.json');
    const unknownEntry = { handle: 'future.handle', provider: 'future-provider' };
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      handles: [unknownEntry, {
        handle: 'x.bookmarks.personal',
        provider: 'x',
        allowedCapabilities: ['x.bookmarks.sync'],
        scopes: ['bookmark.read'],
        backendState: { kind: 'oauth2_refresh', sessionId: 'kept', status: 'reauth_required', updatedAt: 'then' },
        connectedAt: '2026-07-20T12:00:00.000Z',
      }],
    }));
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      expect(clearConnectedHandleReauthRequired('x.bookmarks.personal', registryPath)).toBe(true);
      expect(readConnectedHandleRegistry(registryPath).handles[0]?.backendState).toEqual({
        kind: 'oauth2_refresh',
        sessionId: 'kept',
      });
      expect((JSON.parse(readFileSync(registryPath, 'utf8')) as { handles: unknown[] }).handles)
        .toContainEqual(unknownEntry);
      expect(clearConnectedHandleReauthRequired('x.bookmarks.personal', registryPath)).toBe(false);
      expect(clearConnectedHandleReauthRequired('x.bookmarks.personal', join(dir, 'absent.json'))).toBe(false);
    } finally {
      console.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
