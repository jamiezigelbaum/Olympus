import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
// The QA verdict ladder is NOT written here. The probe below is a Python
// program built as a string and run on the remote host, so it cannot import
// anything — but the SQL it runs is assembled here, in TypeScript, so it can
// interpolate the store's own ladder instead of keeping a second copy that
// drifts. Every fragment below is brace-free on purpose: it lands inside a
// Python f-string (see extraction-readiness.ts).
import {
  dropboxLocalVlmPdfIndexedJobsSql,
  dropboxQaVerdictLadderSql,
  minimumUsefulExtractionCharsSql,
} from '../src/workers/dropbox-files/extraction-readiness.ts';
import { dropboxContentScopePathPrefixes } from '../src/workers/dropbox-files/content-scope-policy.ts';

type WorkerHealth = 'healthy' | 'attention' | 'unknown';

interface RawStatusReport {
  generated_at?: unknown;
  status?: unknown;
  corpora?: RawStatusCorpus[];
}

interface RawStatusCorpus {
  corpus_id?: unknown;
  counts?: Record<string, unknown>;
  qa?: Record<string, unknown>;
}

interface RawRemoteProbe {
  sampled_at?: unknown;
  status?: RawStatusReport;
  status_error?: unknown;
  health?: Record<string, unknown>;
  health_error?: unknown;
  source_worker?: Record<string, unknown>;
  source_worker_error?: unknown;
  drain_units?: Record<string, unknown>;
  drain_unit_details?: RawDrainUnitDetail[];
  drain_units_error?: unknown;
  ocr_helpers?: Record<string, unknown>;
  ocr_helpers_error?: unknown;
  provider_pauses?: RawProviderPause[];
  provider_pauses_error?: unknown;
  venice_credit_status?: RawVeniceCreditStatus;
  venice_credit_status_error?: unknown;
  aggregates?: RawAggregateMetrics;
  aggregates_error?: unknown;
}

interface RawDrainUnitDetail {
  unit?: unknown;
  active_state?: unknown;
  sub_state?: unknown;
  error?: unknown;
}

interface RawProviderPause {
  active?: unknown;
  kind?: unknown;
  reason?: unknown;
  error_kind?: unknown;
  created_at?: unknown;
  message?: unknown;
}

interface RawVeniceCreditStatus {
  kind?: unknown;
  generated_at?: unknown;
  status?: unknown;
  can_consume?: unknown;
  consumption_currency?: unknown;
  balances?: Record<string, unknown>;
  diem_epoch_allocation?: unknown;
  error_kind?: unknown;
  error_message?: unknown;
  actions?: unknown;
}

interface RawAggregateMetrics {
  file_types?: RawAggregateCount[];
  job_statuses?: RawAggregateCount[];
  crawl_frontier_statuses?: RawAggregateCount[];
  scope_files?: RawAggregateCount[];
  scope_folders?: RawAggregateCount[];
  extraction_lanes?: RawExtractionLane[];
  embedding_lanes?: RawEmbeddingLane[];
  media_job_groups?: RawMediaJobGroup[];
  planning_files?: Record<string, unknown>;
  active_sync?: RawActiveSyncRun | null;
  venice_progress?: RawVeniceProgress;
  file_samples?: RawFileSample[];
}

interface RawAggregateCount {
  label?: unknown;
  count?: unknown;
}

interface RawExtractionLane {
  label?: unknown;
  files?: unknown;
  extracted?: unknown;
  terminal?: unknown;
  queued?: unknown;
  leased?: unknown;
  retryable?: unknown;
  failed_terminal?: unknown;
}

interface RawEmbeddingLane {
  label?: unknown;
  files?: unknown;
  chunks?: unknown;
  embedded_chunks?: unknown;
}

interface RawMediaJobGroup {
  label?: unknown;
  planned_jobs?: unknown;
  queued_jobs?: unknown;
  leased_jobs?: unknown;
  leased_current_jobs?: unknown;
  leased_expired_jobs?: unknown;
  indexed_jobs?: unknown;
  metadata_only_jobs?: unknown;
  retryable_jobs?: unknown;
  failed_terminal_jobs?: unknown;
  skipped_jobs?: unknown;
  blocked_jobs?: unknown;
  completed_jobs?: unknown;
  active_jobs?: unknown;
}

interface RawVeniceProgress {
  planned_jobs?: unknown;
  queued_jobs?: unknown;
  leased_jobs?: unknown;
  leased_current_jobs?: unknown;
  leased_expired_jobs?: unknown;
  indexed_jobs?: unknown;
  metadata_only_jobs?: unknown;
  retryable_jobs?: unknown;
  failed_terminal_jobs?: unknown;
  blocked_jobs?: unknown;
  skipped_jobs?: unknown;
  completed_jobs?: unknown;
  active_jobs?: unknown;
  recipe_statuses?: RawAggregateCount[];
  error_kind_statuses?: RawAggregateCount[];
}

interface RawActiveSyncRun {
  run_id_hash?: unknown;
  started_at?: unknown;
  status?: unknown;
  items_seen?: unknown;
  items_indexed?: unknown;
  events?: unknown;
  upserted?: unknown;
  tombstoned?: unknown;
  skipped?: unknown;
}

interface RawFileSample {
  group?: unknown;
  name?: unknown;
  status?: unknown;
  path_display?: unknown;
  size_bytes?: unknown;
  superseded_by_local_success?: unknown;
  file_type?: unknown;
  extractor_kind?: unknown;
  extractor_version?: unknown;
  attempts?: unknown;
  updated_at?: unknown;
  workflow?: unknown;
  phase?: unknown;
  detail?: unknown;
  download_policy?: unknown;
  policy_decision?: unknown;
  priority?: unknown;
  max_bytes_per_file?: unknown;
  created_at?: unknown;
  leased_until?: unknown;
  next_retry_at?: unknown;
  last_error_kind?: unknown;
  temp_bytes_cleaned?: unknown;
  lease_state?: unknown;
}

interface AggregateCount {
  label: string;
  count: number;
}

interface ExtractionLane {
  label: string;
  files: number;
  extracted: number;
  terminal: number;
  queued: number;
  leased: number;
  retryable: number;
  failedTerminal: number;
}

interface EmbeddingLane {
  label: string;
  files: number;
  chunks: number;
  embeddedChunks: number;
}

interface MediaJobGroup {
  label: string;
  plannedJobs: number;
  queuedJobs: number;
  leasedJobs: number;
  leasedCurrentJobs: number;
  leasedExpiredJobs: number;
  indexedJobs: number;
  metadataOnlyJobs: number;
  retryableJobs: number;
  failedTerminalJobs: number;
  skippedJobs: number;
  blockedJobs: number;
  completedJobs: number;
  activeJobs: number;
}

interface PlanningFiles {
  plannedFiles: number;
  indexedFiles: number;
  queuedFiles: number;
  leasedFiles: number;
  retryableFiles: number;
  failedTerminalFiles: number;
}

interface ActiveSyncRun {
  runIdHash: string | null;
  startedAt: string | null;
  status: string;
  itemsSeen: number;
  itemsIndexed: number;
  events: number;
  upserted: number;
  tombstoned: number;
  skipped: number;
}

interface VeniceProgress {
  plannedJobs: number;
  queuedJobs: number;
  leasedJobs: number;
  leasedCurrentJobs: number;
  leasedExpiredJobs: number;
  indexedJobs: number;
  metadataOnlyJobs: number;
  retryableJobs: number;
  failedTerminalJobs: number;
  blockedJobs: number;
  skippedJobs: number;
  completedJobs: number;
  activeJobs: number;
  recipeStatuses: AggregateCount[];
  errorKindStatuses: AggregateCount[];
}

interface FileSample {
  group: string;
  name: string;
  status: string;
  pathDisplay: string;
  sizeBytes: number | null;
  fileType: string;
  extractorKind: string;
  extractorVersion: string;
  attempts: number;
  updatedAt: string | null;
  workflow: string;
  phase: string;
  detail: string;
  downloadPolicy: string;
  policyDecision: string;
  priority: number;
  maxBytesPerFile: number | null;
  createdAt: string | null;
  leasedUntil: string | null;
  nextRetryAt: string | null;
  lastErrorKind: string | null;
  tempBytesCleaned: boolean | null;
  supersededByLocalSuccess: boolean;
  leaseState: string | null;
}

interface ProviderPause {
  active: boolean;
  kind: string;
  reason: string;
  errorKind: string | null;
  createdAt: string | null;
  message: string | null;
}

interface DrainUnitService {
  unit: string;
  label: string;
  activeState: string;
  subState: string;
  health: WorkerHealth;
}

interface VeniceCreditStatus {
  generatedAt: string | null;
  status: string;
  canConsume: boolean | null;
  consumptionCurrency: string | null;
  balances: Record<string, number>;
  diemEpochAllocation: number | null;
  errorKind: string | null;
  errorMessage: string | null;
  actions: string[];
}

interface LiveAggregateMetrics {
  fileTypes: AggregateCount[];
  jobStatuses: AggregateCount[];
  crawlFrontierStatuses: AggregateCount[];
  scopeFiles: AggregateCount[];
  scopeFolders: AggregateCount[];
  extractionLanes: ExtractionLane[];
  embeddingLanes: EmbeddingLane[];
  mediaJobGroups: MediaJobGroup[];
  planningFiles: PlanningFiles;
  activeSync: ActiveSyncRun | null;
  veniceProgress: VeniceProgress;
  fileSamples: FileSample[];
}

export interface LiveIngestionSnapshot {
  sampledAt: string;
  statusGeneratedAt: string | null;
  corpusId: string;
  counts: {
    files: number;
    folders: number;
    tombstones: number;
    chunks: number;
    embeddedChunks: number;
    artifacts: number;
	    extractionJobs: number;
	    queued: number;
	    queuedActionable: number;
	    queuedSuperseded: number;
	    queuedPolicyExcluded: number;
	    leased: number;
	    leasedCurrent: number;
	    leasedCurrentActionable: number;
	    leasedCurrentSuperseded: number;
	    leasedCurrentPolicyExcluded: number;
	    leasedExpired: number;
	    leasedExpiredActionable: number;
	    leasedExpiredSuperseded: number;
	    leasedExpiredPolicyExcluded: number;
	    blocked: number;
    skipped: number;
    failed: number;
    failedActionable: number;
    failedSuperseded: number;
    failedPolicyExcluded: number;
    metadataFoldersTotal: number;
    metadataFoldersVisited: number;
    metadataFoldersPending: number;
    metadataFoldersRetryableFailed: number;
    metadataFoldersExhaustedRetry: number;
    metadataFoldersBlocked: number;
    metadataFoldersFailed: number;
    syncRuns: number;
    retrievalAudits: number;
    semanticRuns: number;
  };
  qa: {
    totalItems: number;
    pass: number;
    staleRevision: number;
    partialPagesGap: number;
    metadataOnlyExpected: number;
    metadataOnlyGap: number;
    metadataOnlyGapLikelyNeedsExtraction: number;
    metadataOnlyGapLikelyDeferred: number;
    metadataOnlyGapUnknownOrNeedsPolicy: number;
    rasterOcrVlmEscalation: number;
    lowConfidenceRetryLocal: number;
    lowConfidenceCandidateForVenice: number;
    blockedPolicy: number;
    /**
     * Files outside the content lanes' folders. Normally 0 here — this probe
     * already row-filters to the active roots — but carried so a probe pointed
     * at a wider scope reports them instead of dropping them.
     */
    outOfContentScope: number;
    failedNeedsOperator: number;
    pending: number;
    visibleGaps: number;
    lowConfidence: number;
    /** The ladder's own denominator: scored items minus the three policy verdicts. */
    eligibleItems: number;
  };
  health: {
    ok: boolean;
    status: string | null;
    error: string | null;
  };
  sourceWorker: {
    activeState: string | null;
    subState: string | null;
    mainPid: string | null;
    restarts: number | null;
    memoryCurrentBytes: number | null;
    memoryPeakBytes: number | null;
    tasksCurrent: number | null;
    health: WorkerHealth;
  };
  ocrHelpers: {
    active: number;
    byName: Record<string, number>;
    error: string | null;
  };
  drainWorkers: {
    total: number;
    active: number;
    failed: number;
    inactive: number;
    other: number;
    states: Record<string, number>;
    services: DrainUnitService[];
    error: string | null;
  };
  providerPauses: ProviderPause[];
  providerPausesError: string | null;
  veniceCreditStatus: VeniceCreditStatus | null;
  veniceCreditStatusError: string | null;
  aggregates: LiveAggregateMetrics | null;
  aggregateError: string | null;
}

export interface LiveRecentProgress {
  windowLabel: string;
  minutesCovered: number;
  baselineSampledAt: string | null;
  deltas: {
    queueRemaining: number;
    queued: number;
    leased: number;
    artifacts: number;
    qaPass: number;
    qaPending: number;
    visibleGaps: number;
    embeddedChunks: number;
    escalationCandidates: number;
    veniceJobsPlanned: number;
    veniceJobsCompleted: number;
  };
  ratesPerHour: {
    queueDrain: number | null;
    artifactGain: number | null;
    qaPassGain: number | null;
    embeddingGain: number | null;
  };
  eta: {
    queueRemainingHours: number | null;
    answerReadyHours: number | null;
  };
}

export interface LiveDashboardState {
  generatedAt: string;
  latest: LiveIngestionSnapshot | null;
  progress: LiveRecentProgress | null;
  history: LiveIngestionSnapshot[];
  error: string | null;
  polling: {
    intervalSeconds: number;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    skippedPolls: number;
  };
}

interface LiveDashboardServerOptions {
  host: string;
  port: number;
  sshTarget: string;
  corpusId: string;
  activeScopeKeys: string[];
  pollSeconds: number;
  historyPath: string;
  remoteDbPath: string | null;
  commandTimeoutMs: number;
}

const DEFAULT_CORPUS_ID = 'secure_local.dropbox.files';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_POLL_SECONDS = 20;
const DEFAULT_HISTORY_PATH = '/tmp/olympus-source-ingestion-live-history.json';
const DEFAULT_REMOTE_DB_PATH: null = null;
const DEFAULT_ACTIVE_SCOPE_KEYS = [
  'dropbox.personal:/1 Projects',
  'dropbox.personal:/2 Areas',
  'dropbox.personal:/3 Resources',
];
const RECENT_WINDOW_MS = 60 * 60 * 1000;
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

export function normalizeRemoteProbe(raw: RawRemoteProbe, corpusId = DEFAULT_CORPUS_ID): LiveIngestionSnapshot {
  const status = raw.status;
  const corpus = status?.corpora?.find((candidate) => candidate.corpus_id === corpusId);
  if (!corpus) {
    const detail = stringValue(raw.status_error) ?? 'status report did not include the Dropbox corpus';
    throw new Error(detail);
  }

  const counts = corpus.counts ?? {};
  const qa = corpus.qa ?? counts;
  const sourceWorker = raw.source_worker ?? {};
  const drainServices = normalizeDrainUnitServices(raw.drain_unit_details);
  const states = normalizeContinuousDrainUnitStates(raw);
  const activeDrainWorkers = states['active/running'] ?? 0;
  const failedDrainWorkers = sumFailedDrainStates(states);
  const inactiveDrainWorkers = states['inactive/dead'] ?? 0;
  const totalDrainWorkers = Object.values(states).reduce((sum, value) => sum + value, 0);
  const otherDrainWorkers = Math.max(0, totalDrainWorkers - activeDrainWorkers - failedDrainWorkers - inactiveDrainWorkers);
  const activeState = stringRecordValue(sourceWorker, 'ActiveState');
  const subState = stringRecordValue(sourceWorker, 'SubState');
  const sourceWorkerHealthy = activeState === 'active' && subState === 'running';
  const healthStatus = stringRecordValue(raw.health ?? {}, 'status') ?? stringRecordValue(raw.health ?? {}, 'state');
  const healthOk = raw.health?.ok === true
    || raw.health?.healthy === true
    || raw.health?.reachable === true
    || healthStatus === 'ok';
  const hasUsableAggregates = raw.aggregates !== undefined && raw.aggregates !== null;
  const hasLeaseSplit = [
    'extraction_jobs_leased_current',
    'extraction_jobs_leased_expired',
    'extraction_leased_current',
    'extraction_leased_expired',
  ].some((key) => key in counts);
  const rawLeasedJobs = firstNumber(counts, ['extraction_jobs_leased', 'extraction_leased']);
  const rawLeasedCurrent = firstNumber(counts, ['extraction_jobs_leased_current', 'extraction_leased_current']);
  const rawLeasedExpired = firstNumber(counts, ['extraction_jobs_leased_expired', 'extraction_leased_expired']);
  const hasActionableLeaseSplit = 'extraction_jobs_leased_current_actionable' in counts
    || 'extraction_jobs_leased_expired_actionable' in counts
    || 'extraction_jobs_leased_current_superseded' in counts
    || 'extraction_jobs_leased_expired_superseded' in counts;
  const rawQueuedJobs = firstNumber(counts, ['extraction_jobs_queued', 'extraction_queued']);
  const rawFailedJobs = firstNumber(counts, ['extraction_jobs_failed', 'extraction_failed']);
  const hasActionableQueueSplit = 'extraction_jobs_queued_actionable' in counts || 'extraction_jobs_queued_superseded' in counts;
  const hasActionableFailureSplit = 'extraction_jobs_failed_actionable' in counts || 'extraction_jobs_failed_superseded' in counts;
  const leasedJobs = rawLeasedJobs || rawLeasedCurrent + rawLeasedExpired;
  const leasedCurrent = hasLeaseSplit
    ? rawLeasedCurrent
    : leasedJobs;
  const leasedExpired = hasLeaseSplit
    ? rawLeasedExpired
    : 0;

  return {
    sampledAt: stringValue(raw.sampled_at) ?? new Date().toISOString(),
    statusGeneratedAt: stringValue(status?.generated_at),
    corpusId,
    counts: {
      files: firstNumber(counts, ['files', 'indexed_items']),
      folders: firstNumber(counts, ['folders']),
      tombstones: firstNumber(counts, ['tombstones']),
      chunks: firstNumber(counts, ['secure_local_chunks', 'chunks']),
      embeddedChunks: firstNumber(counts, ['embedded_chunks']),
	      artifacts: firstNumber(counts, ['extraction_artifacts']),
	      extractionJobs: firstNumber(counts, ['extraction_jobs']),
	      queued: rawQueuedJobs,
	      queuedActionable: hasActionableQueueSplit ? firstNumber(counts, ['extraction_jobs_queued_actionable']) : rawQueuedJobs,
	      queuedSuperseded: firstNumber(counts, ['extraction_jobs_queued_superseded']),
	      queuedPolicyExcluded: firstNumber(counts, ['extraction_jobs_queued_policy_excluded']),
	      leased: leasedJobs,
	      leasedCurrent,
	      leasedCurrentActionable: hasActionableLeaseSplit ? firstNumber(counts, ['extraction_jobs_leased_current_actionable']) : leasedCurrent,
	      leasedCurrentSuperseded: firstNumber(counts, ['extraction_jobs_leased_current_superseded']),
	      leasedCurrentPolicyExcluded: firstNumber(counts, ['extraction_jobs_leased_current_policy_excluded']),
	      leasedExpired,
	      leasedExpiredActionable: hasActionableLeaseSplit ? firstNumber(counts, ['extraction_jobs_leased_expired_actionable']) : leasedExpired,
	      leasedExpiredSuperseded: firstNumber(counts, ['extraction_jobs_leased_expired_superseded']),
	      leasedExpiredPolicyExcluded: firstNumber(counts, ['extraction_jobs_leased_expired_policy_excluded']),
	      blocked: firstNumber(counts, ['extraction_jobs_blocked']),
      skipped: firstNumber(counts, ['extraction_jobs_skipped']),
      failed: rawFailedJobs,
      failedActionable: hasActionableFailureSplit ? firstNumber(counts, ['extraction_jobs_failed_actionable']) : rawFailedJobs,
      failedSuperseded: firstNumber(counts, ['extraction_jobs_failed_superseded']),
      failedPolicyExcluded: firstNumber(counts, ['extraction_jobs_failed_policy_excluded']),
      metadataFoldersTotal: firstNumber(counts, ['metadata_sync_folders_total']),
      metadataFoldersVisited: firstNumber(counts, ['metadata_sync_folders_visited']),
      metadataFoldersPending: firstNumber(counts, ['metadata_sync_folders_pending']),
      metadataFoldersRetryableFailed: firstNumber(counts, ['metadata_sync_folders_retryable_failed']),
      metadataFoldersExhaustedRetry: firstNumber(counts, ['metadata_sync_folders_exhausted_retry']),
      metadataFoldersBlocked: firstNumber(counts, ['metadata_sync_folders_blocked']),
      metadataFoldersFailed: firstNumber(counts, ['metadata_sync_folders_failed']),
      syncRuns: firstNumber(counts, ['sync_runs']),
      retrievalAudits: firstNumber(counts, ['retrieval_audits']),
      semanticRuns: firstNumber(counts, ['semantic_runs']),
    },
    qa: {
      totalItems: firstNumber(qa, ['total_items', 'qa_total_items']),
      pass: firstNumber(qa, ['pass', 'qa_pass']),
      staleRevision: firstNumber(qa, ['stale_revision', 'qa_stale_revision']),
      partialPagesGap: firstNumber(qa, ['partial_pages_gap', 'qa_partial_pages_gap']),
      metadataOnlyExpected: firstNumber(qa, ['metadata_only_expected', 'qa_metadata_only_expected']),
      metadataOnlyGap: firstNumber(qa, ['metadata_only_gap', 'qa_metadata_only_gap']),
      metadataOnlyGapLikelyNeedsExtraction: firstNumber(qa, ['metadata_only_gap_likely_needs_extraction', 'qa_metadata_only_gap_likely_needs_extraction']),
      metadataOnlyGapLikelyDeferred: firstNumber(qa, ['metadata_only_gap_likely_deferred_metadata_only', 'qa_metadata_only_gap_likely_deferred_metadata_only']),
      metadataOnlyGapUnknownOrNeedsPolicy: firstNumber(qa, ['metadata_only_gap_unknown_or_needs_policy', 'qa_metadata_only_gap_unknown_or_needs_policy']),
      rasterOcrVlmEscalation: firstNumber(qa, ['raster_ocr_vlm_escalation', 'qa_raster_ocr_vlm_escalation']),
      lowConfidenceRetryLocal: firstNumber(qa, ['low_confidence_retry_local', 'qa_low_confidence_retry_local']),
      lowConfidenceCandidateForVenice: firstNumber(qa, ['low_confidence_candidate_for_venice', 'qa_low_confidence_candidate_for_venice']),
      blockedPolicy: firstNumber(qa, ['blocked_policy', 'qa_blocked_policy']),
      outOfContentScope: firstNumber(qa, ['out_of_content_scope', 'qa_out_of_content_scope']),
      failedNeedsOperator: firstNumber(qa, ['failed_needs_operator', 'qa_failed_needs_operator']),
      pending: firstNumber(qa, ['pending', 'qa_pending']),
      visibleGaps: firstNumber(qa, ['visible_gaps', 'qa_visible_gaps']),
      lowConfidence: firstNumber(qa, ['low_confidence', 'qa_low_confidence']),
      eligibleItems: firstNumber(qa, ['eligible_items', 'qa_eligible_items']),
    },
    health: {
      ok: healthOk,
      status: healthStatus,
      error: stringValue(raw.health_error),
    },
    sourceWorker: {
      activeState,
      subState,
      mainPid: stringRecordValue(sourceWorker, 'MainPID'),
      restarts: numberFromUnknown(sourceWorker.NRestarts),
      memoryCurrentBytes: saneBytes(sourceWorker.MemoryCurrent),
      memoryPeakBytes: saneBytes(sourceWorker.MemoryPeak),
      tasksCurrent: numberFromUnknown(sourceWorker.TasksCurrent),
      health: sourceWorkerHealthy && (healthOk || !raw.health_error) ? 'healthy' : activeState || raw.health_error ? 'attention' : 'unknown',
    },
    ocrHelpers: normalizeOcrHelpers(raw.ocr_helpers, raw.ocr_helpers_error),
    drainWorkers: {
      total: totalDrainWorkers,
      active: activeDrainWorkers,
      failed: failedDrainWorkers,
      inactive: inactiveDrainWorkers,
      other: otherDrainWorkers,
      states,
      services: drainServices,
      error: stringValue(raw.drain_units_error),
    },
    providerPauses: normalizeProviderPauses(raw.provider_pauses),
    providerPausesError: stringValue(raw.provider_pauses_error),
    veniceCreditStatus: normalizeVeniceCreditStatus(raw.venice_credit_status),
    veniceCreditStatusError: stringValue(raw.venice_credit_status_error),
    aggregates: normalizeAggregates(raw.aggregates),
    aggregateError: hasUsableAggregates ? null : stringValue(raw.aggregates_error),
  };
}

export function computeRecentProgress(
  history: LiveIngestionSnapshot[],
  now = new Date(),
  windowMs = RECENT_WINDOW_MS,
): LiveRecentProgress | null {
  const ordered = sortSnapshots(history);
  const latest = ordered.at(-1);
  if (!latest) return null;

  const nowMs = now.getTime();
  const windowStart = nowMs - windowMs;
  const inWindow = ordered.filter((sample) => sampleTime(sample) >= windowStart);
  const baseline = inWindow[0] ?? ordered[0] ?? latest;
  const latestMs = sampleTime(latest);
  const baselineMs = sampleTime(baseline);
  const minutesCovered = Math.max(0, (latestMs - baselineMs) / 60000);
  const labelMinutes = Math.min(60, Math.round(minutesCovered));
  const windowLabel = labelMinutes >= 58 ? 'last 60 minutes' : labelMinutes > 0 ? `last ${labelMinutes} minutes available` : 'collecting first live baseline';
  const queueRemainingDelta = actionableQueueRemaining(latest) - actionableQueueRemaining(baseline);
  const qaRemaining = Math.max(0, latest.qa.totalItems - latest.qa.pass);

  return {
    windowLabel,
    minutesCovered,
    baselineSampledAt: baseline.sampledAt,
    deltas: {
      queueRemaining: queueRemainingDelta,
      queued: latest.counts.queued - baseline.counts.queued,
      leased: latest.counts.leased - baseline.counts.leased,
      artifacts: latest.counts.artifacts - baseline.counts.artifacts,
      qaPass: latest.qa.pass - baseline.qa.pass,
      qaPending: latest.qa.pending - baseline.qa.pending,
      visibleGaps: latest.qa.visibleGaps - baseline.qa.visibleGaps,
      embeddedChunks: latest.counts.embeddedChunks - baseline.counts.embeddedChunks,
      escalationCandidates: latest.qa.lowConfidenceCandidateForVenice - baseline.qa.lowConfidenceCandidateForVenice,
      veniceJobsPlanned: veniceProgress(latest).plannedJobs - veniceProgress(baseline).plannedJobs,
      veniceJobsCompleted: veniceProgress(latest).completedJobs - veniceProgress(baseline).completedJobs,
    },
    ratesPerHour: {
      queueDrain: ratePerHour(-queueRemainingDelta, minutesCovered),
      artifactGain: ratePerHour(nonNegativeDelta(latest.counts.artifacts, baseline.counts.artifacts), minutesCovered),
      qaPassGain: ratePerHour(latest.qa.pass - baseline.qa.pass, minutesCovered),
      embeddingGain: ratePerHour(nonNegativeDelta(latest.counts.embeddedChunks, baseline.counts.embeddedChunks), minutesCovered),
    },
    eta: {
      queueRemainingHours: etaHours(actionableQueueRemaining(latest), ratePerHour(-queueRemainingDelta, minutesCovered)),
      answerReadyHours: etaHours(qaRemaining, ratePerHour(latest.qa.pass - baseline.qa.pass, minutesCovered)),
    },
  };
}

export function buildLiveDashboardState(
  history: LiveIngestionSnapshot[],
  options: {
    intervalSeconds: number;
    error?: string | null;
    lastStartedAt?: string | null;
    lastCompletedAt?: string | null;
    skippedPolls?: number;
    now?: Date;
  },
): LiveDashboardState {
  const now = options.now ?? new Date();
  const ordered = sortSnapshots(history);
  const latest = ordered.at(-1) ?? null;
  const recent = ordered.filter((sample) => now.getTime() - sampleTime(sample) <= RECENT_WINDOW_MS);

  return {
    generatedAt: now.toISOString(),
    latest,
    progress: computeRecentProgress(ordered, now),
    history: recent.map(slimHistorySnapshot),
    error: options.error ?? null,
    polling: {
      intervalSeconds: options.intervalSeconds,
      lastStartedAt: options.lastStartedAt ?? null,
      lastCompletedAt: options.lastCompletedAt ?? null,
      skippedPolls: options.skippedPolls ?? 0,
    },
  };
}

function slimHistorySnapshot(snapshot: LiveIngestionSnapshot): LiveIngestionSnapshot {
  if (!snapshot.aggregates || snapshot.aggregates.fileSamples.length === 0) return snapshot;
  return {
    ...snapshot,
    aggregates: {
      ...snapshot.aggregates,
      fileSamples: [],
    },
  };
}

export function renderLiveDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Olympus Live Source Ingestion</title>
  <style>
    :root {
      --bg: #f6f7f2;
      --ink: #1e2421;
      --subtle: #5c655f;
      --line: #d7ddd2;
      --panel: #ffffff;
      --green: #2f7d5c;
      --teal: #157d85;
      --blue: #386da4;
      --amber: #b57217;
      --red: #b33f3a;
      --violet: #6655a8;
      --gray: #79817b;
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; background: var(--bg); color: var(--ink); }
    main { width: min(1500px, calc(100% - 32px)); margin: 0 auto; padding: 18px 0 42px; }
    .topbar { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
    h1 { margin: 0; font-size: 29px; line-height: 1.1; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 18px; line-height: 1.2; }
    h3 { margin: 0; font-size: 15px; line-height: 1.2; }
    .subtitle { margin: 8px 0 0; color: var(--subtle); font-size: 14px; line-height: 1.45; max-width: 900px; }
    .pill { display: inline-flex; min-height: 32px; align-items: center; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); padding: 0 12px; font-size: 13px; font-weight: 740; white-space: nowrap; }
    .pill.good { color: var(--green); border-color: #bddbc9; background: #f0faf3; }
    .pill.warn { color: var(--amber); border-color: #ebcf9b; background: #fff8eb; }
    .pill.danger { color: var(--red); border-color: #efc0bb; background: #fff4f2; }
    .grid { display: grid; gap: 14px; }
    .summary-grid { grid-template-columns: repeat(4, minmax(180px, 1fr)); margin-top: 14px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-height: 96px; }
    .card .label { color: var(--subtle); font-size: 12px; line-height: 1.25; font-weight: 680; text-transform: uppercase; }
    .card .value { margin-top: 9px; font-size: 28px; line-height: 1; font-weight: 780; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .card .hint { margin-top: 9px; color: var(--subtle); font-size: 12px; line-height: 1.35; }
    .overall { display: grid; gap: 12px; }
    .overall-head { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
    .overall-title { margin: 0; font-size: 18px; line-height: 1.2; }
    .overall-value { font-size: 18px; line-height: 1.2; font-weight: 780; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
    .section.compact { margin-top: 14px; padding-top: 0; border-top: 0; }
    .product-picture { grid-template-columns: minmax(0, 1fr) minmax(380px, .72fr); align-items: start; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .pipeline-map { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
    .pipeline-step { min-height: 54px; border: 1px solid var(--line); border-radius: 7px; background: #fafbf8; padding: 9px; }
    .pipeline-step strong { display: block; font-size: 12px; line-height: 1.2; }
    .pipeline-step span { display: block; color: var(--subtle); font-size: 11px; line-height: 1.25; margin-top: 4px; }
    .focus-list { display: grid; gap: 8px; margin-top: 12px; }
    .focus-row { display: grid; grid-template-columns: 78px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; border-bottom: 1px solid #edf0e9; padding: 8px 0; font-size: 13px; }
    .focus-row:last-child { border-bottom: 0; }
    .focus-label { font-weight: 760; }
    .focus-detail { color: var(--subtle); overflow-wrap: anywhere; }
    .focus-value { color: var(--subtle); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .bottleneck-grid { grid-template-columns: 1.05fr .95fr; align-items: start; }
    .diagnosis { display: grid; gap: 12px; }
    .diagnosis-main { border-left: 4px solid var(--amber); background: #fffbf2; border-radius: 7px; padding: 12px; }
    .diagnosis-main.good { border-left-color: var(--green); background: #f3fbf5; }
    .diagnosis-main.danger { border-left-color: var(--red); background: #fff4f2; }
    .diagnosis-main.review { border-left-color: var(--violet); background: #f6f3fd; }
    .diagnosis-label { color: var(--subtle); font-size: 12px; font-weight: 760; text-transform: uppercase; }
    .diagnosis-title { margin-top: 5px; font-size: 20px; line-height: 1.2; font-weight: 790; }
    .diagnosis-copy { margin-top: 7px; color: var(--subtle); font-size: 13px; line-height: 1.4; }
    .diagnosis-actions { display: grid; gap: 8px; }
    .action-row { border: 1px solid var(--line); border-radius: 7px; background: #fbfcfa; padding: 10px; font-size: 13px; line-height: 1.35; }
    .service-list { display: grid; gap: 7px; }
    .service-row { display: grid; grid-template-columns: minmax(160px, 1fr) auto; gap: 10px; align-items: baseline; border-bottom: 1px solid #edf0e9; padding: 7px 0; font-size: 12px; }
    .service-row:last-child { border-bottom: 0; }
    .service-name { font-weight: 720; overflow-wrap: anywhere; }
    .service-state { color: var(--subtle); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .spark-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
    .spark-card { border: 1px solid var(--line); border-radius: 7px; background: #fafbf8; padding: 10px; min-height: 112px; }
    .spark-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
    .spark-label { font-size: 12px; font-weight: 760; }
    .spark-value { color: var(--subtle); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
    .spark-svg { width: 100%; height: 42px; display: block; margin-top: 8px; overflow: visible; }
    .spark-line { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .recent-grid { grid-template-columns: repeat(4, minmax(130px, 1fr)); }
    .spark-grid + .recent-grid { margin-top: 12px; }
    .phase-grid { grid-template-columns: repeat(2, minmax(370px, 1fr)); align-items: start; }
    .phase { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 15px; display: grid; gap: 12px; align-content: start; min-height: 260px; }
    .phase-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .phase-note { color: var(--subtle); font-size: 12px; line-height: 1.35; }
    .progress { display: grid; gap: 7px; }
    .progress-row { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
    .progress-label { font-weight: 720; font-size: 13px; }
    .progress-value { color: var(--subtle); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
    .track { height: 15px; border-radius: 7px; border: 1px solid #dfe5da; background: #e9eee6; overflow: hidden; }
    .track.large { height: 20px; }
    .track.unknown { background: repeating-linear-gradient(135deg, #eef1eb 0, #eef1eb 10px, #e3e8df 10px, #e3e8df 20px); }
    .fill { height: 100%; min-width: 1px; background: var(--teal); }
    .fill.good { background: var(--green); }
    .fill.warn { background: var(--amber); }
    .fill.danger { background: var(--red); }
    .fill.review { background: var(--violet); }
    .fill.info { background: var(--blue); }
    .viz { display: grid; gap: 10px; }
    .viz-row { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 14px; align-items: center; }
    .donut { width: 124px; aspect-ratio: 1; border-radius: 50%; display: grid; place-items: center; box-shadow: inset 0 0 0 1px #dfe5da; }
    .donut-hole { width: 72px; aspect-ratio: 1; border-radius: 50%; background: var(--panel); display: grid; place-items: center; text-align: center; padding: 8px; box-shadow: 0 0 0 1px #e8ede4; }
    .donut-value { font-weight: 780; font-size: 18px; line-height: 1; font-variant-numeric: tabular-nums; }
    .donut-caption { margin-top: 3px; color: var(--subtle); font-size: 10px; line-height: 1.1; }
    .legend { display: grid; gap: 7px; font-size: 12px; }
    .legend-row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 8px; align-items: baseline; }
    .swatch { width: 10px; height: 10px; border-radius: 3px; margin-top: 2px; }
    .legend-label { overflow-wrap: anywhere; }
    .legend-value { color: var(--subtle); font-variant-numeric: tabular-nums; text-align: right; }
    .lanes { display: grid; gap: 8px; }
    .lane { display: grid; gap: 5px; font-size: 12px; }
    .lane-row { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
    .lane-name { font-weight: 650; overflow-wrap: anywhere; }
    .lane-detail { color: var(--subtle); font-variant-numeric: tabular-nums; text-align: right; }
    .worker-grid { grid-template-columns: repeat(4, minmax(120px, 1fr)); }
    .mini { border-left: 4px solid var(--line); background: #fafbf8; border-radius: 7px; padding: 10px; min-height: 70px; }
    .mini.good { border-left-color: var(--green); }
    .mini.warn { border-left-color: var(--amber); }
    .mini.danger { border-left-color: var(--red); }
    .mini.info { border-left-color: var(--blue); }
    .mini.review { border-left-color: var(--violet); }
    .mini strong { display: block; font-size: 20px; line-height: 1; font-variant-numeric: tabular-nums; }
    .mini span { display: block; margin-top: 7px; color: var(--subtle); font-size: 12px; line-height: 1.3; }
    .two-col { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
    .bar-list { display: grid; gap: 9px; }
    .bar-row { display: grid; grid-template-columns: minmax(130px, 210px) minmax(120px, 1fr) 92px; gap: 10px; align-items: center; font-size: 13px; }
    .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { height: 13px; border-radius: 6px; border: 1px solid #dfe5da; background: #e9eee6; overflow: hidden; }
    .bar-fill { height: 100%; min-width: 1px; background: var(--blue); }
    .bar-value { color: var(--subtle); text-align: right; font-variant-numeric: tabular-nums; }
    .timeline { display: grid; gap: 7px; }
    .timeline-row { display: grid; grid-template-columns: 142px repeat(5, minmax(70px, 1fr)); gap: 8px; border-bottom: 1px solid #edf0e9; padding: 7px 0; font-size: 12px; align-items: baseline; }
    .timeline-row strong { font-weight: 720; }
    .live-work { display: grid; gap: 12px; }
    .live-work-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .queue-tabs { display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }
    .queue-chip { display: inline-flex; align-items: center; min-height: 28px; border: 1px solid var(--line); border-radius: 7px; padding: 0 9px; background: #fafbf8; color: var(--subtle); font-size: 12px; font-weight: 720; white-space: nowrap; }
    .queue-chip strong { color: var(--ink); margin-right: 4px; font-variant-numeric: tabular-nums; }
    .queue-chip.quiet { opacity: .62; }
    .queue-grid { display: grid; grid-template-columns: 1fr; gap: 12px; align-items: start; }
    .queue-panel { border: 1px solid var(--line); border-radius: 8px; background: #fbfcfa; padding: 12px; display: grid; gap: 10px; }
    .reference-queues { border: 1px solid var(--line); border-radius: 8px; background: #fbfcfa; padding: 10px 12px; }
    .reference-queues summary { cursor: pointer; color: var(--subtle); font-size: 13px; font-weight: 760; }
    .reference-queues .queue-grid { margin-top: 10px; }
    .queue-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; border-bottom: 1px solid #edf0e9; padding-bottom: 8px; }
    .queue-title { font-size: 14px; font-weight: 780; }
    .queue-count { color: var(--subtle); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .work-list { display: grid; gap: 0; }
    .work-row { display: grid; grid-template-columns: minmax(220px, 1.05fr) minmax(260px, 1.2fr) 130px 150px minmax(170px, .9fr); gap: 14px; align-items: start; border-bottom: 1px solid #edf0e9; padding: 10px 0; font-size: 12px; }
    .work-row:last-child { border-bottom: 0; }
    .work-row.header { color: var(--subtle); font-size: 11px; font-weight: 760; text-transform: uppercase; letter-spacing: 0; padding-top: 0; }
    .work-name { font-weight: 740; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .work-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .work-sub { color: var(--subtle); margin-top: 4px; line-height: 1.25; overflow-wrap: anywhere; }
    .work-detail { line-height: 1.35; overflow-wrap: anywhere; }
    .work-note { line-height: 1.35; overflow-wrap: anywhere; }
    .sample-table { display: grid; gap: 0; font-size: 12px; }
    .sample-row { display: grid; grid-template-columns: 118px minmax(180px, 1fr) 96px 120px 86px; gap: 10px; border-bottom: 1px solid #edf0e9; padding: 8px 0; align-items: baseline; }
    .sample-table.compact { max-height: 240px; overflow: auto; padding-right: 4px; }
    .sample-table.compact .sample-row { grid-template-columns: minmax(150px, 1fr) 92px 116px; }
    .sample-panel .sample-table { max-height: 520px; overflow: auto; padding-right: 4px; }
    .sample-row.header { color: var(--subtle); font-weight: 720; }
    .sample-name { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { display: inline-flex; align-items: center; min-height: 22px; border-radius: 5px; padding: 0 7px; background: #eef1eb; color: var(--subtle); font-weight: 700; font-size: 11px; width: fit-content; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge.good { background: #edf8f1; color: var(--green); }
    .badge.warn { background: #fff5df; color: var(--amber); }
    .badge.danger { background: #fff0ee; color: var(--red); }
    .badge.review { background: #f2effb; color: var(--violet); }
    .badge.info { background: #edf4fb; color: var(--blue); }
    .muted { color: var(--subtle); }
    .error { color: var(--red); font-weight: 700; }
    .warning { color: var(--amber); font-weight: 700; }
    @media (max-width: 1180px) {
      .summary-grid { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
      .product-picture, .two-col, .bottleneck-grid { grid-template-columns: 1fr; }
      .phase-grid { grid-template-columns: 1fr; }
      .pipeline-map { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      main { width: min(100% - 20px, 1500px); }
      .topbar { flex-direction: column; gap: 12px; }
      h1 { font-size: 24px; }
      .subtitle { font-size: 13px; }
      .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .recent-grid, .worker-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .spark-grid { grid-template-columns: 1fr; }
      .mini { min-height: 62px; padding: 9px; }
      .mini strong { font-size: 18px; }
      .card { min-height: 76px; padding: 10px; }
      .card .value { font-size: 22px; }
      .card .hint { display: none; }
      .overall-head { display: grid; gap: 8px; }
      .overall-value { white-space: normal; font-size: 15px; }
      .pipeline-map { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .focus-row { grid-template-columns: 1fr; gap: 3px; }
      .viz-row { grid-template-columns: 1fr; }
      .bar-row { grid-template-columns: 1fr; gap: 5px; }
      .bar-value, .lane-detail { text-align: left; }
      .timeline-row { grid-template-columns: 1fr 1fr; }
      .live-work-head { display: grid; gap: 10px; }
      .queue-tabs { justify-content: flex-start; }
      .queue-grid { grid-template-columns: 1fr; }
      .work-row { grid-template-columns: 1fr; gap: 5px; }
      .sample-row { grid-template-columns: 1fr; gap: 4px; }
      .sample-table.compact .sample-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <div class="topbar">
      <div>
        <h1>Olympus Live Source Ingestion</h1>
        <p class="subtitle">Live bounded-metadata control room for Dropbox source readiness. It polls the private host for current queue, QA, embedding, aggregate lane, worker state, and capped file-name/path samples. It does not expose document text.</p>
      </div>
      <div id="status-pill" class="pill warn">Connecting</div>
    </div>
    <div id="app">
      <section class="section">
        <div class="panel">Loading live dashboard...</div>
      </section>
    </div>
  </main>
  <script>
    const app = document.getElementById('app');
    const pill = document.getElementById('status-pill');
    const formatter = new Intl.NumberFormat('en-US');

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function fmt(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
      return formatter.format(Number(value));
    }

    function fmtDelta(value) {
      if (value === null || value === undefined) return 'n/a';
      const n = Number(value);
      if (n === 0) return '0';
      return (n > 0 ? '+' : '') + fmt(n);
    }

    function pct(done, total) {
      if (!total || total <= 0) return 0;
      return Math.max(0, Math.min(100, (done / total) * 100));
    }

    function pctLabel(done, total) {
      return pct(done, total).toFixed(1) + '%';
    }

    function card(label, value, hint) {
      return '<div class="card"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + escapeHtml(value) + '</div><div class="hint">' + escapeHtml(hint) + '</div></div>';
    }

    function mini(label, value, tone) {
      return '<div class="mini ' + escapeHtml(tone || '') + '"><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + '</span></div>';
    }

    function progress(label, done, total, tone, detail) {
      const width = pct(done, total);
      return '<div class="progress"><div class="progress-row"><div class="progress-label">' + escapeHtml(label) + '</div><div class="progress-value">' + escapeHtml(fmt(done) + ' / ' + fmt(total) + ' - ' + pctLabel(done, total)) + '</div></div><div class="track"><div class="fill ' + escapeHtml(tone || '') + '" style="width:' + width + '%"></div></div><div class="phase-note">' + escapeHtml(detail || '') + '</div></div>';
    }

    function unknownProgress(label, value, detail) {
      return '<div class="progress"><div class="progress-row"><div class="progress-label">' + escapeHtml(label) + '</div><div class="progress-value">' + escapeHtml(value) + '</div></div><div class="track unknown"></div><div class="phase-note">' + escapeHtml(detail || '') + '</div></div>';
    }

    function lane(label, done, total, detail, tone) {
      const width = pct(done, total);
      return '<div class="lane"><div class="lane-row"><div class="lane-name">' + escapeHtml(label) + '</div><div class="lane-detail">' + escapeHtml(detail || (fmt(done) + ' / ' + fmt(total))) + '</div></div><div class="track"><div class="fill ' + escapeHtml(tone || '') + '" style="width:' + width + '%"></div></div></div>';
    }

    function toneColor(tone) {
      if (tone === 'good') return 'var(--green)';
      if (tone === 'warn') return 'var(--amber)';
      if (tone === 'danger') return 'var(--red)';
      if (tone === 'review') return 'var(--violet)';
      if (tone === 'info') return 'var(--blue)';
      if (tone === 'teal') return 'var(--teal)';
      return 'var(--gray)';
    }

    function donut(label, segments, centerValue, centerCaption, detail) {
      const normalized = segments
        .map((segment) => ({ ...segment, value: Math.max(0, Number(segment.value || 0)) }))
        .filter((segment) => segment.value > 0);
      const total = normalized.reduce((sum, segment) => sum + segment.value, 0);
      let cursor = 0;
      const gradient = total > 0
        ? normalized.map((segment) => {
          const start = cursor;
          const end = cursor + (segment.value / total) * 100;
          cursor = end;
          return toneColor(segment.tone) + ' ' + start.toFixed(3) + '% ' + end.toFixed(3) + '%';
        }).join(', ')
        : '#e9eee6 0% 100%';
      const legend = normalized.length
        ? normalized.map((segment) => '<div class="legend-row"><span class="swatch" style="background:' + toneColor(segment.tone) + '"></span><span class="legend-label">' + escapeHtml(segment.label) + '</span><span class="legend-value">' + escapeHtml(fmt(segment.value) + ' - ' + pctLabel(segment.value, total)) + '</span></div>').join('')
        : '<div class="phase-note">No data yet.</div>';
      return '<div class="viz"><div class="progress-row"><div class="progress-label">' + escapeHtml(label) + '</div><div class="progress-value">' + escapeHtml(fmt(total) + ' total') + '</div></div><div class="viz-row"><div class="donut" style="background: conic-gradient(' + gradient + ')"><div class="donut-hole"><div><div class="donut-value">' + escapeHtml(centerValue) + '</div><div class="donut-caption">' + escapeHtml(centerCaption) + '</div></div></div></div><div class="legend">' + legend + '</div></div><div class="phase-note">' + escapeHtml(detail || '') + '</div></div>';
    }

	    function statusTone(status) {
	      if (status === 'indexed') return 'good';
	      if (status === 'leased') return 'info';
	      if (status === 'lease_expired') return 'warn';
	      if (status === 'queued') return 'review';
      if (status === 'failed_retryable') return 'warn';
      if (status === 'failed_terminal') return 'danger';
      if (status === 'blocked_policy') return 'danger';
      if (status === 'embedding_pending') return 'review';
      if (status === 'metadata_synced') return 'info';
      if (status === 'metadata_only' || status.startsWith('skipped')) return 'warn';
      return '';
    }

    function barRows(rows) {
      const max = Math.max(1, ...rows.map((row) => Number(row.count || row.files || 0)));
      return '<div class="bar-list">' + rows.map((row) => {
        const value = Number(row.count || row.files || 0);
        return '<div class="bar-row"><div class="bar-label" title="' + escapeHtml(row.label) + '">' + escapeHtml(row.label) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + pct(value, max) + '%"></div></div><div class="bar-value">' + escapeHtml(fmt(value)) + '</div></div>';
      }).join('') + '</div>';
    }

    function mediaJobGroupBody(groups) {
      if (!groups || !groups.length) return '<div class="phase-note">No media-capable extraction rows are visible yet.</div>';
	      return '<div class="phase-note">Media lane separation: active Delphi repair and on-demand image jobs are current work; historical broad VLM and wrong-lane Venice rows are cleanup/deferred rows, not the intended active path.</div><div class="lanes">'
	        + groups.slice(0, 6).map((group) => {
	          const active = group.leasedCurrentJobs;
	          const done = group.completedJobs;
	          const open = group.queuedJobs + group.leasedCurrentJobs + group.leasedExpiredJobs + group.retryableJobs;
	          const detail = fmt(active) + ' current · ' + fmt(group.leasedExpiredJobs) + ' stale · ' + fmt(open) + ' open · ' + fmt(done) + ' terminal';
	          const tone = group.label.startsWith('Historical') || group.label.startsWith('Wrong-lane') || group.leasedExpiredJobs > 0 ? 'warn' : active > 0 ? 'good' : 'info';
	          return lane(group.label, done, Math.max(1, group.plannedJobs), detail, tone);
	        }).join('')
        + '</div>';
    }

    function sampleRows(samples, allowedGroups, limit, compact) {
      const filtered = samples.filter((sample) => !allowedGroups || allowedGroups.includes(sample.group)).slice(0, limit || 32);
      if (!filtered.length) return '<p class="muted">No file-name samples in this slice yet.</p>';
      if (compact) {
        return '<div class="sample-table compact"><div class="sample-row header"><span>file name</span><span>status</span><span>type / attempts</span></div>' + filtered.map((sample) => {
          const recipe = sample.extractorKind && sample.extractorKind !== 'local_text' ? ' · ' + sample.extractorKind : '';
          return '<div class="sample-row"><span class="sample-name" title="' + escapeHtml(sample.name) + '">' + escapeHtml(sample.name) + '</span><span><span class="badge ' + escapeHtml(statusTone(sample.status)) + '">' + escapeHtml(sample.status) + '</span></span><span class="muted">' + escapeHtml(sample.fileType + ' · ' + fmt(sample.attempts) + ' try' + (sample.attempts === 1 ? '' : 'ies') + recipe) + '</span></div>';
        }).join('') + '</div>';
      }
      return '<div class="sample-table"><div class="sample-row header"><span>group</span><span>file name</span><span>status</span><span>type / attempts</span><span>age</span></div>' + filtered.map((sample) => {
        const recipe = sample.extractorKind && sample.extractorKind !== 'local_text' ? ' · ' + sample.extractorKind : '';
        return '<div class="sample-row"><span class="muted">' + escapeHtml(sample.group) + '</span><span class="sample-name" title="' + escapeHtml(sample.name) + '">' + escapeHtml(sample.name) + '</span><span><span class="badge ' + escapeHtml(statusTone(sample.status)) + '">' + escapeHtml(sample.status) + '</span></span><span class="muted">' + escapeHtml(sample.fileType + ' · ' + fmt(sample.attempts) + ' try' + (sample.attempts === 1 ? '' : 'ies') + recipe) + '</span><span class="muted">' + escapeHtml(ageLabel(sample.updatedAt)) + '</span></div>';
      }).join('') + '</div>';
    }

    function liveFileProgress(samples) {
      const activeGroups = [
        'Active local text/PDF',
        'Active local OCR',
        'Active local VLM',
        'Active local other',
        'Active Venice/Grok',
      ];
      const waitingGroups = [
        'Stale local leases',
        'Stale Venice/Grok leases',
        'Waiting local text/PDF',
        'Waiting local OCR',
        'Waiting local VLM',
        'Waiting local other',
        'Waiting Venice/Grok',
        'Retry queue',
        'Wrong-lane old retries',
        'Historical broad VLM jobs',
        'Embedding queue',
        'Metadata sync recent',
      ];
      const referenceGroups = [
        'Recent completed',
        'Book/library inventory',
      ];
      const orderedGroups = activeGroups.concat(waitingGroups, referenceGroups);
      const groups = new Map();
      for (const sample of samples) {
        if (!isLiveWorkSample(sample)) continue;
        if (!groups.has(sample.group)) groups.set(sample.group, []);
        groups.get(sample.group).push(sample);
      }
      const active = activeGroups
        .map((name) => ({ name, rows: groups.get(name) || [] }))
        .filter((group) => group.rows.length > 0);
      const waiting = waitingGroups
        .map((name) => ({ name, rows: groups.get(name) || [] }))
        .filter((group) => group.rows.length > 0);
      const reference = referenceGroups
        .map((name) => ({ name, rows: groups.get(name) || [] }))
        .filter((group) => group.rows.length > 0);
      const extra = Array.from(groups.entries())
        .filter(([name]) => !orderedGroups.includes(name))
        .map(([name, rows]) => ({ name, rows }));
      const allGroups = active.concat(waiting, extra);
      const activeShown = active.reduce((sum, group) => sum + group.rows.length, 0);
      const chips = activeGroups.concat(waitingGroups)
        .map((name) => ({ name, count: (groups.get(name) || []).length }))
        .map((item) => '<span class="queue-chip ' + (item.count > 0 ? '' : 'quiet') + '"><strong>' + escapeHtml(fmt(item.count)) + '</strong>' + escapeHtml(queueShortName(item.name)) + '</span>')
        .join('');
      const referenceBody = reference.length
        ? '<details class="reference-queues"><summary>Recent terminal and inventory rows (' + escapeHtml(fmt(reference.reduce((sum, group) => sum + group.rows.length, 0))) + ' shown)</summary><div class="queue-grid">' + reference.map((group) => queuePanel(group.name, group.rows)).join('') + '</div></details>'
        : '';
      if (!allGroups.length) {
        return '<section class="section"><div class="panel live-work"><div class="live-work-head"><div><h2>Live File Progress</h2><p class="subtitle">No active, queued, retry, stale-lease, metadata-sync, or embedding rows are visible in this sample. Terminal inventory is kept below as reference when available.</p></div></div>' + referenceBody + '</div></section>';
      }
      return '<section class="section"><div class="panel live-work">'
        + '<div class="live-work-head"><div><h2>Live File Progress</h2><p class="subtitle">Current, unexpired leases are shown first as active work. Expired leases are shown separately as stale operational debt, followed by waiting/retry queues, metadata sync, and embedding rows. Terminal book/library inventory is collapsed below so it does not hide live progress.</p></div><div class="queue-tabs">' + chips + '</div></div>'
        + (activeShown > 0 ? '' : '<div class="phase-note">No current active file leases are visible in this sample; the first rows below are stale leases, queued work, retry work, metadata sync, or embedding rows.</div>')
        + '<div class="queue-grid">' + allGroups.map((group) => queuePanel(group.name, group.rows)).join('') + '</div>'
        + referenceBody
        + '</div></section>';
    }

    function isLiveWorkSample(sample) {
      if (sample.group === 'Venice lane') return false;
      if (sample.supersededByLocalSuccess) return false;
      return String(sample.group || '').toLowerCase().indexOf('superseded') === -1;
    }

    function queuePanel(name, rows) {
      const body = rows.length
        ? '<div class="work-row header"><span>File</span><span>Location</span><span>State</span><span>Lane</span><span>Note</span></div>' + rows.map(workRow).join('')
        : '<p class="muted">No files in this queue in the current sample.</p>';
      return '<div class="queue-panel"><div class="queue-head"><div><div class="queue-title">' + escapeHtml(name) + '</div><div class="phase-note">' + escapeHtml(queueDescription(name)) + '</div></div><div class="queue-count">' + escapeHtml(fmt(rows.length) + ' shown') + '</div></div><div class="work-list">' + body + '</div></div>';
    }

    function workRow(sample) {
      const state = workState(sample);
      const status = '<span class="badge ' + escapeHtml(statusTone(state.rawStatus)) + '">' + escapeHtml(state.label) + '</span>';
      const size = sample.sizeBytes === null ? 'size unknown' : bytes(sample.sizeBytes);
      const location = sample.pathDisplay || 'path unavailable';
	      const timing = [
	        sample.createdAt ? 'queued ' + relativeTimeLabel(sample.createdAt) : '',
	        leaseTimingLabel(sample),
	        sample.nextRetryAt ? 'retry ' + relativeTimeLabel(sample.nextRetryAt) : '',
	      ].filter(Boolean).join(' · ');
	      return '<div class="work-row">'
        + '<div><div class="work-name" title="' + escapeHtml(sample.name) + '">' + escapeHtml(sample.name) + '</div><div class="work-sub">' + escapeHtml(sample.fileType + ' · ' + size) + '</div></div>'
        + '<div><div class="work-path" title="' + escapeHtml(location) + '">' + escapeHtml(location) + '</div><div class="work-sub">' + escapeHtml('updated ' + ageLabel(sample.updatedAt)) + '</div></div>'
        + '<div>' + status + '<div class="work-sub">' + escapeHtml(state.detail) + '</div></div>'
        + '<div><div class="work-detail">' + escapeHtml(laneLabel(sample)) + '</div><div class="work-sub">' + escapeHtml(shortRecipe(sample)) + '</div></div>'
        + '<div><div class="work-note">' + escapeHtml(workNote(sample)) + '</div><div class="work-sub">' + escapeHtml(timing || fmt(sample.attempts) + ' attempt' + (sample.attempts === 1 ? '' : 's')) + '</div></div>'
        + '</div>';
	    }

	    function leaseTimingLabel(sample) {
	      if (!sample.leasedUntil) return '';
	      if (sample.leaseState === 'expired') return 'lease expired ' + relativeTimeLabel(sample.leasedUntil);
	      return 'lease expires ' + relativeTimeLabel(sample.leasedUntil);
	    }

	    function workState(sample) {
	      if (sample.group === 'Wrong-lane old retries') return { label: 'needs replan', detail: 'wrong lane', rawStatus: 'failed_retryable' };
	      if (sample.group === 'Historical broad VLM jobs') return { label: 'deferred', detail: 'old VLM row', rawStatus: sample.status };
	      if (sample.status === 'queued') return { label: 'queued', detail: 'waiting', rawStatus: sample.status };
	      if (sample.status === 'leased' && sample.leaseState === 'expired') return { label: 'stale', detail: 'lease expired', rawStatus: 'lease_expired' };
	      if (sample.status === 'leased') return { label: 'in progress', detail: 'claimed', rawStatus: sample.status };
      if (sample.status === 'failed_retryable') return { label: 'failed', detail: 'retryable', rawStatus: sample.status };
      if (sample.status === 'failed_terminal') return { label: 'failed', detail: 'terminal', rawStatus: sample.status };
      if (sample.status === 'indexed') return { label: 'done', detail: 'indexed', rawStatus: sample.status };
      if (sample.status === 'metadata_only') return { label: 'done', detail: 'metadata only', rawStatus: sample.status };
      if (sample.status === 'embedding_pending') return { label: 'queued', detail: 'embedding', rawStatus: sample.status };
      if (sample.status === 'metadata_synced') return { label: 'done', detail: 'metadata sync', rawStatus: sample.status };
      if (sample.status === 'blocked_policy') return { label: 'blocked', detail: 'policy', rawStatus: sample.status };
      if (sample.status.startsWith('skipped')) return { label: 'skipped', detail: sample.status.replace(/^skipped_/, ''), rawStatus: sample.status };
      return { label: statusLabel(sample.status), detail: sample.phase || phaseLabel(sample.status), rawStatus: sample.status };
    }

	    function laneLabel(sample) {
	      if (sample.group === 'Stale local leases') return 'Stale local/Delphi';
	      if (sample.group === 'Stale Venice/Grok leases') return 'Stale Venice/Grok';
	      if (sample.group === 'Wrong-lane old retries') return 'Needs local/vision';
      if (sample.group === 'Historical broad VLM jobs') return 'Historical VLM cleanup';
      if (sample.extractorKind.startsWith('venice_')) return 'Venice/Grok';
      if (sample.extractorKind.includes('embedding')) return 'Local embedding';
      if (sample.extractorKind.includes('metadata')) return 'Metadata sync';
      if (sample.extractorKind.startsWith('local_')) return localLaneLabel(sample.extractorKind);
      return sample.workflow || 'Source worker';
    }

    function localLaneLabel(kind) {
      if (kind === 'local_text' || kind === 'local_text_and_pdf') return 'Local text/PDF';
      if (kind.startsWith('local_ocr')) return 'Local OCR';
      if (kind.startsWith('local_vlm') || kind.includes('vision')) return 'Local VLM';
      if (kind === 'local_visual_descriptor') return 'Local visual descriptor';
      if (kind === 'local_document_facts') return 'Local document facts';
      if (kind.includes('structured')) return 'Local structured parser';
      return 'Local/Delphi';
    }

    function shortRecipe(sample) {
      const version = sample.extractorVersion ? ' · ' + sample.extractorVersion : '';
      return sample.extractorKind + version;
    }

	    function workNote(sample) {
	      if (sample.status === 'leased' && sample.leaseState === 'expired') return 'Lease expired; this should be reclaimed or explained by a live worker heartbeat.';
	      if (sample.group === 'Wrong-lane old retries') return 'E2EE document path cannot process visual media; replan to local or vision-capable lane.';
      if (sample.group === 'Historical broad VLM jobs') return 'Old broad media job; retire to metadata-only or requeue through the dedicated Delphi lane when explicitly needed.';
      if (sample.status === 'failed_retryable') return 'Retryable: ' + (sample.lastErrorKind || 'temporary failure') + '.';
      if (sample.status === 'failed_terminal') return 'Terminal: ' + (sample.lastErrorKind || 'extractor failure') + '.';
      if (sample.status === 'queued') return sample.nextRetryAt ? 'Retry ' + relativeTimeLabel(sample.nextRetryAt) + '.' : 'Waiting for a worker.';
      if (sample.status === 'leased') return sample.leasedUntil ? 'Claimed; lease expires ' + relativeTimeLabel(sample.leasedUntil) + '.' : 'Worker has claimed it.';
      if (sample.status === 'indexed') return 'Usable extraction written.';
      if (sample.status === 'metadata_only') return 'Metadata-only result.';
      if (sample.status === 'embedding_pending') return sample.detail || 'Chunks need embedding.';
      if (sample.status === 'metadata_synced') return 'Metadata refreshed.';
      if (sample.status === 'blocked_policy') return 'Blocked by policy.';
      if (sample.status.startsWith('skipped')) return 'Skipped by extractor policy.';
      return sample.detail || statusDetail(sample.status);
    }

    function queueShortName(name) {
	      if (name.startsWith('Active')) return name.replace('Active ', '');
	      if (name.startsWith('Stale')) return name.replace('Stale ', '');
	      if (name.startsWith('Waiting')) return name.replace('Waiting ', '');
      if (name === 'Metadata sync recent') return 'metadata';
      if (name === 'Recent completed') return 'completed';
      if (name === 'Book/library inventory') return 'books';
      if (name === 'Retry queue') return 'retry';
      if (name === 'Wrong-lane old retries') return 'wrong lane';
      if (name === 'Historical broad VLM jobs') return 'old VLM';
      if (name === 'Embedding queue') return 'embedding';
      return name;
    }

    function queueDescription(name) {
      if (name === 'Active local text/PDF') return 'Workers have claimed plain text, office/text-layer PDF, or structured local extraction work.';
      if (name === 'Active local OCR') return 'Workers have claimed OCR-required files for Delphi/local OCR.';
	      if (name === 'Active local VLM') return 'Workers have claimed visual files for Delphi/local vision processing.';
	      if (name === 'Active local other') return 'Workers have claimed other local/Delphi extractor jobs.';
	      if (name === 'Active Venice/Grok') return 'Workers have claimed these files for private Venice/Grok escalation.';
	      if (name === 'Stale local leases') return 'Local/Delphi jobs whose lease window has expired. These are not active work unless a worker heartbeat proves otherwise.';
	      if (name === 'Stale Venice/Grok leases') return 'Venice/Grok jobs whose lease window has expired. These are stale escalation claims, not current active calls.';
      if (name === 'Waiting local text/PDF') return 'Queued text/PDF/structured files waiting for a local extraction worker.';
      if (name === 'Waiting local OCR') return 'Queued OCR files waiting for a local extraction worker.';
      if (name === 'Waiting local VLM') return 'Queued visual files waiting for a local VLM worker.';
      if (name === 'Waiting local other') return 'Queued local/Delphi jobs that do not fit the main local lanes.';
      if (name === 'Waiting Venice/Grok') return 'Queued files waiting for Venice/Grok escalation capacity.';
      if (name === 'Book/library inventory') return 'Book/library files are kept as folder and metadata inventory unless a user explicitly asks for deeper ingestion.';
      if (name === 'Retry queue') return 'Files that failed retryably and are waiting for their next lease window.';
      if (name === 'Wrong-lane old retries') return 'Old retry rows whose recipe no longer matches the file type. These should be replanned to local/Delphi or a vision-capable lane.';
      if (name === 'Historical broad VLM jobs') return 'Old broad VLM rows from before the dedicated Delphi repair/on-demand lanes. These are cleanup/deferred rows, not the current live Delphi queue.';
      if (name === 'Embedding queue') return 'Files with secure-local chunks still waiting for local embedding.';
      if (name === 'Metadata sync recent') return 'Recent file metadata observed by Dropbox sync; no file bytes are downloaded in this phase.';
      if (name === 'Recent completed') return 'Recently terminal extraction jobs: indexed, metadata-only, skipped, blocked, or failed terminal.';
      return 'File-level queue sample.';
    }

    function statusLabel(status) {
      if (status === 'embedding_pending') return 'pending';
      if (status === 'metadata_synced') return 'synced';
      return status;
    }

    function workflowLabel(kind) {
      if (!kind) return 'Source worker';
      if (kind.startsWith('venice_')) return 'Venice/Grok escalation';
      if (kind.includes('embedding')) return 'Local embeddings';
      if (kind.startsWith('local_')) return 'Local/Delphi processing';
      if (kind.includes('metadata')) return 'Metadata sync';
      return 'Source worker';
    }

    function phaseLabel(status) {
      if (status === 'queued') return 'waiting for worker';
      if (status === 'leased') return 'claimed by worker';
      if (status === 'indexed') return 'extracted and indexed';
      if (status === 'metadata_only') return 'metadata-only terminal';
      if (status === 'failed_retryable') return 'retryable failure';
      if (status === 'failed_terminal') return 'terminal failure';
      if (status === 'blocked_policy') return 'policy blocked';
      if (status && status.startsWith('skipped')) return 'skipped terminal';
      return status || 'unknown';
    }

    function statusDetail(status) {
      if (status === 'queued') return 'Waiting to be claimed by a worker.';
      if (status === 'leased') return 'A worker has claimed the job and is doing the extraction path.';
      if (status === 'indexed') return 'Usable text, artifacts, or facts were written.';
      if (status === 'metadata_only') return 'Handled as metadata-only; no answer text was produced.';
      if (status === 'failed_retryable') return 'The job failed but can be retried.';
      if (status === 'failed_terminal') return 'The job exhausted retries or hit a terminal extractor error.';
      if (status === 'blocked_policy') return 'The item is blocked by policy and will not be sent onward.';
      if (status && status.startsWith('skipped')) return 'The item was intentionally skipped by extractor policy.';
      return 'Current file-level state.';
    }

    function downloadPolicy(sample) {
      if (sample.status === 'metadata_synced') return 'Provider metadata only; no file bytes downloaded.';
      if (sample.status === 'embedding_pending') return 'Uses existing secure-local chunks; no Dropbox download.';
      if (sample.status === 'metadata_only' || sample.status === 'skipped_unsupported' || sample.status === 'skipped_too_large' || sample.status === 'blocked_policy') return 'No file download for this terminal result.';
      if (sample.extractorKind && sample.extractorKind.startsWith('venice_')) return 'Temporary download, then private Venice request; file bytes are not persisted.';
      return 'Temporary local download if needed; file bytes are not persisted.';
    }

    function pipelineMap() {
      const steps = [
        ['Sync', 'discover files'],
        ['Queue', 'plan work'],
        ['Extract', 'read content'],
        ['QA', 'tier/check'],
        ['Embed', 'make searchable'],
        ['Answer', 'cite evidence'],
      ];
      return '<div class="pipeline-map">' + steps.map((step, index) => '<div class="pipeline-step"><strong>' + escapeHtml(String(index + 1) + '. ' + step[0]) + '</strong><span>' + escapeHtml(step[1]) + '</span></div>').join('') + '</div>';
    }

    function focusRow(label, detail, value, tone) {
      return '<div class="focus-row"><span class="badge ' + escapeHtml(tone || '') + '">' + escapeHtml(label) + '</span><span class="focus-detail">' + escapeHtml(detail) + '</span><span class="focus-value">' + escapeHtml(value || '') + '</span></div>';
    }

    function operatorFocus(state) {
      const s = state.latest;
      const a = s.aggregates;
      const venice = a ? a.veniceProgress : null;
      const venicePause = activeProviderPause(s, 'venice');
      const veniceCredit = s.veniceCreditStatus;
      const veniceCreditJobs = venice && !veniceCreditCurrentlyAvailable(veniceCredit)
        ? veniceCreditExhaustedJobs(venice)
        : 0;
      const activeSync = a ? a.activeSync : null;
      const rows = [];
      rows.push(state.error
        ? focusRow('poll', 'Latest poll failed; showing the last successful sample.', 'stale', 'warn')
        : focusRow('poll', 'Dashboard samples are current and command errors are hidden from the product surface.', ageLabel(s.sampledAt), 'good'));
	      rows.push(s.drainWorkers.active > 0
	        ? focusRow('drain', fmt(s.drainWorkers.active) + ' active workers are visible; ' + fmt(currentLeaseCount(s)) + ' jobs have current leases.', fmt(staleLeaseCount(s)) + ' stale', staleLeaseCount(s) > 0 ? 'warn' : 'good')
	        : focusRow('drain', 'No active drain workers are visible.', 'stopped', 'danger'));
      rows.push(actionableQueueRemaining(s) > 0
        ? focusRow('jobs', fmt(actionableQueueRemaining(s)) + ' actionable jobs remain; raw queue includes ' + fmt(s.counts.queuedSuperseded + s.counts.failedSuperseded + s.counts.leasedCurrentSuperseded + s.counts.leasedExpiredSuperseded + s.counts.queuedPolicyExcluded + s.counts.failedPolicyExcluded + s.counts.leasedCurrentPolicyExcluded + s.counts.leasedExpiredPolicyExcluded) + ' superseded/excluded rows.', fmt(queueRemaining(s)) + ' raw', s.counts.failedActionable > 0 ? 'danger' : 'warn')
        : focusRow('jobs', 'No actionable queued or failed extraction jobs are visible; raw queue is historical/superseded debt.', fmt(queueRemaining(s)) + ' raw', queueRemaining(s) > 0 ? 'warn' : 'good'));
      rows.push(s.counts.blocked > 0 || s.qa.failedNeedsOperator > 0
        ? focusRow('blockers', fmt(s.counts.blocked) + ' blocked jobs and ' + fmt(s.qa.failedNeedsOperator) + ' operator failures remain.', fmt(s.qa.visibleGaps) + ' gaps', 'warn')
        : focusRow('blockers', 'No job blockers or operator failures are visible.', fmt(s.qa.visibleGaps) + ' gaps', 'good'));
      if (activeSync) {
        rows.push(focusRow('sync', 'Metadata sync has an active pass writing counts-only events. Top-level sync counters update when the pass completes.', fmt(activeSync.events) + ' events', 'info'));
      }
      rows.push(venicePause
        ? focusRow('Venice', 'Escalation is paused because Venice credits/payment are exhausted.', veniceCreditLabel(veniceCredit), 'danger')
        : veniceCreditJobs > 0
          ? focusRow('Venice', fmt(veniceCreditJobs) + ' Venice jobs report credit/payment exhaustion.', 'pause needed', 'danger')
          : venice && venice.activeJobs > 0
	        ? focusRow('Venice', 'Escalation jobs are open for hard documents; current calls are counted separately from stale leases.', fmt(venice.leasedCurrentJobs) + ' current', venice.leasedCurrentJobs > 0 ? 'good' : 'warn')
	        : focusRow('Venice', 'Escalation candidates exist, but active Venice/Grok work is limited right now.', fmt(s.qa.lowConfidenceCandidateForVenice) + ' candidates', s.qa.lowConfidenceCandidateForVenice > 0 ? 'warn' : 'good'));
      return '<div class="focus-list">' + rows.join('') + '</div>';
    }

    function bottleneckPanel(state) {
      const s = state.latest;
      const activeSync = s.aggregates ? s.aggregates.activeSync : null;
      const metadataOpen = s.counts.metadataFoldersPending + s.counts.metadataFoldersRetryableFailed;
      const metadataBlocked = s.counts.metadataFoldersBlocked + s.counts.metadataFoldersExhaustedRetry;
      const actionable = actionableQueueRemaining(s);
      const rawNonActionable = s.counts.queuedSuperseded
        + s.counts.queuedPolicyExcluded
        + s.counts.leasedCurrentSuperseded
        + s.counts.leasedCurrentPolicyExcluded
        + s.counts.leasedExpiredSuperseded
        + s.counts.leasedExpiredPolicyExcluded
        + s.counts.failedSuperseded
        + s.counts.failedPolicyExcluded;
      const metadataGapDetail = [
        s.qa.metadataOnlyGapLikelyNeedsExtraction > 0 ? fmt(s.qa.metadataOnlyGapLikelyNeedsExtraction) + ' likely need extraction' : '',
        s.qa.metadataOnlyGapLikelyDeferred > 0 ? fmt(s.qa.metadataOnlyGapLikelyDeferred) + ' likely deferred inventory' : '',
        s.qa.metadataOnlyGapUnknownOrNeedsPolicy > 0 ? fmt(s.qa.metadataOnlyGapUnknownOrNeedsPolicy) + ' need policy review' : '',
      ].filter(Boolean).join(' · ');
      const qaGaps = [
        { label: 'metadata gaps', value: s.qa.metadataOnlyGap, tone: 'warn', detail: metadataGapDetail },
        { label: 'local retry', value: s.qa.lowConfidenceRetryLocal, tone: 'review' },
        { label: 'Venice candidates', value: s.qa.lowConfidenceCandidateForVenice, tone: 'review' },
        { label: 'operator failures', value: s.qa.failedNeedsOperator, tone: 'danger' },
      ];
      const totalQaGaps = qaGaps.reduce((sum, row) => sum + row.value, 0);
      const diagnosis = ingestionDiagnosis(s, activeSync, metadataOpen, actionable, rawNonActionable, totalQaGaps);
      const queueAction = actionable > 0
        ? 'Let extraction workers drain the actionable queue; stale leases should be reclaimed if they are not backed by a live heartbeat.'
        : rawNonActionable > 0
          ? 'Do not chase the raw extraction queue. The visible raw backlog is superseded by local success, stale-scope history, or excluded by content policy.'
          : 'No file extraction queue is currently waiting; policy/on-demand inventory can stay mapped until Castor asks for it.';
      const metadataAction = metadataOpen > 0
        ? activeSync
          ? 'Metadata sync is active; watch in-flight sync events before changing extraction settings.'
          : 'Metadata frontier is open but no active sync pass is visible; enqueue/recycle the normal metadata sync lane before debugging extraction.'
        : metadataBlocked > 0
          ? 'Metadata frontier has blocked or retry-exhausted folders; inspect the bounded sync report and recycle only through the operator endpoint.'
          : 'Metadata frontier has no pending/retryable folders in this sample.';
      const qaAction = totalQaGaps > 0
        ? 'QA gaps remain: convert the largest gap category into planner targets, not broad raw Dropbox downloading.'
        : 'No QA gaps are visible in this sample.';
      return '<section class="section"><div class="panel diagnosis">'
        + '<div class="overall-head"><div><h2>Bottleneck / Next Action</h2><p class="subtitle">First-screen diagnosis from existing counts only: metadata frontier, actionable queue truth, service states, and QA gaps.</p></div><div class="overall-value">' + escapeHtml(diagnosis.badge) + '</div></div>'
        + '<div class="grid bottleneck-grid">'
        + '<div class="diagnosis-main ' + escapeHtml(diagnosis.tone) + '"><div class="diagnosis-label">Current bottleneck</div><div class="diagnosis-title">' + escapeHtml(diagnosis.title) + '</div><div class="diagnosis-copy">' + escapeHtml(diagnosis.detail) + '</div></div>'
        + '<div class="diagnosis-actions">'
        + '<div class="action-row"><strong>Next action:</strong> ' + escapeHtml(diagnosis.nextAction) + '</div>'
        + '<div class="action-row"><strong>Metadata frontier:</strong> ' + escapeHtml(metadataAction) + '</div>'
        + '<div class="action-row"><strong>Queue truth:</strong> ' + escapeHtml(queueAction) + '</div>'
        + '<div class="action-row"><strong>QA gaps:</strong> ' + escapeHtml(qaAction) + '</div>'
        + '</div>'
        + '</div>'
        + '<div class="grid recent-grid">'
        + mini('metadata pending', fmt(s.counts.metadataFoldersPending), s.counts.metadataFoldersPending > 0 ? 'warn' : 'good')
        + mini('metadata retryable', fmt(s.counts.metadataFoldersRetryableFailed), s.counts.metadataFoldersRetryableFailed > 0 ? 'warn' : 'good')
        + mini('actionable queue', fmt(actionable), actionable > 0 ? 'review' : 'good')
        + mini('superseded/excluded', fmt(rawNonActionable), rawNonActionable > 0 ? 'warn' : 'good')
        + mini('active services', fmt(activeServiceCount(s)), activeServiceCount(s) > 0 ? 'good' : 'danger')
        + mini('visible QA gaps', fmt(totalQaGaps), totalQaGaps > 0 ? 'warn' : 'good')
        + '</div>'
        + '<div class="grid bottleneck-grid"><div><h3>Active Service States</h3>' + serviceStateList(s) + '</div><div><h3>QA Gap Categories</h3>' + qaGapList(qaGaps) + '</div></div>'
        + '</div></section>';
    }

    function ingestionDiagnosis(s, activeSync, metadataOpen, actionable, rawNonActionable, totalQaGaps) {
      const currentLeases = actionableCurrentLeaseCount(s);
      if (metadataOpen > 0 && actionable === 0 && currentLeases === 0) {
        return {
          badge: 'metadata frontier',
          tone: activeSync ? 'review' : 'danger',
          title: 'Ingestion is waiting on metadata discovery, not extraction.',
          detail: fmt(metadataOpen) + ' folders are pending or retryable while no actionable extraction jobs or current leases are visible. Raw file counts can stay flat until the sync pass commits folder/file discoveries.',
          nextAction: activeSync
            ? 'Keep the sync drain running and watch active-sync events; do not restart extraction just because the file queue is empty.'
            : 'Start or recycle the metadata sync drain through the normal operator path so pending folders become known files and planner input.',
        };
      }
      if (actionable === 0 && rawNonActionable > 0) {
        return {
          badge: 'raw queue noise',
          tone: 'warn',
          title: 'The raw queue is mostly historical debt.',
          detail: fmt(rawNonActionable) + ' queued/failed rows are superseded by local success, stale-scope history, or excluded by policy, so they should not be read as available work.',
          nextAction: metadataOpen > 0 ? 'Return to the metadata frontier; it is the likely source of new actionable work.' : 'Leave deferred inventory mapped unless Castor asks for a specific folder or file.',
        };
      }
      if (actionable > 0 && s.drainWorkers.active === 0) {
        return {
          badge: 'workers stopped',
          tone: 'danger',
          title: 'Actionable jobs exist but no active drain workers are visible.',
          detail: fmt(actionable) + ' actionable jobs remain, with ' + fmt(currentLeases) + ' actionable current leases and ' + fmt(actionableStaleLeaseCount(s)) + ' actionable stale leases.',
          nextAction: 'Restart or inspect the relevant drain services before changing planner policy.',
        };
      }
      if (actionable > 0) {
        return {
          badge: 'extraction drain',
          tone: 'review',
          title: 'Extraction is the active work queue.',
          detail: fmt(actionable) + ' actionable jobs remain across queued, current lease, stale lease, and actionable failure states.',
          nextAction: 'Let active workers drain current jobs; reclaim stale leases if they are not backed by service heartbeats.',
        };
      }
      if (totalQaGaps > 0) {
        return {
          badge: 'policy/on-demand',
          tone: 'warn',
          title: 'Active drain is clear; remaining gaps need policy or on-demand decisions.',
          detail: fmt(totalQaGaps) + ' visible QA gaps remain across metadata-only gaps, local retry, Venice candidates, or operator failures. These are not automatically drainable queue items.',
          nextAction: 'Only create new planner targets for active-project facts that Castor needs; leave archive/books/media as metadata maps until requested.',
        };
      }
      return {
        badge: 'clear',
        tone: 'good',
        title: 'No top-level ingestion bottleneck is visible.',
        detail: 'Metadata frontier, extraction queue, and QA gap categories are clear in this sample.',
        nextAction: 'Watch throughput and answer-ready deltas for regression.',
      };
    }

    function activeServiceCount(s) {
      const services = s.drainWorkers.services || [];
      if (!services.length) return s.drainWorkers.active;
      return services.filter((service) => service.activeState === 'active' && service.subState === 'running').length;
    }

    function serviceStateList(s) {
      const services = [
        {
          label: 'Source worker',
          activeState: s.sourceWorker.activeState || 'unknown',
          subState: s.sourceWorker.subState || 'unknown',
          health: s.sourceWorker.health,
        },
      ].concat(s.drainWorkers.services || []);
      if (!services.length) {
        return '<div class="phase-note">Named service details are not available; aggregate drain states: ' + escapeHtml(JSON.stringify(s.drainWorkers.states || {})) + '</div>';
      }
      return '<div class="service-list">' + services.map((service) => {
        const tone = service.health === 'healthy' ? 'good' : service.health === 'attention' ? 'warn' : '';
        return '<div class="service-row"><span class="service-name">' + escapeHtml(service.label) + '</span><span class="service-state"><span class="badge ' + escapeHtml(tone) + '">' + escapeHtml(service.activeState + '/' + service.subState) + '</span></span></div>';
      }).join('') + '</div>';
    }

    function qaGapList(rows) {
      return '<div class="service-list">' + rows.map((row) =>
        '<div class="service-row"><span class="service-name">' + escapeHtml(row.label) + (row.detail ? '<br><span class="phase-note">' + escapeHtml(row.detail) + '</span>' : '') + '</span><span class="service-state"><span class="badge ' + escapeHtml(row.tone) + '">' + escapeHtml(fmt(row.value)) + '</span></span></div>'
      ).join('') + '</div>';
    }

    function series(state, selector) {
      return state.history.map(selector).filter((value) => Number.isFinite(Number(value))).map(Number);
    }

    function sparkline(label, values, tone, detail) {
      const clean = values.filter((value) => Number.isFinite(Number(value)));
      const latest = clean.length ? clean[clean.length - 1] : null;
      const min = clean.length ? Math.min(...clean) : 0;
      const max = clean.length ? Math.max(...clean) : 1;
      const span = Math.max(1, max - min);
      const points = clean.length > 1
        ? clean.map((value, index) => {
          const x = (index / Math.max(1, clean.length - 1)) * 100;
          const y = 38 - ((value - min) / span) * 34;
          return x.toFixed(2) + ',' + y.toFixed(2);
        }).join(' ')
        : '0,38 100,38';
      return '<div class="spark-card"><div class="spark-head"><span class="spark-label">' + escapeHtml(label) + '</span><span class="spark-value">' + escapeHtml(latest === null ? 'collecting' : fmt(latest)) + '</span></div><svg class="spark-svg" viewBox="0 0 100 42" preserveAspectRatio="none" aria-hidden="true"><polyline class="spark-line" style="stroke:' + toneColor(tone || 'info') + '" points="' + points + '"></polyline></svg><div class="phase-note">' + escapeHtml(detail || '') + '</div></div>';
    }

    function throughputPulse(state) {
      return '<div class="spark-grid">'
	        + sparkline('Actionable queue', series(state, (sample) => actionableQueueRemaining(sample)), 'review', 'Lower is better; excludes superseded queue rows that already have local success.')
        + sparkline('Extraction artifacts', series(state, (sample) => sample.counts.artifacts), 'info', 'Rises when extraction produces artifact records.')
        + sparkline('Embedded chunks', series(state, (sample) => sample.counts.embeddedChunks), 'good', 'Rises when searchable chunks are embedded.')
        + sparkline('Answer-ready files', series(state, (sample) => sample.qa.pass), 'good', 'Final readiness signal.')
        + '</div>';
    }

    function ageLabel(iso) {
      if (!iso) return 'unknown';
      const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
      if (seconds < 90) return seconds + 's ago';
      const minutes = Math.round(seconds / 60);
      if (minutes < 90) return minutes + 'm ago';
      return Math.round(minutes / 60) + 'h ago';
    }

    function relativeTimeLabel(iso) {
      if (!iso) return 'unknown';
      const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
      const abs = Math.abs(seconds);
      const suffix = seconds >= 0 ? 'from now' : 'ago';
      if (abs < 90) return abs + 's ' + suffix;
      const minutes = Math.round(abs / 60);
      if (minutes < 90) return minutes + 'm ' + suffix;
      const hours = Math.round(minutes / 60);
      if (hours < 48) return hours + 'h ' + suffix;
      return Math.round(hours / 24) + 'd ' + suffix;
    }

    function etaLabel(hours) {
      if (hours === null || hours === undefined || !Number.isFinite(Number(hours)) || Number(hours) < 0) return 'collecting';
      if (hours < 1) return Math.max(1, Math.round(hours * 60)) + ' min';
      if (hours < 48) return hours.toFixed(1) + ' hr';
      return (hours / 24).toFixed(1) + ' days';
    }

    function rateLabel(value, unit) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'collecting';
      return fmt(Math.round(Number(value))) + ' ' + unit + '/hr';
    }

    function queueThroughputLabel(value, actionableRemaining) {
      if (countValue(actionableRemaining) === 0) return 'queue clear';
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'collecting';
      const rounded = Math.round(Number(value));
      if (rounded > 0) return fmt(rounded) + ' jobs/hr drained';
      if (rounded < 0) return fmt(Math.abs(rounded)) + ' jobs/hr added';
      return '0 jobs/hr';
    }

    function queueEtaHint(s, progress) {
      if (actionableQueueRemaining(s) === 0) return 'No actionable extraction queue is waiting.';
      return 'ETA for actionable queue: ' + etaLabel(progress?.eta.queueRemainingHours) + '.';
    }

	    function countValue(value) {
	      const number = Number(value);
	      return Number.isFinite(number) ? number : 0;
	    }

	    function currentLeaseCount(s) {
	      const current = Number(s.counts.leasedCurrent);
	      return Number.isFinite(current) ? current : countValue(s.counts.leased);
	    }

	    function staleLeaseCount(s) {
	      return countValue(s.counts.leasedExpired);
	    }

	    function actionableCurrentLeaseCount(s) {
	      const current = Number(s.counts.leasedCurrentActionable);
	      return Number.isFinite(current) ? current : currentLeaseCount(s);
	    }

	    function actionableStaleLeaseCount(s) {
	      const stale = Number(s.counts.leasedExpiredActionable);
	      return Number.isFinite(stale) ? stale : staleLeaseCount(s);
	    }

	    function queueRemaining(s) {
	      return countValue(s.counts.queued) + currentLeaseCount(s) + staleLeaseCount(s) + countValue(s.counts.failed);
	    }

    function actionableQueueRemaining(s) {
      return countValue(s.counts.queuedActionable) + actionableCurrentLeaseCount(s) + actionableStaleLeaseCount(s) + countValue(s.counts.failedActionable);
    }

    function nonActiveScopeCount(rows) {
      return rows
        .filter((row) => row.label !== 'Active ingestion roots')
        .reduce((sum, row) => sum + countValue(row.count), 0);
    }

    /**
     * How many files are actually supposed to end up with rich text.
     *
     * The ladder publishes this itself, and it is preferred: it was counted
     * over exactly the rows the ladder scored, in the same pass that produced
     * the pass count above it. The subtraction is the fallback for a host still
     * running a probe that reports no eligible count, and it is the identical
     * arithmetic that number is built from.
     */
    function richAnswerDenominator(s, totalFiles) {
      if (s.qa.eligibleItems > 0) return s.qa.eligibleItems;
      return Math.max(0, totalFiles - s.qa.metadataOnlyExpected - s.qa.blockedPolicy - s.qa.outOfContentScope);
    }

    function otherScopeFiles(s) {
      return s.aggregates ? nonActiveScopeCount(s.aggregates.scopeFiles) : 0;
    }

    function otherScopeFolders(s) {
      return s.aggregates ? nonActiveScopeCount(s.aggregates.scopeFolders) : 0;
    }

    function fullCorpusFiles(s) {
      const activeFromAggregate = s.aggregates ? countLabel(s.aggregates.scopeFiles, 'Active ingestion roots') : 0;
      const active = activeFromAggregate || s.counts.files;
      return active + otherScopeFiles(s);
    }

    function fullCorpusFolders(s) {
      const activeFromAggregate = s.aggregates ? countLabel(s.aggregates.scopeFolders, 'Active ingestion roots') : 0;
      const active = activeFromAggregate || s.counts.folders;
      return active + otherScopeFolders(s);
    }

    function activeSyncBody(activeSync) {
      if (!activeSync) return '';
      return '<div class="phase-note">Active metadata sync pass</div><div class="grid recent-grid">'
        + mini('active sync run', activeSync.status || 'running', 'info')
        + mini('items indexed this run', fmt(activeSync.itemsIndexed), activeSync.itemsIndexed > 0 ? 'good' : 'warn')
        + mini('items seen this run', fmt(activeSync.itemsSeen), activeSync.itemsSeen > 0 ? 'good' : 'info')
        + mini('events written', fmt(activeSync.events), activeSync.events > 0 ? 'good' : 'warn')
        + mini('upserts', fmt(activeSync.upserted), activeSync.upserted > 0 ? 'good' : 'info')
        + mini('started', ageLabel(activeSync.startedAt), 'info')
        + '</div><div class="phase-note">Discovery is still expanding the known Dropbox frontier. The full-corpus denominator can grow while active-root answer-ready work catches up; folder and sync-run progress finalize after the pass completes.</div>';
    }

    function overallProgress(state) {
      const s = state.latest;
      const totalFiles = s.qa.totalItems || s.counts.files;
      const handled = Math.min(totalFiles, s.qa.pass + s.qa.metadataOnlyExpected + s.qa.blockedPolicy + s.qa.outOfContentScope);
      const remaining = Math.max(0, totalFiles - handled);
      const fullFiles = Math.max(totalFiles, fullCorpusFiles(s));
      const fullFolders = fullCorpusFolders(s);
      const otherFiles = otherScopeFiles(s);
      const otherFolders = otherScopeFolders(s);
      const fullKnown = s.counts.files + s.counts.folders;
      const fullDiscovered = fullFiles + fullFolders;
      return '<section class="section"><div class="panel overall"><div class="overall-head"><div><h2 class="overall-title">Active-Root And Full-Corpus Progress</h2><p class="subtitle">Active-root progress is scoped to /1 Projects, /2 Areas, and /3 Resources. Full-corpus discovery is the broader Dropbox metadata map: Global Archive, broad roots, books, media, and other deferred inventory wait for Castor/on-demand requests instead of blocking the active drain.</p></div><div class="overall-value">' + escapeHtml(fmt(handled) + ' / ' + fmt(totalFiles) + ' active-root') + '</div></div>'
        + progress('Active-root answer progress', handled, totalFiles, 'good', fmt(remaining) + ' active-root files are not handled yet; ' + fmt(s.qa.pass) + ' are answer-ready and ' + fmt(s.qa.metadataOnlyExpected) + ' are expected metadata-only.')
        + progress('Full-corpus discovery progress', fullKnown, fullDiscovered, 'info', fmt(fullFiles) + ' discovered Dropbox files and ' + fmt(fullFolders) + ' folders are known across the full corpus. ' + fmt(otherFiles) + ' files and ' + fmt(otherFolders) + ' folders are outside the active roots, so they are not part of the answer-ready denominator above.')
        + '</div></section>';
    }

    function phaseCards(state) {
      const s = state.latest;
      const a = s.aggregates;
      const totalFiles = s.qa.totalItems || s.counts.files;
      const richAnswerNeeded = richAnswerDenominator(s, totalFiles);
      const fileSamples = a ? a.fileSamples : [];
      const mediaGroups = a ? a.mediaJobGroups : [];
      const outsideActiveScopeFiles = otherScopeFiles(s);
      const outsideActiveScopeFolders = otherScopeFolders(s);
      const planned = a ? a.planningFiles.plannedFiles : s.counts.extractionJobs;
      const unplanned = Math.max(0, totalFiles - planned);
      const planDonut = donut('Known files by planning state', [
        { label: 'Has extraction job', value: planned, tone: 'info' },
        { label: 'Known but not planned', value: unplanned, tone: 'warn' },
      ], pctLabel(planned, totalFiles), 'planned', fmt(planned) + ' known files have extraction jobs; ' + fmt(unplanned) + ' known files have not entered extraction planning yet.');
      const hasStatusFrontier = s.counts.metadataFoldersTotal > 0;
      const hasAggregateFrontier = Boolean(a && a.crawlFrontierStatuses.length > 0);
      const hasCrawlFrontier = hasStatusFrontier || hasAggregateFrontier;
      const activeSync = a ? a.activeSync : null;
      const crawlTotal = hasStatusFrontier
        ? s.counts.metadataFoldersTotal
        : hasAggregateFrontier ? a.crawlFrontierStatuses.reduce((sum, row) => sum + row.count, 0) : 0;
      const crawlVisited = hasStatusFrontier
        ? s.counts.metadataFoldersVisited
        : hasAggregateFrontier ? countLabel(a.crawlFrontierStatuses, 'visited') : 0;
      const crawlPending = hasStatusFrontier
        ? s.counts.metadataFoldersPending
        : hasAggregateFrontier ? countLabel(a.crawlFrontierStatuses, 'pending') : 0;
      const crawlBlocked = hasStatusFrontier
        ? s.counts.metadataFoldersBlocked
        : a ? countAny(a.crawlFrontierStatuses, ['blocked', 'failed']) : 0;
      const crawlRetry = hasStatusFrontier
        ? s.counts.metadataFoldersRetryableFailed
        : a ? countLabel(a.crawlFrontierStatuses, 'retryable_failed') : 0;
      const crawlExhaustedRetry = hasStatusFrontier ? s.counts.metadataFoldersExhaustedRetry : 0;
      const extractionPlanned = a ? a.planningFiles.plannedFiles : s.counts.extractionJobs;
      const extractionRetryable = a ? a.planningFiles.retryableFiles : s.counts.failed;
      const extractionFailedTerminal = a ? a.planningFiles.failedTerminalFiles : 0;
      const extractionHandled = a && a.extractionLanes.length
        ? a.extractionLanes.reduce((sum, row) => sum + row.terminal, 0)
        : Math.max(0, extractionPlanned - s.counts.queued - s.counts.leased - extractionRetryable);
      const extractionNeeded = Math.max(
        0,
        richAnswerDenominator(s, totalFiles),
        s.qa.pass + s.qa.visibleGaps + s.qa.pending,
      );
      const extractionReady = s.qa.pass;
      const lanesExtraction = a && a.extractionLanes.length ? a.extractionLanes.slice(0, 6).map((row) => lane(row.label, row.terminal, row.files, fmt(row.terminal) + ' handled / ' + fmt(row.files) + ' planned; ' + fmt(row.extracted) + ' rich extracted', 'info')).join('') : '';
      const lanesEmbedding = a && a.embeddingLanes.length ? a.embeddingLanes.slice(0, 6).map((row) => lane(row.label, row.embeddedChunks, row.chunks, fmt(row.embeddedChunks) + ' embedded / ' + fmt(row.chunks) + ' chunks', 'good')).join('') : '';
      const jobStatusRows = a ? a.jobStatuses : [];
	      const jobStateDonut = donut('Extraction job status mix', [
	        { label: 'Metadata-only', value: countLabel(jobStatusRows, 'metadata_only'), tone: 'warn' },
	        { label: 'Indexed', value: countLabel(jobStatusRows, 'indexed'), tone: 'good' },
	        { label: 'Actionable queued', value: s.counts.queuedActionable, tone: 'review' },
	        { label: 'Superseded queued', value: s.counts.queuedSuperseded, tone: 'muted' },
	        { label: 'Policy-excluded queued', value: s.counts.queuedPolicyExcluded, tone: 'muted' },
	        { label: 'Current leases', value: currentLeaseCount(s), tone: 'info' },
	        { label: 'Stale leases', value: staleLeaseCount(s), tone: 'warn' },
	        { label: 'Skipped too large', value: countLabel(jobStatusRows, 'skipped_too_large'), tone: 'warn' },
	        { label: 'Failed/retryable', value: countLabel(jobStatusRows, 'failed_retryable'), tone: 'warn' },
	        { label: 'Terminal failure', value: countLabel(jobStatusRows, 'failed_terminal'), tone: 'danger' },
	        { label: 'Policy blocked', value: countLabel(jobStatusRows, 'blocked_policy'), tone: 'danger' },
	      ], fmt(jobStatusRows.reduce((sum, row) => sum + row.count, 0) || s.counts.extractionJobs), 'jobs', 'A current lease is a job still inside its worker claim window. A stale lease is expired and should be reclaimed or explained by a live worker heartbeat.');
      // Same members as the probe's own qa_visible_gaps, raster escalation
      // included: a verdict the ladder can return and the donut cannot name is
      // a slice of files that silently leaves the chart.
      const qaGapTotal = s.qa.metadataOnlyGap
        + s.qa.rasterOcrVlmEscalation
        + s.qa.lowConfidenceRetryLocal
        + s.qa.lowConfidenceCandidateForVenice
        + s.qa.failedNeedsOperator;
      const qaDonut = donut('QA state mix', [
        { label: 'Answer-ready', value: s.qa.pass, tone: 'good' },
        // Its own slice rather than folded into visible gaps: the file IS
        // readable, it is the version that is wrong.
        { label: 'Text out of date', value: s.qa.staleRevision, tone: 'review' },
        { label: 'Pending/in flight', value: s.qa.pending, tone: 'info' },
        { label: 'Expected metadata-only', value: s.qa.metadataOnlyExpected, tone: 'teal' },
        { label: 'Visible gaps', value: qaGapTotal, tone: 'warn' },
        // Its own slice, never folded into visible gaps: a partial document is
        // answerable from the pages that ARE indexed, and counting it in both
        // places would double it in the needs-review total.
        { label: 'Some pages not extracted', value: s.qa.partialPagesGap, tone: 'warn' },
        { label: 'Policy blocked', value: s.qa.blockedPolicy, tone: 'danger' },
      ], pctLabel(s.qa.pass, Math.max(1, richAnswerNeeded)), 'rich ready', fmt(qaGapTotal) + ' visible gaps remain; ' + fmt(s.qa.partialPagesGap) + ' documents are indexed with some pages missing; metadata-only and policy-blocked files are counted in the overall handled meter above, not in rich answer-ready.');
      const venice = a && a.veniceProgress ? a.veniceProgress : {
        plannedJobs: 0,
        queuedJobs: 0,
	        leasedJobs: 0,
	        leasedCurrentJobs: 0,
	        leasedExpiredJobs: 0,
	        indexedJobs: 0,
        metadataOnlyJobs: 0,
        retryableJobs: 0,
        failedTerminalJobs: 0,
        blockedJobs: 0,
        skippedJobs: 0,
        completedJobs: 0,
        activeJobs: 0,
        recipeStatuses: [],
        errorKindStatuses: [],
      };
      const venicePause = activeProviderPause(s, 'venice');
      const veniceCredit = s.veniceCreditStatus;
      const veniceCreditJobs = !veniceCreditCurrentlyAvailable(veniceCredit)
        ? veniceCreditExhaustedJobs(venice)
        : 0;
      const veniceCurrentCandidates = s.qa.lowConfidenceCandidateForVenice;
      const venicePlanningDetail = venice.plannedJobs === 0 && veniceCurrentCandidates > 0
        ? 'Candidates exist, but the standing drain is not currently planning Venice/Grok jobs for them.'
	        : fmt(veniceCurrentCandidates) + ' current unresolved candidates; ' + fmt(venice.queuedJobs) + ' queued, ' + fmt(venice.leasedCurrentJobs) + ' current leases, ' + fmt(venice.leasedExpiredJobs) + ' stale leases, ' + fmt(venice.retryableJobs) + ' retryable.';
      const venicePauseBody = venicePause
        ? '<div class="phase-note error">Venice escalation paused: ' + escapeHtml(venicePause.message || 'provider credit/payment exhaustion') + '</div>'
        : veniceCreditJobs > 0
          ? '<div class="phase-note error">Venice credit/payment exhaustion detected in ' + escapeHtml(fmt(veniceCreditJobs)) + ' retryable job(s). Supervisor should latch the provider pause before more Venice calls.</div>'
          : '';
      const veniceCreditBody = '<div class="grid recent-grid">'
        + mini('credit monitor', veniceCreditLabel(veniceCredit), veniceCreditTone(veniceCredit))
        + mini('can consume', veniceCredit && veniceCredit.canConsume !== null ? String(veniceCredit.canConsume) : 'unknown', veniceCredit && veniceCredit.canConsume === true ? 'good' : 'warn')
        + mini('USD balance', veniceCreditBalance(veniceCredit, 'usd'), veniceCreditTone(veniceCredit))
        + mini('DIEM balance', veniceCreditBalance(veniceCredit, 'diem'), veniceCreditTone(veniceCredit))
        + '</div><div class="phase-note">' + escapeHtml(veniceCreditHint(veniceCredit)) + '</div>';
	      const veniceBody = venicePauseBody + veniceCreditBody + donut('Venice job status mix', [
	        { label: 'Queued', value: venice.queuedJobs, tone: 'review' },
	        { label: 'Current leases', value: venice.leasedCurrentJobs, tone: 'info' },
	        { label: 'Stale leases', value: venice.leasedExpiredJobs, tone: 'warn' },
	        { label: 'Indexed', value: venice.indexedJobs, tone: 'good' },
	        { label: 'Retryable', value: venice.retryableJobs, tone: 'warn' },
        { label: 'Terminal failure', value: venice.failedTerminalJobs, tone: 'danger' },
      ], pctLabel(venice.completedJobs, Math.max(1, venice.plannedJobs)), 'complete', venicePlanningDetail)
        + '<div class="grid recent-grid">'
        + mini('current candidates', fmt(veniceCurrentCandidates), veniceCurrentCandidates > 0 ? 'warn' : 'good')
        + mini('Venice jobs planned', fmt(venice.plannedJobs), venice.plannedJobs > 0 ? 'info' : 'warn')
	        + mini('Venice current leases', fmt(venice.leasedCurrentJobs), venice.leasedCurrentJobs > 0 ? 'good' : 'warn')
	        + mini('Venice stale leases', fmt(venice.leasedExpiredJobs), venice.leasedExpiredJobs > 0 ? 'warn' : 'good')
	        + mini('Venice jobs completed', fmt(venice.completedJobs), venice.completedJobs > 0 ? 'good' : 'info')
        + '</div>'
        + (venice.errorKindStatuses.length ? '<div class="phase-note">Venice retry blockers</div><div class="lanes">' + barRows(venice.errorKindStatuses.slice(0, 3)) + '</div>' : '')
        + (venice.recipeStatuses.length ? '<div class="lanes">' + barRows(venice.recipeStatuses.slice(0, 3)) + '</div>' : '<div class="phase-note">No Venice/Grok recipe rows are active in the job table yet.</div>')
        + '<div class="phase-note">Recent Venice files</div>'
        + sampleRows(fileSamples, ['Venice lane'], 3, true);
      const metadataBody = hasCrawlFrontier
        ? progress('Folders synced', crawlVisited, crawlTotal, 'info', fmt(crawlPending) + ' pending, ' + fmt(crawlRetry) + ' retriable, ' + fmt(crawlBlocked) + ' blocked, ' + fmt(crawlExhaustedRetry) + ' retry-exhausted.')
          + '<div class="grid recent-grid">'
          + mini('active-scope files', fmt(s.counts.files), 'info')
          + mini('known folders', fmt(s.counts.folders), 'info')
          + mini('full-corpus files', fmt(fullCorpusFiles(s)), 'info')
          + mini('full-corpus folders', fmt(fullCorpusFolders(s)), 'info')
          + mini('sync runs', fmt(s.counts.syncRuns), 'info')
          + mini('outside active roots', fmt(outsideActiveScopeFiles) + ' files / ' + fmt(outsideActiveScopeFolders) + ' folders', outsideActiveScopeFiles + outsideActiveScopeFolders > 0 ? 'warn' : 'good')
          + mini('tombstones', fmt(s.counts.tombstones), 'warn')
          + '</div>'
          + activeSyncBody(activeSync)
        : unknownProgress('Metadata sync coverage', 'not exposed', 'The live status endpoint reports current known files and folders, but not the total crawl frontier. This is not 100% complete; it is currently unmeasured here.')
          + '<div class="grid recent-grid">'
          + mini('active-scope files', fmt(s.counts.files), 'info')
          + mini('known folders', fmt(s.counts.folders), 'info')
          + mini('full-corpus files', fmt(fullCorpusFiles(s)), 'info')
          + mini('full-corpus folders', fmt(fullCorpusFolders(s)), 'info')
          + mini('sync runs', fmt(s.counts.syncRuns), 'info')
          + mini('outside active roots', fmt(outsideActiveScopeFiles) + ' files / ' + fmt(outsideActiveScopeFolders) + ' folders', outsideActiveScopeFiles + outsideActiveScopeFolders > 0 ? 'warn' : 'good')
          + mini('tombstones', fmt(s.counts.tombstones), 'warn')
          + '</div>'
          + activeSyncBody(activeSync);
      return [
        phase('Metadata Sync', 'Provider folder/file discovery and freshness mapping.', metadataBody),
        phase('Plan And Queue', 'Turn known files and QA gaps into extraction work.', planDonut + jobStateDonut + mediaJobGroupBody(mediaGroups)),
	        phase('Full Extraction', 'Run extraction jobs that produce usable text/artifacts for files that are not metadata-only by policy.', progress('Rich extraction usable', extractionReady, extractionNeeded, 'info', fmt(extractionHandled) + ' files have terminal job handling; ' + fmt(extractionPlanned) + ' files have been planned; ' + fmt(s.counts.queuedActionable) + ' actionable queued, ' + fmt(s.counts.queuedSuperseded) + ' superseded queued, ' + fmt(s.counts.queuedPolicyExcluded) + ' policy-excluded queued, ' + fmt(actionableCurrentLeaseCount(s)) + ' actionable current leases (' + fmt(currentLeaseCount(s)) + ' raw), ' + fmt(actionableStaleLeaseCount(s)) + ' actionable stale leases (' + fmt(staleLeaseCount(s)) + ' raw), ' + fmt(s.counts.failedActionable) + ' actionable failures, ' + fmt(extractionFailedTerminal) + ' operator failures. ' + fmt(s.qa.metadataOnlyExpected) + ' files are metadata-only by policy and excluded from this denominator.') + '<div class="lanes">' + lanesExtraction + '</div>'),
        phase('Classify And QA', 'Confirm privacy tier and whether the file is good enough for retrieval.', qaDonut + progress('Escalation candidates', s.qa.lowConfidenceCandidateForVenice, totalFiles, 'review', 'Low-confidence items waiting for Venice/Grok-style escalation.')),
        phase('Venice Escalation', 'Private Grok/Venice pass for low-confidence hard documents and image-like files.', veniceBody),
        phase('Embeddings', 'Make secure-local chunks searchable.', progress('Embedded chunks', s.counts.embeddedChunks, s.counts.chunks, 'good', rateLabel(state.progress?.ratesPerHour.embeddingGain, 'chunks') + ' in the live window.') + '<div class="lanes">' + lanesEmbedding + '</div>'),
        phase('Answer Ready', 'Final boss for files that should contribute cited text/artifacts.', progress('Rich answer-ready files', s.qa.pass, richAnswerNeeded, 'good', fmt(s.qa.metadataOnlyExpected) + ' files are intentionally metadata-only and already counted as handled in overall progress.')),
      ].join('');
    }

    function phase(title, desc, body) {
      return '<div class="phase"><div class="phase-head"><div><h3>' + escapeHtml(title) + '</h3><div class="phase-note">' + escapeHtml(desc) + '</div></div></div>' + body + '</div>';
    }

    function countLabel(rows, label) {
      const row = rows.find((candidate) => candidate.label === label);
      return row ? row.count : 0;
    }

    function countAny(rows, labels) {
      return rows.filter((row) => labels.includes(row.label)).reduce((sum, row) => sum + row.count, 0);
    }

    function render(state) {
      const s = state.latest;
      if (!s) {
        pill.className = 'pill warn';
        pill.textContent = state.error ? 'Poll error' : 'Collecting';
        app.innerHTML = '<section class="section"><div class="panel">' + escapeHtml(state.error || 'Collecting first private-host sample...') + '</div></section>';
        return;
      }

      const p = state.progress;
      const totalFiles = s.qa.totalItems || s.counts.files;
      const richAnswerNeeded = richAnswerDenominator(s, totalFiles);
      const venicePause = activeProviderPause(s, 'venice');
      const healthTone = state.error ? 'warn' : s.sourceWorker.health === 'healthy' && s.drainWorkers.active > 0 ? 'good' : 'warn';
      pill.className = 'pill ' + healthTone;
      pill.textContent = state.error ? 'Stale' : healthTone === 'good' ? 'Live' : 'Attention';

      const recentHint = p ? p.windowLabel + ', baseline ' + ageLabel(p.baselineSampledAt) : 'collecting';
      const fullFiles = Math.max(totalFiles, fullCorpusFiles(s));
      const fullFolders = fullCorpusFolders(s);
      const fileTypes = s.aggregates ? s.aggregates.fileTypes.slice(0, 8) : [];
      const jobStatuses = s.aggregates ? s.aggregates.jobStatuses.slice(0, 8) : [];
      const fileSamples = s.aggregates ? s.aggregates.fileSamples : [];
      const jobStatusComposition = jobStatuses.length ? donut('All extraction jobs by status', jobStatuses.map((row) => ({
        label: row.label,
        value: row.count,
        tone: statusTone(row.label),
      })), fmt(s.counts.extractionJobs), 'jobs', 'This is a composition of job states, not a progress meter.') : '<p class="muted">No aggregate job-status data yet.</p>';
	      const timeline = state.history.slice(-12).reverse().map((sample) =>
	        '<div class="timeline-row"><strong>' + escapeHtml(ageLabel(sample.sampledAt)) + '</strong><span>queued ' + escapeHtml(fmt(sample.counts.queued)) + '</span><span>current ' + escapeHtml(fmt(currentLeaseCount(sample))) + '</span><span>stale ' + escapeHtml(fmt(staleLeaseCount(sample))) + '</span><span>QA pass ' + escapeHtml(fmt(sample.qa.pass)) + '</span><span>workers ' + escapeHtml(fmt(sample.drainWorkers.active)) + '</span></div>'
	      ).join('');

      app.innerHTML =
        overallProgress(state) +
        '<div class="grid summary-grid">' +
          card('Rich Answer Ready', fmt(s.qa.pass) + ' / ' + fmt(richAnswerNeeded), pctLabel(s.qa.pass, richAnswerNeeded) + ' of files needing rich text/artifacts are ready. Metadata-only policy rows count in overall progress.') +
          card('Active Scope Files', fmt(s.counts.files), 'Historical/broad Dropbox scopes are excluded from the main denominator.') +
          card('Full Corpus Discovery', fmt(fullFiles) + ' files', fmt(fullFolders) + ' folders discovered across Dropbox; this denominator can grow during metadata sync.') +
	          card('Actionable Queue', fmt(actionableQueueRemaining(s)), actionableQueueRemaining(s) === 0 ? 'Active extraction queue is clear. Raw queue: ' + fmt(queueRemaining(s)) + ' historical, superseded, stale-scope, or policy-excluded rows.' : fmt(s.counts.queuedActionable) + ' actionable queued, ' + fmt(actionableCurrentLeaseCount(s)) + ' actionable current leases, ' + fmt(actionableStaleLeaseCount(s)) + ' actionable stale leases, ' + fmt(s.counts.failedActionable) + ' actionable failed. Raw queue: ' + fmt(queueRemaining(s)) + ' including superseded/excluded.') +
          card('Workers Functioning', fmt(s.drainWorkers.active), fmt(s.drainWorkers.total) + ' drain units tracked; ' + fmt(s.ocrHelpers.active) + ' OCR helper processes active; source worker ' + s.sourceWorker.health + '.') +
          card('Current Throughput', queueThroughputLabel(p?.ratesPerHour.queueDrain, actionableQueueRemaining(s)), queueEtaHint(s, p)) +
          card('Venice Credits', veniceCreditLabel(s.veniceCreditStatus), veniceCreditHint(s.veniceCreditStatus)) +
          card('Last Sample', ageLabel(s.sampledAt), 'Private-host status generated ' + ageLabel(s.statusGeneratedAt) + '.') +
        '</div>' +
        bottleneckPanel(state) +
        liveFileProgress(fileSamples) +
        (state.error ? '<section class="section"><div class="panel warning">Latest poll failed, so this page is showing the last successful sample and will keep retrying. ' + escapeHtml(state.error) + '</div></section>' : '') +
        (venicePause ? '<section class="section compact"><div class="panel error">Venice escalation paused: ' + escapeHtml(venicePause.message || 'provider credit/payment exhaustion') + '</div></section>' : '') +
        '<section class="section grid product-picture">' +
          '<div class="panel"><h2>Operator Focus</h2><p class="subtitle">What needs attention right now, with the pipeline map kept compact underneath.</p>' + operatorFocus(state) + pipelineMap() + '</div>' +
          '<div class="panel"><h2>Throughput Pulse</h2><p class="subtitle">' + escapeHtml(recentHint) + '</p>' + throughputPulse(state) + '<div class="grid recent-grid">' +
            mini('queue remaining delta', fmtDelta(p?.deltas.queueRemaining), p?.deltas.queueRemaining <= 0 ? 'good' : 'warn') +
            mini('artifacts produced', fmtDelta(p?.deltas.artifacts), p?.deltas.artifacts >= 0 ? 'info' : 'warn') +
            mini('QA pass delta', fmtDelta(p?.deltas.qaPass), p?.deltas.qaPass >= 0 ? 'good' : 'warn') +
            mini('embedded chunks delta', fmtDelta(p?.deltas.embeddedChunks), p?.deltas.embeddedChunks >= 0 ? 'good' : 'warn') +
            mini('Venice jobs delta', fmtDelta(p?.deltas.veniceJobsPlanned), p?.deltas.veniceJobsPlanned > 0 ? 'review' : 'info') +
            mini('Venice complete delta', fmtDelta(p?.deltas.veniceJobsCompleted), p?.deltas.veniceJobsCompleted > 0 ? 'good' : 'info') +
          '</div></div>' +
        '</section>' +
        '<section class="section"><h2>Phase Monitors</h2><div class="grid phase-grid">' + phaseCards(state) + '</div></section>' +
        '<section class="section"><h2>Workers And Blockers</h2><div class="panel grid worker-grid">' +
          mini('active drain workers', fmt(s.drainWorkers.active), s.drainWorkers.active > 0 ? 'good' : 'danger') +
	          mini('current job leases', fmt(currentLeaseCount(s)), currentLeaseCount(s) > 0 ? 'info' : 'warn') +
	          mini('stale job leases', fmt(staleLeaseCount(s)), staleLeaseCount(s) === 0 ? 'good' : 'danger') +
	          mini('failed jobs', fmt(s.counts.failed), s.counts.failed === 0 ? 'good' : 'danger') +
          mini('blocked jobs', fmt(s.counts.blocked), s.counts.blocked === 0 ? 'good' : 'warn') +
          mini('source worker', (s.sourceWorker.activeState || 'unknown') + '/' + (s.sourceWorker.subState || 'unknown'), s.sourceWorker.health === 'healthy' ? 'good' : 'warn') +
          mini('worker memory', bytes(s.sourceWorker.memoryCurrentBytes), 'info') +
          mini('policy blocked', fmt(s.qa.blockedPolicy), s.qa.blockedPolicy === 0 ? 'good' : 'warn') +
          mini('operator failures', fmt(s.qa.failedNeedsOperator), s.qa.failedNeedsOperator === 0 ? 'good' : 'danger') +
	        '</div><p class="subtitle">A current lease is still inside its claim window. A stale lease has expired; it should be reclaimed, retried, or explained by a live worker heartbeat before we call it active work.</p>' + (s.aggregateError ? '<p class="error">Aggregate lane counts unavailable: ' + escapeHtml(s.aggregateError) + '</p>' : '') + '</section>' +
        '<section class="section grid two-col"><div class="panel"><h2>File Types</h2>' + (fileTypes.length ? barRows(fileTypes) : '<p class="muted">No aggregate file-type data yet.</p>') + '</div><div class="panel"><h2>Job Status Mix</h2>' + jobStatusComposition + '</div></section>' +
	        '<section class="section"><div class="panel"><h2>Last Samples</h2><div class="timeline"><div class="timeline-row muted"><strong>sample</strong><span>queued</span><span>current</span><span>stale</span><span>QA pass</span><span>workers</span></div>' + timeline + '</div></div></section>';
    }

    function bytes(value) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a';
      const n = Number(value);
      if (n < 1024) return fmt(n) + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
      return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    function activeProviderPause(s, kind) {
      return (s.providerPauses || []).find((pause) => pause.active && pause.kind === kind) || null;
    }

    function veniceCreditExhaustedJobs(venice) {
      return (venice.errorKindStatuses || [])
        .filter((row) => String(row.label || '').startsWith('venice_http_402:'))
        .reduce((sum, row) => sum + Number(row.count || 0), 0);
    }

    function veniceCreditCurrentlyAvailable(credit) {
      return Boolean(credit && credit.status === 'ok' && credit.canConsume !== false);
    }

    function veniceCreditLabel(credit) {
      if (!credit) return 'not monitored';
      if (credit.status === 'ok') return credit.canConsume === false ? 'exhausted' : 'available';
      if (credit.status === 'credit_exhausted') return 'exhausted';
      if (credit.status === 'auth_failed') return 'auth failed';
      if (credit.status === 'not_configured') return 'not configured';
      if (credit.status === 'rate_limited') return 'rate limited';
      return 'unavailable';
    }

    function veniceCreditTone(credit) {
      if (!credit) return 'warn';
      if (credit.status === 'ok' && credit.canConsume !== false) return 'good';
      if (credit.status === 'credit_exhausted' || credit.canConsume === false || credit.status === 'auth_failed') return 'danger';
      return 'warn';
    }

    function veniceCreditBalance(credit, key) {
      if (!credit || !credit.balances || credit.balances[key] === undefined) return 'n/a';
      const value = Number(credit.balances[key]);
      return key === 'usd' ? '$' + value.toFixed(2) : value.toFixed(2);
    }

    function veniceCreditHint(credit) {
      if (!credit) return 'No Venice billing report has been written yet.';
      const checked = credit.generatedAt ? ' Checked ' + ageLabel(credit.generatedAt) + '.' : '';
      if (credit.status === 'ok' && credit.canConsume !== false) {
        return 'Billing balance says Venice can consume. Pause marker still controls whether escalation is allowed.' + checked;
      }
      if (credit.status === 'credit_exhausted' || credit.canConsume === false) {
        return 'Billing balance says Venice cannot consume; keep escalation paused until credits are refilled.' + checked;
      }
      if (credit.status === 'auth_failed') return 'Billing balance rejected the Venice API key; repair credential before resuming.' + checked;
      if (credit.status === 'not_configured') return 'Credit monitor has no Venice API key configured in the runtime wrapper.' + checked;
      return 'Billing balance probe is not currently healthy; keep the last known provider pause state.' + checked;
    }

    async function refresh() {
      try {
        const response = await fetch('/api/state', { cache: 'no-store' });
        if (!response.ok) throw new Error('state request failed: ' + response.status);
        render(await response.json());
      } catch (error) {
        pill.className = 'pill danger';
        pill.textContent = 'Disconnected';
        app.innerHTML = '<section class="section"><div class="panel error">' + escapeHtml(error.message || String(error)) + '</div></section>';
      }
    }

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

export async function fetchLiveSnapshot(options: {
  sshTarget: string;
  corpusId: string;
  activeScopeKeys: string[];
  remoteDbPath: string | null;
  commandTimeoutMs: number;
}): Promise<LiveIngestionSnapshot> {
  const remoteScript = buildRemoteProbeScript(options.corpusId, options.remoteDbPath, options.activeScopeKeys);
  const stdout = await runCommand(['ssh', options.sshTarget, remoteScript], options.commandTimeoutMs);
  return normalizeRemoteProbe(JSON.parse(stdout) as RawRemoteProbe, options.corpusId);
}

export async function startLiveDashboardServer(options: LiveDashboardServerOptions): Promise<void> {
  let history = loadHistory(options.historyPath);
  let error: string | null = null;
  let lastStartedAt: string | null = null;
  let lastCompletedAt: string | null = null;
  let skippedPolls = 0;
  let polling = false;

  const poll = async () => {
    if (polling) {
      skippedPolls += 1;
      return;
    }
    polling = true;
    lastStartedAt = new Date().toISOString();
    try {
      const snapshot = await fetchLiveSnapshot({
        sshTarget: options.sshTarget,
        corpusId: options.corpusId,
        activeScopeKeys: options.activeScopeKeys,
        remoteDbPath: options.remoteDbPath,
        commandTimeoutMs: options.commandTimeoutMs,
      });
      error = null;
      lastCompletedAt = new Date().toISOString();
      history = appendHistory(history, snapshot, new Date());
      saveHistory(options.historyPath, history);
    } catch (caught) {
      const rawError = caught instanceof Error ? caught.message : String(caught);
      console.warn(`[source-ingestion-live-dashboard] poll failed: ${rawError}`);
      error = publicPollErrorMessage(rawError);
      lastCompletedAt = new Date().toISOString();
    } finally {
      polling = false;
    }
  };

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/state') {
        return Response.json(buildLiveDashboardState(history, {
          intervalSeconds: options.pollSeconds,
          error,
          lastStartedAt,
          lastCompletedAt,
          skippedPolls,
        }));
      }
      if (url.pathname === '/') {
        return new Response(renderLiveDashboardHtml(), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      }
      return new Response('Not found', { status: 404 });
    },
  });

  console.log(JSON.stringify({
    kind: 'source_ingestion_live_dashboard',
    url: `http://${options.host}:${server.port}/`,
    ssh_target: options.sshTarget,
    active_scope_keys: options.activeScopeKeys,
    poll_seconds: options.pollSeconds,
    history_path: options.historyPath,
  }, null, 2));

  await poll();
  setInterval(() => {
    void poll();
  }, options.pollSeconds * 1000);
}

export function buildRemoteProbeScript(
  corpusId: string,
  remoteDbPath: string | null,
  activeScopeKeys: string[] = DEFAULT_ACTIVE_SCOPE_KEYS,
): string {
  const corpusJson = JSON.stringify(corpusId);
  const dbPathJson = JSON.stringify(remoteDbPath);
  const activeScopeKeysJson = JSON.stringify(activeScopeKeys.map((scope) => scope.trim()).filter(Boolean));
  // The probe's active scopes ARE the content-lane policy — the same list the
  // supervisor and the embedding drain are launched against — so the ladder's
  // scope rung is derived from them rather than configured a second time here.
  // A probe pointed at one folder therefore scores that folder's files exactly
  // as the worker does for the same scope.
  const contentScopePathPrefixes = dropboxContentScopePathPrefixes(activeScopeKeys);
  return `python3 - <<'PY'
import datetime
import hashlib
import json
import os
import shlex
import sqlite3
import subprocess
import time

CORPUS_ID = json.loads(${JSON.stringify(corpusJson)})
DB_PATH = json.loads(${JSON.stringify(dbPathJson)})
ACTIVE_SCOPE_KEYS = json.loads(${JSON.stringify(activeScopeKeysJson)})
PROVIDER = "dropbox"
MAX_FRONTIER_RETRY_COUNT = 3
ACTIVE_SYNC_STALE_SECONDS = 30 * 60
SOURCE_STATUS_TIMEOUT_SECONDS = 25
SQLITE_STATUS_DEADLINE_SECONDS = 12
SQLITE_FAST_STATUS_DEADLINE_SECONDS = 5
SQLITE_AGGREGATE_DEADLINE_SECONDS = 12
SQLITE_FAST_AGGREGATE_DEADLINE_SECONDS = 5
ENABLE_RICH_AGGREGATES = os.environ.get("OLYMPUS_LIVE_DASHBOARD_RICH_AGGREGATES", "") == "1"
VENICE_CREDIT_STATUS_FILE = "/tmp/olympus-source-processing-supervisor/venice-credit-status.json"
PROVIDER_PAUSE_FILES = [
    "/tmp/olympus-source-processing-supervisor-venice-paused.json",
]
WORKER_AUTH_TOKEN = os.environ.get("OLYMPUS_WORKER_AUTH_TOKEN", "").strip()

def run(args, input_text=None, timeout=20):
    completed = subprocess.run(
        args,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=True,
    )
    return completed.stdout

def curl_config_value(value):
    return json.dumps(str(value))

def curl_json(config_lines, body=None, timeout=20, include_worker_auth=False):
    config = "fail\\nshow-error\\nsilent\\n"
    for line in config_lines:
        config += line + "\\n"
    if include_worker_auth and WORKER_AUTH_TOKEN:
        config += "header = " + curl_config_value("Authorization: Bearer " + WORKER_AUTH_TOKEN) + "\\n"
    if body is not None:
        config += "data = " + curl_config_value(body) + "\\n"
    return run(["curl", "-K", "-"], input_text=config, timeout=timeout)

def safe_error(exc):
    text = str(exc)
    if len(text) > 500:
        return text[:500] + "...truncated"
    return text

def source_worker_env():
    try:
        text = run(["systemctl", "--user", "show", "olympus-email-source.service", "-p", "Environment", "--value"], timeout=10)
    except Exception:
        return {}
    env = {}
    try:
        for item in shlex.split(text):
            if "=" in item:
                key, value = item.split("=", 1)
                env[key] = value
    except ValueError:
        return {}
    return env

SOURCE_WORKER_ENV = source_worker_env()
CONTENT_EXCLUDE_PREFIXES = [
    item.strip().lower()
    for item in SOURCE_WORKER_ENV.get("OLYMPUS_SOURCE_INDEX_DROPBOX_CONTENT_EXCLUDE_PREFIXES", "").split("||")
    if item.strip()
]

out = {"sampled_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")}

def merge_status_counts(status, extra_counts):
    if not isinstance(status, dict) or not isinstance(extra_counts, dict):
        return status
    corpora = status.get("corpora")
    if not isinstance(corpora, list):
        return status
    target = None
    for corpus in corpora:
        if isinstance(corpus, dict) and corpus.get("corpus_id") == CORPUS_ID:
            target = corpus
            break
    if target is None and corpora and isinstance(corpora[0], dict):
        target = corpora[0]
    if target is None:
        return status
    counts = target.get("counts")
    if not isinstance(counts, dict):
        counts = {}
    counts.update(extra_counts)
    target["counts"] = counts
    return status

def provider_pauses():
    pauses = []
    for path in PROVIDER_PAUSE_FILES:
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as handle:
            record = json.load(handle)
        if not isinstance(record, dict) or record.get("active") is False:
            continue
        error_kind = record.get("error_kind")
        pauses.append({
            "active": True,
            "kind": record.get("kind") or ("venice" if isinstance(error_kind, str) and error_kind.startswith("venice_") else "provider"),
            "reason": record.get("reason") or "provider_pause",
            "error_kind": error_kind,
            "created_at": record.get("created_at"),
            "message": record.get("message"),
        })
    return pauses

try:
    out["provider_pauses"] = provider_pauses()
except Exception as exc:
    out["provider_pauses_error"] = safe_error(exc)

try:
    if os.path.exists(VENICE_CREDIT_STATUS_FILE):
        with open(VENICE_CREDIT_STATUS_FILE, "r", encoding="utf-8") as handle:
            credit_status = json.load(handle)
        if isinstance(credit_status, dict):
            out["venice_credit_status"] = credit_status
except Exception as exc:
    out["venice_credit_status_error"] = safe_error(exc)

def rows(con, sql, params=()):
    return [dict(row) for row in con.execute(sql, params).fetchall()]

def scalar(con, sql, params=()):
    row = con.execute(sql, params).fetchone()
    return int(row[0] or 0) if row else 0

def scope_predicate(column):
    if not ACTIVE_SCOPE_KEYS:
        return "1=1", ()
    placeholders = ",".join("?" for _ in ACTIVE_SCOPE_KEYS)
    return f"{column} IN ({placeholders})", tuple(ACTIVE_SCOPE_KEYS)

def active_root_paths():
    roots = []
    for scope in ACTIVE_SCOPE_KEYS:
        _, _, path = str(scope).partition(":")
        path = path.strip().lower().rstrip("/")
        if path and path not in roots:
            roots.append(path)
    return roots

ACTIVE_ROOT_PATHS = active_root_paths()

def active_path_predicate(column):
    if not ACTIVE_ROOT_PATHS:
        return "1=1", ()
    checks = []
    params = []
    for path in ACTIVE_ROOT_PATHS:
        checks.append(f"LOWER(COALESCE({column}, '')) = ?")
        params.append(path)
        checks.append(f"LOWER(COALESCE({column}, '')) LIKE ?")
        params.append(path + "/%")
    return "(" + " OR ".join(checks) + ")", tuple(params)

def archive_path_predicate(column):
    return (
        "("
        f"LOWER(COALESCE({column}, '')) = '/4 archive'"
        f" OR LOWER(COALESCE({column}, '')) LIKE '/4 archive/%'"
        f" OR LOWER(COALESCE({column}, '')) = '/archive'"
        f" OR LOWER(COALESCE({column}, '')) LIKE '/archive/%'"
        ")"
    )

def inventory_bucket_case(column):
    active_sql, active_params = active_path_predicate(column)
    archive_sql = archive_path_predicate(column)
    return (
        f"CASE WHEN {active_sql} THEN 'Active ingestion roots' "
        f"WHEN {archive_sql} THEN 'Archive/global inventory' "
        "ELSE 'Other indexed scopes' END",
        active_params,
    )

def local_success_sql(alias="j"):
    return f"""
      EXISTS (
        SELECT 1
        FROM content_extraction_jobs sj
        WHERE sj.local_entry_id = {alias}.local_entry_id
          AND sj.job_id <> {alias}.job_id
          AND sj.extractor_kind NOT LIKE 'venice_%'
          AND sj.status = 'indexed'
      )
    """

def stale_scope_sql(alias="j", entry_alias="e"):
    return f"{alias}.approved_scope_key <> {entry_alias}.approved_scope_key"

# The store's staleness predicate, kept identical to
# staleRevisionExtractionSql in src/workers/dropbox-files/local-index.ts:
# an extraction indexed against bytes the file no longer has, and none
# indexed against the bytes it has now. The second half alone would flag
# every entry whose text arrived with the sync item and never had a job.
# Two "?" placeholders, both PROVIDER, in the order they appear.
def stale_revision_extraction_sql(entry_alias="e"):
    return f"""
      EXISTS (
        SELECT 1
        FROM content_extraction_jobs oj
        WHERE oj.provider = ?
          AND oj.local_entry_id = {entry_alias}.local_entry_id
          AND oj.status = 'indexed'
          AND (
            COALESCE(oj.revision, '') <> COALESCE({entry_alias}.revision, '')
            OR COALESCE(oj.content_hash, '') <> COALESCE({entry_alias}.content_hash, '')
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM content_extraction_jobs cj
        WHERE cj.provider = ?
          AND cj.local_entry_id = {entry_alias}.local_entry_id
          AND cj.status = 'indexed'
          AND COALESCE(cj.revision, '') = COALESCE({entry_alias}.revision, '')
          AND COALESCE(cj.content_hash, '') = COALESCE({entry_alias}.content_hash, '')
      )
    """

def source_worker_status():
    body = json.dumps({"corpus_id": CORPUS_ID, "include_items": False})
    status_text = curl_json([
        "max-time = " + str(SOURCE_STATUS_TIMEOUT_SECONDS),
        "request = " + curl_config_value("POST"),
        "header = " + curl_config_value("Content-Type: application/json"),
        "url = " + curl_config_value("http://127.0.0.1:8010/v1/source/index/status"),
    ], body=body, timeout=SOURCE_STATUS_TIMEOUT_SECONDS + 5, include_worker_auth=True)
    return json.loads(status_text)

def install_sqlite_deadline(con, seconds):
    deadline = time.monotonic() + seconds
    def progress_handler():
        return 1 if time.monotonic() > deadline else 0
    con.set_progress_handler(progress_handler, 20000)

def qa_counts(con):
    entry_scope_sql, entry_scope_params = active_path_predicate("e.path_lower")
    row = con.execute(f"""
      WITH
        chunk_summary AS (
          SELECT
            local_entry_id,
            COUNT(*) AS chunk_count,
            SUM(LENGTH(TRIM(bounded_text))) AS chunk_text_chars
          FROM content_chunks_secure_local
          GROUP BY local_entry_id
        ),
        artifact_summary AS (
          SELECT
            local_entry_id,
            COUNT(*) AS artifact_count,
            SUM(CASE WHEN bounded_text IS NOT NULL AND LENGTH(TRIM(bounded_text)) > 0 THEN 1 ELSE 0 END) AS artifact_text_count,
            SUM(CASE WHEN bounded_text IS NOT NULL THEN LENGTH(TRIM(bounded_text)) ELSE 0 END) AS artifact_text_chars,
            MIN(confidence) AS min_artifact_confidence,
            GROUP_CONCAT(DISTINCT artifact_kind) AS artifact_kinds,
            GROUP_CONCAT(COALESCE(warnings_json, ''), char(10)) AS artifact_warnings_json
          FROM content_artifacts_secure_local
          GROUP BY local_entry_id
        ),
        fact_summary AS (
          SELECT
            local_entry_id,
            COUNT(*) AS fact_count,
            MIN(confidence) AS min_fact_confidence
          FROM content_facts_secure_local
          GROUP BY local_entry_id
        ),
        job_summary AS (
          SELECT
            local_entry_id,
            SUM(CASE WHEN status = 'blocked_policy' THEN 1 ELSE 0 END) AS blocked_policy_jobs,
            SUM(CASE WHEN status = 'failed_retryable' THEN 1 ELSE 0 END) AS failed_retryable_jobs,
            SUM(CASE WHEN status = 'failed_terminal' THEN 1 ELSE 0 END) AS failed_terminal_jobs,
            SUM(CASE WHEN status IN ('queued', 'leased') THEN 1 ELSE 0 END) AS pending_jobs
          FROM content_extraction_jobs
          WHERE provider = ?
          GROUP BY local_entry_id
        ),
        ledger AS (
          SELECT
            e.extraction_status,
            e.extraction_completeness,
            lower(COALESCE(e.mime_type, '')) AS mime_type_lower,
            lower(COALESCE(e.path_display, e.path_lower, e.name, '')) AS path_lower,
            e.size_bytes,
            COALESCE(ch.chunk_count, 0) AS chunk_count,
            MAX(COALESCE(ch.chunk_text_chars, 0), COALESCE(ar.artifact_text_chars, 0)) AS text_char_count,
            COALESCE(ar.artifact_count, 0) AS artifact_count,
            COALESCE(ar.artifact_text_count, 0) AS artifact_text_count,
            COALESCE(f.fact_count, 0) AS fact_count,
            COALESCE(j.blocked_policy_jobs, 0) AS blocked_policy_jobs,
            COALESCE(j.failed_retryable_jobs, 0) AS failed_retryable_jobs,
            COALESCE(j.failed_terminal_jobs, 0) AS failed_terminal_jobs,
            COALESCE(j.pending_jobs, 0) AS pending_jobs,
            ${dropboxLocalVlmPdfIndexedJobsSql('e')} AS local_vlm_pdf_indexed_jobs,
            CASE WHEN {stale_revision_extraction_sql("e")} THEN 1 ELSE 0 END AS stale_revision_extraction,
            COALESCE(ar.artifact_warnings_json, '') AS warning_blob,
            COALESCE(ar.artifact_kinds, '') AS artifact_kinds,
            CASE
              WHEN ar.min_artifact_confidence IS NULL THEN f.min_fact_confidence
              WHEN f.min_fact_confidence IS NULL THEN ar.min_artifact_confidence
              WHEN ar.min_artifact_confidence < f.min_fact_confidence THEN ar.min_artifact_confidence
              ELSE f.min_fact_confidence
            END AS min_confidence,
            ${minimumUsefulExtractionCharsSql('e')} AS minimum_useful_chars
          FROM entries e
          LEFT JOIN chunk_summary ch ON ch.local_entry_id = e.local_entry_id
          LEFT JOIN artifact_summary ar ON ar.local_entry_id = e.local_entry_id
          LEFT JOIN fact_summary f ON f.local_entry_id = e.local_entry_id
          LEFT JOIN job_summary j ON j.local_entry_id = e.local_entry_id
          WHERE e.entry_type = 'file' AND e.tombstoned = 0 AND {entry_scope_sql}
        ),
        verdicts AS (
          SELECT
            mime_type_lower,
            path_lower,
            size_bytes,
            ${dropboxQaVerdictLadderSql(contentScopePathPrefixes)} AS qa_verdict
          FROM ledger
        )
      SELECT
        COUNT(*) AS qa_total_items,
        SUM(CASE WHEN qa_verdict = 'qa_pass' THEN 1 ELSE 0 END) AS qa_pass,
        SUM(CASE WHEN qa_verdict = 'qa_stale_revision' THEN 1 ELSE 0 END) AS qa_stale_revision,
        SUM(CASE WHEN qa_verdict = 'qa_partial_pages_gap' THEN 1 ELSE 0 END) AS qa_partial_pages_gap,
        SUM(CASE WHEN qa_verdict = 'qa_metadata_only_expected' THEN 1 ELSE 0 END) AS qa_metadata_only_expected,
        SUM(CASE WHEN qa_verdict = 'qa_metadata_only_gap' THEN 1 ELSE 0 END) AS qa_metadata_only_gap,
        SUM(CASE WHEN qa_verdict = 'qa_metadata_only_gap' AND (
          mime_type_lower LIKE 'text/%'
          OR mime_type_lower = 'application/pdf'
          OR mime_type_lower IN ('application/json', 'application/xml', 'application/rtf', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint')
          OR mime_type_lower LIKE '%csv%'
          OR mime_type_lower LIKE '%spreadsheet%'
          OR mime_type_lower LIKE '%excel%'
          OR mime_type_lower LIKE '%wordprocessingml%'
          OR mime_type_lower LIKE '%presentationml%'
          OR path_lower LIKE '%.csv'
          OR path_lower LIKE '%.doc'
          OR path_lower LIKE '%.docx'
          OR path_lower LIKE '%.json'
          OR path_lower LIKE '%.md'
          OR path_lower LIKE '%.markdown'
          OR path_lower LIKE '%.pdf'
          OR path_lower LIKE '%.ppt'
          OR path_lower LIKE '%.pptx'
          OR path_lower LIKE '%.rtf'
          OR path_lower LIKE '%.txt'
          OR path_lower LIKE '%.xls'
          OR path_lower LIKE '%.xlsx'
          OR path_lower LIKE '%.xml'
        ) THEN 1 ELSE 0 END) AS qa_metadata_only_gap_likely_needs_extraction,
        SUM(CASE WHEN qa_verdict = 'qa_metadata_only_gap'
          AND NOT (
            mime_type_lower LIKE 'text/%'
            OR mime_type_lower = 'application/pdf'
            OR mime_type_lower IN ('application/json', 'application/xml', 'application/rtf', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint')
            OR mime_type_lower LIKE '%csv%'
            OR mime_type_lower LIKE '%spreadsheet%'
            OR mime_type_lower LIKE '%excel%'
            OR mime_type_lower LIKE '%wordprocessingml%'
            OR mime_type_lower LIKE '%presentationml%'
            OR path_lower LIKE '%.csv'
            OR path_lower LIKE '%.doc'
            OR path_lower LIKE '%.docx'
            OR path_lower LIKE '%.json'
            OR path_lower LIKE '%.md'
            OR path_lower LIKE '%.markdown'
            OR path_lower LIKE '%.pdf'
            OR path_lower LIKE '%.ppt'
            OR path_lower LIKE '%.pptx'
            OR path_lower LIKE '%.rtf'
            OR path_lower LIKE '%.txt'
            OR path_lower LIKE '%.xls'
            OR path_lower LIKE '%.xlsx'
            OR path_lower LIKE '%.xml'
          )
          AND (
            mime_type_lower LIKE 'audio/%'
            OR mime_type_lower LIKE 'image/%'
            OR mime_type_lower LIKE 'video/%'
            OR path_lower LIKE '%.3gp'
            OR path_lower LIKE '%.avi'
            OR path_lower LIKE '%.bmp'
            OR path_lower LIKE '%.gif'
            OR path_lower LIKE '%.heic'
            OR path_lower LIKE '%.heif'
            OR path_lower LIKE '%.jpeg'
            OR path_lower LIKE '%.jpg'
            OR path_lower LIKE '%.m4a'
            OR path_lower LIKE '%.m4v'
            OR path_lower LIKE '%.mov'
            OR path_lower LIKE '%.mp3'
            OR path_lower LIKE '%.mp4'
            OR path_lower LIKE '%.mpeg'
            OR path_lower LIKE '%.mpg'
            OR path_lower LIKE '%.png'
            OR path_lower LIKE '%.tif'
            OR path_lower LIKE '%.tiff'
            OR path_lower LIKE '%.wav'
            OR path_lower LIKE '%.webm'
            OR path_lower LIKE '%.webp'
            OR path_lower LIKE '%.zip'
            OR path_lower LIKE '%/archive/%'
            OR path_lower LIKE '%/audio/%'
            OR path_lower LIKE '%/audiobooks/%'
            OR path_lower LIKE '%/book library/%'
            OR path_lower LIKE '%/books/%'
            OR path_lower LIKE '%/calibre library/%'
            OR path_lower LIKE '%/e-books/%'
            OR path_lower LIKE '%/ebooks/%'
            OR path_lower LIKE '%/kindle/%'
            OR path_lower LIKE '%/photos/%'
            OR path_lower LIKE '%/pictures/%'
            OR path_lower LIKE '%/videos/%'
            OR (size_bytes IS NOT NULL AND size_bytes > 100000000)
          )
        THEN 1 ELSE 0 END) AS qa_metadata_only_gap_likely_deferred_metadata_only,
        SUM(CASE WHEN qa_verdict = 'qa_metadata_only_gap'
          AND NOT (
            mime_type_lower LIKE 'text/%'
            OR mime_type_lower = 'application/pdf'
            OR mime_type_lower IN ('application/json', 'application/xml', 'application/rtf', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint')
            OR mime_type_lower LIKE '%csv%'
            OR mime_type_lower LIKE '%spreadsheet%'
            OR mime_type_lower LIKE '%excel%'
            OR mime_type_lower LIKE '%wordprocessingml%'
            OR mime_type_lower LIKE '%presentationml%'
            OR path_lower LIKE '%.csv'
            OR path_lower LIKE '%.doc'
            OR path_lower LIKE '%.docx'
            OR path_lower LIKE '%.json'
            OR path_lower LIKE '%.md'
            OR path_lower LIKE '%.markdown'
            OR path_lower LIKE '%.pdf'
            OR path_lower LIKE '%.ppt'
            OR path_lower LIKE '%.pptx'
            OR path_lower LIKE '%.rtf'
            OR path_lower LIKE '%.txt'
            OR path_lower LIKE '%.xls'
            OR path_lower LIKE '%.xlsx'
            OR path_lower LIKE '%.xml'
          )
          AND NOT (
            mime_type_lower LIKE 'audio/%'
            OR mime_type_lower LIKE 'image/%'
            OR mime_type_lower LIKE 'video/%'
            OR path_lower LIKE '%.3gp'
            OR path_lower LIKE '%.avi'
            OR path_lower LIKE '%.bmp'
            OR path_lower LIKE '%.gif'
            OR path_lower LIKE '%.heic'
            OR path_lower LIKE '%.heif'
            OR path_lower LIKE '%.jpeg'
            OR path_lower LIKE '%.jpg'
            OR path_lower LIKE '%.m4a'
            OR path_lower LIKE '%.m4v'
            OR path_lower LIKE '%.mov'
            OR path_lower LIKE '%.mp3'
            OR path_lower LIKE '%.mp4'
            OR path_lower LIKE '%.mpeg'
            OR path_lower LIKE '%.mpg'
            OR path_lower LIKE '%.png'
            OR path_lower LIKE '%.tif'
            OR path_lower LIKE '%.tiff'
            OR path_lower LIKE '%.wav'
            OR path_lower LIKE '%.webm'
            OR path_lower LIKE '%.webp'
            OR path_lower LIKE '%.zip'
            OR path_lower LIKE '%/archive/%'
            OR path_lower LIKE '%/audio/%'
            OR path_lower LIKE '%/audiobooks/%'
            OR path_lower LIKE '%/book library/%'
            OR path_lower LIKE '%/books/%'
            OR path_lower LIKE '%/calibre library/%'
            OR path_lower LIKE '%/e-books/%'
            OR path_lower LIKE '%/ebooks/%'
            OR path_lower LIKE '%/kindle/%'
            OR path_lower LIKE '%/photos/%'
            OR path_lower LIKE '%/pictures/%'
            OR path_lower LIKE '%/videos/%'
            OR (size_bytes IS NOT NULL AND size_bytes > 100000000)
          )
        THEN 1 ELSE 0 END) AS qa_metadata_only_gap_unknown_or_needs_policy,
        SUM(CASE WHEN qa_verdict = 'qa_raster_ocr_vlm_escalation' THEN 1 ELSE 0 END) AS qa_raster_ocr_vlm_escalation,
        SUM(CASE WHEN qa_verdict = 'qa_low_confidence_retry_local' THEN 1 ELSE 0 END) AS qa_low_confidence_retry_local,
        SUM(CASE WHEN qa_verdict = 'qa_low_confidence_candidate_for_venice' THEN 1 ELSE 0 END) AS qa_low_confidence_candidate_for_venice,
        SUM(CASE WHEN qa_verdict = 'qa_blocked_policy' THEN 1 ELSE 0 END) AS qa_blocked_policy,
        SUM(CASE WHEN qa_verdict = 'qa_out_of_content_scope' THEN 1 ELSE 0 END) AS qa_out_of_content_scope,
        SUM(CASE WHEN qa_verdict = 'qa_failed_needs_operator' THEN 1 ELSE 0 END) AS qa_failed_needs_operator,
        SUM(CASE WHEN qa_verdict = 'qa_pending' THEN 1 ELSE 0 END) AS qa_pending
      FROM verdicts
    """, (PROVIDER, PROVIDER, PROVIDER, PROVIDER, *entry_scope_params)).fetchone()
    counts = {key: int(row[key] or 0) for key in row.keys()}
    # qa_stale_revision stays out of this sum on purpose: the dashboard shows
    # it as its own needs-review reason, so adding it here would count one
    # document twice. Same rule as the store's own two copies of the sum.
    counts["qa_visible_gaps"] = (
        counts["qa_metadata_only_gap"]
        + counts["qa_raster_ocr_vlm_escalation"]
        + counts["qa_low_confidence_retry_local"]
        + counts["qa_low_confidence_candidate_for_venice"]
        + counts["qa_failed_needs_operator"]
    )
    counts["qa_low_confidence"] = (
        counts["qa_raster_ocr_vlm_escalation"]
        + counts["qa_low_confidence_retry_local"]
        + counts["qa_low_confidence_candidate_for_venice"]
    )
    # The three verdicts nothing is pending on, subtracted here exactly as the
    # store subtracts them in applyDerivedReadinessQaTotals. qa_out_of_content_scope
    # is deliberately absent from qa_visible_gaps above: no lane was ever
    # pointed at those files, so they are policy rather than review work.
    counts["qa_eligible_items"] = max(0, (
        counts["qa_total_items"]
        - counts["qa_metadata_only_expected"]
        - counts["qa_blocked_policy"]
        - counts["qa_out_of_content_scope"]
    ))
    return counts

def crawl_counts(con):
    counts = {
        "metadata_sync_folders_pending": 0,
        "metadata_sync_folders_visited": 0,
        "metadata_sync_folders_retryable_failed": 0,
        "metadata_sync_folders_exhausted_retry": 0,
        "metadata_sync_folders_blocked": 0,
        "metadata_sync_folders_failed": 0,
        "metadata_sync_folders_total": 0,
    }
    frontier_scope_sql, frontier_scope_params = scope_predicate("approved_scope_key")
    for row in con.execute(f"""
        SELECT status, retry_count, COUNT(*) AS count
        FROM crawl_frontier
        WHERE provider = ? AND {frontier_scope_sql}
        GROUP BY status, retry_count
    """, (PROVIDER, *frontier_scope_params)).fetchall():
        status = row["status"]
        count = int(row["count"] or 0)
        if status == "pending":
            counts["metadata_sync_folders_pending"] += count
        elif status == "visited":
            counts["metadata_sync_folders_visited"] += count
        elif status in ("retryable_failed", "failed"):
            counts["metadata_sync_folders_retryable_failed"] += count
            if int(row["retry_count"] or 0) >= MAX_FRONTIER_RETRY_COUNT:
                counts["metadata_sync_folders_exhausted_retry"] += count
        elif status == "blocked":
            counts["metadata_sync_folders_blocked"] += count
    counts["metadata_sync_folders_failed"] = (
        counts["metadata_sync_folders_retryable_failed"]
        + counts["metadata_sync_folders_blocked"]
    )
    counts["metadata_sync_folders_total"] = (
        counts["metadata_sync_folders_pending"]
        + counts["metadata_sync_folders_visited"]
        + counts["metadata_sync_folders_failed"]
    )
    return counts

def db_status_snapshot(con):
    entry_scope_sql, entry_scope_params = active_path_predicate("path_lower")
    entry_join_scope_sql, entry_join_scope_params = active_path_predicate("e.path_lower")
    job_alias_scope_sql, job_alias_scope_params = active_path_predicate("e.path_lower")
    excluded_entry_sql = content_exclusion_sql("e")
    stale_scope = stale_scope_sql("j", "e")
    sync_scope_sql, sync_scope_params = scope_predicate("approved_scope_key")
    proposal_scope_sql, proposal_scope_params = scope_predicate("approved_scope_key")
    counts = {
        "accounts": scalar(con, "SELECT COUNT(*) FROM accounts"),
        "files": scalar(con, f"SELECT COUNT(*) FROM entries WHERE entry_type = 'file' AND tombstoned = 0 AND {entry_scope_sql}", entry_scope_params),
        "folders": scalar(con, f"SELECT COUNT(*) FROM entries WHERE entry_type = 'folder' AND tombstoned = 0 AND {entry_scope_sql}", entry_scope_params),
        "tombstones": scalar(con, f"SELECT COUNT(*) FROM entries WHERE tombstoned = 1 AND {entry_scope_sql}", entry_scope_params),
        "chunks": scalar(con, f"SELECT COUNT(*) FROM content_chunks_secure_local c JOIN entries e ON e.local_entry_id = c.local_entry_id WHERE e.tombstoned = 0 AND {entry_join_scope_sql}", entry_join_scope_params),
        "secure_local_chunks": scalar(con, f"SELECT COUNT(*) FROM content_chunks_secure_local c JOIN entries e ON e.local_entry_id = c.local_entry_id WHERE e.tombstoned = 0 AND {entry_join_scope_sql}", entry_join_scope_params),
        "extraction_artifacts": scalar(con, f"SELECT COUNT(*) FROM content_artifacts_secure_local ar JOIN entries e ON e.local_entry_id = ar.local_entry_id WHERE e.tombstoned = 0 AND {entry_join_scope_sql}", entry_join_scope_params),
        "document_facts": scalar(con, f"SELECT COUNT(*) FROM content_facts_secure_local f JOIN entries e ON e.local_entry_id = f.local_entry_id WHERE e.tombstoned = 0 AND {entry_join_scope_sql}", entry_join_scope_params),
        "content_classifications": scalar(con, f"SELECT COUNT(*) FROM content_classifications_secure_local cls JOIN entries e ON e.local_entry_id = cls.local_entry_id WHERE e.tombstoned = 0 AND cls.active = 1 AND {entry_join_scope_sql}", entry_join_scope_params),
        "content_policy_findings": scalar(con, f"SELECT COUNT(*) FROM content_policy_findings_secure_local f JOIN content_classifications_secure_local cls ON cls.classification_id = f.classification_id JOIN entries e ON e.local_entry_id = cls.local_entry_id WHERE e.tombstoned = 0 AND cls.active = 1 AND {entry_join_scope_sql}", entry_join_scope_params),
	        "extraction_jobs": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", job_alias_scope_params),
	        "extraction_jobs_queued": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status = 'queued' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", job_alias_scope_params),
	        "extraction_jobs_queued_actionable": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status = 'queued' AND e.entry_type = 'file' AND e.tombstoned = 0 AND NOT ({local_success_sql('j')}) AND NOT ({stale_scope}) AND NOT ({excluded_entry_sql}) AND {job_alias_scope_sql}", job_alias_scope_params),
	        "extraction_jobs_queued_superseded": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status = 'queued' AND e.entry_type = 'file' AND e.tombstoned = 0 AND (({local_success_sql('j')}) OR ({stale_scope})) AND {job_alias_scope_sql}", job_alias_scope_params),
	        "extraction_jobs_queued_policy_excluded": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status = 'queued' AND e.entry_type = 'file' AND e.tombstoned = 0 AND NOT ({local_success_sql('j')}) AND {excluded_entry_sql} AND {job_alias_scope_sql}", job_alias_scope_params),
	        "extraction_jobs_leased": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status = 'leased' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", job_alias_scope_params),
	        "extraction_jobs_leased_current": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status = 'leased' AND (j.leased_until IS NULL OR strftime('%s', j.leased_until) > strftime('%s', ?)) AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (out["sampled_at"], *job_alias_scope_params)),
	        "extraction_jobs_leased_expired": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status = 'leased' AND j.leased_until IS NOT NULL AND strftime('%s', j.leased_until) <= strftime('%s', ?) AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (out["sampled_at"], *job_alias_scope_params)),
	        "extraction_jobs_blocked": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status = 'blocked_policy' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", job_alias_scope_params),
        "extraction_jobs_skipped": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status IN ('skipped_unsupported', 'skipped_too_large', 'metadata_only') AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", job_alias_scope_params),
        "extraction_jobs_failed": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status IN ('failed_retryable', 'failed_terminal') AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", job_alias_scope_params),
        "extraction_jobs_failed_actionable": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status IN ('failed_retryable', 'failed_terminal') AND e.entry_type = 'file' AND e.tombstoned = 0 AND NOT ({local_success_sql('j')}) AND NOT ({stale_scope}) AND NOT ({excluded_entry_sql}) AND {job_alias_scope_sql}", job_alias_scope_params),
        "extraction_jobs_failed_superseded": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status IN ('failed_retryable', 'failed_terminal') AND e.entry_type = 'file' AND e.tombstoned = 0 AND (({local_success_sql('j')}) OR ({stale_scope})) AND {job_alias_scope_sql}", job_alias_scope_params),
        "extraction_jobs_failed_policy_excluded": scalar(con, f"SELECT COUNT(*) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = 'dropbox' AND j.status IN ('failed_retryable', 'failed_terminal') AND e.entry_type = 'file' AND e.tombstoned = 0 AND NOT ({local_success_sql('j')}) AND {excluded_entry_sql} AND {job_alias_scope_sql}", job_alias_scope_params),
        "sync_runs": scalar(con, f"SELECT COUNT(*) FROM sync_runs WHERE provider = 'dropbox' AND corpus_id = 'secure_local.dropbox.files' AND {sync_scope_sql}", sync_scope_params),
        "retrieval_audits": scalar(con, "SELECT COUNT(*) FROM retrieval_audit"),
        "embedding_models": scalar(con, "SELECT COUNT(*) FROM embedding_models"),
        "embedded_chunks": scalar(con, f"SELECT COUNT(*) FROM content_chunk_embeddings_secure_local emb JOIN content_chunks_secure_local c ON c.chunk_id = emb.chunk_id JOIN entries e ON e.local_entry_id = emb.local_entry_id WHERE e.tombstoned = 0 AND emb.source_content_hash = c.content_hash AND {entry_join_scope_sql}", entry_join_scope_params),
        "semantic_runs": scalar(con, f"SELECT COUNT(*) FROM semantic_index_runs WHERE provider = 'dropbox' AND corpus_id = 'secure_local.dropbox.files' AND {sync_scope_sql}", sync_scope_params),
        "promotion_proposals": scalar(con, f"SELECT COUNT(*) FROM promotion_proposals_secure_local WHERE provider = 'dropbox' AND corpus_id = 'secure_local.dropbox.files' AND {proposal_scope_sql}", proposal_scope_params),
        "promotion_decisions": scalar(con, f"SELECT COUNT(*) FROM promotion_decisions_secure_local d JOIN promotion_proposals_secure_local p ON p.proposal_id = d.proposal_id WHERE p.provider = 'dropbox' AND p.corpus_id = 'secure_local.dropbox.files' AND {scope_predicate('p.approved_scope_key')[0]}", scope_predicate("p.approved_scope_key")[1]),
    }
    counts.update(qa_counts(con))
    counts.update(crawl_counts(con))
    return {
        "generated_at": out["sampled_at"],
        "status": "ok",
        "corpora": [{"corpus_id": CORPUS_ID, "counts": counts, "qa": counts}],
    }

def db_fast_status_counts(con):
    job_scope_sql, job_scope_params = active_path_predicate("e.path_lower")
    local_success = local_success_sql("j")
    stale_scope = stale_scope_sql("j", "e")
    content_excluded = content_exclusion_sql("e")
    row = con.execute(f"""
        SELECT
          COUNT(*) AS extraction_jobs,
          SUM(CASE WHEN j.status = 'queued' THEN 1 ELSE 0 END) AS extraction_jobs_queued,
          SUM(CASE WHEN j.status = 'queued' AND NOT ({local_success}) AND NOT ({stale_scope}) AND NOT ({content_excluded}) THEN 1 ELSE 0 END) AS extraction_jobs_queued_actionable,
          SUM(CASE WHEN j.status = 'queued' AND (({local_success}) OR ({stale_scope})) THEN 1 ELSE 0 END) AS extraction_jobs_queued_superseded,
          SUM(CASE WHEN j.status = 'queued' AND NOT ({local_success}) AND {content_excluded} THEN 1 ELSE 0 END) AS extraction_jobs_queued_policy_excluded,
          SUM(CASE WHEN j.status = 'leased' THEN 1 ELSE 0 END) AS extraction_jobs_leased,
          SUM(CASE WHEN {leased_current_sql("j")} THEN 1 ELSE 0 END) AS extraction_jobs_leased_current,
          SUM(CASE WHEN {leased_current_sql("j")} AND NOT ({local_success}) AND NOT ({stale_scope}) AND NOT ({content_excluded}) THEN 1 ELSE 0 END) AS extraction_jobs_leased_current_actionable,
          SUM(CASE WHEN {leased_current_sql("j")} AND (({local_success}) OR ({stale_scope})) THEN 1 ELSE 0 END) AS extraction_jobs_leased_current_superseded,
          SUM(CASE WHEN {leased_current_sql("j")} AND NOT ({local_success}) AND {content_excluded} THEN 1 ELSE 0 END) AS extraction_jobs_leased_current_policy_excluded,
          SUM(CASE WHEN {leased_expired_sql("j")} THEN 1 ELSE 0 END) AS extraction_jobs_leased_expired,
          SUM(CASE WHEN {leased_expired_sql("j")} AND NOT ({local_success}) AND NOT ({stale_scope}) AND NOT ({content_excluded}) THEN 1 ELSE 0 END) AS extraction_jobs_leased_expired_actionable,
          SUM(CASE WHEN {leased_expired_sql("j")} AND (({local_success}) OR ({stale_scope})) THEN 1 ELSE 0 END) AS extraction_jobs_leased_expired_superseded,
          SUM(CASE WHEN {leased_expired_sql("j")} AND NOT ({local_success}) AND {content_excluded} THEN 1 ELSE 0 END) AS extraction_jobs_leased_expired_policy_excluded,
          SUM(CASE WHEN j.status IN ('failed_retryable', 'failed_terminal') THEN 1 ELSE 0 END) AS extraction_jobs_failed,
          SUM(CASE WHEN j.status IN ('failed_retryable', 'failed_terminal') AND NOT ({local_success}) AND NOT ({stale_scope}) AND NOT ({content_excluded}) THEN 1 ELSE 0 END) AS extraction_jobs_failed_actionable,
          SUM(CASE WHEN j.status IN ('failed_retryable', 'failed_terminal') AND (({local_success}) OR ({stale_scope})) THEN 1 ELSE 0 END) AS extraction_jobs_failed_superseded,
          SUM(CASE WHEN j.status IN ('failed_retryable', 'failed_terminal') AND NOT ({local_success}) AND {content_excluded} THEN 1 ELSE 0 END) AS extraction_jobs_failed_policy_excluded
        FROM content_extraction_jobs j
        JOIN entries e ON e.local_entry_id = j.local_entry_id
        WHERE j.provider = ? AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_scope_sql}
    """, (PROVIDER, *job_scope_params)).fetchone()
    return {key: int(row[key] or 0) for key in row.keys()}

def venice_progress(con):
    job_scope_sql, job_scope_params = active_path_predicate("e.path_lower")
    row = con.execute(f"""
        SELECT
	          COUNT(*) AS planned_jobs,
	          SUM(CASE WHEN j.status = 'queued' THEN 1 ELSE 0 END) AS queued_jobs,
	          SUM(CASE WHEN j.status = 'leased' THEN 1 ELSE 0 END) AS leased_jobs,
	          SUM(CASE WHEN {leased_current_sql("j")} THEN 1 ELSE 0 END) AS leased_current_jobs,
	          SUM(CASE WHEN {leased_expired_sql("j")} THEN 1 ELSE 0 END) AS leased_expired_jobs,
	          SUM(CASE WHEN j.status = 'indexed' THEN 1 ELSE 0 END) AS indexed_jobs,
          SUM(CASE WHEN j.status = 'metadata_only' THEN 1 ELSE 0 END) AS metadata_only_jobs,
          SUM(CASE WHEN j.status = 'failed_retryable' THEN 1 ELSE 0 END) AS retryable_jobs,
          SUM(CASE WHEN j.status = 'failed_terminal' THEN 1 ELSE 0 END) AS failed_terminal_jobs,
          SUM(CASE WHEN j.status = 'blocked_policy' THEN 1 ELSE 0 END) AS blocked_jobs,
          SUM(CASE WHEN j.status IN ('skipped_unsupported', 'skipped_too_large') THEN 1 ELSE 0 END) AS skipped_jobs
        FROM content_extraction_jobs j
        JOIN entries e ON e.local_entry_id = j.local_entry_id
        WHERE j.provider = ? AND j.extractor_kind LIKE 'venice_%' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_scope_sql}
    """, (PROVIDER, *job_scope_params)).fetchone()
    progress = {key: int(row[key] or 0) for key in row.keys()}
    progress["completed_jobs"] = (
        progress["indexed_jobs"]
        + progress["metadata_only_jobs"]
        + progress["failed_terminal_jobs"]
        + progress["blocked_jobs"]
        + progress["skipped_jobs"]
    )
    progress["active_jobs"] = (
        progress["queued_jobs"]
        + progress["leased_jobs"]
        + progress["retryable_jobs"]
    )
    progress["recipe_statuses"] = rows(con, f"""
        SELECT j.extractor_kind || ':' || j.extractor_version || ':' || j.status AS label, COUNT(*) AS count
        FROM content_extraction_jobs j
        JOIN entries e ON e.local_entry_id = j.local_entry_id
        WHERE j.provider = ? AND j.extractor_kind LIKE 'venice_%' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_scope_sql}
        GROUP BY j.extractor_kind, j.extractor_version, j.status
        ORDER BY count DESC
        LIMIT 20
    """, (PROVIDER, *job_scope_params))
    progress["error_kind_statuses"] = rows(con, f"""
        SELECT COALESCE(NULLIF(j.last_error_kind, ''), 'unknown') || ':' || j.status AS label, COUNT(*) AS count
        FROM content_extraction_jobs j
        JOIN entries e ON e.local_entry_id = j.local_entry_id
        WHERE j.provider = ? AND j.extractor_kind LIKE 'venice_%' AND j.last_error_kind IS NOT NULL AND j.last_error_kind <> '' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_scope_sql}
        GROUP BY j.last_error_kind, j.status
        ORDER BY count DESC
        LIMIT 20
    """, (PROVIDER, *job_scope_params))
    return progress

def active_sync_run(con):
    run_scope_sql, run_scope_params = scope_predicate("r.approved_scope_key")
    candidates = con.execute(f"""
        WITH event_counts AS (
          SELECT
            sync_run_id,
            COUNT(*) AS events,
            SUM(CASE WHEN event_type = 'upserted' THEN 1 ELSE 0 END) AS upserted,
            SUM(CASE WHEN event_type = 'tombstoned' THEN 1 ELSE 0 END) AS tombstoned,
            SUM(CASE WHEN event_type = 'skipped' THEN 1 ELSE 0 END) AS skipped,
            MAX(created_at) AS last_event_at
          FROM sync_events
          GROUP BY sync_run_id
        )
        SELECT
          r.sync_run_id,
          r.started_at,
          r.status,
          r.items_seen,
          r.items_indexed,
          COALESCE(e.events, 0) AS events,
          COALESCE(e.upserted, 0) AS upserted,
          COALESCE(e.tombstoned, 0) AS tombstoned,
          COALESCE(e.skipped, 0) AS skipped,
          COALESCE(e.last_event_at, r.started_at) AS last_activity_at
        FROM sync_runs r
        LEFT JOIN event_counts e ON e.sync_run_id = r.sync_run_id
        WHERE r.provider = ? AND r.corpus_id = ? AND r.status = 'running' AND {run_scope_sql}
        ORDER BY last_activity_at DESC
        LIMIT 20
    """, (PROVIDER, CORPUS_ID, *run_scope_params)).fetchall()
    active = None
    now = datetime.datetime.now(datetime.timezone.utc)
    for candidate in candidates:
        activity_at = parse_iso_datetime(candidate["last_activity_at"])
        is_stale_inactive = (
            activity_at is not None
            and (now - activity_at).total_seconds() > ACTIVE_SYNC_STALE_SECONDS
        )
        if not is_stale_inactive:
            active = candidate
            break
    if active is None:
        return None
    return {
        "run_id_hash": hashlib.sha256(active["sync_run_id"].encode("utf-8")).hexdigest()[:16],
        "started_at": active["started_at"],
        "status": active["status"],
        "items_seen": int(active["items_seen"] or 0),
        "items_indexed": int(active["items_indexed"] or 0),
        "events": int(active["events"] or 0),
        "upserted": int(active["upserted"] or 0),
        "tombstoned": int(active["tombstoned"] or 0),
        "skipped": int(active["skipped"] or 0),
    }

def parse_iso_datetime(value):
    if not value:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=datetime.timezone.utc)
        return parsed.astimezone(datetime.timezone.utc)
    except ValueError:
        return None

def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"

def content_exclusion_sql(alias="e"):
    if not CONTENT_EXCLUDE_PREFIXES:
        return "0=1"
    checks = []
    for prefix in CONTENT_EXCLUDE_PREFIXES:
        checks.append(f"LOWER(COALESCE({alias}.path_display, '')) LIKE {sql_literal(prefix + '%')}")
        checks.append(f"LOWER(COALESCE({alias}.path_lower, '')) LIKE {sql_literal(prefix + '%')}")
    return "(" + " OR ".join(checks) + ")"

def leased_current_sql(alias="j"):
    now = sql_literal(out["sampled_at"])
    return f"({alias}.status = 'leased' AND ({alias}.leased_until IS NULL OR strftime('%s', {alias}.leased_until) > strftime('%s', {now})))"

def leased_expired_sql(alias="j"):
    now = sql_literal(out["sampled_at"])
    return f"({alias}.status = 'leased' AND {alias}.leased_until IS NOT NULL AND strftime('%s', {alias}.leased_until) <= strftime('%s', {now}))"

def file_type_expr(column):
    return f"""
      CASE
        WHEN {column} = 'application/pdf' THEN 'PDF'
        WHEN {column} LIKE 'image/%' THEN 'Image'
        WHEN {column} IN (
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-powerpoint',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        ) THEN 'Office'
        WHEN {column} LIKE 'text/%' THEN 'Text'
        WHEN {column} IS NULL OR {column} = '' THEN 'Unknown'
        ELSE 'Other'
      END
    """

def sample_jobs(con, group_label, where_sql, order_sql, limit):
    job_scope_sql, job_scope_params = active_path_predicate("e.path_lower")
    return rows(con, f"""
        SELECT
          ? AS "group",
          COALESCE(NULLIF(TRIM(e.name), ''), '(unnamed file)') AS name,
          j.status AS status,
          e.path_display AS path_display,
          e.size_bytes AS size_bytes,
          CASE WHEN EXISTS (
            SELECT 1
            FROM content_extraction_jobs sj
            WHERE sj.local_entry_id = j.local_entry_id
              AND sj.job_id <> j.job_id
              AND sj.extractor_kind NOT LIKE 'venice_%'
              AND sj.status = 'indexed'
          ) THEN 1 ELSE 0 END AS superseded_by_local_success,
          {file_type_expr('e.mime_type')} AS file_type,
          j.extractor_kind AS extractor_kind,
          j.extractor_version AS extractor_version,
          j.attempts AS attempts,
          j.updated_at AS updated_at,
          CASE
            WHEN j.extractor_kind LIKE 'venice_%' THEN 'Venice/Grok escalation'
            WHEN j.extractor_kind LIKE 'local_%' THEN 'Local/Delphi processing'
            ELSE 'Source worker'
          END AS workflow,
	          CASE
	            WHEN j.status = 'queued' THEN 'waiting for worker'
	            WHEN {leased_expired_sql("j")} THEN 'stale lease'
	            WHEN j.status = 'leased' THEN 'claimed by worker'
	            WHEN j.status = 'indexed' THEN 'extracted and indexed'
            WHEN j.status = 'metadata_only' THEN 'metadata-only terminal'
            WHEN j.status = 'failed_retryable' THEN 'retryable failure'
            WHEN j.status = 'failed_terminal' THEN 'terminal failure'
            WHEN j.status = 'blocked_policy' THEN 'policy blocked'
            WHEN j.status LIKE 'skipped_%' THEN 'skipped terminal'
            ELSE j.status
          END AS phase,
	          CASE
	            WHEN {book_library_sql()} THEN 'Book/library inventory: metadata and folder presence are enough unless explicitly requested.'
	            WHEN j.status = 'queued' THEN 'Waiting to be claimed by a worker.'
	            WHEN {leased_expired_sql("j")} THEN 'Lease window expired; this job is stale unless a live worker heartbeat explains it.'
	            WHEN j.status = 'leased' AND j.extractor_kind LIKE 'venice_%' THEN 'Worker claimed it; temporary bytes may be fetched, then sent through private Venice/Grok escalation.'
            WHEN j.status = 'leased' THEN 'Worker claimed it; temporary bytes may be fetched for local extraction.'
            WHEN j.status = 'indexed' THEN 'Usable text, artifacts, or facts were written.'
            WHEN j.status = 'metadata_only' THEN 'Handled as metadata-only; no answer text was produced.'
            WHEN j.status = 'failed_retryable' THEN 'Failed retryably and will return to the lease queue after backoff.'
            WHEN j.status = 'failed_terminal' THEN 'Terminal extractor failure; operator/recipe work is needed.'
            WHEN j.status = 'blocked_policy' THEN 'Blocked by policy; it will not be sent onward.'
            WHEN j.status LIKE 'skipped_%' THEN 'Skipped by extractor policy.'
            ELSE 'Current file-level extraction state.'
          END AS detail,
          CASE
            WHEN j.status IN ('metadata_only', 'skipped_unsupported', 'skipped_too_large', 'blocked_policy') THEN 'No file download for this terminal result.'
            WHEN j.extractor_kind LIKE 'venice_%' THEN 'Temporary download, then private Venice request; file bytes are not persisted.'
            ELSE 'Temporary local download if needed; file bytes are not persisted.'
          END AS download_policy,
          j.policy_decision AS policy_decision,
          j.priority AS priority,
          j.max_bytes_per_file AS max_bytes_per_file,
          j.created_at AS created_at,
          j.leased_until AS leased_until,
	          j.next_retry_at AS next_retry_at,
	          j.last_error_kind AS last_error_kind,
	          j.temp_bytes_cleaned AS temp_bytes_cleaned,
	          CASE
	            WHEN {leased_expired_sql("j")} THEN 'expired'
	            WHEN {leased_current_sql("j")} THEN 'current'
	            ELSE NULL
	          END AS lease_state
        FROM content_extraction_jobs j
        JOIN entries e ON e.local_entry_id = j.local_entry_id
        WHERE j.provider = ? AND {job_scope_sql} AND e.entry_type = 'file' AND e.tombstoned = 0 AND ({where_sql})
        ORDER BY {order_sql}
        LIMIT ?
    """, (group_label, PROVIDER, *job_scope_params, limit))

def embedding_samples(con, limit):
    entry_scope_sql, entry_scope_params = active_path_predicate("e.path_lower")
    return rows(con, f"""
        SELECT
          'Embedding queue' AS "group",
          COALESCE(NULLIF(TRIM(e.name), ''), '(unnamed file)') AS name,
          'embedding_pending' AS status,
          e.path_display AS path_display,
          e.size_bytes AS size_bytes,
          0 AS superseded_by_local_success,
          {file_type_expr('e.mime_type')} AS file_type,
          'secure_local_embedding' AS extractor_kind,
          'local' AS extractor_version,
          0 AS attempts,
          MAX(c.indexed_at) AS updated_at,
          'Local embeddings' AS workflow,
          'embedding queue' AS phase,
          COUNT(*) || ' secure-local chunk(s) are waiting for local embedding.' AS detail,
          'Uses existing secure-local chunks; no Dropbox download.' AS download_policy,
          '' AS policy_decision,
          COUNT(*) AS priority,
          NULL AS max_bytes_per_file,
          MIN(c.indexed_at) AS created_at,
	          NULL AS leased_until,
	          NULL AS next_retry_at,
	          NULL AS last_error_kind,
	          NULL AS temp_bytes_cleaned,
	          NULL AS lease_state
        FROM content_chunks_secure_local c
        JOIN entries e ON e.local_entry_id = c.local_entry_id
        LEFT JOIN content_chunk_embeddings_secure_local emb
          ON emb.chunk_id = c.chunk_id
         AND emb.source_content_hash = c.content_hash
        WHERE emb.chunk_id IS NULL
          AND e.entry_type = 'file'
          AND e.tombstoned = 0
          AND {entry_scope_sql}
        GROUP BY e.local_entry_id
        ORDER BY COUNT(*) DESC, MAX(c.indexed_at) DESC
        LIMIT ?
    """, (*entry_scope_params, limit))

def metadata_sync_samples(con, limit):
    entry_scope_sql, entry_scope_params = active_path_predicate("e.path_lower")
    return rows(con, f"""
        SELECT
          'Metadata sync recent' AS "group",
          COALESCE(NULLIF(TRIM(e.name), ''), '(unnamed file)') AS name,
          'metadata_synced' AS status,
          e.path_display AS path_display,
          e.size_bytes AS size_bytes,
          0 AS superseded_by_local_success,
          {file_type_expr('e.mime_type')} AS file_type,
          'dropbox_metadata_sync' AS extractor_kind,
          'provider-delta' AS extractor_version,
          0 AS attempts,
          se.created_at AS updated_at,
          'Dropbox metadata sync' AS workflow,
          'metadata sync' AS phase,
          'Dropbox metadata was mapped or refreshed; content extraction is a later phase.' AS detail,
          'Provider metadata only; no file bytes downloaded.' AS download_policy,
          '' AS policy_decision,
          0 AS priority,
          NULL AS max_bytes_per_file,
          se.created_at AS created_at,
	          NULL AS leased_until,
	          NULL AS next_retry_at,
	          NULL AS last_error_kind,
	          NULL AS temp_bytes_cleaned,
	          NULL AS lease_state
        FROM sync_events se
        JOIN entries e ON e.provider_entry_id = se.provider_entry_id
        WHERE se.provider = ?
          AND e.entry_type = 'file'
          AND e.tombstoned = 0
          AND {entry_scope_sql}
        ORDER BY se.created_at DESC
        LIMIT ?
    """, (PROVIDER, *entry_scope_params, limit))

def visual_media_sql():
    return """
      (
        LOWER(COALESCE(e.mime_type, '')) LIKE 'image/%'
        OR LOWER(COALESCE(e.mime_type, '')) LIKE 'video/%'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.png'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.jpg'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.jpeg'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.gif'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.webp'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.heic'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.heif'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.tif'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.tiff'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.bmp'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.mov'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.mp4'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.m4v'
      )
    """

def book_library_sql():
    return """
      (
        LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.azw'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.azw3'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.azw4'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.cba'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.cb7'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.cbr'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.cbt'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.cbz'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.djv'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.djvu'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.epub'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.fb2'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.ibooks'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.lit'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.mobi'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%.opf'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%/audiobooks/%'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%/book library/%'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%/books/%'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%/calibre library/%'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%/e-books/%'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%/ebooks/%'
        OR LOWER(COALESCE(e.path_display, e.path_lower, e.name, '')) LIKE '%/kindle/%'
      )
    """

def default_deferred_content_sql():
    return "(" + visual_media_sql() + " OR " + book_library_sql() + ")"

def media_job_groups(con):
    job_scope_sql, job_scope_params = active_path_predicate("e.path_lower")
    return rows(con, f"""
        WITH scoped AS (
          SELECT
            CASE
              WHEN j.extractor_kind = 'local_vlm_layout'
                AND j.extractor_version LIKE '%on-demand-media-vlm%'
                THEN 'On-demand Delphi image ingestion'
              WHEN j.extractor_kind = 'local_vlm_layout'
                AND (j.extractor_version LIKE '%delphi-vlm-visual-repair%' OR j.extractor_version >= '2026-06-24')
                THEN 'Active Delphi VLM repair'
              WHEN j.extractor_kind = 'local_vlm_layout'
                AND j.extractor_version < '2026-06-24'
                THEN 'Historical broad VLM jobs'
              WHEN j.extractor_kind LIKE 'venice_%' AND {visual_media_sql()}
                THEN 'Wrong-lane Venice visual jobs'
              WHEN {book_library_sql()}
                THEN 'Metadata-only book/library inventory'
              WHEN j.extractor_kind LIKE 'venice_%'
                THEN 'Venice/Grok document escalation'
              ELSE 'Other media-capable jobs'
	            END AS label,
	            j.status AS status,
	            CASE WHEN {leased_current_sql("j")} THEN 1 ELSE 0 END AS leased_current,
	            CASE WHEN {leased_expired_sql("j")} THEN 1 ELSE 0 END AS leased_expired
          FROM content_extraction_jobs j
          JOIN entries e ON e.local_entry_id = j.local_entry_id
          WHERE j.provider = ?
            AND {job_scope_sql}
            AND (
              j.extractor_kind LIKE 'local_vlm%'
              OR j.extractor_kind = 'local_visual_descriptor'
              OR j.extractor_kind LIKE 'venice_%'
              OR {visual_media_sql()}
              OR {book_library_sql()}
            )
        )
        SELECT
          label,
          COUNT(*) AS planned_jobs,
	          SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_jobs,
	          SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased_jobs,
	          SUM(leased_current) AS leased_current_jobs,
	          SUM(leased_expired) AS leased_expired_jobs,
	          SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) AS indexed_jobs,
          SUM(CASE WHEN status = 'metadata_only' THEN 1 ELSE 0 END) AS metadata_only_jobs,
          SUM(CASE WHEN status = 'failed_retryable' THEN 1 ELSE 0 END) AS retryable_jobs,
          SUM(CASE WHEN status = 'failed_terminal' THEN 1 ELSE 0 END) AS failed_terminal_jobs,
          SUM(CASE WHEN status IN ('skipped_unsupported', 'skipped_too_large') THEN 1 ELSE 0 END) AS skipped_jobs,
          SUM(CASE WHEN status = 'blocked_policy' THEN 1 ELSE 0 END) AS blocked_jobs,
          SUM(CASE WHEN status IN ('indexed', 'metadata_only', 'failed_terminal', 'blocked_policy', 'skipped_unsupported', 'skipped_too_large') THEN 1 ELSE 0 END) AS completed_jobs,
          SUM(CASE WHEN status IN ('queued', 'leased', 'failed_retryable') THEN 1 ELSE 0 END) AS active_jobs
        FROM scoped
        GROUP BY label
        ORDER BY active_jobs DESC, planned_jobs DESC, label ASC
    """, (PROVIDER, *job_scope_params))

def file_samples(con):
    samples = []
    wrong_lane_visual = "j.status IN ('queued', 'leased', 'failed_retryable') AND LOWER(j.extractor_kind) LIKE 'venice_%' AND " + visual_media_sql()
    local_success = local_success_sql("j")
    same_scope = "NOT (" + stale_scope_sql("j", "e") + ")"
    content_excluded = content_exclusion_sql("e")
    local_text = "j.extractor_kind IN ('local_text', 'local_text_and_pdf', 'local_structured', 'local_office_structured')"
    deferred_content = default_deferred_content_sql()
    book_library = book_library_sql()
    local_ocr = "j.extractor_kind LIKE 'local_ocr%'"
    local_vlm = "(j.extractor_kind LIKE 'local_vlm%' OR j.extractor_kind = 'local_visual_descriptor')"
    historical_broad_vlm = "j.extractor_kind = 'local_vlm_layout' AND j.extractor_version < '2026-06-24'"
    local_vlm_current = "(" + local_vlm + ") AND NOT (" + historical_broad_vlm + ")"
    local_other = "j.extractor_kind LIKE 'local_%' AND NOT (" + local_text + ") AND NOT (" + local_ocr + ") AND NOT (" + local_vlm + ")"
    current_lease = leased_current_sql("j")
    expired_lease = leased_expired_sql("j")
    samples.extend(sample_jobs(con, "Active local text/PDF", same_scope + " AND " + current_lease + " AND " + local_text + " AND NOT (" + deferred_content + ")", "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Active local OCR", same_scope + " AND " + current_lease + " AND " + local_ocr, "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Active local VLM", same_scope + " AND " + current_lease + " AND " + local_vlm_current, "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Active local other", same_scope + " AND " + current_lease + " AND " + local_other, "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Active Venice/Grok", same_scope + " AND " + current_lease + " AND j.extractor_kind LIKE 'venice_%'", "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Stale local leases", same_scope + " AND " + expired_lease + " AND j.extractor_kind NOT LIKE 'venice_%'", "j.leased_until ASC, j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Stale Venice/Grok leases", same_scope + " AND " + expired_lease + " AND j.extractor_kind LIKE 'venice_%'", "j.leased_until ASC, j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Waiting local text/PDF", same_scope + " AND j.status = 'queued' AND NOT (" + local_success + ") AND NOT (" + content_excluded + ") AND " + local_text + " AND NOT (" + deferred_content + ")", "j.priority DESC, j.updated_at ASC", 8))
    samples.extend(sample_jobs(con, "Waiting local OCR", same_scope + " AND j.status = 'queued' AND NOT (" + local_success + ") AND NOT (" + content_excluded + ") AND " + local_ocr, "j.priority DESC, j.updated_at ASC", 8))
    samples.extend(sample_jobs(con, "Waiting local VLM", same_scope + " AND j.status = 'queued' AND NOT (" + local_success + ") AND NOT (" + content_excluded + ") AND " + local_vlm_current, "j.priority DESC, j.updated_at ASC", 8))
    samples.extend(sample_jobs(con, "Waiting local other", same_scope + " AND j.status = 'queued' AND NOT (" + local_success + ") AND NOT (" + content_excluded + ") AND " + local_other, "j.priority DESC, j.updated_at ASC", 8))
    samples.extend(sample_jobs(con, "Waiting Venice/Grok", same_scope + " AND j.status = 'queued' AND NOT (" + local_success + ") AND NOT (" + content_excluded + ") AND j.extractor_kind LIKE 'venice_%'", "j.priority DESC, j.updated_at ASC", 8))
    samples.extend(sample_jobs(con, "Book/library inventory", "j.status IN ('queued', 'failed_retryable', 'metadata_only') AND " + book_library, "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Retry queue", same_scope + " AND j.status = 'failed_retryable' AND NOT (" + local_success + ") AND NOT (" + content_excluded + ") AND NOT (" + wrong_lane_visual + ") AND NOT (" + historical_broad_vlm + ") AND NOT (" + deferred_content + ")", "COALESCE(j.next_retry_at, j.updated_at) ASC, j.priority DESC", 8))
    samples.extend(sample_jobs(con, "Wrong-lane old retries", wrong_lane_visual + " AND NOT (" + local_success + ")", "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Historical broad VLM jobs", "j.status IN ('queued', 'failed_retryable', 'failed_terminal') AND " + historical_broad_vlm, "j.updated_at ASC", 8))
    samples.extend(embedding_samples(con, 8))
    samples.extend(metadata_sync_samples(con, 8))
    samples.extend(sample_jobs(con, "Recent completed", "j.status IN ('indexed', 'metadata_only', 'failed_terminal', 'blocked_policy', 'skipped_unsupported', 'skipped_too_large')", "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Venice lane", "j.extractor_kind LIKE 'venice_%'", "j.updated_at DESC", 8))
    return samples

def fast_file_samples(con):
    samples = []
    wrong_lane_visual = "j.status IN ('queued', 'leased', 'failed_retryable') AND LOWER(j.extractor_kind) LIKE 'venice_%' AND " + visual_media_sql()
    local_success = local_success_sql("j")
    same_scope = "NOT (" + stale_scope_sql("j", "e") + ")"
    content_excluded = content_exclusion_sql("e")
    local_text = "j.extractor_kind IN ('local_text', 'local_text_and_pdf', 'local_structured', 'local_office_structured')"
    deferred_content = default_deferred_content_sql()
    local_ocr = "j.extractor_kind LIKE 'local_ocr%'"
    local_vlm = "(j.extractor_kind LIKE 'local_vlm%' OR j.extractor_kind = 'local_visual_descriptor')"
    historical_broad_vlm = "j.extractor_kind = 'local_vlm_layout' AND j.extractor_version NOT IN ('2026-06-24-delphi-vlm-visual-repair', '2026-06-24-on-demand-media-vlm')"
    local_vlm_current = "(" + local_vlm + ") AND NOT (" + historical_broad_vlm + ")"
    local_other = "j.extractor_kind LIKE 'local_%' AND NOT (" + local_text + ") AND NOT (" + local_ocr + ") AND NOT (" + local_vlm + ")"
    current_lease = leased_current_sql("j")
    samples.extend(sample_jobs(con, "Active local OCR", same_scope + " AND " + current_lease + " AND " + local_ocr, "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Active local text/PDF", same_scope + " AND " + current_lease + " AND " + local_text + " AND NOT (" + deferred_content + ")", "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Active local VLM", same_scope + " AND " + current_lease + " AND " + local_vlm_current, "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Active local other", same_scope + " AND " + current_lease + " AND " + local_other, "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Active Venice/Grok", same_scope + " AND " + current_lease + " AND j.extractor_kind LIKE 'venice_%'", "j.updated_at DESC", 8))
    samples.extend(sample_jobs(con, "Waiting local OCR", same_scope + " AND j.status = 'queued' AND NOT (" + local_success + ") AND NOT (" + content_excluded + ") AND " + local_ocr, "j.priority DESC, j.updated_at ASC", 8))
    samples.extend(sample_jobs(con, "Waiting local text/PDF", same_scope + " AND j.status = 'queued' AND NOT (" + local_success + ") AND NOT (" + content_excluded + ") AND " + local_text + " AND NOT (" + deferred_content + ")", "j.priority DESC, j.updated_at ASC", 8))
    samples.extend(sample_jobs(con, "Waiting Venice/Grok", same_scope + " AND j.status = 'queued' AND NOT (" + local_success + ") AND NOT (" + content_excluded + ") AND j.extractor_kind LIKE 'venice_%'", "j.priority DESC, j.updated_at ASC", 8))
    samples.extend(sample_jobs(con, "Retry queue", same_scope + " AND j.status = 'failed_retryable' AND NOT (" + local_success + ") AND NOT (" + content_excluded + ") AND NOT (" + deferred_content + ")", "COALESCE(j.next_retry_at, j.updated_at) ASC, j.priority DESC", 8))
    samples.extend(sample_jobs(con, "Wrong-lane Venice visual jobs", wrong_lane_visual + " AND NOT (" + local_success + ")", "j.updated_at DESC", 8))
    return samples

def db_aggregates(con):
    entry_scope_sql, entry_scope_params = active_path_predicate("path_lower")
    entry_alias_scope_sql, entry_alias_scope_params = active_path_predicate("e.path_lower")
    job_alias_scope_sql, job_alias_scope_params = active_path_predicate("e.path_lower")
    frontier_scope_sql, frontier_scope_params = scope_predicate("approved_scope_key")
    file_bucket_sql, file_bucket_params = inventory_bucket_case("path_lower")
    folder_bucket_sql, folder_bucket_params = inventory_bucket_case("path_lower")
    return {
        "file_types": rows(con, f"""
            SELECT
              CASE
                WHEN mime_type = 'application/pdf' THEN 'PDF'
                WHEN mime_type LIKE 'image/%' THEN 'Images'
                WHEN mime_type IN (
                  'application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.ms-powerpoint',
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                ) THEN 'Office documents'
                WHEN mime_type LIKE 'text/%' THEN 'Text'
                WHEN mime_type LIKE 'audio/%' THEN 'Audio'
                WHEN mime_type LIKE 'video/%' THEN 'Video'
                WHEN mime_type IS NULL OR mime_type = '' THEN 'Unknown'
                ELSE 'Other'
              END AS label,
              COUNT(*) AS count
            FROM entries
            WHERE entry_type = 'file' AND tombstoned = 0 AND {entry_scope_sql}
            GROUP BY label
            ORDER BY count DESC
            LIMIT 12
        """, entry_scope_params),
        "scope_files": rows(con, f"""
            SELECT
              {file_bucket_sql} AS label,
              COUNT(*) AS count
            FROM entries
            WHERE entry_type = 'file' AND tombstoned = 0
            GROUP BY label
            ORDER BY label ASC
        """, file_bucket_params),
        "scope_folders": rows(con, f"""
            SELECT
              {folder_bucket_sql} AS label,
              COUNT(*) AS count
            FROM entries
            WHERE entry_type = 'folder' AND tombstoned = 0
            GROUP BY label
            ORDER BY label ASC
        """, folder_bucket_params),
        "job_statuses": rows(con, f"""
            SELECT j.status AS label, COUNT(*) AS count
            FROM content_extraction_jobs j
            JOIN entries e ON e.local_entry_id = j.local_entry_id
            WHERE j.provider = ? AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}
            GROUP BY j.status
            ORDER BY count DESC
            LIMIT 20
        """, (PROVIDER, *job_alias_scope_params)),
        "crawl_frontier_statuses": rows(con, f"""
            SELECT status AS label, COUNT(*) AS count
            FROM crawl_frontier
            WHERE provider = ? AND {frontier_scope_sql}
            GROUP BY status
            ORDER BY count DESC
            LIMIT 20
        """, (PROVIDER, *frontier_scope_params)),
        "extraction_lanes": rows(con, f"""
            WITH
            job_file_status AS (
              SELECT
                local_entry_id,
                MAX(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
                MAX(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased,
                MAX(CASE WHEN status = 'failed_retryable' THEN 1 ELSE 0 END) AS retryable,
                MAX(CASE WHEN status = 'failed_terminal' THEN 1 ELSE 0 END) AS failed_terminal,
                MAX(CASE WHEN status IN (
                  'indexed',
                  'metadata_only',
                  'skipped_unsupported',
                  'skipped_too_large',
                  'blocked_policy',
                  'failed_terminal'
                ) THEN 1 ELSE 0 END) AS terminal
              FROM content_extraction_jobs
              WHERE provider = ?
              GROUP BY local_entry_id
            ),
            chunk_summary AS (
              SELECT local_entry_id, COUNT(*) AS chunk_count
              FROM content_chunks_secure_local
              GROUP BY local_entry_id
            ),
            artifact_summary AS (
              SELECT
                local_entry_id,
                SUM(CASE WHEN bounded_text IS NOT NULL AND LENGTH(TRIM(bounded_text)) > 0 THEN 1 ELSE 0 END) AS artifact_text_count
              FROM content_artifacts_secure_local
              GROUP BY local_entry_id
            ),
            fact_summary AS (
              SELECT local_entry_id, COUNT(*) AS fact_count
              FROM content_facts_secure_local
              GROUP BY local_entry_id
            )
            SELECT
              CASE
                WHEN e.mime_type = 'application/pdf' THEN 'PDF'
                WHEN e.mime_type LIKE 'image/%' THEN 'Images'
                WHEN e.mime_type IN (
                  'application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.ms-powerpoint',
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                ) THEN 'Office documents'
                WHEN e.mime_type LIKE 'text/%' THEN 'Text'
                WHEN e.mime_type LIKE 'audio/%' THEN 'Audio'
                WHEN e.mime_type LIKE 'video/%' THEN 'Video'
                WHEN e.mime_type IS NULL OR e.mime_type = '' THEN 'Unknown'
                ELSE 'Other'
              END AS label,
              COUNT(*) AS files,
              SUM(CASE
                WHEN e.extraction_status = 'extracted'
                  OR COALESCE(ch.chunk_count, 0) > 0
                  OR COALESCE(ar.artifact_text_count, 0) > 0
                  OR COALESCE(f.fact_count, 0) > 0
                THEN 1 ELSE 0 END) AS extracted,
              SUM(CASE WHEN jf.terminal = 1 AND jf.queued = 0 AND jf.leased = 0 AND jf.retryable = 0 THEN 1 ELSE 0 END) AS terminal,
              SUM(jf.queued) AS queued,
              SUM(jf.leased) AS leased,
              SUM(jf.retryable) AS retryable,
              SUM(jf.failed_terminal) AS failed_terminal
            FROM job_file_status jf
            JOIN entries e ON e.local_entry_id = jf.local_entry_id
            LEFT JOIN chunk_summary ch ON ch.local_entry_id = e.local_entry_id
            LEFT JOIN artifact_summary ar ON ar.local_entry_id = e.local_entry_id
            LEFT JOIN fact_summary f ON f.local_entry_id = e.local_entry_id
            WHERE e.entry_type = 'file' AND e.tombstoned = 0 AND {entry_alias_scope_sql}
            GROUP BY label
            ORDER BY files DESC
            LIMIT 12
        """, (PROVIDER, *entry_alias_scope_params)),
        "embedding_lanes": rows(con, f"""
            SELECT
              CASE
                WHEN e.mime_type = 'application/pdf' THEN 'PDF'
                WHEN e.mime_type LIKE 'image/%' THEN 'Images'
                WHEN e.mime_type IN (
                  'application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.ms-powerpoint',
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                ) THEN 'Office documents'
                WHEN e.mime_type LIKE 'text/%' THEN 'Text'
                WHEN e.mime_type LIKE 'audio/%' THEN 'Audio'
                WHEN e.mime_type LIKE 'video/%' THEN 'Video'
                WHEN e.mime_type IS NULL OR e.mime_type = '' THEN 'Unknown'
                ELSE 'Other'
              END AS label,
              COUNT(DISTINCT e.local_entry_id) AS files,
              COUNT(DISTINCT c.chunk_id) AS chunks,
              COUNT(DISTINCT emb.chunk_id) AS embedded_chunks
            FROM entries e
            LEFT JOIN content_chunks_secure_local c ON c.local_entry_id = e.local_entry_id
            LEFT JOIN content_chunk_embeddings_secure_local emb ON emb.chunk_id = c.chunk_id
            WHERE e.entry_type = 'file' AND e.tombstoned = 0 AND {entry_alias_scope_sql}
            GROUP BY label
            ORDER BY chunks DESC, files DESC
            LIMIT 12
        """, entry_alias_scope_params),
        "media_job_groups": media_job_groups(con),
        "planning_files": {
            "planned_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
            "indexed_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND j.status = 'indexed' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
            "queued_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND j.status = 'queued' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
            "leased_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND j.status = 'leased' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
            "retryable_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND j.status = 'failed_retryable' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
            "failed_terminal_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND j.status = 'failed_terminal' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
        },
        "active_sync": active_sync_run(con),
        "venice_progress": venice_progress(con),
        "file_samples": file_samples(con),
    }

def db_fast_aggregates(con):
    entry_scope_sql, entry_scope_params = active_path_predicate("path_lower")
    entry_alias_scope_sql, entry_alias_scope_params = active_path_predicate("e.path_lower")
    job_alias_scope_sql, job_alias_scope_params = active_path_predicate("e.path_lower")
    file_bucket_sql, file_bucket_params = inventory_bucket_case("path_lower")
    folder_bucket_sql, folder_bucket_params = inventory_bucket_case("path_lower")
    return {
        "file_types": rows(con, f"""
            SELECT
              CASE
                WHEN mime_type = 'application/pdf' THEN 'PDF'
                WHEN mime_type LIKE 'image/%' THEN 'Images'
                WHEN mime_type IN (
                  'application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.ms-powerpoint',
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                ) THEN 'Office documents'
                WHEN mime_type LIKE 'text/%' THEN 'Text'
                WHEN mime_type LIKE 'audio/%' THEN 'Audio'
                WHEN mime_type LIKE 'video/%' THEN 'Video'
                WHEN mime_type IS NULL OR mime_type = '' THEN 'Unknown'
                ELSE 'Other'
              END AS label,
              COUNT(*) AS count
            FROM entries
            WHERE entry_type = 'file' AND tombstoned = 0 AND {entry_scope_sql}
            GROUP BY label
            ORDER BY count DESC
            LIMIT 12
        """, entry_scope_params),
        "scope_files": rows(con, f"""
            SELECT
              {file_bucket_sql} AS label,
              COUNT(*) AS count
            FROM entries
            WHERE entry_type = 'file' AND tombstoned = 0
            GROUP BY label
            ORDER BY label ASC
        """, file_bucket_params),
        "scope_folders": rows(con, f"""
            SELECT
              {folder_bucket_sql} AS label,
              COUNT(*) AS count
            FROM entries
            WHERE entry_type = 'folder' AND tombstoned = 0
            GROUP BY label
            ORDER BY label ASC
        """, folder_bucket_params),
        "job_statuses": rows(con, f"""
            SELECT j.status AS label, COUNT(*) AS count
            FROM content_extraction_jobs j
            JOIN entries e ON e.local_entry_id = j.local_entry_id
            WHERE j.provider = ? AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}
            GROUP BY j.status
            ORDER BY count DESC
            LIMIT 20
        """, (PROVIDER, *job_alias_scope_params)),
        "extraction_lanes": rows(con, f"""
            SELECT
              CASE
                WHEN e.mime_type = 'application/pdf' THEN 'PDF'
                WHEN e.mime_type LIKE 'image/%' THEN 'Images'
                WHEN e.mime_type IN (
                  'application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.ms-powerpoint',
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                ) THEN 'Office documents'
                WHEN e.mime_type LIKE 'text/%' THEN 'Text'
                WHEN e.mime_type LIKE 'audio/%' THEN 'Audio'
                WHEN e.mime_type LIKE 'video/%' THEN 'Video'
                WHEN e.mime_type IS NULL OR e.mime_type = '' THEN 'Unknown'
                ELSE 'Other'
              END AS label,
              COUNT(DISTINCT j.local_entry_id) AS files,
              COUNT(DISTINCT CASE WHEN j.status = 'indexed' THEN j.local_entry_id END) AS extracted,
              COUNT(DISTINCT CASE WHEN j.status IN (
                'indexed',
                'metadata_only',
                'skipped_unsupported',
                'skipped_too_large',
                'blocked_policy',
                'failed_terminal'
              ) THEN j.local_entry_id END) AS terminal,
              SUM(CASE WHEN j.status = 'queued' THEN 1 ELSE 0 END) AS queued,
              SUM(CASE WHEN j.status = 'leased' THEN 1 ELSE 0 END) AS leased,
              SUM(CASE WHEN j.status = 'failed_retryable' THEN 1 ELSE 0 END) AS retryable,
              SUM(CASE WHEN j.status = 'failed_terminal' THEN 1 ELSE 0 END) AS failed_terminal
            FROM content_extraction_jobs j
            JOIN entries e ON e.local_entry_id = j.local_entry_id
            WHERE j.provider = ? AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}
            GROUP BY label
            ORDER BY files DESC
            LIMIT 12
        """, (PROVIDER, *job_alias_scope_params)),
        "embedding_lanes": rows(con, f"""
            SELECT
              CASE
                WHEN e.mime_type = 'application/pdf' THEN 'PDF'
                WHEN e.mime_type LIKE 'image/%' THEN 'Images'
                WHEN e.mime_type IN (
                  'application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.ms-powerpoint',
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                ) THEN 'Office documents'
                WHEN e.mime_type LIKE 'text/%' THEN 'Text'
                WHEN e.mime_type LIKE 'audio/%' THEN 'Audio'
                WHEN e.mime_type LIKE 'video/%' THEN 'Video'
                WHEN e.mime_type IS NULL OR e.mime_type = '' THEN 'Unknown'
                ELSE 'Other'
              END AS label,
              COUNT(DISTINCT e.local_entry_id) AS files,
              COUNT(DISTINCT c.chunk_id) AS chunks,
              COUNT(DISTINCT emb.chunk_id) AS embedded_chunks
            FROM entries e
            LEFT JOIN content_chunks_secure_local c ON c.local_entry_id = e.local_entry_id
            LEFT JOIN content_chunk_embeddings_secure_local emb
              ON emb.chunk_id = c.chunk_id
             AND emb.source_content_hash = c.content_hash
            WHERE e.entry_type = 'file' AND e.tombstoned = 0 AND {entry_alias_scope_sql}
            GROUP BY label
            ORDER BY chunks DESC, files DESC
            LIMIT 12
        """, entry_alias_scope_params),
        "media_job_groups": media_job_groups(con),
        "planning_files": {
            "planned_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
            "indexed_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND j.status = 'indexed' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
            "queued_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND j.status = 'queued' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
            "leased_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND j.status = 'leased' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
            "retryable_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND j.status = 'failed_retryable' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
            "failed_terminal_files": scalar(con, f"SELECT COUNT(DISTINCT j.local_entry_id) FROM content_extraction_jobs j JOIN entries e ON e.local_entry_id = j.local_entry_id WHERE j.provider = ? AND j.status = 'failed_terminal' AND e.entry_type = 'file' AND e.tombstoned = 0 AND {job_alias_scope_sql}", (PROVIDER, *job_alias_scope_params)),
        },
        "venice_progress": venice_progress(con),
        "file_samples": fast_file_samples(con),
    }

if not DB_PATH:
    try:
        out["status"] = source_worker_status()
    except Exception as exc:
        out["status_error"] = safe_error(exc)

if DB_PATH:
    try:
        if not os.path.exists(DB_PATH):
            raise FileNotFoundError("configured source DB path does not exist")
        con = sqlite3.connect("file:" + DB_PATH + "?mode=ro", uri=True, timeout=1)
        con.row_factory = sqlite3.Row
        try:
            con.execute("PRAGMA query_only = ON")
            con.execute("PRAGMA busy_timeout = 1000")
            try:
                install_sqlite_deadline(con, SQLITE_FAST_STATUS_DEADLINE_SECONDS)
                fast_counts = db_fast_status_counts(con)
                if "status" in out:
                    out["status"] = merge_status_counts(out["status"], fast_counts)
            except Exception as exc:
                out["fast_status_error"] = safe_error(exc)
            try:
                install_sqlite_deadline(con, SQLITE_STATUS_DEADLINE_SECONDS)
                out["status"] = db_status_snapshot(con)
            except Exception as exc:
                out["status_db_error"] = safe_error(exc)
            if ENABLE_RICH_AGGREGATES:
                try:
                    install_sqlite_deadline(con, SQLITE_AGGREGATE_DEADLINE_SECONDS)
                    out["aggregates"] = db_aggregates(con)
                except Exception as exc:
                    aggregate_warning = safe_error(exc)
                    install_sqlite_deadline(con, SQLITE_FAST_AGGREGATE_DEADLINE_SECONDS)
                    out["aggregates"] = db_fast_aggregates(con)
                    out["aggregates_mode"] = "fast"
                    out["aggregates_warning"] = aggregate_warning
            else:
                install_sqlite_deadline(con, SQLITE_FAST_AGGREGATE_DEADLINE_SECONDS)
                out["aggregates"] = db_fast_aggregates(con)
                out["aggregates_mode"] = "fast"
            if "health" not in out:
                out["health"] = {"reachable": True, "status": "db_snapshot"}
        finally:
            con.set_progress_handler(None, 0)
            con.close()
    except Exception as exc:
        if "status" not in out:
            try:
                out["status"] = source_worker_status()
            except Exception:
                out["status_error"] = safe_error(exc)
        out["aggregates_error"] = safe_error(exc)

if "health" not in out:
    try:
        health_text = run(["curl", "-fsS", "--max-time", "10", "http://127.0.0.1:8010/v1/health"], timeout=12)
        health = json.loads(health_text)
        if isinstance(health, dict):
            out["health"] = {key: health.get(key) for key in ["ok", "healthy", "reachable", "configured", "status", "state", "service", "version"] if key in health}
        else:
            out["health"] = {"status": "unknown"}
    except Exception as exc:
        out["health_error"] = safe_error(exc)

try:
    show_text = run([
        "systemctl", "--user", "show", "olympus-email-source.service",
        "-p", "ActiveState", "-p", "SubState", "-p", "MainPID",
        "-p", "NRestarts", "-p", "MemoryCurrent", "-p", "MemoryPeak",
        "-p", "TasksCurrent", "--no-pager",
    ], timeout=10)
    props = {}
    for line in show_text.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            props[key] = value
    out["source_worker"] = props
except Exception as exc:
    out["source_worker_error"] = safe_error(exc)

try:
    named_units = [
        "olympus-source-processing-supervisor.service",
        "olympus-source-processing-supervisor-local-ocr.service",
        "olympus-source-processing-supervisor-local-vlm-visual-repair.service",
        "olympus-source-embedding-drain.service",
        "olympus-source-processing-supervisor-venice-grok43.service",
        "olympus-source-processing-supervisor-venice-grok43-areas.service",
        "olympus-source-processing-supervisor-venice-grok43-resources.service",
    ]
    states = {}
    named_details = []
    for unit in named_units:
        try:
            show_text = run([
                "systemctl", "--user", "show", unit,
                "-p", "ActiveState", "-p", "SubState", "--no-pager",
            ], timeout=5)
            props = {}
            for line in show_text.splitlines():
                if "=" in line:
                    key, value = line.split("=", 1)
                    props[key] = value
            active_state = props.get("ActiveState") or "unknown"
            sub_state = props.get("SubState") or "unknown"
            state_key = active_state + "/" + sub_state
            states[state_key] = states.get(state_key, 0) + 1
            named_details.append({
                "unit": unit,
                "active_state": active_state,
                "sub_state": sub_state,
            })
        except Exception as exc:
            named_details.append({
                "unit": unit,
                "error": safe_error(exc),
            })
    out["drain_units"] = states
    out["drain_unit_details"] = named_details
except Exception as exc:
    out["drain_units_error"] = safe_error(exc)

try:
    helper_names = {"ocrmypdf", "tesseract", "unpaper", "gs", "pdftoppm", "mutool"}
    ps_text = run(["ps", "-eo", "comm="], timeout=10)
    by_name = {}
    for raw_name in ps_text.splitlines():
        name = os.path.basename(raw_name.strip())
        if name in helper_names:
            by_name[name] = by_name.get(name, 0) + 1
    out["ocr_helpers"] = {"active": sum(by_name.values()), "by_name": by_name}
except Exception as exc:
    out["ocr_helpers_error"] = safe_error(exc)

print(json.dumps(out))
PY`;
}

function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): LiveDashboardServerOptions & { once: boolean } {
  const options: LiveDashboardServerOptions & { once: boolean } = {
    host: env.OLYMPUS_SOURCE_INGESTION_LIVE_HOST ?? DEFAULT_HOST,
    port: numberFromUnknown(env.OLYMPUS_SOURCE_INGESTION_LIVE_PORT) ?? DEFAULT_PORT,
    sshTarget: env.OLYMPUS_SOURCE_INGESTION_SSH_TARGET ?? '',
    corpusId: env.OLYMPUS_SOURCE_INGESTION_CORPUS_ID ?? DEFAULT_CORPUS_ID,
    activeScopeKeys: csv(env.OLYMPUS_SOURCE_INGESTION_ACTIVE_SCOPE_KEYS) ?? [...DEFAULT_ACTIVE_SCOPE_KEYS],
    pollSeconds: numberFromUnknown(env.OLYMPUS_SOURCE_INGESTION_POLL_SECONDS) ?? DEFAULT_POLL_SECONDS,
    historyPath: env.OLYMPUS_SOURCE_INGESTION_HISTORY_PATH ?? DEFAULT_HISTORY_PATH,
    remoteDbPath: env.OLYMPUS_SOURCE_INGESTION_REMOTE_DB_PATH ?? DEFAULT_REMOTE_DB_PATH,
    commandTimeoutMs: numberFromUnknown(env.OLYMPUS_SOURCE_INGESTION_COMMAND_TIMEOUT_MS) ?? 90000,
    once: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      index += 1;
      return value;
    };
    if (arg === '--host') options.host = next();
    else if (arg === '--port') options.port = Number.parseInt(next(), 10);
    else if (arg === '--ssh-target') options.sshTarget = next();
    else if (arg === '--corpus-id') options.corpusId = next();
    else if (arg === '--active-scopes') options.activeScopeKeys = csv(next()) ?? [];
    else if (arg === '--poll-seconds') options.pollSeconds = Number.parseInt(next(), 10);
    else if (arg === '--history') options.historyPath = next();
    else if (arg === '--remote-db') options.remoteDbPath = next();
    else if (arg === '--no-remote-db') options.remoteDbPath = null;
    else if (arg === '--command-timeout-ms') options.commandTimeoutMs = Number.parseInt(next(), 10);
    else if (arg === '--once') options.once = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.sshTarget.trim()) {
    throw new Error('No private-host SSH target is configured. Set OLYMPUS_SOURCE_INGESTION_SSH_TARGET or pass --ssh-target; there is deliberately no committed default.');
  }
  if (!Number.isFinite(options.port) || options.port <= 0) throw new Error('--port must be a positive number.');
  if (options.activeScopeKeys.length === 0) throw new Error('--active-scopes must include at least one Dropbox approved scope.');
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds < 5) throw new Error('--poll-seconds must be at least 5.');
  if (!Number.isFinite(options.commandTimeoutMs) || options.commandTimeoutMs < 1000) throw new Error('--command-timeout-ms must be at least 1000.');
  return options;
}

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function normalizeAggregates(raw: RawAggregateMetrics | undefined): LiveAggregateMetrics | null {
  if (!raw) return null;
  return {
    fileTypes: normalizeAggregateCounts(raw.file_types),
    jobStatuses: normalizeAggregateCounts(raw.job_statuses),
    crawlFrontierStatuses: normalizeAggregateCounts(raw.crawl_frontier_statuses),
    scopeFiles: normalizeAggregateCounts(raw.scope_files),
    scopeFolders: normalizeAggregateCounts(raw.scope_folders),
    extractionLanes: (raw.extraction_lanes ?? []).map((row) => ({
      label: stringValue(row.label) ?? 'unknown',
      files: numberFromUnknown(row.files) ?? 0,
      extracted: numberFromUnknown(row.extracted) ?? 0,
      terminal: numberFromUnknown(row.terminal) ?? 0,
      queued: numberFromUnknown(row.queued) ?? 0,
      leased: numberFromUnknown(row.leased) ?? 0,
      retryable: numberFromUnknown(row.retryable) ?? 0,
      failedTerminal: numberFromUnknown(row.failed_terminal) ?? 0,
    })),
    embeddingLanes: (raw.embedding_lanes ?? []).map((row) => ({
      label: stringValue(row.label) ?? 'unknown',
      files: numberFromUnknown(row.files) ?? 0,
      chunks: numberFromUnknown(row.chunks) ?? 0,
      embeddedChunks: numberFromUnknown(row.embedded_chunks) ?? 0,
    })),
	    mediaJobGroups: (raw.media_job_groups ?? []).map((row) => ({
	      label: stringValue(row.label) ?? 'unknown',
	      plannedJobs: numberFromUnknown(row.planned_jobs) ?? 0,
	      queuedJobs: numberFromUnknown(row.queued_jobs) ?? 0,
	      leasedJobs: numberFromUnknown(row.leased_jobs) ?? 0,
	      leasedCurrentJobs: numberFromUnknown(row.leased_current_jobs) ?? numberFromUnknown(row.leased_jobs) ?? 0,
	      leasedExpiredJobs: numberFromUnknown(row.leased_expired_jobs) ?? 0,
	      indexedJobs: numberFromUnknown(row.indexed_jobs) ?? 0,
      metadataOnlyJobs: numberFromUnknown(row.metadata_only_jobs) ?? 0,
      retryableJobs: numberFromUnknown(row.retryable_jobs) ?? 0,
      failedTerminalJobs: numberFromUnknown(row.failed_terminal_jobs) ?? 0,
      skippedJobs: numberFromUnknown(row.skipped_jobs) ?? 0,
      blockedJobs: numberFromUnknown(row.blocked_jobs) ?? 0,
      completedJobs: numberFromUnknown(row.completed_jobs) ?? 0,
      activeJobs: numberFromUnknown(row.active_jobs) ?? 0,
    })),
    planningFiles: {
      plannedFiles: numberFromUnknown(raw.planning_files?.planned_files) ?? 0,
      indexedFiles: numberFromUnknown(raw.planning_files?.indexed_files) ?? 0,
      queuedFiles: numberFromUnknown(raw.planning_files?.queued_files) ?? 0,
      leasedFiles: numberFromUnknown(raw.planning_files?.leased_files) ?? 0,
      retryableFiles: numberFromUnknown(raw.planning_files?.retryable_files) ?? 0,
      failedTerminalFiles: numberFromUnknown(raw.planning_files?.failed_terminal_files) ?? 0,
    },
    activeSync: normalizeActiveSyncRun(raw.active_sync),
    veniceProgress: normalizeVeniceProgress(raw.venice_progress),
    fileSamples: normalizeFileSamples(raw.file_samples),
  };
}

function normalizeActiveSyncRun(raw: RawActiveSyncRun | null | undefined): ActiveSyncRun | null {
  if (!raw) return null;
  const events = numberFromUnknown(raw.events) ?? 0;
  const itemsSeen = numberFromUnknown(raw.items_seen) ?? 0;
  const itemsIndexed = numberFromUnknown(raw.items_indexed) ?? 0;
  if (events === 0 && itemsSeen === 0 && itemsIndexed === 0 && !stringValue(raw.started_at)) return null;
  return {
    runIdHash: stringValue(raw.run_id_hash),
    startedAt: stringValue(raw.started_at),
    status: stringValue(raw.status) ?? 'running',
    itemsSeen,
    itemsIndexed,
    events,
    upserted: numberFromUnknown(raw.upserted) ?? 0,
    tombstoned: numberFromUnknown(raw.tombstoned) ?? 0,
    skipped: numberFromUnknown(raw.skipped) ?? 0,
  };
}

function normalizeVeniceProgress(raw: RawVeniceProgress | undefined): VeniceProgress {
	  return {
	    plannedJobs: numberFromUnknown(raw?.planned_jobs) ?? 0,
	    queuedJobs: numberFromUnknown(raw?.queued_jobs) ?? 0,
	    leasedJobs: numberFromUnknown(raw?.leased_jobs) ?? 0,
	    leasedCurrentJobs: numberFromUnknown(raw?.leased_current_jobs) ?? numberFromUnknown(raw?.leased_jobs) ?? 0,
	    leasedExpiredJobs: numberFromUnknown(raw?.leased_expired_jobs) ?? 0,
	    indexedJobs: numberFromUnknown(raw?.indexed_jobs) ?? 0,
    metadataOnlyJobs: numberFromUnknown(raw?.metadata_only_jobs) ?? 0,
    retryableJobs: numberFromUnknown(raw?.retryable_jobs) ?? 0,
    failedTerminalJobs: numberFromUnknown(raw?.failed_terminal_jobs) ?? 0,
    blockedJobs: numberFromUnknown(raw?.blocked_jobs) ?? 0,
    skippedJobs: numberFromUnknown(raw?.skipped_jobs) ?? 0,
    completedJobs: numberFromUnknown(raw?.completed_jobs) ?? 0,
    activeJobs: numberFromUnknown(raw?.active_jobs) ?? 0,
    recipeStatuses: normalizeAggregateCounts(raw?.recipe_statuses),
    errorKindStatuses: normalizeAggregateCounts(raw?.error_kind_statuses),
  };
}

function normalizeAggregateCounts(rows: RawAggregateCount[] | undefined): AggregateCount[] {
  return (rows ?? []).map((row) => ({
    label: stringValue(row.label) ?? 'unknown',
    count: numberFromUnknown(row.count) ?? 0,
  }));
}

function normalizeFileSamples(rows: RawFileSample[] | undefined): FileSample[] {
  return (rows ?? []).slice(0, 96).map((row) => ({
    group: stringValue(row.group) ?? 'Sample',
    name: stringValue(row.name) ?? '(unnamed file)',
    status: stringValue(row.status) ?? 'unknown',
    pathDisplay: stringValue(row.path_display) ?? '',
    sizeBytes: numberFromUnknown(row.size_bytes),
    fileType: stringValue(row.file_type) ?? 'Unknown',
    extractorKind: stringValue(row.extractor_kind) ?? 'unknown',
    extractorVersion: stringValue(row.extractor_version) ?? '',
    attempts: numberFromUnknown(row.attempts) ?? 0,
    updatedAt: stringValue(row.updated_at),
    workflow: stringValue(row.workflow) ?? '',
    phase: stringValue(row.phase) ?? '',
    detail: stringValue(row.detail) ?? '',
    downloadPolicy: stringValue(row.download_policy) ?? '',
    policyDecision: stringValue(row.policy_decision) ?? '',
    priority: numberFromUnknown(row.priority) ?? 0,
    maxBytesPerFile: numberFromUnknown(row.max_bytes_per_file),
    createdAt: stringValue(row.created_at),
    leasedUntil: stringValue(row.leased_until),
    nextRetryAt: stringValue(row.next_retry_at),
    lastErrorKind: stringValue(row.last_error_kind),
	    tempBytesCleaned: booleanFromUnknown(row.temp_bytes_cleaned),
	    supersededByLocalSuccess: booleanFromUnknown(row.superseded_by_local_success) ?? false,
	    leaseState: stringValue(row.lease_state),
	  }));
}

function normalizeProviderPauses(rows: RawProviderPause[] | undefined): ProviderPause[] {
  return (rows ?? []).map((row) => {
    const errorKind = stringValue(row.error_kind);
    return {
      active: row.active !== false,
      kind: stringValue(row.kind) ?? (errorKind?.startsWith('venice_') ? 'venice' : 'provider'),
      reason: stringValue(row.reason) ?? 'provider_pause',
      errorKind,
      createdAt: stringValue(row.created_at),
      message: stringValue(row.message),
    };
  });
}

function normalizeVeniceCreditStatus(raw: RawVeniceCreditStatus | undefined): VeniceCreditStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const actions = Array.isArray(raw.actions)
    ? raw.actions.map((action) => stringValue(action)).filter((action): action is string => action !== null).slice(0, 6)
    : [];
  return {
    generatedAt: stringValue(raw.generated_at),
    status: stringValue(raw.status) ?? 'unknown',
    canConsume: typeof raw.can_consume === 'boolean' ? raw.can_consume : null,
    consumptionCurrency: stringValue(raw.consumption_currency),
    balances: normalizeNumberRecord(raw.balances),
    diemEpochAllocation: numberFromUnknown(raw.diem_epoch_allocation),
    errorKind: stringValue(raw.error_kind),
    errorMessage: stringValue(raw.error_message),
    actions,
  };
}

function normalizeNumberRecord(record: Record<string, unknown> | undefined): Record<string, number> {
  const output: Record<string, number> = {};
  if (!record) return output;
  for (const [key, value] of Object.entries(record)) {
    const number = numberFromUnknown(value);
    if (number !== null) output[key] = number;
  }
  return output;
}

function runCommand(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn(args, {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => {
      proc.kill();
    }, timeoutMs);

    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${args[0]} exited ${code}: ${stderr.trim().slice(0, 800)}`));
        return;
      }
      resolve(stdout);
    }).catch((error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function publicPollErrorMessage(rawError: string): string {
  const lower = rawError.toLowerCase();
  if (lower.includes('exit status 7') || lower.includes('connection refused') || lower.includes('failed to connect')) {
    return 'Could not reach the private-host source-worker status endpoint on this poll.';
  }
  if (lower.includes('ssh exited 255') || lower.includes('operation timed out') || lower.includes('network is unreachable')) {
    return 'Could not reach the private host over SSH on this poll.';
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return 'The live status poll timed out.';
  }
  return 'The live status poll failed.';
}

function appendHistory(history: LiveIngestionSnapshot[], snapshot: LiveIngestionSnapshot, now: Date): LiveIngestionSnapshot[] {
  const retentionStart = now.getTime() - HISTORY_RETENTION_MS;
  const retained = sortSnapshots([...history.map(slimHistorySnapshot), snapshot])
    .filter((sample) => sampleTime(sample) >= retentionStart);
  return retained.map((sample, index) => index === retained.length - 1 ? sample : slimHistorySnapshot(sample));
}

function loadHistory(path: string): LiveIngestionSnapshot[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return sortSnapshots(parsed.filter(isLiveSnapshot).map(hydrateLiveSnapshot));
  } catch {
    return [];
  }
}

function saveHistory(path: string, history: LiveIngestionSnapshot[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(history, null, 2));
}

function isLiveSnapshot(value: unknown): value is LiveIngestionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.sampledAt === 'string' && typeof record.counts === 'object' && typeof record.qa === 'object';
}

function hydrateLiveSnapshot(sample: LiveIngestionSnapshot): LiveIngestionSnapshot {
  const counts = sample.counts as LiveIngestionSnapshot['counts'] & {
    leasedCurrent?: number;
    leasedCurrentActionable?: number;
    leasedCurrentSuperseded?: number;
    leasedCurrentPolicyExcluded?: number;
    leasedExpired?: number;
    leasedExpiredActionable?: number;
    leasedExpiredSuperseded?: number;
    leasedExpiredPolicyExcluded?: number;
    leased?: number;
  };
  if (!Number.isFinite(Number(counts.leasedCurrent))) counts.leasedCurrent = Number(counts.leased) || 0;
  if (!Number.isFinite(Number(counts.leasedCurrentActionable))) counts.leasedCurrentActionable = counts.leasedCurrent;
  if (!Number.isFinite(Number(counts.leasedCurrentSuperseded))) counts.leasedCurrentSuperseded = 0;
  if (!Number.isFinite(Number(counts.leasedCurrentPolicyExcluded))) counts.leasedCurrentPolicyExcluded = 0;
  if (!Number.isFinite(Number(counts.leasedExpired))) counts.leasedExpired = 0;
  if (!Number.isFinite(Number(counts.leasedExpiredActionable))) counts.leasedExpiredActionable = counts.leasedExpired;
  if (!Number.isFinite(Number(counts.leasedExpiredSuperseded))) counts.leasedExpiredSuperseded = 0;
  if (!Number.isFinite(Number(counts.leasedExpiredPolicyExcluded))) counts.leasedExpiredPolicyExcluded = 0;
  const drainWorkers = sample.drainWorkers as LiveIngestionSnapshot['drainWorkers'] & {
    services?: DrainUnitService[];
  };
  if (drainWorkers && !Array.isArray(drainWorkers.services)) drainWorkers.services = [];
  return sample;
}

function sortSnapshots(history: LiveIngestionSnapshot[]): LiveIngestionSnapshot[] {
  return [...history].sort((left, right) => sampleTime(left) - sampleTime(right));
}

function sampleTime(sample: LiveIngestionSnapshot): number {
  const ms = Date.parse(sample.sampledAt);
  return Number.isFinite(ms) ? ms : 0;
}

function queueRemaining(sample: LiveIngestionSnapshot): number {
  const leasedCurrent = Number.isFinite(Number(sample.counts.leasedCurrent))
    ? Number(sample.counts.leasedCurrent)
    : Number(sample.counts.leased) || 0;
  const leasedExpired = Number.isFinite(Number(sample.counts.leasedExpired))
    ? Number(sample.counts.leasedExpired)
    : 0;
  return sample.counts.queued + leasedCurrent + leasedExpired + sample.counts.failed;
}

function actionableQueueRemaining(sample: LiveIngestionSnapshot): number {
  const leasedCurrent = Number.isFinite(Number(sample.counts.leasedCurrentActionable))
    ? Number(sample.counts.leasedCurrentActionable)
    : Number.isFinite(Number(sample.counts.leasedCurrent))
      ? Number(sample.counts.leasedCurrent)
      : Number(sample.counts.leased) || 0;
  const leasedExpired = Number.isFinite(Number(sample.counts.leasedExpiredActionable))
    ? Number(sample.counts.leasedExpiredActionable)
    : Number.isFinite(Number(sample.counts.leasedExpired))
      ? Number(sample.counts.leasedExpired)
      : 0;
  return sample.counts.queuedActionable + leasedCurrent + leasedExpired + sample.counts.failedActionable;
}

function veniceProgress(sample: LiveIngestionSnapshot): VeniceProgress {
  return sample.aggregates?.veniceProgress ?? normalizeVeniceProgress(undefined);
}

function etaHours(remaining: number, rate: number | null): number | null {
  if (!rate || rate <= 0) return null;
  return remaining / rate;
}

function ratePerHour(delta: number, minutes: number): number | null {
  if (minutes <= 0) return null;
  return delta * (60 / minutes);
}

function nonNegativeDelta(latest: number, baseline: number): number {
  return Math.max(0, latest - baseline);
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    if (!(key in source)) continue;
    const value = numberFromUnknown(source[key]);
    if (value !== null) return value;
  }
  return 0;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function booleanFromUnknown(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 't', 'yes', 'y', '1'].includes(normalized)) return true;
    if (['false', 'f', 'no', 'n', '0'].includes(normalized)) return false;
  }
  return null;
}

function saneBytes(value: unknown): number | null {
  const bytes = numberFromUnknown(value);
  if (bytes === null || bytes < 0 || bytes > 1_000_000_000_000_000) return null;
  return bytes;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringRecordValue(record: Record<string, unknown>, key: string): string | null {
  return stringValue(record[key]);
}

function normalizeDrainUnitStates(raw: Record<string, unknown>): Record<string, number> {
  const states: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const count = numberFromUnknown(value);
    if (count !== null) states[key] = count;
  }
  return states;
}

function normalizeOcrHelpers(
  raw: Record<string, unknown> | undefined,
  rawError: unknown,
): LiveIngestionSnapshot['ocrHelpers'] {
  const byName: Record<string, number> = {};
  const rawByName = raw?.by_name;
  if (rawByName && typeof rawByName === 'object' && !Array.isArray(rawByName)) {
    for (const [key, value] of Object.entries(rawByName as Record<string, unknown>)) {
      const count = numberFromUnknown(value);
      if (count !== null) byName[key] = count;
    }
  }
  const active = numberFromUnknown(raw?.active) ?? Object.values(byName).reduce((sum, count) => sum + count, 0);
  return {
    active,
    byName,
    error: stringValue(rawError),
  };
}

function normalizeContinuousDrainUnitStates(raw: RawRemoteProbe): Record<string, number> {
  const details = Array.isArray(raw.drain_unit_details) ? raw.drain_unit_details : [];
  if (details.length === 0) return normalizeDrainUnitStates(raw.drain_units ?? {});

  const states: Record<string, number> = {};
  for (const detail of details) {
    const activeState = stringValue(detail.active_state) ?? 'unknown';
    const subState = stringValue(detail.sub_state) ?? 'unknown';
    const key = `${activeState}/${subState}`;
    states[key] = (states[key] ?? 0) + 1;
  }
  return states;
}

function normalizeDrainUnitServices(rows: RawDrainUnitDetail[] | undefined): DrainUnitService[] {
  return (rows ?? []).slice(0, 16).map((row) => {
    const unit = stringValue(row.unit) ?? 'unknown.service';
    const activeState = stringValue(row.active_state) ?? (row.error ? 'unknown' : 'inactive');
    const subState = stringValue(row.sub_state) ?? (row.error ? 'error' : 'unknown');
    return {
      unit,
      label: serviceLabel(unit),
      activeState,
      subState,
      health: activeState === 'active' && subState === 'running'
        ? 'healthy'
        : activeState === 'unknown' && subState === 'error'
          ? 'attention'
          : 'unknown',
    };
  });
}

function serviceLabel(unit: string): string {
  if (unit === 'olympus-source-embedding-drain.service') return 'Embedding drain';
  if (unit === 'olympus-source-processing-supervisor.service') return 'Default supervisor';
  if (unit === 'olympus-source-processing-supervisor-local-ocr.service') return 'Local OCR supervisor';
  if (unit === 'olympus-source-processing-supervisor-local-vlm-visual-repair.service') return 'Local VLM repair supervisor';
  if (unit === 'olympus-source-processing-supervisor-venice-grok43.service') return 'Venice/Grok supervisor';
  if (unit === 'olympus-source-processing-supervisor-venice-grok43-areas.service') return 'Venice/Grok Areas supervisor';
  if (unit === 'olympus-source-processing-supervisor-venice-grok43-resources.service') return 'Venice/Grok Resources supervisor';
  return unit.replace(/^olympus-source-/, '').replace(/\.service$/, '').replace(/-/g, ' ');
}

function sumFailedDrainStates(states: Record<string, number>): number {
  return Object.entries(states)
    .filter(([key]) => key.startsWith('failed/') || key.endsWith('/failed'))
    .reduce((sum, [, value]) => sum + value, 0);
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  if (options.once) {
    const snapshot = await fetchLiveSnapshot(options);
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    await startLiveDashboardServer(options);
  }
}
