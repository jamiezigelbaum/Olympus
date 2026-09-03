import { describe, expect, test } from 'bun:test';
import {
  checkDropboxVeniceExtractionEnv,
  optionsFromEnv,
  runDropboxVeniceExtractionProof,
  type DropboxVeniceExtractionProofClient,
  type DropboxVeniceExtractionProofPlanRequest,
  type DropboxVeniceExtractionProofRunRequest,
} from '../scripts/dropbox-venice-extraction-proof.ts';
import type {
  FileExtractionRunResponse as DropboxContentExtractionBatchResult,
  FileExtractionPlanResponse as DropboxContentExtractionEnqueueResult,
} from '../src/workers/file-extraction/http-types.ts';

const SCOPE_A = 'dropbox.personal:/1 Projects';
const SCOPE_B = 'dropbox.personal:/2 Areas';

describe('Dropbox Venice extraction proof', () => {
  test('blocks without explicit Venice extraction env and does not call worker endpoints', async () => {
    const client = new FakeVeniceProofClient({
      plans: [plan({ jobsQueued: 1 })],
      batches: [batch({ leasedJobs: 1, counts: { indexed: 1 } })],
    });

    const report = await runDropboxVeniceExtractionProof({
      client,
      approvedScopeKeys: [SCOPE_A],
      now: new Date('2026-06-21T12:00:00.000Z'),
      env: {},
    });

    expect(report.status).toBe('blocked_missing_venice_env');
    expect(report.ok).toBe(false);
    expect(report.env_check.missing).toEqual([
      'OLYMPUS_FILE_EXTRACTION_REMOTE_ENABLED=true',
      'OLYMPUS_FILE_EXTRACTION_REMOTE_BASE_URL',
      'OLYMPUS_FILE_EXTRACTION_REMOTE_API_KEY or OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
    ]);
    expect(client.planCalls).toHaveLength(0);
    expect(client.extractCalls).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain(SCOPE_A);
  });

  test('plans one hard non-S5 Venice candidate and reports only safe hashes after indexing', async () => {
    const client = new FakeVeniceProofClient({
      plans: [plan({
        jobsQueued: 1,
        egressDestination: 'venice_private',
      })],
      batches: [batch({
        leasedJobs: 1,
        egressDestination: 'venice_private',
        counts: { indexed: 1 },
        records: [{
          job_id: 'raw-batch-job-id',
          status: 'indexed',
          provider_file_id_hash: 'provider-hash',
          chunks_indexed: 2,
          temp_bytes_cleaned: true,
        }],
      })],
    });

    const report = await runDropboxVeniceExtractionProof({
      client,
      approvedScopeKeys: [SCOPE_A],
      now: new Date('2026-06-21T12:00:00.000Z'),
      env: veniceEnv(),
    });

    expect(report.status).toBe('passed');
    expect(report.ok).toBe(true);
    expect(client.planCalls).toHaveLength(1);
    expect(client.planCalls[0]).toMatchObject({
      corpus_id: 'secure_local.dropbox.files',
      account: 'personal',
      approved_scope_key: SCOPE_A,
      extractor_kind: 'venice_e2ee_document',
      limit: 1,
      provider: 'dropbox',
      policy_decision: 'needs_review',
    });
    expect(client.planCalls[0]?.mime_types).toContain('application/pdf');
    expect(client.planCalls[0]?.mime_types).toContain('image/png');
    expect(client.extractCalls).toHaveLength(1);
    expect(client.extractCalls[0]).toMatchObject({
      corpus_id: 'secure_local.dropbox.files',
      account: 'personal',
      approved_scope_key: SCOPE_A,
      provider: 'dropbox',
      extractor_kind: 'venice_e2ee_document',
      limit: 1,
      lease_seconds: 300,
    });
    expect(report.summary).toMatchObject({
      jobs_queued: 1,
      jobs_leased: 1,
      indexed: 1,
      failed_retryable: 0,
    });
    expect(report.policy).toMatchObject({
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      direct_db_mutation: false,
      message_corpora_excluded: true,
      local_only: false,
      egress_destination: 'venice_private',
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SCOPE_A);
    expect(serialized).not.toContain('raw-job-id');
    expect(serialized).not.toContain('raw-batch-job-id');
  });

  test('accepts a TEE-resolved batch over a private-declared plan and reports the resolved category', async () => {
    // The plan's destination is the static approved floor the queue lifecycle
    // declares; the batch's is resolved against the live catalog at dispatch.
    // A TEE resolution over a venice_private declaration is a correctly
    // configured system — the proof must not fail it, and the report must
    // carry the resolved value.
    const client = new FakeVeniceProofClient({
      plans: [plan({ jobsQueued: 1, egressDestination: 'venice_private' })],
      batches: [batch({
        leasedJobs: 1,
        egressDestination: 'venice_tee',
        counts: { indexed: 1 },
        records: [{
          status: 'indexed',
          provider_file_id_hash: 'provider-hash',
          chunks_indexed: 1,
        }],
      })],
    });

    const report = await runDropboxVeniceExtractionProof({
      client,
      approvedScopeKeys: [SCOPE_A],
      now: new Date('2026-06-21T12:00:00.000Z'),
      env: veniceEnv(),
    });

    expect(report.status).toBe('passed');
    expect(report.ok).toBe(true);
    expect(report.scopes[0]?.egress_destination).toBe('venice_tee');
  });

  test('refuses an anonymized plan before asking the worker to extract a file', async () => {
    const client = new FakeVeniceProofClient({
      plans: [plan({ jobsQueued: 1, egressDestination: 'venice_anonymized' })],
      batches: [batch({ leasedJobs: 1, counts: { indexed: 1 }, egressDestination: 'venice_anonymized' })],
    });

    const report = await runDropboxVeniceExtractionProof({
      client,
      approvedScopeKeys: [SCOPE_A],
      now: new Date('2026-06-21T12:00:00.000Z'),
      env: veniceEnv(),
    });

    expect(report.status).toBe('attention');
    expect(report.ok).toBe(false);
    expect(client.planCalls).toHaveLength(1);
    expect(client.extractCalls).toHaveLength(0);
  });

  test('continues across empty scopes but stops after the first planned proof job', async () => {
    const client = new FakeVeniceProofClient({
      plans: [
        plan({ jobsQueued: 0 }),
        plan({ jobsQueued: 1 }),
        plan({ jobsQueued: 1 }),
      ],
      batches: [batch({ leasedJobs: 1, counts: { failed_retryable: 1 } })],
    });

    const report = await runDropboxVeniceExtractionProof({
      client,
      approvedScopeKeys: [SCOPE_A, SCOPE_B, 'dropbox.personal:/3 Resources'],
      now: new Date('2026-06-21T12:00:00.000Z'),
      env: veniceEnv(),
    });

    expect(report.status).toBe('blocked_worker_venice_env');
    expect(client.planCalls.map((call) => call.approved_scope_key)).toEqual([SCOPE_A, SCOPE_B]);
    expect(client.extractCalls.map((call) => call.approved_scope_key)).toEqual([SCOPE_B]);
    expect(report.summary).toMatchObject({
      jobs_queued: 1,
      jobs_leased: 1,
      failed_retryable: 1,
    });
  });

  test('reports Venice provider payload failures separately from missing worker env', async () => {
    const client = new FakeVeniceProofClient({
      plans: [plan({ jobsQueued: 1 })],
      batches: [batch({
        leasedJobs: 1,
        counts: { failed_retryable: 1 },
        records: [{
          status: 'failed_retryable',
          provider_file_id_hash: 'provider-hash',
          chunks_indexed: 0,
          error_hash: 'error-hash',
          error_kind: 'venice_image_validation_failed',
        }],
      })],
    });

    const report = await runDropboxVeniceExtractionProof({
      client,
      approvedScopeKeys: [SCOPE_A],
      now: new Date('2026-06-21T12:00:00.000Z'),
      env: veniceEnv(),
    });

    expect(report.status).toBe('blocked_worker_venice_payload');
    expect(report.actions.join(' ')).toContain('venice_image_validation_failed');
    expect(report.scopes[0]?.batch?.records[0]).toMatchObject({
      error_kind: 'venice_image_validation_failed',
    });
  });

  test('allows explicit service-env-only override for host-owned worker secrets', () => {
    expect(checkDropboxVeniceExtractionEnv({}, true)).toEqual({
      checked: false,
      service_env_override: true,
      missing: [],
      key_env_present: false,
    });
  });

  test('attaches worker bearer auth to live proof HTTP requests when configured', async () => {
    const requests: RequestInit[] = [];
    const options = optionsFromEnv({
      OLYMPUS_CONFIG: '/tmp/olympus-config-that-does-not-exist.json',
      OLYMPUS_DROPBOX_VENICE_EXTRACTION_PROOF_ENABLED: 'true',
      OLYMPUS_DROPBOX_VENICE_PROOF_BASE_URL: 'http://worker.test/v1',
      OLYMPUS_WORKER_AUTH_TOKEN: ' venice-proof-secret ',
    }, (async (_url, init) => {
      requests.push(init ?? {});
      return jsonResponse(plan({ jobsQueued: 1 }));
    }) as typeof fetch);

    await options.client.planDropboxContent({
      corpus_id: 'secure_local.dropbox.files',
      provider: 'dropbox',
      account: 'personal',
      approved_scope_key: SCOPE_A,
      extractor_kind: 'venice_e2ee_document',
      limit: 1,
      mime_types: ['application/pdf'],
      policy_decision: 'needs_review',
    });

    expect(new Headers(requests[0]?.headers).get('authorization')).toBe('Bearer venice-proof-secret');
  });
});

class FakeVeniceProofClient implements DropboxVeniceExtractionProofClient {
  readonly planCalls: DropboxVeniceExtractionProofPlanRequest[] = [];
  readonly extractCalls: DropboxVeniceExtractionProofRunRequest[] = [];

  constructor(private readonly responses: {
    plans: DropboxContentExtractionEnqueueResult[];
    batches: DropboxContentExtractionBatchResult[];
  }) {}

  async planDropboxContent(request: DropboxVeniceExtractionProofPlanRequest): Promise<DropboxContentExtractionEnqueueResult> {
    this.planCalls.push(request);
    return this.responses.plans.shift() ?? plan({ jobsQueued: 0 });
  }

  async extractDropboxContent(request: DropboxVeniceExtractionProofRunRequest): Promise<DropboxContentExtractionBatchResult> {
    this.extractCalls.push(request);
    return this.responses.batches.shift() ?? batch({ leasedJobs: 0 });
  }
}

function plan(options: {
  jobsQueued: number;
  jobsExisting?: number;
  egressDestination?: string;
}): DropboxContentExtractionEnqueueResult {
  return {
    kind: 'file_extraction_plan',
    corpus_id: 'secure_local.dropbox.files',
    candidates: options.jobsQueued + (options.jobsExisting ?? 0),
    jobs_queued: options.jobsQueued,
    jobs_existing: options.jobsExisting ?? 0,
    jobs_forced: 0,
    jobs_skipped_too_large: 0,
    jobs_unroutable: 0,
    extractor_kinds: ['venice_e2ee_document'],
    done: true,
    policy: {
      worker_private_surface: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_bytes_downloaded: false,
      local_only: false,
      egress_destination: (options.egressDestination ?? 'venice_e2ee') as 'venice_e2ee',
      trust_domain: 'secure_local',
    },
  };
}

function batch(options: {
  leasedJobs: number;
  counts?: Partial<DropboxContentExtractionBatchResult['counts']>;
  egressDestination?: string;
  records?: Array<{
    job_id?: string;
    status: string;
    provider_file_id_hash: string;
    chunks_indexed: number;
    temp_bytes_cleaned?: boolean;
    error_hash?: string;
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
    records: (options.records ?? []).map((record) => ({
      job_id: record.job_id ?? 'job-id',
      status: record.status as DropboxContentExtractionBatchResult['records'][number]['status'],
      extractor_kind: 'venice_e2ee_document',
      extractor_version: 'test',
      attempts: 1,
      chunks_indexed: record.chunks_indexed,
      ...(record.error_kind ? { error_kind: record.error_kind } : {}),
      egress_destination: (options.egressDestination ?? 'venice_e2ee') as 'venice_e2ee',
    })),
    counts,
    policy: {
      worker_private_surface: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_bytes_persisted: false,
      temp_bytes_cleaned: true,
      local_only: false,
      egress_destination: (options.egressDestination ?? 'venice_e2ee') as 'venice_e2ee',
      trust_domain: 'secure_local',
    },
  };
}

function veniceEnv(): Record<string, string> {
  return {
    OLYMPUS_FILE_EXTRACTION_REMOTE_ENABLED: 'true',
    OLYMPUS_FILE_EXTRACTION_REMOTE_BASE_URL: 'https://api.venice.ai/api/v1',
    OLYMPUS_SOURCE_INDEX_VENICE_API_KEY: 'test-key',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}
