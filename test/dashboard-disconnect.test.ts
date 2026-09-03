import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import type { CredentialOAuth2StateStore } from '../src/workers/credential-broker/index.ts';
import {
  connectApiKeySource,
  startExternalOAuthSourceConnection,
} from '../src/core/connect.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  readConnectedHandleRegistry,
  upsertConnectedHandle,
  writeConnectedHandleRegistry,
  type ConnectedHandleRegistry,
} from '../src/workers/credential-broker/connected-handles.ts';

describe('bounded dashboard Disconnect', () => {
  test('removes one shared account grant, stops reads, refreshes scheduling, and retains app registration and data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-disconnect-'));
    const registryPath = join(root, 'handles.json');
    const refreshRef = 'store:google.personal.oauth.refresh_token';
    const registry = googleSharedRegistry(refreshRef);
    writeConnectedHandleRegistry(registry, registryPath);
    const secrets = memorySecretStore({
      'google.personal.oauth.client_id': 'client-id',
      'google.personal.oauth.client_secret': 'client-secret',
      'google.personal.oauth.refresh_token': 'refresh-token',
    });
    const schedulerUpdates: unknown[][] = [];
    const manualReads: unknown[] = [];
    const worker = createEmailSourceWorker({
      sourceScheduler: {
        status: () => ({ enabled: true, running: false, sources: [] }),
        updateSources: (sources: unknown[]) => schedulerUpdates.push(sources),
      } as never,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        // No adoption tick in this suite: it does not exercise registry
        // adoption, and an unclosed worker would leave one ticking.
        registryAdoptionIntervalMs: 0,
        refreshSchedulerSources: () => [],
        triggerSourceSync: async (request) => {
          manualReads.push(request);
          return { ok: true };
        },
      },
    });
    try {
      const response = await worker.fetch(jsonRequest('/dashboard/disconnect', {
        source_id: 'gmail.email',
        acknowledge: true,
      }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        source_id: 'gmail.email',
        disconnected_source_ids: ['gmail.email', 'google_drive.docs'],
        removed_handles: ['gmail.personal', 'google_drive.personal'],
        scheduling_refreshed: true,
        policy: {
          scheduled_reads_stopped: true,
          manual_reads_stopped: true,
          indexed_data_deleted: false,
          developer_app_registration_retained: true,
          provider_grant_revoked: false,
          restart_required: false,
        },
      });
      expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);
      expect(await secrets.get('google.personal.oauth.refresh_token')).toBeUndefined();
      expect(await secrets.get('google.personal.oauth.client_id')).toBe('client-id');
      expect(await secrets.get('google.personal.oauth.client_secret')).toBe('client-secret');
      expect(schedulerUpdates).toEqual([[]]);

      const manual = await worker.fetch(jsonRequest('/dashboard/sync-now', { source: 'gmail' }));
      expect(manual.status).toBe(409);
      await expect(manual.json()).resolves.toMatchObject({ error: { code: 'source_disconnected' } });
      expect(manualReads).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires explicit retention/revocation acknowledgement before mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-disconnect-confirm-'));
    const registryPath = join(root, 'handles.json');
    writeConnectedHandleRegistry(googleSharedRegistry('store:google.personal.oauth.refresh_token'), registryPath);
    const secrets = memorySecretStore({ 'google.personal.oauth.refresh_token': 'refresh-token' });
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
      },
    });
    try {
      const response = await worker.fetch(jsonRequest('/dashboard/disconnect', {
        source_id: 'gmail.email',
      }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'disconnect_confirmation_required' },
      });
      expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(2);
      expect(await secrets.get('google.personal.oauth.refresh_token')).toBe('refresh-token');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('connect and Disconnect fail closed on duplicate personal handles without account ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-cardinality-'));
    const registryPath = join(root, 'handles.json');
    const registry = googleSharedRegistry('store:google.personal.oauth.refresh_token');
    registry.handles.push({
      ...registry.handles[0]!,
      handle: 'gmail.personal.legacy',
      accountRole: 'personal',
      oauth2Refresh: {
        ...registry.handles[0]!.oauth2Refresh!,
        refreshTokenSecretRef: 'store:gmail.personal.legacy.oauth.refresh_token',
      },
    });
    writeConnectedHandleRegistry(registry, registryPath);
    const secrets = memorySecretStore({
      'gmail.personal.oauth.client_id': 'client-id',
      'gmail.personal.oauth.client_secret': 'client-secret',
      'google.personal.oauth.refresh_token': 'refresh-token',
      'gmail.personal.legacy.oauth.refresh_token': 'legacy-refresh-token',
    });
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
      },
    });
    try {
      const response = await worker.fetch(jsonRequest('/dashboard/connect/oauth/start', {
        source: 'gmail',
      }));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'dashboard_account_cardinality_violation' },
      });

      const disconnect = await worker.fetch(jsonRequest('/dashboard/disconnect', {
        source_id: 'gmail.email',
        acknowledge: true,
      }));
      expect(disconnect.status).toBe(409);
      await expect(disconnect.json()).resolves.toMatchObject({
        error: { code: 'dashboard_account_cardinality_violation' },
      });
      expect(readConnectedHandleRegistry(registryPath).handles).toHaveLength(3);
      expect(await secrets.get('google.personal.oauth.refresh_token')).toBe('refresh-token');
      expect(await secrets.get('gmail.personal.legacy.oauth.refresh_token')).toBe('legacy-refresh-token');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes a metadata-only X grant from the local rotating-token state store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-disconnect-x-'));
    const registryPath = join(root, 'handles.json');
    writeConnectedHandleRegistry({
      version: 1,
      handles: [{
        handle: 'x.bookmarks.personal',
        provider: 'x',
        accountRole: 'personal',
        trustDomain: 'internal',
        allowedCapabilities: ['x.bookmarks.sync'],
        scopes: ['bookmark.read'],
        connectedAt: '2026-08-30T10:00:00.000Z',
        providerAccountId: '12345',
      }],
    }, registryPath);
    const removed: string[] = [];
    const oauth2StateStore: CredentialOAuth2StateStore = {
      load: async () => ({ refreshToken: 'not-returned', scopes: ['bookmark.read'], status: 'available' }),
      save: async () => {},
      delete: async (handle) => { removed.push(handle); },
    };
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
        oauth2StateStore,
      },
    });
    try {
      const response = await worker.fetch(jsonRequest('/dashboard/disconnect', {
        source_id: 'x.bookmarks',
        acknowledge: true,
      }));
      expect(response.status).toBe(200);
      expect(removed).toEqual(['x.bookmarks.personal']);
      expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes the encrypted session-path grant from a legacy guided-session handle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-disconnect-session-'));
    const registryPath = join(root, 'handles.json');
    writeConnectedHandleRegistry({
      version: 1,
      handles: [{
        handle: 'telegram.personal',
        provider: 'telegram',
        sessionKind: 'mtproto_session',
        accountRole: 'personal',
        trustDomain: 'secure_local',
        allowedCapabilities: ['telegram.messages.sync'],
        scopes: [],
        connectedAt: '2026-08-30T10:00:00.000Z',
      }],
    }, registryPath);
    const secrets = memorySecretStore({
      'telegram.personal.session_path': '/private/local/session',
    });
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
      },
    });
    try {
      const response = await worker.fetch(jsonRequest('/dashboard/disconnect', {
        source_id: 'telegram.messages',
        acknowledge: true,
      }));
      expect(response.status).toBe(200);
      expect(await secrets.get('telegram.personal.session_path')).toBeUndefined();
      expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('serializes reconnect behind Disconnect so a successful reconnect cannot be deleted by a stale plan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-disconnect-race-'));
    const registryPath = join(root, 'handles.json');
    upsertConnectedHandle({
      handle: 'readwise.personal',
      provider: 'readwise',
      accountRole: 'personal',
      trustDomain: 'internal',
      allowedCapabilities: ['readwise.sync'],
      scopes: ['readwise.export:read', 'readwise.reader:read'],
      tokenSecretRefs: ['store:readwise.personal.token'],
      connectedAt: '2026-08-30T10:00:00.000Z',
    }, registryPath);

    const values = new Map([['readwise.personal.token', 'old-token']]);
    let releaseDelete!: () => void;
    const deleteRelease = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let markDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { markDeleteStarted = resolve; });
    let reconnectStarted = false;
    const secrets: SecretStore = {
      label: 'deferred-memory',
      get: async (key) => values.get(key),
      getSync: (key) => values.get(key),
      set: async (key, value) => { values.set(key, value); },
      delete: async (key) => {
        markDeleteStarted();
        await deleteRelease;
        values.delete(key);
      },
      list: async () => [...values.keys()].sort(),
    };
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        connectApiKey: async (options) => {
          reconnectStarted = true;
          await options.secretStore!.set('readwise.personal.token', options.apiKey);
          upsertConnectedHandle({
            handle: 'readwise.personal',
            provider: 'readwise',
            accountRole: 'personal',
            trustDomain: 'internal',
            allowedCapabilities: ['readwise.sync'],
            scopes: ['readwise.export:read', 'readwise.reader:read'],
            tokenSecretRefs: ['store:readwise.personal.token'],
            connectedAt: '2026-08-30T10:01:00.000Z',
          }, options.registryPath);
          return {
            ok: true,
            source: options.source,
            handles: ['readwise.personal'],
            registryPath: options.registryPath!,
            secretRefs: ['store:readwise.personal.token'],
          };
        },
      },
    });
    try {
      const disconnect = worker.fetch(jsonRequest('/dashboard/disconnect', {
        source_id: 'readwise.library',
        acknowledge: true,
      }));
      await deleteStarted;
      const reconnect = worker.fetch(jsonRequest('/dashboard/connect/api-key', {
        source: 'readwise',
        api_key: 'new-token',
      }));
      await Promise.resolve();
      expect(reconnectStarted).toBe(false);

      releaseDelete();
      expect((await disconnect).status).toBe(200);
      expect((await reconnect).status).toBe(200);
      expect(reconnectStarted).toBe(true);
      expect(await secrets.get('readwise.personal.token')).toBe('new-token');
      expect(readConnectedHandleRegistry(registryPath).handles.map((handle) => handle.handle))
        .toEqual(['readwise.personal']);
    } finally {
      releaseDelete();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('serializes an OAuth start ahead of Disconnect and invalidates the published attempt before returning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-oauth-disconnect-race-'));
    const registryPath = join(root, 'handles.json');
    upsertConnectedHandle({
      handle: 'dropbox.personal',
      provider: 'dropbox',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read', 'files.content.read'],
      tokenSecretRefs: ['store:dropbox.personal.oauth.refresh_token'],
      connectedAt: '2026-08-30T10:00:00.000Z',
    }, registryPath);
    const secrets = memorySecretStore({
      'dropbox.personal.oauth.client_id': 'dropbox-client-id',
      'dropbox.personal.oauth.refresh_token': 'old-refresh-token',
    });
    const startEntered = deferred();
    const releaseStart = deferred();
    let callbackCompletions = 0;
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        startExternalOAuthConnection: async (options) => {
          startEntered.resolve();
          await releaseStart.promise;
          return {
            ok: true,
            source: options.source,
            authorizationUrl: 'https://www.dropbox.com/oauth2/authorize?state=state-fixture',
            redirectUri: options.redirectUri,
            state: 'state-fixture',
            startedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            completeCallback: async () => {
              callbackCompletions += 1;
              return {
                ok: true,
                source: options.source,
                handles: ['dropbox.personal'],
                registryPath,
                secretRefs: ['store:dropbox.personal.oauth.refresh_token'],
              };
            },
            cancel() {},
          };
        },
      },
    });
    try {
      const start = worker.fetch(jsonRequest('/dashboard/connect/oauth/start', { source: 'dropbox' }));
      await startEntered.promise;
      let disconnectReturned = false;
      const disconnect = worker.fetch(jsonRequest('/dashboard/disconnect', {
        source_id: 'dropbox.files',
        acknowledge: true,
      })).then((response) => {
        disconnectReturned = true;
        return response;
      });
      await Promise.resolve();
      expect(disconnectReturned).toBe(false);

      releaseStart.resolve();
      expect((await start).status).toBe(200);
      expect((await disconnect).status).toBe(200);
      expect(await secrets.get('dropbox.personal.oauth.refresh_token')).toBeUndefined();
      expect(await secrets.get('dropbox.personal.oauth.client_id')).toBe('dropbox-client-id');
      expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);

      const callback = await worker.fetch(new Request(
        'http://worker.test/oauth/callback/dropbox?code=callback-code&state=state-fixture',
      ));
      expect(callback.status).toBe(410);
      expect(callbackCompletions).toBe(0);
    } finally {
      releaseStart.resolve();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('waits for an in-flight manual read before Disconnect reports success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-manual-disconnect-race-'));
    const registryPath = join(root, 'handles.json');
    upsertConnectedHandle({
      handle: 'readwise.personal',
      provider: 'readwise',
      accountRole: 'personal',
      trustDomain: 'internal',
      allowedCapabilities: ['readwise.sync'],
      scopes: ['readwise.export:read', 'readwise.reader:read'],
      tokenSecretRefs: ['store:readwise.personal.token'],
      connectedAt: '2026-08-30T10:00:00.000Z',
    }, registryPath);
    const readEntered = deferred();
    const releaseRead = deferred();
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({ 'readwise.personal.token': 'token' }),
        triggerSourceSync: async () => {
          readEntered.resolve();
          await releaseRead.promise;
          return { ok: true };
        },
      },
    });
    try {
      const sync = worker.fetch(jsonRequest('/dashboard/sync-now', { source: 'readwise' }));
      await readEntered.promise;
      let disconnectReturned = false;
      const disconnect = worker.fetch(jsonRequest('/dashboard/disconnect', {
        source_id: 'readwise.library',
        acknowledge: true,
      })).then((response) => {
        disconnectReturned = true;
        return response;
      });
      await Promise.resolve();
      expect(disconnectReturned).toBe(false);

      releaseRead.resolve();
      expect((await sync).status).toBe(200);
      expect((await disconnect).status).toBe(200);
      expect(disconnectReturned).toBe(true);
      expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);
    } finally {
      releaseRead.resolve();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses Disconnect while a scheduled read is running and preserves custody for retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-scheduled-disconnect-race-'));
    const registryPath = join(root, 'handles.json');
    upsertConnectedHandle({
      handle: 'dropbox.personal',
      provider: 'dropbox',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read', 'files.content.read'],
      tokenSecretRefs: ['store:dropbox.personal.oauth.refresh_token'],
      connectedAt: '2026-08-30T10:00:00.000Z',
    }, registryPath);
    const secrets = memorySecretStore({
      'dropbox.personal.oauth.refresh_token': 'refresh-token',
    });
    const schedulerUpdates: unknown[][] = [];
    const worker = createEmailSourceWorker({
      sourceScheduler: {
        status: () => ({
          sources: [{
            source_id: 'dropbox.files',
            corpus_id: 'dropbox.files',
            tasks: [{ running: true }],
          }],
        }),
        updateSources: (sources: unknown[]) => schedulerUpdates.push(sources),
      } as never,
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
        // No adoption tick in this suite: it does not exercise registry
        // adoption, and an unclosed worker would leave one ticking.
        registryAdoptionIntervalMs: 0,
        refreshSchedulerSources: () => [],
      },
    });
    try {
      const response = await worker.fetch(jsonRequest('/dashboard/disconnect', {
        source_id: 'dropbox.files',
        acknowledge: true,
      }));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'disconnect_source_busy' },
      });
      expect(schedulerUpdates).toEqual([]);
      expect(await secrets.get('dropbox.personal.oauth.refresh_token')).toBe('refresh-token');
      expect(readConnectedHandleRegistry(registryPath).handles.map((handle) => handle.handle))
        .toEqual(['dropbox.personal']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('serializes public CLI Connect with dashboard Disconnect across the filesystem custody boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-cli-connect-race-'));
    const registryPath = join(root, 'handles.json');
    upsertConnectedHandle({
      handle: 'readwise.personal',
      provider: 'readwise',
      accountRole: 'personal',
      trustDomain: 'internal',
      allowedCapabilities: ['readwise.sync'],
      scopes: ['readwise.export:read', 'readwise.reader:read'],
      tokenSecretRefs: ['store:readwise.personal.token'],
      connectedAt: '2026-08-30T10:00:00.000Z',
    }, registryPath);
    const values = new Map([['readwise.personal.token', 'old-token']]);
    const deleteStarted = deferred();
    const releaseDelete = deferred();
    const secrets: SecretStore = {
      label: 'deferred-memory',
      get: async (key) => values.get(key),
      getSync: (key) => values.get(key),
      set: async (key, value) => { values.set(key, value); },
      delete: async (key) => {
        deleteStarted.resolve();
        await releaseDelete.promise;
        values.delete(key);
      },
      list: async () => [...values.keys()].sort(),
    };
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
      },
    });
    try {
      const disconnect = worker.fetch(jsonRequest('/dashboard/disconnect', {
        source_id: 'readwise.library',
        acknowledge: true,
      }));
      await deleteStarted.promise;
      let connectReturned = false;
      const connect = connectApiKeySource({
        source: 'readwise',
        apiKey: 'new-token',
        registryPath,
        secretStore: secrets,
        fetch: async () => new Response('{}', { status: 204 }),
      }).then((result) => {
        connectReturned = true;
        return result;
      });
      await Promise.resolve();
      expect(connectReturned).toBe(false);

      releaseDelete.resolve();
      expect((await disconnect).status).toBe(200);
      await expect(connect).resolves.toMatchObject({ ok: true, handles: ['readwise.personal'] });
      expect(await secrets.get('readwise.personal.token')).toBe('new-token');
      expect(readConnectedHandleRegistry(registryPath).handles.map((handle) => handle.handle))
        .toEqual(['readwise.personal']);
    } finally {
      releaseDelete.resolve();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a Disconnect generation fences an earlier detached OAuth completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-dashboard-detached-oauth-fence-'));
    const registryPath = join(root, 'handles.json');
    upsertConnectedHandle({
      handle: 'dropbox.personal',
      provider: 'dropbox',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read', 'files.content.read'],
      tokenSecretRefs: ['store:dropbox.personal.oauth.refresh_token'],
      connectedAt: '2026-08-30T10:00:00.000Z',
    }, registryPath);
    const secrets = memorySecretStore({
      'dropbox.personal.oauth.client_id': 'client-id',
      'dropbox.personal.oauth.refresh_token': 'old-refresh-token',
    });
    const pending = await startExternalOAuthSourceConnection({
      source: 'dropbox',
      clientId: 'client-id',
      redirectUri: 'http://127.0.0.1:17777/oauth/callback/dropbox',
      registryPath,
      secretStore: secrets,
      fetch: async () => new Response(JSON.stringify({
        access_token: 'access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: secrets,
      },
    });
    try {
      const disconnect = await worker.fetch(jsonRequest('/dashboard/disconnect', {
        source_id: 'dropbox.files',
        acknowledge: true,
      }));
      expect(disconnect.status).toBe(200);
      await expect(pending.completeCallback({ state: pending.state, code: 'spent-code' }))
        .rejects.toThrow('newer Disconnect superseded');
      expect(await secrets.get('dropbox.personal.oauth.refresh_token')).toBeUndefined();
      expect(readConnectedHandleRegistry(registryPath).handles).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('public CLI Connect enforces one connected account per provider before storing a second grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-cli-account-cardinality-'));
    const registryPath = join(root, 'handles.json');
    const secrets = memorySecretStore({});
    const options = {
      source: 'readwise' as const,
      registryPath,
      secretStore: secrets,
      fetch: async () => new Response('{}', { status: 204 }),
    };
    try {
      await expect(connectApiKeySource({ ...options, apiKey: 'personal-token', accountRole: 'personal' }))
        .resolves.toMatchObject({ handles: ['readwise.personal'] });
      await expect(connectApiKeySource({ ...options, apiKey: 'work-token', accountRole: 'work' }))
        .rejects.toThrow('one connected account per provider');
      expect(await secrets.get('readwise.work.token')).toBeUndefined();
      expect(readConnectedHandleRegistry(registryPath).handles.map((handle) => handle.handle))
        .toEqual(['readwise.personal']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function googleSharedRegistry(refreshTokenSecretRef: string): ConnectedHandleRegistry {
  const oauth2Refresh = {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientIdSecretRef: 'store:google.personal.oauth.client_id',
    clientSecretSecretRef: 'store:google.personal.oauth.client_secret',
    refreshTokenSecretRef,
    scopes: [],
  };
  return {
    version: 1,
    handles: [
      {
        handle: 'gmail.personal',
        provider: 'gmail',
        accountRole: 'personal',
        trustDomain: 'secure_local',
        allowedCapabilities: ['gmail.email.sync'],
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        oauth2Refresh: { ...oauth2Refresh },
        connectedAt: '2026-08-30T10:00:00.000Z',
      },
      {
        handle: 'google_drive.personal',
        provider: 'google_drive',
        accountRole: 'personal',
        trustDomain: 'internal',
        allowedCapabilities: ['google_drive.docs.sync'],
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        oauth2Refresh: { ...oauth2Refresh },
        connectedAt: '2026-08-30T10:00:00.000Z',
      },
    ],
  };
}

function fixtureSovereigntyEngine() {
  return createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
  }));
}

function memorySecretStore(initial: Record<string, string>): SecretStore {
  const values = new Map(Object.entries(initial));
  return {
    label: 'memory',
    get: async (key) => values.get(key),
    getSync: (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
    list: async () => [...values.keys()].sort(),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
