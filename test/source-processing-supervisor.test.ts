import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  ensureReportPathDir,
  optionsFromEnv,
  janitorOptionsFromEnv,
  runSourceProcessingJanitor,
  runSourceProcessingSupervisor,
  type DropboxContentJanitorRequeueRequest,
  type DropboxContentLeaseRecycleRequest,
  type DropboxEmbeddingRequest,
  type DropboxExtractionRequest,
  type DropboxContentPlanRequest,
  type SourceProcessingSupervisorClient,
} from '../scripts/source-processing-supervisor.ts';
import { defaultConfig } from '../src/core/config.ts';
import type { SourceIndexStatusResult } from '../src/core/email.ts';
import type {
  FileExtractionRunResponse as DropboxContentExtractionBatchResult,
  FileExtractionPlanResponse as DropboxContentExtractionEnqueueResult,
  FileExtractionJanitorRequeueResponse as DropboxContentExtractionJanitorRequeueResult,
  FileExtractionLeaseRecycleResponse as DropboxContentExtractionLeaseRecycleResult,
} from '../src/workers/file-extraction/http-types.ts';

const SCOPE_A = 'dropbox.personal:/1 Projects';
const SCOPE_B = 'dropbox.personal:/2 Areas';
const SUPERVISOR_SCRIPT = readFileSync(join(import.meta.dir, '..', 'scripts', 'source-processing-supervisor.ts'), 'utf8');

describe('source processing supervisor', () => {
  test('round-robins Dropbox scopes, embeds after indexed progress, and hides raw scope keys', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [
        batch({ leasedJobs: 1, counts: { indexed: 1 } }),
        batch({ leasedJobs: 0 }),
      ],
      [SCOPE_B]: [
        batch({ leasedJobs: 2, counts: { metadata_only: 2 } }),
      ],
    }, {
      [SCOPE_A]: [
        snapshot({ queued: 4, leased: 0, chunks: 10, embedded: 9 }),
        snapshot({ queued: 3, leased: 0, chunks: 11, embedded: 10 }),
      ],
      [SCOPE_B]: [
        snapshot({ queued: 2, leased: 0, chunks: 5, embedded: 5 }),
        snapshot({ queued: 0, leased: 0, chunks: 5, embedded: 5 }),
      ],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A, SCOPE_B],
      maxCycles: 3,
      batchSize: 2,
      embedAfterExtract: true,
      now: new Date('2026-06-21T11:30:00.000Z'),
    });

    expect(client.planCalls.map((call) => call.approved_scope_key)).toEqual([SCOPE_A, SCOPE_B, SCOPE_A]);
    expect(client.extractCalls.map((call) => call.approved_scope_key)).toEqual([SCOPE_A, SCOPE_B, SCOPE_A]);
    expect(client.embedCalls.map((call) => call.approved_scope_key)).toEqual([SCOPE_A]);
    expect(report.status).toBe('progress');
    expect(report.summary).toMatchObject({
      jobs_leased: 3,
      jobs_planned: 3,
      terminal_progress_jobs: 3,
      embed_runs: 1,
      queued_before: 6,
      queued_after: 3,
    });
    expect(report.policy).toMatchObject({
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      direct_db_mutation: false,
      message_corpora_excluded: true,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SCOPE_A);
    expect(serialized).not.toContain(SCOPE_B);
  });

  test('keeps extraction progress separate from embedding retry failures', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [
        batch({ leasedJobs: 1, counts: { indexed: 1 } }),
      ],
    }, {}, {
      [SCOPE_A]: [new Error('/source/index/embed returned HTTP 500: embedding service unavailable')],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 1,
      batchSize: 1,
      embedAfterExtract: true,
      now: new Date('2026-06-23T12:40:00.000Z'),
    });

    expect(client.embedCalls).toHaveLength(1);
    expect(report.status).toBe('progress');
    expect(report.summary).toMatchObject({
      terminal_progress_jobs: 1,
      embed_runs: 0,
      embed_failed_runs: 1,
    });
    expect(report.scopes[0]).toMatchObject({
      status: 'progress',
      embed_failed_runs: 1,
      warnings: ['embedding failed after extraction progress: /source/index/embed returned HTTP 500: embedding service unavailable'],
      errors: [],
    });
    expect(report.actions.join('\n')).toContain('embedding run(s) failed after extraction progress');
  });

  test('parks a scope after repeated no-progress retryable batches', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [
        batch({ leasedJobs: 1, counts: { failed_retryable: 1 } }),
        batch({ leasedJobs: 1, counts: { failed_retryable: 1 } }),
      ],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 2,
      maxConsecutiveNoProgressBatches: 2,
    });

    expect(report.status).toBe('parked');
    expect(report.scopes[0]).toMatchObject({
      status: 'parked',
      jobs_leased: 2,
      failed_retryable_jobs: 2,
      consecutive_no_progress_batches: 2,
    });
    expect(report.actions.join('\n')).toContain('parked after repeated no-progress batches');
  });

  test('unbounded drain parks a failed scope and continues later scopes', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_B]: [
        batch({ leasedJobs: 1, counts: { indexed: 1 } }),
      ],
    }, {}, {}, {
      [SCOPE_A]: [new Error('/source/index/dropbox/content/extract returned HTTP 500: provider socket refused')],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A, SCOPE_B],
      maxCycles: Number.POSITIVE_INFINITY,
      stopWhenIdle: true,
      statusSnapshots: false,
      batchSize: 1,
      planLimit: 1,
      planBeforeExtract: true,
      embedAfterExtract: false,
    });

    expect(client.planCalls.map((call) => call.approved_scope_key)).toEqual([SCOPE_A, SCOPE_B, SCOPE_B]);
    expect(client.extractCalls.map((call) => call.approved_scope_key)).toEqual([SCOPE_B, SCOPE_B]);
    expect(report.status).toBe('progress');
    expect(report.cycles_run).toBe(4);
    expect(report.summary.terminal_progress_jobs).toBe(1);
    expect(report.scopes[0]).toMatchObject({
      status: 'parked',
      errors: ['/source/index/dropbox/content/extract returned HTTP 500: provider socket refused'],
    });
    expect(report.scopes[0]?.warnings.join('\n')).toContain('scope parked for this unbounded run');
    expect(report.scopes[1]).toMatchObject({ status: 'progress', jobs_leased: 1 });
    expect(report.actions.join('\n')).toContain('scope parked after supervisor request failure');
  });

  test('passes QA verdict targets through to planning without exposing source data', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [batch({ leasedJobs: 0 })],
    });

    await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 1,
      qaVerdicts: ['qa_low_confidence_candidate_for_venice', 'qa_low_confidence_candidate_for_venice', ' '],
      extractorKind: 'venice_grok43_document',
      extractorVersion: '2026-06-23-grok43-escalation-v1',
      mimeTypes: ['application/pdf', 'application/pdf'],
      includePathPrefixes: ['/1 Projects/Active'],
      excludePathPrefixes: ['/2 Areas/Identity/Profile Photos'],
      sourceExtractorKinds: ['local_text'],
      sourceJobStatuses: ['metadata_only'],
    });

    expect(client.planCalls).toHaveLength(1);
    expect(client.planCalls[0]).toMatchObject({
      extractor_kind: 'venice_grok43_document',
      extractor_version: '2026-06-23-grok43-escalation-v1',
      qa_verdicts: ['qa_low_confidence_candidate_for_venice'],
      mime_types: ['application/pdf'],
      include_path_prefixes: ['/1 projects/active'],
      exclude_path_prefixes: ['/2 areas/identity/profile photos'],
      source_extractor_kinds: ['local_text'],
      source_job_statuses: ['metadata_only'],
    });
    expect(client.extractCalls[0]).toMatchObject({
      include_path_prefixes: ['/1 projects/active'],
      exclude_path_prefixes: ['/2 areas/identity/profile photos'],
    });
    expect(client.statusCalls).toHaveLength(2);
    expect(client.statusCalls[0]).toMatchObject({
      extractor_kind: 'venice_grok43_document',
      extractor_version: '2026-06-23-grok43-escalation-v1',
      qa_verdicts: ['qa_low_confidence_candidate_for_venice'],
      mime_types: ['application/pdf'],
      include_path_prefixes: ['/1 projects/active'],
      exclude_path_prefixes: ['/2 areas/identity/profile photos'],
      source_extractor_kinds: ['local_text'],
      source_job_statuses: ['metadata_only'],
      include_items: false,
    });
    expect(client.statusCalls[1]).toMatchObject(client.statusCalls[0]!);
  });

  test('flags QA gaps when raw queued jobs are non-actionable', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [batch({ leasedJobs: 0 })],
    }, {
      [SCOPE_A]: [
        snapshot({
          queued: 12,
          queuedActionable: 0,
          queuedSuperseded: 9,
          queuedPolicyExcluded: 3,
          visibleGaps: 4,
          metadataOnlyGap: 4,
        }),
        snapshot({
          queued: 12,
          queuedActionable: 0,
          queuedSuperseded: 9,
          queuedPolicyExcluded: 3,
          visibleGaps: 4,
          metadataOnlyGap: 4,
        }),
      ],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 1,
      batchSize: 1,
      qaVerdicts: ['qa_metadata_only_gap'],
      includePathPrefixes: ['/1 Projects/Active'],
      excludePathPrefixes: ['/1 Projects/Archive'],
      statusSnapshots: true,
    });

    expect(client.statusCalls).toHaveLength(2);
    expect(client.statusCalls[0]).toMatchObject({
      include_path_prefixes: ['/1 projects/active'],
      exclude_path_prefixes: ['/1 projects/archive'],
      qa_verdicts: ['qa_metadata_only_gap'],
      include_items: false,
    });
    expect(report.status).toBe('attention');
    expect(report.scopes[0]?.warnings.join('\n')).toContain('no actionable queued or leased extraction work');
    expect(report.scopes[0]?.warnings.join('\n')).toContain('ignored 12 non-actionable extraction job');
    expect(report.actions.join('\n')).toContain('QA-visible gaps remain but this lane has no actionable extraction work');
    expect(report.actions.join('\n')).not.toContain('supervisor request failed');
  });

  test('requires an explicit supervisor write gate in env', () => {
    expect(() => optionsFromEnv({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
    })).toThrow('OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ENABLED=true');

    const options = optionsFromEnv({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ENABLED: 'true',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_DROPBOX_SCOPES: `${SCOPE_A},${SCOPE_B}`,
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BATCH_SIZE: '1',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_CONCURRENCY: '7',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_QA_VERDICTS: 'qa_low_confidence_candidate_for_venice,qa_metadata_only_gap',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MIME_TYPES: 'application/pdf,image/png',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_INCLUDE_PATH_PREFIXES: '/1 Projects,/2 Areas',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_EXCLUDE_PATH_PREFIXES: '/1 Projects/Archive||/2 Areas/Photos',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_REQUIRED_ARTIFACT_KIND: 'text',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_REQUIRED_ARTIFACT_WARNING: 'ocr_required',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_SOURCE_EXTRACTOR_KINDS: 'venice_e2ee_document',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_SOURCE_JOB_STATUSES: 'failed_retryable',
    });

    expect(options.approvedScopeKeys).toEqual([SCOPE_A, SCOPE_B]);
    expect(options.batchSize).toBe(1);
    expect(options.concurrency).toBe(7);
    expect(options.embedAfterExtract).toBe(false);
    expect(options.qaVerdicts).toEqual(['qa_low_confidence_candidate_for_venice', 'qa_metadata_only_gap']);
    expect(options.mimeTypes).toEqual(['application/pdf', 'image/png']);
    expect(options.includePathPrefixes).toEqual(['/1 Projects', '/2 Areas']);
    expect(options.excludePathPrefixes).toEqual(['/1 Projects/Archive', '/2 Areas/Photos']);
    expect(options.requiredArtifactKind).toBe('text');
    expect(options.requiredArtifactWarning).toBe('ocr_required');
    expect(options.sourceExtractorKinds).toEqual(['venice_e2ee_document']);
    expect(options.sourceJobStatuses).toEqual(['failed_retryable']);
    expect(options.statusSnapshots).toBe(true);
  });

  test('attaches worker bearer auth to HTTP requests when configured', async () => {
    const requests: RequestInit[] = [];
    const options = optionsFromEnv({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ENABLED: 'true',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BASE_URL: 'http://worker.test/v1',
      OLYMPUS_WORKER_AUTH_TOKEN: ' supervisor-secret ',
    }, (async (_url, init) => {
      requests.push(init ?? {});
      return jsonResponse(plan({ jobsQueued: 1 }));
    }) as typeof fetch);

    await options.client.planDropboxContent({
      corpus_id: 'secure_local.dropbox.files',
      account: 'personal',
      approved_scope_key: SCOPE_A,
      extractor_kind: 'local_text',
      extractor_version: 'test',
      limit: 1,
    });

    expect(new Headers(requests[0]?.headers).get('authorization')).toBe('Bearer supervisor-secret');
  });

  test('normalizes bare-origin supervisor and janitor worker URLs before composing source routes', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url) => {
      urls.push(String(url));
      return jsonResponse(plan({ jobsQueued: 1 }));
    }) as typeof fetch;

    const supervisor = optionsFromEnv({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ENABLED: 'true',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BASE_URL: 'http://worker.test',
    }, fetchImpl);
    await supervisor.client.planDropboxContent({
      corpus_id: 'secure_local.dropbox.files',
      account: 'personal',
      approved_scope_key: SCOPE_A,
      extractor_kind: 'local_text',
      extractor_version: 'test',
      limit: 1,
    });

    const janitor = janitorOptionsFromEnv({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_SOURCE_PROCESSING_JANITOR_ENABLED: 'true',
      OLYMPUS_SOURCE_PROCESSING_JANITOR_BASE_URL: 'http://janitor-worker.test/',
    }, fetchImpl);
    await janitor.client.recycleDropboxContentLeases({
      corpus_id: 'secure_local.dropbox.files',
      account: 'personal',
      approved_scope_key: SCOPE_A,
      extractor_kind_prefix: 'local_',
      limit: 1,
      dry_run: true,
    });

    expect(urls).toEqual([
      'http://worker.test/v1/source/index/files/plan',
      'http://janitor-worker.test/v1/source/index/files/recycle-leases',
    ]);
  });

  test('omits worker bearer auth from HTTP requests when unset', async () => {
    const requests: RequestInit[] = [];
    const options = optionsFromEnv({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ENABLED: 'true',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BASE_URL: 'http://worker.test/v1',
    }, (async (_url, init) => {
      requests.push(init ?? {});
      return jsonResponse(plan({ jobsQueued: 1 }));
    }) as typeof fetch);

    await options.client.planDropboxContent({
      corpus_id: 'secure_local.dropbox.files',
      account: 'personal',
      approved_scope_key: SCOPE_A,
      extractor_kind: 'local_text',
      extractor_version: 'test',
      limit: 1,
    });

    expect(new Headers(requests[0]?.headers).has('authorization')).toBe(false);
  });

  test('can run concurrent extraction workers inside one supervisor cycle', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [
        batch({ leasedJobs: 1, counts: { indexed: 1 } }),
        batch({ leasedJobs: 1, counts: { metadata_only: 1 } }),
        batch({ leasedJobs: 1, counts: { skipped_too_large: 1 } }),
      ],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 1,
      planBeforeExtract: false,
      embedAfterExtract: false,
      batchSize: 1,
      concurrency: 3,
      workerId: 'drain-worker',
    });

    expect(client.extractCalls.map((call) => call.worker_id)).toEqual([
      'drain-worker-1',
      'drain-worker-2',
      'drain-worker-3',
    ]);
    expect(report.status).toBe('progress');
    expect(report.summary).toMatchObject({
      jobs_leased: 3,
      terminal_progress_jobs: 3,
    });
    expect(report.scopes[0]?.counts).toMatchObject({
      indexed: 1,
      metadata_only: 1,
      skipped_too_large: 1,
    });
  });

  test('passes raster OCR VLM escalation cap through supervisor-shaped planning request', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [batch({ leasedJobs: 0 })],
    });

    await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 1,
      qaVerdicts: ['qa_raster_ocr_vlm_escalation'],
      extractorKind: 'local_vlm_pdf',
      extractorVersion: '2026-07-07-local-vlm-raster-pdf-v1',
      mimeTypes: ['application/pdf'],
      planLimit: 100,
      qaRasterOcrVlmEscalationLimit: 10,
      batchSize: 1,
      leaseSeconds: 3600,
    });

    expect(client.planCalls).toHaveLength(1);
    expect(client.planCalls[0]).toMatchObject({
      extractor_kind: 'local_vlm_pdf',
      extractor_version: '2026-07-07-local-vlm-raster-pdf-v1',
      limit: 100,
      qa_raster_ocr_vlm_escalation_limit: 10,
      qa_verdicts: ['qa_raster_ocr_vlm_escalation'],
      mime_types: ['application/pdf'],
    });
    expect(client.extractCalls[0]).toMatchObject({
      extractor_kind: 'local_vlm_pdf',
      extractor_version: '2026-07-07-local-vlm-raster-pdf-v1',
      limit: 1,
      lease_seconds: 3600,
    });
  });

  test('can skip optional status snapshots so drain work is not blocked by status probes', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [
        batch({ leasedJobs: 1, counts: { indexed: 1 } }),
      ],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 1,
      statusSnapshots: false,
    });

    expect(client.statusCalls).toHaveLength(0);
    expect(client.planCalls).toHaveLength(1);
    expect(client.extractCalls).toHaveLength(1);
    expect(report.status).toBe('progress');
    expect(report.summary).toMatchObject({
      terminal_progress_jobs: 1,
      queued_before: 0,
      queued_after: 0,
    });
  });

  test('reports attention when QA-targeted cleanup has gaps but no actionable queue', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [
        batch({ leasedJobs: 0 }),
      ],
    }, {
      [SCOPE_A]: [
        snapshot({ queued: 0, leased: 0, metadataOnlyGap: 7, lowConfidenceRetryLocal: 3, visibleGaps: 10 }),
        snapshot({ queued: 0, leased: 0, metadataOnlyGap: 7, lowConfidenceRetryLocal: 3, visibleGaps: 10 }),
      ],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 1,
      planBeforeExtract: false,
      qaVerdicts: ['qa_metadata_only_gap', 'qa_low_confidence_retry_local'],
    });

    expect(report.status).toBe('attention');
    expect(report.summary).toMatchObject({
      jobs_leased: 0,
      queued_after: 0,
      leased_after: 0,
      qa_visible_gaps_after: 10,
      qa_metadata_only_gap_after: 7,
      qa_low_confidence_retry_local_after: 3,
    });
    expect(report.scopes[0]).toMatchObject({
      status: 'attention',
      warnings: ['QA-targeted supervisor found 10 remaining visible gap(s) but no actionable queued or leased extraction work.'],
    });
    expect(report.actions.join('\n')).toContain('QA-visible Dropbox gap(s) remain with no actionable queued or leased extraction work');
    expect(JSON.stringify(report)).not.toContain(SCOPE_A);
  });

  test('adapts concurrency when provider backpressure error kinds appear', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [
        batch({
          leasedJobs: 2,
          counts: { failed_retryable: 2 },
          records: [
            { status: 'failed_retryable', error_kind: 'venice_rate_limited' },
            { status: 'failed_retryable', error_kind: 'venice_rate_limited' },
          ],
        }),
        batch({ leasedJobs: 0 }),
        batch({ leasedJobs: 0 }),
        batch({ leasedJobs: 0 }),
        batch({ leasedJobs: 1, counts: { indexed: 1 } }),
        batch({ leasedJobs: 1, counts: { indexed: 1 } }),
        batch({ leasedJobs: 1, counts: { indexed: 1 } }),
      ],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 3,
      planBeforeExtract: false,
      embedAfterExtract: false,
      batchSize: 1,
      concurrency: 4,
      workerId: 'venice-drain',
      backpressureErrorKinds: ['venice_rate_limited'],
      backpressurePauseSeconds: 0,
      adaptiveConcurrency: true,
    });

    expect(client.extractCalls.map((call) => call.worker_id)).toEqual([
      'venice-drain-1',
      'venice-drain-2',
      'venice-drain-3',
      'venice-drain-4',
      'venice-drain-1',
      'venice-drain-2',
      'venice-drain-1',
      'venice-drain-2',
      'venice-drain-3',
    ]);
    expect(report.status).toBe('progress');
    expect(report.summary).toMatchObject({
      provider_backpressure_jobs: 2,
      terminal_progress_jobs: 3,
    });
    expect(report.scopes[0]).toMatchObject({
      provider_backpressure_jobs: 2,
      error_kind_counts: { venice_rate_limited: 2 },
    });
    expect(report.scopes[0]?.warnings.join('\n')).toContain('adaptive concurrency reduced from 4 to 2');
    expect(report.actions.join('\n')).toContain('provider backpressure observed');
  });

  test('can stop and report immediately on provider backpressure', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [
        batch({
          leasedJobs: 2,
          counts: { failed_retryable: 2 },
          records: [
            { status: 'failed_retryable', error_kind: 'venice_http_402' },
            { status: 'failed_retryable', error_kind: 'venice_rate_limited' },
          ],
        }),
        batch({ leasedJobs: 0 }),
        batch({ leasedJobs: 1, counts: { indexed: 1 } }),
      ],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 10,
      planBeforeExtract: false,
      embedAfterExtract: false,
      concurrency: 2,
      backpressureErrorKinds: ['venice_rate_limited', 'venice_http_402'],
      backpressurePauseSeconds: 300,
      adaptiveConcurrency: true,
      stopOnBackpressure: true,
    });

    expect(client.extractCalls).toHaveLength(2);
    expect(report.status).toBe('parked');
    expect(report.cycles_run).toBe(1);
    expect(report.summary.provider_backpressure_jobs).toBe(2);
    expect(report.scopes[0]?.warnings.join('\n')).toContain('provider backpressure stop requested');
    expect(report.scopes[0]?.effective_concurrency).toBe(1);
  });

  test('exits before worker calls when a provider pause marker is active', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'olympus-supervisor-pause-'));
    try {
      const pauseFile = join(tmp, 'venice-paused.json');
      writeFileSync(pauseFile, JSON.stringify({
        active: true,
        kind: 'venice',
        reason: 'provider_backpressure',
        error_kind: 'venice_http_402',
        created_at: '2026-06-23T12:00:00.000Z',
        message: 'Venice escalation paused because provider reported credit/payment exhaustion.',
      }));
      const client = new FakeSupervisorClient({
        [SCOPE_A]: [batch({ leasedJobs: 1, counts: { indexed: 1 } })],
      });

      const report = await runSourceProcessingSupervisor({
        client,
        approvedScopeKeys: [SCOPE_A],
        providerPauseFile: pauseFile,
        maxCycles: 10,
      });

      expect(client.statusCalls).toHaveLength(0);
      expect(client.planCalls).toHaveLength(0);
      expect(client.extractCalls).toHaveLength(0);
      expect(client.embedCalls).toHaveLength(0);
      expect(report.status).toBe('parked');
      expect(report.active_phase).toBe('paused');
      expect(report.provider_pause).toMatchObject({
        kind: 'venice',
        error_kind: 'venice_http_402',
      });
      expect(report.actions.join('\n')).toContain('credit/payment exhaustion');
      expect(report.actions.join('\n')).not.toContain('parked after repeated no-progress batches');
      expect(report.scopes[0]?.warnings.join('\n')).toContain('provider pause active');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('latches a provider pause marker on configured Venice credit exhaustion', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'olympus-supervisor-pause-'));
    try {
      const pauseFile = join(tmp, 'venice-paused.json');
      const client = new FakeSupervisorClient({
        [SCOPE_A]: [
          batch({
            leasedJobs: 1,
            counts: { failed_retryable: 1 },
            records: [{ status: 'failed_retryable', error_kind: 'venice_http_402' }],
          }),
          batch({ leasedJobs: 1, counts: { indexed: 1 } }),
        ],
      });

      const report = await runSourceProcessingSupervisor({
        client,
        approvedScopeKeys: [SCOPE_A],
        providerPauseFile: pauseFile,
        pauseOnBackpressureErrorKinds: ['venice_http_402'],
        planBeforeExtract: false,
        embedAfterExtract: false,
        maxCycles: 10,
        backpressurePauseSeconds: 300,
      });

      const pause = JSON.parse(readFileSync(pauseFile, 'utf8')) as Record<string, unknown>;
      expect(client.extractCalls).toHaveLength(1);
      expect(report.status).toBe('parked');
      expect(report.cycles_run).toBe(1);
      expect(report.summary.provider_backpressure_jobs).toBe(1);
      expect(report.provider_pause).toMatchObject({
        kind: 'venice',
        error_kind: 'venice_http_402',
      });
      expect(pause).toMatchObject({
        active: true,
        kind: 'venice',
        error_kind: 'venice_http_402',
      });
      expect(report.scopes[0]?.warnings.join('\n')).toContain('provider pause latched');
      expect(report.actions.join('\n')).toContain('refill credits');
      expect(report.actions.join('\n')).not.toContain('parked after repeated no-progress batches');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('unbounded drains park an attention failure instead of spinning', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [],
    }, {}, {}, {
      [SCOPE_A]: [new Error('Unable to connect. Is the computer able to access the url?')],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: Number.POSITIVE_INFINITY,
      maxRuntimeSeconds: Number.POSITIVE_INFINITY,
      planBeforeExtract: true,
      stopOnAttention: false,
    });

    expect(client.planCalls).toHaveLength(1);
    expect(client.extractCalls).toHaveLength(0);
    expect(report.status).toBe('parked');
    expect(report.cycles_run).toBe(2);
    expect(report.exhausted_cycle_budget).toBe(false);
    expect(report.scopes[0]).toMatchObject({
      status: 'parked',
      errors: ['Unable to connect. Is the computer able to access the url?'],
    });
    expect(report.scopes[0]?.warnings.join('\n')).toContain('scope parked for this unbounded run');
    expect(report.actions.join('\n')).toContain('scope parked after supervisor request failure');
  });

  test('emits bounded progress heartbeats while supervisor work is running', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [
        batch({ leasedJobs: 1, counts: { metadata_only: 1 } }),
      ],
    });
    const progressReports: Awaited<ReturnType<typeof runSourceProcessingSupervisor>>[] = [];

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 1,
      embedAfterExtract: false,
      progressHeartbeatSeconds: 0,
      onProgress: (progressReport) => progressReports.push(progressReport),
    });

    expect(report.run_state).toBe('complete');
    expect(report.active_phase).toBe('complete');
    expect(progressReports.length).toBeGreaterThanOrEqual(5);
    expect(progressReports[0]).toMatchObject({
      run_state: 'running',
      active_phase: 'starting',
    });
    expect(progressReports.map((progressReport) => progressReport.active_phase)).toContain('planning');
    expect(progressReports.map((progressReport) => progressReport.active_phase)).toContain('extracting');
    expect(progressReports.at(-1)).toMatchObject({
      run_state: 'complete',
      active_phase: 'complete',
      status: 'progress',
    });
    const serialized = JSON.stringify(progressReports);
    expect(serialized).not.toContain(SCOPE_A);
  });

  test('accepts drain-probe env sentinels without inventing fixed capacity limits', () => {
    const options = optionsFromEnv({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ENABLED: 'true',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_DROPBOX_SCOPES: SCOPE_A,
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PLAN_LIMIT: 'max',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BATCH_SIZE: 'max',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_CYCLES: 'unbounded',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_RUNTIME_SECONDS: 'unbounded',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_REQUEST_TIMEOUT_SECONDS: 'none',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_LEASE_SECONDS: 'max',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_CONSECUTIVE_NO_PROGRESS_BATCHES: 'disabled',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_WHEN_IDLE: 'true',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_ON_ATTENTION: 'true',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STATUS_SNAPSHOTS: 'false',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BACKPRESSURE_ERROR_KINDS: 'venice_rate_limited, venice_http_402',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PAUSE_ON_BACKPRESSURE_ERROR_KINDS: 'venice_http_402',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PROVIDER_PAUSE_FILE: '/tmp/olympus-source-processing-supervisor-venice-paused.json',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BACKPRESSURE_PAUSE_SECONDS: '0',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ADAPTIVE_CONCURRENCY: 'true',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_ON_BACKPRESSURE: 'true',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PROGRESS_HEARTBEAT_SECONDS: '0',
    });

    expect(options.planLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(options.batchSize).toBe(Number.MAX_SAFE_INTEGER);
    expect(options.maxCycles).toBe(Number.POSITIVE_INFINITY);
    expect(options.maxRuntimeSeconds).toBe(Number.POSITIVE_INFINITY);
    expect(options.requestTimeoutSeconds).toBe(Number.POSITIVE_INFINITY);
    expect(options.leaseSeconds).toBe(Number.MAX_SAFE_INTEGER);
    expect(options.maxConsecutiveNoProgressBatches).toBe(Number.POSITIVE_INFINITY);
    expect(options.stopWhenIdle).toBe(true);
    expect(options.stopOnAttention).toBe(true);
    expect(options.statusSnapshots).toBe(false);
    expect(options.backpressureErrorKinds).toEqual(['venice_rate_limited', 'venice_http_402']);
    expect(options.pauseOnBackpressureErrorKinds).toEqual(['venice_http_402']);
    expect(options.providerPauseFile).toBe('/tmp/olympus-source-processing-supervisor-venice-paused.json');
    expect(options.backpressurePauseSeconds).toBe(0);
    expect(options.adaptiveConcurrency).toBe(true);
    expect(options.stopOnBackpressure).toBe(true);
    expect(options.progressHeartbeatSeconds).toBe(0);

    const interchanged = optionsFromEnv({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ENABLED: 'true',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_DROPBOX_SCOPES: SCOPE_A,
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PLAN_LIMIT: 'unbounded',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BATCH_SIZE: 'unbounded',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_CYCLES: 'max',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_RUNTIME_SECONDS: 'max',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_REQUEST_TIMEOUT_SECONDS: 'max',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_LEASE_SECONDS: 'unbounded',
      OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_CONSECUTIVE_NO_PROGRESS_BATCHES: 'max',
    });

    expect(interchanged.planLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(interchanged.batchSize).toBe(Number.MAX_SAFE_INTEGER);
    expect(interchanged.maxCycles).toBe(Number.POSITIVE_INFINITY);
    expect(interchanged.maxRuntimeSeconds).toBe(Number.POSITIVE_INFINITY);
    expect(interchanged.requestTimeoutSeconds).toBe(Number.POSITIVE_INFINITY);
    expect(interchanged.leaseSeconds).toBe(Number.MAX_SAFE_INTEGER);
    expect(interchanged.maxConsecutiveNoProgressBatches).toBe(Number.POSITIVE_INFINITY);
  });

  test('can drain until a full idle pass instead of a fixed cycle budget', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [batch({ leasedJobs: 0 })],
      [SCOPE_B]: [batch({ leasedJobs: 0 })],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A, SCOPE_B],
      maxCycles: Number.POSITIVE_INFINITY,
      maxRuntimeSeconds: Number.POSITIVE_INFINITY,
      stopWhenIdle: true,
      planBeforeExtract: false,
    });

    expect(report.status).toBe('idle');
    expect(report.cycles_run).toBe(2);
    expect(report.exhausted_cycle_budget).toBe(false);
    expect(report.exhausted_time_budget).toBe(false);
    expect(client.extractCalls.map((call) => call.approved_scope_key)).toEqual([SCOPE_A, SCOPE_B]);
  });

  test('continuous unbounded drain re-polls across multiple idle sweeps until work arrives', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [
        batch({ leasedJobs: 0 }),
        batch({ leasedJobs: 0 }),
        batch({ leasedJobs: 1, counts: { indexed: 1 } }),
        batch({
          leasedJobs: 1,
          counts: { failed_retryable: 1 },
          records: [{ status: 'failed_retryable', error_kind: 'router_busy' }],
        }),
      ],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: Number.POSITIVE_INFINITY,
      maxRuntimeSeconds: Number.POSITIVE_INFINITY,
      stopWhenIdle: false,
      stopOnBackpressure: true,
      backpressureErrorKinds: ['router_busy'],
      idlePollSeconds: 0,
      planBeforeExtract: false,
      statusSnapshots: false,
    } as Parameters<typeof runSourceProcessingSupervisor>[0] & { idlePollSeconds: number });

    expect(client.extractCalls).toHaveLength(4);
    expect(report.cycles_run).toBe(4);
    expect(report.summary.terminal_progress_jobs).toBe(1);
    expect(report.scopes[0]).toMatchObject({ status: 'parked', jobs_leased: 2 });
  });

  test('drives private worker APIs without opening source stores directly', () => {
    expect(SUPERVISOR_SCRIPT).toContain("this.postJson('/source/index/files/plan'");
    expect(SUPERVISOR_SCRIPT).toContain("this.postJson('/source/index/files/extract'");
    expect(SUPERVISOR_SCRIPT).toContain("this.postJson('/source/index/files/recycle-leases'");
    expect(SUPERVISOR_SCRIPT).toContain("this.postJson('/source/index/files/janitor-requeue'");
    expect(SUPERVISOR_SCRIPT).toContain("this.postJson('/source/index/embed'");
    expect(SUPERVISOR_SCRIPT).toContain("this.postJson('/source/index/status'");
    expect(SUPERVISOR_SCRIPT).not.toContain('LocalDropboxFilesIndex');
    expect(SUPERVISOR_SCRIPT).not.toContain('dropbox-files/local-index');
    expect(SUPERVISOR_SCRIPT).not.toContain('bun:sqlite');
  });

  test('janitor emits sweep report shape and defaults terminal reclassification to dry-run', async () => {
    const client = new FakeSupervisorClient({}, {}, {}, {}, {
      recycleResults: {
        [SCOPE_A]: [leaseRecycle({ prefix: 'local_text', matched: 2, requeued: 2 })],
      },
      requeueResults: {
        [SCOPE_A]: [
          janitorRequeue({ mode: 'expired_retryable', matched: 3, requeued: 3, prefix: 'local_text' }),
          janitorRequeue({ mode: 'terminal_reclassification', matched: 25, requeued: 0, dryRun: true, extractor: 'local_text', lastErrorKind: 'unknown' }),
        ],
      },
    });

    const report = await runSourceProcessingJanitor({
      client,
      approvedScopeKeys: [SCOPE_A],
      staleLeaseExtractorKindPrefixes: ['local_text'],
      retryableExtractorKindPrefixes: ['local_text'],
      terminalClasses: [{ extractor_kind: 'local_text', last_error_kind: 'unknown' }],
      terminalClassBudget: 25,
      now: new Date('2026-07-09T10:00:00.000Z'),
    });

    expect(client.recycleCalls).toEqual([expect.objectContaining({
      approved_scope_key: SCOPE_A,
      extractor_kind_prefix: 'local_text',
      stale_only: true,
      dry_run: false,
    })]);
    expect(client.janitorRequeueCalls).toEqual([
      expect.objectContaining({ mode: 'expired_retryable', dry_run: false }),
      expect.objectContaining({ mode: 'terminal_reclassification', dry_run: true, limit: 25 }),
    ]);
    expect(report).toMatchObject({
      kind: 'source_processing_janitor_report',
      generated_at: '2026-07-09T10:00:00.000Z',
      apply_terminal_reclassification: false,
      status: 'complete',
      summary: {
        stale_leases_matched: 2,
        stale_leases_requeued: 2,
        expired_retryable_matched: 3,
        expired_retryable_requeued: 3,
        terminal_matched: 25,
        terminal_requeued: 0,
        terminal_dry_run: true,
      },
      policy: {
        direct_db_mutation: false,
        raw_source_exposed: false,
      },
    });
    expect(JSON.stringify(report)).not.toContain(SCOPE_A);
  });

  test('janitor warm-up failure skips local VLM work without marking jobs failed', async () => {
    const client = new FakeSupervisorClient({}, {}, {}, {}, {
      recycleResults: {
        [SCOPE_A]: [leaseRecycle({ prefix: 'local_text', matched: 1, requeued: 1 })],
      },
      requeueResults: {
        [SCOPE_A]: [
          janitorRequeue({ mode: 'expired_retryable', matched: 1, requeued: 1, prefix: 'local_text' }),
          janitorRequeue({ mode: 'terminal_reclassification', matched: 1, requeued: 0, dryRun: true, extractor: 'local_text', lastErrorKind: 'unknown' }),
        ],
      },
    });
    const fetchCalls: string[] = [];
    const failingFetch = (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      return new Response('cold load timeout', { status: 504 });
    }) as typeof fetch;

    const report = await runSourceProcessingJanitor({
      client,
      approvedScopeKeys: [SCOPE_A],
      staleLeaseExtractorKindPrefixes: ['local_vlm_pdf', 'local_text'],
      retryableExtractorKindPrefixes: ['local_vlm_pdf', 'local_text'],
      terminalClasses: [
        { extractor_kind: 'local_vlm_pdf', last_error_kind: 'unknown' },
        { extractor_kind: 'local_text', last_error_kind: 'unknown' },
      ],
      fetchImpl: failingFetch,
      vlmBaseUrl: 'http://vlm.test/v1',
      vlmModel: 'vlm-test-model',
      now: new Date('2026-07-09T10:05:00.000Z'),
    });

    expect(fetchCalls).toEqual(['http://vlm.test/v1/chat/completions']);
    expect(client.recycleCalls.map((call) => call.extractor_kind_prefix)).toEqual(['local_text']);
    expect(client.janitorRequeueCalls.map((call) => call.extractor_kind_prefix ?? call.extractor_kind)).toEqual(['local_text', 'local_text']);
    expect(report.status).toBe('complete_with_warnings');
    expect(report.vlm_warmup).toMatchObject({ attempted: true, skipped: true, ok: false });
    expect(report.stale_leases.find((item) => item.extractor_kind_prefix === 'local_vlm_pdf')).toMatchObject({
      matched_jobs: 0,
      jobs_requeued: 0,
      error: 'local_vlm_pdf warm-up failed; skipped this class',
    });
    expect(report.terminal_reclassification.find((item) => item.extractor_kind === 'local_vlm_pdf')).toMatchObject({
      matched_jobs: 0,
      jobs_requeued: 0,
      error: 'local_vlm_pdf warm-up failed; skipped this class',
    });
  });

  test('janitor forwards explicit network prior-guard opt-in for terminal classes', async () => {
    const client = new FakeSupervisorClient({}, {}, {}, {}, {
      requeueResults: {
        [SCOPE_A]: [
          janitorRequeue({ mode: 'expired_retryable', matched: 0, requeued: 0 }),
          janitorRequeue({
            mode: 'terminal_reclassification',
            matched: 1,
            requeued: 1,
            extractor: 'local_text',
            lastErrorKind: 'network_unreachable',
            networkGuardOverrideUsed: true,
          }),
        ],
      },
    });

    const report = await runSourceProcessingJanitor({
      client,
      approvedScopeKeys: [SCOPE_A],
      terminalClasses: [{ extractor_kind: 'local_text', last_error_kind: 'network_unreachable' }],
      allowNetworkTerminalRequeueAfterPriorJanitor: true,
      applyTerminalReclassification: true,
      warmVlmLane: false,
    });

    expect(client.janitorRequeueCalls.find((call) => call.mode === 'terminal_reclassification')).toMatchObject({
      extractor_kind: 'local_text',
      last_error_kind: 'network_unreachable',
      allow_network_terminal_requeue_after_prior_janitor: true,
    });
    expect(report.summary.network_guard_overrides_used).toBe(1);
  });

  test('the janitor default terminal classes cover the kinds the vision lane actually parks under', async () => {
    const client = new FakeSupervisorClient({}, {}, {}, {}, {});

    await runSourceProcessingJanitor({
      client,
      approvedScopeKeys: [SCOPE_A],
      warmVlmLane: false,
    });

    // Recovery has to exist by default, not only when an operator remembers to
    // name the class. A vision job comes to rest under its router kind once its
    // attempts are spent; a sweep that only knows OCR/text `unknown` never sees
    // it, and the runbook would be promising a recovery that cannot happen.
    const classes = client.janitorRequeueCalls
      .filter((call) => call.mode === 'terminal_reclassification')
      .map((call) => `${call.extractor_kind}:${call.last_error_kind}`);
    for (const kind of [
      'vlm_router_profile_unknown',
      'vlm_router_auth_failed',
      'vlm_router_request_rejected',
      'vlm_backend_unavailable',
    ]) {
      expect(classes).toContain(`local_vlm_pdf:${kind}`);
    }
  });

  test('a preflight lane failure reaches the supervisor as a backpressure stop, not as idle', async () => {
    const client = new FakeSupervisorClient({
      [SCOPE_A]: [
        batch({ leasedJobs: 0, preflightErrorKind: 'vlm_router_profile_unknown' }),
        batch({ leasedJobs: 1, counts: { indexed: 1 } }),
      ],
    });

    const report = await runSourceProcessingSupervisor({
      client,
      approvedScopeKeys: [SCOPE_A],
      maxCycles: 10,
      planBeforeExtract: false,
      embedAfterExtract: false,
      stopWhenIdle: false,
      backpressureErrorKinds: [
        'vlm_backend_unavailable',
        'vlm_router_profile_unknown',
        'vlm_router_auth_failed',
        'vlm_router_request_rejected',
      ],
      stopOnBackpressure: true,
    });

    // A gate that refuses before leasing produces no records, so its kind has to
    // travel on the batch itself — otherwise a broken lane reads as "idle" and
    // the run keeps polling a router it already knows is unusable.
    expect(client.extractCalls).toHaveLength(1);
    expect(report.status).toBe('parked');
    expect(report.summary.provider_backpressure_jobs).toBe(1);
    expect(report.scopes[0]?.error_kind_counts).toMatchObject({ vlm_router_profile_unknown: 1 });
    expect(report.scopes[0]?.warnings.join('\n')).toContain('provider backpressure stop requested');
  });

  test('janitor VLM warm-up names a Delphi vision profile on the router, never a backing model id', async () => {
    const options = janitorOptionsFromEnv({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_SOURCE_PROCESSING_JANITOR_ENABLED: 'true',
      OLYMPUS_SOURCE_PROCESSING_JANITOR_DROPBOX_SCOPES: SCOPE_A,
    });

    // The escalation tier is a profile id on the router, resolved from the Argus
    // vision profile config. Backing model ids rotate without notice, so one
    // hardcoded here is a live outage waiting for the next Delphi swap
    // (consumer contract §1). The retired bypass ports are ratcheted separately
    // by the consolidation boundary guard.
    const visionProfile = defaultConfig().argus.modelProfiles.vlm_qwen36_27b;
    expect(options.vlmBaseUrl).toBe(visionProfile.baseUrl);
    expect(options.vlmModel).toBe(visionProfile.model);
    expect(options.vlmModel).toBe('delphi/vision-deep');
    expect(SUPERVISOR_SCRIPT).not.toContain('mlx-community/');
  });

  test('janitor VLM warm-up sends a contract-shaped request and never sends reasoning_effort', async () => {
    const client = new FakeSupervisorClient({}, {}, {}, {}, {});
    const bodies: Array<Record<string, unknown>> = [];
    const capturingFetch = (async (url: string | URL | Request, init: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:28090/v1/chat/completions');
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    }) as unknown as typeof fetch;

    await runSourceProcessingJanitor({
      client,
      approvedScopeKeys: [SCOPE_A],
      staleLeaseExtractorKindPrefixes: ['local_vlm_pdf'],
      retryableExtractorKindPrefixes: [],
      terminalClasses: [],
      fetchImpl: capturingFetch,
      vlmBaseUrl: 'http://127.0.0.1:28090/v1',
      vlmModel: 'delphi/vision-deep',
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: 'delphi/vision-deep', temperature: 0 });
    // The backing runtime 400s on `reasoning_effort` as of 2026-08-19; the router
    // already suppresses thinking, so a consumer never asks (contract §4).
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  });

  test('janitor parses Venice terminal escalation env and reports counts-only escalation totals', async () => {
    const options = janitorOptionsFromEnv({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_SOURCE_PROCESSING_JANITOR_ENABLED: 'true',
      OLYMPUS_SOURCE_PROCESSING_JANITOR_DROPBOX_SCOPES: SCOPE_A,
      OLYMPUS_SOURCE_PROCESSING_JANITOR_TERMINAL_CLASSES: 'local_text:unknown:venice_grok43_document:2026-07-09',
      OLYMPUS_SOURCE_PROCESSING_JANITOR_ESCALATION_BUDGET: '2',
      OLYMPUS_SOURCE_PROCESSING_JANITOR_APPLY: 'true',
      OLYMPUS_SOURCE_PROCESSING_JANITOR_WARM_VLM: 'false',
    });
    expect(options.terminalClasses).toEqual([{
      extractor_kind: 'local_text',
      last_error_kind: 'unknown',
      target_extractor_kind: 'venice_grok43_document',
      target_extractor_version: '2026-07-09',
    }]);
    expect(options.escalationBudget).toBe(2);

    const client = new FakeSupervisorClient({}, {}, {}, {}, {
      requeueResults: {
        [SCOPE_A]: [
          janitorRequeue({ mode: 'expired_retryable', matched: 0, requeued: 0 }),
          janitorRequeue({
            mode: 'terminal_reclassification',
            matched: 4,
            requeued: 0,
            dryRun: false,
            extractor: 'local_text',
            lastErrorKind: 'unknown',
            targetExtractor: 'venice_grok43_document',
            targetVersion: '2026-07-09',
            escalated: 2,
            skippedPolicyExcluded: 1,
            skippedAlreadyEscalated: 0,
            skippedEscalationBudget: 1,
          }),
        ],
      },
    });

    const report = await runSourceProcessingJanitor({
      client,
      approvedScopeKeys: [SCOPE_A],
      ...(options.terminalClasses ? { terminalClasses: options.terminalClasses } : {}),
      ...(options.escalationBudget !== undefined ? { escalationBudget: options.escalationBudget } : {}),
      applyTerminalReclassification: true,
      warmVlmLane: false,
    });

    expect(client.janitorRequeueCalls.find((call) => call.mode === 'terminal_reclassification')).toMatchObject({
      extractor_kind: 'local_text',
      last_error_kind: 'unknown',
      target_extractor_kind: 'venice_grok43_document',
      target_extractor_version: '2026-07-09',
      escalation_budget: 2,
      reason: 'janitor_terminal_escalated_venice_grok43_document',
    });
    expect(report.summary.escalations).toEqual({
      budget_per_run: 2,
      budget_remaining: 0,
      matched: 4,
      escalated: 2,
      would_escalate: 0,
      policy_excluded: 1,
      already_escalated: 0,
      skipped_budget: 1,
    });
    expect(JSON.stringify(report)).not.toContain(SCOPE_A);
  });

  test('ensureReportPathDir creates missing report parent directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-supervisor-report-'));
    try {
      const reportPath = join(root, 'nested', 'lane', 'current.json');
      ensureReportPathDir(reportPath);
      writeFileSync(reportPath, '{}\n');
      expect(readFileSync(reportPath, 'utf8')).toBe('{}\n');
      // Idempotent when the directory already exists.
      ensureReportPathDir(reportPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

class FakeSupervisorClient implements SourceProcessingSupervisorClient {
  readonly planCalls: DropboxContentPlanRequest[] = [];
  readonly extractCalls: DropboxExtractionRequest[] = [];
  readonly embedCalls: DropboxEmbeddingRequest[] = [];
  readonly recycleCalls: DropboxContentLeaseRecycleRequest[] = [];
  readonly janitorRequeueCalls: DropboxContentJanitorRequeueRequest[] = [];
  readonly statusCalls: Array<{
    corpus_id: 'secure_local.dropbox.files';
    account: string;
    approved_scope_key: string;
    include_path_prefixes?: string[];
    exclude_path_prefixes?: string[];
    extractor_kind?: string;
    extractor_version?: string;
    qa_verdicts?: string[];
    mime_types?: string[];
    required_artifact_kind?: string;
    required_artifact_warning?: string;
    source_extractor_kinds?: string[];
    source_job_statuses?: string[];
    include_items: false;
  }> = [];

  constructor(
    private readonly batches: Record<string, DropboxContentExtractionBatchResult[]>,
    private readonly statuses: Record<string, SourceIndexStatusResult[]> = {},
    private readonly embedFailures: Record<string, Error[]> = {},
    private readonly planFailures: Record<string, Error[]> = {},
    private readonly janitorFixtures: {
      recycleResults?: Record<string, DropboxContentExtractionLeaseRecycleResult[]>;
      requeueResults?: Record<string, DropboxContentExtractionJanitorRequeueResult[]>;
    } = {},
  ) {}

  async planDropboxContent(request: DropboxContentPlanRequest): Promise<DropboxContentExtractionEnqueueResult> {
    this.planCalls.push(request);
    const failure = this.planFailures[request.approved_scope_key]?.shift();
    if (failure) throw failure;
    return plan({ jobsQueued: 1 });
  }

  async extractDropboxContent(request: DropboxExtractionRequest): Promise<DropboxContentExtractionBatchResult> {
    this.extractCalls.push(request);
    return this.batches[request.approved_scope_key]?.shift() ?? batch({ leasedJobs: 0 });
  }

  async recycleDropboxContentLeases(request: DropboxContentLeaseRecycleRequest): Promise<DropboxContentExtractionLeaseRecycleResult> {
    this.recycleCalls.push(request);
    return this.janitorFixtures.recycleResults?.[request.approved_scope_key]?.shift()
      ?? leaseRecycle({ prefix: request.extractor_kind_prefix, matched: 0, requeued: 0 });
  }

  async janitorRequeueDropboxContent(request: DropboxContentJanitorRequeueRequest): Promise<DropboxContentExtractionJanitorRequeueResult> {
    this.janitorRequeueCalls.push(request);
    return this.janitorFixtures.requeueResults?.[request.approved_scope_key]?.shift()
      ?? janitorRequeue({
        mode: request.mode,
        matched: 0,
        requeued: 0,
        dryRun: request.dry_run,
        ...(request.extractor_kind_prefix ? { prefix: request.extractor_kind_prefix } : {}),
        ...(request.extractor_kind ? { extractor: request.extractor_kind } : {}),
        ...(request.last_error_kind ? { lastErrorKind: request.last_error_kind } : {}),
        ...(request.target_extractor_kind ? { targetExtractor: request.target_extractor_kind } : {}),
        ...(request.target_extractor_version ? { targetVersion: request.target_extractor_version } : {}),
      });
  }

  async embedDropboxFiles(request: DropboxEmbeddingRequest): Promise<unknown> {
    this.embedCalls.push(request);
    const failure = this.embedFailures[request.approved_scope_key]?.shift();
    if (failure) throw failure;
    return { status: 'completed', chunks_seen: 1, chunks_embedded: 1 };
  }

  async sourceIndexStatus(request: {
    corpus_id: 'secure_local.dropbox.files';
    account: string;
    approved_scope_key: string;
    include_path_prefixes?: string[];
    exclude_path_prefixes?: string[];
    extractor_kind?: string;
    extractor_version?: string;
    qa_verdicts?: string[];
    mime_types?: string[];
    required_artifact_kind?: string;
    required_artifact_warning?: string;
    source_extractor_kinds?: string[];
    source_job_statuses?: string[];
    include_items: false;
  }): Promise<SourceIndexStatusResult> {
    this.statusCalls.push(request);
    return this.statuses[request.approved_scope_key]?.shift() ?? snapshot({});
  }
}

function plan(options: { jobsQueued: number; jobsExisting?: number }): DropboxContentExtractionEnqueueResult {
  return {
    kind: 'file_extraction_plan',
    corpus_id: 'secure_local.dropbox.files',
    candidates: options.jobsQueued + (options.jobsExisting ?? 0),
    jobs_queued: options.jobsQueued,
    jobs_existing: options.jobsExisting ?? 0,
    jobs_forced: 0,
    jobs_skipped_too_large: 0,
    jobs_unroutable: 0,
    extractor_kinds: ['local_text'],
    done: true,
    policy: {
      worker_private_surface: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_bytes_downloaded: false,
      local_only: true,
      trust_domain: 'secure_local',
    },
  };
}

function leaseRecycle(options: {
  prefix: string;
  matched: number;
  requeued: number;
  dryRun?: boolean;
}): DropboxContentExtractionLeaseRecycleResult {
  return {
    kind: 'file_extraction_lease_recycle',
    corpus_id: 'secure_local.dropbox.files',
    extractor_kind_prefix: options.prefix,
    matched_jobs: options.matched,
    jobs_requeued: options.requeued,
    dry_run: options.dryRun ?? false,
    stale_only: true,
  };
}

function janitorRequeue(options: {
  mode: 'expired_retryable' | 'terminal_reclassification';
  matched: number;
  requeued: number;
  dryRun?: boolean;
  prefix?: string;
  extractor?: string;
  lastErrorKind?: string;
  targetExtractor?: string;
  targetVersion?: string;
  escalated?: number;
  skippedPolicyExcluded?: number;
  skippedAlreadyEscalated?: number;
  skippedEscalationBudget?: number;
  skippedAttemptBudget?: number;
  skippedAlreadyJanitorRequeued?: number;
  networkGuardOverrideUsed?: boolean;
}): DropboxContentExtractionJanitorRequeueResult {
  return {
    kind: 'file_extraction_janitor_requeue',
    corpus_id: 'secure_local.dropbox.files',
    mode: options.mode,
    matched_jobs: options.matched,
    jobs_requeued: options.requeued,
    jobs_escalated: options.escalated ?? 0,
    skipped_attempt_budget: options.skippedAttemptBudget ?? 0,
    skipped_already_janitor_requeued: options.skippedAlreadyJanitorRequeued ?? 0,
    skipped_policy_excluded: options.skippedPolicyExcluded ?? 0,
    skipped_escalation_budget: options.skippedEscalationBudget ?? 0,
    skipped_target_exists: options.skippedAlreadyEscalated ?? 0,
    network_guard_override_used: options.networkGuardOverrideUsed ?? false,
    dry_run: options.dryRun ?? false,
    reason: 'janitor_test',
  };
}

function batch(options: {
  leasedJobs: number;
  counts?: Partial<DropboxContentExtractionBatchResult['counts']>;
  preflightErrorKind?: string;
  records?: Array<{
    status: DropboxContentExtractionBatchResult['records'][number]['status'];
    error_kind?: string;
  }>;
}): DropboxContentExtractionBatchResult {
  const counts: DropboxContentExtractionBatchResult['counts'] = {
    indexed: 0,
    metadata_only: 0,
    blocked_policy: 0,
    skipped_unsupported: 0,
    skipped_too_large: 0,
    failed_retryable: 0,
    failed_terminal: 0,
    ...options.counts,
  };
  return {
    kind: 'file_extraction_run',
    corpus_id: 'secure_local.dropbox.files',
    provider: 'dropbox',
    account: 'personal',
    scope_key_hash: 'scope-hash',
    worker_id_hash: 'worker-hash',
    leased_jobs: options.leasedJobs,
    processed_jobs: options.leasedJobs,
    abandoned_leases: 0,
    paused: false,
    consecutive_retryable_failures: 0,
    ...(options.preflightErrorKind ? { preflight_error_kind: options.preflightErrorKind } : {}),
    records: (options.records ?? []).map((record, index) => ({
      job_id: `job-${index}`,
      status: record.status,
      extractor_kind: 'local_text',
      extractor_version: 'test',
      attempts: 1,
      chunks_indexed: record.status === 'indexed' ? 1 : 0,
      ...(record.error_kind ? { error_kind: record.error_kind } : {}),
    })),
    counts,
    policy: {
      worker_private_surface: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_bytes_persisted: false,
      temp_bytes_cleaned: true,
      local_only: true,
      trust_domain: 'secure_local',
    },
  };
}

function snapshot(options: {
  queued?: number;
  queuedActionable?: number;
  queuedSuperseded?: number;
  queuedPolicyExcluded?: number;
  leased?: number;
  leasedCurrent?: number;
  leasedExpired?: number;
  failed?: number;
  failedActionable?: number;
  failedSuperseded?: number;
  failedPolicyExcluded?: number;
  chunks?: number;
  embedded?: number;
  files?: number;
  visibleGaps?: number;
  metadataOnlyGap?: number;
  lowConfidenceRetryLocal?: number;
  lowConfidenceCandidateForVenice?: number;
  failedNeedsOperator?: number;
  qaPending?: number;
}): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-06-21T11:30:00.000Z',
    corpora: [{
      corpus_id: 'secure_local.dropbox.files',
      family: 'file',
      trust_domain: 'secure_local',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'local_only',
      configured: true,
      provider: 'dropbox',
      counts: {
        accounts: 1,
        files: options.files ?? 10,
        folders: 0,
        tombstones: 0,
        secure_local_chunks: options.chunks ?? 0,
        extraction_artifacts: 0,
        extraction_jobs: 0,
        extraction_jobs_queued: options.queued ?? 0,
        extraction_jobs_queued_actionable: options.queuedActionable ?? options.queued ?? 0,
        extraction_jobs_queued_superseded: options.queuedSuperseded ?? 0,
        extraction_jobs_queued_policy_excluded: options.queuedPolicyExcluded ?? 0,
        extraction_jobs_leased: options.leased ?? 0,
        extraction_jobs_leased_current: options.leasedCurrent ?? options.leased ?? 0,
        extraction_jobs_leased_expired: options.leasedExpired ?? 0,
        extraction_jobs_blocked: 0,
        extraction_jobs_skipped: 0,
        extraction_jobs_failed: options.failed ?? 0,
        extraction_jobs_failed_actionable: options.failedActionable ?? options.failed ?? 0,
        extraction_jobs_failed_superseded: options.failedSuperseded ?? 0,
        extraction_jobs_failed_policy_excluded: options.failedPolicyExcluded ?? 0,
        sync_runs: 1,
        retrieval_audits: 0,
        semantic_runs: 1,
        embedding_models: 1,
        embedded_chunks: options.embedded ?? 0,
        qa_total_items: options.files ?? 10,
        qa_pass: 0,
        qa_metadata_only_expected: 0,
        qa_metadata_only_gap: options.metadataOnlyGap ?? 0,
        qa_raster_ocr_vlm_escalation: 0,
        qa_low_confidence_retry_local: options.lowConfidenceRetryLocal ?? 0,
        qa_low_confidence_candidate_for_venice: options.lowConfidenceCandidateForVenice ?? 0,
        qa_blocked_policy: 0,
        qa_failed_needs_operator: options.failedNeedsOperator ?? 0,
        qa_pending: options.qaPending ?? 0,
        qa_visible_gaps: options.visibleGaps ?? 0,
        qa_low_confidence: (options.lowConfidenceRetryLocal ?? 0) + (options.lowConfidenceCandidateForVenice ?? 0),
      },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'secure_local_item_metadata_not_exposed_to_castor',
    }],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}
