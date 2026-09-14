import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { defaultConfig, loadConfig } from '../src/core/config.ts';
import {
  createEnvCredentialBroker,
  type CredentialOAuth2HandleState,
} from '../src/workers/credential-broker/index.ts';

const temporaryRoots: string[] = [];
afterAll(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('public runtime', () => {
  test('default config contains only public runtime sections and loads without a config file', () => {
    const defaults = defaultConfig();

    expect(defaults).not.toHaveProperty('fileDelivery');
    expect(defaults).not.toHaveProperty('castorWorkspace');
    expect(defaults).not.toHaveProperty('domainExpert');

    const loaded = loadConfig({
      OLYMPUS_CONFIG: join(tmpdir(), `olympus-public-runtime-config-absent-${process.pid}.json`),
    });
    expect(loaded).toEqual(defaults);
  });

  test('mints an OAuth2 bearer session through the direct public broker runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-public-runtime-oauth2-'));
    temporaryRoots.push(root);
    const registryPath = join(root, 'handles.json');
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

    const states = new Map<string, CredentialOAuth2HandleState>([
      ['x.bookmarks.personal', {
        refreshToken: 'refresh-token-generation-1',
        status: 'available',
      }],
    ]);
    let refreshCalls = 0;
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_ID: 'x-client-id-fixture',
        OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_SECRET: 'x-client-secret-fixture',
      },
      handleRegistryPath: registryPath,
      oauth2StateStore: {
        load: async (handle: string) => states.get(handle),
        save: async (handle: string, state: CredentialOAuth2HandleState) => {
          states.set(handle, { ...states.get(handle), ...state });
        },
      },
      oauth2CacheNamespace: `direct-public-runtime-oauth2-${root}`,
      now: () => new Date('2026-08-18T12:00:00.000Z'),
      fetch: async () => {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          access_token: 'access-token-generation-2',
          expires_in: 7200,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const session = await broker.issueSession({
      handle: 'x.bookmarks.personal',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      trustDomain: 'internal',
    });

    expect(session).toMatchObject({
      kind: 'bearer_token',
      handle: 'x.bookmarks.personal',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      token: 'access-token-generation-2',
      expiresAt: '2026-08-18T14:00:00.000Z',
    });
    expect(refreshCalls).toBe(1);
    expect(states.get('x.bookmarks.personal')).toMatchObject({
      refreshToken: 'refresh-token-generation-1',
      status: 'available',
      pendingRefreshStartedAt: undefined,
      updatedAt: '2026-08-18T12:00:00.000Z',
    });
  });
});
