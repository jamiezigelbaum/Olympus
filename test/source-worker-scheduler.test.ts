import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  SOURCE_SCHEDULER_MAX_FUTURE_DEFERRAL_MS,
  SOURCE_SCHEDULER_SOURCE_IDS_ENV,
  SourceScheduler,
  SourceSchedulerTaskFailure,
  createSourceSchedulerFromConfig,
  createGmailConnectorStoreSchedulerSource,
  createGoogleDriveConnectorStoreSchedulerSource,
  createReadwiseSchedulerSource,
  createXBookmarksSchedulerSource,
  sourceSchedulerSourceIdsFromEnv,
  type SourceSchedulerSource,
  type SourceSchedulerTaskRunResult,
} from '../src/workers/source-scheduler.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import { CredentialBrokerError } from '../src/workers/credential-broker/index.ts';
import { OperationError } from '../src/core/operation-error.ts';
import {
  GMAIL_CONNECTOR_CORPUS_ID,
  GMAIL_STORE_PULL_RECEIPT_KIND,
  GMAIL_STORE_RECONCILE_RECEIPT_KIND,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_STORE_PULL_RECEIPT_KIND,
  GOOGLE_DRIVE_STORE_RECONCILE_RECEIPT_KIND,
  GoogleRequestBudgetError,
  encodeGmailStoreCheckpoint,
  gmailReceiptDigest,
  googleDriveReceiptDigest,
  type GmailConnectorStoreReceipt,
  type GmailConnectorStoreSyncHandler,
  type GmailConnectorStoreTaskOutcome,
  type GmailStorePullRequest,
  type GoogleDriveConnectorStoreReceipt,
  type GoogleDriveConnectorStoreSyncHandler,
  type GoogleDriveConnectorStoreTaskOutcome,
  type GoogleDriveStorePullRequest,
} from '../src/workers/google-connectors/index.ts';
import { READWISE_LIBRARY_CORPUS_ID } from '../src/workers/readwise/index.ts';
import type { OlympusConfig } from '../src/core/config.ts';
import type {
  XBookmarksConnectorStoreSyncHandler,
} from '../src/workers/x-bookmarks/index.ts';
import { XBookmarksLiveSyncError } from '../src/workers/x-bookmarks/index.ts';

describe('source worker scheduler', () => {
  test('a guarded unpark request permits exactly one immediate task attempt without changing cadence', async () => {
    await withSchedulerStateFixture(async (path) => {
      const key = {
        sourceId: 'gmail.email',
        corpusId: 'secure_local.dropbox.files',
        taskId: 'gmail.email_store_pull',
      };
      const store = new LocalSourceSchedulerStateStore(path);
      store.recordFailure({
        ...key,
        completedAt: '2026-07-29T09:00:00.000Z',
        notBeforeAt: '2026-07-30T00:00:00.000Z',
        errorKind: 'gmail_daily_api_request_guard',
        errorHash: '0123456789abcdef',
        degradedReason: 'gmail_daily_api_request_guard',
      });

      const control = store as LocalSourceSchedulerStateStore & {
        requestUnpark(input: {
          sourceId: string;
          taskId: string;
          expectedNotBeforeAt: string;
          reason: string;
          requestedAt: string;
        }): unknown;
      };
      expect(() => control.requestUnpark({
        sourceId: key.sourceId,
        taskId: key.taskId,
        expectedNotBeforeAt: '2026-07-30T01:00:00.000Z',
        reason: 'incident_probe',
        requestedAt: '2026-07-29T10:00:00.000Z',
      })).toThrow(/expected_not_before_mismatch/);
      control.requestUnpark({
        sourceId: key.sourceId,
        taskId: key.taskId,
        expectedNotBeforeAt: '2026-07-30T00:00:00.000Z',
        reason: 'incident_probe',
        requestedAt: '2026-07-29T10:00:00.000Z',
      });

      let runs = 0;
      let now = new Date('2026-07-29T10:00:01.000Z');
      const scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 1,
        now: () => now,
        stateStore: store,
        sources: [source(key.sourceId, 'continuous', 30 * 60_000, undefined, [task(
          key.taskId,
          async () => {
            runs += 1;
            return { status: 'idle' };
          },
        )])],
      });

      const attempted = await scheduler.runDueTasks(now);
      expect(runs).toBe(1);
      expect(attempted.sources[0]?.tasks[0]).toMatchObject({
        interval_seconds: 1_800,
        next_run_at: '2026-07-29T10:30:01.000Z',
      });

      now = new Date('2026-07-29T10:00:02.000Z');
      await scheduler.runDueTasks(now);
      expect(runs).toBe(1);
      store.close();
    });
  });

  test('classifies actionable failures into safe codes and logs only safe retry fields', async () => {
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const malformedConfiguration = source(
        'configuration.source',
        'continuous',
        60_000,
        undefined,
        [task('configuration.sync', async () => {
          throw new SourceSchedulerTaskFailure(
            'private folder path should never reach the log',
            { errorKind: 'config_missing_folder_argument' },
          );
        })],
      );
      const credential = source('credential.source', 'continuous', 60_000, undefined, [task(
        'credential.pull',
        async () => {
          throw new CredentialBrokerError(
            'credential_refresh_failed',
            'private credential handle should never reach the log',
            { handle: 'private.handle', capability: 'private.capability' },
          );
        },
      )]);
      const gmail = createGmailConnectorStoreSchedulerSource({
        config: schedulerConfig(),
        sync: gmailStoreHandler({
          onPull: () => {
            throw new GoogleRequestBudgetError('Gmail', '2026-07-30T00:00:00.000Z');
          },
        }),
      })!;
      const scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 1,
        now: () => new Date('2026-07-29T10:00:00.000Z'),
        sources: [malformedConfiguration, credential, gmail],
      });

      const status = await scheduler.runDueTasks();
      const errorKinds = status.sources.flatMap((entry) =>
        entry.tasks.map((entry) => entry.last_error_kind)
      );
      expect(errorKinds).toContain('config_missing_folder_argument');
      expect(errorKinds).toContain('credential_session_latched');
      expect(errorKinds).toContain('gmail_daily_api_request_guard');
      expect(lines).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'error_kind=gmail_daily_api_request_guard retry_at=2026-07-30T00:00:00.000Z degraded_reason=gmail_daily_api_request_guard',
        ),
      ]));
      expect(lines.join('\n')).toContain('retry_at=');
      expect(lines.join('\n')).toContain('degraded_reason=');
      expect(lines.join('\n')).not.toContain('private folder path');
      expect(lines.join('\n')).not.toContain('private credential handle');
    } finally {
      console.error = originalError;
    }
  });

  test('credential refresh lease contention files a typed short retry instead of task_failed', async () => {
    await withSchedulerStateFixture(async (path) => {
      const stateStore = new LocalSourceSchedulerStateStore(path);
      const scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 24 * 60 * 60_000,
        maxTransientRetries: 1,
        now: () => new Date('2026-07-30T12:00:00.000Z'),
        stateStore,
        sources: [source('credential.source', 'continuous', 60_000, undefined, [task(
          'credential.pull',
          async () => {
            throw new CredentialBrokerError(
              'credential_refresh_busy',
              'private credential handle is refreshing elsewhere',
              { handle: 'private.handle', capability: 'private.capability' },
            );
          },
        )])],
      });

      const status = await scheduler.runDueTasks();
      expect(status.sources[0]?.tasks[0]).toMatchObject({
        last_error_kind: 'credential_refresh_busy',
        degraded_reason: 'credential_refresh_busy',
        next_run_at: '2026-07-30T12:00:30.000Z',
      });
      expect(status.sources[0]?.tasks[0]?.last_error_kind).not.toBe('task_failed');
      stateStore.close();
    });
  });

  // 2026-08-20: "Local source embedding endpoint failed." carried its connect
  // detail in the OperationError suggestion, so safeSchedulerErrorKind's
  // message regexes never matched and every embed-endpoint outage surfaced as
  // untyped task_failed — misattributed to credentials for a whole morning
  // while the real fault was a retired tunnel port.
  test('embedding endpoint failures file a typed kind instead of task_failed', async () => {
    const messages = [
      'Local source embedding endpoint failed.',
      'Local source embedding endpoint returned HTTP 503.',
    ];
    for (const message of messages) {
      await withSchedulerStateFixture(async (path) => {
        const stateStore = new LocalSourceSchedulerStateStore(path);
        const scheduler = new SourceScheduler({
          enabled: true,
          tickMs: 1_000,
          errorBackoffMs: 60_000,
          maxTransientRetries: 1,
          now: () => new Date('2026-08-20T12:00:00.000Z'),
          stateStore,
          sources: [source('dropbox.files', 'continuous', 60_000, undefined, [task(
            'dropbox.embeddings',
            async () => {
              throw new OperationError(
                'source_index_error',
                message,
                'Unable to connect. Is the computer able to access the url?',
              );
            },
          )])],
        });

        const status = await scheduler.runDueTasks();
        expect(status.sources[0]?.tasks[0]?.last_error_kind).toBe('embedding_backend_unavailable');
        expect(status.sources[0]?.tasks[0]?.last_error_kind).not.toBe('task_failed');
        stateStore.close();
      });
    }
  });

  test('preserves reauth-required and missing credential failures as honest scheduler state', async () => {
    await withSchedulerStateFixture(async (path) => {
      const stateStore = new LocalSourceSchedulerStateStore(path);
      const sources = (['credential_reauth_required', 'credential_missing'] as const).map((code) =>
        source(code, 'continuous', 60_000, undefined, [task(`${code}.pull`, async () => {
          throw new CredentialBrokerError(code, 'private credential detail', {
            handle: 'private.handle',
            capability: 'private.capability',
          });
        })]));
      const scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 1,
        now: () => new Date('2026-08-18T12:00:00.000Z'),
        stateStore,
        sources,
      });

      const status = await scheduler.runDueTasks();
      expect(status.sources.map((item) => item.tasks[0]?.last_error_kind)).toEqual([
        'credential_reauth_required',
        'credential_missing',
      ]);
      expect(status.sources.map((item) => item.tasks[0]?.degraded_reason)).toEqual([
        'credential_reauth_required',
        'credential_missing',
      ]);
      expect(status.sources.every((item) => item.tasks[0]?.next_run_at === '2026-08-18T12:00:05.000Z')).toBe(true);
      stateStore.close();
    });
  });

  test('factory scheduler runs unrestricted on an empty allowlist and filters refreshed sources', () => {
    const x = source('x.bookmarks', 'continuous', 30_000, undefined, [task('x.head', async () => ({ status: 'idle' }))]);
    const gmail = source('gmail.email', 'continuous', 60_000, undefined, [task('gmail.sync', async () => ({ status: 'idle' }))]);
    expect(sourceSchedulerSourceIdsFromEnv({})).toEqual([]);
    expect(sourceSchedulerSourceIdsFromEnv({
      [SOURCE_SCHEDULER_SOURCE_IDS_ENV]: 'x.bookmarks, x.bookmarks',
    })).toEqual(['x.bookmarks']);
    expect(() => sourceSchedulerSourceIdsFromEnv({
      [SOURCE_SCHEDULER_SOURCE_IDS_ENV]: 'x.bookmarks,not allowed!',
    })).toThrow('sourceIds entries must be one of');
    expect(() => sourceSchedulerSourceIdsFromEnv({
      [SOURCE_SCHEDULER_SOURCE_IDS_ENV]: 'domain_library.agent_library',
    })).toThrow('sourceIds entries must be one of');

    // A fresh install enables the scheduler before any source is connected, so
    // the configured allowlist is necessarily empty there. Empty means "no
    // operator restriction": every constructed lane runs, and a machine with
    // nothing connected constructs none, so the scheduler simply idles.
    const emptyConfig = schedulerConfig();
    emptyConfig.worker.scheduler.sourceIds = [];
    const emptyStore = new LocalSourceSchedulerStateStore(':memory:');
    const unrestricted = createSourceSchedulerFromConfig({
      config: emptyConfig,
      sources: [x, gmail],
      stateStore: emptyStore,
    });
    expect(unrestricted.status().sources.map((entry) => entry.source_id)).toEqual(['x.bookmarks', 'gmail.email']);

    const idle = createSourceSchedulerFromConfig({
      config: emptyConfig,
      sources: [],
      stateStore: emptyStore,
    });
    expect(idle.status()).toMatchObject({ enabled: true, sources: [], missing_selected_source_ids: [] });
    idle.start();
    expect(idle.status().running).toBe(true);
    // The lane the dashboard connect flow adds after boot is admitted, which
    // an empty allowlist read as fail-closed would have filtered out forever.
    idle.updateSources([gmail]);
    expect(idle.status().sources.map((entry) => entry.source_id)).toEqual(['gmail.email']);
    idle.stop();

    // The class keeps its own contract: an explicit empty list is fail-closed.
    const closedStore = new LocalSourceSchedulerStateStore(':memory:');
    const closed = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      allowedSourceIds: [],
      sources: [x, gmail],
      stateStore: closedStore,
    });
    expect(closed.status().sources).toEqual([]);

    const selectedStore = new LocalSourceSchedulerStateStore(':memory:');
    const selected = createSourceSchedulerFromConfig({
      config: schedulerConfig(),
      sources: [x, gmail],
      stateStore: selectedStore,
    });
    expect(selected.status().sources.map((entry) => entry.source_id)).toEqual(['x.bookmarks']);
    selected.updateSources([gmail, x]);
    expect(selected.status()).toMatchObject({
      selected_source_ids: ['x.bookmarks'],
      missing_selected_source_ids: [],
      sources: [{ source_id: 'x.bookmarks' }],
    });
    selected.updateSources([gmail]);
    expect(selected.status()).toMatchObject({
      selected_source_ids: ['x.bookmarks'],
      missing_selected_source_ids: ['x.bookmarks'],
      sources: [],
    });
    closedStore.close();
    emptyStore.close();
    selectedStore.close();
  });

  test('installs a task-specific fast wake without changing the shared scheduler tick', () => {
    const timers: Array<{ intervalMs: number; callback: () => void }> = [];
    const cleared: unknown[] = [];
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 60_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      sources: [source('x.bookmarks', 'continuous', 30_000, undefined, [{
        ...task('x.bookmarks_head', async () => ({ status: 'idle' })),
        intervalMs: 30_000,
      }])],
      setIntervalImpl: ((callback: () => void, intervalMs: number) => {
        const timer = { intervalMs, callback, unref() {} };
        timers.push(timer);
        return timer;
      }) as unknown as typeof setInterval,
      clearIntervalImpl: ((timer: unknown) => { cleared.push(timer); }) as typeof clearInterval,
    });
    scheduler.start();
    expect(timers.map((timer) => timer.intervalMs).sort((a, b) => a - b)).toEqual([30_000, 60_000]);
    scheduler.stop();
    expect(cleared).toHaveLength(2);
  });

  test('X scheduling fails closed without its connector-store handler', () => {
    expect(createXBookmarksSchedulerSource({ config: schedulerConfig() })).toBeUndefined();

    const liveSync: XBookmarksConnectorStoreSyncHandler = {
      async syncHead() {
        return {
          status: 'idle',
          counts: {},
          api_usage: usageStatus(),
        };
      },
      async reconcile() {
        return {
          status: 'idle',
          counts: {},
          api_usage: usageStatus(),
        };
      },
      lastCompleteReconcileAt: () => '2026-07-17T12:00:00.000Z',
      completeReconcileWatermark: () => ({
        completed_at: '2026-07-17T12:00:00.000Z',
        items_seen: 640,
        folders_seen: 26,
        folder_memberships_seen: 367,
        global_traversal_exhausted: true,
        global_verification_matched: true,
        removal_authoritative: true,
        coverage_scope: 'account_snapshot',
        window_boundary_verified: false,
        traversal_digest_sha256: 'a'.repeat(64),
        traversal_cardinality: 640,
        verification_digest_sha256: 'a'.repeat(64),
        verification_cardinality: 640,
        absence_items_tombstoned: 0,
        out_of_scope_removals: 0,
        folder_inventory_authoritative: true,
        folder_inventory_coverage_gaps: 0,
        folders_carried_forward: 0,
        folder_membership_coverage_gaps: 0,
        folder_provider_outage: false,
        complete_reconciliation_authoritative: true,
        global_current_authority: 'green',
        folder_provenance: 'green',
        staged_recovery: 'not_needed',
      }),
      apiUsageStatus: usageStatus,
    };
    const source = createXBookmarksSchedulerSource({ config: schedulerConfig(), liveSync })!;
    expect(source.tasks.map((entry) => ({ id: entry.id, intervalMs: entry.intervalMs }))).toEqual([
      { id: 'x.bookmarks_head', intervalMs: 30_000 },
      { id: 'x.bookmarks_reconcile', intervalMs: 86_400_000 },
    ]);
    expect(source.tasks[1]?.bootstrapLastSuccessAt?.()).toBe('2026-07-17T12:00:00.000Z');
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 60_000,
      errorBackoffMs: 1_000,
      maxTransientRetries: 1,
      sources: [source],
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    const reconcileStatus = scheduler.status().sources[0]?.tasks
      .find((task) => task.id === 'x.bookmarks_reconcile');
    expect(reconcileStatus).toMatchObject({
      last_success_at: '2026-07-17T12:00:00.000Z',
      last_result: {
        status: 'idle',
        counts: {
          items_seen: 640,
          folders_seen: 26,
          folder_memberships_seen: 367,
          global_traversal_exhausted: 1,
          global_verification_matched: 1,
          removal_authoritative: 1,
        },
      },
    });
  });

  test('retries a content-free temporary X provider failure within the configured bound', async () => {
    let attempts = 0;
    const liveSync: XBookmarksConnectorStoreSyncHandler = {
      async syncHead() {
        attempts += 1;
        if (attempts < 3) {
          throw new XBookmarksLiveSyncError({
            errorKind: 'provider_temporary',
            message: 'Temporary X bookmarks provider failure.',
          });
        }
        return { status: 'idle', counts: {}, api_usage: usageStatus() };
      },
      async reconcile() { return { status: 'idle', counts: {}, api_usage: usageStatus() }; },
      lastCompleteReconcileAt: () => '2026-07-18T12:00:00.000Z',
      completeReconcileWatermark: () => undefined,
      apiUsageStatus: usageStatus,
    };
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 60_000,
      errorBackoffMs: 1,
      maxTransientRetries: 3,
      sleep: async () => {},
      now: () => new Date('2026-07-18T12:00:00.000Z'),
      sources: [createXBookmarksSchedulerSource({ config: schedulerConfig(), liveSync })!],
    });
    await scheduler.runDueTasks();
    expect(attempts).toBe(3);
  });

  test('a non-authoritative daily observation does not refresh X reconciliation freshness', async () => {
    const authoritativeAt = '2026-07-17T10:00:00.000Z';
    const now = new Date('2026-07-18T13:00:00.000Z');
    const liveSync: XBookmarksConnectorStoreSyncHandler = {
      async syncHead() { return { status: 'idle', counts: {}, api_usage: usageStatus() }; },
      async reconcile() {
        throw new XBookmarksLiveSyncError({
          errorKind: 'reconcile_incomplete',
          message: 'ambiguous coverage',
          degradedReason: 'x_reconcile_global_coverage_ambiguous',
          retryAt: '2026-07-18T13:05:00.000Z',
          warnings: ['x_reconcile_authoritative_freshness_not_advanced'],
          counts: {
            global_traversal_exhausted: 1,
            global_verification_matched: 0,
            removal_authoritative: 0,
          },
        });
      },
      lastCompleteReconcileAt: () => authoritativeAt,
      completeReconcileWatermark: () => ({
        completed_at: authoritativeAt,
        items_seen: 640,
        folders_seen: 26,
        folder_memberships_seen: 367,
        global_traversal_exhausted: true,
        global_verification_matched: true,
        removal_authoritative: true,
        coverage_scope: 'account_snapshot',
        window_boundary_verified: false,
        traversal_digest_sha256: 'a'.repeat(64),
        traversal_cardinality: 640,
        verification_digest_sha256: 'a'.repeat(64),
        verification_cardinality: 640,
        absence_items_tombstoned: 0,
        out_of_scope_removals: 0,
        folder_inventory_authoritative: true,
        folder_inventory_coverage_gaps: 0,
        folders_carried_forward: 0,
        folder_membership_coverage_gaps: 0,
        folder_provider_outage: false,
        complete_reconciliation_authoritative: true,
        global_current_authority: 'green',
        folder_provenance: 'green',
        staged_recovery: 'not_needed',
      }),
      apiUsageStatus: usageStatus,
    };
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => now,
      sources: [createXBookmarksSchedulerSource({ config: schedulerConfig(), liveSync })!],
    });
    const status = await scheduler.runDueTasks(now);
    const sourceStatus = status.sources[0]!;
    const reconcile = sourceStatus.tasks.find((task) => task.id === 'x.bookmarks_reconcile')!;
    expect(reconcile).toMatchObject({
      last_success_at: authoritativeAt,
      consecutive_failures: 1,
      degraded_reason: 'x_reconcile_global_coverage_ambiguous',
      stale_anomaly: true,
      last_result: {
        status: 'failed',
        counts: {
          global_verification_matched: 0,
          removal_authoritative: 0,
        },
      },
    });
    expect(sourceStatus.stale_sync_anomaly).toBe(true);
  });

  test('a persistent folder-provenance gap records success and settles to daily cadence', async () => {
    let now = new Date('2026-07-18T12:00:00.000Z');
    let reconciliations = 0;
    const dayMs = 86_400_000;
    const liveSync: XBookmarksConnectorStoreSyncHandler = {
      async syncHead() {
        return { status: 'idle', counts: {}, api_usage: usageStatus() };
      },
      async reconcile() {
        reconciliations += 1;
        return {
          status: 'idle',
          counts: {
            api_requests: 7,
            removal_authoritative: 1,
            global_current_authority: 1,
            folder_provenance_green: 0,
            folder_membership_coverage_gaps: 1,
          },
          warnings: ['x_reconcile_folder_provenance_degraded_daily_cadence'],
          authority: {
            global_current_authority: 'green',
            folder_provenance: 'degraded',
            staged_recovery: 'not_needed',
          },
          retry_at: {
            at: new Date(now.getTime() + dayMs).toISOString(),
            effective_interval_ms: dayMs,
            degraded_reason: 'x_reconcile_folder_provenance_degraded',
          },
          api_usage: usageStatus(),
        };
      },
      lastCompleteReconcileAt: () => undefined,
      completeReconcileWatermark: () => undefined,
      apiUsageStatus: usageStatus,
    };
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => now,
      sources: [createXBookmarksSchedulerSource({ config: schedulerConfig(), liveSync })!],
    });

    let status = await scheduler.runDueTasks(now);
    let reconcile = status.sources[0]!.tasks.find(
      (task) => task.id === 'x.bookmarks_reconcile',
    )!;
    expect(reconciliations).toBe(1);
    expect(reconcile).toMatchObject({
      last_success_at: now.toISOString(),
      consecutive_failures: 0,
      effective_interval_seconds: dayMs / 1_000,
      degraded_reason: 'x_reconcile_folder_provenance_degraded',
      last_result: {
        status: 'idle',
        counts: {
          api_requests: 7,
          global_current_authority: 1,
          folder_provenance_green: 0,
        },
      },
    });

    now = new Date('2026-07-18T12:05:00.000Z');
    status = await scheduler.runDueTasks(now);
    reconcile = status.sources[0]!.tasks.find(
      (task) => task.id === 'x.bookmarks_reconcile',
    )!;
    expect(reconciliations).toBe(1);
    expect(reconcile.last_result?.counts?.api_requests).toBe(7);

    now = new Date('2026-07-19T12:00:00.001Z');
    await scheduler.runDueTasks(now);
    expect(reconciliations).toBe(2);
  });
  test('runs continuous source tasks on cadence and leaves manual sources idle', async () => {
    let now = new Date('2026-07-02T12:00:00.000Z');
    const runs: string[] = [];
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 3,
      now: () => now,
      sleep: async () => {},
      sources: [
        source('dropbox.files', 'continuous', 60_000, () => '2026-07-02T10:30:00.000Z', [
          task('dropbox.metadata_sync', async () => {
            runs.push('sync');
            return { status: 'progress', counts: { jobs_leased: 1 } };
          }),
        ]),
        source('archive.manual', 'manual', 60_000, undefined, [
          task('manual.sync', async () => {
            runs.push('manual');
            return { status: 'progress' };
          }),
        ]),
      ],
    });

    const first = await scheduler.runDueTasks(now);
    now = new Date('2026-07-02T12:00:30.000Z');
    await scheduler.runDueTasks(now);
    now = new Date('2026-07-02T12:01:01.000Z');
    await scheduler.runDueTasks(now);

    expect(runs).toEqual(['sync', 'sync']);
    expect(first.sources[0]).toMatchObject({
      source_id: 'dropbox.files',
      sync_cadence: 'continuous',
      freshness_hours: 1.5,
      stale_sync_anomaly: false,
    });
    expect(first.sources[1]?.tasks[0]?.last_success_at).toBeUndefined();
  });

  test('retries transient failures three times with backoff before succeeding', async () => {
    let attempts = 0;
    let sleeps = 0;
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 25,
      maxTransientRetries: 3,
      now: () => new Date('2026-07-02T12:00:00.000Z'),
      sleep: async (ms) => {
        sleeps += ms;
      },
      sources: [
        source('dropbox.files', 'continuous', 60_000, undefined, [
          task('dropbox.metadata_sync', async () => {
            attempts += 1;
            if (attempts < 3) throw new Error('temporary network timeout');
            return { status: 'progress', counts: { jobs_leased: 1 } };
          }),
        ]),
      ],
    });

    const status = await scheduler.runDueTasks();

    expect(attempts).toBe(3);
    expect(sleeps).toBe(50);
    expect(status.sources[0]?.tasks[0]).toMatchObject({
      consecutive_failures: 0,
      last_result: { status: 'progress', counts: { jobs_leased: 1 } },
    });
  });

  test('backs off after three transient failures without exposing the error text', async () => {
    let attempts = 0;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 3,
      now: () => new Date('2026-07-02T12:00:00.000Z'),
      sleep: async () => {},
      sources: [
        source('dropbox.files', 'continuous', 60_000, undefined, [
          task('dropbox.metadata_sync', async () => {
            attempts += 1;
            throw new Error('temporary provider outage with private path /secret/source');
          }),
        ]),
      ],
    });

    try {
      const status = await scheduler.runDueTasks();
      const serialized = JSON.stringify(status);

      expect(attempts).toBe(3);
      expect(status.sources[0]?.tasks[0]).toMatchObject({
        consecutive_failures: 1,
        last_error_kind: 'temporary',
        last_result: { status: 'failed' },
      });
      expect(status.sources[0]?.tasks[0]?.last_error_hash).toMatch(/^[a-f0-9]{16}$/);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('error_kind=temporary');
      expect(errors[0]).toMatch(/error_hash=[a-f0-9]{16}/);
      expect(serialized).not.toContain('/secret/source');
      expect(serialized).not.toContain('provider outage');
      expect(errors.join('\n')).not.toContain('/secret/source');
      expect(errors.join('\n')).not.toContain('provider outage');
    } finally {
      console.error = originalError;
    }
  });

  test('keeps a single in-process writer active across concurrent ticks', async () => {
    let runs = 0;
    let release!: () => void;
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 3,
      now: () => new Date('2026-07-02T12:00:00.000Z'),
      sleep: async () => {},
      sources: [
        source('dropbox.files', 'continuous', 60_000, undefined, [
          task('dropbox.metadata_sync', async () => {
            runs += 1;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return { status: 'progress' };
          }),
        ]),
      ],
    });

    const first = scheduler.runDueTasks();
    const second = scheduler.runDueTasks();
    release();
    await Promise.all([first, second]);

    expect(runs).toBe(1);
  });

  test('preserves the running state object when sources refresh mid-task', async () => {
    let now = new Date('2026-07-18T12:00:00.000Z');
    let release!: () => void;
    let initialRuns = 0;
    let replacementRuns = 0;
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => now,
      sources: [source('refreshable.source', 'continuous', 60_000, undefined, [
        task('refreshable.sync', async () => {
          initialRuns += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { status: 'idle' };
        }),
      ])],
    });

    const running = scheduler.runDueTasks(now);
    await Promise.resolve();
    expect(initialRuns).toBe(1);

    scheduler.updateSources([
      source('refreshable.source', 'continuous', 60_000, undefined, [
        task('refreshable.sync', async () => {
          replacementRuns += 1;
          return { status: 'idle' };
        }),
      ]),
    ], now);
    await scheduler.runDueTasks(now);
    expect(replacementRuns).toBe(0);

    release();
    await running;
    now = new Date('2026-07-18T12:01:01.000Z');
    await scheduler.runDueTasks(now);
    expect(replacementRuns).toBe(1);
  });

  test('runs different concurrency keys in parallel while serializing tasks that share a key', async () => {
    let releaseDifferent!: () => void;
    const differentGate = new Promise<void>((resolve) => {
      releaseDifferent = resolve;
    });
    const differentStarted: string[] = [];
    let differentActive = 0;
    let maxDifferentActive = 0;
    const differentKeyScheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-07-18T12:00:00.000Z'),
      sources: [source('parallel.sources', 'continuous', 60_000, undefined, [
        {
          ...task('parallel.a', async () => {
            differentStarted.push('a');
            differentActive += 1;
            maxDifferentActive = Math.max(maxDifferentActive, differentActive);
            await differentGate;
            differentActive -= 1;
            return { status: 'idle' };
          }),
          concurrencyKey: 'store.a',
        },
        {
          ...task('parallel.b', async () => {
            differentStarted.push('b');
            differentActive += 1;
            maxDifferentActive = Math.max(maxDifferentActive, differentActive);
            await differentGate;
            differentActive -= 1;
            return { status: 'idle' };
          }),
          concurrencyKey: 'store.b',
        },
      ])],
    });

    const parallelRun = differentKeyScheduler.runDueTasks();
    await Promise.resolve();
    expect(differentStarted.sort()).toEqual(['a', 'b']);
    expect(maxDifferentActive).toBe(2);
    releaseDifferent();
    await parallelRun;

    let releaseShared!: () => void;
    const sharedGate = new Promise<void>((resolve) => {
      releaseShared = resolve;
    });
    const sharedStarted: string[] = [];
    let sharedActive = 0;
    let maxSharedActive = 0;
    const sharedKeyScheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-07-18T12:00:00.000Z'),
      sources: [source('serialized.source', 'continuous', 60_000, undefined, [
        {
          ...task('serialized.a', async () => {
            sharedStarted.push('a');
            sharedActive += 1;
            maxSharedActive = Math.max(maxSharedActive, sharedActive);
            await sharedGate;
            sharedActive -= 1;
            return { status: 'idle' };
          }),
          concurrencyKey: 'shared.store',
        },
        {
          ...task('serialized.b', async () => {
            sharedStarted.push('b');
            sharedActive += 1;
            maxSharedActive = Math.max(maxSharedActive, sharedActive);
            sharedActive -= 1;
            return { status: 'idle' };
          }),
          concurrencyKey: 'shared.store',
        },
      ])],
    });

    const serializedRun = sharedKeyScheduler.runDueTasks();
    await Promise.resolve();
    expect(sharedStarted).toEqual(['a']);
    releaseShared();
    await serializedRun;
    expect(sharedStarted).toEqual(['a', 'b']);
    expect(maxSharedActive).toBe(1);
  });

  test('uses task-owned cadence and bootstrap freshness without an eager restart run', async () => {
    let now = new Date('2026-07-18T12:00:00.000Z');
    let runs = 0;
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => now,
      sources: [source('x.bookmarks', 'continuous', 300_000, undefined, [{
        ...task('x.bookmarks_head', async () => {
          runs += 1;
          return { status: 'idle' };
        }),
        intervalMs: 30_000,
        freshnessThresholdMs: 60_000,
        bootstrapLastSuccessAt: () => '2026-07-18T11:59:45.000Z',
      }])],
    });

    const beforeDue = await scheduler.runDueTasks(now);
    expect(runs).toBe(0);
    expect(beforeDue.sources[0]?.tasks[0]).toMatchObject({
      interval_seconds: 30,
      effective_interval_seconds: 30,
      freshness_threshold_seconds: 60,
      freshness_seconds: 15,
      stale_anomaly: false,
      next_run_at: '2026-07-18T12:00:15.000Z',
    });

    now = new Date('2026-07-18T12:00:16.000Z');
    await scheduler.runDueTasks(now);
    expect(runs).toBe(1);
  });

  // A budget-refused task must stay visibly attempted after a newer external
  // success is adopted (2026-07-26 incident), while the adopted completion —
  // not the preserved attempt — still owns the schedule.
  test('adopting an external success preserves the attempt record without moving the schedule', async () => {
    await withSchedulerStateFixture(async (path) => {
      const now = new Date('2026-07-18T12:09:10.000Z');
      const key = {
        sourceId: 'x.bookmarks',
        corpusId: 'secure_local.dropbox.files',
        taskId: 'x.bookmarks_head',
      };
      let store = new LocalSourceSchedulerStateStore(path);
      store.recordAttempt({ ...key, attemptedAt: '2026-07-18T11:58:00.000Z' });
      store.recordFailure({
        ...key,
        completedAt: '2026-07-18T11:58:01.000Z',
        notBeforeAt: '2026-07-19T00:00:00.000Z',
        errorKind: 'task_failed',
        errorHash: '0123456789abcdef',
        degradedReason: 'daily_api_request_guard',
      });
      store.close();

      store = new LocalSourceSchedulerStateStore(path);
      const scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 1,
        now: () => now,
        stateStore: store,
        sources: [source('x.bookmarks', 'continuous', 300_000, undefined, [{
          ...task('x.bookmarks_head', async () => ({ status: 'idle' })),
          intervalMs: 30_000,
          freshnessThresholdMs: 60_000,
          bootstrapLastSuccessAt: () => '2026-07-18T12:09:00.000Z',
        }])],
      });

      const status = await scheduler.runDueTasks(now);
      expect(status.sources[0]?.tasks[0]).toMatchObject({
        last_attempt_at: '2026-07-18T11:58:00.000Z',
        last_success_at: '2026-07-18T12:09:00.000Z',
        consecutive_failures: 0,
        // Cadence anchor is the adopted completion (12:09:00 + 30s), never
        // the preserved attempt and never the cleared not_before deferral.
        next_run_at: '2026-07-18T12:09:30.000Z',
      });
      expect(status.sources[0]?.tasks[0]?.degraded_reason).toBeUndefined();
      expect(status.sources[0]?.tasks[0]?.last_error_kind).toBeUndefined();
      expect(store.get(key)).toMatchObject({
        attemptPending: false,
        lastAttemptAt: '2026-07-18T11:58:00.000Z',
      });
      store.close();
    });
  });

  // The status report is what the health monitor and the X activation gate
  // classify from. Collapsing explicit guard kinds into task_failed forced both
  // to read degraded_reason as a fallback; a marker outliving its cause then
  // degraded every deploy (live 2026-07-27, `advisory_degraded_reason`).
  test('records refusal and failure kinds honestly, and a recovery clears both markers', async () => {
    await withSchedulerStateFixture(async (path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      let now = new Date('2026-07-27T12:00:00.000Z');
      let outcome: 'refused' | 'incomplete' | 'recovered' = 'refused';
      const scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 1,
        now: () => now,
        stateStore: store,
        sources: [source('x.bookmarks', 'continuous', 30_000, undefined, [task(
          'x.bookmarks_reconcile',
          async () => {
            if (outcome === 'recovered') return { status: 'idle' };
            throw new SourceSchedulerTaskFailure('private provider detail', {
              errorKind: outcome === 'refused' ? 'api_request_guard' : 'reconcile_incomplete',
              retryAt: {
                at: '2026-07-27T13:00:00.000Z',
                degradedReason: outcome === 'refused'
                  ? 'daily_api_request_guard'
                  : 'x_reconcile_incomplete',
              },
            });
          },
        )])],
      });

      try {
        const refused = (await scheduler.runDueTasks(now)).sources[0]!.tasks[0]!;
        expect(refused.last_error_kind).toBe('api_request_guard');
        expect(refused.degraded_reason).toBe('daily_api_request_guard');

        outcome = 'incomplete';
        now = new Date('2026-07-27T13:00:00.000Z');
        const incomplete = (await scheduler.runDueTasks(now)).sources[0]!.tasks[0]!;
        // A bounded traversal is a real failure and must never read as a
        // refusal, whatever marker the previous refusal left behind.
        expect(incomplete.last_error_kind).toBe('reconcile_incomplete');
        expect(incomplete.degraded_reason).toBe('x_reconcile_incomplete');

        outcome = 'recovered';
        now = new Date('2026-07-27T14:00:00.000Z');
        const recovered = (await scheduler.runDueTasks(now)).sources[0]!.tasks[0]!;
        expect(recovered.last_error_kind).toBeUndefined();
        expect(recovered.degraded_reason).toBeUndefined();
        expect(recovered.consecutive_failures).toBe(0);
        expect(store.get({
          sourceId: 'x.bookmarks',
          corpusId: 'secure_local.dropbox.files',
          taskId: 'x.bookmarks_reconcile',
        })?.degradedReason).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  // A daily budget advisory is scoped to the UTC day it was minted for: the
  // budget resets at the rollover, so yesterday's marker is meaningless today.
  // It must expire without waiting for a run, because a task that is not
  // running is exactly what left every deploy degraded on 2026-07-27.
  test('expires a day-scoped budget advisory at the UTC rollover without a further run', async () => {
    await withSchedulerStateFixture(async (path) => {
      const key = {
        sourceId: 'x.bookmarks',
        corpusId: 'secure_local.dropbox.files',
        taskId: 'x.bookmarks_reconcile',
      };
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        store.recordSuccess({
          ...key,
          completedAt: '2026-07-27T23:40:00.000Z',
          resultStatus: 'idle',
          degradedReason: 'daily_api_request_guard',
        });
        // The task never runs again for the rest of this test; only the clock
        // the report is rendered against moves.
        const scheduler = new SourceScheduler({
          enabled: true,
          tickMs: 1_000,
          errorBackoffMs: 5_000,
          maxTransientRetries: 1,
          now: () => new Date('2026-07-27T23:50:00.000Z'),
          stateStore: store,
          sources: [source('x.bookmarks', 'continuous', 30_000, undefined, [task(
            'x.bookmarks_reconcile',
            async () => ({ status: 'idle' }),
          )])],
        });

        const sameDay = scheduler.status(new Date('2026-07-27T23:50:00.000Z'));
        expect(sameDay.sources[0]?.tasks[0]?.degraded_reason).toBe('daily_api_request_guard');

        const nextDay = scheduler.status(new Date('2026-07-28T00:05:00.000Z'));
        expect(nextDay.sources[0]?.tasks[0]?.degraded_reason).toBeUndefined();

        // Expiry is strictly-before, never not-equal: a marker that reads as
        // minted on a *later* day is clock skew, not an expiry, and must keep
        // degrading so `hold:reconcile_clock_ahead` still has something to hold.
        const clockBehind = scheduler.status(new Date('2026-07-26T12:00:00.000Z'));
        expect(clockBehind.sources[0]?.tasks[0]?.degraded_reason).toBe('daily_api_request_guard');

        // The durable marker is untouched -- expiry is a read-side rule, so a
        // clock correction cannot destroy evidence.
        expect(store.get(key)?.degradedReason).toBe('daily_api_request_guard');
      } finally {
        store.close();
      }
    });
  });

  // Only day-scoped budget markers expire. A structural degradation is not
  // repaired by midnight and must survive the rollover untouched.
  test('keeps a non-budget degradation marker across the UTC rollover', async () => {
    await withSchedulerStateFixture(async (path) => {
      const store = new LocalSourceSchedulerStateStore(path);
      try {
        store.recordSuccess({
          sourceId: 'x.bookmarks',
          corpusId: 'secure_local.dropbox.files',
          taskId: 'x.bookmarks_reconcile',
          completedAt: '2026-07-27T23:40:00.000Z',
          resultStatus: 'idle',
          degradedReason: 'x_reconcile_coverage_ambiguous',
        });
        const scheduler = new SourceScheduler({
          enabled: true,
          tickMs: 1_000,
          errorBackoffMs: 5_000,
          maxTransientRetries: 1,
          now: () => new Date('2026-07-28T00:05:00.000Z'),
          stateStore: store,
          sources: [source('x.bookmarks', 'continuous', 30_000, undefined, [task(
            'x.bookmarks_reconcile',
            async () => ({ status: 'idle' }),
          )])],
        });
        expect(scheduler.status().sources[0]?.tasks[0]?.degraded_reason)
          .toBe('x_reconcile_coverage_ambiguous');
      } finally {
        store.close();
      }
    });
  });

  test('reschedules a crash-interrupted pending attempt by the error backoff', async () => {
    await withSchedulerStateFixture(async (path) => {
      const now = new Date('2026-07-18T12:00:10.000Z');
      let store = new LocalSourceSchedulerStateStore(path);
      store.recordAttempt({
        sourceId: 'x.bookmarks',
        corpusId: 'secure_local.dropbox.files',
        taskId: 'x.bookmarks_head',
        attemptedAt: '2026-07-18T12:00:00.000Z',
      });
      store.close();

      store = new LocalSourceSchedulerStateStore(path);
      let runs = 0;
      const scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 30_000,
        maxTransientRetries: 1,
        now: () => now,
        stateStore: store,
        sources: [source('x.bookmarks', 'continuous', 300_000, undefined, [{
          ...task('x.bookmarks_head', async () => {
            runs += 1;
            return { status: 'idle' };
          }),
          intervalMs: 30_000,
          // An older external clock must never adopt over the newer pending
          // attempt, so the attempt-pending backoff still owns the schedule.
          bootstrapLastSuccessAt: () => '2026-07-18T11:59:00.000Z',
        }])],
      });

      const status = await scheduler.runDueTasks(now);
      expect(runs).toBe(0);
      expect(status.sources[0]?.tasks[0]).toMatchObject({
        next_run_at: '2026-07-18T12:00:30.000Z',
        last_attempt_at: '2026-07-18T12:00:00.000Z',
      });
      store.close();
    });
  });

  test('anchors recurring starts to the prior due time across two-second runs and restart', async () => {
    await withSchedulerStateFixture(async (path) => {
      let now = new Date('2026-07-18T12:00:00.000Z');
      const starts: string[] = [];
      const scheduledTask = () => ({
        ...task('x.bookmarks_head', async () => {
          starts.push(now.toISOString());
          now = new Date(now.getTime() + 2_000);
          return { status: 'idle' as const };
        }),
        intervalMs: 30_000,
      });

      let store = new LocalSourceSchedulerStateStore(path);
      let scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 1,
        now: () => now,
        stateStore: store,
        sources: [source('x.bookmarks', 'continuous', 300_000, undefined, [scheduledTask()])],
      });

      let status = await scheduler.runDueTasks(now);
      expect(starts).toEqual(['2026-07-18T12:00:00.000Z']);
      expect(status.sources[0]?.tasks[0]?.next_run_at).toBe('2026-07-18T12:00:30.000Z');

      now = new Date('2026-07-18T12:00:29.000Z');
      await scheduler.runDueTasks(now);
      expect(starts).toHaveLength(1);

      now = new Date('2026-07-18T12:00:30.000Z');
      status = await scheduler.runDueTasks(now);
      expect(starts).toEqual([
        '2026-07-18T12:00:00.000Z',
        '2026-07-18T12:00:30.000Z',
      ]);
      expect(status.sources[0]?.tasks[0]?.next_run_at).toBe('2026-07-18T12:01:00.000Z');
      store.close();

      now = new Date('2026-07-18T12:00:45.000Z');
      store = new LocalSourceSchedulerStateStore(path);
      scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 1,
        now: () => now,
        stateStore: store,
        sources: [source('x.bookmarks', 'continuous', 300_000, undefined, [scheduledTask()])],
      });
      status = await scheduler.runDueTasks(now);
      expect(starts).toHaveLength(2);
      expect(status.sources[0]?.tasks[0]?.next_run_at).toBe('2026-07-18T12:01:00.000Z');

      now = new Date('2026-07-18T12:01:00.000Z');
      status = await scheduler.runDueTasks(now);
      expect(starts).toEqual([
        '2026-07-18T12:00:00.000Z',
        '2026-07-18T12:00:30.000Z',
        '2026-07-18T12:01:00.000Z',
      ]);
      expect(status.sources[0]?.tasks[0]?.next_run_at).toBe('2026-07-18T12:01:30.000Z');
      store.close();
    });
  });

  test('persists checkpoints, attempts, effective cadence, and restart-safe next runs per task', async () => {
    await withSchedulerStateFixture(async (path) => {
      let now = new Date('2026-07-18T12:00:00.000Z');
      const firstContexts: unknown[] = [];
      let store = new LocalSourceSchedulerStateStore(path);
      const first = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 1,
        now: () => now,
        stateStore: store,
        sources: [source('x.bookmarks', 'continuous', 300_000, undefined, [{
          id: 'x.bookmarks_head',
          kind: 'sync',
          writer: true,
          intervalMs: 30_000,
          freshnessThresholdMs: 60_000,
          concurrencyKey: 'x.bookmarks.store',
          async run(context) {
            firstContexts.push(context);
            return {
              status: 'progress',
              counts: { items_indexed: 1 },
              checkpoint: 'bookmark-101',
              retryAt: {
                at: '2026-07-18T12:01:00.000Z',
                effectiveIntervalMs: 60_000,
                degradedReason: 'rate_limit_guard',
              },
            };
          },
        }])],
      });

      const firstStatus = await first.runDueTasks(now);
      expect(firstContexts).toHaveLength(1);
      expect(firstContexts[0]).toMatchObject({
        sourceId: 'x.bookmarks',
        taskId: 'x.bookmarks_head',
        attemptedAt: '2026-07-18T12:00:00.000Z',
        consecutiveFailures: 0,
        effectiveIntervalMs: 30_000,
      });
      expect(firstStatus.sources[0]?.tasks[0]).toMatchObject({
        next_run_at: '2026-07-18T12:01:00.000Z',
        effective_interval_seconds: 60,
        degraded_reason: 'rate_limit_guard',
      });
      store.close();

      now = new Date('2026-07-18T12:00:30.000Z');
      const resumedContexts: unknown[] = [];
      store = new LocalSourceSchedulerStateStore(path);
      const resumed = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 1,
        now: () => now,
        stateStore: store,
        sources: [source('x.bookmarks', 'continuous', 300_000, undefined, [{
          id: 'x.bookmarks_head',
          kind: 'sync',
          writer: true,
          intervalMs: 30_000,
          freshnessThresholdMs: 60_000,
          concurrencyKey: 'x.bookmarks.store',
          bootstrapLastSuccessAt: () => '2026-07-18T10:00:00.000Z',
          async run(context) {
            resumedContexts.push(context);
            return { status: 'idle' };
          },
        }])],
      });

      const beforeRetry = await resumed.runDueTasks(now);
      expect(resumedContexts).toHaveLength(0);
      expect(beforeRetry.sources[0]?.tasks[0]).toMatchObject({
        next_run_at: '2026-07-18T12:01:00.000Z',
        effective_interval_seconds: 60,
        degraded_reason: 'rate_limit_guard',
      });

      now = new Date('2026-07-18T12:01:01.000Z');
      const afterRetry = await resumed.runDueTasks(now);
      expect(resumedContexts[0]).toMatchObject({
        checkpoint: 'bookmark-101',
        lastSuccessAt: '2026-07-18T12:00:00.000Z',
        effectiveIntervalMs: 60_000,
        degradedReason: 'rate_limit_guard',
      });
      expect(afterRetry.sources[0]?.tasks[0]).toMatchObject({
        next_run_at: '2026-07-18T12:01:30.000Z',
        effective_interval_seconds: 30,
      });
      expect(afterRetry.sources[0]?.tasks[0]?.degraded_reason).toBeUndefined();
      expect(store.get({
        sourceId: 'x.bookmarks',
        corpusId: 'secure_local.dropbox.files',
        taskId: 'x.bookmarks_head',
      })).toMatchObject({
        checkpoint: 'bookmark-101',
        lastAttemptAt: '2026-07-18T12:01:01.000Z',
        lastSuccessAt: '2026-07-18T12:01:01.000Z',
        consecutiveFailures: 0,
      });
      store.close();
    });
  });

  test('persists typed failure retry timing and degradation without parsing private error text', async () => {
    const store = new LocalSourceSchedulerStateStore(':memory:');
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    try {
      const scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 3,
        now: () => new Date('2026-07-18T12:00:00.000Z'),
        stateStore: store,
        sources: [source('x.bookmarks', 'continuous', 30_000, undefined, [{
          ...task('x.bookmarks_head', async () => {
            throw new SourceSchedulerTaskFailure('private provider detail /secret/path', {
              errorKind: 'rate_limited',
              warnings: ['rate limit detail'],
              retryAt: {
                at: '2026-07-18T12:02:00.000Z',
                effectiveIntervalMs: 120_000,
                degradedReason: 'provider_backoff',
              },
            });
          }),
          intervalMs: 30_000,
        }])],
      });

      const status = await scheduler.runDueTasks();
      expect(status.sources[0]?.tasks[0]).toMatchObject({
        next_run_at: '2026-07-18T12:02:00.000Z',
        consecutive_failures: 1,
        last_error_kind: 'rate_limited',
        effective_interval_seconds: 120,
        degraded_reason: 'provider_backoff',
        last_result: { status: 'failed', warnings: ['rate_limited'] },
      });
      expect(JSON.stringify(status)).not.toContain('/secret/path');
      expect(errors.join('\n')).not.toContain('/secret/path');
      expect(store.get({
        sourceId: 'x.bookmarks',
        corpusId: 'secure_local.dropbox.files',
        taskId: 'x.bookmarks_head',
      })).toMatchObject({
        effectiveIntervalMs: 120_000,
        degradedReason: 'provider_backoff',
      });
    } finally {
      console.error = originalError;
      store.close();
    }
  });

  test('applies typed failure cadence without a state store and maps unsafe error kinds', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    try {
      const scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 1,
        now: () => new Date('2026-07-18T12:00:00.000Z'),
        sources: [source('unsafe.telemetry', 'continuous', 30_000, undefined, [{
          ...task('unsafe.telemetry_sync', async () => {
            throw new SourceSchedulerTaskFailure('private message /secret/message', {
              errorKind: 'customer/private/rate-limit-secret',
              retryAt: {
                at: '2026-07-18T12:02:00.000Z',
                effectiveIntervalMs: 120_000,
                degradedReason: 'provider_backoff',
              },
            });
          }),
        }])],
      });

      const status = await scheduler.runDueTasks();
      expect(status.sources[0]?.tasks[0]).toMatchObject({
        last_error_kind: 'rate_limited',
        effective_interval_seconds: 120,
        degraded_reason: 'provider_backoff',
      });
      expect(JSON.stringify(status)).not.toContain('customer/private');
      expect(errors.join('\n')).not.toContain('customer/private');
      expect(errors.join('\n')).not.toContain('/secret/message');
    } finally {
      console.error = originalError;
    }
  });

  test('lets an interrupted equal-timestamp attempt override an obsolete deferral on restart', async () => {
    const store = new LocalSourceSchedulerStateStore(':memory:');
    try {
      const key = {
        sourceId: 'x.bookmarks',
        corpusId: 'secure_local.dropbox.files',
        taskId: 'x.bookmarks_head',
      };
      store.recordSuccess({
        ...key,
        completedAt: '2026-07-18T12:00:00.000Z',
        resultStatus: 'idle',
        notBeforeAt: '2099-01-01T00:00:00.000Z',
      });
      store.recordAttempt({ ...key, attemptedAt: '2026-07-18T12:00:00.000Z' });
      let runs = 0;
      const scheduler = new SourceScheduler({
        enabled: true,
        tickMs: 1_000,
        errorBackoffMs: 5_000,
        maxTransientRetries: 1,
        now: () => new Date('2026-07-18T12:00:01.000Z'),
        stateStore: store,
        sources: [source('x.bookmarks', 'continuous', 30_000, undefined, [
          task('x.bookmarks_head', async () => {
            runs += 1;
            return { status: 'idle' };
          }),
        ])],
      });

      const status = await scheduler.runDueTasks();
      expect(runs).toBe(0);
      expect(status.sources[0]?.tasks[0]?.next_run_at).toBe('2026-07-18T12:00:05.000Z');
    } finally {
      store.close();
    }
  });

  test('serializes afterTick delivery and coalesces queued snapshots to the latest status', async () => {
    let now = new Date('2026-07-18T12:00:00.000Z');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markFirstDelivered!: () => void;
    const firstDelivered = new Promise<void>((resolve) => {
      markFirstDelivered = resolve;
    });
    const delivered: string[] = [];
    let active = 0;
    let maxActive = 0;
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => now,
      sources: [],
      afterTick: async (status) => {
        delivered.push(status.generated_at);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (delivered.length === 1) {
          markFirstDelivered();
          await gate;
        }
        active -= 1;
      },
    });

    const first = scheduler.runDueTasks(now);
    await firstDelivered;
    now = new Date('2026-07-18T12:00:01.000Z');
    const second = scheduler.runDueTasks(now);
    now = new Date('2026-07-18T12:00:02.000Z');
    const third = scheduler.runDueTasks(now);
    await Promise.resolve();
    release();
    await Promise.all([first, second, third]);

    expect(delivered).toEqual([
      '2026-07-18T12:00:00.000Z',
      '2026-07-18T12:00:02.000Z',
    ]);
    expect(maxActive).toBe(1);
  });

  test('bounds provider retry clocks and effective cadence to the scheduler safety horizon', async () => {
    const now = new Date('2026-07-18T12:00:00.000Z');
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => now,
      sources: [source('bounded.source', 'continuous', 30_000, undefined, [{
        ...task('bounded.sync', async () => ({
          status: 'idle',
          retryAt: {
            at: '2099-01-01T00:00:00.000Z',
            effectiveIntervalMs: SOURCE_SCHEDULER_MAX_FUTURE_DEFERRAL_MS * 10,
            degradedReason: 'provider_backoff',
          },
        })),
      }])],
    });

    const status = await scheduler.runDueTasks(now);
    expect(status.sources[0]?.tasks[0]).toMatchObject({
      next_run_at: '2026-07-20T12:00:00.000Z',
      effective_interval_seconds: SOURCE_SCHEDULER_MAX_FUTURE_DEFERRAL_MS / 1_000,
      degraded_reason: 'provider_backoff',
    });

    let poisonedRuns = 0;
    const poisonedBootstrap = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => now,
      sources: [source('poisoned.source', 'continuous', 30_000, undefined, [{
        ...task('poisoned.sync', async () => {
          poisonedRuns += 1;
          return { status: 'idle' };
        }),
        bootstrapLastSuccessAt: () => '2099-01-01T00:00:00.000Z',
      }])],
    });
    const poisonedStatus = await poisonedBootstrap.runDueTasks(now);
    expect(poisonedRuns).toBe(0);
    expect(poisonedStatus.sources[0]?.tasks[0]).toMatchObject({
      next_run_at: '2026-07-20T12:00:00.000Z',
      stale_anomaly: true,
    });
  });

  test('filters malformed or potentially private counts before no-store status output', async () => {
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-07-18T12:00:00.000Z'),
      sources: [source('safe.counts', 'continuous', 30_000, undefined, [{
        ...task('safe.counts_sync', async () => ({
          status: 'progress',
          counts: {
            items_indexed: 2,
            '/private/source/path': 1,
            negative: -1,
            fractional: 1.5,
          },
        })),
      }])],
    });

    const status = await scheduler.runDueTasks();
    expect(status.sources[0]?.tasks[0]?.last_result?.counts).toEqual({ items_indexed: 2 });
    expect(JSON.stringify(status)).not.toContain('/private/source/path');
  });

  test('flags stale-sync anomalies from sync age rather than port liveness', () => {
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 3,
      now: () => new Date('2026-07-02T12:00:00.000Z'),
      sources: [
        source('dropbox.files', 'continuous', 60_000, () => '2026-06-30T00:00:00.000Z', [
          task('dropbox.metadata_sync', async () => ({ status: 'idle' })),
        ]),
      ],
    });

    expect(scheduler.status().sources[0]).toMatchObject({
      freshness_hours: 60,
      freshness_threshold_hours: 26,
      stale_sync_anomaly: true,
    });
  });

  test('disabled scheduler proves no behavior change for existing installs', async () => {
    let runs = 0;
    const scheduler = new SourceScheduler({
      enabled: false,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 3,
      sources: [
        source('dropbox.files', 'continuous', 60_000, undefined, [
          task('dropbox.metadata_sync', async () => {
            runs += 1;
            return { status: 'progress' };
          }),
        ]),
      ],
    });

    const status = await scheduler.runDueTasks();

    expect(runs).toBe(0);
    expect(status.enabled).toBe(false);
  });

  test('registered Gmail connector-store lane runs a bounded pull and an unbounded reconcile', async () => {
    const calls: string[] = [];
    const sync = gmailStoreHandler({
      onPull: (request) => {
        calls.push(`pull:${request?.max_items ?? 'unbounded'}:${request?.checkpoint ?? 'fresh'}`);
      },
      onReconcile: () => calls.push('reconcile'),
    });
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-07-07T12:00:00.000Z'),
      sources: [
        createGmailConnectorStoreSchedulerSource({
          config: schedulerConfig(),
          sync,
        })!,
      ],
    });

    const status = await scheduler.runDueTasks();

    expect(status.sources[0]).toMatchObject({
      source_id: 'gmail.email',
      corpus_id: GMAIL_CONNECTOR_CORPUS_ID,
      tasks: [
        {
          id: 'gmail.email_store_pull',
          last_result: {
            status: 'progress',
            counts: {
              provider_traversals: 1,
              internal_items_indexed: 1,
              secure_items_indexed: 1,
              secure_chunks_embedded: 1,
            },
          },
        },
        { id: 'gmail.email_store_reconcile', last_result: { status: 'progress' } },
      ],
    });
    // The pull carries the host bound; the reconcile deliberately carries none,
    // which is the only shape the spine accepts as a full snapshot.
    expect(calls).toEqual(['pull:200:fresh', 'reconcile']);
  });

  test('Gmail lane threads its provider checkpoint envelope back into the next pull', async () => {
    const seen: Array<string | undefined> = [];
    const envelope = encodeGmailStoreCheckpoint({ head: 'gm1:y' })!;
    const sync = gmailStoreHandler({
      checkpoint: envelope,
      onPull: (request) => seen.push(request?.checkpoint),
    });
    const source = createGmailConnectorStoreSchedulerSource({ config: schedulerConfig(), sync })!;
    let clock = Date.parse('2026-07-07T12:00:00.000Z');
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date(clock),
      sources: [source],
    });

    await scheduler.runDueTasks();
    // Past the pull interval so the second tick actually re-runs the task.
    clock += 2 * 60 * 60_000;
    await scheduler.runDueTasks();

    // One opaque envelope carries both lanes, because both write the same
    // store's sync_runs.cursor and the last writer would erase the other.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe(envelope);
  });

  test('Gmail lane fails closed without its connector-store handler', () => {
    expect(createGmailConnectorStoreSchedulerSource({ config: schedulerConfig() })).toBeUndefined();
  });

  test('Gmail daily request guard parks the lane instead of fail-looping it', async () => {
    const sync = gmailStoreHandler({
      onPull: () => {
        throw new GoogleRequestBudgetError('Gmail', '2026-07-08T00:00:00.000Z');
      },
    });
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-07-07T12:00:00.000Z'),
      sources: [
        createGmailConnectorStoreSchedulerSource({ config: schedulerConfig(), sync })!,
      ],
    });

    const status = await scheduler.runDueTasks();
    const pull = status.sources[0]!.tasks.find((task) => task.id === 'gmail.email_store_pull');

    // A planned park, not an error backoff: the lane waits for the UTC
    // rollover rather than retrying the same refusal all day.
    expect(pull).toMatchObject({
      next_run_at: '2026-07-08T00:00:00.000Z',
      degraded_reason: 'gmail_daily_api_request_guard',
    });
  });

  test('Gmail future-day clock regression has its own honest categorical kind', async () => {
    const sync = gmailStoreHandler({
      onPull: () => {
        throw new GoogleRequestBudgetError(
          'Gmail',
          '2026-07-31T00:00:00.000Z',
          'future_utc_day',
        );
      },
    });
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-07-29T12:00:00.000Z'),
      sources: [
        createGmailConnectorStoreSchedulerSource({ config: schedulerConfig(), sync })!,
      ],
    });

    const status = await scheduler.runDueTasks();
    const pull = status.sources[0]!.tasks.find((task) => task.id === 'gmail.email_store_pull');
    expect(pull).toMatchObject({
      last_error_kind: 'gmail_request_budget_clock_regression',
      degraded_reason: 'gmail_request_budget_clock_regression',
    });
  });

  test('Gmail residual ledger contention is a typed short refusal, not task_failed', async () => {
    const sync = gmailStoreHandler({
      onPull: () => {
        throw new GoogleRequestBudgetError(
          'Gmail',
          '2026-07-29T12:00:30.000Z',
          'ledger_busy',
        );
      },
    });
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-07-29T12:00:00.000Z'),
      sources: [
        createGmailConnectorStoreSchedulerSource({ config: schedulerConfig(), sync })!,
      ],
    });

    const status = await scheduler.runDueTasks();
    const pull = status.sources[0]!.tasks.find((task) => task.id === 'gmail.email_store_pull');
    expect(pull).toMatchObject({
      last_error_kind: 'gmail_request_budget_ledger_busy',
      degraded_reason: 'gmail_request_budget_ledger_busy',
      next_run_at: '2026-07-29T12:00:30.000Z',
    });
  });

  test('registered Google Drive connector-store lane runs a bounded pull and an unbounded reconcile', async () => {
    const calls: string[] = [];
    const liveSync = driveStoreHandler({
      onPull: (request) => {
        calls.push(`pull:${request?.max_items ?? 'unbounded'}:${request?.checkpoint ?? 'fresh'}`);
      },
      onReconcile: () => calls.push('reconcile'),
    });
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-07-07T12:00:00.000Z'),
      sources: [
        createGoogleDriveConnectorStoreSchedulerSource({
          config: schedulerConfig(),
          liveSync,
        })!,
      ],
    });

    const status = await scheduler.runDueTasks();

    expect(status.sources[0]).toMatchObject({
      source_id: 'google_drive.docs',
      corpus_id: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      tasks: [
        {
          id: 'google_drive.docs_store_pull',
          last_result: {
            status: 'progress',
            counts: {
              provider_traversals: 1,
              internal_items_indexed: 1,
              secure_items_indexed: 1,
              secure_chunks_embedded: 1,
            },
          },
        },
        { id: 'google_drive.docs_store_reconcile', last_result: { status: 'progress' } },
      ],
    });
    // The pull carries the host bound; the reconcile deliberately carries none,
    // which is the only shape the spine accepts as a full snapshot.
    expect(calls).toEqual(['pull:200:fresh', 'reconcile']);
  });

  test('Google Drive lane fails closed without its connector-store handler', () => {
    expect(createGoogleDriveConnectorStoreSchedulerSource({ config: schedulerConfig() })).toBeUndefined();
  });

  test('Google Drive daily request guard parks the lane instead of fail-looping it', async () => {
    const liveSync = driveStoreHandler({
      onPull: () => {
        throw new GoogleRequestBudgetError('Google Drive', '2026-07-08T00:00:00.000Z');
      },
    });
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 5_000,
      maxTransientRetries: 1,
      now: () => new Date('2026-07-07T12:00:00.000Z'),
      sources: [
        createGoogleDriveConnectorStoreSchedulerSource({
          config: schedulerConfig(),
          liveSync,
        })!,
      ],
    });

    const status = await scheduler.runDueTasks();
    const pull = status.sources[0]!.tasks.find((task) => task.id === 'google_drive.docs_store_pull');

    // A planned park, not an error backoff: the lane waits for the UTC
    // rollover rather than retrying the same refusal all day.
    expect(pull).toMatchObject({
      next_run_at: '2026-07-08T00:00:00.000Z',
      degraded_reason: 'google_drive_daily_api_request_guard',
    });
  });
});

function gmailStoreHandler(hooks: {
  onPull?: (request?: GmailStorePullRequest) => void;
  onReconcile?: () => void;
  checkpoint?: string | null;
} = {}): GmailConnectorStoreSyncHandler {
  const outcome = (kind: GmailConnectorStoreReceipt['kind']): GmailConnectorStoreTaskOutcome => {
    const receipt: Omit<GmailConnectorStoreReceipt, 'receipt_sha256'> = {
      kind,
      status: 'progress',
      counts: {
        api_requests: 4,
        daily_api_request_budget: 5_000,
        provider_traversals: 1,
        items_seen: 2,
        fetch_item_cache_hits: 2,
        attachments_declared: 0,
        attachment_bytes_declared: 0,
      attachments_not_ingested: 0,
      items_skipped_otp: 0,
      items_skipped_category: 0,
        internal_items_indexed: 1,
        internal_items_tombstoned: 0,
        internal_items_rejected: 1,
        internal_chunks_indexed: 1,
        internal_chunks_embedded: 1,
        secure_items_indexed: 1,
        secure_items_tombstoned: 0,
        secure_items_rejected: 1,
        secure_chunks_indexed: 1,
        secure_chunks_embedded: 1,
        resumed_from_checkpoint: 0,
        resume_cursor_rejected: 0,
        traversal_complete: 1,
        absence_authoritative: 0,
      },
      api_usage: { utc_day: '2026-07-07' },
      policy: {
        counts_only: true,
        raw_source_exposed: false,
        source_text_returned: false,
        provider_cursor_exposed: false,
        absence_authority: 'partial_window',
        tombstones_applied: false,
      },
    };
    return {
      receipt: { ...receipt, receipt_sha256: gmailReceiptDigest(receipt) },
      checkpoint: hooks.checkpoint ?? null,
    };
  };
  return {
    async sync() {
      throw new Error('The scheduler lane must use pull/reconcile, never the one-shot sync.');
    },
    async pull(request) {
      hooks.onPull?.(request);
      return outcome(GMAIL_STORE_PULL_RECEIPT_KIND);
    },
    async reconcile() {
      hooks.onReconcile?.();
      return outcome(GMAIL_STORE_RECONCILE_RECEIPT_KIND);
    },
    lastStoreRunCompletedAt: () => undefined,
    requestBudgetStatus: () => undefined,
  };
}

function driveStoreHandler(hooks: {
  onPull?: (request?: GoogleDriveStorePullRequest) => void;
  onReconcile?: () => void;
} = {}): GoogleDriveConnectorStoreSyncHandler {
  const outcome = (kind: GoogleDriveConnectorStoreReceipt['kind']): GoogleDriveConnectorStoreTaskOutcome => {
    const receipt: Omit<GoogleDriveConnectorStoreReceipt, 'receipt_sha256'> = {
      kind,
      status: 'progress',
      counts: {
        api_requests: 3,
        daily_api_request_budget: 3_000,
        provider_traversals: 1,
        items_seen: 2,
        content_reads: 2,
        content_read_cap: 50,
        content_reads_failed: 0,
        internal_items_indexed: 1,
        internal_items_tombstoned: 0,
        internal_items_rejected: 1,
        internal_items_excluded: 0,
        internal_items_excluded_unevaluable: 0,
        internal_chunks_indexed: 1,
        internal_chunks_embedded: 1,
        secure_items_indexed: 1,
        secure_items_tombstoned: 0,
        secure_items_rejected: 1,
        secure_items_excluded: 0,
        secure_items_excluded_unevaluable: 0,
        secure_chunks_indexed: 1,
        secure_chunks_embedded: 1,
        resumed_from_checkpoint: 0,
        resume_cursor_rejected: 0,
        traversal_complete: 1,
        absence_authoritative: 0,
      },
      api_usage: { utc_day: '2026-07-07' },
      policy: {
        counts_only: true,
        raw_source_exposed: false,
        source_text_returned: false,
        provider_cursor_exposed: false,
        absence_authority: 'partial_window',
        tombstones_applied: false,
      },
    };
    return {
      receipt: { ...receipt, receipt_sha256: googleDriveReceiptDigest(receipt) },
      checkpoint: null,
    };
  };
  return {
    async sync() {
      throw new Error('The scheduler lane must use pull/reconcile, never the one-shot sync.');
    },
    async pull(request) {
      hooks.onPull?.(request);
      return outcome(GOOGLE_DRIVE_STORE_PULL_RECEIPT_KIND);
    },
    async reconcile() {
      hooks.onReconcile?.();
      return outcome(GOOGLE_DRIVE_STORE_RECONCILE_RECEIPT_KIND);
    },
    lastStoreRunCompletedAt: () => undefined,
    requestBudgetStatus: () => undefined,
  };
}

function schedulerConfig(): OlympusConfig {
  return {
    worker: {
      scheduler: {
        enabled: true,
        sourceIds: ['x.bookmarks'],
        tickSeconds: 1,
        syncIntervalSeconds: 300,
        freshnessThresholdHours: 24,
        errorBackoffSeconds: 30,
        maxTransientRetries: 1,
      },
    },
  } as OlympusConfig;
}

function usageStatus() {
  return {
    utc_day: '2026-07-18',
    api_requests: 0,
    resource_reads: 0,
    estimated_billable_resources: 0,
    reserved_resource_reads: 0,
    estimated_spend_microusd: 0,
    estimated_spend_usd: 0,
    estimated_unit_cost_usd: 0.001,
    estimate: true as const,
    hard_budgets: { api_requests: 1, resource_reads: 1, estimated_spend_microusd: 1 },
    guard: { state: 'ok' as const },
    policy: {
      counts_only: true as const,
      raw_source_exposed: false as const,
      source_text_returned: false as const,
      resource_ids_exposed: false as const,
      provider_cursor_exposed: false as const,
    },
  };
}

describe('lane not-advancing gate', () => {
  /** Runs a lane N+1 times against a fresh scheduler and returns its statuses. */
  async function runLane(
    counts: () => Record<string, number>,
    runs: number,
    stateStore?: LocalSourceSchedulerStateStore,
    startAt = '2026-07-28T00:00:00.000Z',
  ): Promise<Array<string | undefined>> {
    const reasons: Array<string | undefined> = [];
    let clock = Date.parse(startAt);
    const scheduler = new SourceScheduler({
      enabled: true,
      tickMs: 1_000,
      errorBackoffMs: 1_000,
      maxTransientRetries: 1,
      zeroChangeDegradeRuns: 3,
      sources: [source('lane.src', 'continuous', 1_000, undefined, [
        task('lane.pull', async () => ({ status: 'progress', counts: counts() })),
      ])],
      now: () => new Date(clock),
      ...(stateStore ? { stateStore } : {}),
    });
    for (let run = 0; run < runs; run += 1) {
      const status = await scheduler.runDueTasks(new Date(clock));
      reasons.push(status.sources[0]?.tasks[0]?.degraded_reason);
      clock += 3_600_000;
    }
    return reasons;
  }

  test('degrades a lane only after N consecutive runs that saw items and changed none', async () => {
    // Three consecutive runs spending provider I/O to rewrite rows that already
    // matched. The lane reports healthy counts throughout, which is the point.
    expect(await runLane(() => ({ items_seen: 40, items_changed: 0 }), 3))
      .toEqual([undefined, undefined, 'traversal_not_advancing']);
  });

  test('an idle lane never degrades, however long it stays idle', async () => {
    // items_seen === 0 is the structural protection: a quiet lane is not a
    // stuck one, and it does not increment the streak at any N.
    expect(await runLane(() => ({ items_seen: 0, items_changed: 0 }), 6))
      .toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  test('one real change clears the streak', async () => {
    let run = 0;
    // Runs 1-2 build the streak, run 3 changes something and resets it to zero,
    // so the gate needs three fresh zero-change runs (4-6) to fire again.
    const reasons = await runLane(() => {
      run += 1;
      return { items_seen: 40, items_changed: run === 3 ? 1 : 0 };
    }, 6);
    expect(reasons).toEqual([
      undefined, undefined, undefined, undefined, undefined, 'traversal_not_advancing',
    ]);
  });

  test('a lane that reports no items_changed at all is never judged by the gate', async () => {
    expect(await runLane(() => ({ items_seen: 40, items_indexed: 40 }), 5))
      .toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  test('the streak survives a scheduler restart', async () => {
    await withSchedulerStateFixture(async (path) => {
      const counts = () => ({ items_seen: 40, items_changed: 0 });
      const first = new LocalSourceSchedulerStateStore(path);
      expect(await runLane(counts, 2, first)).toEqual([undefined, undefined]);
      first.close();

      // A brand new scheduler and a brand new state store handle: the streak is
      // carried in the counts the scheduler already persists, so the third run
      // still knows it is the third.
      const second = new LocalSourceSchedulerStateStore(path);
      expect(await runLane(counts, 1, second, '2026-07-28T06:00:00.000Z'))
        .toEqual(['traversal_not_advancing']);
      second.close();
    });
  });
});

function source(
  sourceId: string,
  cadence: SourceSchedulerSource['cadence'],
  intervalMs: number,
  lastSyncCompletedAt: (() => string | undefined) | undefined,
  tasks: SourceSchedulerSource['tasks'],
): SourceSchedulerSource {
  return {
    sourceId,
    corpusId: 'secure_local.dropbox.files',
    cadence,
    intervalMs,
    freshnessThresholdHours: 26,
    tasks,
    ...(lastSyncCompletedAt ? { lastSyncCompletedAt } : {}),
  };
}

function task(
  id: string,
  run: () => Promise<SourceSchedulerTaskRunResult>,
): SourceSchedulerSource['tasks'][number] {
  return {
    id,
    kind: 'sync',
    writer: true,
    run,
  };
}

async function withSchedulerStateFixture(run: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-source-worker-scheduler-'));
  try {
    await run(join(dir, 'scheduler.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
