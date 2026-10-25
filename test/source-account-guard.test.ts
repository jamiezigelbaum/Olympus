// The worker's account check in front of every Dropbox, Drive and Gmail task.
// An account change fails closed: nothing syncs and nothing is deleted until
// the owner removes the previous account's items or reconnects that account.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSourceAccountBindings,
  recordFileSourceConnect,
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
import { withEmbeddingSweep, withLocalPrivateEmbeddingBackfill, type SourceSchedulerSource } from '../src/workers/source-scheduler.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { DropboxApiMetadataClient } from '../src/workers/dropbox-files/provider-client.ts';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PROVIDER_IDENTITY_ENDPOINTS,
  googleAccountIdFromAddress,
  googleSubjectLabel,
} from '../src/core/provider-account-identity.ts';

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
  /** Shared between harnesses: the stores two lanes of one source both write. */
  holds?: { items: boolean };
  identityStatus?: number;
  storesStale?: boolean;
  restarts?: boolean;
  evidence?: { folders?: string[] | undefined; opens?: boolean | undefined };
  duringCheck?: () => void;
  /** The account registry's account for the source's history, and what the guard told it. */
  history?: { id?: string; unreadable?: boolean; recorded: string[] };
}) {
  let reopenRequests = 0;
  const evidenceCalls = { record: 0, check: [] as string[][] };
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
    laneHoldsItems: () => input.holds ? input.holds.items : input.holdsItems ?? true,
    laneStoresStale: () => input.storesStale ?? false,
    requestStoreReopen: () => { reopenRequests += 1; return input.restarts ?? false; },
    ...(input.history
      ? {
          historyAccount: {
            read: () => {
              if (input.history!.unreadable) throw new Error('registry unreadable');
              return input.history!.id;
            },
            // The registry's rule, for ids compared whole: the first value stays unless the history holds nothing.
            record: (id: string, { historyEmpty }: { historyEmpty: boolean }) => {
              const history = input.history!;
              if (history.id !== undefined && history.id !== id && !historyEmpty) return 'different' as const;
              const result = history.id === id ? 'same' as const : 'recorded' as const;
              history.id = id;
              history.recorded.push(id);
              return result;
            },
          },
        }
      : {}),
    ...(input.evidence
      ? {
          ownAccountEvidence: {
            record: async () => { evidenceCalls.record += 1; return input.evidence!.folders; },
            check: async (_token: string, folderIds: readonly string[]) => {
              evidenceCalls.check.push([...folderIds]);
              input.duringCheck?.();
              return input.evidence!.opens;
            },
          },
        }
      : {}),
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
  return { guard, issued, lookups, evidenceCalls, reopenRequests: () => reopenRequests };
}

function binding(registryPath: string) {
  const read = readSourceAccountBindings(sourceAccountBindingsPath(registryPath));
  return read.kind === 'ok' ? read.bindings.sources['dropbox.files'] : 'malformed';
}

describe('the account guard', () => {
  test('a legacy grant with no readable account records folders only it can open while it is the grant in force (independent review round 13)', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, undefined);
    // The account cannot be read (no account_info.read): the run proceeds unbound and records evidence.
    const legacy = harness({ registryPath, tokenAccount: 'dbid:main', identityStatus: 400, evidence: { folders: ['id:own1', 'id:own2'] } });
    let ran = 0;
    const source = accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard: legacy.guard });
    await source.tasks[0]!.run();
    await source.tasks[0]!.run();
    expect(ran).toBe(2);
    expect(legacy.evidenceCalls.record).toBe(1);
    expect(binding(registryPath)).toEqual({ previous_account_folders: ['id:own1', 'id:own2'] });

    // After a reconnect nothing is recorded: the token may be the new account's.
    const reconnected = join(tempDir(), 'handles.json');
    writeGrant(reconnected, undefined);
    updateSourceAccountBinding(sourceAccountBindingsPath(reconnected), 'dropbox.files', () => ({ reconnected_at: '2026-10-10T22:42:00.000Z' }));
    const after = harness({ registryPath: reconnected, tokenAccount: 'dbid:demo', identityStatus: 400, evidence: { folders: ['id:other'] } });
    await accountBoundSchedulerSource({ source: lane(() => undefined), guard: after.guard }).tasks[0]!.run().catch(() => undefined);
    expect(after.evidenceCalls.record).toBe(0);
    expect(binding(reconnected)).toEqual({ reconnected_at: '2026-10-10T22:42:00.000Z' });
  });

  test('a legacy grant binds on reconnect only when the new token owns a recorded folder (independent review rounds 13-14)', async () => {
    const cases = [
      { folders: ['id:own1', 'id:own2'], opens: true, binds: true },
      { folders: ['id:own1', 'id:own2'], opens: false, binds: false },
      { folders: ['id:own1', 'id:own2'], opens: undefined, binds: false },
      // No evidence was recorded: nothing proves the account, so it fails closed.
      { folders: undefined, opens: true, binds: false },
    ] as const;
    for (const { folders, opens, binds } of cases) {
      const registryPath = join(tempDir(), 'handles.json');
      writeGrant(registryPath, 'dbid:demo');
      updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({
        reconnected_at: '2026-10-10T22:42:00.000Z',
        ...(folders ? { previous_account_folders: [...folders] } : {}),
      }));
      const { guard, evidenceCalls } = harness({ registryPath, tokenAccount: 'dbid:demo', evidence: { opens } });
      let ran = 0;
      const outcome = await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run()
        .catch((reason: unknown) => reason);
      expect(evidenceCalls.check).toEqual(folders ? [[...folders]] : []);
      expect(evidenceCalls.record).toBe(0);
      if (binds) {
        expect(ran).toBe(1);
        expect(binding(registryPath)).toEqual({ provider_account_id: 'dbid:demo', bound_at: '2026-10-10T22:43:00.000Z', bound_grant: '2026-10-10T22:42:00.000Z' });
      } else {
        expect((outcome as SourceAccountChangedError).code).toBe('source_account_changed');
        expect(ran).toBe(0);
        expect(binding(registryPath)).toMatchObject({ purge_required: { reason: 'previous_account_unknown' } });
      }
    }
  });

  test('a reconnect landing while the evidence is checked is never overwritten by the bind (independent review round 14)', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:main');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({
      reconnected_at: '2026-10-10T22:42:00.000Z',
      previous_account_folders: ['id:own1'],
      purge_required: { reason: 'previous_account_unknown', detected_at: '2026-10-10T22:42:30.000Z' },
    }));
    const before = binding(registryPath);
    // Connect B publishes its grant while the provider is being asked; its
    // marker leaves the standing purge as it is.
    const { guard, evidenceCalls } = harness({
      registryPath,
      tokenAccount: 'dbid:main',
      evidence: { opens: true },
      duringCheck: () => writeGrant(registryPath, 'dbid:other', '2026-10-10T22:44:00.000Z'),
    });
    let ran = 0;
    const error = await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run()
      .catch((reason: unknown) => reason);
    expect(evidenceCalls.check).toEqual([['id:own1']]);
    expect((error as SourceAccountChangedError).code).toBe('source_account_unverified');
    expect(ran).toBe(0);
    expect(binding(registryPath)).toEqual(before);
  });

  test("a check for the next account waits for the previous account's run to finish writing", async () => {
    // The Dropbox dashboard hook (no scheduler lane for Dropbox: scheduler
    // disabled, or Dropbox outside its allowlist) runs a freshly built lane's
    // tasks directly, so a Sync now and a post-connect sync can overlap. A's
    // run is admitted and still listing when B is connected and B's run is
    // checked: with the stores still empty, B would bind over A's coming items.
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:A');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({
      provider_account_id: 'dbid:A',
      bound_at: '2026-10-10T22:00:00.000Z',
    }));
    const holds = { items: false };
    const laneOf = (guard: ReturnType<typeof harness>['guard'], run: () => Promise<void>) => accountBoundSchedulerSource({
      guard,
      source: {
        sourceId: 'dropbox.files',
        corpusId: 'dropbox.files.secure',
        cadence: 'continuous',
        intervalMs: 60_000,
        freshnessThresholdHours: 1,
        tasks: [{
          id: 'dropbox.files_store_pull.x',
          kind: 'sync',
          writer: true,
          run: async () => { await run(); return { status: 'progress' }; },
        }],
      },
    }).tasks[0]!;

    let admitted!: () => void;
    const listing = new Promise<void>((resolve) => { admitted = resolve; });
    let release!: () => void;
    const pageFetched = new Promise<void>((resolve) => { release = resolve; });
    const runA = laneOf(harness({ registryPath, tokenAccount: 'dbid:A', holds }).guard, async () => {
      admitted();
      await pageFetched;
      holds.items = true;
    }).run();
    await listing;

    // B is connected, as connect.ts records it over a bound source.
    writeGrant(registryPath, 'dbid:B', '2026-10-10T22:44:00.000Z');
    expect(recordFileSourceConnect({
      registryPath,
      provider: 'dropbox',
      providerAccountId: 'dbid:B',
      now: new Date('2026-10-10T22:44:00.000Z'),
    })).toBe('purge_required');
    let bRan = false;
    const b = harness({ registryPath, tokenAccount: 'dbid:B', holds });
    const runB = laneOf(b.guard, async () => { bRan = true; })
      .run()
      .catch((error: unknown) => error);
    // Unserialized, B's check takes a token at once and decides on it; queued,
    // it has not asked for one while A is still writing.
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(b.issued).toHaveLength(0);
    expect(binding(registryPath)).toMatchObject({ provider_account_id: 'dbid:A', purge_required: { reason: 'account_changed' } });
    release();
    await runA;

    const failure = await runB;
    expect(failure).toBeInstanceOf(SourceAccountChangedError);
    expect((failure as SourceAccountChangedError).code).toBe('source_account_changed');
    expect(bRan).toBe(false);
    expect(binding(registryPath)).toMatchObject({ provider_account_id: 'dbid:A', purge_required: { reason: 'account_changed' } });
  });

  test('a Dropbox read that stalls ends at its deadline, so the next queued run proceeds (PR #267 review, Astra)', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:A');
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:A' });
    // Headers, then a body that never finishes and ignores the abort signal.
    const client = new DropboxApiMetadataClient({
      token: 'token-of-dbid:A',
      requestTimeoutMs: 30,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"entries":[')); },
      }), { status: 200 }),
    });
    const stalled = guard.run!(() => client.listFolder({ path: '', recursive: true, limit: 100 }))
      .then(() => undefined, (error: unknown) => error);
    const next = guard.run!(async () => 'ran');
    expect(((await stalled) as Error).name).toBe('AbortError');
    expect(await next).toBe('ran');
  });

  test('sync, embedding sweep and Private backfill are all stopped by a refusing account guard', async () => {
    let swept = 0;
    let synced = 0;
    let backfilled = 0;
    const store = new LocalConnectorStore({ dbPath: join(tempDir(), 'private.sqlite'), corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local' });
    const provider: SourceEmbeddingProvider = {
      provider: 'built-in', backend: 'local', modelId: 'test', dimension: 2, configHash: 'test', epochId: 'test',
      async embed(inputs) { return inputs.map(() => [1, 0]); },
    };
    try {
      const withSweep = withEmbeddingSweep([lane(() => { synced += 1; })], () => () => { swept += 1; return []; });
      const withBackfill = withLocalPrivateEmbeddingBackfill(withSweep, () => {
        backfilled += 1;
        return [{ store, provider }];
      });
      // Target discovery happens while attaching the task; count only runs.
      backfilled = 0;
      expect(withBackfill[0]!.tasks.map((task) => task.id)).toEqual(['dropbox_sync', 'dropbox.files_embeddings', 'dropbox.files_private_meaning']);
      const refusing = { async assertAccount() { throw new SourceAccountChangedError('source_stores_reopen_required', 'reopen'); } };
      const [guarded] = guardAccountBoundLanes(withBackfill, new Map([['dropbox.files', refusing]]));
      for (const task of guarded!.tasks) {
        const error = await task.run().catch((reason: unknown) => reason);
        expect((error as SourceAccountChangedError).code).toBe('source_stores_reopen_required');
      }
      expect(swept).toBe(0);
      expect(synced).toBe(0);
      expect(backfilled).toBe(0);
      // A permitted run enters the actual backfill task, so the counter proves
      // the refusal above stopped task execution rather than an inert fixture.
      await withBackfill[0]!.tasks[2]!.run();
      expect(backfilled).toBe(1);
      // The worker applies the guards after both embedding tasks are attached.
      const server = readFileSync(new URL('../src/workers/email-source/server.ts', import.meta.url), 'utf8');
      expect(server).toContain('withLocalPrivateEmbeddingBackfill(sweptSources,');
      expect(server).toContain('guardAccountBoundLanes(privateBackfillSources, laneGuards)');
      expect(server).not.toContain('accountBoundSchedulerSource(');
    } finally {
      store.close();
    }
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
    expect(binding(registryPath)).toEqual({ provider_account_id: 'dbid:main', bound_at: '2026-10-10T22:43:00.000Z', bound_grant: '2026-10-10T22:42:00.000Z' });
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
    expect(binding(registryPath)).toEqual({ provider_account_id: 'dbid:demo', bound_at: '2026-10-10T22:43:00.000Z', bound_grant: '2026-10-10T22:42:00.000Z' });
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

describe('the account guard for a Google source known by its subject (independent review P1)', () => {
  const SUB = googleSubjectLabel('109876543210987654321');
  const OLD = googleAccountIdFromAddress('owner@example.test');
  const RENAMED = googleAccountIdFromAddress('renamed@example.test');
  const GRANTED = '2026-10-10T22:42:00.000Z';

  function gmailGuard(registryPath: string, token: { address: string; sub?: string }) {
    upsertConnectedHandle({
      handle: 'gmail.personal',
      provider: 'gmail',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['gmail.email.sync'],
      scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'openid'],
      connectedAt: GRANTED,
      providerAccountId: `${SUB}.${OLD}`,
    }, registryPath);
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'gmail.email', () => ({
      provider_account_id: `${SUB}.${OLD}`,
      bound_grant: GRANTED,
    }));
    const broker: CredentialBroker = {
      async issueSession(request) {
        return {
          kind: 'bearer_token',
          handle: request.handle,
          provider: 'gmail',
          capability: request.capability,
          token: 'gmail-access-token-fixture',
          audit: {
            handle: request.handle,
            provider: 'gmail',
            capability: request.capability,
            scopes: [],
            outcome: 'issued',
            issuedAt: GRANTED,
            rawCredentialExposed: false,
          },
        };
      },
    };
    return createSourceAccountGuard({
      sourceId: 'gmail.email',
      provider: 'gmail',
      handle: 'gmail.personal',
      capability: 'gmail.email.sync',
      registryPath,
      laneHoldsItems: () => true,
      broker,
      fetch: async (url) => {
        if (url === DEFAULT_PROVIDER_IDENTITY_ENDPOINTS.google_tokeninfo) {
          return new Response(JSON.stringify(token.sub
            ? { sub: token.sub, scope: 'openid https://www.googleapis.com/auth/gmail.readonly' }
            : { scope: 'https://www.googleapis.com/auth/gmail.readonly' }), { status: 200 });
        }
        return new Response(JSON.stringify({ emailAddress: token.address }), { status: 200 });
      },
      now: () => new Date('2026-10-11T00:00:00.000Z'),
    });
  }

  function gmailBinding(registryPath: string) {
    const read = readSourceAccountBindings(sourceAccountBindingsPath(registryPath));
    return read.kind === 'ok' ? read.bindings.sources['gmail.email'] : 'malformed';
  }

  test('a token without a subject at the old address (now another account\'s) syncs nothing and marks nothing', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    const guard = gmailGuard(registryPath, { address: 'owner@example.test' });
    let ran = 0;
    const error = await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run()
      .catch((reason: unknown) => reason);
    expect(ran).toBe(0);
    expect(error).toBeInstanceOf(SourceAccountChangedError);
    expect((error as SourceAccountChangedError).code).toBe('source_account_unverified');
    expect(gmailBinding(registryPath)).toEqual({ provider_account_id: `${SUB}.${OLD}`, bound_grant: GRANTED });
  });

  test('the same subject under a renamed address syncs and the binding follows the address', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    const guard = gmailGuard(registryPath, { address: 'renamed@example.test', sub: '109876543210987654321' });
    let ran = 0;
    await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run();
    expect(ran).toBe(1);
    expect(gmailBinding(registryPath)).toEqual({ provider_account_id: `${SUB}.${RENAMED}`, bound_grant: GRANTED });
  });
});

describe('the account its history belongs to (storage step 4e)', () => {
  test('a connect of another account over a history that names its account is held, and nothing is deleted', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:other');
    // An import made the history; the binding names no account yet.
    recordFileSourceConnect({ registryPath, provider: 'dropbox', providerAccountId: 'dbid:other', now: new Date('2026-10-10T22:42:00.000Z') });
    const history = { id: 'dbid:main', recorded: [] as string[] };
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:other', history });
    let ran = 0;
    const outcome = await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run()
      .catch((reason: unknown) => reason);
    expect((outcome as SourceAccountChangedError).code).toBe('source_account_changed');
    expect(ran).toBe(0);
    // A known change, not an unknown previous account; the history keeps its account.
    expect(binding(registryPath)).toMatchObject({ purge_required: { reason: 'account_changed' } });
    expect(history.recorded).toEqual([]);
  });

  test('the account the history names joins it: the binding takes it, and the history is told once', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:main');
    recordFileSourceConnect({ registryPath, provider: 'dropbox', providerAccountId: 'dbid:main', now: new Date('2026-10-10T22:42:00.000Z') });
    const history = { id: 'dbid:main', recorded: [] as string[] };
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:main', history });
    let ran = 0;
    const source = accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard });
    await source.tasks[0]!.run();
    await source.tasks[0]!.run();
    expect(ran).toBe(2);
    expect(binding(registryPath)).toMatchObject({ provider_account_id: 'dbid:main' });
    expect(history.recorded).toEqual(['dbid:main']);
  });

  test('a history that names no account learns the bound one', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:main');
    const history = { recorded: [] as string[] };
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:main', history });
    await accountBoundSchedulerSource({ source: lane(() => undefined), guard }).tasks[0]!.run();
    expect(binding(registryPath)).toMatchObject({ provider_account_id: 'dbid:main' });
    expect(history.recorded).toEqual(['dbid:main']);
  });

  test('another account bound over empty stores relabels the empty history, so an import of the first account no longer joins it (PR #530 review)', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:other');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({ provider_account_id: 'dbid:main', bound_at: '2026-10-10T22:00:00.000Z' }));
    recordFileSourceConnect({ registryPath, provider: 'dropbox', providerAccountId: 'dbid:other', now: new Date('2026-10-10T22:42:00.000Z') });
    const history = { id: 'dbid:main', recorded: [] as string[] };
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:other', holdsItems: false, history });
    let ran = 0;
    await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run();
    expect(ran).toBe(1);
    expect(binding(registryPath)).toMatchObject({ provider_account_id: 'dbid:other' });
    expect(history.id).toBe('dbid:other');
  });

  test('a binding that names another account than a history holding items is refused, whichever wrote first', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:other');
    updateSourceAccountBinding(sourceAccountBindingsPath(registryPath), 'dropbox.files', () => ({ provider_account_id: 'dbid:other', bound_at: '2026-10-10T22:00:00.000Z' }));
    const history = { id: 'dbid:main', recorded: [] as string[] };
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:other', holdsItems: true, history });
    let ran = 0;
    const outcome = await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run()
      .catch((reason: unknown) => reason);
    expect((outcome as SourceAccountChangedError).code).toBe('source_account_changed');
    expect(ran).toBe(0);
    expect(history.id).toBe('dbid:main');
  });

  test('a registry that cannot be read holds the run', async () => {
    const registryPath = join(tempDir(), 'handles.json');
    writeGrant(registryPath, 'dbid:main');
    const history = { unreadable: true, recorded: [] as string[] };
    const { guard } = harness({ registryPath, tokenAccount: 'dbid:main', history });
    let ran = 0;
    const outcome = await accountBoundSchedulerSource({ source: lane(() => { ran += 1; }), guard }).tasks[0]!.run()
      .catch((reason: unknown) => reason);
    expect((outcome as SourceAccountChangedError).code).toBe('source_account_unverified');
    expect(ran).toBe(0);
  });
});
