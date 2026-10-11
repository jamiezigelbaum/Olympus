// An X bookmarks run never stores what it read under a grant that was replaced
// while it ran.
//
// The broker stops serving a replaced grant's cached token (PR #254), but a
// token it already handed out still works at X. Without a per-page check, a
// run in flight when account B is connected keeps fetching account A's
// bookmarks and stores them in the lane that now belongs to B.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretStore } from '../src/core/secret-store.ts';
import { syncAndEmbedFromConnector } from '../src/workers/connector-store/index.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { upsertConnectedHandle } from '../src/workers/credential-broker/connected-handles.ts';
import { createEnvCredentialBroker } from '../src/workers/credential-broker/index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  XBookmarksGrantChangedError,
  createXBookmarksApiSourceConnector,
  createXBookmarksConnectorStore,
  createXBookmarksConnectorStoreSyncHandler,
  createXBookmarksContentRecoveryHandler,
  createXBookmarksSourceConnector,
  defaultXBookmarksLiveSyncConfig,
  runXBookmarksWindowDiagnostic,
  type XBookmarksLiveSyncConfig,
} from '../src/workers/x-bookmarks/index.ts';
import { X_BOOKMARKS_STORE_PLACEMENT } from '../src/workers/x-bookmarks/connector.ts';

const HANDLE = 'x.bookmarks.personal';
const ACCOUNT = 'personal';
const USER_ID = '1000';
// The account a reconnect switches to; a run built for it reads as this id.
const USER_B = '2000';
const NOW = new Date('2026-10-11T09:00:00.000Z');

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('X bookmarks grant fence', () => {
  test('a reconnect during the head fetch stores nothing, and the next run uses the new grant', async () => {
    const f = fixture();
    f.writeGrant('2026-10-11T08:00:00.000Z', USER_ID);
    f.respond = (token) => {
      // Account B is connected while account A's page is on the wire.
      f.reconnect('2026-10-11T08:30:00.000Z', USER_B);
      return token === 'access-for-refresh-token-a' ? [post('201', 'account a private marker')] : [];
    };

    const handler = f.handler();
    await expect(handler.syncHead({ attempted_at: NOW.toISOString() })).rejects.toBeInstanceOf(XBookmarksGrantChangedError);
    expect(f.tokensUsed).toEqual(['access-for-refresh-token-a']);
    expect(f.store.status().counts.items).toBe(0);
    expect(f.store.searchItems('account a private marker', 5)).toHaveLength(0);
    expect(f.usage.headCheckpoint(ACCOUNT)).toBeUndefined();

    f.respond = (token) => token === 'access-for-refresh-token-b' ? [post('301', 'account b marker')] : [];
    await expect(f.handler(undefined, USER_B).syncHead({ attempted_at: NOW.toISOString() })).resolves.toMatchObject({ status: 'progress' });
    expect(f.tokensUsed.at(-1)).toBe('access-for-refresh-token-b');
    expect(f.store.searchItems('account b marker', 5)[0]?.sourceItem.providerItemId).toBe('301');
    expect(f.store.searchItems('account a private marker', 5)).toHaveLength(0);
  });

  test('a reconnect between acquisition and listing stores nothing', async () => {
    const f = fixture();
    f.writeGrant('2026-10-11T08:00:00.000Z', USER_ID);
    f.respond = () => [post('201', 'account a private marker')];
    const connector = createXBookmarksApiSourceConnector({
      mode: 'incremental',
      account: ACCOUNT,
      attemptedAt: NOW,
      now: () => NOW,
      usageStore: f.usage,
      config: testConfig(),
      credentialBroker: f.broker,
      credentialHandle: HANDLE,
      userId: USER_ID,
      fetch: f.xFetch,
    });
    await connector.probe();
    f.reconnect('2026-10-11T08:30:00.000Z', USER_B);

    await expect(syncAndEmbedFromConnector({
      store: f.store,
      connector,
      embeddingProvider: fakeEmbeddingProvider(),
      sync: { placement: X_BOOKMARKS_STORE_PLACEMENT, fetchContent: true },
    })).rejects.toBeInstanceOf(XBookmarksGrantChangedError);
    expect(f.store.status().counts.items).toBe(0);
  });

  test('a reconnect during reconciliation stores nothing and completes no snapshot', async () => {
    const f = fixture();
    f.writeGrant('2026-10-11T08:00:00.000Z', USER_ID);
    let requests = 0;
    f.respond = () => {
      requests += 1;
      if (requests === 1) f.reconnect('2026-10-11T08:30:00.000Z', USER_B);
      return [post('201', 'account a private marker')];
    };
    const state = new LocalXBookmarksReconcileStateStore(':memory:');
    closers.push(() => state.close());

    await expect(f.handler(state).reconcile({ attempted_at: NOW.toISOString() }))
      .rejects.toBeInstanceOf(XBookmarksGrantChangedError);
    expect(requests).toBe(1);
    expect(f.store.status().counts.items).toBe(0);
    expect(state.completedSnapshot(ACCOUNT)).toBeUndefined();
  });

  test('an unchanged grant syncs normally', async () => {
    const f = fixture();
    f.writeGrant('2026-10-11T08:00:00.000Z', USER_ID);
    f.respond = () => [post('201', 'account a marker')];
    await expect(f.handler().syncHead({ attempted_at: NOW.toISOString() })).resolves.toMatchObject({ status: 'progress' });
    expect(f.store.searchItems('account a marker', 5)[0]?.sourceItem.providerItemId).toBe('201');
    expect(f.usage.headCheckpoint(ACCOUNT)).toBe('201');
  });
});

describe('X bookmarks content recovery grant fence', () => {
  test('a reconnect during the lookup restores nothing, and the next run uses the new grant', async () => {
    const f = fixture();
    f.writeGrant('2026-10-11T08:00:00.000Z', USER_ID);
    const store = createXBookmarksConnectorStore(join(f.dir, 'x-recovery.sqlite'));
    closers.push(() => store.close());
    // A bookmark stored by id only, waiting for its text.
    await store.syncFromConnector(createXBookmarksSourceConnector({
      account: ACCOUNT,
      posts: [{ id: '2076846914813788163' }],
      fetchedAt: NOW.toISOString(),
    }), { fetchContent: true });
    const recoveryAs = (userId: string) => createXBookmarksContentRecoveryHandler({
      store,
      usageStore: f.usage,
      account: ACCOUNT,
      userId,
      credentialBroker: f.broker,
      credentialHandle: HANDLE,
      fetch: f.xFetch,
      config: testConfig(),
      receiptPath: join(f.dir, 'recovery-receipt.json'),
      now: () => NOW,
    });

    f.respond = (token) => {
      f.reconnect('2026-10-11T08:30:00.000Z', USER_B);
      return token === 'access-for-refresh-token-a'
        ? [post('2076846914813788163', 'zebraquill')]
        : [];
    };
    const deferred = await recoveryAs(USER_ID).recover({ execute: true });
    expect(deferred).toMatchObject({
      status: 'deferred',
      counts: { api_requests: 1, items_recovered: 0, items_deferred: 1 },
    });
    expect(f.tokensUsed).toEqual(['access-for-refresh-token-a']);
    expect(store.searchItems('zebraquill', 5)).toHaveLength(0);

    f.respond = (token) => token === 'access-for-refresh-token-b'
      ? [post('2076846914813788163', 'account b recovered text')]
      : [];
    const completed = await recoveryAs(USER_B).recover({ execute: true });
    expect(completed).toMatchObject({ status: 'completed', counts: { items_recovered: 1 } });
    expect(f.tokensUsed.at(-1)).toBe('access-for-refresh-token-b');
    expect(store.searchItems('account b recovered text', 5)).toHaveLength(1);
    expect(store.searchItems('zebraquill', 5)).toHaveLength(0);
  });
});

describe('X runs read only as the account their grant is for', () => {
  // The lane's account check runs at task entry, before the token is taken: a
  // connect landing in between hands a run built for account A the grant of
  // account B. Nothing may then be read or stored, including a completed
  // reconcile snapshot replayed with no provider call (PR #264 review).
  test('a sync built for account A with B already connected reads and stores nothing', async () => {
    const f = fixture();
    f.writeGrant('2026-10-11T08:30:00.000Z', USER_B);
    f.respond = () => [post('201', 'account b private marker')];
    const state = new LocalXBookmarksReconcileStateStore(':memory:');
    closers.push(() => state.close());

    const head = await f.handler(state).syncHead({ attempted_at: NOW.toISOString() }).catch((error: unknown) => error);
    expect(head).toBeInstanceOf(XBookmarksGrantChangedError);
    expect((head as XBookmarksGrantChangedError).code).toBe('x_bookmarks_grant_account_mismatch');
    await expect(f.handler(state).reconcile({ attempted_at: NOW.toISOString() }))
      .rejects.toBeInstanceOf(XBookmarksGrantChangedError);
    expect(f.tokensUsed).toEqual([]);
    expect(f.store.status().counts.items).toBe(0);
    expect(state.completedSnapshot(ACCOUNT)).toBeUndefined();
  });

  test('content recovery built for account A with B already connected restores nothing', async () => {
    const f = fixture();
    f.writeGrant('2026-10-11T08:30:00.000Z', USER_B);
    const store = createXBookmarksConnectorStore(join(f.dir, 'x-recovery.sqlite'));
    closers.push(() => store.close());
    await store.syncFromConnector(createXBookmarksSourceConnector({
      account: ACCOUNT,
      posts: [{ id: '2076846914813788163' }],
      fetchedAt: NOW.toISOString(),
    }), { fetchContent: true });
    f.respond = () => [post('2076846914813788163', 'quokkaspire')];

    const receipt = await createXBookmarksContentRecoveryHandler({
      store,
      usageStore: f.usage,
      account: ACCOUNT,
      userId: USER_ID,
      credentialBroker: f.broker,
      credentialHandle: HANDLE,
      fetch: f.xFetch,
      config: testConfig(),
      receiptPath: join(f.dir, 'recovery-receipt.json'),
      now: () => NOW,
    }).recover({ execute: true });
    expect(receipt).toMatchObject({ status: 'deferred', counts: { api_requests: 0, items_recovered: 0, items_deferred: 1 } });
    expect(f.tokensUsed).toEqual([]);
    expect(store.searchItems('quokkaspire', 5)).toHaveLength(0);
  });
});

describe('X bookmarks window diagnostic grant fence', () => {
  test('a reconnect during the diagnostic writes no report', async () => {
    const f = fixture();
    f.writeGrant('2026-10-11T08:00:00.000Z', USER_ID);
    f.respond = () => {
      f.reconnect('2026-10-11T08:30:00.000Z', USER_B);
      return [post('201', 'account a marker')];
    };
    const reportPath = join(f.dir, 'diagnostic.json');
    await expect(runXBookmarksWindowDiagnostic({
      account: ACCOUNT,
      attemptedAt: NOW,
      usageStore: f.usage,
      reportPath,
      credentialBroker: f.broker,
      credentialHandle: HANDLE,
      userId: USER_ID,
      fetch: f.xFetch,
      config: testConfig(),
    })).rejects.toBeInstanceOf(XBookmarksGrantChangedError);
    expect(f.tokensUsed).toEqual(['access-for-refresh-token-a']);
    expect(existsSync(reportPath)).toBe(false);
  });

  test('an unchanged grant writes the report', async () => {
    const f = fixture();
    f.writeGrant('2026-10-11T08:00:00.000Z', USER_ID);
    f.respond = () => [post('201', 'account a marker')];
    const reportPath = join(f.dir, 'diagnostic.json');
    await runXBookmarksWindowDiagnostic({
      account: ACCOUNT,
      attemptedAt: NOW,
      usageStore: f.usage,
      reportPath,
      credentialBroker: f.broker,
      credentialHandle: HANDLE,
      userId: USER_ID,
      fetch: f.xFetch,
      config: testConfig(),
    });
    expect(existsSync(reportPath)).toBe(true);
  });
});

interface Post { id: string; text: string }

function post(id: string, text: string): Post {
  return { id, text };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-x-grant-fence-'));
  dirs.push(dir);
  const registryPath = join(dir, 'handles.json');
  const secretStore = memorySecretStore({
    'x.bookmarks.personal.oauth.client_id': 'x-client-id-fixture',
    'x.bookmarks.personal.oauth.refresh_token': 'refresh-token-a',
  });
  const broker = createEnvCredentialBroker({
    env: {},
    handleRegistryPath: registryPath,
    secretStore,
    oauth2CacheNamespace: `x-grant-fence-${dir}`,
    now: () => NOW,
    fetch: async (_url, init) => {
      const refreshToken = new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '';
      return new Response(JSON.stringify({
        access_token: `access-for-${refreshToken}`,
        expires_in: 7_200,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const store = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'internal.x.bookmarks',
    family: 'x',
    trustDomain: 'internal',
  });
  const usage = new LocalXBookmarksApiUsageStore(':memory:');
  closers.push(() => { usage.close(); store.close(); });

  const writeGrant = (connectedAt: string, providerAccountId: string): void => {
    upsertConnectedHandle({
      handle: HANDLE,
      provider: 'x',
      accountRole: 'personal',
      trustDomain: 'internal',
      allowedCapabilities: ['x.bookmarks.sync'],
      scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
      oauth2Refresh: {
        tokenUrl: 'https://api.x.com/2/oauth2/token',
        clientIdSecretRef: 'store:x.bookmarks.personal.oauth.client_id',
        refreshTokenSecretRef: 'store:x.bookmarks.personal.oauth.refresh_token',
      },
      connectedAt,
      providerAccountId,
    }, registryPath);
  };

  const state = {
    dir,
    store,
    usage,
    broker,
    writeGrant,
    /** The second connect, as the dashboard writes it. */
    reconnect(connectedAt: string, providerAccountId: string): void {
      secretStore.values.set('x.bookmarks.personal.oauth.refresh_token', 'refresh-token-b');
      writeGrant(connectedAt, providerAccountId);
    },
    tokensUsed: [] as string[],
    respond: (_token: string): Post[] => [],
    xFetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
      state.tokensUsed.push(token);
      const posts = state.respond(token);
      return new Response(JSON.stringify({
        data: posts.map((entry) => ({ id: entry.id, text: entry.text, created_at: NOW.toISOString() })),
        meta: { result_count: posts.length },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
    handler(reconcileStateStore?: LocalXBookmarksReconcileStateStore, userId = USER_ID) {
      return createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        ...(reconcileStateStore ? { reconcileStateStore } : {}),
        embeddingProvider: fakeEmbeddingProvider(),
        credentialBroker: broker,
        credentialHandle: HANDLE,
        account: ACCOUNT,
        userId,
        fetch: state.xFetch,
        config: testConfig(),
        now: () => NOW,
      });
    },
  };
  return state;
}

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

function fakeEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'test',
    modelId: 'test-x-embed',
    dimension: 3,
    configHash: 'test-config',
    epochId: 'test-epoch',
    backend: 'cloud',
    async embed(inputs) {
      return inputs.map(() => [1, 0, 0]);
    },
  };
}

function testConfig(overrides: Partial<XBookmarksLiveSyncConfig> = {}): XBookmarksLiveSyncConfig {
  return {
    ...defaultXBookmarksLiveSyncConfig({}),
    dailyApiRequestBudget: 10_000,
    dailyResourceReadBudget: 100_000,
    dailyEstimatedSpendMicrousd: 100_000_000,
    rateLimitLowWatermark: 0,
    ...overrides,
  };
}
