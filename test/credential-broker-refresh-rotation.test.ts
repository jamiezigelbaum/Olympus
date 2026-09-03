import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
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

/** How X refuses a refresh token it has already rotated away. */
const X_SPENT_REFRESH_TOKEN_RESPONSE = JSON.stringify({
  error: 'invalid_request',
  error_description: 'Value passed for the refresh token was invalid.',
});

describe('rotating OAuth2 refresh tokens fail closed after a crash mid-refresh', () => {
  test('a valid cached session takes no lease and only the mint path acquires one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-rotation-cache-fast-path-'));
    const statePath = join(dir, 'credential-broker.json');
    try {
      const store = new LeaseCountingOAuth2StateStore(statePath);
      await store.save('x.bookmarks.personal', {
        refreshToken: 'refresh-token-generation-1',
        status: 'available',
      });
      let refreshCalls = 0;
      const broker = createEnvCredentialBroker({
        env: X_CLIENT_ENV,
        oauth2StateStore: store,
        oauth2CacheNamespace: `rotation-cache-fast-path-${dir}`,
        fetch: async () => {
          refreshCalls += 1;
          return jsonResponse({
            access_token: 'access-token-generation-2',
            expires_in: 7200,
          });
        },
      });

      const first = await broker.issueSession(X_REQUEST);
      const leaseCallsAfterMint = store.leaseTargetPathCalls;
      const second = await broker.issueSession(X_REQUEST);

      expect(first).toEqual(second);
      expect(refreshCalls).toBe(1);
      expect(leaseCallsAfterMint).toBe(1);
      expect(store.leaseTargetPathCalls).toBe(leaseCallsAfterMint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a real SIGKILL after exchange leaves a marker and the next real process refuses before presenting the stale token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-rotation-crash-'));
    const statePath = join(dir, 'state', 'credential-broker.json');
    const registryPath = join(dir, 'handles.json');
    const exchangeCompletePath = join(dir, 'exchange-complete');
    const staleTokenPresentedPath = join(dir, 'stale-token-presented');
    writeRegisteredXHandle(registryPath);

    try {
      const seed = new JsonCredentialOAuth2StateStore(statePath);
      await seed.save('x.bookmarks.personal', {
        refreshToken: 'refresh-token-generation-1',
        scopes: ['tweet.read', 'bookmark.read', 'offline.access'],
        status: 'available',
        updatedAt: '2026-07-28T02:00:00.000Z',
      });

      const crashed = Bun.spawn([process.execPath, '--eval', crashAfterExchangeScript({
        statePath,
        registryPath,
        exchangeCompletePath,
      })], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await waitForFile(exchangeCompletePath);
      crashed.kill(9);
      const [crashedStderr, crashedExit] = await Promise.all([
        new Response(crashed.stderr).text(),
        crashed.exited,
      ]);
      expect(crashedExit, crashedStderr).not.toBe(0);

      // A half-written store would be unrecoverable, since it holds the only copy
      // of every rotating refresh token.
      const onDisk = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(onDisk).toMatchObject({
        version: 1,
        handles: {
          'x.bookmarks.personal': {
            refreshToken: 'refresh-token-generation-1',
            status: 'available',
            pendingRefreshStartedAt: '2026-07-28T03:00:00.000Z',
          },
        },
      });
      expect(readdirSync(join(dir, 'state')).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);

      const recovered = Bun.spawn([process.execPath, '--eval', recoverAfterCrashScript({
        statePath,
        registryPath,
        staleTokenPresentedPath,
      })], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [recoveredStdout, recoveredStderr, recoveredExit] = await Promise.all([
        new Response(recovered.stdout).text(),
        new Response(recovered.stderr).text(),
        recovered.exited,
      ]);
      expect(recoveredExit, recoveredStderr).toBe(0);
      const result = JSON.parse(recoveredStdout) as { code: string; message: string };
      expect(result.code).toBe('credential_reauth_required');
      expect(result.message).toContain('2026-07-28T03:00:00.000Z');
      expect(result.message).not.toContain('refresh-token-generation-1');
      expect(existsSync(staleTokenPresentedPath)).toBe(false);

      const stored = await new JsonCredentialOAuth2StateStore(statePath).load('x.bookmarks.personal');
      expect(stored?.status).toBe('reauth_required');
      expect(stored?.pendingRefreshStartedAt).toBeUndefined();
      expect(readConnectedHandleRegistry(registryPath).handles[0]).toMatchObject({
        handle: 'x.bookmarks.personal',
        backendState: { status: 'reauth_required' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('state files reject unknown versions and statuses without exposing token material', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-rotation-state-validation-'));
    const path = join(dir, 'state.json');
    try {
      writeFileSync(path, JSON.stringify({
        version: 2,
        handles: {
          'x.bookmarks.personal': { refreshToken: 'do-not-expose-version-token', status: 'available' },
        },
      }));
      const versionError = await new JsonCredentialOAuth2StateStore(path)
        .load('x.bookmarks.personal')
        .catch((error: unknown) => error);
      expect(String(versionError)).toContain('unsupported version');
      expect(String(versionError)).not.toContain('do-not-expose-version-token');

      writeFileSync(path, JSON.stringify({
        version: 1,
        handles: {
          'x.bookmarks.personal': { refreshToken: 'do-not-expose-status-token', status: 'unknown_future_status' },
        },
      }));
      const statusError = await new JsonCredentialOAuth2StateStore(path)
        .load('x.bookmarks.personal')
        .catch((error: unknown) => error);
      expect(String(statusError)).toContain('unsupported status');
      expect(String(statusError)).not.toContain('do-not-expose-status-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a rotation that cannot be stored fails the mint instead of handing out its access token', async () => {
    const events: string[] = [];
    const broker = createEnvCredentialBroker({
      env: X_CLIENT_ENV,
      oauth2StateStore: new FailRotationSave(events),
      oauth2CacheNamespace: 'rotation-save-failure',
      now: () => new Date('2026-07-28T03:00:00.000Z'),
      fetch: async () => jsonResponse({
        access_token: 'access-token-generation-2',
        refresh_token: 'refresh-token-generation-2',
        expires_in: 7200,
      }),
    });

    const error = await broker.issueSession(X_REQUEST).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CredentialBrokerError);
    expect((error as CredentialBrokerError).code).toBe('credential_reauth_required');
    expect((error as CredentialBrokerError).message).toContain('rotated its refresh token');
    expect(String(error)).not.toContain('refresh-token-generation-2');
    expect(String(error)).not.toContain('access-token-generation-2');
    expect(events).toContain('reauth-marked');
  });

  test('the rotated token is on disk before the session is returned, and the marker is retired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-rotation-durable-'));
    const statePath = join(dir, 'credential-broker.json');

    try {
      const store = new JsonCredentialOAuth2StateStore(statePath);
      await store.save('x.bookmarks.personal', {
        refreshToken: 'refresh-token-generation-1',
        status: 'available',
      });
      // Held across the refresh: a descriptor opened before the write keeps
      // reading the bytes it was opened on, so if the store replaced the file
      // rather than truncating it in place, these bytes stay whole and readable.
      const heldBeforeRefresh = openSync(statePath, 'r');

      let stateWhenTokenIssued: unknown;
      const broker = createEnvCredentialBroker({
        env: X_CLIENT_ENV,
        oauth2StateStore: new JsonCredentialOAuth2StateStore(statePath),
        oauth2CacheNamespace: 'rotation-durable-before-return',
        now: () => new Date('2026-07-28T03:00:00.000Z'),
        fetch: async () => jsonResponse({
          access_token: 'access-token-generation-2',
          refresh_token: 'refresh-token-generation-2',
          expires_in: 7200,
          scope: 'tweet.read bookmark.read offline.access',
        }),
      });

      const session = await broker.issueSession(X_REQUEST);
      stateWhenTokenIssued = JSON.parse(readFileSync(statePath, 'utf8'));

      expect(session).toMatchObject({ kind: 'bearer_token', token: 'access-token-generation-2' });
      expect(stateWhenTokenIssued).toMatchObject({
        handles: {
          'x.bookmarks.personal': {
            refreshToken: 'refresh-token-generation-2',
            status: 'available',
            updatedAt: '2026-07-28T03:00:00.000Z',
          },
        },
      });
      expect(readFileSync(statePath, 'utf8')).not.toContain('pendingRefreshStartedAt');
      // The pre-refresh bytes are still intact and parseable. An in-place
      // truncate-and-rewrite would have left this reader with a torn file --
      // which is the state a crash mid-write would have made permanent.
      expect(JSON.parse(readHeldFile(heldBeforeRefresh))).toMatchObject({
        handles: { 'x.bookmarks.personal': { refreshToken: 'refresh-token-generation-1' } },
      });
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('concurrent saves for different handles keep both rotations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-rotation-concurrent-'));
    const statePath = join(dir, 'credential-broker.json');

    try {
      const store = new JsonCredentialOAuth2StateStore(statePath);
      await Promise.all([
        store.save('x.bookmarks.personal', { refreshToken: 'x-rotation', status: 'available' }),
        store.save('dropbox.personal', { refreshToken: 'dropbox-rotation', status: 'available' }),
      ]);

      // Read-modify-write on a shared file: without serialization the second
      // writer would flush a snapshot taken before the first one landed.
      expect(JSON.parse(readFileSync(statePath, 'utf8')).handles).toMatchObject({
        'x.bookmarks.personal': { refreshToken: 'x-rotation' },
        'dropbox.personal': { refreshToken: 'dropbox-rotation' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('local grant deletion removes only the selected rotating-token state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-rotation-delete-'));
    const statePath = join(dir, 'credential-broker.json');
    try {
      const store = new JsonCredentialOAuth2StateStore(statePath);
      await store.save('x.bookmarks.personal', { refreshToken: 'private-x-generation', status: 'available' });
      await store.save('dropbox.personal', { refreshToken: 'dropbox-rotation', status: 'available' });

      await store.delete('x.bookmarks.personal');

      expect(await store.load('x.bookmarks.personal')).toBeUndefined();
      expect(await store.load('dropbox.personal')).toMatchObject({ refreshToken: 'dropbox-rotation' });
      expect(readFileSync(statePath, 'utf8')).not.toContain('private-x-generation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a provider that refuses a spent refresh token as invalid_request is terminal, not a retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-rotation-terminal-'));
    const registryPath = join(dir, 'handles.json');
    writeRegisteredXHandle(registryPath);

    try {
      const store = new MemoryOAuth2StateStore();
      await store.save('x.bookmarks.personal', { refreshToken: 'refresh-token-generation-1', status: 'available' });
      const broker = createEnvCredentialBroker({
        env: X_CLIENT_ENV,
        handleRegistryPath: registryPath,
        oauth2StateStore: store,
        oauth2CacheNamespace: 'rotation-terminal-invalid-request',
        now: () => new Date('2026-07-28T03:00:00.000Z'),
        fetch: async () => new Response(X_SPENT_REFRESH_TOKEN_RESPONSE, {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      });

      const error = await broker.issueSession(X_REQUEST).catch((reason: unknown) => reason);

      expect((error as CredentialBrokerError).code).toBe('credential_reauth_required');
      expect((await store.load('x.bookmarks.personal'))?.status).toBe('reauth_required');
      expect(readConnectedHandleRegistry(registryPath).handles[0]).toMatchObject({
        backendState: { status: 'reauth_required' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a genuinely malformed token request is not classified terminal, so the refusal itself does not mark the handle reauth_required', async () => {
    const store = new MemoryOAuth2StateStore();
    await store.save('x.bookmarks.personal', { refreshToken: 'refresh-token-generation-1', status: 'available' });
    const broker = createEnvCredentialBroker({
      env: X_CLIENT_ENV,
      oauth2StateStore: store,
      oauth2CacheNamespace: 'rotation-malformed-request',
      now: () => new Date('2026-07-28T03:00:00.000Z'),
      fetch: async () => new Response(JSON.stringify({
        error: 'invalid_request',
        error_description: 'Missing required parameter: grant_type.',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    });

    const error = await broker.issueSession(X_REQUEST).catch((reason: unknown) => reason);

    expect((error as CredentialBrokerError).code).toBe('credential_refresh_failed');
    expect((await store.load('x.bookmarks.personal'))?.status).toBe('available');
    // The attempt stays marked: a refusal this generic does not prove the
    // provider left the refresh token alone.
    expect((await store.load('x.bookmarks.personal'))?.pendingRefreshStartedAt).toBe('2026-07-28T03:00:00.000Z');
  });

  test('a rotation is refused when an environment pin would shadow it on every later read', async () => {
    const store = new MemoryOAuth2StateStore();
    const broker = createEnvCredentialBroker({
      env: {
        ...X_CLIENT_ENV,
        OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_REFRESH_TOKEN: 'pinned-refresh-token',
      },
      oauth2StateStore: store,
      oauth2CacheNamespace: 'rotation-env-pinned',
      now: () => new Date('2026-07-28T03:00:00.000Z'),
      fetch: async () => jsonResponse({
        access_token: 'access-token-generation-2',
        refresh_token: 'refresh-token-generation-2',
        expires_in: 7200,
      }),
    });

    const error = await broker.issueSession(X_REQUEST).catch((reason: unknown) => reason);

    expect((error as CredentialBrokerError).code).toBe('credential_reauth_required');
    expect(String(error)).not.toContain('pinned-refresh-token');
    expect(String(error)).not.toContain('OLYMPUS_CREDENTIAL_X_BOOKMARKS_PERSONAL_OAUTH2_REFRESH_TOKEN');
    expect((await store.load('x.bookmarks.personal'))?.status).toBe('reauth_required');
  });

  test('a failed save with nothing rotated stays an ordinary error and never forces reauthorization', async () => {
    const store = new SeededFailOnOutcomeSave('refresh-token-generation-1');
    const broker = createEnvCredentialBroker({
      env: X_CLIENT_ENV,
      oauth2StateStore: store,
      oauth2CacheNamespace: 'rotation-absent-bookkeeping',
      now: () => new Date('2026-07-28T03:00:00.000Z'),
      fetch: async () => jsonResponse({ access_token: 'access-token-generation-2', expires_in: 7200 }),
    });

    const error = await broker.issueSession(X_REQUEST).catch((reason: unknown) => reason);

    // The provider returned no new refresh token, so the stored one still works.
    // The write failure is worth surfacing but must not condemn a live handle to
    // reauthorization, which is unrecoverable without a human.
    expect(error).toBeInstanceOf(Error);
    expect((error as CredentialBrokerError).code).toBeUndefined();
    expect(store.reauthAttempts).toBe(0);
  });
});

/** Read a descriptor's whole file from position 0, then close it. */
function readHeldFile(descriptor: number): string {
  try {
    const size = fstatSync(descriptor).size;
    const buffer = Buffer.alloc(size);
    readSync(descriptor, buffer, 0, size, 0);
    return buffer.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
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

class LeaseCountingOAuth2StateStore extends JsonCredentialOAuth2StateStore {
  leaseTargetPathCalls = 0;

  override leaseTargetPath(handle: string): string {
    this.leaseTargetPathCalls += 1;
    return super.leaseTargetPath(handle);
  }
}

/** Stands in for the process disappearing once the provider has answered. */
class FailRotationSave implements CredentialOAuth2StateStore {
  constructor(private readonly events: string[]) {}

  async load(): Promise<CredentialOAuth2HandleState | undefined> {
    return { refreshToken: 'refresh-token-generation-1', status: 'available' };
  }

  async save(_handle: string, state: CredentialOAuth2HandleState): Promise<void> {
    if (state.status === 'reauth_required') {
      this.events.push('reauth-marked');
      return;
    }
    if (state.pendingRefreshStartedAt) return;
    throw new Error('state store is read-only');
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
    await Bun.sleep(10);
  }
}

function crashAfterExchangeScript(paths: {
  statePath: string;
  registryPath: string;
  exchangeCompletePath: string;
}): string {
  return `
import { existsSync, writeFileSync } from 'node:fs';
import {
  JsonCredentialOAuth2StateStore,
  createEnvCredentialBroker,
} from './src/workers/credential-broker/index.ts';

const inner = new JsonCredentialOAuth2StateStore(${JSON.stringify(paths.statePath)});
const blockingStore = {
  leaseTargetPath(handle) {
    return inner.leaseTargetPath(handle);
  },
  load(handle) {
    return inner.load(handle);
  },
  async save(handle, state) {
    if (state.refreshToken === 'refresh-token-generation-2' && !state.pendingRefreshStartedAt) {
      writeFileSync(${JSON.stringify(paths.exchangeCompletePath)}, 'provider-exchange-complete\\n');
      while (true) await Bun.sleep(25);
    }
    return inner.save(handle, state);
  },
};
const broker = createEnvCredentialBroker({
  env: ${JSON.stringify(X_CLIENT_ENV)},
  handleRegistryPath: ${JSON.stringify(paths.registryPath)},
  oauth2StateStore: blockingStore,
  oauth2CacheNamespace: 'rotation-real-crash-first-process',
  now: () => new Date('2026-07-28T03:00:00.000Z'),
  fetch: async () => new Response(JSON.stringify({
    access_token: 'access-token-generation-2',
    refresh_token: 'refresh-token-generation-2',
    expires_in: 7200,
    scope: 'tweet.read bookmark.read offline.access',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
});
await broker.issueSession(${JSON.stringify(X_REQUEST)});
`;
}

function recoverAfterCrashScript(paths: {
  statePath: string;
  registryPath: string;
  staleTokenPresentedPath: string;
}): string {
  return `
import { writeFileSync } from 'node:fs';
import {
  JsonCredentialOAuth2StateStore,
  createEnvCredentialBroker,
} from './src/workers/credential-broker/index.ts';

const broker = createEnvCredentialBroker({
  env: ${JSON.stringify(X_CLIENT_ENV)},
  handleRegistryPath: ${JSON.stringify(paths.registryPath)},
  oauth2StateStore: new JsonCredentialOAuth2StateStore(${JSON.stringify(paths.statePath)}),
  oauth2CacheNamespace: 'rotation-real-crash-second-process',
  oauth2LeaseOptions: { acquireTimeoutMs: 2_000, pollIntervalMs: 10, staleAfterMs: 100 },
  now: () => new Date('2026-07-28T04:00:00.000Z'),
  fetch: async () => {
    writeFileSync(${JSON.stringify(paths.staleTokenPresentedPath)}, 'stale token was presented\\n');
    return new Response(${JSON.stringify(X_SPENT_REFRESH_TOKEN_RESPONSE)}, {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});
try {
  await broker.issueSession(${JSON.stringify(X_REQUEST)});
  throw new Error('Expected recovery to refuse.');
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
}
`;
}

class SeededFailOnOutcomeSave implements CredentialOAuth2StateStore {
  reauthAttempts = 0;

  constructor(private readonly refreshToken: string) {}

  async load(): Promise<CredentialOAuth2HandleState | undefined> {
    return { refreshToken: this.refreshToken, status: 'available' };
  }

  async save(_handle: string, state: CredentialOAuth2HandleState): Promise<void> {
    if (state.status === 'reauth_required') this.reauthAttempts += 1;
    if (state.pendingRefreshStartedAt) return;
    throw new Error('state store is read-only');
  }
}
