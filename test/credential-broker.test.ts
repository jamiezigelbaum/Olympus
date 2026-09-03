import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  CredentialBrokerError,
  StaticCredentialBroker,
  createEnvCredentialBroker,
  safeCredentialSessionAudit,
  type CredentialOAuth2HandleState,
  type CredentialOAuth2StateStore,
} from '../src/workers/credential-broker/index.ts';
import {
  markConnectedHandleReauthRequired,
  repairXLocalOAuthRegistryPosture,
  readConnectedHandleRegistry,
  upsertConnectedHandle,
  type ConnectedCredentialHandle,
} from '../src/workers/credential-broker/connected-handles.ts';
import { sourceFamilyPostureRegistry } from '../src/core/source-family.ts';

describe('Olympus credential broker', () => {
  test('repairs a dual-owned X registry entry only when local OAuth state is account-matched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-local-oauth-registry-repair-'));
    const registryPath = join(dir, 'handles.json');
    const stateStore = new MemoryOAuth2StateStore();
    const handle: ConnectedCredentialHandle = {
      handle: 'x.bookmarks.personal',
      provider: 'x',
      accountRole: 'personal',
      trustDomain: 'internal',
      allowedCapabilities: ['x.bookmarks.sync'],
      scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
      oauth2Refresh: {
        tokenUrl: 'https://api.x.com/2/oauth2/token',
        clientIdSecretRef: 'store:x.personal.oauth.client_id',
        clientSecretSecretRef: 'store:x.personal.oauth.client_secret',
        refreshTokenSecretRef: 'store:x.personal.oauth.refresh_token',
        scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
      },
      connectedAt: '2026-08-27T10:00:00.000Z',
      providerAccountId: '1234567890',
    };
    try {
      upsertConnectedHandle(handle, registryPath);
      await stateStore.save(handle.handle, {
        refreshToken: 'local-state-refresh-token-fixture',
        providerAccountId: '1234567890',
        scopes: handle.scopes,
        status: 'available',
        updatedAt: '2026-08-27T10:01:00.000Z',
      });

      expect(await repairXLocalOAuthRegistryPosture({ registryPath, oauth2StateStore: stateStore }))
        .toBe('repaired');
      const repaired = readConnectedHandleRegistry(registryPath).handles[0]!;
      expect(repaired).toMatchObject({
        handle: handle.handle,
        provider: 'x',
        providerAccountId: handle.providerAccountId,
        allowedCapabilities: ['x.bookmarks.sync'],
      });
      expect(repaired.oauth2Refresh).toBeUndefined();
      expect(repaired.tokenSecretRefs).toBeUndefined();
      expect(await repairXLocalOAuthRegistryPosture({ registryPath, oauth2StateStore: stateStore }))
        .toBe('already_metadata_only');

      await stateStore.save(handle.handle, {
        refreshToken: 'other-refresh-token-fixture',
        providerAccountId: '9999999999',
        status: 'available',
      });
      expect(await repairXLocalOAuthRegistryPosture({ registryPath, oauth2StateStore: stateStore }))
        .toBe('already_metadata_only');
      upsertConnectedHandle(handle, registryPath);
      await expect(repairXLocalOAuthRegistryPosture({ registryPath, oauth2StateStore: stateStore }))
        .rejects.toThrow('account-mismatched');
      expect(readConnectedHandleRegistry(registryPath).handles[0]?.oauth2Refresh).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preserves malformed connected-handle registry entries during unrelated writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-connected-handles-preserve-'));
    const registryPath = join(dir, 'handles.json');
    const malformedEntry: Record<string, unknown> = {
      handle: 'dropbox.malformed',
      provider: 'dropbox',
      connectedAt: '2026-07-08T10:00:00.000Z',
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read'],
      oauth2Refresh: {
        tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
        clientIdSecretRef: 'not-a-store-ref',
        refreshTokenSecretRef: 'store:dropbox.personal.oauth.refresh_token',
      },
      extraPayload: {
        mustSurvive: true,
        ordinal: 7,
      },
    };
    const validHandle: ConnectedCredentialHandle = {
      handle: 'dropbox.personal',
      provider: 'dropbox',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read', 'files.content.read', 'sharing.read'],
      oauth2Refresh: {
        tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
        clientIdSecretRef: 'store:dropbox.personal.oauth.client_id',
        refreshTokenSecretRef: 'store:dropbox.personal.oauth.refresh_token',
        scopes: ['files.metadata.read', 'files.content.read', 'sharing.read'],
      },
      connectedAt: '2026-07-08T10:05:00.000Z',
    };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown, ...args: unknown[]) => {
      warnings.push([message, ...args].map(String).join(' '));
    };

    try {
      writeFileSync(registryPath, JSON.stringify({ version: 1, handles: [malformedEntry] }, null, 2));

      const before = readConnectedHandleRegistry(registryPath);
      expect(before.handles).toEqual([]);
      expect(before.dropped?.length).toBe(1);
      expect(before.dropped?.[0]?.index).toBe(0);
      expect(before.dropped?.[0]?.reason).toBe('invalid_oauth2_refresh');

      const upserted = upsertConnectedHandle(validHandle, registryPath);
      expect(upserted.dropped?.length).toBe(1);
      expect(upserted.dropped?.[0]?.reason).toBe('invalid_oauth2_refresh');
      let disk = JSON.parse(readFileSync(registryPath, 'utf8')) as { handles: unknown[] };
      expect(disk.handles).toContainEqual(malformedEntry);
      expect(JSON.stringify(disk.handles.find((entry) =>
        typeof entry === 'object'
        && entry !== null
        && (entry as { handle?: unknown }).handle === malformedEntry.handle
      ))).toBe(JSON.stringify(malformedEntry));

      expect(markConnectedHandleReauthRequired(
        validHandle.handle,
        registryPath,
        new Date('2026-07-08T10:10:00.000Z'),
      )).toBe(true);
      disk = JSON.parse(readFileSync(registryPath, 'utf8')) as { handles: unknown[] };
      expect(disk.handles).toContainEqual(malformedEntry);

      const after = readConnectedHandleRegistry(registryPath);
      expect(after.handles).toHaveLength(1);
      expect(after.dropped?.length).toBe(1);
      expect(after.dropped?.[0]?.index).toBe(0);
      expect(after.dropped?.[0]?.reason).toBe('invalid_oauth2_refresh');
      expect(after.handles[0]?.backendState).toMatchObject({
        kind: 'oauth2_refresh',
        status: 'reauth_required',
        updatedAt: '2026-07-08T10:10:00.000Z',
      });
      expect(warnings.length).toBeGreaterThanOrEqual(4);
      expect(warnings.every((warning) =>
        warning.includes('Ignoring malformed Olympus connected handle registry entry')
        && warning.includes('invalid_oauth2_refresh')
      )).toBe(true);
    } finally {
      console.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('issues broker-scoped Readwise sessions from a named handle', async () => {
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_READWISE_PERSONAL_TOKEN: 'readwise-token-fixture',
      },
      now: () => new Date('2026-05-19T12:00:00.000Z'),
    });

    const session = await broker.issueSession({
      handle: 'readwise.personal',
      provider: 'readwise',
      capability: 'readwise.sync',
      trustDomain: 'internal',
      purpose: 'Sync Readwise into the S1/internal source index.',
    });
    const audit = safeCredentialSessionAudit(session);

    expect(session).toMatchObject({
      kind: 'bearer_token',
      handle: 'readwise.personal',
      provider: 'readwise',
      capability: 'readwise.sync',
      token: 'readwise-token-fixture',
      expiresAt: '2026-05-19T13:00:00.000Z',
    });
    expect(audit).toEqual({
      handle: 'readwise.personal',
      provider: 'readwise',
      capability: 'readwise.sync',
      accountRole: 'personal',
      trustDomain: 'internal',
      scopes: ['readwise.export:read', 'readwise.reader:read'],
      outcome: 'issued',
      issuedAt: '2026-05-19T12:00:00.000Z',
      expiresAt: '2026-05-19T13:00:00.000Z',
      rawCredentialExposed: false,
    });
    expect(JSON.stringify(audit)).not.toContain('readwise-token-fixture');
  });

  test('accepts legacy Readwise token env only inside the broker compatibility layer', async () => {
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_SOURCE_INDEX_READWISE_TOKEN: 'legacy-token-fixture',
      },
    });

    const session = await broker.issueSession({
      handle: 'readwise.personal',
      provider: 'readwise',
      capability: 'readwise.sync',
      trustDomain: 'internal',
    });

    expect(session.kind).toBe('bearer_token');
    if (session.kind !== 'bearer_token') throw new Error('Expected bearer_token session.');
    expect(session.token).toBe('legacy-token-fixture');
    expect(JSON.stringify(safeCredentialSessionAudit(session))).not.toContain('legacy-token-fixture');
  });

  test('issues S1 X bookmark sessions from the personal handle', async () => {
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_TOKEN: 'x-token-fixture',
      },
      now: () => new Date('2026-05-19T12:00:00.000Z'),
    });

    const session = await broker.issueSession({
      handle: 'x.bookmarks.personal',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      trustDomain: 'internal',
      purpose: 'Sync X bookmark folders into the internal source index.',
    });

    expect(session).toMatchObject({
      kind: 'bearer_token',
      handle: 'x.bookmarks.personal',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      token: 'x-token-fixture',
      expiresAt: '2026-05-19T13:00:00.000Z',
    });
    expect(safeCredentialSessionAudit(session)).toEqual({
      handle: 'x.bookmarks.personal',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      accountRole: 'personal',
      trustDomain: 'internal',
      scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
      outcome: 'issued',
      issuedAt: '2026-05-19T12:00:00.000Z',
      expiresAt: '2026-05-19T13:00:00.000Z',
      rawCredentialExposed: false,
    });
    expect(JSON.stringify(safeCredentialSessionAudit(session))).not.toContain('x-token-fixture');
  });

  test('refreshes X OAuth2 user-context tokens from broker-owned state', async () => {
    const stateStore = new MemoryOAuth2StateStore();
    await stateStore.save('x.bookmarks.personal', {
      refreshToken: 'old-refresh-token-fixture',
      scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
      status: 'available',
    });
    const requests: Array<{ authorization: string | undefined; body: string }> = [];
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_ID: 'x-client-id-fixture',
        OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_SECRET: 'x-client-secret-fixture',
      },
      oauth2StateStore: stateStore,
      oauth2CacheNamespace: 'test-x-refreshes-oauth2',
      now: () => new Date('2026-05-19T12:00:00.000Z'),
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get('Authorization') ?? undefined,
          body: String(init?.body),
        });
        return new Response(JSON.stringify({
          access_token: 'new-access-token-fixture',
          refresh_token: 'new-refresh-token-fixture',
          expires_in: 7200,
          scope: 'tweet.read users.read bookmark.read offline.access',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const session = await broker.issueSession({
      handle: 'x.bookmarks.personal',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      trustDomain: 'internal',
      purpose: 'Sync X bookmark folders into the internal source index.',
    });
    const stored = await stateStore.load('x.bookmarks.personal');

    expect(requests).toEqual([{
      authorization: `Basic ${Buffer.from('x-client-id-fixture:x-client-secret-fixture').toString('base64')}`,
      body: 'grant_type=refresh_token&refresh_token=old-refresh-token-fixture',
    }]);
    expect(session).toMatchObject({
      kind: 'bearer_token',
      handle: 'x.bookmarks.personal',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      token: 'new-access-token-fixture',
      expiresAt: '2026-05-19T14:00:00.000Z',
    });
    expect(stored).toMatchObject({
      refreshToken: 'new-refresh-token-fixture',
      scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
      status: 'available',
      updatedAt: '2026-05-19T12:00:00.000Z',
    });
    expect(JSON.stringify(safeCredentialSessionAudit(session))).not.toContain('new-access-token-fixture');
    expect(JSON.stringify(safeCredentialSessionAudit(session))).not.toContain('new-refresh-token-fixture');
    expect(JSON.stringify(safeCredentialSessionAudit(session))).not.toContain('x-client-secret-fixture');
  });

  test('merges metadata-only connected X identity with default OAuth and shares one refresh across brokers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-metadata-handle-'));
    const registryPath = join(dir, 'handles.json');
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      handles: [{
        handle: 'x.bookmarks.personal',
        provider: 'x',
        accountRole: 'personal',
        trustDomain: 'internal',
        allowedCapabilities: ['x.bookmarks.sync'],
        scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
        connectedAt: '2026-07-18T12:00:00.000Z',
        providerAccountId: '1234567890',
      }],
    }));
    const stateStore = new MemoryOAuth2StateStore();
    await stateStore.save('x.bookmarks.personal', {
      refreshToken: 'metadata-refresh-token-fixture',
      scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
      status: 'available',
    });
    let tokenRequests = 0;
    const options = {
      env: {
        OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_ID: 'metadata-client-id',
        OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_SECRET: 'metadata-client-secret',
      },
      handleRegistryPath: registryPath,
      oauth2StateStore: stateStore,
      oauth2CacheNamespace: 'test-x-metadata-default-merge',
      now: () => new Date('2026-07-18T12:05:00.000Z'),
      fetch: async () => {
        tokenRequests += 1;
        await Bun.sleep(10);
        return new Response(JSON.stringify({
          access_token: 'metadata-access-token-fixture',
          expires_in: 3_600,
          scope: 'tweet.read users.read bookmark.read offline.access',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    };
    const request = {
      handle: 'x.bookmarks.personal',
      provider: 'x' as const,
      capability: 'x.bookmarks.sync',
      trustDomain: 'internal' as const,
    };

    const [first, second] = await Promise.all([
      createEnvCredentialBroker(options).issueSession(request),
      createEnvCredentialBroker(options).issueSession(request),
    ]);
    expect(first).toMatchObject({ kind: 'bearer_token', token: 'metadata-access-token-fixture' });
    expect(second).toMatchObject({ kind: 'bearer_token', token: 'metadata-access-token-fixture' });
    expect(tokenRequests).toBe(1);
  });

  test('reports X OAuth2 reauth when client credentials exist but refresh state is missing', async () => {
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_CLIENT_ID: 'x-client-id-fixture',
      },
      oauth2StateStore: new MemoryOAuth2StateStore(),
    });

    await expect(broker.issueSession({
      handle: 'x.bookmarks.personal',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      trustDomain: 'internal',
    })).rejects.toMatchObject({
      code: 'credential_reauth_required',
      handle: 'x.bookmarks.personal',
      capability: 'x.bookmarks.sync',
    });
    await expect(broker.status?.('x.bookmarks.personal')).resolves.toMatchObject({
      handle: 'x.bookmarks.personal',
      status: 'reauth_required',
      rawCredentialExposed: false,
    });
  });

  test('registers active source-family credential handles without claiming ingestion is live', async () => {
    const broker = createEnvCredentialBroker({ env: {}, oauth2StateStore: new MemoryOAuth2StateStore() });
    const handles = sourceFamilyPostureRegistry
      .list()
      .filter((posture) => posture.status !== 'deferred')
      .flatMap((posture) => posture.credentialHandles ?? []);
    const statuses = await Promise.all(handles.map((handle) => broker.status?.(handle)));

    expect(handles).toEqual([
      'gmail.personal',
      'gmail.business_ocu',
      'dropbox.personal',
      'telegram.personal',
      'whatsapp.business',
      'whatsapp.personal_local',
      'apple_messages.local',
      'x.bookmarks.personal',
      'readwise.personal',
      'google_drive.personal',
      'reflect.archive',
      'roam.archive',
    ]);
    expect(statuses.map((status) => status?.handle)).toEqual(handles);
    expect(statuses.every((status) => status?.status === 'missing')).toBe(true);
    expect(statuses.every((status) => status?.rawCredentialExposed === false)).toBe(true);
    expect(JSON.stringify(statuses)).not.toContain('OLYMPUS_CREDENTIAL');
  });

  test('models Dropbox as an Olympus-owned OAuth lane while preserving secure-local posture', async () => {
    const requests: Array<{ authorization: string | undefined; body: string }> = [];
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_KEY: 'dropbox-app-key-fixture',
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_SECRET: 'dropbox-app-secret-fixture',
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_REFRESH_TOKEN: 'dropbox-refresh-token-fixture',
      },
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      oauth2CacheNamespace: 'test-dropbox-models-oauth-lane',
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get('Authorization') ?? undefined,
          body: String(init?.body),
        });
        return new Response(JSON.stringify({
          access_token: 'dropbox-access-token-fixture',
          expires_in: 14400,
          scope: 'files.metadata.read files.content.read sharing.read',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const status = await broker.status?.('dropbox.personal');
    const session = await broker.issueSession({
      handle: 'dropbox.personal',
      provider: 'dropbox',
      capability: 'dropbox.files.sync',
      trustDomain: 'secure_local',
      purpose: 'Sync approved Dropbox file metadata and selected content packets.',
    });

    expect(status).toMatchObject({
      handle: 'dropbox.personal',
      provider: 'dropbox',
      sessionKind: 'bearer_token',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      capabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read', 'files.content.read', 'sharing.read'],
      status: 'available',
      rawCredentialExposed: false,
    });
    expect(requests).toEqual([{
      authorization: `Basic ${Buffer.from('dropbox-app-key-fixture:dropbox-app-secret-fixture').toString('base64')}`,
      body: 'grant_type=refresh_token&refresh_token=dropbox-refresh-token-fixture',
    }]);
    expect(session).toMatchObject({
      kind: 'bearer_token',
      handle: 'dropbox.personal',
      provider: 'dropbox',
      capability: 'dropbox.files.sync',
      token: 'dropbox-access-token-fixture',
      expiresAt: '2026-05-20T16:00:00.000Z',
    });
    expect(safeCredentialSessionAudit(session)).toMatchObject({
      handle: 'dropbox.personal',
      provider: 'dropbox',
      capability: 'dropbox.files.sync',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      scopes: ['files.metadata.read', 'files.content.read', 'sharing.read'],
      rawCredentialExposed: false,
    });
    expect(JSON.stringify(safeCredentialSessionAudit(session))).not.toContain('dropbox-access-token-fixture');
    expect(JSON.stringify(safeCredentialSessionAudit(session))).not.toContain('dropbox-refresh-token-fixture');
    expect(JSON.stringify(safeCredentialSessionAudit(session))).not.toContain('dropbox-app-secret-fixture');
  });

  test('coalesces concurrent OAuth2 refreshes and reuses unexpired access tokens', async () => {
    let refreshCalls = 0;
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_KEY: 'dropbox-app-key-fixture',
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_SECRET: 'dropbox-app-secret-fixture',
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_REFRESH_TOKEN: 'dropbox-refresh-token-fixture',
      },
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      oauth2CacheNamespace: 'test-dropbox-coalesces-one-broker',
      fetch: async () => {
        refreshCalls += 1;
        await Promise.resolve();
        return new Response(JSON.stringify({
          access_token: `dropbox-access-token-fixture-${refreshCalls}`,
          expires_in: 14400,
          scope: 'files.metadata.read files.content.read sharing.read',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const [first, second] = await Promise.all([
      broker.issueSession({
        handle: 'dropbox.personal',
        provider: 'dropbox',
        capability: 'dropbox.files.sync',
        trustDomain: 'secure_local',
      }),
      broker.issueSession({
        handle: 'dropbox.personal',
        provider: 'dropbox',
        capability: 'dropbox.files.sync',
        trustDomain: 'secure_local',
      }),
    ]);
    const third = await broker.issueSession({
      handle: 'dropbox.personal',
      provider: 'dropbox',
      capability: 'dropbox.files.sync',
      trustDomain: 'secure_local',
    });

    expect(refreshCalls).toBe(1);
    expect(first).toMatchObject({ kind: 'bearer_token', token: 'dropbox-access-token-fixture-1' });
    expect(second).toMatchObject({ kind: 'bearer_token', token: 'dropbox-access-token-fixture-1' });
    expect(third).toMatchObject({ kind: 'bearer_token', token: 'dropbox-access-token-fixture-1' });
  });

  test('shares OAuth2 refresh cache across broker instances in one worker process', async () => {
    let refreshCalls = 0;
    const env = {
      OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_KEY: 'dropbox-app-key-fixture',
      OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_SECRET: 'dropbox-app-secret-fixture',
      OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_REFRESH_TOKEN: 'dropbox-refresh-token-fixture',
    };
    const fetch = async () => {
      refreshCalls += 1;
      await Promise.resolve();
      return new Response(JSON.stringify({
        access_token: `dropbox-access-token-fixture-${refreshCalls}`,
        expires_in: 14400,
        scope: 'files.metadata.read files.content.read sharing.read',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const options = {
      env,
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      oauth2CacheNamespace: 'test-dropbox-cross-broker-process-cache',
      fetch,
    };
    const firstBroker = createEnvCredentialBroker(options);
    const secondBroker = createEnvCredentialBroker(options);

    const request = {
      handle: 'dropbox.personal',
      provider: 'dropbox' as const,
      capability: 'dropbox.files.sync',
      trustDomain: 'secure_local' as const,
    };
    const [first, second] = await Promise.all([
      firstBroker.issueSession(request),
      secondBroker.issueSession(request),
    ]);
    const third = await createEnvCredentialBroker(options).issueSession(request);

    expect(refreshCalls).toBe(1);
    expect(first).toMatchObject({ kind: 'bearer_token', token: 'dropbox-access-token-fixture-1' });
    expect(second).toMatchObject({ kind: 'bearer_token', token: 'dropbox-access-token-fixture-1' });
    expect(third).toMatchObject({ kind: 'bearer_token', token: 'dropbox-access-token-fixture-1' });
  });

  test('backs off repeated OAuth2 refresh failures without stampeding the provider', async () => {
    let refreshCalls = 0;
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_KEY: 'dropbox-app-key-fixture',
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_SECRET: 'dropbox-app-secret-fixture',
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_REFRESH_TOKEN: 'dropbox-refresh-token-fixture',
      },
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      oauth2CacheNamespace: 'test-dropbox-refresh-failure-backoff',
      oauth2RefreshFailureBackoffMs: 60_000,
      fetch: async () => {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          error: 'too_many_requests',
          error_description: 'rate limited',
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const request = {
      handle: 'dropbox.personal',
      provider: 'dropbox' as const,
      capability: 'dropbox.files.sync',
      trustDomain: 'secure_local' as const,
    };

    await expect(broker.issueSession(request)).rejects.toMatchObject({
      code: 'credential_refresh_failed',
      handle: 'dropbox.personal',
    });
    await expect(broker.issueSession(request)).rejects.toMatchObject({
      code: 'credential_refresh_failed',
      handle: 'dropbox.personal',
    });
    expect(refreshCalls).toBe(1);
  });

  test('redacts encoded OAuth2 refresh secrets from provider failures', async () => {
    const clientId = 'dropbox-app-key-fixture';
    const clientSecret = 'dropbox-app-secret-fixture';
    const refreshToken = 'dropbox-refresh-token-fixture/with+chars=';
    const reflectedBasic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const reflectedRefreshBase64Url = Buffer.from(refreshToken).toString('base64url');
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_KEY: clientId,
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_APP_SECRET: clientSecret,
        OLYMPUS_CREDENTIAL_DROPBOX_PERSONAL_REFRESH_TOKEN: refreshToken,
      },
      oauth2CacheNamespace: 'test-dropbox-refresh-redacts-encoded-errors',
      fetch: async () => new Response(JSON.stringify({
        error: 'temporarily_unavailable',
        error_description: [
          `raw=${refreshToken}`,
          `encoded=${encodeURIComponent(refreshToken)}`,
          `basic=${reflectedBasic}`,
          `token64=${reflectedRefreshBase64Url}`,
        ].join(' '),
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
    });

    let thrown: unknown;
    try {
      await broker.issueSession({
        handle: 'dropbox.personal',
        provider: 'dropbox',
        capability: 'dropbox.files.sync',
        trustDomain: 'secure_local',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CredentialBrokerError);
    const message = String(thrown);
    const serialized = JSON.stringify(thrown);
    for (const secret of [
      clientSecret,
      refreshToken,
      encodeURIComponent(refreshToken),
      reflectedBasic,
      reflectedRefreshBase64Url,
    ]) {
      expect(message).not.toContain(secret);
      expect(serialized).not.toContain(secret);
    }
    expect(message).toContain('[redacted]');
  });

  test('issues typed non-bearer session descriptors without exposing backend secrets', async () => {
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_TELEGRAM_PERSONAL_MTPROTO_SESSION_READY: 'true',
        OLYMPUS_CREDENTIAL_APPLE_MESSAGES_LOCAL_DB_READY: 'true',
        OLYMPUS_CREDENTIAL_REFLECT_ARCHIVE_READY: 'true',
        OLYMPUS_CREDENTIAL_WHATSAPP_PERSONAL_LOCAL_DB_READY: 'true',
        OLYMPUS_CREDENTIAL_WHATSAPP_BUSINESS_RUNTIME_READY: 'true',
      },
      now: () => new Date('2026-05-20T12:00:00.000Z'),
    });

    await expect(broker.status?.('telegram.personal')).resolves.toMatchObject({
      handle: 'telegram.personal',
      provider: 'telegram',
      sessionKind: 'mtproto_session',
      status: 'available',
      rawCredentialExposed: false,
    });
    const telegram = await broker.issueSession({
      handle: 'telegram.personal',
      provider: 'telegram',
      capability: 'telegram.messages.sync',
      trustDomain: 'secure_local',
    });
    const appleMessages = await broker.issueSession({
      handle: 'apple_messages.local',
      provider: 'apple_messages',
      capability: 'apple_messages.messages.sync',
      trustDomain: 'secure_local',
    });
    const whatsappLocal = await broker.issueSession({
      handle: 'whatsapp.personal_local',
      provider: 'whatsapp_personal',
      capability: 'whatsapp.personal.messages.sync',
      trustDomain: 'secure_local',
    });
    const reflectArchive = await broker.issueSession({
      handle: 'reflect.archive',
      provider: 'reflect',
      capability: 'reflect.archive.import',
      trustDomain: 'internal',
    });
    const whatsappBusiness = await broker.issueSession({
      handle: 'whatsapp.business',
      provider: 'whatsapp_business',
      capability: 'whatsapp.business.messages.sync',
      trustDomain: 'secure_local',
    });
    expect(telegram).toMatchObject({
      kind: 'mtproto_session',
      mtprotoProfileId: 'telegram_personal',
      runtimeEndpointId: 'telegram_local_telethon_reader',
      library: 'telethon',
      leaseId: 'telegram_personal_mtproto_readonly_lease',
      expiresAt: '2026-05-20T13:00:00.000Z',
      backendLabel: 'local_private:telegram_telethon_reader',
    });
    expect(appleMessages).toMatchObject({
      kind: 'local_app_database',
      databaseSourceId: 'apple_messages_local',
      readerWorker: 'apple_messages_reader',
      databaseRole: 'messages_readonly',
      scopeLabel: 'local_messages',
    });
    expect(whatsappLocal).toMatchObject({
      kind: 'local_app_database',
      databaseSourceId: 'whatsapp_personal_local',
      readerWorker: 'whatsapp_local_reader',
      databaseRole: 'messages_readonly',
    });
    expect(reflectArchive).toMatchObject({
      kind: 'archive_path',
      archiveRootAlias: 'reflect_archive',
      readerWorker: 'archive_import_reader',
      contentBounds: 'approved_archive_root',
    });
    expect(whatsappBusiness).toMatchObject({
      kind: 'webhook_token',
      webhookIntegrationId: 'twilio_whatsapp_business',
      validationMode: 'broker_verified_event',
      verifierReference: 'twilio_whatsapp_business_verifier',
      backendLabel: 'twilio:whatsapp_business_gateway',
    });
    const serialized = JSON.stringify([
      telegram,
      appleMessages,
      whatsappLocal,
      reflectArchive,
      whatsappBusiness,
      safeCredentialSessionAudit(telegram),
      safeCredentialSessionAudit(appleMessages),
      safeCredentialSessionAudit(reflectArchive),
    ]);
    expect(serialized).not.toContain('OLYMPUS_CREDENTIAL');
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('.sqlite');
    expect(serialized).not.toContain('.db');
    expect(serialized).not.toContain('token-fixture');
    expect(serialized).not.toContain('secret');
  });

  test('non-bearer backend state fails closed when missing, reauth-required, or unsafe', async () => {
    const missingBroker = createEnvCredentialBroker({ env: {} });
    await expect(missingBroker.issueSession({
      handle: 'telegram.personal',
      provider: 'telegram',
      capability: 'telegram.messages.sync',
      trustDomain: 'secure_local',
    })).rejects.toMatchObject({
      code: 'credential_missing',
      handle: 'telegram.personal',
      capability: 'telegram.messages.sync',
    });

    const reauthBroker = createEnvCredentialBroker({
      env: {},
      backendStates: {
        'telegram.personal': {
          kind: 'mtproto_session',
          status: 'reauth_required',
          mtprotoProfileId: 'telegram_personal',
          runtimeEndpointId: 'telegram_local_telethon_reader',
        },
      },
    });
    await expect(reauthBroker.status?.('telegram.personal')).resolves.toMatchObject({
      status: 'reauth_required',
      rawCredentialExposed: false,
    });
    await expect(reauthBroker.issueSession({
      handle: 'telegram.personal',
      provider: 'telegram',
      capability: 'telegram.messages.sync',
      trustDomain: 'secure_local',
    })).rejects.toMatchObject({
      code: 'credential_reauth_required',
      handle: 'telegram.personal',
      capability: 'telegram.messages.sync',
    });

    const unsafeBroker = createEnvCredentialBroker({
      env: {},
      backendStates: {
        'reflect.archive': {
          kind: 'archive_path',
          archiveRootAlias: '/Users/owner/private/Reflect',
          readerWorker: 'archive_import_reader',
        },
      },
    });
    await expect(unsafeBroker.issueSession({
      handle: 'reflect.archive',
      provider: 'reflect',
      capability: 'reflect.archive.import',
      trustDomain: 'internal',
    })).rejects.toMatchObject({
      code: 'credential_backend_malformed',
      handle: 'reflect.archive',
    });

    try {
      await unsafeBroker.issueSession({
        handle: 'reflect.archive',
        provider: 'reflect',
        capability: 'reflect.archive.import',
        trustDomain: 'internal',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialBrokerError);
      expect(String(error)).not.toContain('/Users/owner/private/Reflect');
    }
  });

  test('fails closed for missing handles and disallowed capabilities', async () => {
    const broker = createEnvCredentialBroker({ env: {} });

    await expect(broker.issueSession({
      handle: 'x.bookmarks.unknown',
      provider: 'x',
      capability: 'x.bookmarks.read',
      trustDomain: 'internal',
    })).rejects.toMatchObject({
      code: 'credential_handle_not_registered',
      handle: 'x.bookmarks.unknown',
    });

    await expect(broker.issueSession({
      handle: 'x.bookmarks.personal',
      provider: 'x',
      capability: 'x.bookmarks.write',
      trustDomain: 'internal',
    })).rejects.toMatchObject({
      code: 'credential_capability_not_allowed',
      handle: 'x.bookmarks.personal',
      capability: 'x.bookmarks.write',
    });
  });

  test('reports missing credentials without exposing env names or values', async () => {
    const broker = createEnvCredentialBroker({ env: {} });

    await expect(broker.issueSession({
      handle: 'readwise.personal',
      provider: 'readwise',
      capability: 'readwise.sync',
      trustDomain: 'internal',
    })).rejects.toMatchObject({
      code: 'credential_missing',
      handle: 'readwise.personal',
      capability: 'readwise.sync',
    });

    try {
      await broker.issueSession({
        handle: 'readwise.personal',
        provider: 'readwise',
        capability: 'readwise.sync',
        trustDomain: 'internal',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialBrokerError);
      expect(String(error)).not.toContain('OLYMPUS_SOURCE_INDEX_READWISE_TOKEN');
      expect(String(error)).not.toContain('READWISE_TOKEN');
    }
  });

  test('static broker supports deterministic adapter tests', async () => {
    const broker = new StaticCredentialBroker([{
      handle: 'readwise.test',
      provider: 'readwise',
      allowedCapabilities: ['readwise.sync'],
      token: 'static-token-fixture',
      scopes: ['readwise.reader:read'],
      trustDomain: 'internal',
    }]);

    const status = await broker.status?.('readwise.test');
    const session = await broker.issueSession({
      handle: 'readwise.test',
      provider: 'readwise',
      capability: 'readwise.sync',
      trustDomain: 'internal',
    });

    expect(status).toMatchObject({
      handle: 'readwise.test',
      provider: 'readwise',
      status: 'available',
      rawCredentialExposed: false,
    });
    expect(session.kind).toBe('bearer_token');
    if (session.kind !== 'bearer_token') throw new Error('Expected bearer_token session.');
    expect(session.token).toBe('static-token-fixture');
  });

  test('static broker supports deterministic non-bearer adapter tests', async () => {
    const broker = new StaticCredentialBroker([{
      handle: 'reflect.test',
      provider: 'reflect',
      sessionKind: 'archive_path',
      allowedCapabilities: ['reflect.archive.import'],
      trustDomain: 'internal',
      accountRole: 'archive',
      backendState: {
        kind: 'archive_path',
        archiveRootAlias: 'reflect_test_archive',
        readerWorker: 'archive_import_reader',
        importRunId: 'test_import_run',
        backendLabel: 'local_private:archive_import',
      },
    }], {
      now: () => new Date('2026-05-20T12:00:00.000Z'),
    });

    const status = await broker.status?.('reflect.test');
    const session = await broker.issueSession({
      handle: 'reflect.test',
      provider: 'reflect',
      capability: 'reflect.archive.import',
      trustDomain: 'internal',
    });

    expect(status).toMatchObject({
      handle: 'reflect.test',
      provider: 'reflect',
      sessionKind: 'archive_path',
      status: 'available',
      rawCredentialExposed: false,
    });
    expect(session).toMatchObject({
      kind: 'archive_path',
      archiveRootAlias: 'reflect_test_archive',
      readerWorker: 'archive_import_reader',
      importRunId: 'test_import_run',
      audit: {
        handle: 'reflect.test',
        provider: 'reflect',
        capability: 'reflect.archive.import',
        accountRole: 'archive',
        trustDomain: 'internal',
        scopes: [],
        outcome: 'issued',
        issuedAt: '2026-05-20T12:00:00.000Z',
        backendLabel: 'local_private:archive_import',
        rawCredentialExposed: false,
      },
    });
    expect(JSON.stringify(session)).not.toContain('/Users/');
    expect(JSON.stringify(session)).not.toContain('OLYMPUS_CREDENTIAL');
  });

  test('models direct-OAuth Gmail and Drive as bearer handles fed only by environment', async () => {
    const broker = createEnvCredentialBroker({
      env: {
        OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_CLIENT_ID: 'google-client-id-fixture',
        OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_CLIENT_SECRET: 'google-client-secret-fixture',
        OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_REFRESH_TOKEN: 'google-refresh-token-fixture',
      },
      oauth2StateStore: new MemoryOAuth2StateStore(),
      now: () => new Date('2026-07-28T12:00:00.000Z'),
    });

    const gmailStatus = await broker.status?.('gmail.personal.direct');
    const driveStatus = await broker.status?.('google_drive.personal');

    expect(gmailStatus).toMatchObject({
      handle: 'gmail.personal.direct',
      provider: 'gmail',
      sessionKind: 'bearer_token',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      capabilities: ['gmail.email.sync'],
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      status: 'available',
      rawCredentialExposed: false,
    });
    expect(driveStatus).toMatchObject({
      handle: 'google_drive.personal',
      provider: 'google_drive',
      sessionKind: 'bearer_token',
      accountRole: 'personal',
      trustDomain: 'internal',
      capabilities: ['google_drive.docs.sync'],
      // drive.readonly alone: document text comes from the Drive export
      // endpoint, so documents.readonly was never exercised.
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      status: 'available',
      rawCredentialExposed: false,
    });
    expect(JSON.stringify([gmailStatus, driveStatus])).not.toContain('google-refresh-token-fixture');
    expect(JSON.stringify([gmailStatus, driveStatus])).not.toContain('google-client-secret-fixture');
  });

  test('merges bare Gmail and Drive registry entries into the direct-OAuth defaults', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-google-direct-handles-'));
    const registryPath = join(dir, 'handles.json');
    try {
      writeFileSync(registryPath, JSON.stringify({
        version: 1,
        handles: [
          {
            handle: 'gmail.personal.direct',
            provider: 'gmail',
            accountRole: 'personal',
            trustDomain: 'secure_local',
            allowedCapabilities: ['gmail.email.sync'],
            scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            connectedAt: '2026-07-28T10:00:00.000Z',
          },
          {
            handle: 'google_drive.personal',
            provider: 'google_drive',
            accountRole: 'personal',
            trustDomain: 'internal',
            allowedCapabilities: ['google_drive.docs.sync'],
            scopes: [
              'https://www.googleapis.com/auth/drive.readonly',
            ],
            connectedAt: '2026-07-28T10:00:00.000Z',
          },
        ],
      }));
      const requests: Array<{ url: string; authorization: string | undefined; body: string }> = [];
      const brokerOptions = {
        env: {
          OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_CLIENT_ID: 'google-client-id-fixture',
          OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_CLIENT_SECRET: 'google-client-secret-fixture',
          OLYMPUS_CREDENTIAL_GOOGLE_CASTOR_OAUTH2_REFRESH_TOKEN: 'google-refresh-token-fixture',
        },
        handleRegistryPath: registryPath,
        oauth2StateStore: new MemoryOAuth2StateStore(),
        now: () => new Date('2026-07-28T12:00:00.000Z'),
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          requests.push({
            url: String(input),
            authorization: headers.get('Authorization') ?? undefined,
            body: String(init?.body),
          });
          return new Response(JSON.stringify({
            access_token: `google-access-token-${requests.length}`,
            expires_in: 3_600,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
      };

      const gmailSession = await createEnvCredentialBroker({
        ...brokerOptions,
        oauth2CacheNamespace: 'test-google-direct-gmail-merge',
      }).issueSession({
        handle: 'gmail.personal.direct',
        provider: 'gmail',
        capability: 'gmail.email.sync',
        trustDomain: 'secure_local',
      });
      const driveSession = await createEnvCredentialBroker({
        ...brokerOptions,
        oauth2CacheNamespace: 'test-google-direct-drive-merge',
      }).issueSession({
        handle: 'google_drive.personal',
        provider: 'google_drive',
        capability: 'google_drive.docs.sync',
        trustDomain: 'internal',
      });

      expect(gmailSession).toMatchObject({
        kind: 'bearer_token',
        handle: 'gmail.personal.direct',
        provider: 'gmail',
        capability: 'gmail.email.sync',
        token: 'google-access-token-1',
        expiresAt: '2026-07-28T13:00:00.000Z',
      });
      expect(driveSession).toMatchObject({
        kind: 'bearer_token',
        handle: 'google_drive.personal',
        provider: 'google_drive',
        capability: 'google_drive.docs.sync',
        token: 'google-access-token-2',
      });
      expect(requests).toEqual([
        {
          url: 'https://oauth2.googleapis.com/token',
          authorization: `Basic ${Buffer.from('google-client-id-fixture:google-client-secret-fixture').toString('base64')}`,
          body: 'grant_type=refresh_token&refresh_token=google-refresh-token-fixture',
        },
        {
          url: 'https://oauth2.googleapis.com/token',
          authorization: `Basic ${Buffer.from('google-client-id-fixture:google-client-secret-fixture').toString('base64')}`,
          body: 'grant_type=refresh_token&refresh_token=google-refresh-token-fixture',
        },
      ]);
      expect(JSON.stringify(safeCredentialSessionAudit(gmailSession))).not.toContain('google-refresh-token-fixture');
      expect(JSON.stringify(safeCredentialSessionAudit(driveSession))).not.toContain('google-client-secret-fixture');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports direct-OAuth Google handles as missing when the wrapper exported nothing', async () => {
    const broker = createEnvCredentialBroker({ env: {}, oauth2StateStore: new MemoryOAuth2StateStore() });

    await expect(broker.status?.('gmail.personal.direct')).resolves.toMatchObject({
      handle: 'gmail.personal.direct',
      status: 'missing',
    });
    await expect(broker.status?.('google_drive.personal')).resolves.toMatchObject({
      handle: 'google_drive.personal',
      status: 'missing',
    });
  });
});

class MemoryOAuth2StateStore implements CredentialOAuth2StateStore {
  private readonly states = new Map<string, CredentialOAuth2HandleState>();

  async load(handle: string): Promise<CredentialOAuth2HandleState | undefined> {
    return this.states.get(handle);
  }

  async save(handle: string, state: CredentialOAuth2HandleState): Promise<void> {
    this.states.set(handle, {
      ...this.states.get(handle),
      ...state,
    });
  }
}
