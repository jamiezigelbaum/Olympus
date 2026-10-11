// The worker's account check in front of every Dropbox, Drive and Gmail task.
// An account change fails closed: nothing syncs and nothing is deleted until
// the owner removes the previous account's items or reconnects that account.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSourceAccountBindings,
  sourceAccountBindingsPath,
  updateSourceAccountBinding,
} from '../src/core/source-account-binding.ts';
import { upsertConnectedHandle } from '../src/workers/credential-broker/connected-handles.ts';
import type { CredentialBroker, CredentialSessionRequest } from '../src/workers/credential-broker/index.ts';
import {
  accountBoundSchedulerSource,
  createSourceAccountGuard,
  guardAccountBoundLanes,
  SourceAccountChangedError,
} from '../src/workers/source-account-guard.ts';
import { withEmbeddingSweep, type SourceSchedulerSource } from '../src/workers/source-scheduler.ts';
import { readFileSync } from 'node:fs';

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
  storesStale?: boolean;
  restarts?: boolean;
}) {
  let reopenRequests = 0;
  const issued: CredentialSessionRequest[] = [];
  const lookups: string[] = [];
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
    laneStoresStale: () => input.storesStale ?? false,
    requestStoreReopen: () => { reopenRequests += 1; return input.restarts ?? false; },
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
  return { guard, issued, lookups, reopenRequests: () => reopenRequests };
}

function binding(registryPath: string) {
  const read = readSourceAccountBindings(sourceAccountBindingsPath(registryPath));
  return read.kind === 'ok' ? read.bindings.sources['dropbox.files'] : 'malformed';
}

describe('the account guard', () => {
  test('an embedding sweep appended to a lane is guarded with it (independent review round 10)', async () => {
    let swept = 0;
    let synced = 0;
    const withSweep = withEmbeddingSweep([lane(() => { synced += 1; })], () => () => { swept += 1; return []; });
    expect(withSweep[0]!.tasks.map((task) => task.kind)).toEqual(['sync', 'embed']);
    const refusing = { async assertAccount() { throw new SourceAccountChangedError('source_stores_reopen_required', 'reopen'); } };
    const [guarded] = guardAccountBoundLanes(withSweep, new Map([['dropbox.files', refusing]]));
    for (const task of guarded!.tasks) {
      const error = await task.run().catch((reason: unknown) => reason);
      expect((error as SourceAccountChangedError).code).toBe('source_stores_reopen_required');
    }
    expect(swept).toBe(0);
    expect(synced).toBe(0);
    // The worker applies the guards after the sweep is attached, not before.
    const server = readFileSync(new URL('../src/workers/email-source/server.ts', import.meta.url), 'utf8');
    expect(server).toContain('guardAccountBoundLanes(sweptSources, laneGuards)');
    expect(server).not.toContain('accountBoundSchedulerSource(');
  });

  test('stores deleted while the worker stayed up are reopened before anything is decided or synced (PR review)', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:demo');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({
      provider_account_id: 'dbid:main',
      purge_required: { reason: 'account_changed', detected_at: '2026-10-10T22:42:30.000Z' },
    }));
    for (const restarts of [true, false]) {
      const { guard, issued, reopenRequests } = harness({ registryPath, tokenAccount: 'dbid:demo', storesStale: true, restarts });
      let ran = 0;
      const source = accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard });
      const error = await source.tasks[0]!.run().catch((reason: unknown) => reason);
      expect((error as SourceAccountChangedError).code).toBe('source_stores_reopen_required');
      expect((error as Error).message).toContain(restarts ? 'restarting' : 'Restart the Olympus worker');
      expect(reopenRequests()).toBe(1);
      expect(issued).toEqual([]);
      expect(ran).toBe(0);
    }
    // The marker stands until a worker with freshly opened (empty) stores decides.
    expect(binding(registryPath)).toMatchObject({ purge_required: { reason: 'account_changed' } });
    const reopened = harness({ registryPath, tokenAccount: 'dbid:demo', holdsItems: false });
    await accountBoundSchedulerSource({ source: lane(() => undefined), guard: reopened.guard }).tasks[0]!.run();
    expect(binding(registryPath)).toMatchObject({ provider_account_id: 'dbid:demo' });
    expect((binding(registryPath) as { purge_required?: unknown }).purge_required).toBeUndefined();
  });

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

  test('a reconnect to a different account over stored items stops sync and deletes nothing', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:demo');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({ provider_account_id: 'dbid:main' }));
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:demo' });
    let ran = 0;
    const source = accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard });

    const error = await source.tasks[0]!.run().catch((reason: unknown) => reason);
    expect((error as SourceAccountChangedError).code).toBe('source_account_changed');
    // Both routes out, in words: keep (reconnect the previous account) or
    // replace (the deliberate CLI deletion flow).
    expect((error as Error).message).toContain('reconnect the previous account');
    expect((error as Error).message).toContain('olympus data delete --source dropbox.files');
    expect(ran).toBe(0);
    expect(binding(registryPath)).toMatchObject({
      provider_account_id: 'dbid:main',
      purge_required: { reason: 'account_changed' },
    });
    // Asked again, the same answer: it never escalates to deleting anything.
    expect((await source.tasks[0]!.run().catch((reason: unknown) => reason) as SourceAccountChangedError).code)
      .toBe('source_account_changed');
  });

  test('reconnecting the previous account lifts the marker and sync resumes', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:main');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({
      provider_account_id: 'dbid:main',
      purge_required: { reason: 'account_changed', detected_at: '2026-10-10T22:43:00.000Z' },
    }));
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:main' });
    let ran = 0;
    await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run();
    expect(ran).toBe(1);
    expect(binding(registryPath)).toEqual({ provider_account_id: 'dbid:main', bound_at: '2026-10-10T22:43:00.000Z' });
  });

  test('once the owner has removed the previous account\'s items, the new account is bound', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:demo');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({
      provider_account_id: 'dbid:main',
      purge_required: { reason: 'account_changed', detected_at: '2026-10-10T22:43:00.000Z' },
    }));
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:demo', holdsItems: false });
    let ran = 0;
    await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run();
    expect(ran).toBe(1);
    expect(binding(registryPath)).toEqual({ provider_account_id: 'dbid:demo', bound_at: '2026-10-10T22:43:00.000Z' });
  });

  test('a bound source whose token cannot be identified does not sync on the grant\'s word', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:demo');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({ provider_account_id: 'dbid:demo' }));
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:main', identityStatus: 503 });
    let ran = 0;
    const error = await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run()
      .catch((reason: unknown) => reason);
    expect((error as SourceAccountChangedError).code).toBe('source_account_unverified');
    expect(ran).toBe(0);
    expect(binding(registryPath)).toEqual({ provider_account_id: 'dbid:demo' });
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
