import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { defaultConfig, loadConfig, normalizeSourceWorkerBaseUrl } from '../src/core/config.ts';
import { withWorkerAuthHeader, workerAuthTokenFromConfig } from '../src/core/worker-auth.ts';
import {
  dropboxPolicyApprovedScopeKeys,
  loadDropboxIngestionPolicy,
} from '../src/core/source-ingestion-policy.ts';
import type { SourceIndexStatusResult } from '../src/core/email.ts';
import type {
  FileExtractionJanitorRequeueResponse as DropboxContentExtractionJanitorRequeueResult,
  FileExtractionLeaseRecycleResponse as DropboxContentExtractionLeaseRecycleResult,
  FileExtractionPlanResponse as DropboxContentExtractionEnqueueResult,
  FileExtractionRunResponse as DropboxContentExtractionBatchResult,
} from '../src/workers/file-extraction/http-types.ts';

const DROPBOX_CORPUS_ID = 'secure_local.dropbox.files' as const;
const DEFAULT_DROPBOX_SCOPES = [
  'dropbox.personal:/1 Projects',
  'dropbox.personal:/2 Areas',
  'dropbox.personal:/3 Resources',
] as const;
const DEFAULT_EXTRACTOR_KIND = 'local_text';
const DEFAULT_EXTRACTOR_VERSION = '2026-05-22';
const DEFAULT_WORKER_ID = 'source-processing-supervisor';
const DEFAULT_BATCH_SIZE = 2;
const DEFAULT_PLAN_LIMIT = 25;
const DEFAULT_MAX_CYCLES = 6;
const DEFAULT_MAX_RUNTIME_SECONDS = 300;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 180;
const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_BATCHES = 3;
const DEFAULT_BACKPRESSURE_PAUSE_SECONDS = 300;
const DEFAULT_IDLE_POLL_SECONDS = 30;
const DEFAULT_PROGRESS_HEARTBEAT_SECONDS = 15;
const DEFAULT_JANITOR_CLASS_BUDGET = 25;
const DEFAULT_JANITOR_RETRYABLE_BUDGET = 100;
const DEFAULT_JANITOR_STALE_LEASE_BUDGET = 100;
// The janitor is currently scheduled at most once per day, so the per-run
// escalation budget is the daily cap until a durable daily ledger replaces it.
const DEFAULT_JANITOR_ESCALATION_BUDGET = 25;
const DEFAULT_VLM_WARMUP_TIMEOUT_SECONDS = 180;
// The OCR-escalation tier is a PROFILE on the Delphi router, never a backing
// model id: the model behind a profile rotates without notice, and the ids this
// warm-up used to carry named a retired bypass port and a model that no longer
// exists (docs/reference/delphi-consumer-contract.md §1-§2). The Argus vision
// profile config is the single place that knows the current escalation tier, so
// the defaults are read from it rather than restated here.
const ESCALATION_VISION_PROFILE_KEY = 'vlm_qwen36_27b' as const;

function escalationVisionProfile(): { baseUrl: string; model: string } {
  return defaultConfig().argus.modelProfiles[ESCALATION_VISION_PROFILE_KEY];
}

export interface DropboxExtractionRequest {
  corpus_id: typeof DROPBOX_CORPUS_ID;
  account: string;
  approved_scope_key: string;
  worker_id: string;
  extractor_kind: string;
  extractor_version: string;
  limit: number;
  lease_seconds: number;
  include_path_prefixes?: string[];
  exclude_path_prefixes?: string[];
}

export interface DropboxContentPlanRequest {
  corpus_id: typeof DROPBOX_CORPUS_ID;
  account: string;
  approved_scope_key: string;
  extractor_kind: string;
  extractor_version: string;
  limit: number;
  qa_verdicts?: string[];
  qa_raster_ocr_vlm_escalation_limit?: number;
  mime_types?: string[];
  include_path_prefixes?: string[];
  exclude_path_prefixes?: string[];
  required_artifact_kind?: string;
  required_artifact_warning?: string;
  source_extractor_kinds?: string[];
  source_job_statuses?: string[];
}

export interface DropboxEmbeddingRequest {
  corpus_id: typeof DROPBOX_CORPUS_ID;
  account: string;
  approved_scope_key: string;
}

export interface SourceProcessingSupervisorClient {
  planDropboxContent(request: DropboxContentPlanRequest): Promise<DropboxContentExtractionEnqueueResult>;
  extractDropboxContent(request: DropboxExtractionRequest): Promise<DropboxContentExtractionBatchResult>;
  recycleDropboxContentLeases(request: DropboxContentLeaseRecycleRequest): Promise<DropboxContentExtractionLeaseRecycleResult>;
  janitorRequeueDropboxContent(request: DropboxContentJanitorRequeueRequest): Promise<DropboxContentExtractionJanitorRequeueResult>;
  embedDropboxFiles(request: DropboxEmbeddingRequest): Promise<unknown>;
  sourceIndexStatus(request: {
    corpus_id: typeof DROPBOX_CORPUS_ID;
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
  }): Promise<SourceIndexStatusResult>;
}

export interface DropboxContentLeaseRecycleRequest {
  corpus_id: typeof DROPBOX_CORPUS_ID;
  account: string;
  approved_scope_key: string;
  extractor_kind_prefix: string;
  limit: number;
  dry_run: boolean;
  stale_only?: boolean;
}

export interface DropboxContentJanitorRequeueRequest {
  corpus_id: typeof DROPBOX_CORPUS_ID;
  account: string;
  approved_scope_key: string;
  mode: 'expired_retryable' | 'terminal_reclassification';
  extractor_kind?: string;
  extractor_kind_prefix?: string;
  last_error_kind?: string;
  target_extractor_kind?: string;
  target_extractor_version?: string;
  escalation_budget?: number;
  limit: number;
  dry_run: boolean;
  reason: string;
  allow_network_terminal_requeue_after_prior_janitor?: boolean;
}

export interface SourceProcessingSupervisorOptions {
  client: SourceProcessingSupervisorClient;
  now?: Date;
  account?: string;
  approvedScopeKeys: string[];
  workerId?: string;
  extractorKind?: string;
  extractorVersion?: string;
  qaVerdicts?: string[];
  mimeTypes?: string[];
  includePathPrefixes?: string[];
  excludePathPrefixes?: string[];
  requiredArtifactKind?: string;
  requiredArtifactWarning?: string;
  sourceExtractorKinds?: string[];
  sourceJobStatuses?: string[];
  planBeforeExtract?: boolean;
  planLimit?: number;
  qaRasterOcrVlmEscalationLimit?: number;
  batchSize?: number;
  concurrency?: number;
  maxCycles?: number;
  maxRuntimeSeconds?: number;
  requestTimeoutSeconds?: number;
  leaseSeconds?: number;
  embedAfterExtract?: boolean;
  maxConsecutiveNoProgressBatches?: number;
  stopWhenIdle?: boolean;
  stopOnAttention?: boolean;
  statusSnapshots?: boolean;
  backpressureErrorKinds?: string[];
  backpressurePauseSeconds?: number;
  idlePollSeconds?: number;
  pauseOnBackpressureErrorKinds?: string[];
  providerPauseFile?: string;
  adaptiveConcurrency?: boolean;
  stopOnBackpressure?: boolean;
  progressHeartbeatSeconds?: number;
  onProgress?: (report: SourceProcessingSupervisorReport) => void;
}

export interface SourceProcessingJanitorTerminalClass {
  extractor_kind: string;
  last_error_kind: string;
  target_extractor_kind?: string;
  target_extractor_version?: string;
}

export interface SourceProcessingJanitorOptions {
  client: SourceProcessingSupervisorClient;
  now?: Date;
  account?: string;
  approvedScopeKeys: string[];
  applyTerminalReclassification?: boolean;
  terminalClassBudget?: number;
  escalationBudget?: number;
  retryableBudget?: number;
  staleLeaseBudget?: number;
  staleLeaseExtractorKindPrefixes?: string[];
  retryableExtractorKindPrefixes?: string[];
  terminalClasses?: SourceProcessingJanitorTerminalClass[];
  allowNetworkTerminalRequeueAfterPriorJanitor?: boolean;
  warmVlmLane?: boolean;
  vlmBaseUrl?: string;
  vlmModel?: string;
  vlmWarmupTimeoutSeconds?: number;
  fetchImpl?: typeof fetch;
}

export interface SourceProcessingJanitorReport {
  kind: 'source_processing_janitor_report';
  generated_at: string;
  corpus_id: typeof DROPBOX_CORPUS_ID;
  apply_terminal_reclassification: boolean;
  status: 'complete' | 'complete_with_warnings';
  summary: {
    stale_leases_matched: number;
    stale_leases_requeued: number;
    expired_retryable_matched: number;
    expired_retryable_requeued: number;
    terminal_matched: number;
    terminal_requeued: number;
    terminal_dry_run: boolean;
    skipped_attempt_budget: number;
    skipped_already_janitor_requeued: number;
    network_guard_overrides_used: number;
    escalations: {
      budget_per_run: number;
      budget_remaining: number;
      matched: number;
      escalated: number;
      would_escalate: number;
      policy_excluded: number;
      already_escalated: number;
      skipped_budget: number;
    };
  };
  stale_leases: SourceProcessingJanitorLeaseActionReport[];
  expired_retryable: SourceProcessingJanitorRequeueActionReport[];
  terminal_reclassification: SourceProcessingJanitorRequeueActionReport[];
  vlm_warmup?: SourceProcessingJanitorVlmWarmupReport;
  warnings: string[];
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    source_scope_keys_exposed: false;
    direct_db_mutation: false;
    message_corpora_excluded: true;
  };
}

export interface SourceProcessingJanitorLeaseActionReport {
  scope_key_hash: string;
  extractor_kind_prefix: string;
  matched_jobs: number;
  jobs_requeued: number;
  dry_run: boolean;
  stale_only: boolean;
  error?: string;
}

export interface SourceProcessingJanitorRequeueActionReport {
  scope_key_hash: string;
  mode: 'expired_retryable' | 'terminal_reclassification';
  extractor_kind?: string;
  extractor_kind_prefix?: string;
  last_error_kind?: string;
  target_extractor_kind?: string;
  target_extractor_version?: string;
  matched_jobs: number;
  jobs_requeued: number;
  jobs_escalated: number;
  skipped_policy_excluded: number;
  skipped_already_escalated: number;
  skipped_escalation_budget: number;
  dry_run: boolean;
  skipped_attempt_budget: number;
  skipped_already_janitor_requeued: number;
  network_guard_override_used: boolean;
  error?: string;
}

export interface SourceProcessingJanitorVlmWarmupReport {
  attempted: boolean;
  skipped: boolean;
  ok: boolean;
  base_url_hash?: string;
  model_hash?: string;
  error?: string;
}

export interface SourceProcessingSupervisorProviderPause {
  active: true;
  kind: string;
  reason: string;
  error_kind?: string;
  created_at?: string;
  message: string;
}

export interface SourceProcessingSupervisorReport {
  kind: 'source_processing_supervisor_report';
  generated_at: string;
  updated_at: string;
  run_state: 'running' | 'complete';
  heartbeat_seq: number;
  active_phase?: 'starting' | 'paused' | 'status_before' | 'planning' | 'extracting' | 'embedding' | 'status_after' | 'complete';
  active_scope_hash?: string;
  corpus_id: typeof DROPBOX_CORPUS_ID;
  status: 'progress' | 'idle' | 'parked' | 'attention';
  cycles_run: number;
  exhausted_cycle_budget: boolean;
  exhausted_time_budget: boolean;
  scopes: SourceProcessingSupervisorScopeReport[];
  summary: {
    jobs_leased: number;
    jobs_planned: number;
    jobs_existing: number;
    terminal_progress_jobs: number;
    failed_retryable_jobs: number;
    embed_runs: number;
    embed_failed_runs: number;
    queued_before: number;
    queued_after: number;
    leased_before: number;
    leased_after: number;
    provider_backpressure_jobs: number;
    qa_visible_gaps_after: number;
    qa_stale_revision_after: number;
    qa_metadata_only_gap_after: number;
    qa_raster_ocr_vlm_escalation_after: number;
    qa_low_confidence_retry_local_after: number;
    qa_low_confidence_candidate_for_venice_after: number;
    qa_failed_needs_operator_after: number;
    qa_pending_after: number;
  };
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    source_scope_keys_exposed: false;
    direct_db_mutation: false;
    message_corpora_excluded: true;
  };
  provider_pause?: SourceProcessingSupervisorProviderPause;
  actions: string[];
}

export interface SourceProcessingSupervisorScopeReport {
  scope_key_hash: string;
  status: 'progress' | 'idle' | 'parked' | 'attention';
  cycles_run: number;
  jobs_leased: number;
  jobs_planned: number;
  jobs_existing: number;
  terminal_progress_jobs: number;
  failed_retryable_jobs: number;
  embed_runs: number;
  embed_failed_runs: number;
  provider_backpressure_jobs: number;
  effective_concurrency: number;
  consecutive_no_progress_batches: number;
  before?: ExtractionQueueSnapshot;
  after?: ExtractionQueueSnapshot;
  counts: DropboxContentExtractionBatchResult['counts'];
  error_kind_counts: Record<string, number>;
  warnings: string[];
  errors: string[];
}

export interface ExtractionQueueSnapshot {
  indexed_items: number;
  chunks: number;
  embedded_chunks: number;
  extraction_queued: number;
  extraction_queued_actionable?: number | undefined;
  extraction_queued_superseded?: number | undefined;
  extraction_queued_policy_excluded?: number | undefined;
  extraction_leased: number;
  extraction_leased_current?: number | undefined;
  extraction_leased_current_actionable?: number | undefined;
  extraction_leased_current_superseded?: number | undefined;
  extraction_leased_current_policy_excluded?: number | undefined;
  extraction_leased_expired?: number | undefined;
  extraction_leased_expired_actionable?: number | undefined;
  extraction_leased_expired_superseded?: number | undefined;
  extraction_leased_expired_policy_excluded?: number | undefined;
  extraction_failed: number;
  extraction_failed_actionable?: number | undefined;
  extraction_failed_superseded?: number | undefined;
  extraction_failed_policy_excluded?: number | undefined;
  qa_visible_gaps: number;
  qa_stale_revision: number;
  qa_metadata_only_gap: number;
  qa_partial_pages_gap: number;
  qa_raster_ocr_vlm_escalation: number;
  qa_low_confidence_retry_local: number;
  qa_low_confidence_candidate_for_venice: number;
  qa_failed_needs_operator: number;
  qa_pending: number;
}

interface HttpClientOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

class HttpSourceProcessingSupervisorClient implements SourceProcessingSupervisorClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly authToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.baseUrl = normalizeSourceWorkerBaseUrl(options.baseUrl);
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async extractDropboxContent(request: DropboxExtractionRequest): Promise<DropboxContentExtractionBatchResult> {
    return this.postJson('/source/index/files/extract', request) as Promise<DropboxContentExtractionBatchResult>;
  }

  async planDropboxContent(request: DropboxContentPlanRequest): Promise<DropboxContentExtractionEnqueueResult> {
    return this.postJson('/source/index/files/plan', request) as Promise<DropboxContentExtractionEnqueueResult>;
  }

  async recycleDropboxContentLeases(request: DropboxContentLeaseRecycleRequest): Promise<DropboxContentExtractionLeaseRecycleResult> {
    return this.postJson('/source/index/files/recycle-leases', request) as Promise<DropboxContentExtractionLeaseRecycleResult>;
  }

  async janitorRequeueDropboxContent(request: DropboxContentJanitorRequeueRequest): Promise<DropboxContentExtractionJanitorRequeueResult> {
    return this.postJson('/source/index/files/janitor-requeue', request) as Promise<DropboxContentExtractionJanitorRequeueResult>;
  }

  async embedDropboxFiles(request: DropboxEmbeddingRequest): Promise<unknown> {
    return this.postJson('/source/index/embed', request);
  }

  async sourceIndexStatus(request: {
    corpus_id: typeof DROPBOX_CORPUS_ID;
    account: string;
    approved_scope_key: string;
    include_items: false;
  }): Promise<SourceIndexStatusResult> {
    return this.postJson('/source/index/status', request) as Promise<SourceIndexStatusResult>;
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const useTimeout = Number.isFinite(this.requestTimeoutMs);
    const controller = useTimeout ? new AbortController() : undefined;
    const timeout = useTimeout ? setTimeout(() => controller?.abort(), this.requestTimeoutMs) : undefined;
    try {
      const init = withWorkerAuthHeader({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      }, this.authToken);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      return text ? JSON.parse(text) : {};
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export async function runSourceProcessingSupervisor(
  options: SourceProcessingSupervisorOptions,
): Promise<SourceProcessingSupervisorReport> {
  const generatedAt = options.now ?? new Date();
  const account = options.account?.trim() || 'personal';
  const workerId = options.workerId?.trim() || DEFAULT_WORKER_ID;
  const extractorKind = options.extractorKind?.trim() || DEFAULT_EXTRACTOR_KIND;
  const extractorVersion = options.extractorVersion?.trim() || DEFAULT_EXTRACTOR_VERSION;
  const qaVerdicts = normalizeOptionalList(options.qaVerdicts);
  const mimeTypes = normalizeOptionalList(options.mimeTypes).map((mimeType) => mimeType.toLowerCase());
  const includePathPrefixes = normalizeOptionalList(options.includePathPrefixes).map((prefix) => prefix.toLowerCase());
  const excludePathPrefixes = normalizeOptionalList(options.excludePathPrefixes).map((prefix) => prefix.toLowerCase());
  const sourceExtractorKinds = normalizeOptionalList(options.sourceExtractorKinds);
  const sourceJobStatuses = normalizeOptionalList(options.sourceJobStatuses);
  const planBeforeExtract = options.planBeforeExtract ?? true;
  const planLimit = positiveIntOption(options.planLimit, DEFAULT_PLAN_LIMIT, 'planLimit');
  const batchSize = positiveIntOption(options.batchSize, DEFAULT_BATCH_SIZE, 'batchSize');
  const concurrency = positiveIntOption(options.concurrency, 1, 'concurrency');
  const maxCycles = positiveIntOrUnboundedOption(options.maxCycles, DEFAULT_MAX_CYCLES, 'maxCycles');
  const maxRuntimeSeconds = positiveIntOrUnboundedOption(options.maxRuntimeSeconds, DEFAULT_MAX_RUNTIME_SECONDS, 'maxRuntimeSeconds');
  const leaseSeconds = positiveIntOption(options.leaseSeconds, DEFAULT_LEASE_SECONDS, 'leaseSeconds');
  const embedAfterExtract = options.embedAfterExtract ?? false;
  const maxConsecutiveNoProgressBatches = positiveIntOrUnboundedOption(
    options.maxConsecutiveNoProgressBatches,
    DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_BATCHES,
    'maxConsecutiveNoProgressBatches',
  );
  const stopWhenIdle = options.stopWhenIdle ?? false;
  const stopOnAttention = options.stopOnAttention ?? false;
  const statusSnapshots = options.statusSnapshots ?? true;
  const configuredBackpressureErrorKinds = normalizeOptionalList(options.backpressureErrorKinds);
  const pauseOnBackpressureErrorKinds = new Set(normalizeOptionalList(options.pauseOnBackpressureErrorKinds));
  const backpressureErrorKinds = new Set([
    ...configuredBackpressureErrorKinds,
    ...pauseOnBackpressureErrorKinds,
  ]);
  const backpressurePauseSeconds = nonNegativeIntOption(
    options.backpressurePauseSeconds,
    backpressureErrorKinds.size > 0 ? DEFAULT_BACKPRESSURE_PAUSE_SECONDS : 0,
    'backpressurePauseSeconds',
  );
  const idlePollSeconds = nonNegativeIntOption(
    options.idlePollSeconds,
    DEFAULT_IDLE_POLL_SECONDS,
    'idlePollSeconds',
  );
  const adaptiveConcurrency = options.adaptiveConcurrency ?? backpressureErrorKinds.size > 0;
  const stopOnBackpressure = options.stopOnBackpressure ?? false;
  const progressHeartbeatSeconds = nonNegativeIntOption(
    options.progressHeartbeatSeconds,
    DEFAULT_PROGRESS_HEARTBEAT_SECONDS,
    'progressHeartbeatSeconds',
  );
  const progressHeartbeatMs = progressHeartbeatSeconds * 1_000;
  const scopes = normalizeScopes(options.approvedScopeKeys);
  const reports = scopes.map((scope) => emptyScopeReport(scope));
  const effectiveConcurrencyByScope = new Map(scopes.map((scope) => [scope, concurrency] as const));
  const startedAt = Date.now();
  const deadlineMs = startedAt + maxRuntimeSeconds * 1_000;
  let cyclesRun = 0;
  let exhaustedTimeBudget = false;
  let consecutiveIdleScopeChecks = 0;
  let stopAfterCurrentCycle = false;
  let heartbeatSeq = 0;
  let providerPause = readProviderPause(options.providerPauseFile);

  const emitProgress = (
    phase: NonNullable<SourceProcessingSupervisorReport['active_phase']>,
    scope: string | undefined,
    runState: SourceProcessingSupervisorReport['run_state'] = 'running',
  ) => {
    if (!options.onProgress) return;
    heartbeatSeq += 1;
    options.onProgress(buildReport({
      generatedAt,
      updatedAt: new Date(),
      runState,
      heartbeatSeq,
      phase,
      scope,
      cyclesRun,
      maxCycles,
      exhaustedTimeBudget,
      reports,
      summary: summarizeScopes(reports),
      providerPause,
    }));
  };

  const withHeartbeat = async <T>(
    phase: NonNullable<SourceProcessingSupervisorReport['active_phase']>,
    scope: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> => {
    emitProgress(phase, scope);
    const interval = options.onProgress && progressHeartbeatMs > 0
      ? setInterval(() => emitProgress(phase, scope), progressHeartbeatMs)
      : undefined;
    try {
      return await operation();
    } finally {
      if (interval) clearInterval(interval);
    }
  };

  emitProgress('starting', undefined);

  if (providerPause) {
    for (const report of reports) {
      report.status = 'parked';
      report.warnings.push(`provider pause active: ${providerPause.error_kind ?? providerPause.reason}`);
    }
    const summary = summarizeScopes(reports);
    const pausedReport = buildReport({
      generatedAt,
      updatedAt: new Date(),
      runState: 'complete',
      heartbeatSeq: heartbeatSeq + 1,
      phase: 'paused',
      scope: undefined,
      cyclesRun,
      maxCycles,
      exhaustedTimeBudget,
      reports,
      summary,
      providerPause,
    });
    heartbeatSeq = pausedReport.heartbeat_seq;
    options.onProgress?.(pausedReport);
    return pausedReport;
  }

  if (statusSnapshots) {
    for (const report of reports) {
      const scope = scopeFromReport(report, scopes, reports);
      const before = await withHeartbeat('status_before', scope, () => readScopeSnapshot(options.client, account, scope, {
        extractorKind,
        extractorVersion,
        qaVerdicts,
        mimeTypes,
        includePathPrefixes,
        excludePathPrefixes,
        ...(options.requiredArtifactKind?.trim() ? { requiredArtifactKind: options.requiredArtifactKind.trim() } : {}),
        ...(options.requiredArtifactWarning?.trim() ? { requiredArtifactWarning: options.requiredArtifactWarning.trim() } : {}),
        sourceExtractorKinds,
        sourceJobStatuses,
      }));
      if (before) report.before = before;
    }
  }

  while (cyclesRun < maxCycles) {
    if (Date.now() >= deadlineMs) {
      exhaustedTimeBudget = true;
      break;
    }
    const scopeIndex = cyclesRun % scopes.length;
    const scope = scopes[scopeIndex]!;
    const scopeReport = reports[scopeIndex]!;
    if (scopeReport.status === 'parked') {
      cyclesRun += 1;
      consecutiveIdleScopeChecks += 1;
      if (consecutiveIdleScopeChecks >= scopes.length) break;
      continue;
    }
    cyclesRun += 1;
    scopeReport.cycles_run += 1;
    try {
      if (planBeforeExtract) {
        const plan = await withHeartbeat('planning', scope, () => options.client.planDropboxContent({
          corpus_id: DROPBOX_CORPUS_ID,
          account,
          approved_scope_key: scope,
          extractor_kind: extractorKind,
          extractor_version: extractorVersion,
          limit: planLimit,
          ...(options.qaRasterOcrVlmEscalationLimit !== undefined
            ? { qa_raster_ocr_vlm_escalation_limit: options.qaRasterOcrVlmEscalationLimit }
            : {}),
          ...(qaVerdicts.length > 0 ? { qa_verdicts: qaVerdicts } : {}),
          ...(mimeTypes.length > 0 ? { mime_types: mimeTypes } : {}),
          ...(includePathPrefixes.length > 0 ? { include_path_prefixes: includePathPrefixes } : {}),
          ...(excludePathPrefixes.length > 0 ? { exclude_path_prefixes: excludePathPrefixes } : {}),
          ...(options.requiredArtifactKind?.trim() ? { required_artifact_kind: options.requiredArtifactKind.trim() } : {}),
          ...(options.requiredArtifactWarning?.trim() ? { required_artifact_warning: options.requiredArtifactWarning.trim() } : {}),
          ...(sourceExtractorKinds.length > 0 ? { source_extractor_kinds: sourceExtractorKinds } : {}),
          ...(sourceJobStatuses.length > 0 ? { source_job_statuses: sourceJobStatuses } : {}),
        }));
        scopeReport.jobs_planned += plan.jobs_queued;
        scopeReport.jobs_existing += plan.jobs_existing;
      }
      const effectiveConcurrency = effectiveConcurrencyByScope.get(scope) ?? concurrency;
      scopeReport.effective_concurrency = effectiveConcurrency;
      const batch = summarizeExtractionBatches(await withHeartbeat('extracting', scope, () => Promise.all(
        Array.from({ length: effectiveConcurrency }, (_, index) => options.client.extractDropboxContent({
          corpus_id: DROPBOX_CORPUS_ID,
          account,
          approved_scope_key: scope,
          worker_id: concurrentWorkerId(workerId, index, effectiveConcurrency),
          extractor_kind: extractorKind,
          extractor_version: extractorVersion,
          limit: batchSize,
          lease_seconds: leaseSeconds,
          ...(includePathPrefixes.length > 0 ? { include_path_prefixes: includePathPrefixes } : {}),
          ...(excludePathPrefixes.length > 0 ? { exclude_path_prefixes: excludePathPrefixes } : {}),
        })),
      )));
      mergeCounts(scopeReport.counts, batch.counts);
      mergeErrorKindCounts(scopeReport.error_kind_counts, batch.error_kind_counts);
      if (batch.warnings.length > 0) scopeReport.warnings.push(...batch.warnings);
      scopeReport.jobs_leased += batch.leased_jobs;
      scopeReport.failed_retryable_jobs += batch.counts.failed_retryable;
      const providerBackpressureJobs = countBackpressureJobs(batch.error_kind_counts, backpressureErrorKinds);
      scopeReport.provider_backpressure_jobs += providerBackpressureJobs;
      consecutiveIdleScopeChecks = batch.leased_jobs === 0 ? consecutiveIdleScopeChecks + 1 : 0;
      const terminalProgress = terminalProgressJobs(batch.counts);
      scopeReport.terminal_progress_jobs += terminalProgress;
      if (providerBackpressureJobs > 0) {
        const kinds = backpressureKindsSummary(batch.error_kind_counts, backpressureErrorKinds);
        scopeReport.warnings.push(`provider backpressure from ${providerBackpressureJobs} job(s): ${kinds}`);
        const pauseErrorKind = firstMatchingErrorKind(batch.error_kind_counts, pauseOnBackpressureErrorKinds);
        if (pauseErrorKind) {
          providerPause = createProviderPause(pauseErrorKind, new Date());
          writeProviderPause(options.providerPauseFile, providerPause);
          scopeReport.status = 'parked';
          scopeReport.warnings.push(`provider pause latched: ${pauseErrorKind}`);
          stopAfterCurrentCycle = true;
        }
        if (adaptiveConcurrency && effectiveConcurrency > 1) {
          const nextConcurrency = Math.max(1, Math.floor(effectiveConcurrency / 2));
          effectiveConcurrencyByScope.set(scope, nextConcurrency);
          scopeReport.effective_concurrency = nextConcurrency;
          scopeReport.warnings.push(`adaptive concurrency reduced from ${effectiveConcurrency} to ${nextConcurrency}`);
        }
        if (backpressurePauseSeconds > 0 && !pauseErrorKind) {
          if (stopOnBackpressure) {
            scopeReport.warnings.push('provider backpressure stop requested; ending supervisor run after this cycle');
          } else {
            await sleep(backpressurePauseSeconds * 1_000);
          }
        } else if (stopOnBackpressure || pauseErrorKind) {
          scopeReport.warnings.push('provider backpressure stop requested; ending supervisor run after this cycle');
        }
        if (stopOnBackpressure) {
          stopAfterCurrentCycle = true;
        }
      } else if (adaptiveConcurrency && terminalProgress > 0 && effectiveConcurrency < concurrency) {
        const nextConcurrency = effectiveConcurrency + 1;
        effectiveConcurrencyByScope.set(scope, nextConcurrency);
        scopeReport.effective_concurrency = nextConcurrency;
      }
      if (batch.leased_jobs === 0) {
        scopeReport.status = scopeReport.jobs_leased > 0 ? 'progress' : 'idle';
        scopeReport.consecutive_no_progress_batches = 0;
      } else if (terminalProgress > 0) {
        scopeReport.status = 'progress';
        scopeReport.consecutive_no_progress_batches = 0;
      } else {
        scopeReport.consecutive_no_progress_batches += 1;
        if (scopeReport.consecutive_no_progress_batches >= maxConsecutiveNoProgressBatches) {
          scopeReport.status = 'parked';
          scopeReport.errors.push(`parked after ${scopeReport.consecutive_no_progress_batches} no-progress extraction batch(es)`);
        }
      }
      if (stopOnBackpressure && providerBackpressureJobs > 0 && terminalProgress === 0) {
        scopeReport.status = 'parked';
      }
      if (embedAfterExtract && batch.counts.indexed > 0) {
        try {
          await withHeartbeat('embedding', scope, () => options.client.embedDropboxFiles({
            corpus_id: DROPBOX_CORPUS_ID,
            account,
            approved_scope_key: scope,
          }));
          scopeReport.embed_runs += 1;
        } catch (error) {
          scopeReport.embed_failed_runs += 1;
          scopeReport.warnings.push(`embedding failed after extraction progress: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      scopeReport.status = 'attention';
      scopeReport.errors.push(errorMessage(error));
      consecutiveIdleScopeChecks = 0;
      if (stopOnAttention) break;
      if (!Number.isFinite(maxCycles)) {
        scopeReport.status = 'parked';
        scopeReport.warnings.push('scope parked for this unbounded run after supervisor request attention; later scopes can continue and the timer can retry this scope next cycle');
      }
    }
    if (stopAfterCurrentCycle) break;
    if (consecutiveIdleScopeChecks >= scopes.length) {
      if (stopWhenIdle) break;
      if (!Number.isFinite(maxCycles)) {
        consecutiveIdleScopeChecks = 0;
        await sleep(idlePollSeconds * 1_000);
      }
    }
  }

  if (Date.now() >= deadlineMs && cyclesRun < maxCycles) exhaustedTimeBudget = true;
  if (statusSnapshots) {
    for (let index = 0; index < reports.length; index += 1) {
      const after = await withHeartbeat('status_after', scopes[index]!, () => readScopeSnapshot(options.client, account, scopes[index]!, {
        extractorKind,
        extractorVersion,
        qaVerdicts,
        mimeTypes,
        includePathPrefixes,
        excludePathPrefixes,
        ...(options.requiredArtifactKind?.trim() ? { requiredArtifactKind: options.requiredArtifactKind.trim() } : {}),
        ...(options.requiredArtifactWarning?.trim() ? { requiredArtifactWarning: options.requiredArtifactWarning.trim() } : {}),
        sourceExtractorKinds,
        sourceJobStatuses,
      }));
      if (after) reports[index]!.after = after;
    }
  }
  annotateIdleQaGaps(reports, qaVerdicts, sourceJobStatuses);
  const summary = summarizeScopes(reports);
  const finalReport = buildReport({
    generatedAt,
    updatedAt: new Date(),
    runState: 'complete',
    heartbeatSeq: heartbeatSeq + 1,
    phase: 'complete',
    scope: undefined,
    cyclesRun,
    maxCycles,
    exhaustedTimeBudget,
    reports,
    summary,
    providerPause,
  });
  heartbeatSeq = finalReport.heartbeat_seq;
  options.onProgress?.(finalReport);
  return finalReport;
}

export async function runSourceProcessingJanitor(
  options: SourceProcessingJanitorOptions,
): Promise<SourceProcessingJanitorReport> {
  const generatedAt = options.now ?? new Date();
  const account = options.account?.trim() || 'personal';
  const scopes = normalizeScopes(options.approvedScopeKeys);
  const applyTerminalReclassification = options.applyTerminalReclassification ?? false;
  const terminalClassBudget = positiveIntOption(options.terminalClassBudget, DEFAULT_JANITOR_CLASS_BUDGET, 'terminalClassBudget');
  const escalationBudget = nonNegativeIntOption(options.escalationBudget, DEFAULT_JANITOR_ESCALATION_BUDGET, 'escalationBudget');
  const retryableBudget = positiveIntOption(options.retryableBudget, DEFAULT_JANITOR_RETRYABLE_BUDGET, 'retryableBudget');
  const staleLeaseBudget = positiveIntOption(options.staleLeaseBudget, DEFAULT_JANITOR_STALE_LEASE_BUDGET, 'staleLeaseBudget');
  const staleLeasePrefixes = normalizeOptionalList(options.staleLeaseExtractorKindPrefixes);
  const retryablePrefixes = normalizeOptionalList(options.retryableExtractorKindPrefixes);
  const terminalClasses = (options.terminalClasses && options.terminalClasses.length > 0
    ? options.terminalClasses
    : [
        { extractor_kind: 'local_ocr_tesseract', last_error_kind: 'unknown' },
        { extractor_kind: 'local_text', last_error_kind: 'unknown' },
        // The vision lane's own resting places. A job that spends its attempt
        // budget against a refusing router parks under the router kind, never
        // under `unknown`, so a sweep listing only the two classes above would
        // never see it — and the runbook would be promising a recovery that
        // cannot happen. Reclassification stays dry-run unless the caller opts
        // in, so listing a class only makes it visible.
        { extractor_kind: 'local_vlm_pdf', last_error_kind: 'vlm_router_profile_unknown' },
        { extractor_kind: 'local_vlm_pdf', last_error_kind: 'vlm_router_auth_failed' },
        { extractor_kind: 'local_vlm_pdf', last_error_kind: 'vlm_router_request_rejected' },
        { extractor_kind: 'local_vlm_pdf', last_error_kind: 'vlm_backend_unavailable' },
      ]).map((item) => ({
        extractor_kind: item.extractor_kind.trim(),
        last_error_kind: item.last_error_kind.trim(),
        ...(item.target_extractor_kind?.trim() ? { target_extractor_kind: item.target_extractor_kind.trim() } : {}),
        ...(item.target_extractor_version?.trim() ? { target_extractor_version: item.target_extractor_version.trim() } : {}),
      })).filter((item) => item.extractor_kind && item.last_error_kind);
  const warnings: string[] = [];
  const staleLeaseReports: SourceProcessingJanitorLeaseActionReport[] = [];
  const retryableReports: SourceProcessingJanitorRequeueActionReport[] = [];
  const terminalReports: SourceProcessingJanitorRequeueActionReport[] = [];
  let escalationBudgetRemaining = escalationBudget;
  const touchesLocalVlmPdf = [
    ...staleLeasePrefixes,
    ...retryablePrefixes,
    ...terminalClasses.map((item) => item.extractor_kind),
  ].some((value) => extractorSelectionTouchesLocalVlmPdf(value));
  let vlmWarmup: SourceProcessingJanitorVlmWarmupReport | undefined;

  if ((options.warmVlmLane ?? true) && touchesLocalVlmPdf) {
    vlmWarmup = await warmVlmLane({
      baseUrl: options.vlmBaseUrl?.trim() || escalationVisionProfile().baseUrl,
      model: options.vlmModel?.trim() || escalationVisionProfile().model,
      timeoutSeconds: positiveIntOption(options.vlmWarmupTimeoutSeconds, DEFAULT_VLM_WARMUP_TIMEOUT_SECONDS, 'vlmWarmupTimeoutSeconds'),
      fetchImpl: options.fetchImpl ?? fetch,
    });
    if (!vlmWarmup.ok) warnings.push(`vlm warm-up skipped local_vlm_pdf maintenance: ${vlmWarmup.error ?? 'unknown warm-up failure'}`);
  }
  const skipLocalVlmPdf = vlmWarmup && !vlmWarmup.ok;

  for (const scope of scopes) {
    for (const prefix of staleLeasePrefixes) {
      if (skipLocalVlmPdf && extractorSelectionTouchesLocalVlmPdf(prefix)) {
        staleLeaseReports.push(emptyLeaseAction(scope, prefix, 'local_vlm_pdf warm-up failed; skipped this class'));
        continue;
      }
      try {
        const result = await options.client.recycleDropboxContentLeases({
          corpus_id: DROPBOX_CORPUS_ID,
          account,
          approved_scope_key: scope,
          extractor_kind_prefix: prefix,
          limit: staleLeaseBudget,
          dry_run: false,
          stale_only: true,
        });
        staleLeaseReports.push({
          scope_key_hash: hashScope(scope),
          extractor_kind_prefix: result.extractor_kind_prefix,
          matched_jobs: result.matched_jobs,
          jobs_requeued: result.jobs_requeued,
          dry_run: result.dry_run,
          stale_only: result.stale_only,
        });
      } catch (error) {
        const message = errorMessage(error);
        warnings.push(`stale lease recycle failed for ${hashScope(scope)}/${prefix}: ${message}`);
        staleLeaseReports.push(emptyLeaseAction(scope, prefix, message));
      }
    }

    const retryableSelections = retryablePrefixes.length > 0 ? retryablePrefixes : [undefined];
    for (const prefix of retryableSelections) {
      if (prefix && skipLocalVlmPdf && extractorSelectionTouchesLocalVlmPdf(prefix)) {
        retryableReports.push(emptyRequeueAction(scope, 'expired_retryable', {
          extractorKindPrefix: prefix,
          error: 'local_vlm_pdf warm-up failed; skipped this class',
        }));
        continue;
      }
      try {
        const result = await options.client.janitorRequeueDropboxContent({
          corpus_id: DROPBOX_CORPUS_ID,
          account,
          approved_scope_key: scope,
          mode: 'expired_retryable',
          ...(prefix ? { extractor_kind_prefix: prefix } : {}),
          limit: retryableBudget,
          dry_run: false,
          reason: 'janitor_expired_retryable',
        });
        retryableReports.push(requeueReportFromResult(result, scope, {
          ...(prefix ? { extractorKindPrefix: prefix } : {}),
        }));
      } catch (error) {
        const message = errorMessage(error);
        warnings.push(`expired retryable requeue failed for ${hashScope(scope)}${prefix ? `/${prefix}` : ''}: ${message}`);
        retryableReports.push(emptyRequeueAction(scope, 'expired_retryable', {
          ...(prefix ? { extractorKindPrefix: prefix } : {}),
          error: message,
        }));
      }
    }

    for (const terminalClass of terminalClasses) {
      if (skipLocalVlmPdf && extractorSelectionTouchesLocalVlmPdf(terminalClass.extractor_kind)) {
        terminalReports.push(emptyRequeueAction(scope, 'terminal_reclassification', {
          extractorKind: terminalClass.extractor_kind,
          lastErrorKind: terminalClass.last_error_kind,
          error: 'local_vlm_pdf warm-up failed; skipped this class',
        }));
        continue;
      }
      try {
        const targetFields = terminalClass.target_extractor_kind && terminalClass.target_extractor_version
          ? {
            target_extractor_kind: terminalClass.target_extractor_kind,
            target_extractor_version: terminalClass.target_extractor_version,
            escalation_budget: escalationBudgetRemaining,
          }
          : {};
        const result = await options.client.janitorRequeueDropboxContent({
          corpus_id: DROPBOX_CORPUS_ID,
          account,
          approved_scope_key: scope,
          mode: 'terminal_reclassification',
          extractor_kind: terminalClass.extractor_kind,
          last_error_kind: terminalClass.last_error_kind,
          limit: terminalClassBudget,
          dry_run: !applyTerminalReclassification,
          reason: terminalClass.target_extractor_kind
            ? `janitor_terminal_escalated_${terminalClass.target_extractor_kind}`
            : `janitor_terminal_${terminalClass.extractor_kind}_${terminalClass.last_error_kind}`,
          ...targetFields,
          ...(options.allowNetworkTerminalRequeueAfterPriorJanitor
            ? { allow_network_terminal_requeue_after_prior_janitor: true }
            : {}),
        });
        if (!result.dry_run && result.jobs_escalated > 0) {
          escalationBudgetRemaining = Math.max(0, escalationBudgetRemaining - result.jobs_escalated);
        }
        terminalReports.push(requeueReportFromResult(result, scope, {
          extractorKind: terminalClass.extractor_kind,
          lastErrorKind: terminalClass.last_error_kind,
          ...(terminalClass.target_extractor_kind
            ? { targetExtractorKind: terminalClass.target_extractor_kind }
            : {}),
          ...(terminalClass.target_extractor_version
            ? { targetExtractorVersion: terminalClass.target_extractor_version }
            : {}),
        }));
      } catch (error) {
        const message = errorMessage(error);
        warnings.push(`terminal reclassification failed for ${hashScope(scope)}/${terminalClass.extractor_kind}/${terminalClass.last_error_kind}: ${message}`);
        terminalReports.push(emptyRequeueAction(scope, 'terminal_reclassification', {
          extractorKind: terminalClass.extractor_kind,
          lastErrorKind: terminalClass.last_error_kind,
          error: message,
        }));
      }
    }
  }

  const summary = {
    stale_leases_matched: sum(staleLeaseReports, (item) => item.matched_jobs),
    stale_leases_requeued: sum(staleLeaseReports, (item) => item.jobs_requeued),
    expired_retryable_matched: sum(retryableReports, (item) => item.matched_jobs),
    expired_retryable_requeued: sum(retryableReports, (item) => item.jobs_requeued),
    terminal_matched: sum(terminalReports, (item) => item.matched_jobs),
    terminal_requeued: sum(terminalReports, (item) => item.jobs_requeued),
    terminal_dry_run: !applyTerminalReclassification,
    skipped_attempt_budget: sum(retryableReports, (item) => item.skipped_attempt_budget)
      + sum(terminalReports, (item) => item.skipped_attempt_budget),
    skipped_already_janitor_requeued: sum(terminalReports, (item) => item.skipped_already_janitor_requeued),
    network_guard_overrides_used: terminalReports.filter((item) => item.network_guard_override_used).length,
    escalations: {
      budget_per_run: escalationBudget,
      budget_remaining: escalationBudgetRemaining,
      matched: sum(terminalReports, (item) => item.target_extractor_kind ? item.matched_jobs : 0),
      escalated: sum(terminalReports, (item) => item.jobs_escalated),
      would_escalate: sum(terminalReports, (item) => item.dry_run && item.target_extractor_kind
        ? item.matched_jobs - item.skipped_policy_excluded - item.skipped_already_escalated - item.skipped_escalation_budget
        : 0),
      policy_excluded: sum(terminalReports, (item) => item.skipped_policy_excluded),
      already_escalated: sum(terminalReports, (item) => item.skipped_already_escalated),
      skipped_budget: sum(terminalReports, (item) => item.skipped_escalation_budget),
    },
  };
  return {
    kind: 'source_processing_janitor_report',
    generated_at: generatedAt.toISOString(),
    corpus_id: DROPBOX_CORPUS_ID,
    apply_terminal_reclassification: applyTerminalReclassification,
    status: warnings.length > 0 ? 'complete_with_warnings' : 'complete',
    summary,
    stale_leases: staleLeaseReports,
    expired_retryable: retryableReports,
    terminal_reclassification: terminalReports,
    ...(vlmWarmup ? { vlm_warmup: vlmWarmup } : {}),
    warnings,
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      direct_db_mutation: false,
      message_corpora_excluded: true,
    },
  };
}

function buildReport(input: {
  generatedAt: Date;
  updatedAt: Date;
  runState: SourceProcessingSupervisorReport['run_state'];
  heartbeatSeq: number;
  phase: NonNullable<SourceProcessingSupervisorReport['active_phase']>;
  scope: string | undefined;
  cyclesRun: number;
  maxCycles: number;
  exhaustedTimeBudget: boolean;
  reports: SourceProcessingSupervisorScopeReport[];
  summary: SourceProcessingSupervisorReport['summary'];
  providerPause: SourceProcessingSupervisorProviderPause | undefined;
}): SourceProcessingSupervisorReport {
  const parked = input.reports.some((scope) => scope.status === 'parked');
  const attention = input.reports.some((scope) => scope.status === 'attention');
  const progress = input.summary.terminal_progress_jobs > 0 || input.summary.embed_runs > 0;
  const actions = actionsFromReport({
    reports: input.reports,
    exhaustedTimeBudget: input.exhaustedTimeBudget,
    exhaustedCycleBudget: input.cyclesRun >= input.maxCycles,
    summary: input.summary,
    providerPause: input.providerPause,
  });
  return {
    kind: 'source_processing_supervisor_report',
    generated_at: input.generatedAt.toISOString(),
    updated_at: input.updatedAt.toISOString(),
    run_state: input.runState,
    heartbeat_seq: input.heartbeatSeq,
    active_phase: input.phase,
    ...(input.scope ? { active_scope_hash: hashScope(input.scope) } : {}),
    corpus_id: DROPBOX_CORPUS_ID,
    status: input.providerPause ? 'parked' : attention ? 'attention' : progress ? 'progress' : parked ? 'parked' : 'idle',
    cycles_run: input.cyclesRun,
    exhausted_cycle_budget: input.cyclesRun >= input.maxCycles,
    exhausted_time_budget: input.exhaustedTimeBudget,
    scopes: input.reports,
    summary: input.summary,
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      direct_db_mutation: false,
      message_corpora_excluded: true,
    },
    ...(input.providerPause ? { provider_pause: input.providerPause } : {}),
    actions,
  };
}

function requeueReportFromResult(
  result: DropboxContentExtractionJanitorRequeueResult,
  scope: string,
  selection: {
    extractorKind?: string;
    extractorKindPrefix?: string;
    lastErrorKind?: string;
    targetExtractorKind?: string;
    targetExtractorVersion?: string;
  },
): SourceProcessingJanitorRequeueActionReport {
  return {
    scope_key_hash: hashScope(scope),
    mode: result.mode,
    ...(selection.extractorKind ? { extractor_kind: selection.extractorKind } : {}),
    ...(selection.extractorKindPrefix ? { extractor_kind_prefix: selection.extractorKindPrefix } : {}),
    ...(selection.lastErrorKind ? { last_error_kind: selection.lastErrorKind } : {}),
    ...(selection.targetExtractorKind ? { target_extractor_kind: selection.targetExtractorKind } : {}),
    ...(selection.targetExtractorVersion ? { target_extractor_version: selection.targetExtractorVersion } : {}),
    matched_jobs: result.matched_jobs,
    jobs_requeued: result.jobs_requeued,
    jobs_escalated: result.jobs_escalated,
    dry_run: result.dry_run,
    skipped_attempt_budget: result.skipped_attempt_budget,
    skipped_policy_excluded: result.skipped_policy_excluded,
    skipped_already_escalated: result.skipped_target_exists,
    skipped_escalation_budget: result.skipped_escalation_budget,
    skipped_already_janitor_requeued: result.skipped_already_janitor_requeued,
    network_guard_override_used: result.network_guard_override_used,
  };
}

function emptyLeaseAction(
  scope: string,
  extractorKindPrefix: string,
  error: string,
): SourceProcessingJanitorLeaseActionReport {
  return {
    scope_key_hash: hashScope(scope),
    extractor_kind_prefix: extractorKindPrefix,
    matched_jobs: 0,
    jobs_requeued: 0,
    dry_run: false,
    stale_only: true,
    error,
  };
}

function emptyRequeueAction(
  scope: string,
  mode: SourceProcessingJanitorRequeueActionReport['mode'],
  options: {
    extractorKind?: string;
    extractorKindPrefix?: string;
    lastErrorKind?: string;
    error: string;
  },
): SourceProcessingJanitorRequeueActionReport {
  return {
    scope_key_hash: hashScope(scope),
    mode,
    ...(options.extractorKind ? { extractor_kind: options.extractorKind } : {}),
    ...(options.extractorKindPrefix ? { extractor_kind_prefix: options.extractorKindPrefix } : {}),
    ...(options.lastErrorKind ? { last_error_kind: options.lastErrorKind } : {}),
    matched_jobs: 0,
    jobs_requeued: 0,
    jobs_escalated: 0,
    dry_run: mode === 'terminal_reclassification',
    skipped_attempt_budget: 0,
    skipped_policy_excluded: 0,
    skipped_already_escalated: 0,
    skipped_escalation_budget: 0,
    skipped_already_janitor_requeued: 0,
    network_guard_override_used: false,
    error: options.error,
  };
}

function extractorSelectionTouchesLocalVlmPdf(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized === 'local_vlm_pdf' || 'local_vlm_pdf'.startsWith(normalized);
}

async function warmVlmLane(options: {
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  fetchImpl: typeof fetch;
}): Promise<SourceProcessingJanitorVlmWarmupReport> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutSeconds * 1_000);
  const baseUrl = trimTrailingSlash(options.baseUrl);
  try {
    const response = await options.fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: 'Reply ok.' }],
        max_tokens: 1,
        temperature: 0,
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        attempted: true,
        skipped: true,
        ok: false,
        base_url_hash: hashScope(baseUrl),
        model_hash: hashScope(options.model),
        error: `HTTP ${response.status}: ${text.slice(0, 120)}`,
      };
    }
    return {
      attempted: true,
      skipped: false,
      ok: true,
      base_url_hash: hashScope(baseUrl),
      model_hash: hashScope(options.model),
    };
  } catch (error) {
    return {
      attempted: true,
      skipped: true,
      ok: false,
      base_url_hash: hashScope(baseUrl),
      model_hash: hashScope(options.model),
      error: errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function optionsFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): SourceProcessingSupervisorOptions {
  if (env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ENABLED !== 'true') {
    throw new Error('OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ENABLED=true is required for source processing supervisor writes.');
  }
  const config = loadConfig(env);
  const authToken = workerAuthTokenFromConfig(config);
  const dropboxPolicy = loadDropboxIngestionPolicy({
    inlinePolicy: config.sourceIndex.ingestionPolicies.dropboxPersonal?.policy,
    policyPath: config.sourceIndex.ingestionPolicies.dropboxPersonal?.policyPath,
    env,
  });
  const requestTimeoutSeconds = positiveIntOrUnbounded(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_REQUEST_TIMEOUT_SECONDS, DEFAULT_REQUEST_TIMEOUT_SECONDS, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_REQUEST_TIMEOUT_SECONDS');
  const qaVerdicts = csv(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_QA_VERDICTS);
  const mimeTypes = csv(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MIME_TYPES);
  const includePathPrefixes = csv(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_INCLUDE_PATH_PREFIXES);
  const excludePathPrefixes = csv(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_EXCLUDE_PATH_PREFIXES);
  const sourceExtractorKinds = csv(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_SOURCE_EXTRACTOR_KINDS);
  const sourceJobStatuses = csv(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_SOURCE_JOB_STATUSES);
  const backpressureErrorKinds = csv(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BACKPRESSURE_ERROR_KINDS);
  const pauseOnBackpressureErrorKinds = csv(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PAUSE_ON_BACKPRESSURE_ERROR_KINDS);
  const hasProviderBackpressureKinds = backpressureErrorKinds !== undefined || pauseOnBackpressureErrorKinds !== undefined;
  return {
    client: new HttpSourceProcessingSupervisorClient({
      baseUrl: normalizeSourceWorkerBaseUrl(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BASE_URL?.trim() || config.email.baseUrl),
      requestTimeoutMs: requestTimeoutSeconds * 1_000,
      ...(authToken ? { authToken } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    account: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_DROPBOX_ACCOUNT?.trim() || 'personal',
    approvedScopeKeys: csv(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_DROPBOX_SCOPES)
      || dropboxPolicyApprovedScopeKeys(dropboxPolicy)
      || [...DEFAULT_DROPBOX_SCOPES],
    workerId: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_WORKER_ID?.trim() || DEFAULT_WORKER_ID,
    extractorKind: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_EXTRACTOR_KIND?.trim() || DEFAULT_EXTRACTOR_KIND,
    extractorVersion: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_EXTRACTOR_VERSION?.trim() || DEFAULT_EXTRACTOR_VERSION,
    ...(qaVerdicts ? { qaVerdicts } : {}),
    ...(mimeTypes ? { mimeTypes } : {}),
    ...(includePathPrefixes ? { includePathPrefixes } : {}),
    ...(excludePathPrefixes ? { excludePathPrefixes } : {}),
    ...(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_REQUIRED_ARTIFACT_KIND?.trim()
      ? { requiredArtifactKind: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_REQUIRED_ARTIFACT_KIND.trim() }
      : {}),
    ...(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_REQUIRED_ARTIFACT_WARNING?.trim()
      ? { requiredArtifactWarning: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_REQUIRED_ARTIFACT_WARNING.trim() }
      : {}),
    ...(sourceExtractorKinds ? { sourceExtractorKinds } : {}),
    ...(sourceJobStatuses ? { sourceJobStatuses } : {}),
    planBeforeExtract: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PLAN_BEFORE_EXTRACT === undefined
      ? true
      : parseBoolean(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PLAN_BEFORE_EXTRACT, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PLAN_BEFORE_EXTRACT'),
    planLimit: positiveIntOrMax(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PLAN_LIMIT, DEFAULT_PLAN_LIMIT, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PLAN_LIMIT'),
    qaRasterOcrVlmEscalationLimit: positiveIntOrMax(
      env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_QA_RASTER_OCR_VLM_ESCALATION_LIMIT,
      25,
      'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_QA_RASTER_OCR_VLM_ESCALATION_LIMIT',
    ),
    batchSize: positiveIntOrMax(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BATCH_SIZE, DEFAULT_BATCH_SIZE, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BATCH_SIZE'),
    concurrency: positiveInt(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_CONCURRENCY, 1, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_CONCURRENCY'),
    maxCycles: positiveIntOrUnbounded(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_CYCLES, DEFAULT_MAX_CYCLES, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_CYCLES'),
    maxRuntimeSeconds: positiveIntOrUnbounded(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_RUNTIME_SECONDS, DEFAULT_MAX_RUNTIME_SECONDS, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_RUNTIME_SECONDS'),
    requestTimeoutSeconds,
    leaseSeconds: positiveIntOrMax(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_LEASE_SECONDS, DEFAULT_LEASE_SECONDS, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_LEASE_SECONDS'),
    embedAfterExtract: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_EMBED_AFTER_EXTRACT === undefined
      ? false
      : parseBoolean(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_EMBED_AFTER_EXTRACT, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_EMBED_AFTER_EXTRACT'),
    maxConsecutiveNoProgressBatches: positiveIntOrUnbounded(
      env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_CONSECUTIVE_NO_PROGRESS_BATCHES,
      DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_BATCHES,
      'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_MAX_CONSECUTIVE_NO_PROGRESS_BATCHES',
    ),
    stopWhenIdle: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_WHEN_IDLE === undefined
      ? false
      : parseBoolean(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_WHEN_IDLE, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_WHEN_IDLE'),
    stopOnAttention: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_ON_ATTENTION === undefined
      ? false
      : parseBoolean(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_ON_ATTENTION, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_ON_ATTENTION'),
    statusSnapshots: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STATUS_SNAPSHOTS === undefined
      ? true
      : parseBoolean(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STATUS_SNAPSHOTS, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STATUS_SNAPSHOTS'),
    ...(backpressureErrorKinds ? { backpressureErrorKinds } : {}),
    ...(pauseOnBackpressureErrorKinds ? { pauseOnBackpressureErrorKinds } : {}),
    ...(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PROVIDER_PAUSE_FILE?.trim()
      ? { providerPauseFile: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PROVIDER_PAUSE_FILE.trim() }
      : {}),
    backpressurePauseSeconds: nonNegativeInt(
      env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BACKPRESSURE_PAUSE_SECONDS,
      hasProviderBackpressureKinds ? DEFAULT_BACKPRESSURE_PAUSE_SECONDS : 0,
      'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BACKPRESSURE_PAUSE_SECONDS',
    ),
    idlePollSeconds: nonNegativeInt(
      env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_IDLE_POLL_SECONDS,
      DEFAULT_IDLE_POLL_SECONDS,
      'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_IDLE_POLL_SECONDS',
    ),
    adaptiveConcurrency: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ADAPTIVE_CONCURRENCY === undefined
      ? hasProviderBackpressureKinds
      : parseBoolean(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ADAPTIVE_CONCURRENCY, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_ADAPTIVE_CONCURRENCY'),
    stopOnBackpressure: env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_ON_BACKPRESSURE === undefined
      ? false
      : parseBoolean(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_ON_BACKPRESSURE, 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_STOP_ON_BACKPRESSURE'),
    progressHeartbeatSeconds: nonNegativeInt(
      env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PROGRESS_HEARTBEAT_SECONDS,
      DEFAULT_PROGRESS_HEARTBEAT_SECONDS,
      'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_PROGRESS_HEARTBEAT_SECONDS',
    ),
  };
}

export function janitorOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): SourceProcessingJanitorOptions {
  if (env.OLYMPUS_SOURCE_PROCESSING_JANITOR_ENABLED !== 'true') {
    throw new Error('OLYMPUS_SOURCE_PROCESSING_JANITOR_ENABLED=true is required for source processing janitor writes.');
  }
  const config = loadConfig(env);
  const authToken = workerAuthTokenFromConfig(config);
  const dropboxPolicy = loadDropboxIngestionPolicy({
    inlinePolicy: config.sourceIndex.ingestionPolicies.dropboxPersonal?.policy,
    policyPath: config.sourceIndex.ingestionPolicies.dropboxPersonal?.policyPath,
    env,
  });
  const requestTimeoutSeconds = positiveIntOrUnbounded(
    env.OLYMPUS_SOURCE_PROCESSING_JANITOR_REQUEST_TIMEOUT_SECONDS,
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    'OLYMPUS_SOURCE_PROCESSING_JANITOR_REQUEST_TIMEOUT_SECONDS',
  );
  const terminalClasses = terminalClassesFromEnv(env.OLYMPUS_SOURCE_PROCESSING_JANITOR_TERMINAL_CLASSES);
  return {
    client: new HttpSourceProcessingSupervisorClient({
      baseUrl: normalizeSourceWorkerBaseUrl(
        env.OLYMPUS_SOURCE_PROCESSING_JANITOR_BASE_URL?.trim()
          || env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BASE_URL?.trim()
          || config.email.baseUrl,
      ),
      requestTimeoutMs: requestTimeoutSeconds * 1_000,
      ...(authToken ? { authToken } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    account: env.OLYMPUS_SOURCE_PROCESSING_JANITOR_DROPBOX_ACCOUNT?.trim()
      || env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_DROPBOX_ACCOUNT?.trim()
      || 'personal',
    approvedScopeKeys: csv(env.OLYMPUS_SOURCE_PROCESSING_JANITOR_DROPBOX_SCOPES)
      || csv(env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_DROPBOX_SCOPES)
      || dropboxPolicyApprovedScopeKeys(dropboxPolicy)
      || [...DEFAULT_DROPBOX_SCOPES],
    applyTerminalReclassification: env.OLYMPUS_SOURCE_PROCESSING_JANITOR_APPLY === undefined
      ? false
      : parseBoolean(env.OLYMPUS_SOURCE_PROCESSING_JANITOR_APPLY, 'OLYMPUS_SOURCE_PROCESSING_JANITOR_APPLY'),
    terminalClassBudget: positiveInt(
      env.OLYMPUS_SOURCE_PROCESSING_JANITOR_TERMINAL_CLASS_BUDGET,
      DEFAULT_JANITOR_CLASS_BUDGET,
      'OLYMPUS_SOURCE_PROCESSING_JANITOR_TERMINAL_CLASS_BUDGET',
    ),
    escalationBudget: nonNegativeInt(
      env.OLYMPUS_SOURCE_PROCESSING_JANITOR_ESCALATION_BUDGET,
      DEFAULT_JANITOR_ESCALATION_BUDGET,
      'OLYMPUS_SOURCE_PROCESSING_JANITOR_ESCALATION_BUDGET',
    ),
    retryableBudget: positiveInt(
      env.OLYMPUS_SOURCE_PROCESSING_JANITOR_RETRYABLE_BUDGET,
      DEFAULT_JANITOR_RETRYABLE_BUDGET,
      'OLYMPUS_SOURCE_PROCESSING_JANITOR_RETRYABLE_BUDGET',
    ),
    staleLeaseBudget: positiveInt(
      env.OLYMPUS_SOURCE_PROCESSING_JANITOR_STALE_LEASE_BUDGET,
      DEFAULT_JANITOR_STALE_LEASE_BUDGET,
      'OLYMPUS_SOURCE_PROCESSING_JANITOR_STALE_LEASE_BUDGET',
    ),
    staleLeaseExtractorKindPrefixes: csv(env.OLYMPUS_SOURCE_PROCESSING_JANITOR_STALE_LEASE_PREFIXES)
      || ['local_ocr_tesseract', 'local_text', 'venice_'],
    retryableExtractorKindPrefixes: csv(env.OLYMPUS_SOURCE_PROCESSING_JANITOR_RETRYABLE_PREFIXES) || [],
    ...(terminalClasses ? { terminalClasses } : {}),
    allowNetworkTerminalRequeueAfterPriorJanitor: env.OLYMPUS_SOURCE_PROCESSING_JANITOR_ALLOW_NETWORK_PRIOR_GUARD === undefined
      ? false
      : parseBoolean(
          env.OLYMPUS_SOURCE_PROCESSING_JANITOR_ALLOW_NETWORK_PRIOR_GUARD,
          'OLYMPUS_SOURCE_PROCESSING_JANITOR_ALLOW_NETWORK_PRIOR_GUARD',
        ),
    warmVlmLane: env.OLYMPUS_SOURCE_PROCESSING_JANITOR_WARM_VLM === undefined
      ? true
      : parseBoolean(env.OLYMPUS_SOURCE_PROCESSING_JANITOR_WARM_VLM, 'OLYMPUS_SOURCE_PROCESSING_JANITOR_WARM_VLM'),
    vlmBaseUrl: env.OLYMPUS_SOURCE_PROCESSING_JANITOR_VLM_BASE_URL?.trim()
      || env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_BASE_URL?.trim()
      || config.argus.modelProfiles[ESCALATION_VISION_PROFILE_KEY].baseUrl,
    vlmModel: env.OLYMPUS_SOURCE_PROCESSING_JANITOR_VLM_MODEL?.trim()
      || env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_MODEL?.trim()
      || config.argus.modelProfiles[ESCALATION_VISION_PROFILE_KEY].model,
    vlmWarmupTimeoutSeconds: positiveInt(
      env.OLYMPUS_SOURCE_PROCESSING_JANITOR_VLM_WARMUP_TIMEOUT_SECONDS,
      DEFAULT_VLM_WARMUP_TIMEOUT_SECONDS,
      'OLYMPUS_SOURCE_PROCESSING_JANITOR_VLM_WARMUP_TIMEOUT_SECONDS',
    ),
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

function emptyScopeReport(scope: string): SourceProcessingSupervisorScopeReport {
  return {
    scope_key_hash: hashScope(scope),
    status: 'idle',
    cycles_run: 0,
    jobs_leased: 0,
    jobs_planned: 0,
    jobs_existing: 0,
    terminal_progress_jobs: 0,
    failed_retryable_jobs: 0,
    embed_runs: 0,
    embed_failed_runs: 0,
    provider_backpressure_jobs: 0,
    effective_concurrency: 1,
    consecutive_no_progress_batches: 0,
    counts: {
      indexed: 0,
      metadata_only: 0,
      blocked_policy: 0,
      skipped_unsupported: 0,
      skipped_too_large: 0,
      failed_retryable: 0,
      failed_terminal: 0,
    },
    error_kind_counts: {},
    warnings: [],
    errors: [],
  };
}

function scopeFromReport(
  report: SourceProcessingSupervisorScopeReport,
  scopes: readonly string[],
  reports: readonly SourceProcessingSupervisorScopeReport[],
): string {
  const index = reports.indexOf(report);
  return scopes[index]!;
}

async function readScopeSnapshot(
  client: SourceProcessingSupervisorClient,
  account: string,
  approvedScopeKey: string,
  filters: {
    extractorKind?: string;
    extractorVersion?: string;
    qaVerdicts?: readonly string[];
    mimeTypes?: readonly string[];
    includePathPrefixes?: readonly string[];
    excludePathPrefixes?: readonly string[];
    requiredArtifactKind?: string;
    requiredArtifactWarning?: string;
    sourceExtractorKinds?: readonly string[];
    sourceJobStatuses?: readonly string[];
  } = {},
): Promise<ExtractionQueueSnapshot | undefined> {
  try {
    const status = await client.sourceIndexStatus({
      corpus_id: DROPBOX_CORPUS_ID,
      account,
      approved_scope_key: approvedScopeKey,
      ...(filters.extractorKind ? { extractor_kind: filters.extractorKind } : {}),
      ...(filters.extractorVersion ? { extractor_version: filters.extractorVersion } : {}),
      ...(filters.qaVerdicts && filters.qaVerdicts.length > 0 ? { qa_verdicts: [...filters.qaVerdicts] } : {}),
      ...(filters.mimeTypes && filters.mimeTypes.length > 0 ? { mime_types: [...filters.mimeTypes] } : {}),
      ...(filters.includePathPrefixes && filters.includePathPrefixes.length > 0
        ? { include_path_prefixes: [...filters.includePathPrefixes] }
        : {}),
      ...(filters.excludePathPrefixes && filters.excludePathPrefixes.length > 0
        ? { exclude_path_prefixes: [...filters.excludePathPrefixes] }
        : {}),
      ...(filters.requiredArtifactKind ? { required_artifact_kind: filters.requiredArtifactKind } : {}),
      ...(filters.requiredArtifactWarning ? { required_artifact_warning: filters.requiredArtifactWarning } : {}),
      ...(filters.sourceExtractorKinds && filters.sourceExtractorKinds.length > 0
        ? { source_extractor_kinds: [...filters.sourceExtractorKinds] }
        : {}),
      ...(filters.sourceJobStatuses && filters.sourceJobStatuses.length > 0
        ? { source_job_statuses: [...filters.sourceJobStatuses] }
        : {}),
      include_items: false,
    });
    const corpus = status.corpora
      .map(sourceStatusCorpusRecord)
      .find((entry) => entry?.corpus_id === DROPBOX_CORPUS_ID);
    const counts = corpus?.counts ?? {};
    return {
      indexed_items: numberValue(counts.indexed_items ?? counts.files),
      chunks: numberValue(counts.secure_local_chunks ?? counts.chunks),
      embedded_chunks: numberValue(counts.embedded_chunks),
      extraction_queued: numberValue(counts.extraction_jobs_queued),
      extraction_queued_actionable: optionalNumberValue(counts.extraction_jobs_queued_actionable),
      extraction_queued_superseded: optionalNumberValue(counts.extraction_jobs_queued_superseded),
      extraction_queued_policy_excluded: optionalNumberValue(counts.extraction_jobs_queued_policy_excluded),
      extraction_leased: numberValue(counts.extraction_jobs_leased),
      extraction_leased_current: optionalNumberValue(counts.extraction_jobs_leased_current),
      extraction_leased_current_actionable: optionalNumberValue(counts.extraction_jobs_leased_current_actionable),
      extraction_leased_current_superseded: optionalNumberValue(counts.extraction_jobs_leased_current_superseded),
      extraction_leased_current_policy_excluded: optionalNumberValue(counts.extraction_jobs_leased_current_policy_excluded),
      extraction_leased_expired: optionalNumberValue(counts.extraction_jobs_leased_expired),
      extraction_leased_expired_actionable: optionalNumberValue(counts.extraction_jobs_leased_expired_actionable),
      extraction_leased_expired_superseded: optionalNumberValue(counts.extraction_jobs_leased_expired_superseded),
      extraction_leased_expired_policy_excluded: optionalNumberValue(counts.extraction_jobs_leased_expired_policy_excluded),
      extraction_failed: numberValue(counts.extraction_jobs_failed),
      extraction_failed_actionable: optionalNumberValue(counts.extraction_jobs_failed_actionable),
      extraction_failed_superseded: optionalNumberValue(counts.extraction_jobs_failed_superseded),
      extraction_failed_policy_excluded: optionalNumberValue(counts.extraction_jobs_failed_policy_excluded),
      qa_visible_gaps: numberValue(counts.qa_visible_gaps),
      qa_stale_revision: numberValue(counts.qa_stale_revision),
      qa_metadata_only_gap: numberValue(counts.qa_metadata_only_gap),
      qa_partial_pages_gap: numberValue(counts.qa_partial_pages_gap),
      qa_raster_ocr_vlm_escalation: numberValue(counts.qa_raster_ocr_vlm_escalation),
      qa_low_confidence_retry_local: numberValue(counts.qa_low_confidence_retry_local),
      qa_low_confidence_candidate_for_venice: numberValue(counts.qa_low_confidence_candidate_for_venice),
      qa_failed_needs_operator: numberValue(counts.qa_failed_needs_operator),
      qa_pending: numberValue(counts.qa_pending),
    };
  } catch {
    return undefined;
  }
}

function sourceStatusCorpusRecord(value: unknown): { corpus_id: string; counts?: Record<string, number> } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.corpus_id !== 'string') return undefined;
  return {
    corpus_id: record.corpus_id,
    ...(record.counts && typeof record.counts === 'object'
      ? { counts: numberRecord(record.counts as Record<string, unknown>) }
      : {}),
  };
}

function numberRecord(record: Record<string, unknown>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
  }
  return output;
}

function summarizeScopes(reports: readonly SourceProcessingSupervisorScopeReport[]): SourceProcessingSupervisorReport['summary'] {
  return {
    jobs_leased: sum(reports, (scope) => scope.jobs_leased),
    jobs_planned: sum(reports, (scope) => scope.jobs_planned),
    jobs_existing: sum(reports, (scope) => scope.jobs_existing),
    terminal_progress_jobs: sum(reports, (scope) => scope.terminal_progress_jobs),
    failed_retryable_jobs: sum(reports, (scope) => scope.failed_retryable_jobs),
    embed_runs: sum(reports, (scope) => scope.embed_runs),
    embed_failed_runs: sum(reports, (scope) => scope.embed_failed_runs),
    queued_before: sum(reports, (scope) => scope.before?.extraction_queued ?? 0),
    queued_after: sum(reports, (scope) => scope.after?.extraction_queued ?? 0),
    leased_before: sum(reports, (scope) => scope.before?.extraction_leased ?? 0),
    leased_after: sum(reports, (scope) => scope.after?.extraction_leased ?? 0),
    provider_backpressure_jobs: sum(reports, (scope) => scope.provider_backpressure_jobs),
    qa_visible_gaps_after: sum(reports, (scope) => scope.after?.qa_visible_gaps ?? 0),
    qa_stale_revision_after: sum(reports, (scope) => scope.after?.qa_stale_revision ?? 0),
    qa_metadata_only_gap_after: sum(reports, (scope) => scope.after?.qa_metadata_only_gap ?? 0),
    qa_raster_ocr_vlm_escalation_after: sum(reports, (scope) => scope.after?.qa_raster_ocr_vlm_escalation ?? 0),
    qa_low_confidence_retry_local_after: sum(reports, (scope) => scope.after?.qa_low_confidence_retry_local ?? 0),
    qa_low_confidence_candidate_for_venice_after: sum(reports, (scope) => scope.after?.qa_low_confidence_candidate_for_venice ?? 0),
    qa_failed_needs_operator_after: sum(reports, (scope) => scope.after?.qa_failed_needs_operator ?? 0),
    qa_pending_after: sum(reports, (scope) => scope.after?.qa_pending ?? 0),
  };
}

function annotateIdleQaGaps(
  reports: SourceProcessingSupervisorScopeReport[],
  qaVerdicts: readonly string[],
  sourceJobStatuses: readonly string[],
): void {
  if (qaVerdicts.length === 0 && sourceJobStatuses.length === 0) return;
  for (const scope of reports) {
    const after = scope.after;
    if (!after) continue;
    const actionableQueued = after.extraction_queued_actionable ?? after.extraction_queued;
    const actionableLeased = (after.extraction_leased_current_actionable ?? after.extraction_leased_current ?? after.extraction_leased)
      + (after.extraction_leased_expired_actionable ?? after.extraction_leased_expired ?? 0);
    if (actionableQueued > 0 || actionableLeased > 0) continue;
    const targetedGaps = targetedQaGapCount(after, qaVerdicts);
    const targetedFailedJobs = sourceJobStatuses.length > 0
      ? after.extraction_failed_actionable ?? after.extraction_failed
      : 0;
    if (targetedGaps === 0 && targetedFailedJobs === 0) continue;
    if (scope.terminal_progress_jobs > 0 || scope.jobs_leased > 0) continue;
    scope.status = 'attention';
    const nonActionableQueued = (after.extraction_queued_superseded ?? 0) + (after.extraction_queued_policy_excluded ?? 0);
    const nonActionableFailed = (after.extraction_failed_superseded ?? 0) + (after.extraction_failed_policy_excluded ?? 0);
    if (targetedGaps > 0) {
      scope.warnings.push(`QA-targeted supervisor found ${targetedGaps} remaining visible gap(s) but no actionable queued or leased extraction work.`);
    }
    if (targetedFailedJobs > 0) {
      scope.warnings.push(`source-job-status-targeted supervisor found ${targetedFailedJobs} actionable failed extraction job(s) but no actionable queued or leased extraction work.`);
    }
    const nonActionableLeased =
      (after.extraction_leased_current_superseded ?? 0)
      + (after.extraction_leased_current_policy_excluded ?? 0)
      + (after.extraction_leased_expired_superseded ?? 0)
      + (after.extraction_leased_expired_policy_excluded ?? 0);
    if (nonActionableQueued > 0 || nonActionableFailed > 0 || nonActionableLeased > 0) {
      scope.warnings.push(`ignored ${nonActionableQueued + nonActionableFailed + nonActionableLeased} non-actionable extraction job(s): superseded or policy-excluded.`);
    }
  }
}

function targetedQaGapCount(snapshot: ExtractionQueueSnapshot, qaVerdicts: readonly string[]): number {
  if (qaVerdicts.length === 0) return 0;
  let total = 0;
  const seen = new Set<string>();
  for (const verdict of qaVerdicts) {
    if (seen.has(verdict)) continue;
    seen.add(verdict);
    switch (verdict) {
      case 'qa_stale_revision':
        total += snapshot.qa_stale_revision;
        break;
      case 'qa_metadata_only_gap':
        total += snapshot.qa_metadata_only_gap;
        break;
      case 'qa_partial_pages_gap':
        total += snapshot.qa_partial_pages_gap;
        break;
      case 'qa_raster_ocr_vlm_escalation':
        total += snapshot.qa_raster_ocr_vlm_escalation;
        break;
      case 'qa_low_confidence_retry_local':
        total += snapshot.qa_low_confidence_retry_local;
        break;
      case 'qa_low_confidence_candidate_for_venice':
        total += snapshot.qa_low_confidence_candidate_for_venice;
        break;
      case 'qa_failed_needs_operator':
        total += snapshot.qa_failed_needs_operator;
        break;
      default:
        break;
    }
  }
  return total;
}

function actionsFromReport(input: {
  reports: readonly SourceProcessingSupervisorScopeReport[];
  exhaustedTimeBudget: boolean;
  exhaustedCycleBudget: boolean;
  summary: SourceProcessingSupervisorReport['summary'];
  providerPause: SourceProcessingSupervisorProviderPause | undefined;
}): string[] {
  const actions: string[] = [];
  if (input.providerPause) {
    if (input.providerPause.kind === 'venice' && input.providerPause.error_kind === 'venice_http_402') {
      actions.push('venice: escalation paused because the provider reported credit/payment exhaustion; refill credits, clear the provider pause marker, then restart the Venice timers.');
    } else {
      actions.push(`${input.providerPause.kind}: provider work paused after ${input.providerPause.error_kind ?? input.providerPause.reason}; clear the provider pause marker after the provider is healthy.`);
    }
  }
  if (input.exhaustedTimeBudget) actions.push('supervisor: continue in the next cycle; runtime budget was exhausted.');
  if (input.exhaustedCycleBudget) actions.push('supervisor: continue in the next cycle; cycle budget was exhausted.');
  if (input.summary.queued_after > 0) actions.push(`dropbox: ${input.summary.queued_after} extraction job(s) remain queued.`);
  if (input.summary.leased_after > 0) actions.push(`dropbox: ${input.summary.leased_after} extraction job(s) remain leased or waiting for recycle.`);
  if (input.summary.queued_after === 0 && input.summary.leased_after === 0 && input.summary.qa_visible_gaps_after > 0) {
    actions.push(`source-readiness: ${input.summary.qa_visible_gaps_after} QA-visible Dropbox gap(s) remain with no actionable queued or leased extraction work; run a targeted QA replan with an appropriate extractor/version or retire policy-deferred rows through the worker API.`);
  }
  for (const scope of input.reports) {
    if (scope.status === 'parked' && !input.providerPause) {
      if (scope.errors.some((error) => error.includes('no-progress extraction batch'))) {
        actions.push(`dropbox:${scope.scope_key_hash}: parked after repeated no-progress batches; inspect local extractor/provider health.`);
      } else if (scope.errors.length > 0) {
        actions.push(`dropbox:${scope.scope_key_hash}: scope parked after supervisor request failure; later scopes can continue, inspect private worker health for this scope.`);
      } else {
        actions.push(`dropbox:${scope.scope_key_hash}: parked after repeated no-progress batches; inspect local extractor/provider health.`);
      }
    }
    if (scope.status === 'attention' && scope.errors.length > 0) {
      actions.push(`dropbox:${scope.scope_key_hash}: supervisor request failed; inspect private worker health.`);
    } else if (scope.status === 'attention' && scope.warnings.some((warning) => warning.includes('no actionable queued or leased extraction work'))) {
      actions.push(`dropbox:${scope.scope_key_hash}: QA-visible gaps remain but this lane has no actionable extraction work; replan with a matching extractor/version or retire policy-deferred rows through the worker API.`);
    }
    if (scope.embed_failed_runs > 0) {
      actions.push(`dropbox:${scope.scope_key_hash}: ${scope.embed_failed_runs} embedding run(s) failed after extraction progress; continue extraction and retry embeddings through the embedding drain.`);
    }
    if (scope.provider_backpressure_jobs > 0) {
      actions.push(`dropbox:${scope.scope_key_hash}: provider backpressure observed on ${scope.provider_backpressure_jobs} job(s); keep adaptive concurrency/backoff enabled for this extraction lane.`);
    }
  }
  return actions;
}

function terminalProgressJobs(counts: DropboxContentExtractionBatchResult['counts']): number {
  return counts.indexed
    + counts.metadata_only
    + counts.blocked_policy
    + counts.skipped_unsupported
    + counts.skipped_too_large
    + counts.failed_terminal;
}

function summarizeExtractionBatches(
  batches: DropboxContentExtractionBatchResult[],
): Pick<DropboxContentExtractionBatchResult, 'counts' | 'leased_jobs'> & { error_kind_counts: Record<string, number>; warnings: string[] } {
  const counts = emptyExtractionCounts();
  const errorKindCounts: Record<string, number> = {};
  const warnings: string[] = [];
  let leasedJobs = 0;
  for (const batch of batches) {
    mergeCounts(counts, batch.counts);
    if (batch.paused && batch.pause_reason && !warnings.includes(batch.pause_reason)) {
      warnings.push(batch.pause_reason);
    }
    for (const record of batch.records) {
      if (!record.error_kind) continue;
      errorKindCounts[record.error_kind] = (errorKindCounts[record.error_kind] ?? 0) + 1;
    }
    if (batch.preflight_error_kind) {
      errorKindCounts[batch.preflight_error_kind] =
        (errorKindCounts[batch.preflight_error_kind] ?? 0) + 1;
    }
    leasedJobs += batch.leased_jobs;
  }
  return { counts, leased_jobs: leasedJobs, error_kind_counts: errorKindCounts, warnings };
}

function emptyExtractionCounts(): DropboxContentExtractionBatchResult['counts'] {
  return {
    indexed: 0,
    metadata_only: 0,
    blocked_policy: 0,
    skipped_unsupported: 0,
    skipped_too_large: 0,
    failed_retryable: 0,
    failed_terminal: 0,
  };
}

function mergeCounts(
  target: DropboxContentExtractionBatchResult['counts'],
  source: DropboxContentExtractionBatchResult['counts'],
): void {
  for (const key of Object.keys(target) as Array<keyof typeof target>) {
    target[key] += source[key];
  }
}

function mergeErrorKindCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [kind, count] of Object.entries(source)) {
    target[kind] = (target[kind] ?? 0) + count;
  }
}

function countBackpressureJobs(
  errorKindCounts: Record<string, number>,
  backpressureErrorKinds: Set<string>,
): number {
  if (backpressureErrorKinds.size === 0) return 0;
  let total = 0;
  for (const [kind, count] of Object.entries(errorKindCounts)) {
    if (backpressureErrorKinds.has(kind)) total += count;
  }
  return total;
}

function firstMatchingErrorKind(
  errorKindCounts: Record<string, number>,
  errorKinds: Set<string>,
): string | undefined {
  if (errorKinds.size === 0) return undefined;
  return Object.entries(errorKindCounts)
    .filter(([kind]) => errorKinds.has(kind))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .at(0)?.[0];
}

function createProviderPause(errorKind: string, now: Date): SourceProcessingSupervisorProviderPause {
  const kind = errorKind.startsWith('venice_') ? 'venice' : 'provider';
  return {
    active: true,
    kind,
    reason: 'provider_backpressure',
    error_kind: errorKind,
    created_at: now.toISOString(),
    message: kind === 'venice' && errorKind === 'venice_http_402'
      ? 'Venice escalation paused because provider reported credit/payment exhaustion. Refill Venice credits, remove this marker, then restart Venice escalation timers.'
      : `Provider work paused because ${errorKind} backpressure was observed. Clear this marker after the provider is healthy.`,
  };
}

function readProviderPause(path: string | undefined): SourceProcessingSupervisorProviderPause | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.active === false) return undefined;
    const reason = stringOption(record.reason) ?? 'provider_pause';
    const errorKind = stringOption(record.error_kind);
    const kind = stringOption(record.kind) ?? (errorKind?.startsWith('venice_') ? 'venice' : 'provider');
    return {
      active: true,
      kind,
      reason,
      ...(errorKind ? { error_kind: errorKind } : {}),
      ...(stringOption(record.created_at) ? { created_at: stringOption(record.created_at)! } : {}),
      message: stringOption(record.message) ?? `${kind} work is paused by provider pause marker.`,
    };
  } catch {
    return undefined;
  }
}

function writeProviderPause(path: string | undefined, pause: SourceProcessingSupervisorProviderPause): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pause, null, 2)}\n`);
}

function backpressureKindsSummary(
  errorKindCounts: Record<string, number>,
  backpressureErrorKinds: Set<string>,
): string {
  return Object.entries(errorKindCounts)
    .filter(([kind]) => backpressureErrorKinds.has(kind))
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}=${count}`)
    .join(', ') || 'unknown';
}

function normalizeScopes(scopes: readonly string[]): string[] {
  const normalized = normalizeOptionalList(scopes);
  if (normalized.length === 0) {
    throw new Error('At least one Dropbox approved scope key is required.');
  }
  return [...new Set(normalized)];
}

function normalizeOptionalList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function hashScope(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 16);
}

function concurrentWorkerId(workerId: string, index: number, concurrency: number): string {
  return concurrency > 1 ? `${workerId}-${index + 1}` : workerId;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function csv(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value.split(/\|\||,/).map((item) => item.trim()).filter(Boolean);
}

function terminalClassesFromEnv(value: string | undefined): SourceProcessingJanitorTerminalClass[] | undefined {
  const items = csv(value);
  if (!items) return undefined;
  return items.map((item) => {
    const [extractorKind, lastErrorKind, targetExtractorKind, targetExtractorVersion, extra] = item.split(':');
    if (!extractorKind?.trim() || !lastErrorKind?.trim() || extra !== undefined) {
      throw new Error('OLYMPUS_SOURCE_PROCESSING_JANITOR_TERMINAL_CLASSES must use extractor_kind:last_error_kind or extractor_kind:last_error_kind:target_kind:target_version entries.');
    }
    if ((targetExtractorKind?.trim() && !targetExtractorVersion?.trim()) || (!targetExtractorKind?.trim() && targetExtractorVersion?.trim())) {
      throw new Error('OLYMPUS_SOURCE_PROCESSING_JANITOR_TERMINAL_CLASSES target entries require both target_kind and target_version.');
    }
    return {
      extractor_kind: extractorKind.trim(),
      last_error_kind: lastErrorKind.trim(),
      ...(targetExtractorKind?.trim() ? { target_extractor_kind: targetExtractorKind.trim() } : {}),
      ...(targetExtractorVersion?.trim() ? { target_extractor_version: targetExtractorVersion.trim() } : {}),
    };
  });
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInt(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function nonNegativeInt(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function positiveIntOrMax(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  if (isMaxOrUnboundedToken(value)) return Number.MAX_SAFE_INTEGER;
  return positiveInt(value, defaultValue, name);
}

function positiveIntOrUnbounded(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  if (isMaxOrUnboundedToken(value)) return Number.POSITIVE_INFINITY;
  return positiveInt(value, defaultValue, name);
}

function positiveIntOption(value: number | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeIntOption(value: number | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function positiveIntOrUnboundedOption(value: number | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  if (value === Number.POSITIVE_INFINITY) return value;
  return positiveIntOption(value, defaultValue, name);
}

function isMaxOrUnboundedToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'max'
    || normalized === 'unbounded'
    || normalized === 'none'
    || normalized === 'disabled'
    || normalized === 'infinite'
    || normalized === 'infinity';
}

function parseBoolean(value: string, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : 'unknown supervisor error';
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): { reportPath?: string; janitor: boolean; apply: boolean } {
  const options: { reportPath?: string; janitor: boolean; apply: boolean } = { janitor: false, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--report') {
      const value = argv[index + 1];
      if (!value) throw new Error('--report requires a path.');
      options.reportPath = value;
      index += 1;
    } else if (arg === '--janitor') {
      options.janitor = true;
    } else if (arg === '--apply') {
      options.apply = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export function ensureReportPathDir(reportPath: string): void {
  mkdirSync(dirname(reportPath), { recursive: true });
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.reportPath) ensureReportPathDir(args.reportPath);
  const report = args.janitor
    ? await runSourceProcessingJanitor({
        ...janitorOptionsFromEnv(process.env),
        ...(args.apply ? { applyTerminalReclassification: true } : {}),
      })
    : await runSourceProcessingSupervisor({
        ...optionsFromEnv(process.env),
        ...(args.reportPath
          ? { onProgress: (progressReport) => writeFileSync(args.reportPath!, `${JSON.stringify(progressReport, null, 2)}\n`) }
          : {}),
      });
  const json = JSON.stringify(report, null, 2);
  if (args.reportPath) writeFileSync(args.reportPath, `${json}\n`);
  console.log(json);
  if (!args.janitor && process.env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_EXIT_ON_ATTENTION === 'true' && report.status === 'attention') {
    process.exitCode = 1;
  }
}
