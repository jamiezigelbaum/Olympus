// Owner ruling 2026-08-19: the X usage budgets are Olympus's own artificial
// constraint and gate ROUTINE (scheduled) operations only. Work a human
// initiated — the dashboard Sync now button, the admin/CLI sync surface — is
// never refused by a daily budget or head reserve. The live incident: both
// were refused by daily_cost_guard / head_resource_read_reserve_guard, forcing
// dated env overrides on the private host. Three invariants below: an operator run
// proceeds where the scheduled twin is refused, its usage is still recorded
// truthfully (even past the budget line), and a scheduled run immediately
// after an expensive operator run is still guarded. X's OWN rate limit is not
// ours to waive, so provider_rate_limit keeps refusing operator runs whenever
// the provider itself is exhausted. Unknown provenance fails closed to
// scheduled.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import {
  SCHEDULER_SOURCE_IDS,
  SourceScheduler,
  createXBookmarksSchedulerSource,
} from '../src/workers/source-scheduler.ts';
import {
  LocalXBookmarksApiUsageStore,
  XApiUsageGuardError,
  XBookmarksLiveSyncError,
  X_BOOKMARKS_CORPUS_ID,
  createXBookmarksConnectorStoreSyncHandler,
  defaultXBookmarksLiveSyncConfig,
  type XApiUsageStatus,
  type XBookmarkPost,
  type XBookmarksConnectorStoreSyncHandler,
  type XBookmarksLiveSyncConfig,
  type XBookmarksLiveSyncResult,
} from '../src/workers/x-bookmarks/index.ts';

const ACCOUNT = 'personal';
const NOON = new Date('2026-08-19T12:00:00.000Z');

describe('X usage guard invocation provenance', () => {
  test('an operator run proceeds where the scheduled run is refused, records truthfully, and the next scheduled run is still guarded', () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const config = guardTestConfig();
    exhaustSpendBudget(usage, config);

    // Red-first anchor: the scheduled twin is refused by the same guard that
    // refused the live sync-now on 2026-08-19.
    expect(caughtGuard(() => usage.reserveRequest({
      account: ACCOUNT, requestedMaxResources: 6, config, now: NOON,
    }))?.guardKind).toBe('daily_cost_guard');

    const reservation = usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 6,
      provenance: 'operator',
      config,
      now: NOON,
    });
    // Budgets do not clamp an operator reservation either: a grant of less
    // than the request is the same refusal in slow motion.
    expect(reservation.maxResources).toBe(6);
    usage.settleSuccess({
      reservation,
      resourceIds: ['post:op-1', 'post:op-2', 'post:op-3', 'post:op-4', 'post:op-5', 'post:op-6'],
      config,
      now: NOON,
    });

    // Usage is recorded truthfully even though it now stands past the budget.
    expect(usage.status({ account: ACCOUNT, config, now: NOON })).toMatchObject({
      resource_reads: 16,
      estimated_spend_microusd: 16_000,
      guard: { state: 'exhausted', degraded_reason: 'daily_cost_guard' },
    });

    // The exemption is per-run, not a switch: the very next scheduled run is
    // guarded against the total the operator run just spent.
    expect(caughtGuard(() => usage.reserveRequest({
      account: ACCOUNT, requestedMaxResources: 1, config, now: NOON,
    }))?.guardKind).toBe('daily_cost_guard');
    usage.close();
  });

  test('head reserve refusals yield to operator provenance too', () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    // A reserve larger than the whole read budget refuses every background
    // reservation outright — the second guard from the live incident.
    const config = guardTestConfig({ headResourceReadReserve: 1_000 });

    expect(caughtGuard(() => usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 6,
      preserveHeadReserve: true,
      config,
      now: NOON,
    }))?.guardKind).toBe('head_resource_read_reserve_guard');

    const reservation = usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 6,
      preserveHeadReserve: true,
      provenance: 'operator',
      config,
      now: NOON,
    });
    expect(reservation.maxResources).toBe(6);
    usage.close();
  });

  test('the provider rate limit is X-owned and still refuses an operator run, while the low-watermark buffer is ours and does not', () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const config = guardTestConfig({ rateLimitLowWatermark: 12 });
    const resetAt = new Date(NOON.getTime() + 15 * 60_000).toISOString();

    // remaining 5 is above X's own floor but under OUR low watermark: the
    // scheduled background run parks, the operator run proceeds.
    seedRateLimit(usage, config, { limit: 100, remaining: 5, resetAt });
    expect(caughtGuard(() => usage.reserveRequest({
      account: ACCOUNT, requestedMaxResources: 1, preserveHeadReserve: true, config, now: NOON,
    }))?.guardKind).toBe('provider_rate_limit');
    const belowWatermark = usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 1,
      preserveHeadReserve: true,
      provenance: 'operator',
      config,
      now: NOON,
    });
    usage.settleSuccess({ reservation: belowWatermark, resourceIds: ['post:1'], config, now: NOON });

    // remaining 0 until a future reset is X refusing further requests: not
    // Olympus's constraint to waive for anyone.
    seedRateLimit(usage, config, { limit: 100, remaining: 0, resetAt });
    const refused = caughtGuard(() => usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 1,
      provenance: 'operator',
      config,
      now: NOON,
    }));
    expect(refused?.guardKind).toBe('provider_rate_limit');
    expect(refused?.retryAt).toBe(resetAt);
    usage.close();
  });

  test('unknown provenance fails closed to scheduled', () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const config = guardTestConfig();
    exhaustSpendBudget(usage, config);

    expect(caughtGuard(() => usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 1,
      provenance: 'owner' as never,
      config,
      now: NOON,
    }))?.guardKind).toBe('daily_cost_guard');
    usage.close();
  });

  test('an operator dispatch-time count proceeds past the request budget where the scheduled one is refused', () => {
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const config = guardTestConfig({ dailyApiRequestBudget: 1 });
    exhaustSpendBudget(usage, config);

    expect(caughtGuard(() => usage.reserveRequest({
      account: ACCOUNT, requestedMaxResources: 1, countApiRequestOnDispatch: true, config, now: NOON,
    }))?.guardKind).toBe('daily_api_request_guard');

    const reservation = usage.reserveRequest({
      account: ACCOUNT,
      requestedMaxResources: 1,
      countApiRequestOnDispatch: true,
      provenance: 'operator',
      config,
      now: NOON,
    });
    usage.markRequestDispatched({ reservation, config, now: NOON });
    usage.settleSuccess({ reservation, resourceIds: ['post:late'], config, now: NOON });
    expect(usage.status({ account: ACCOUNT, config, now: NOON })).toMatchObject({
      api_requests: 2,
      resource_reads: 11,
    });
    usage.close();
  });

  test('an operator failure and an abandoned operator dispatch both charge the conservative estimate past the budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-operator-provenance-'));
    const usagePath = join(dir, 'x-usage.sqlite');
    const config = guardTestConfig();
    let usage = new LocalXBookmarksApiUsageStore(usagePath);
    try {
      exhaustSpendBudget(usage, config);

      // A failed operator call with an unknown outcome keeps the conservative
      // full charge; the scheduled clamp to remaining budget would record zero.
      const failed = usage.reserveRequest({
        account: ACCOUNT, requestedMaxResources: 4, provenance: 'operator', config, now: NOON,
      });
      usage.settleFailure({ reservation: failed, potentiallyBillable: true, config, now: NOON });
      expect(usage.status({ account: ACCOUNT, config, now: NOON })).toMatchObject({
        resource_reads: 14,
        estimated_spend_microusd: 14_000,
      });

      // Provenance is durable on the reservation: a crash between dispatch and
      // settlement still converts to the full unclamped charge after reopen.
      usage.reserveRequest({
        account: ACCOUNT, requestedMaxResources: 5, provenance: 'operator', config, now: NOON,
      });
      usage.close();
      usage = new LocalXBookmarksApiUsageStore(usagePath);
      const afterLease = new Date(NOON.getTime() + 20 * 60_000);
      expect(usage.status({ account: ACCOUNT, config, now: afterLease })).toMatchObject({
        resource_reads: 19,
        estimated_spend_microusd: 19_000,
      });
    } finally {
      usage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Live 2026-08-21 with the daily guard already exhausted: an operator ran
  // mode=window_diagnostic through the admin surface to investigate the X
  // window, and every probe was refused — diagnostic_requests 3,
  // diagnostic_guarded_requests 3, diagnostic_successful_requests 0. The
  // diagnostic exists to answer an operator's question about the very window
  // whose routine budget is spent, so its probes are sub-requests of an
  // operator invocation and inherit that provenance.
  test('an operator window diagnostic probes where the scheduled diagnostic is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-operator-diagnostic-'));
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'internal.x.bookmarks',
      family: 'x',
      trustDomain: 'internal',
    });
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    try {
      const config = guardTestConfig();
      exhaustSpendBudget(usage, config);
      const handler = createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        embeddingProvider: fakeEmbeddingProvider(),
        account: ACCOUNT,
        now: () => NOON,
        config,
        diagnosticReportPath: join(dir, 'window-diagnostic.json'),
        sourceClient: {
          async fetchBookmarks() {
            return { posts: [bookmark('diag-1', 'diagnostic marker')] };
          },
          async fetchBookmarkFolders() { return { folders: [] }; },
          async fetchBookmarksInFolder() { return { posts: [] }; },
        },
      });

      await expect(handler.diagnoseWindow!({ attempted_at: NOON.toISOString() }))
        .resolves.toMatchObject({
          counts: {
            diagnostic_probes: 4,
            diagnostic_requests: 3,
            diagnostic_guarded_requests: 3,
            diagnostic_successful_requests: 0,
          },
        });

      await expect(handler.diagnoseWindow!({
        attempted_at: NOON.toISOString(),
        provenance: 'operator',
      })).resolves.toMatchObject({
        counts: {
          diagnostic_probes: 4,
          diagnostic_requests: 3,
          diagnostic_guarded_requests: 0,
          diagnostic_successful_requests: 3,
        },
      });
    } finally {
      usage.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Every page of an operator reconcile is a sub-request of one operator
  // invocation: rich global, ID-only verification, folder inventory and folder
  // membership alike. With the daily guard exhausted, a single sub-request
  // that reserved as 'scheduled' would refuse the run, so completing it with
  // folders and memberships observed is the proof that none of them do.
  test('every page of an operator reconcile reserves as operator, including folders and memberships', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'internal.x.bookmarks',
      family: 'x',
      trustDomain: 'internal',
    });
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    try {
      const config = guardTestConfig();
      exhaustSpendBudget(usage, config);
      const folder = { id: 'folder-op', name: 'Operator Folder' };
      const post = bookmark('op-reconcile-1', 'operator reconcile marker');
      const handler = createXBookmarksConnectorStoreSyncHandler({
        store,
        usageStore: usage,
        embeddingProvider: fakeEmbeddingProvider(),
        account: ACCOUNT,
        userId: 'provider-user-1',
        now: () => NOON,
        config,
        sourceClient: {
          async fetchBookmarks(request = {}) {
            return { posts: request.headOnly ? [{ id: post.id }] : [post] };
          },
          async fetchBookmarkFolders() { return { folders: [folder] }; },
          async fetchBookmarksInFolder() { return { posts: [{ id: post.id }] }; },
        },
      });

      const scheduled = handler.reconcile({ attempted_at: NOON.toISOString() });
      await expect(scheduled).rejects.toBeInstanceOf(XBookmarksLiveSyncError);
      await scheduled.catch((error: XBookmarksLiveSyncError) => {
        expect(error.degradedReason).toBe('daily_cost_guard');
      });

      await expect(handler.reconcile({
        attempted_at: NOON.toISOString(),
        provenance: 'operator',
      })).resolves.toMatchObject({
        status: 'progress',
        counts: { folders_seen: 1, folder_memberships_seen: 1 },
      });
    } finally {
      usage.close();
      store.close();
    }
  });

  test('the live handler threads operator provenance from the sync request down to the guard', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'internal.x.bookmarks',
      family: 'x',
      trustDomain: 'internal',
    });
    const usage = new LocalXBookmarksApiUsageStore(':memory:');
    const config = guardTestConfig();
    exhaustSpendBudget(usage, config);
    const handler = createXBookmarksConnectorStoreSyncHandler({
      store,
      usageStore: usage,
      embeddingProvider: fakeEmbeddingProvider(),
      account: ACCOUNT,
      now: () => NOON,
      config,
      sourceClient: {
        async fetchBookmarks() {
          return { posts: [bookmark('op-head-1', 'operator head marker')] };
        },
        async fetchBookmarkFolders() { return { folders: [] }; },
        async fetchBookmarksInFolder() { return { posts: [] }; },
      },
    });

    const scheduled = handler.syncHead({ attempted_at: NOON.toISOString() });
    await expect(scheduled).rejects.toBeInstanceOf(XBookmarksLiveSyncError);
    await scheduled.catch((error: XBookmarksLiveSyncError) => {
      expect(error.degradedReason).toBe('daily_cost_guard');
    });

    await expect(handler.syncHead({
      attempted_at: NOON.toISOString(),
      provenance: 'operator',
    })).resolves.toMatchObject({
      status: 'progress',
      counts: { items_indexed: 1 },
    });

    // The operator run's spend landed in the shared ledger, so the very next
    // scheduled run is still refused.
    await expect(handler.syncHead({ attempted_at: NOON.toISOString() }))
      .rejects.toBeInstanceOf(XBookmarksLiveSyncError);
    usage.close();
    store.close();
  });

  test('the scheduler stamps runSource ticks as operator and due ticks as scheduled', async () => {
    const requests: Array<{ task: string; provenance?: string }> = [];
    const liveSync = capturingLiveSync(requests);
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 60_000,
      errorBackoffMs: 1_000,
      maxTransientRetries: 1,
      now: () => NOON,
      sources: [createXBookmarksSchedulerSource({ config: schedulerConfig(), liveSync })!],
    });

    await scheduler.runSource(SCHEDULER_SOURCE_IDS.xBookmarks, NOON, 'operator');
    expect(requests.map((entry) => entry.provenance)).toEqual(['operator', 'operator']);

    // The head lane is due again one cadence later; its tick must not inherit
    // the earlier manual run's provenance.
    requests.length = 0;
    await scheduler.runDueTasks(new Date(NOON.getTime() + 5 * 60_000));
    for (const entry of requests) expect(entry.provenance).not.toBe('operator');
    expect(requests.length).toBeGreaterThan(0);
  });

  test('the dashboard sync-now route and the admin sync surface both run X with operator provenance', async () => {
    const requests: Array<{ task: string; provenance?: string }> = [];
    const fetch = operatorSurfaceFetch(requests);

    const syncNow = await fetch(operatorSurfaceRequest(DASHBOARD_SYNC_NOW, {
      Authorization: 'Bearer dashboard-secret',
    }));
    expect(syncNow.status).toBe(200);
    expect(requests).toEqual([{ task: 'reconcile', provenance: 'operator' }]);

    requests.length = 0;
    const admin = await fetch(operatorSurfaceRequest(ADMIN_INDEX_SYNC, {
      Authorization: 'Bearer dashboard-secret',
    }));
    expect(admin.status).toBe(200);
    expect(requests).toEqual([{ task: 'head', provenance: 'operator' }]);

    requests.length = 0;
    const diagnostic = await fetch(operatorSurfaceRequest(ADMIN_WINDOW_DIAGNOSTIC, {
      Authorization: 'Bearer dashboard-secret',
    }));
    expect(diagnostic.status).toBe(200);
    expect(requests).toEqual([{ task: 'window_diagnostic', provenance: 'operator' }]);
  });

  // R62 finding 2. These routes are the only surfaces that waive the daily
  // budget, so a caller who reaches either without the worker bearer token
  // gets Olympus's own spending exemption along with the provider bill behind
  // it. The dash_ token is the live near-miss rather than a hypothetical: it
  // is a genuine derived credential an operator can copy straight out of a
  // dashboard URL, it is weaker on purpose, and it authorizes the two
  // read-only dashboard GETs and nothing else. A 401 alone would not settle
  // this — a route that refuses AFTER dispatching the sync has already spent
  // the budget — so every row asserts the X handler was never invoked at all.
  test('every unauthenticated and dash_-token caller is refused at every X operator surface without reaching the handler', async () => {
    const requests: Array<{ task: string; provenance?: string }> = [];
    const fetch = operatorSurfaceFetch(requests);
    const dashToken = dashboardQueryTokenFromWorkerAuthToken('dashboard-secret')!;
    expect(dashToken.startsWith('dash_')).toBe(true);

    // Control: the same guard admits this exact token on the read-only route
    // it was minted for. Without this, the matrix below would pass just as
    // happily on a typo'd token and would prove nothing about scope.
    const sentinel = withWorkerBearerAuth(async () => new Response('reached'), { authToken: 'dashboard-secret' });
    const dashboardRead = await sentinel(new Request(`http://worker.test/dashboard.json?token=${dashToken}`));
    expect(await dashboardRead.text()).toBe('reached');

    const refused: Array<[string, Record<string, string>, string]> = [
      ['no credential at all', {}, ''],
      ['the dash_ URL token pasted into the Authorization header', { Authorization: `Bearer ${dashToken}` }, ''],
      ['the dash_ URL token carried in the query string', {}, `?token=${dashToken}`],
      ['the dash_ token stripped back to the worker secret it derives from', {}, '?token=dashboard-secret'],
      ['a bearer token that is not this worker\'s', { Authorization: 'Bearer not-the-worker-secret' }, ''],
    ];
    for (const surface of X_OPERATOR_SURFACES) {
      for (const [credential, headers, query] of refused) {
        const response = await fetch(operatorSurfaceRequest(surface, headers, query));
        const body = await response.json() as { error?: { code?: string } };
        expect(`${surface.path} with ${credential} -> ${response.status} ${body.error?.code}`)
          .toBe(`${surface.path} with ${credential} -> 401 unauthorized`);
        expect(requests).toEqual([]);
      }
    }

    // Not vacuous: the same path and body, with the worker bearer token, does
    // reach X. Every refusal above was about the credential and nothing else.
    for (const surface of X_OPERATOR_SURFACES) {
      requests.length = 0;
      const allowed = await fetch(operatorSurfaceRequest(surface, { Authorization: 'Bearer dashboard-secret' }));
      expect(allowed.status).toBe(200);
      expect(requests).toEqual([{ task: surface.task, provenance: 'operator' }]);
    }
  });

  // R62 finding 1: the OAuth callback is bearer-exempt by design, and a
  // provider controls when it completes. The post-connect first sync it
  // dispatches must therefore never carry operator provenance.
  test('a provider-controlled OAuth callback never starts an operator run', async () => {
    const requests: Array<{ task: string; provenance?: string }> = [];
    const dir = mkdtempSync(join(tmpdir(), 'olympus-x-provenance-callback-'));
    try {
      const worker = createEmailSourceWorker({
        xBookmarksConnectorStoreSync: capturingLiveSync(requests),
        sourceDashboard: {
          sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
          registryPath: join(dir, 'handles.json'),
          secretStore: memoryProvenanceSecretStore({
            'x.personal.oauth.client_id': 'x-client-id-fixture',
            'x.personal.oauth.client_secret': 'x-client-secret-fixture',
          }),
          startExternalOAuthConnection: async () => ({
            ok: true as const,
            source: 'x' as const,
            authorizationUrl: 'https://x.com/i/oauth2/authorize?state=state-fixture',
            redirectUri: 'http://127.0.0.1:8010/oauth/callback/x',
            state: 'state-fixture',
            startedAt: NOON.toISOString(),
            expiresAt: new Date(NOON.getTime() + 600_000).toISOString(),
            completeCallback: async () => ({
              ok: true as const,
              source: 'x' as const,
              handles: ['x.bookmarks.personal'],
              registryPath: join(dir, 'handles.json'),
              secretRefs: [],
            }),
            cancel() {},
          }),
        },
      });
      const fetch = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });
      const started = await fetch(new Request('http://worker.test/dashboard/connect/oauth/start', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer dashboard-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source: 'x' }),
      }));
      expect(started.status).toBe(200);

      // The callback itself carries no bearer — exactly the exempt surface.
      // A successful callback now redirects (303) to a query-free done page
      // rather than answering 200 directly (MINOR 2, Codex round 2 on
      // 7863a735); the redirect is the completion signal this test cares
      // about — the post-connect sync it dispatches already ran by then.
      const callback = await fetch(new Request(
        'http://worker.test/oauth/callback/x?code=x-code-fixture&state=state-fixture',
      ));
      expect(callback.status).toBe(303);
      expect(requests.length).toBeGreaterThan(0);
      for (const entry of requests) expect(entry.provenance).not.toBe('operator');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // R62 finding 2: a scheduled task context must stay byte-identical to what
  // tasks received before provenance existed — the key itself must be absent,
  // not present with the value 'scheduled'.
  test('a scheduled task context carries no provenance key at all', async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 60_000,
      errorBackoffMs: 1_000,
      maxTransientRetries: 1,
      now: () => NOON,
      sources: [{
        sourceId: 'probe.source',
        corpusId: 'internal.probe',
        cadence: 'continuous',
        intervalMs: 60_000,
        freshnessThresholdHours: 26,
        tasks: [{
          id: 'probe.tick',
          kind: 'sync',
          writer: true,
          intervalMs: 60_000,
          async run(context: Record<string, unknown>) {
            contexts.push(context);
            return { status: 'idle' as const, counts: {} };
          },
        }],
      } as never],
    });

    await scheduler.runDueTasks(NOON);
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) expect('provenance' in context).toBe(false);

    contexts.length = 0;
    await scheduler.runSource('probe.source', NOON, 'operator');
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) expect(context.provenance).toBe('operator');
  });
});

/** The two surfaces an operator uses to start an X run by hand — the only two
 * that carry the budget exemption, and so the only two whose authorization
 * matters this much. */
const DASHBOARD_SYNC_NOW = {
  path: '/dashboard/sync-now',
  task: 'reconcile',
  body: { source: 'x' },
} as const;
const ADMIN_INDEX_SYNC = {
  path: '/v1/source/index/sync',
  task: 'head',
  body: { corpus_id: X_BOOKMARKS_CORPUS_ID, mode: 'head' },
} as const;
const ADMIN_WINDOW_DIAGNOSTIC = {
  path: '/v1/source/index/sync',
  task: 'window_diagnostic',
  body: { corpus_id: X_BOOKMARKS_CORPUS_ID, mode: 'window_diagnostic' },
} as const;
const X_OPERATOR_SURFACES = [
  DASHBOARD_SYNC_NOW,
  ADMIN_INDEX_SYNC,
  ADMIN_WINDOW_DIAGNOSTIC,
] as const;

type XOperatorSurface = typeof X_OPERATOR_SURFACES[number];

function operatorSurfaceRequest(
  surface: XOperatorSurface,
  headers: Record<string, string>,
  query = '',
): Request {
  return new Request(`http://worker.test${surface.path}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(surface.body),
  });
}

function operatorSurfaceFetch(
  requests: Array<{ task: string; provenance?: string }>,
): (request: Request) => Promise<Response> {
  const worker = createEmailSourceWorker({
    xBookmarksConnectorStoreSync: capturingLiveSync(requests),
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
        OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
        OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
      })),
    },
  });
  return withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });
}

function memoryProvenanceSecretStore(initial: Record<string, string>) {
  const secrets = new Map(Object.entries(initial));
  return {
    label: 'memory',
    async get(key: string) {
      return secrets.get(key);
    },
    getSync(key: string) {
      return secrets.get(key);
    },
    async set(key: string, value: string) {
      secrets.set(key, value);
    },
    async delete(key: string) {
      secrets.delete(key);
    },
    async list() {
      return [...secrets.keys()].sort();
    },
  };
}

// Ten spend units of headroom at 1000 microUSD each, no reserves unless a
// test opts in: the daily cost guard is the one that refused the live runs.
function guardTestConfig(overrides: Partial<XBookmarksLiveSyncConfig> = {}): XBookmarksLiveSyncConfig {
  return {
    ...defaultXBookmarksLiveSyncConfig({}),
    dailyApiRequestBudget: 100,
    dailyResourceReadBudget: 100,
    dailyEstimatedSpendMicrousd: 10_000,
    estimatedUnitCostMicrousd: 1_000,
    headApiRequestReserve: 0,
    headResourceReadReserve: 0,
    headEstimatedSpendReserveMicrousd: 0,
    rateLimitLowWatermark: 0,
    richResourceExpansionMultiplier: 1,
    ...overrides,
  };
}

function exhaustSpendBudget(usage: LocalXBookmarksApiUsageStore, config: XBookmarksLiveSyncConfig): void {
  const reservation = usage.reserveRequest({
    account: ACCOUNT, requestedMaxResources: 10, config, now: NOON,
  });
  usage.settleSuccess({
    reservation,
    resourceIds: Array.from({ length: 10 }, (_, index) => `post:seed-${index}`),
    config,
    now: NOON,
  });
}

function seedRateLimit(
  usage: LocalXBookmarksApiUsageStore,
  config: XBookmarksLiveSyncConfig,
  rateLimit: { limit: number; remaining: number; resetAt: string },
): void {
  const reservation = usage.reserveRequest({
    account: ACCOUNT, requestedMaxResources: 1, provenance: 'operator', config, now: NOON,
  });
  usage.settleFailure({ reservation, rateLimit, potentiallyBillable: false, config, now: NOON });
}

function caughtGuard(run: () => unknown): XApiUsageGuardError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof XApiUsageGuardError) return error;
    throw error;
  }
}

function capturingLiveSync(
  requests: Array<{ task: string; provenance?: string }>,
): XBookmarksConnectorStoreSyncHandler {
  const result = (): XBookmarksLiveSyncResult => ({
    status: 'idle',
    counts: {},
    api_usage: usageStatus(),
  });
  return {
    async syncHead(request = {}) {
      requests.push({ task: 'head', ...(request.provenance ? { provenance: request.provenance } : {}) });
      return result();
    },
    async reconcile(request = {}) {
      requests.push({ task: 'reconcile', ...(request.provenance ? { provenance: request.provenance } : {}) });
      return result();
    },
    async diagnoseWindow(request = {}) {
      requests.push({
        task: 'window_diagnostic',
        ...(request.provenance ? { provenance: request.provenance } : {}),
      });
      return result();
    },
    lastCompleteReconcileAt: () => undefined,
    completeReconcileWatermark: () => undefined,
    apiUsageStatus: usageStatus,
  };
}

function usageStatus(): XApiUsageStatus {
  return {
    utc_day: '2026-08-19',
    api_requests: 1,
    resource_reads: 1,
    estimated_billable_resources: 1,
    reserved_resource_reads: 0,
    estimated_spend_microusd: 1_000,
    estimated_spend_usd: 0.001,
    estimated_unit_cost_usd: 0.001,
    estimate: true,
    hard_budgets: {
      api_requests: 4_000,
      resource_reads: 10_000,
      estimated_spend_microusd: 2_000_000,
    },
    guard: { state: 'ok' },
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      resource_ids_exposed: false,
      provider_cursor_exposed: false,
    },
  };
}

function schedulerConfig() {
  return {
    worker: {
      scheduler: {
        enabled: true,
        tickSeconds: 1,
        syncIntervalSeconds: 300,
        freshnessThresholdHours: 24,
        errorBackoffSeconds: 30,
        maxTransientRetries: 1,
      },
    },
  } as never;
}

function bookmark(id: string, text: string): XBookmarkPost {
  return {
    id,
    text,
    createdAt: '2026-08-19T11:59:00.000Z',
    sourceVersion: `v-${id}`,
    url: `https://x.com/i/web/status/${id}`,
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
