import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  READWISE_LIBRARY_CORPUS_ID,
  READWISE_RESUME_REJECTED_WARNING,
  READWISE_STORE_PULL_RECEIPT_KIND,
  READWISE_STORE_RECONCILE_RECEIPT_KIND,
  ReadwiseDailyRequestBudget,
  createReadwiseConnectorStore,
  createReadwiseConnectorStoreSyncHandler,
  createReadwiseDailyRequestBudget,
  readwiseReceiptDigest,
  type ReadwiseConnectorStoreSyncHandler,
  type ReadwiseFetch,
  type ReadwiseLiveSyncConfig,
} from '../src/workers/readwise/index.ts';
import {
  SourceScheduler,
  createReadwiseSchedulerSource,
} from '../src/workers/source-scheduler.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import { DeterministicSourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { OlympusConfig } from '../src/core/config.ts';

const ACCOUNT = 'person@example.com';
const DAY = '2026-07-26';
const START = new Date(`${DAY}T10:00:00.000Z`);
const PULL_TASK = {
  sourceId: 'readwise.library',
  corpusId: READWISE_LIBRARY_CORPUS_ID,
  taskId: 'readwise.library_store_pull',
};
const RECONCILE_TASK = { ...PULL_TASK, taskId: 'readwise.library_store_reconcile' };
// A structurally valid resume cursor whose provider page token no longer exists.
const STALE_CURSOR = `rw1:${Buffer.from(JSON.stringify({
  phase: 'reader',
  pageCursor: 'stale-page',
})).toString('base64url')}`;

describe('Readwise dark store: bounded slices, resume, reconcile, and the daily guard', () => {
  test('registers both store tasks, resumes each bounded slice, and clears the checkpoint on a complete traversal', async () => {
    const harness = storeHarness();
    const clock = { now: START };
    const stateStore = new LocalSourceSchedulerStateStore(':memory:');
    // Park the daily reconcile so the bounded-pull round trip is observed alone.
    stateStore.recordSuccess({
      ...RECONCILE_TASK,
      completedAt: START.toISOString(),
      resultStatus: 'idle',
      notBeforeAt: new Date(START.getTime() + 24 * 3_600_000).toISOString(),
    });
    const source = createReadwiseSchedulerSource({
      config: schedulerConfig(),
      liveSync: harness.handler,
      liveConfig: liveConfig({ storePullMaxItems: 2 }),
    })!;
    expect(source.tasks.map((task) => task.id)).toEqual([
      'readwise.library_store_pull',
      'readwise.library_store_reconcile',
    ]);
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 60_000,
      errorBackoffMs: 1_000,
      maxTransientRetries: 1,
      now: () => clock.now,
      stateStore,
      sources: [source],
    });

    try {
      const checkpoints: Array<string | undefined> = [];
      for (let slice = 0; slice < 4; slice += 1) {
        await scheduler.runDueTasks();
        checkpoints.push(stateStore.get(PULL_TASK)?.checkpoint);
        clock.now = new Date(clock.now.getTime() + 15 * 60_000);
      }

      // Three bounded slices leave a durable resume point; the fourth reaches
      // the provider's final page and clears it.
      expect(checkpoints.slice(0, 3).every((value) => typeof value === 'string')).toBe(true);
      expect(new Set(checkpoints.slice(0, 3)).size).toBe(3);
      expect(checkpoints[3]).toBeUndefined();
      expect(harness.calls).toEqual([
        'https://readwise.io/api/v3/list/?limit=2&withHtmlContent=true&withRawSourceUrl=true',
        'https://readwise.io/api/v3/list/?limit=2&pageCursor=reader-2&withHtmlContent=true&withRawSourceUrl=true',
        'https://readwise.io/api/v2/export/',
        'https://readwise.io/api/v2/export/?pageCursor=export-2',
      ]);
      expect(harness.store.status().counts.items).toBe(7);

      const status = scheduler.status();
      expect(status.sources[0]).toMatchObject({
        source_id: 'readwise.library',
        corpus_id: READWISE_LIBRARY_CORPUS_ID,
      });
      const pullStatus = status.sources[0]!.tasks.find((task) => task.id === PULL_TASK.taskId);
      expect(pullStatus?.last_result).toMatchObject({
        status: 'progress',
        counts: { items_seen: 1, resumed_from_checkpoint: 1, traversal_complete: 1 },
      });
      expect(JSON.stringify(status)).not.toContain('PRIVATE_READWISE_MARKER');
    } finally {
      scheduler.stop();
      stateStore.close();
      harness.close();
    }
  });

  test('emits a self-digested counts-only receipt for each store task', async () => {
    const harness = storeHarness();
    try {
      const pull = await harness.handler.pull({ max_items: 2 });
      const { receipt_sha256: pullDigest, ...pullBody } = pull.receipt;
      expect(pullBody).toMatchObject({
        kind: READWISE_STORE_PULL_RECEIPT_KIND,
        status: 'progress',
        counts: {
          api_requests: 1,
          daily_api_request_budget: 50,
          items_seen: 2,
          items_indexed: 2,
          items_tombstoned: 0,
          items_rejected: 0,
          resumed_from_checkpoint: 0,
          resume_cursor_rejected: 0,
          traversal_complete: 0,
          absence_authoritative: 0,
        },
        api_usage: { utc_day: DAY },
        policy: {
          counts_only: true,
          raw_source_exposed: false,
          source_text_returned: false,
          provider_cursor_exposed: false,
          absence_authority: 'partial_window',
          tombstones_applied: false,
        },
      });
      expect(readwiseReceiptDigest(pullBody)).toBe(pullDigest);
      expect(typeof pull.checkpoint).toBe('string');
      expect(JSON.stringify(pull.receipt)).not.toContain('PRIVATE_READWISE_MARKER');
      expect(JSON.stringify(pull.receipt)).not.toContain('reader-2');

      const reconcile = await harness.handler.reconcile();
      const { receipt_sha256: reconcileDigest, ...reconcileBody } = reconcile.receipt;
      expect(reconcileBody.kind).toBe(READWISE_STORE_RECONCILE_RECEIPT_KIND);
      expect(readwiseReceiptDigest(reconcileBody)).toBe(reconcileDigest);
    } finally {
      harness.close();
    }
  });

  test('falls back to a fresh traversal with a counts-only warning when a resumed cursor is rejected', async () => {
    const undecodable = storeHarness();
    try {
      const outcome = await undecodable.handler.pull({
        checkpoint: 'rw1:not-a-real-cursor',
        max_items: 2,
      });
      expect(outcome.receipt.warnings).toEqual([READWISE_RESUME_REJECTED_WARNING]);
      expect(outcome.receipt.counts.resumed_from_checkpoint).toBe(0);
      // The shared scheduler collapses unknown warning tokens, so the rejection
      // has to survive as a count to stay visible in scheduler status.
      expect(outcome.receipt.counts.resume_cursor_rejected).toBe(1);
      expect(outcome.receipt.counts.items_seen).toBe(2);
      expect(undecodable.calls).toEqual([
        'https://readwise.io/api/v3/list/?limit=2&withHtmlContent=true&withRawSourceUrl=true',
      ]);
    } finally {
      undecodable.close();
    }

    const rejected = storeHarness();
    try {
      const outcome = await rejected.handler.pull({ checkpoint: STALE_CURSOR, max_items: 2 });
      expect(outcome.receipt.warnings).toEqual([READWISE_RESUME_REJECTED_WARNING]);
      expect(outcome.receipt.counts.resumed_from_checkpoint).toBe(0);
      // The shared scheduler collapses unknown warning tokens, so the rejection
      // has to survive as a count to stay visible in scheduler status.
      expect(outcome.receipt.counts.resume_cursor_rejected).toBe(1);
      expect(outcome.receipt.counts.items_seen).toBe(2);
      expect(rejected.calls).toEqual([
        'https://readwise.io/api/v3/list/?limit=2&pageCursor=stale-page&withHtmlContent=true&withRawSourceUrl=true',
        'https://readwise.io/api/v3/list/?limit=2&withHtmlContent=true&withRawSourceUrl=true',
      ]);
    } finally {
      rejected.close();
    }
  });

  test('parks the lane to the next UTC day when the daily request guard trips, instead of fail-looping', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-readwise-budget-'));
    const statePath = join(root, 'state', 'readwise-daily-request-budget.json');
    const clock = { now: START };
    const harness = storeHarness({
      requestBudget: createReadwiseDailyRequestBudget({
        env: { OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET: '1' },
        statePath,
        now: () => clock.now,
      }),
      now: () => clock.now,
    });
    const stateStore = new LocalSourceSchedulerStateStore(':memory:');
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 60_000,
      errorBackoffMs: 1_000,
      maxTransientRetries: 3,
      now: () => clock.now,
      stateStore,
      sources: [createReadwiseSchedulerSource({
        config: schedulerConfig(),
        liveSync: harness.handler,
        liveConfig: liveConfig({ storePullMaxItems: 2 }),
      })!],
    });

    try {
      await scheduler.runDueTasks();
      expect(harness.calls).toHaveLength(1);

      clock.now = new Date(clock.now.getTime() + 15 * 60_000);
      await scheduler.runDueTasks();

      // The guard is a planned park: one refusal, no provider request, and the
      // next attempt is the UTC rollover rather than the error backoff.
      expect(harness.calls).toHaveLength(1);
      const parked = stateStore.get(PULL_TASK)!;
      expect(parked.degradedReason).toBe('readwise_daily_api_request_guard');
      // The refusal is typed, not laundered through the untyped task_failed:
      // the health monitor classifies it from the kind alone.
      expect(parked.lastErrorKind).toBe('readwise_daily_api_request_guard');
      expect(parked.notBeforeAt).toBe('2026-07-27T00:00:00.000Z');
      expect(parked.consecutiveFailures).toBe(1);
      const pullStatus = scheduler.status().sources[0]!.tasks
        .find((task) => task.id === PULL_TASK.taskId);
      expect(pullStatus).toMatchObject({
        degraded_reason: 'readwise_daily_api_request_guard',
        last_error_kind: 'readwise_daily_api_request_guard',
        next_run_at: '2026-07-27T00:00:00.000Z',
      });

      // A restart on the same UTC day inherits the spent counter from disk.
      const restored = createReadwiseDailyRequestBudget({
        env: { OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET: '1' },
        statePath,
        now: () => clock.now,
      });
      expect(restored.status()).toEqual({
        utcDay: DAY,
        requests: 1,
        dailyRequestBudget: 1,
      });
      expect(() => restored.reserve()).toThrow('daily_api_request_guard');

      // The counter rolls with the UTC day, not with the process.
      const nextDay = createReadwiseDailyRequestBudget({
        env: { OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET: '1' },
        statePath,
        now: () => new Date('2026-07-27T00:30:00.000Z'),
      });
      expect(nextDay.status().requests).toBe(0);
      nextDay.reserve();
      expect(nextDay.status()).toEqual({
        utcDay: '2026-07-27',
        requests: 1,
        dailyRequestBudget: 1,
      });
    } finally {
      scheduler.stop();
      stateStore.close();
      harness.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reconciles un-cursored and un-bounded, and never claims absence authority', async () => {
    const harness = storeHarness();
    try {
      const bounded = await harness.handler.pull({ max_items: 2 });
      expect(bounded.checkpoint).toBeTruthy();
      expect(harness.store.status().lastSyncRun?.cursor).toBeTruthy();

      harness.calls.length = 0;
      const reconcile = await harness.handler.reconcile();

      // A full snapshot ignores every resume point and every bound: it starts
      // at the first provider page and runs to the done page in one traversal.
      expect(harness.calls[0]).toBe(
        'https://readwise.io/api/v3/list/?limit=100&withHtmlContent=true&withRawSourceUrl=true',
      );
      expect(reconcile.receipt.counts.items_seen).toBe(7);
      expect(reconcile.receipt.counts.traversal_complete).toBe(1);
      expect(reconcile.checkpoint).toBeNull();
      expect(harness.store.status().lastSyncRun?.cursor).toBeUndefined();

      // The provider drops its trailing pages; Readwise export deletion
      // semantics are unverified, so absence preserves the missing items
      // instead of tombstoning them.
      harness.shrink();
      const second = await harness.handler.reconcile();
      expect(second.receipt.counts.items_seen).toBe(4);
      expect(second.receipt.counts.items_tombstoned).toBe(0);
      expect(second.receipt.counts.absence_authoritative).toBe(0);
      expect(harness.store.status().counts).toMatchObject({ items: 7, tombstonedItems: 0 });

      // With no cursor left in the store, the scheduler checkpoint is the
      // remaining resume evidence and is honored.
      harness.calls.length = 0;
      await harness.handler.pull({ checkpoint: bounded.checkpoint!, max_items: 2 });
      expect(harness.calls[0]).toBe(
        'https://readwise.io/api/v3/list/?limit=2&pageCursor=reader-2&withHtmlContent=true&withRawSourceUrl=true',
      );
    } finally {
      harness.close();
    }
  });

  test('fails closed when the connector-store handler is absent', () => {
    expect(createReadwiseSchedulerSource({ config: schedulerConfig() })).toBeUndefined();
  });
});

interface StoreHarness {
  handler: ReadwiseConnectorStoreSyncHandler;
  store: LocalConnectorStore;
  calls: string[];
  shrink(): void;
  close(): void;
}

function storeHarness(options: {
  requestBudget?: ReadwiseDailyRequestBudget;
  now?: () => Date;
} = {}): StoreHarness {
  const root = mkdtempSync(join(tmpdir(), 'olympus-readwise-store-'));
  const store = createReadwiseConnectorStore(join(root, 'readwise-connector.sqlite'));
  const calls: string[] = [];
  const state = { shrunk: false };
  const now = options.now ?? (() => START);
  const handler = createReadwiseConnectorStoreSyncHandler({
    store,
    embeddingProvider: new DeterministicSourceEmbeddingProvider({
      modelId: 'readwise-t3-test',
      epochId: 'cloud:test:readwise-t3-test:v1',
    }),
    account: ACCOUNT,
    credentialBroker: readwiseBroker(),
    fetch: readwiseFetch(calls, state),
    requestBudget: options.requestBudget ?? new ReadwiseDailyRequestBudget({
      dailyRequestBudget: 50,
      now,
    }),
    now,
  });
  return {
    handler,
    store,
    calls,
    shrink: () => {
      state.shrunk = true;
    },
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function liveConfig(overrides: Partial<ReadwiseLiveSyncConfig> = {}): ReadwiseLiveSyncConfig {
  return {
    storePullIntervalMs: 15 * 60_000,
    storePullFreshnessThresholdMs: 60 * 60_000,
    storePullMaxItems: 200,
    storeReconcileIntervalMs: 24 * 60 * 60_000,
    storeReconcileFreshnessThresholdMs: 26 * 60 * 60_000,
    ...overrides,
  };
}

function schedulerConfig(): OlympusConfig {
  return {
    worker: {
      scheduler: {
        enabled: true,
        sourceIds: ['readwise.library'],
        tickSeconds: 1,
        syncIntervalSeconds: 300,
        freshnessThresholdHours: 24,
        errorBackoffSeconds: 30,
        maxTransientRetries: 1,
      },
    },
  } as OlympusConfig;
}

function readwiseBroker(): StaticCredentialBroker {
  return new StaticCredentialBroker([{
    handle: 'readwise.personal',
    provider: 'readwise',
    allowedCapabilities: ['readwise.sync'],
    token: 'broker-token',
    scopes: ['readwise.reader:read', 'readwise.export:read'],
    trustDomain: 'internal',
  }]);
}

// Two reader pages then two export pages: 4 documents + 3 highlights.
function readwiseFetch(calls: string[], state: { shrunk: boolean }): ReadwiseFetch {
  return async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    const pageCursor = parsed.searchParams.get('pageCursor');
    if (pageCursor === 'stale-page') {
      return jsonResponse({ detail: 'invalid pageCursor' }, 400);
    }
    if (parsed.pathname === '/api/v3/list/' && !pageCursor) {
      return jsonResponse({
        count: 2,
        ...(state.shrunk ? {} : { nextPageCursor: 'reader-2' }),
        results: [
          { id: 'reader-1', title: 'Reader one', summary: 'PRIVATE_READWISE_MARKER one' },
          { id: 'reader-2', title: 'Reader two', summary: 'PRIVATE_READWISE_MARKER two' },
        ],
      });
    }
    if (parsed.pathname === '/api/v3/list/') {
      return jsonResponse({
        count: 2,
        results: [
          { id: 'reader-3', title: 'Reader three', summary: 'PRIVATE_READWISE_MARKER three' },
          { id: 'reader-4', title: 'Reader four', summary: 'PRIVATE_READWISE_MARKER four' },
        ],
      });
    }
    if (parsed.pathname === '/api/v2/export/' && !pageCursor) {
      return jsonResponse({
        ...(state.shrunk ? {} : { nextPageCursor: 'export-2' }),
        results: [{
          user_book_id: 'book-42',
          title: 'Book 42',
          highlights: [
            { id: 'highlight-7', text: 'PRIVATE_READWISE_MARKER seven' },
            { id: 'highlight-8', text: 'PRIVATE_READWISE_MARKER eight' },
          ],
        }],
      });
    }
    if (parsed.pathname === '/api/v2/export/') {
      return jsonResponse({
        results: [{
          user_book_id: 'book-99',
          title: 'Book 99',
          highlights: [{ id: 'highlight-9', text: 'PRIVATE_READWISE_MARKER nine' }],
        }],
      });
    }
    return jsonResponse({ error: 'unexpected URL' }, 404);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
