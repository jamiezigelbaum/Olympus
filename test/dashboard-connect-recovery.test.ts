// Three ways the dashboard used to strand a pilot who was, in fact, connected.
//
// The page is the only surface that can tell an owner a source needs
// reconnecting, so it must survive the states that make that question urgent:
// a handle registry it cannot parse, a Google client whose secret is already
// stored, and a reconnect performed from the terminal instead of the page.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import type { ExternalPendingOAuthConnection } from '../src/core/connect.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  upsertConnectedHandle,
  type ConnectedCredentialHandle,
} from '../src/workers/credential-broker/connected-handles.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the dashboard renders over an unreadable handle registry', () => {
  test('a corrupt handles.json costs the cards their connection facts, not the whole page', async () => {
    const registryPath = fixtureRegistryPath();
    // Truncated by a partial restore, a hand-edit, or a newer writer: the
    // registry reader throws on the whole file rather than on one entry.
    writeFileSync(registryPath, '{"version": 1, "handles": [{"handle": "gmail.per');
    const worker = createEmailSourceWorker({
      sourceIndexStatus: { async status() { return fixtureStatus(); } },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
      },
    });

    const response = await worker.fetch(new Request('http://worker.test/dashboard.json'));
    expect(response.status).toBe(200);
    const view = await response.json() as { sources: Array<{ source_id: string; connection: { label: string } }> };

    // Honest rather than silent: with the registry unreadable the page cannot
    // claim these sources are unconnected, only that it could not tell.
    expect(cardLabel(view, 'gmail.email')).toBe('connection state unreadable');
    expect(cardLabel(view, 'dropbox.files')).toBe('connection state unreadable');

    const page = await worker.fetch(new Request('http://worker.test/dashboard'));
    expect(page.status).toBe(200);
  });

  test('a readable registry still says plainly that a source is not connected', async () => {
    const registryPath = fixtureRegistryPath();
    const worker = createEmailSourceWorker({
      sourceIndexStatus: { async status() { return fixtureStatus(); } },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({}),
      },
    });

    const response = await worker.fetch(new Request('http://worker.test/dashboard.json'));
    expect(response.status).toBe(200);
    const view = await response.json() as { sources: Array<{ source_id: string; connection: { label: string } }> };
    expect(cardLabel(view, 'gmail.email')).toBe('not connected');
  });
});

describe('a Google reconnect keeps the client secret its own registration was issued with', () => {
  test('a stored secret paired with the client id in use reaches the token exchange', async () => {
    const registryPath = fixtureRegistryPath();
    const starts: Array<{ clientId: string; clientSecret?: string }> = [];
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        // What a pilot who followed the earlier bring-your-own-client
        // instructions has in the store today.
        secretStore: memorySecretStore({
          'gmail.personal.oauth.client_id': 'byo-client-id',
          'gmail.personal.oauth.client_secret': 'byo-client-secret',
        }),
        startExternalOAuthConnection: async (options) => {
          starts.push({
            clientId: options.clientId,
            ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }),
          });
          return fixturePending(options);
        },
      },
    });

    const response = await worker.fetch(jsonRequest('/dashboard/connect/oauth/start', { source: 'gmail' }));
    expect(response.status).toBe(200);
    expect(starts).toEqual([{ clientId: 'byo-client-id', clientSecret: 'byo-client-secret' }]);
  });

  test('a secret belonging to some other registration never rides along with the pilot client', async () => {
    const registryPath = fixtureRegistryPath();
    const previous = process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID;
    process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID = 'pilot-client-id';
    const starts: Array<{ clientId: string; clientSecret?: string }> = [];
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        // A secret left over from a registration whose client id is gone. The
        // pilot client is a public client; pairing it with a stranger's secret
        // is the one thing Google refuses outright.
        secretStore: memorySecretStore({ 'gmail.personal.oauth.client_secret': 'stale-secret' }),
        startExternalOAuthConnection: async (options) => {
          starts.push({
            clientId: options.clientId,
            ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }),
          });
          return fixturePending(options);
        },
      },
    });

    try {
      const response = await worker.fetch(jsonRequest('/dashboard/connect/oauth/start', { source: 'gmail' }));
      expect(response.status).toBe(200);
      expect(starts).toEqual([{ clientId: 'pilot-client-id' }]);
    } finally {
      if (previous === undefined) delete process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID;
      else process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID = previous;
    }
  });
});

describe('Sync now follows the registry, not this process\'s memory of a Disconnect', () => {
  test('a reconnect made from the CLI restores manual reads without a worker restart', async () => {
    const registryPath = fixtureRegistryPath();
    upsertConnectedHandle(gmailHandle('2026-08-30T10:00:00.000Z'), registryPath);
    const manualReads: unknown[] = [];
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({ 'gmail.personal.oauth.refresh_token': 'refresh-token' }),
        triggerSourceSync: async (request) => {
          manualReads.push(request);
          return { ok: true };
        },
      },
    });

    const disconnect = await worker.fetch(jsonRequest('/dashboard/disconnect', {
      source_id: 'gmail.email',
      acknowledge: true,
    }));
    expect(disconnect.status).toBe(200);

    const stillDisconnected = await worker.fetch(jsonRequest('/dashboard/sync-now', { source: 'gmail' }));
    expect(stillDisconnected.status).toBe(409);
    expect(manualReads).toEqual([]);

    // `olympus connect gmail` — a separate process with no channel back into
    // this one. All it can leave behind is the registry entry.
    upsertConnectedHandle(gmailHandle('2026-08-30T11:00:00.000Z'), registryPath);

    const reconnected = await worker.fetch(jsonRequest('/dashboard/sync-now', { source: 'gmail' }));
    expect(reconnected.status).toBe(200);
    expect(manualReads).toEqual([{ source: 'gmail', reason: 'manual' }]);
  });

  test('an unreadable registry keeps a disconnected source refused rather than crashing the read', async () => {
    const registryPath = fixtureRegistryPath();
    upsertConnectedHandle(gmailHandle('2026-08-30T10:00:00.000Z'), registryPath);
    const worker = createEmailSourceWorker({
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath,
        secretStore: memorySecretStore({ 'gmail.personal.oauth.refresh_token': 'refresh-token' }),
        triggerSourceSync: async () => ({ ok: true }),
      },
    });

    expect((await worker.fetch(jsonRequest('/dashboard/disconnect', {
      source_id: 'gmail.email',
      acknowledge: true,
    }))).status).toBe(200);
    writeFileSync(registryPath, '{"version": 1, "handles": [{"handle": "gmail.per');

    const response = await worker.fetch(jsonRequest('/dashboard/sync-now', { source: 'gmail' }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'source_disconnected' } });
  });
});

function fixtureRegistryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-connect-recovery-'));
  dirs.push(dir);
  return join(dir, 'handles.json');
}

function cardLabel(
  view: { sources: Array<{ source_id: string; connection: { label: string } }> },
  sourceId: string,
): string {
  const card = view.sources.find((candidate) => candidate.source_id === sourceId);
  expect(card).toBeDefined();
  return card!.connection.label;
}

function gmailHandle(connectedAt: string): ConnectedCredentialHandle {
  return {
    handle: 'gmail.personal',
    provider: 'gmail',
    accountRole: 'personal',
    trustDomain: 'secure_local',
    allowedCapabilities: ['gmail.email.sync'],
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    oauth2Refresh: {
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientIdSecretRef: 'store:gmail.personal.oauth.client_id',
      refreshTokenSecretRef: 'store:gmail.personal.oauth.refresh_token',
      scopes: [],
    },
    connectedAt,
  };
}

function fixturePending(
  options: { source: ExternalPendingOAuthConnection['source']; redirectUri: string },
): ExternalPendingOAuthConnection {
  return {
    ok: true,
    source: options.source,
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=state-fixture',
    redirectUri: options.redirectUri,
    state: 'state-fixture',
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    completeCallback: async () => ({
      ok: true,
      source: options.source,
      handles: ['gmail.personal'],
      registryPath: 'unused',
      secretRefs: [],
    }),
    cancel() {},
  };
}

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

function fixtureStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-08-24T00:00:00.000Z',
    corpora: [{
      corpus_id: 'secure_local.email.private',
      family: 'email',
      trust_domain: 'secure_local',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'local_only',
      configured: true,
      provider: 'gmail',
      counts: {
        accounts: 1,
        indexed_items: 10,
        files_with_text: 8,
        secure_local_chunks: 20,
        embedded_chunks: 20,
      },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'item_metadata_not_requested',
    }],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  } as unknown as SourceIndexStatusResult;
}
