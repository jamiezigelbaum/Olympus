import { describe, expect, test } from 'bun:test';
import type { OlympusConfig } from '../src/core/config.ts';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { createCanonicalDropboxSchedulerSource } from '../src/workers/source-scheduler.ts';
import { SourceScheduler, SourceSchedulerTaskFailure } from '../src/workers/source-scheduler.ts';
import type { DropboxProviderStoreSyncHandler } from '../src/workers/dropbox-files/index.ts';
import type {
  ExtractionPlanRequest,
  ExtractionRunRequest,
  FileExtractionRunner,
} from '../src/workers/file-extraction/runner.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';

describe('canonical Dropbox scheduler', () => {
  test('the shipped default policy constructs the shared extraction task', () => {
    const source = createCanonicalDropboxSchedulerSource({
      policy: defaultDropboxIngestionPolicy(),
      config: schedulerConfig(),
      providerSync: stubProviderSync(),
      store: {} as LocalConnectorStore,
      fileExtraction: {} as FileExtractionRunner,
    });
    expect(source?.tasks.some((task) => task.kind === 'extract')).toBe(true);
  });

  test('orders metadata for every admitted root before shared extraction, and declares no embed task', async () => {
    const calls: string[] = [];
    const policy = defaultDropboxIngestionPolicy();
    policy.roots = [
      {
        path: '/Full',
        approved_scope_key: 'dropbox.personal:/Full',
        default_action: 'full_extract',
      },
      {
        path: '/Metadata',
        approved_scope_key: 'dropbox.personal:/Metadata',
        default_action: 'metadata_only',
      },
    ];
    const providerSync = {
      async pull(request) {
        calls.push(`sync:${request.approved_scope_key}:${request.checkpoint ?? 'fresh'}`);
        return {
          receipt: {
            kind: 'dropbox_provider_connector_store_pull_receipt',
            status: 'progress',
            counts: {
              items_seen: 1,
              items_indexed: 1,
              items_changed: 1,
              items_tombstoned: 0,
              deleted_events_applied: 0,
              items_rejected: 0,
              items_excluded: 0,
              metadata_only_items: 1,
              traversal_complete: 1,
              resumed_from_checkpoint: Number(Boolean(request.checkpoint)),
              page_digest_restarts: 0,
              resume_cursor_reset: 0,
            },
            policy: {
              counts_only: true,
              raw_source_exposed: false,
              source_text_returned: false,
              provider_cursor_exposed: false,
              native_recursive_only: true,
              content_extraction: 'shared_factory',
            },
            receipt_sha256: 'a'.repeat(64),
          },
          checkpoint: `next:${request.approved_scope_key}`,
        };
      },
      connectorIdForScope(scope: string) {
        return `id:${scope}`;
      },
      lastStoreRunCompletedAt: () => '2026-08-26T10:00:00.000Z',
    } satisfies DropboxProviderStoreSyncHandler;
    const fileExtraction = {
      async plan(request: ExtractionPlanRequest) {
        calls.push(`plan:${request.approvedScopeKey}:${request.cursor ?? 'fresh'}`);
        return {
          kind: 'file_extraction_plan',
          corpusId: request.corpusId,
          candidates: 1,
          jobsQueued: 1,
          jobsExisting: 0,
          jobsForced: 0,
          jobsSkippedTooLarge: 0,
          jobsUnroutable: 0,
          extractorKinds: ['local_text'],
          nextCursor: 'candidate-cursor',
          done: false,
        };
      },
      async run(request: ExtractionRunRequest) {
        calls.push(`extract:${request.approvedScopeKey}:${request.preflightExtractorKinds?.join(',') ?? 'none'}`);
        return {
          kind: 'file_extraction_run',
          corpusId: request.corpusId,
          provider: request.provider,
          accountScope: request.accountScope,
          scopeKeyHash: 'scope',
          workerIdHash: 'worker',
          leasedJobs: 1,
          processedJobs: 1,
          abandonedLeases: 0,
          records: [],
          counts: {
            indexed: 1,
            metadata_only: 0,
            skipped_unsupported: 0,
            skipped_too_large: 0,
            blocked_policy: 0,
            failed_retryable: 0,
            failed_terminal: 0,
          },
          paused: false,
          consecutiveRetryableFailures: 0,
          policy: {
            workerPrivateSurface: true,
            rawSourceExposed: false,
            sourceTextReturned: false,
            fileBytesPersisted: false,
            tempBytesCleaned: true,
            localOnly: true,
          },
        };
      },
    } as unknown as FileExtractionRunner;
    const store = {} as unknown as LocalConnectorStore;

    const source = createCanonicalDropboxSchedulerSource({
      policy,
      config: schedulerConfig(),
      providerSync,
      store,
      fileExtraction,
    });
    // Its stores get vectors from the shared embedding sweep (withEmbeddingSweep).
    expect(source?.tasks.map((task) => task.kind)).toEqual(['sync', 'sync', 'extract']);
    for (const task of source!.tasks) {
      await task.run({
        sourceId: source!.sourceId,
        corpusId: source!.corpusId,
        taskId: task.id,
        attemptedAt: '2026-08-26T10:00:00.000Z',
        consecutiveFailures: 0,
        effectiveIntervalMs: 300_000,
        ...(task.kind === 'sync'
          ? { checkpoint: 'provider-resume' }
          : task.kind === 'extract'
            ? { checkpoint: 'candidate-resume' }
            : {}),
      });
    }

    expect(calls).toEqual([
      'sync:dropbox.personal:/Full:provider-resume',
      'sync:dropbox.personal:/Metadata:provider-resume',
      'plan:dropbox.personal:/Full:candidate-resume',
      // The pass keeps reading pages toward its plan limit; a page that names
      // the same next position again ends the scan.
      'plan:dropbox.personal:/Full:candidate-cursor',
      'extract:dropbox.personal:/Full:local_text',
    ]);
    expect(source?.tasks.some((task) => task.id.includes('/Full'))).toBe(false);
  });

  test('records a typed scheduler failure when an extractor preflight pauses the lane', async () => {
    const policy = defaultDropboxIngestionPolicy();
    const source = createCanonicalDropboxSchedulerSource({
      policy,
      config: schedulerConfig(),
      providerSync: stubProviderSync(),
      store: {} as LocalConnectorStore,
      fileExtraction: {
        async plan() {
          return {
            kind: 'file_extraction_plan', corpusId: policy.corpusId, candidates: 1,
            jobsQueued: 1, jobsExisting: 0, jobsForced: 0, jobsSkippedTooLarge: 0,
            jobsUnroutable: 0, extractorKinds: ['local_vlm_pdf'], done: true,
          } as unknown as Awaited<ReturnType<FileExtractionRunner['plan']>>;
        },
        async run(request: ExtractionRunRequest) {
          expect(request.preflightExtractorKinds).toEqual(['local_vlm_pdf']);
          return {
            kind: 'file_extraction_run', corpusId: policy.corpusId, provider: 'dropbox', accountScope: 'personal',
            scopeKeyHash: 'scope', workerIdHash: 'worker', leasedJobs: 0, processedJobs: 0, abandonedLeases: 0,
            records: [], counts: { indexed: 0, metadata_only: 0, skipped_unsupported: 0, skipped_too_large: 0,
              blocked_policy: 0, failed_retryable: 0, failed_terminal: 0 }, paused: true,
            pauseReason: 'extractor_health_probe_failed', preflightErrorKind: 'vlm_profile_unknown',
            consecutiveRetryableFailures: 0,
            policy: { workerPrivateSurface: true, rawSourceExposed: false, sourceTextReturned: false,
              fileBytesPersisted: false, tempBytesCleaned: true, localOnly: true, trustDomain: 'secure_local' },
          };
        },
      } as unknown as FileExtractionRunner,
    });
    const extract = source!.tasks.find((task) => task.kind === 'extract')!;
    const failure = await extract.run().catch((error) => error);
    expect(failure).toBeInstanceOf(SourceSchedulerTaskFailure);
    expect(failure.errorKind).toBe('vlm_profile_unknown');
  });
});

function stubProviderSync(): DropboxProviderStoreSyncHandler {
  return {
    pull: async () => ({ receipt: { status: 'idle', counts: {} }, checkpoint: null }),
    connectorIdForScope: () => 'dropbox-fixture',
    lastStoreRunCompletedAt: () => undefined,
  } as unknown as DropboxProviderStoreSyncHandler;
}

function schedulerConfig(): OlympusConfig {
  return {
    worker: {
      scheduler: {
        enabled: true,
        sourceIds: ['dropbox.files'],
        tickSeconds: 1,
        syncIntervalSeconds: 300,
        freshnessThresholdHours: 24,
        errorBackoffSeconds: 30,
        maxTransientRetries: 1,
      },
    },
  } as OlympusConfig;
}


test('a missing root takes the daily lane, names its chosen path, and leaves other scopes syncing', async () => {
  let now = new Date('2026-10-14T08:00:00Z');
  let restored = false;
  const stateStore = new (await import('../src/workers/source-scheduler-state.ts')).LocalSourceSchedulerStateStore(':memory:');
  const calls: string[] = [];
  const policy = defaultDropboxIngestionPolicy();
  policy.roots = ['/Gone', '/Here'].map(path => ({ path, approved_scope_key: `dropbox.personal:${path}`, default_action: 'metadata_only' as const }));
  const client = new (await import('../src/workers/dropbox-files/provider-client.ts')).DropboxApiMetadataClient({ token: 'test', fetch: async () => restored ? Response.json({ entries: [], cursor: 'restored', has_more: false }) : new Response(JSON.stringify({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }), { status: 409 }) });
  const sync = { ...stubProviderSync(), async pull(request: any) {
    calls.push(request.approved_scope_key);
    if (request.approved_scope_key.endsWith('/Gone')) await client.listFolder({ path: '/Gone', recursive: true, limit: 10 });
    return stubProviderSync().pull(request);
  } } as DropboxProviderStoreSyncHandler;
  const source = createCanonicalDropboxSchedulerSource({ policy, config: schedulerConfig(), providerSync: sync, store: { lastCompletedSyncRun: () => undefined } as unknown as LocalConnectorStore })!;
  const options = { enabled: true, tickMs: 1000, errorBackoffMs: 5000, maxTransientRetries: 2, now: () => now, sources: [source], stateStore };
  let scheduler = new SourceScheduler(options);
  try {
    const status = await scheduler.runDueTasks();
    const missing = status.sources[0]!.tasks.find(t => t.last_error_kind === 'scope_root_missing')!;
    expect(missing).toBeDefined();
    expect(missing.missing_scope_path).toBe('/Gone');
    expect(missing.effective_interval_seconds).toBe(86400);
    expect(missing.next_run_at).toBe('2026-10-15T08:00:00.000Z');
    expect(calls).toEqual(['dropbox.personal:/Gone', 'dropbox.personal:/Here']);
    now = new Date('2026-10-14T08:06:00Z');
    await scheduler.runDueTasks();
    expect(calls.filter(c => c.endsWith('/Gone'))).toHaveLength(1);
    expect(calls.filter(c => c.endsWith('/Here'))).toHaveLength(2);
    scheduler.stop();
    scheduler = new SourceScheduler(options);
    await scheduler.runDueTasks();
    expect(calls.filter(c => c.endsWith('/Gone'))).toHaveLength(1);
    expect(scheduler.status().sources[0]!.tasks[0]!.missing_scope_path).toBe('/Gone');
    restored = true;
    now = new Date('2026-10-15T08:00:00Z');
    const recovered = await scheduler.runDueTasks();
    expect(recovered.sources[0]!.tasks[0]!.missing_scope_path).toBeUndefined();
    expect(recovered.sources[0]!.tasks[0]!.effective_interval_seconds).toBe(300);
    expect(calls.filter(c => c.endsWith('/Gone'))).toHaveLength(2);
  } finally { scheduler.stop(); stateStore.close(); }
});
