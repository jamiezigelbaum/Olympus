// X bookmarks is account-bound like Dropbox, Drive and Gmail: one X account
// per bookmarks source. A reconnect to a different X account over stored
// bookmarks stops the source at task entry, and nothing is deleted for the
// owner. The account the lane reads as is the X user id every bookmarks
// request is addressed to (X refuses it for another account's token), so the
// check makes no provider call and never mints a token of its own.

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOAuthSource } from '../src/core/connect.ts';
import { EncryptedFileSecretStore } from '../src/core/secret-store.ts';
import { fetchProviderAccountId } from '../src/core/provider-account-identity.ts';
import {
  readSourceAccountBindings,
  sourceAccountBindingsPath,
  updateSourceAccountBinding,
} from '../src/core/source-account-binding.ts';
import { readConnectedHandleRegistry, upsertConnectedHandle } from '../src/workers/credential-broker/connected-handles.ts';
import {
  JsonCredentialOAuth2StateStore,
  type CredentialBroker,
  type CredentialOAuth2StateStore,
} from '../src/workers/credential-broker/index.ts';
import { EmailSourceWorkerError } from '../src/workers/email-source/index.ts';
import {
  accountCheckedXBookmarksRuntime,
  type XBookmarksConnectorStoreRuntime,
} from '../src/workers/email-source/server.ts';
import {
  createExclusiveRunner,
  createSourceAccountGuard,
  SourceAccountChangedError,
  type ExclusiveRunner,
} from '../src/workers/source-account-guard.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-x-account-binding-'));
  dirs.push(dir);
  return dir;
}

function bindingOf(registryPath: string) {
  const read = readSourceAccountBindings(sourceAccountBindingsPath(registryPath));
  return read.kind === 'ok' ? read.bindings.sources['x.bookmarks'] : undefined;
}

async function xServer(state: { userId: string }) {
  const grantTypes: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const stateParam = url.searchParams.get('state') ?? '';
      response.writeHead(302, { Location: `${redirectUri}?code=code-fixture&state=${stateParam}` }).end();
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        grantTypes.push(new URLSearchParams(body).get('grant_type') ?? '');
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          access_token: `x-access-for-${state.userId}`,
          refresh_token: `x-refresh-for-${state.userId}`,
          expires_in: 7_200,
        }));
      });
      return;
    }
    if (url.pathname === '/2/users/me') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: { id: state.userId } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, grantTypes, close: () => server.close() };
}

function connectX(dir: string, baseUrl: string, oauth2StateStore?: CredentialOAuth2StateStore) {
  return connectOAuthSource({
    source: 'x',
    clientId: 'x-client-id-fixture',
    clientSecret: 'x-client-secret-fixture',
    authUrl: `${baseUrl}/authorize`,
    tokenUrl: `${baseUrl}/token`,
    registryPath: join(dir, 'handles.json'),
    oauth2StateStore: oauth2StateStore ?? new JsonCredentialOAuth2StateStore(join(dir, 'oauth-state.json')),
    secretStore: new EncryptedFileSecretStore({
      encryptedFilePath: join(dir, 'secrets.enc'),
      keyFilePath: join(dir, 'secrets.key'),
    }),
    openBrowser: false,
    onAuthorizationUrl: async (url) => {
      const authResponse = await fetch(url, { redirect: 'manual' });
      const location = authResponse.headers.get('location');
      if (!location) throw new Error('mock authorization did not redirect');
      await fetch(location);
    },
  });
}

describe('X connect records the account its grant belongs to', () => {
  test('an X source from before bindings existed, reconnected to the SAME account, keeps its bookmarks', async () => {
    const dir = tempDir();
    const state = { userId: '1001' };
    const server = await xServer(state);
    try {
      await connectX(dir, server.baseUrl);
      rmSync(sourceAccountBindingsPath(join(dir, 'handles.json')), { force: true });
      const result = await connectX(dir, server.baseUrl);
      expect(result.sourceAccountPurgeRequired).toBeUndefined();
      expect(bindingOf(join(dir, 'handles.json'))).toEqual({
        provider_account_id: '1001',
        bound_at: expect.any(String),
      });
    } finally {
      server.close();
    }
  });

  test('an X source from before bindings existed, reconnected to a DIFFERENT account, requires a purge without refreshing the replaced grant', async () => {
    const dir = tempDir();
    const state = { userId: '1001' };
    const server = await xServer(state);
    try {
      await connectX(dir, server.baseUrl);
      rmSync(sourceAccountBindingsPath(join(dir, 'handles.json')), { force: true });
      state.userId = '2002';
      const result = await connectX(dir, server.baseUrl);
      expect(result.sourceAccountPurgeRequired).toEqual(['x.bookmarks']);
      expect(result.sourceAccountNotice).toContain('olympus data delete --source x.bookmarks');
      expect(bindingOf(join(dir, 'handles.json'))).toMatchObject({
        provider_account_id: '1001',
        purge_required: { reason: 'account_changed' },
      });
      // The previous account comes from the grant's recorded user id. A
      // refresh of the old grant from the connect process would rotate X's
      // refresh token and revoke the worker's live session.
      expect(server.grantTypes).toEqual(['authorization_code', 'authorization_code']);
    } finally {
      server.close();
    }
  });

  test('a bound X source reconnected to a different account requires a purge', async () => {
    const dir = tempDir();
    const registryPath = join(dir, 'handles.json');
    const state = { userId: '1001' };
    const server = await xServer(state);
    try {
      await connectX(dir, server.baseUrl);
      // What the worker's guard writes on the first sync it verifies.
      updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'x.bookmarks', () => ({
        provider_account_id: '1001',
        bound_at: '2026-10-11T08:00:00.000Z',
      }));
      state.userId = '2002';
      const result = await connectX(dir, server.baseUrl);
      expect(result.sourceAccountPurgeRequired).toEqual(['x.bookmarks']);

      // Reconnecting the previous account lifts it.
      state.userId = '1001';
      const back = await connectX(dir, server.baseUrl);
      expect(back.sourceAccountPurgeRequired).toBeUndefined();
      expect(bindingOf(registryPath)?.purge_required).toBeUndefined();
      expect(bindingOf(registryPath)?.provider_account_id).toBe('1001');
    } finally {
      server.close();
    }
  });
});

describe('a failed X reconnect leaves the previous grant as it was', () => {
  test('a state save that never lands restores the registry entry with the binding', async () => {
    // X keeps its rotating token in the OAuth state store, so the registry
    // entry is written first. Left at the new account's grant over the old
    // token, the worker would read the new account as the one the stores hold
    // (PR #264 review).
    const dir = tempDir();
    const registryPath = join(dir, 'handles.json');
    const state = { userId: '1001' };
    const server = await xServer(state);
    try {
      await connectX(dir, server.baseUrl);
      updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'x.bookmarks', () => ({
        provider_account_id: '1001',
        bound_at: '2026-10-11T08:00:00.000Z',
      }));
      const entryBefore = readConnectedHandleRegistry(registryPath).handles
        .find((entry) => entry.handle === 'x.bookmarks.personal');
      const bindingBefore = bindingOf(registryPath);
      expect(entryBefore?.providerAccountId).toBe('1001');

      const real = new JsonCredentialOAuth2StateStore(join(dir, 'oauth-state.json'));
      const failingSave: CredentialOAuth2StateStore = {
        load: (handle) => real.load(handle),
        save: async () => { throw new Error('disk full'); },
        ...(real.leaseTargetPath ? { leaseTargetPath: (handle: string) => real.leaseTargetPath!(handle) } : {}),
      };
      state.userId = '2002';
      await expect(connectX(dir, server.baseUrl, failingSave)).rejects.toThrow('disk full');

      const entryAfter = readConnectedHandleRegistry(registryPath).handles
        .find((entry) => entry.handle === 'x.bookmarks.personal');
      expect(entryAfter?.providerAccountId).toBe('1001');
      expect(entryAfter?.connectedAt).toBe(entryBefore!.connectedAt);
      expect(bindingOf(registryPath)).toEqual(bindingBefore);
    } finally {
      server.close();
    }
  });
});

describe('the X account guard', () => {
  function guardFor(input: {
    registryPath: string;
    readAccount: () => string | undefined;
    holdsItems: boolean;
    exclusive?: ExclusiveRunner;
    holds?: { items: boolean };
  }) {
    const broker: CredentialBroker = {
      async issueSession() { throw new Error('the X guard must not take a token'); },
    };
    const holds = input.holds ?? { items: input.holdsItems };
    const guard = createSourceAccountGuard({
      sourceId: 'x.bookmarks',
      provider: 'x',
      handle: 'x.bookmarks.personal',
      capability: 'x.bookmarks.sync',
      registryPath: input.registryPath,
      laneHoldsItems: () => holds.items,
      readAccountId: input.readAccount,
      ...(input.exclusive ? { exclusive: input.exclusive } : {}),
      broker,
      fetch: async () => { throw new Error('the X guard must not call the provider'); },
    });
    return { guard, setHoldsItems: (value: boolean) => { holds.items = value; } };
  }

  function writeXGrant(registryPath: string, providerAccountId: string | undefined, connectedAt = '2026-10-11T08:00:00.000Z') {
    upsertConnectedHandle({
      handle: 'x.bookmarks.personal',
      provider: 'x',
      accountRole: 'personal',
      trustDomain: 'internal',
      allowedCapabilities: ['x.bookmarks.sync'],
      scopes: ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'],
      connectedAt,
      ...(providerAccountId ? { providerAccountId } : {}),
    }, registryPath);
  }

  test('an X source from before bindings existed adopts the account it reads as', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeXGrant(registryPath, '1001');
    const { guard } = guardFor({ registryPath, readAccount: () => '1001', holdsItems: true });
    await guard.assertAccount();
    expect(bindingOf(registryPath)).toMatchObject({ provider_account_id: '1001' });
  });

  test('a different X account over stored bookmarks stops sync and deletes nothing', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeXGrant(registryPath, '1001');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'x.bookmarks', () => ({
      provider_account_id: '1001',
      bound_at: '2026-10-11T08:00:00.000Z',
    }));
    // Reconnected as another account; the worker has picked the new grant up.
    writeXGrant(registryPath, '2002', '2026-10-11T09:00:00.000Z');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'x.bookmarks', (current) => ({
      ...current,
      reconnected_at: '2026-10-11T09:00:00.000Z',
    }));
    const { guard, setHoldsItems } = guardFor({ registryPath, readAccount: () => '2002', holdsItems: true });
    const failure = await guard.assertAccount().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SourceAccountChangedError);
    expect((failure as SourceAccountChangedError).code).toBe('source_account_changed');
    expect((failure as Error).message).toContain('olympus data delete --source x.bookmarks');
    expect(bindingOf(registryPath)).toMatchObject({
      provider_account_id: '1001',
      purge_required: { reason: 'account_changed' },
    });

    // Once the owner has removed the previous account's bookmarks, the new one binds.
    setHoldsItems(false);
    await guard.assertAccount();
    expect(bindingOf(registryPath)).toMatchObject({ provider_account_id: '2002' });
    expect(bindingOf(registryPath)?.purge_required).toBeUndefined();
  });

  test('a lane still reading as the previous account under the new grant does not sync', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeXGrant(registryPath, '2002');
    const { guard } = guardFor({ registryPath, readAccount: () => '1001', holdsItems: true });
    const failure = await guard.assertAccount().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SourceAccountChangedError);
    expect((failure as SourceAccountChangedError).code).toBe('source_account_token_mismatch');
    expect((failure as Error).message).toContain('set to read a different account');
  });

  test('a grant that names no account never binds the source to the configured read account', async () => {
    // A configured user id is not evidence: adopting it would bind a legacy
    // source's items to an account they never came from (PR #264 review, Astra).
    const registryPath = join(tempDir(), 'handles.json');
    writeXGrant(registryPath, undefined);
    const { guard } = guardFor({ registryPath, readAccount: () => '2002', holdsItems: true });
    await guard.assertAccount();
    expect(bindingOf(registryPath)?.provider_account_id).toBeUndefined();
  });

  test("a check for the next account waits for the previous account's task to finish writing", async () => {
    // Account A's task is admitted and writing; B is connected meanwhile. B's
    // check must not find A's stores empty mid-write and bind B over them
    // (PR #264 review, Astra).
    const registryPath = join(tempDir(), 'handles.json');
    writeXGrant(registryPath, '1001');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'x.bookmarks', () => ({
      provider_account_id: '1001',
      bound_at: '2026-10-11T08:00:00.000Z',
    }));
    const exclusive = createExclusiveRunner();
    const holds = { items: false };
    const a = guardFor({ registryPath, readAccount: () => '1001', holdsItems: false, exclusive, holds }).guard;
    const b = guardFor({ registryPath, readAccount: () => '2002', holdsItems: false, exclusive, holds }).guard;

    let release!: () => void;
    const writing = new Promise<void>((resolve) => { release = resolve; });
    const runA = a.run!(async () => {
      await writing;
      holds.items = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The connect for B, as connect.ts records it over a bound source.
    writeXGrant(registryPath, '2002', '2026-10-11T09:00:00.000Z');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'x.bookmarks', (current) => ({
      ...current,
      reconnected_at: '2026-10-11T09:00:00.000Z',
      purge_required: { reason: 'account_changed', detected_at: '2026-10-11T09:00:00.000Z' },
    }));
    let bRan = false;
    const runB = b.run!(async () => { bRan = true; }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await runA;

    const failure = await runB;
    expect(failure).toBeInstanceOf(SourceAccountChangedError);
    expect((failure as SourceAccountChangedError).code).toBe('source_account_changed');
    expect(bRan).toBe(false);
    expect(bindingOf(registryPath)).toMatchObject({
      provider_account_id: '1001',
      purge_required: { reason: 'account_changed' },
    });
  });

  test('a lane with no read account yet waits rather than binding', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeXGrant(registryPath, '1001');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'x.bookmarks', () => ({
      provider_account_id: '1001',
      bound_at: '2026-10-11T08:00:00.000Z',
    }));
    const { guard } = guardFor({ registryPath, readAccount: () => undefined, holdsItems: true });
    await expect(guard.assertAccount()).rejects.toMatchObject({ code: 'source_account_unverified' });
  });
});

describe('the X operator routes pass the account check', () => {
  function fakeRuntime(calls: string[]): XBookmarksConnectorStoreRuntime {
    const result = { status: 'idle' as const, counts: {} };
    return {
      store: {} as XBookmarksConnectorStoreRuntime['store'],
      providerUserId: '1001',
      sync: {
        syncHead: async () => { calls.push('syncHead'); return result as never; },
        reconcile: async () => { calls.push('reconcile'); return result as never; },
        diagnoseWindow: async () => { calls.push('diagnoseWindow'); return result as never; },
        lastCompleteReconcileAt: () => undefined,
        completeReconcileWatermark: () => undefined,
        apiUsageStatus: () => ({}) as never,
      },
      contentRecovery: {
        recover: async () => { calls.push('recover'); return {} as never; },
      },
    };
  }

  test('a stopped source refuses Sync now and content recovery with a 409, reading nothing', async () => {
    const calls: string[] = [];
    const runtime = accountCheckedXBookmarksRuntime(fakeRuntime(calls), {
      async assertAccount() {
        throw new SourceAccountChangedError('source_account_changed', 'x.bookmarks is now connected to a different account.');
      },
    });
    for (const run of [
      () => runtime.sync.syncHead(),
      () => runtime.sync.reconcile(),
      () => runtime.contentRecovery.recover(),
    ]) {
      const failure = await run().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(EmailSourceWorkerError);
      expect(failure).toMatchObject({ status: 409, code: 'source_account_changed' });
    }
    expect(calls).toEqual([]);
    // The diagnostic stores nothing, so it can still look at a stopped source.
    await runtime.sync.diagnoseWindow!();
    expect(calls).toEqual(['diagnoseWindow']);
  });

  test('a source on its own account runs as before', async () => {
    const calls: string[] = [];
    const checks: string[] = [];
    const runtime = accountCheckedXBookmarksRuntime(fakeRuntime(calls), {
      async assertAccount() { checks.push('check'); },
    });
    await runtime.sync.syncHead();
    await runtime.sync.reconcile();
    await runtime.contentRecovery.recover();
    expect(calls).toEqual(['syncHead', 'reconcile', 'recover']);
    expect(checks).toEqual(['check', 'check', 'check']);
  });
});

describe('X provider identity', () => {
  test('reads the numeric user id from users/me', async () => {
    const id = await fetchProviderAccountId({
      provider: 'x',
      accessToken: 'token',
      fetchImpl: async () => new Response(JSON.stringify({ data: { id: '1001', username: 'someone' } }), { status: 200 }),
    });
    expect(id).toBe('1001');
    await expect(fetchProviderAccountId({
      provider: 'x',
      accessToken: 'token',
      fetchImpl: async () => new Response(JSON.stringify({ data: { id: 'not-numeric' } }), { status: 200 }),
    })).rejects.toThrow('X did not name the connected account.');
  });
});
