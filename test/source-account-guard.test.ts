// The worker's account check in front of every Dropbox, Drive and Gmail task,
// and the start-up purge it hands off to when a reconnect changed the account.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSourceAccountBindings,
  sourceAccountBindingsPath,
  updateSourceAccountBinding,
} from '../src/core/source-account-binding.ts';
import { upsertConnectedHandle } from '../src/workers/credential-broker/connected-handles.ts';
import type { CredentialBroker, CredentialSessionRequest } from '../src/workers/credential-broker/index.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { defaultDropboxConnectorStoreDbPath } from '../src/workers/dropbox-files/index.ts';
import {
  accountBoundSchedulerSource,
  createSourceAccountGuard,
  SourceAccountChangedError,
} from '../src/workers/source-account-guard.ts';
import { purgeSourcesAwaitingAccountChange } from '../src/workers/source-account-purge.ts';
import type { SourceSchedulerSource } from '../src/workers/source-scheduler.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-source-account-guard-'));
  dirs.push(dir);
  return dir;
}

function writeGrant(registryPath: string, providerAccountId: string | undefined, connectedAt = '2026-10-10T22:42:00.000Z'): void {
  upsertConnectedHandle({
    handle: 'dropbox.personal',
    provider: 'dropbox',
    accountRole: 'personal',
    trustDomain: 'secure_local',
    allowedCapabilities: ['dropbox.files.sync'],
    scopes: ['files.metadata.read', 'files.content.read', 'sharing.read', 'account_info.read'],
    connectedAt,
    ...(providerAccountId ? { providerAccountId } : {}),
  }, registryPath);
}

/** A broker serving one fixed access token, and a provider that says whose it is. */
function harness(input: {
  registryPath: string;
  tokenAccount: string;
  holdsItems?: boolean;
  identityStatus?: number;
}) {
  const issued: CredentialSessionRequest[] = [];
  const lookups: string[] = [];
  let restarts = 0;
  const broker: CredentialBroker = {
    async issueSession(request) {
      issued.push(request);
      return {
        kind: 'bearer_token',
        handle: request.handle,
        provider: 'dropbox',
        capability: request.capability,
        token: `token-of-${input.tokenAccount}`,
        audit: {
          handle: request.handle,
          provider: 'dropbox',
          capability: request.capability,
          scopes: [],
          outcome: 'issued',
          issuedAt: '2026-10-10T22:43:00.000Z',
          rawCredentialExposed: false,
        },
      };
    },
  };
  const guard = createSourceAccountGuard({
    sourceId: 'dropbox.files',
    provider: 'dropbox',
    handle: 'dropbox.personal',
    capability: 'dropbox.files.sync',
    registryPath: input.registryPath,
    laneHoldsItems: () => input.holdsItems ?? true,
    requestPurgeRestart: () => {
      restarts += 1;
      return true;
    },
    broker,
    fetch: async (_url, init) => {
      const token = String((init.headers as Record<string, string>).Authorization).replace('Bearer token-of-', '');
      lookups.push(token);
      return input.identityStatus
        ? new Response('{}', { status: input.identityStatus })
        : new Response(JSON.stringify({ account_id: token }), { status: 200 });
    },
    now: () => new Date('2026-10-10T22:43:00.000Z'),
  });
  return { guard, issued, lookups, restarts: () => restarts };
}

function binding(registryPath: string) {
  const read = readSourceAccountBindings(sourceAccountBindingsPath(registryPath));
  return read.kind === 'ok' ? read.bindings.sources['dropbox.files'] : 'malformed';
}

describe('the account guard', () => {
  test('the 2026-10-10 shape: a cached token for the first account under the second account\'s grant never syncs', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:demo');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({ provider_account_id: 'dbid:main' }));
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:main' });
    let ran = 0;
    const source = accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard });

    const error = await source.tasks[0]!.run().catch((reason: unknown) => reason);
    expect((error as SourceAccountChangedError).code).toBe('source_account_token_mismatch');
    expect(ran).toBe(0);
  });

  test('a reconnect to a different account over stored items stops sync, marks the purge and restarts', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:demo');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({ provider_account_id: 'dbid:main' }));
    const { guard, restarts } = harness({ registryPath, tokenAccount: 'dbid:demo' });
    let ran = 0;
    const source = accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard });

    const error = await source.tasks[0]!.run().catch((reason: unknown) => reason);
    expect((error as SourceAccountChangedError).code).toBe('source_account_changed');
    expect((error as Error).message).toContain('restarting');
    expect(ran).toBe(0);
    expect(restarts()).toBe(1);
    expect(binding(registryPath)).toMatchObject({
      provider_account_id: 'dbid:main',
      purge_required: { reason: 'account_changed' },
    });
  });

  test('the same account proceeds, and the token is looked up once', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:main');
    const { guard, lookups } = harness({ registryPath, tokenAccount: 'dbid:main' });
    let ran = 0;
    const source = accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard });

    await source.tasks[0]!.run();
    await source.tasks[0]!.run();
    expect(ran).toBe(2);
    expect(lookups).toEqual(['dbid:main']);
    expect(binding(registryPath)).toMatchObject({ provider_account_id: 'dbid:main' });
  });

  test('a legacy grant whose token cannot be identified still syncs, unbound, when never reconnected', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, undefined);
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:main', identityStatus: 401 });
    let ran = 0;
    await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run();
    expect(ran).toBe(1);
    expect(binding(registryPath)).toBeUndefined();
  });
});

describe('the start-up purge', () => {
  test('removes the source\'s stores and unbinds it; a source not marked is untouched', () => {
    const dir = tempDir();
    const env = { HOME: join(dir, 'home'), XDG_DATA_HOME: join(dir, 'xdg-data') };
    const registryPath = join(dir, 'handles.json');
    const storePath = defaultDropboxConnectorStoreDbPath(env);
    const store = new LocalConnectorStore({
      dbPath: storePath,
      corpusId: 'secure_local.dropbox.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
    expect(store.holdsAnyItem()).toBe(false);
    store.close();
    expect(existsSync(storePath)).toBe(true);
    const path = sourceAccountBindingsPath(registryPath);
    updateSourceAccountBinding(path, 'dropbox.files', () => ({
      provider_account_id: 'dbid:main',
      purge_required: { reason: 'account_changed', detected_at: '2026-10-10T22:43:00.000Z' },
    }));
    updateSourceAccountBinding(path, 'gmail.email', () => ({ provider_account_id: 'google:abc' }));

    const outcomes = purgeSourcesAwaitingAccountChange({ registryPath, env, homeDir: env.HOME });

    expect(outcomes).toEqual([{ sourceId: 'dropbox.files', status: 'purged', removedPaths: expect.any(Number) }]);
    expect(existsSync(storePath)).toBe(false);
    const read = readSourceAccountBindings(path);
    expect(read.kind === 'ok' && read.bindings.sources).toEqual({ 'gmail.email': { provider_account_id: 'google:abc' } });
  });

  test('does nothing without a marker', () => {
    const dir = tempDir();
    expect(purgeSourcesAwaitingAccountChange({ registryPath: join(dir, 'handles.json'), env: { HOME: dir } })).toEqual([]);
  });
});

function lane(onRun: () => void): SourceSchedulerSource {
  return {
    sourceId: 'dropbox.files',
    corpusId: 'secure_local.dropbox.files',
    cadence: 'continuous',
    intervalMs: 60_000,
    freshnessThresholdHours: 24,
    tasks: [{
      id: 'dropbox_sync',
      kind: 'sync',
      writer: true,
      async run() {
        onRun();
        return { status: 'idle' };
      },
    }],
  };
}
