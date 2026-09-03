import { describe, expect, test } from 'bun:test';
import type { OlympusConfig } from '../src/core/config.ts';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { createCanonicalDropboxSchedulerSource } from '../src/workers/source-scheduler.ts';
import { SourceSchedulerTaskFailure } from '../src/workers/source-scheduler.ts';
import type { DropboxProviderStoreSyncHandler } from '../src/workers/dropbox-files/index.ts';
import type {
  ExtractionPlanRequest,
  ExtractionRunRequest,
  FileExtractionRunner,
} from '../src/workers/file-extraction/runner.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

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

  test('orders metadata for every admitted root before shared extraction and local embedding', async () => {
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
    const store = {
      async embedChunks() {
        calls.push('embed');
        return {
          corpusId: policy.corpusId,
          modelId: 'local-test',
          chunksSeen: 1,
          chunksEmbedded: 1,
          chunksSkipped: 0,
        };
      },
    } as unknown as LocalConnectorStore;
    const embeddingProvider = {
      backend: 'local',
      modelId: 'local-test',
      epochId: 'epoch-test',
    } as SourceEmbeddingProvider;

    const source = createCanonicalDropboxSchedulerSource({
      policy,
      config: schedulerConfig(),
      providerSync,
      store,
      fileExtraction,
      embeddingProvider,
    });
    expect(source?.tasks.map((task) => task.kind)).toEqual(['sync', 'sync', 'extract', 'embed']);
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
      'extract:dropbox.personal:/Full:local_text',
      'embed',
    ]);
    expect(source?.tasks.some((task) => task.id.includes('/Full'))).toBe(false);
  });

  test('refuses a non-local embedding provider for the secure Dropbox corpus', () => {
    expect(() => createCanonicalDropboxSchedulerSource({
      policy: defaultDropboxIngestionPolicy(),
      config: schedulerConfig(),
      providerSync: {} as DropboxProviderStoreSyncHandler,
      store: {} as LocalConnectorStore,
      embeddingProvider: { backend: 'cloud' } as SourceEmbeddingProvider,
    })).toThrow('require a local/private embedding provider');
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
