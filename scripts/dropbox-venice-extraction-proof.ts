import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../src/core/config.ts';
import { withWorkerAuthHeader, workerAuthTokenFromConfig } from '../src/core/worker-auth.ts';
import type {
  FileExtractionPlanResponse as DropboxContentExtractionEnqueueResult,
  FileExtractionRunResponse as DropboxContentExtractionBatchResult,
} from '../src/workers/file-extraction/http-types.ts';

type DropboxVeniceEgressDestination =
  | 'venice_private'
  | 'venice_tee'
  | 'venice_e2ee'
  | 'venice_mixed_approved';

interface DropboxContentExtractionPlanRequest {
  corpus_id: typeof DROPBOX_CORPUS_ID;
  provider: 'dropbox';
  account: string;
  approved_scope_key: string;
  extractor_kind: string;
  limit: number;
  mime_types?: readonly string[];
  policy_decision: 'needs_review';
}

interface DropboxContentExtractionRunRequest {
  corpus_id: typeof DROPBOX_CORPUS_ID;
  provider: 'dropbox';
  account: string;
  approved_scope_key: string;
  extractor_kind: string;
  limit: number;
  lease_seconds: number;
}

const DROPBOX_CORPUS_ID = 'secure_local.dropbox.files' as const;
const DEFAULT_DROPBOX_SCOPES = [
  'dropbox.personal:/1 Projects',
  'dropbox.personal:/2 Areas',
  'dropbox.personal:/3 Resources',
] as const;
const DEFAULT_ACCOUNT = 'personal';
const DEFAULT_WORKER_ID = 'private-host-venice-proof';
const DEFAULT_EXTRACTOR_KIND = 'venice_e2ee_document';
const DEFAULT_EXTRACTOR_VERSION = '2026-06-21-m5-live-proof';
const DEFAULT_LIMIT = 1;
const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 240;
const DEFAULT_VENICE_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/gif',
] as const;
const VENICE_KEY_ENV_NAMES = [
  'OLYMPUS_FILE_EXTRACTION_REMOTE_API_KEY',
  'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
  'VENICE_API_KEY',
  'API_KEY_VENICE',
  'Venice-API-Key',
] as const;
const APPROVED_VENICE_EGRESS_DESTINATIONS = new Set<DropboxVeniceEgressDestination>([
  'venice_private',
  'venice_tee',
  'venice_e2ee',
  'venice_mixed_approved',
]);

export interface DropboxVeniceExtractionProofClient {
  planDropboxContent(request: DropboxVeniceExtractionProofPlanRequest): Promise<DropboxContentExtractionEnqueueResult>;
  extractDropboxContent(request: DropboxVeniceExtractionProofRunRequest): Promise<DropboxContentExtractionBatchResult>;
}

export type DropboxVeniceExtractionProofPlanRequest = DropboxContentExtractionPlanRequest & {
  corpus_id: typeof DROPBOX_CORPUS_ID;
};

export type DropboxVeniceExtractionProofRunRequest = DropboxContentExtractionRunRequest & {
  corpus_id: typeof DROPBOX_CORPUS_ID;
};

export interface DropboxVeniceExtractionProofOptions {
  client: DropboxVeniceExtractionProofClient;
  now?: Date;
  account?: string;
  approvedScopeKeys: string[];
  workerId?: string;
  extractorKind?: string;
  extractorVersion?: string;
  limit?: number;
  leaseSeconds?: number;
  requestTimeoutSeconds?: number;
  mimeTypes?: readonly string[];
  env?: Record<string, string | undefined>;
  allowServiceEnvOnly?: boolean;
}

export interface DropboxVeniceExtractionProofReport {
  kind: 'dropbox_venice_extraction_live_proof';
  generated_at: string;
  ok: boolean;
  status:
    | 'passed'
    | 'blocked_missing_venice_env'
    | 'blocked_no_candidate'
    | 'blocked_worker_venice_env'
    | 'blocked_worker_venice_payload'
    | 'attention';
  corpus_id: typeof DROPBOX_CORPUS_ID;
  extractor_kind: string;
  extractor_version: string;
  worker_id_hash: string;
  scopes_checked: number;
  scopes: DropboxVeniceExtractionScopeReport[];
  summary: {
    jobs_queued: number;
    jobs_existing: number;
    jobs_leased: number;
    indexed: number;
    metadata_only: number;
    blocked_policy: number;
    skipped_unsupported: number;
    skipped_too_large: number;
    failed_retryable: number;
    failed_terminal: number;
  };
  env_check: DropboxVeniceEnvCheck;
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    source_scope_keys_exposed: false;
    direct_db_mutation: false;
    message_corpora_excluded: true;
    worker_private_surface: true;
    local_only: false;
    egress_destination?: DropboxVeniceEgressDestination;
    trust_domain: 'secure_local';
  };
  actions: string[];
}

export interface DropboxVeniceExtractionScopeReport {
  scope_key_hash: string;
  egress_destination?: DropboxVeniceEgressDestination;
  status:
    | 'candidate_planned'
    | 'no_candidate'
    | 'indexed'
    | 'metadata_only'
    | 'blocked_policy'
    | 'failed_retryable'
    | 'failed_terminal'
    | 'attention';
  plan: {
    candidates: number;
    jobs_queued: number;
    jobs_existing: number;
    jobs_skipped_too_large: number;
    jobs_unroutable: number;
    extractor_kinds: readonly string[];
  };
  batch?: {
    leased_jobs: number;
    records: Array<{
      job_id_hash: string;
      status: string;
      chunks_indexed: number;
      error_kind?: string;
      egress_destination?: DropboxVeniceEgressDestination;
    }>;
    counts: DropboxContentExtractionBatchResult['counts'];
  };
}

export interface DropboxVeniceEnvCheck {
  checked: boolean;
  service_env_override: boolean;
  missing: string[];
  key_env_present: boolean;
}

interface HttpClientOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

class HttpDropboxVeniceExtractionProofClient implements DropboxVeniceExtractionProofClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly authToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async planDropboxContent(request: DropboxVeniceExtractionProofPlanRequest): Promise<DropboxContentExtractionEnqueueResult> {
    return this.postJson('/source/index/files/plan', request) as Promise<DropboxContentExtractionEnqueueResult>;
  }

  async extractDropboxContent(request: DropboxVeniceExtractionProofRunRequest): Promise<DropboxContentExtractionBatchResult> {
    return this.postJson('/source/index/files/extract', request) as Promise<DropboxContentExtractionBatchResult>;
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const init = withWorkerAuthHeader({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }, this.authToken);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function runDropboxVeniceExtractionProof(
  options: DropboxVeniceExtractionProofOptions,
): Promise<DropboxVeniceExtractionProofReport> {
  const generatedAt = options.now ?? new Date();
  const account = options.account?.trim() || DEFAULT_ACCOUNT;
  const workerId = options.workerId?.trim() || DEFAULT_WORKER_ID;
  const extractorKind = options.extractorKind?.trim() || DEFAULT_EXTRACTOR_KIND;
  const extractorVersion = options.extractorVersion?.trim() || DEFAULT_EXTRACTOR_VERSION;
  const limit = positiveIntOption(options.limit, DEFAULT_LIMIT, 'limit');
  const leaseSeconds = positiveIntOption(options.leaseSeconds, DEFAULT_LEASE_SECONDS, 'leaseSeconds');
  const scopes = normalizeScopes(options.approvedScopeKeys);
  const mimeTypes = normalizeStrings(options.mimeTypes ?? DEFAULT_VENICE_MIME_TYPES);
  const envCheck = checkDropboxVeniceExtractionEnv(options.env ?? process.env, Boolean(options.allowServiceEnvOnly));

  if (envCheck.missing.length > 0) {
    return baseReport({
      generatedAt,
      status: 'blocked_missing_venice_env',
      ok: false,
      extractorKind,
      extractorVersion,
      workerId,
      scopesChecked: 0,
      scopes: [],
      envCheck,
      actions: [
        `private host: add ${envCheck.missing.join(', ')} to olympus-email-source.service through the approved service env path, restart the source worker, then rerun this proof.`,
      ],
    });
  }

  const scopeReports: DropboxVeniceExtractionScopeReport[] = [];
  for (const scope of scopes) {
    const scopeReport = emptyScopeReport(scope);
    scopeReports.push(scopeReport);
    try {
      const plan = await options.client.planDropboxContent({
        corpus_id: DROPBOX_CORPUS_ID,
        provider: 'dropbox',
        account,
        approved_scope_key: scope,
        extractor_kind: extractorKind,
        limit,
        mime_types: mimeTypes,
        policy_decision: 'needs_review',
      });
      const planEgressDestination = assertVenicePlanPolicy(plan);
      scopeReport.egress_destination = planEgressDestination;
      scopeReport.plan = safePlanSummary(plan);
      if (plan.jobs_queued + plan.jobs_existing === 0) {
        scopeReport.status = 'no_candidate';
        continue;
      }

      scopeReport.status = 'candidate_planned';
      const batch = await options.client.extractDropboxContent({
        corpus_id: DROPBOX_CORPUS_ID,
        provider: 'dropbox',
        account,
        approved_scope_key: scope,
        extractor_kind: extractorKind,
        limit,
        lease_seconds: leaseSeconds,
      });
      const batchEgressDestination = assertVeniceBatchPolicy(batch);
      // No equality demand between the two: the plan's destination is the
      // static approved floor the queue lifecycle declares, while the batch's
      // is resolved against the live catalog at dispatch — a TEE or
      // mixed-approved resolution over a venice_private declaration is a
      // correctly configured system, not a defect. Both values have already
      // passed isApprovedVeniceEgressDestination above, which is the check
      // that carries the security weight; the resolved batch value is the
      // authoritative one and is what the report keeps.
      scopeReport.egress_destination = batchEgressDestination;
      scopeReport.batch = safeBatchSummary(batch);
      scopeReport.status = statusFromBatch(batch);
      break;
    } catch (error) {
      scopeReport.status = 'attention';
      return finalizeReport({
        generatedAt,
        status: 'attention',
        extractorKind,
        extractorVersion,
        workerId,
        scopes: scopeReports,
        envCheck,
        actions: [`dropbox:${scopeReport.scope_key_hash}: worker proof request failed; inspect source-worker health (${errorMessage(error)}).`],
      });
    }
  }

  const summary = summarizeScopes(scopeReports);
  if (summary.indexed > 0) {
    return finalizeReport({
      generatedAt,
      status: 'passed',
      extractorKind,
      extractorVersion,
      workerId,
      scopes: scopeReports,
      envCheck,
      actions: ['source-readiness: rerun embeddings/readiness proof after Venice extraction progress.'],
    });
  }
  if (summary.failed_retryable > 0) {
    const retryableKinds = scopeReports.flatMap((scope) =>
      scope.batch?.records
        .filter((record) => record.status === 'failed_retryable')
        .map((record) => record.error_kind)
        .filter((kind): kind is string => Boolean(kind)) ?? [],
    );
    if (retryableKinds.some((kind) => kind.startsWith('venice_'))) {
      return finalizeReport({
        generatedAt,
        status: 'blocked_worker_venice_payload',
        extractorKind,
        extractorVersion,
        workerId,
        scopes: scopeReports,
        envCheck,
        actions: [
          `private host: Venice is reachable, but the worker returned provider/payload failure (${[...new Set(retryableKinds)].join(', ')}); inspect the Dropbox Venice extractor request/media normalization path before retrying.`,
        ],
      });
    }
    return finalizeReport({
      generatedAt,
      status: 'blocked_worker_venice_env',
      extractorKind,
      extractorVersion,
      workerId,
      scopes: scopeReports,
      envCheck,
      actions: [
        'private host: the worker leased a Venice proof job but returned retryable failure; inspect olympus-email-source.service Venice env/client logs, then retry through this proof command.',
      ],
    });
  }
  if (scopeReports.every((scope) => scope.status === 'no_candidate')) {
    return finalizeReport({
      generatedAt,
      status: 'blocked_no_candidate',
      extractorKind,
      extractorVersion,
      workerId,
      scopes: scopeReports,
      envCheck,
      actions: ['dropbox: no approved non-S5 QA Venice candidate was available in the configured scopes; rerun readiness QA or provide a narrower approved scope with hard documents.'],
    });
  }
  return finalizeReport({
    generatedAt,
    status: 'attention',
    extractorKind,
    extractorVersion,
    workerId,
    scopes: scopeReports,
    envCheck,
    actions: ['dropbox: Venice proof made no indexed progress; if jobs_existing was nonzero, bump OLYMPUS_DROPBOX_VENICE_PROOF_EXTRACTOR_VERSION once and rerun.'],
  });
}

export function optionsFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): DropboxVeniceExtractionProofOptions {
  if (env.OLYMPUS_DROPBOX_VENICE_EXTRACTION_PROOF_ENABLED !== 'true') {
    throw new Error('OLYMPUS_DROPBOX_VENICE_EXTRACTION_PROOF_ENABLED=true is required for live Dropbox Venice proof writes.');
  }
  const requestTimeoutSeconds = positiveInt(
    env.OLYMPUS_DROPBOX_VENICE_PROOF_REQUEST_TIMEOUT_SECONDS,
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    'OLYMPUS_DROPBOX_VENICE_PROOF_REQUEST_TIMEOUT_SECONDS',
  );
  const config = loadConfig(env);
  const authToken = workerAuthTokenFromConfig(config);
  return {
    client: new HttpDropboxVeniceExtractionProofClient({
      baseUrl: env.OLYMPUS_DROPBOX_VENICE_PROOF_BASE_URL?.trim()
        || env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BASE_URL?.trim()
        || config.email.baseUrl,
      requestTimeoutMs: requestTimeoutSeconds * 1_000,
      ...(authToken ? { authToken } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    env,
    account: env.OLYMPUS_DROPBOX_VENICE_PROOF_ACCOUNT?.trim() || DEFAULT_ACCOUNT,
    approvedScopeKeys: csv(env.OLYMPUS_DROPBOX_VENICE_PROOF_SCOPES) || [...DEFAULT_DROPBOX_SCOPES],
    workerId: env.OLYMPUS_DROPBOX_VENICE_PROOF_WORKER_ID?.trim() || DEFAULT_WORKER_ID,
    extractorKind: env.OLYMPUS_DROPBOX_VENICE_PROOF_EXTRACTOR_KIND?.trim() || DEFAULT_EXTRACTOR_KIND,
    extractorVersion: env.OLYMPUS_DROPBOX_VENICE_PROOF_EXTRACTOR_VERSION?.trim() || DEFAULT_EXTRACTOR_VERSION,
    limit: positiveInt(env.OLYMPUS_DROPBOX_VENICE_PROOF_LIMIT, DEFAULT_LIMIT, 'OLYMPUS_DROPBOX_VENICE_PROOF_LIMIT'),
    leaseSeconds: positiveInt(env.OLYMPUS_DROPBOX_VENICE_PROOF_LEASE_SECONDS, DEFAULT_LEASE_SECONDS, 'OLYMPUS_DROPBOX_VENICE_PROOF_LEASE_SECONDS'),
    requestTimeoutSeconds,
    mimeTypes: csv(env.OLYMPUS_DROPBOX_VENICE_PROOF_MIME_TYPES) || [...DEFAULT_VENICE_MIME_TYPES],
    allowServiceEnvOnly: env.OLYMPUS_DROPBOX_VENICE_PROOF_ALLOW_SERVICE_ENV_ONLY === 'true',
  };
}

export function checkDropboxVeniceExtractionEnv(
  env: Record<string, string | undefined>,
  allowServiceEnvOnly = false,
): DropboxVeniceEnvCheck {
  if (allowServiceEnvOnly) {
    return {
      checked: false,
      service_env_override: true,
      missing: [],
      key_env_present: false,
    };
  }
  const missing: string[] = [];
  if (env.OLYMPUS_FILE_EXTRACTION_REMOTE_ENABLED?.trim() !== 'true') {
    missing.push('OLYMPUS_FILE_EXTRACTION_REMOTE_ENABLED=true');
  }
  if (!env.OLYMPUS_FILE_EXTRACTION_REMOTE_BASE_URL?.trim()) {
    missing.push('OLYMPUS_FILE_EXTRACTION_REMOTE_BASE_URL');
  }
  const keyEnvPresent = VENICE_KEY_ENV_NAMES.some((name) => Boolean(env[name]?.trim()));
  if (!keyEnvPresent) {
    missing.push('OLYMPUS_FILE_EXTRACTION_REMOTE_API_KEY or OLYMPUS_SOURCE_INDEX_VENICE_API_KEY');
  }
  return {
    checked: true,
    service_env_override: false,
    missing,
    key_env_present: keyEnvPresent,
  };
}

function finalizeReport(input: {
  generatedAt: Date;
  status: DropboxVeniceExtractionProofReport['status'];
  extractorKind: string;
  extractorVersion: string;
  workerId: string;
  scopes: DropboxVeniceExtractionScopeReport[];
  envCheck: DropboxVeniceEnvCheck;
  actions: string[];
}): DropboxVeniceExtractionProofReport {
  return baseReport({
    generatedAt: input.generatedAt,
    ok: input.status === 'passed',
    status: input.status,
    extractorKind: input.extractorKind,
    extractorVersion: input.extractorVersion,
    workerId: input.workerId,
    scopesChecked: input.scopes.length,
    scopes: input.scopes,
    envCheck: input.envCheck,
    actions: input.actions,
  });
}

function baseReport(input: {
  generatedAt: Date;
  ok: boolean;
  status: DropboxVeniceExtractionProofReport['status'];
  extractorKind: string;
  extractorVersion: string;
  workerId: string;
  scopesChecked: number;
  scopes: DropboxVeniceExtractionScopeReport[];
  envCheck: DropboxVeniceEnvCheck;
  actions: string[];
}): DropboxVeniceExtractionProofReport {
  const egressDestinations = [...new Set(
    input.scopes
      .map((scope) => scope.egress_destination)
      .filter((value): value is DropboxVeniceEgressDestination => value !== undefined),
  )];
  const egressDestination: DropboxVeniceEgressDestination | undefined = egressDestinations.length > 1
    ? 'venice_mixed_approved'
    : egressDestinations[0];
  return {
    kind: 'dropbox_venice_extraction_live_proof',
    generated_at: input.generatedAt.toISOString(),
    ok: input.ok,
    status: input.status,
    corpus_id: DROPBOX_CORPUS_ID,
    extractor_kind: input.extractorKind,
    extractor_version: input.extractorVersion,
    worker_id_hash: hashString(input.workerId),
    scopes_checked: input.scopesChecked,
    scopes: input.scopes,
    summary: summarizeScopes(input.scopes),
    env_check: input.envCheck,
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      direct_db_mutation: false,
      message_corpora_excluded: true,
      worker_private_surface: true,
      local_only: false,
      ...(egressDestination ? { egress_destination: egressDestination } : {}),
      trust_domain: 'secure_local',
    },
    actions: input.actions,
  };
}

function emptyScopeReport(scope: string): DropboxVeniceExtractionScopeReport {
  return {
    scope_key_hash: hashString(scope),
    status: 'no_candidate',
    plan: {
      candidates: 0,
      jobs_queued: 0,
      jobs_existing: 0,
      jobs_skipped_too_large: 0,
      jobs_unroutable: 0,
      extractor_kinds: [],
    },
  };
}

function safePlanSummary(plan: DropboxContentExtractionEnqueueResult): DropboxVeniceExtractionScopeReport['plan'] {
  return {
    candidates: plan.candidates,
    jobs_queued: plan.jobs_queued,
    jobs_existing: plan.jobs_existing,
    jobs_skipped_too_large: plan.jobs_skipped_too_large,
    jobs_unroutable: plan.jobs_unroutable,
    extractor_kinds: plan.extractor_kinds,
  };
}

function safeBatchSummary(batch: DropboxContentExtractionBatchResult): NonNullable<DropboxVeniceExtractionScopeReport['batch']> {
  return {
    leased_jobs: batch.leased_jobs,
    records: batch.records.map((record) => ({
      job_id_hash: hashString(record.job_id),
      status: record.status,
      chunks_indexed: record.chunks_indexed ?? 0,
      ...(record.error_kind ? { error_kind: record.error_kind } : {}),
      ...(record.egress_destination
        ? { egress_destination: record.egress_destination }
        : {}),
    })),
    counts: batch.counts,
  };
}

function statusFromBatch(batch: DropboxContentExtractionBatchResult): DropboxVeniceExtractionScopeReport['status'] {
  if (batch.counts.indexed > 0) return 'indexed';
  if (batch.counts.failed_retryable > 0) return 'failed_retryable';
  if (batch.counts.failed_terminal > 0) return 'failed_terminal';
  if (batch.counts.blocked_policy > 0) return 'blocked_policy';
  if (batch.counts.metadata_only > 0) return 'metadata_only';
  return 'attention';
}

function summarizeScopes(
  scopes: readonly DropboxVeniceExtractionScopeReport[],
): DropboxVeniceExtractionProofReport['summary'] {
  const emptyCounts: DropboxContentExtractionBatchResult['counts'] = {
    indexed: 0,
    metadata_only: 0,
    blocked_policy: 0,
    skipped_unsupported: 0,
    skipped_too_large: 0,
    failed_retryable: 0,
    failed_terminal: 0,
  };
  const counts = scopes.reduce((total, scope) => {
    const batchCounts = scope.batch?.counts ?? emptyCounts;
    return {
      indexed: total.indexed + batchCounts.indexed,
      metadata_only: total.metadata_only + batchCounts.metadata_only,
      blocked_policy: total.blocked_policy + batchCounts.blocked_policy,
      skipped_unsupported: total.skipped_unsupported + batchCounts.skipped_unsupported,
      skipped_too_large: total.skipped_too_large + batchCounts.skipped_too_large,
      failed_retryable: total.failed_retryable + batchCounts.failed_retryable,
      failed_terminal: total.failed_terminal + batchCounts.failed_terminal,
    };
  }, emptyCounts);
  return {
    jobs_queued: sum(scopes, (scope) => scope.plan.jobs_queued),
    jobs_existing: sum(scopes, (scope) => scope.plan.jobs_existing),
    jobs_leased: sum(scopes, (scope) => scope.batch?.leased_jobs ?? 0),
    ...counts,
  };
}

function assertVenicePlanPolicy(
  plan: DropboxContentExtractionEnqueueResult,
): DropboxVeniceEgressDestination {
  const policy = plan.policy;
  if (policy.raw_source_exposed !== false || policy.source_text_returned !== false || policy.file_bytes_downloaded !== false) {
    throw new Error('Dropbox Venice proof rejected unsafe content-plan policy.');
  }
  if (
    policy.local_only !== false
    || !isApprovedVeniceEgressDestination(policy.egress_destination)
    || policy.trust_domain !== 'secure_local'
  ) {
    throw new Error('Dropbox Venice proof requires recipe-aware Venice plan policy.');
  }
  return policy.egress_destination;
}

function assertVeniceBatchPolicy(
  batch: DropboxContentExtractionBatchResult,
): DropboxVeniceEgressDestination {
  const policy = batch.policy;
  if (
    policy.raw_source_exposed !== false
    || policy.source_text_returned !== false
    || policy.file_bytes_persisted !== false
    || policy.temp_bytes_cleaned !== true
    || policy.worker_private_surface !== true
  ) {
    throw new Error('Dropbox Venice proof rejected unsafe extraction policy.');
  }
  if (
    policy.local_only !== false
    || !isApprovedVeniceEgressDestination(policy.egress_destination)
    || policy.trust_domain !== 'secure_local'
  ) {
    throw new Error('Dropbox Venice proof requires recipe-aware Venice extraction policy.');
  }
  return policy.egress_destination;
}

function isApprovedVeniceEgressDestination(
  value: unknown,
): value is DropboxVeniceEgressDestination {
  return typeof value === 'string'
    && APPROVED_VENICE_EGRESS_DESTINATIONS.has(value as DropboxVeniceEgressDestination);
}

function normalizeScopes(scopes: readonly string[]): string[] {
  const normalized = normalizeStrings(scopes);
  if (normalized.length === 0) throw new Error('At least one Dropbox approved scope key is required.');
  return normalized;
}

function normalizeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function positiveInt(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function positiveIntOption(value: number | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function csv(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : 'unknown proof error';
}

function parseArgs(argv: string[]): { reportPath?: string } {
  const options: { reportPath?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--report') {
      const value = argv[index + 1];
      if (!value) throw new Error('--report requires a path.');
      options.reportPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const report = await runDropboxVeniceExtractionProof(optionsFromEnv(process.env));
  const json = JSON.stringify(report, null, 2);
  if (args.reportPath) {
    mkdirSync(dirname(args.reportPath), { recursive: true });
    writeFileSync(args.reportPath, `${json}\n`);
  }
  console.log(json);
  if (!report.ok) process.exit(1);
}
