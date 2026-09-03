import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

type DashboardStatus = 'ready' | 'watch' | 'attention' | 'unknown';

interface SourceReadinessReport {
  kind: 'source_readiness_proof';
  generated_at: string;
  status: DashboardStatus;
  corpora?: SourceReadinessCorpus[];
  approved_non_message_corpora?: SourceReadinessCorpus[];
  actions: string[];
}

interface SourceReadinessCorpus {
  corpus_id: string;
  family: string;
  trust_domain: string;
  activation_mode?: string;
  status: DashboardStatus;
  counts: {
    indexed_items: number;
    chunks: number;
    embedded_chunks: number;
    sync_runs: number;
    extraction_failed?: number;
    extraction_queued?: number;
    extraction_leased?: number;
  };
  qa?: {
    total_items: number;
    pass: number;
    metadata_only_expected: number;
    metadata_only_gap: number;
    low_confidence_retry_local: number;
    low_confidence_candidate_for_venice: number;
    blocked_policy: number;
    failed_needs_operator: number;
    pending: number;
    visible_gaps: number;
    low_confidence: number;
  };
  embedding: {
    required: boolean;
    ready: boolean;
    coverage_ratio?: number;
  };
  retrieval?: {
    declared_mode: string;
    servable_mode: 'keyword' | 'hybrid';
    state: 'ready' | 'degraded';
    reason?: string;
  };
  actions: string[];
}

interface SourceProcessingSupervisorReport {
  kind: 'source_processing_supervisor_report';
  generated_at: string;
  status: DashboardStatus | 'progress' | 'idle' | 'parked';
  cycles_run: number;
  exhausted_cycle_budget: boolean;
  exhausted_time_budget: boolean;
  scopes: SupervisorScope[];
  summary: {
    jobs_leased: number;
    jobs_planned: number;
    jobs_existing: number;
    terminal_progress_jobs: number;
    failed_retryable_jobs: number;
    embed_runs: number;
    queued_before: number;
    queued_after: number;
    leased_before: number;
    leased_after: number;
  };
  actions: string[];
}

interface SupervisorScope {
  scope_key_hash: string;
  status: DashboardStatus | 'progress' | 'idle' | 'parked';
  cycles_run: number;
  jobs_leased: number;
  jobs_planned: number;
  terminal_progress_jobs: number;
  failed_retryable_jobs: number;
  embed_runs: number;
  counts: Record<string, number>;
  errors: string[];
  before?: QueueSnapshot;
  after?: QueueSnapshot;
}

interface QueueSnapshot {
  indexed_items: number;
  chunks: number;
  embedded_chunks: number;
  extraction_queued: number;
  extraction_leased: number;
  extraction_failed: number;
}

interface AggregateCount {
  label: string;
  count: number;
}

interface DropboxEmbeddingLane {
  label: string;
  files: number;
  chunks: number;
  embedded_chunks: number;
}

interface DropboxExtractionLane {
  label: string;
  files: number;
  extracted: number;
  terminal: number;
}

interface DropboxPlanningMetrics {
  planned_files: number;
  indexed_files: number;
  queued_files: number;
  leased_files: number;
  retryable_files: number;
  failed_terminal_files: number;
}

interface DropboxAggregateMetrics {
  file_types: AggregateCount[];
  mime_types: AggregateCount[];
  extraction_statuses: AggregateCount[];
  job_statuses: AggregateCount[];
  failed_error_kinds: AggregateCount[];
  extractor_kinds: AggregateCount[];
  sync_job_statuses: AggregateCount[];
  crawl_frontier_statuses: AggregateCount[];
  embedding_lanes: DropboxEmbeddingLane[];
  extraction_lanes: DropboxExtractionLane[];
  planning_files: DropboxPlanningMetrics;
  chunked_files: number;
  artifact_files: number;
}

type PhaseTone = 'good' | 'muted' | 'warn' | 'review' | 'info' | 'danger';

interface PhaseLane {
  label: string;
  done: number;
  total: number;
  detail: string;
  tone?: PhaseTone;
}

interface PhaseAttention {
  label: string;
  value: number;
  detail?: string;
  tone: PhaseTone;
}

interface PhaseMonitor {
  id: string;
  title: string;
  description: string;
  primaryLabel: string;
  unit: string;
  total: number;
  done: number;
  remaining: number;
  blocked: number;
  speedPerHour?: number;
  speedUnit: string;
  eta?: string;
  statusNote: string;
  ready?: PhaseLane;
  lanes?: PhaseLane[];
  attention?: PhaseAttention[];
}

interface DashboardOptions {
  readiness: SourceReadinessReport;
  supervisor?: SourceProcessingSupervisorReport;
  aggregates?: DropboxAggregateMetrics;
  generatedAt?: Date;
  timerIntervalMinutes?: number;
  latestRunDurationSeconds?: number;
}

interface DashboardViewModel {
  generatedAt: string;
  readinessGeneratedAt: string;
  supervisorGeneratedAt?: string;
  status: DashboardStatus;
  dropbox: SourceReadinessCorpus;
  supervisor?: SourceProcessingSupervisorReport;
  aggregates: DropboxAggregateMetrics;
  throughput: {
    terminalJobsLastRun: number;
    scheduledJobsPerHour?: number;
    activeJobsPerHour?: number;
    scheduledEta?: string;
    activeEta?: string;
  };
  phases: PhaseMonitor[];
  corpusParity: Array<{
    corpusId: string;
    chunks: number;
    embeddedChunks: number;
    missingChunks: number;
    refreshNeeded: boolean;
    retrievalState: 'ready' | 'degraded' | 'unknown';
  }>;
  monitorIdeas: string[];
}

const DROPBOX_CORPUS_ID = 'secure_local.dropbox.files';
const DEFAULT_TIMER_INTERVAL_MINUTES = 10;
const SCOPE_LABELS: Record<string, string> = {
  '933d4c6abe9c22d4': '/1 Projects',
  b5480422806b2019: '/2 Areas',
  '3d77d4bd923ae033': '/3 Resources',
};

export function buildSourceIngestionDashboardViewModel(options: DashboardOptions): DashboardViewModel {
  const readinessCorpora = options.readiness.corpora ?? options.readiness.approved_non_message_corpora ?? [];
  const dropbox = readinessCorpora.find((corpus) => corpus.corpus_id === DROPBOX_CORPUS_ID);
  if (!dropbox) throw new Error(`Readiness report did not include ${DROPBOX_CORPUS_ID}.`);
  const aggregates = options.aggregates ?? emptyAggregates();
  const timerIntervalMinutes = options.timerIntervalMinutes ?? DEFAULT_TIMER_INTERVAL_MINUTES;
  const terminalJobsLastRun = options.supervisor?.summary.terminal_progress_jobs ?? 0;
  const queued = dropbox.counts.extraction_queued ?? 0;
  const leased = dropbox.counts.extraction_leased ?? 0;
  const failed = dropbox.counts.extraction_failed ?? 0;
  const remainingJobs = queued + leased + failed;
  const scheduledJobsPerHour = terminalJobsLastRun > 0 && timerIntervalMinutes > 0
    ? terminalJobsLastRun * (60 / timerIntervalMinutes)
    : undefined;
  const activeJobsPerHour = terminalJobsLastRun > 0 && options.latestRunDurationSeconds && options.latestRunDurationSeconds > 0
    ? terminalJobsLastRun * (3600 / options.latestRunDurationSeconds)
    : undefined;
  const throughput = {
    terminalJobsLastRun,
    ...(scheduledJobsPerHour ? { scheduledJobsPerHour } : {}),
    ...(activeJobsPerHour ? { activeJobsPerHour } : {}),
    ...(scheduledJobsPerHour ? { scheduledEta: etaLabel(remainingJobs, scheduledJobsPerHour) } : {}),
    ...(activeJobsPerHour ? { activeEta: etaLabel(remainingJobs, activeJobsPerHour) } : {}),
  };
  return {
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    readinessGeneratedAt: options.readiness.generated_at,
    ...(options.supervisor ? { supervisorGeneratedAt: options.supervisor.generated_at } : {}),
    status: normalizeDashboardStatus(options.readiness.status),
    dropbox,
    ...(options.supervisor ? { supervisor: options.supervisor } : {}),
    aggregates,
    throughput,
    phases: buildPhaseMonitors(dropbox, options.supervisor, aggregates, throughput),
    corpusParity: readinessCorpora.map((corpus) => ({
      corpusId: corpus.corpus_id,
      chunks: corpus.counts.chunks,
      embeddedChunks: corpus.counts.embedded_chunks,
      missingChunks: Math.max(0, corpus.counts.chunks - corpus.counts.embedded_chunks),
      refreshNeeded: corpus.embedding.required && corpus.counts.embedded_chunks < corpus.counts.chunks,
      retrievalState: corpus.retrieval?.state ?? 'unknown',
    })),
    monitorIdeas: [
      'Backlog: queued, leased, failed, pending, and whether planning is adding work faster than extraction drains it.',
      'Throughput: jobs/hour by latest run, rolling 1h/6h/24h, per scope, and per extractor kind.',
      'ETA: finish time at current scheduled pace, continuous-drain pace, and target appliance pace.',
      'Quality: QA pass, expected metadata-only, metadata gaps, low-confidence local retry, and Venice/Grok escalation candidates.',
      'Coverage: files with chunks, files with artifacts, embedding coverage, and searchable evidence coverage.',
      'Blockers: failed jobs, stuck leases, aborted scopes, provider/network errors, private worker restarts, and model endpoint health.',
      'File mix: MIME families, largest backlog families, PDFs/images/Office/table/audio splits, and unsupported types.',
      'Scope health: /1 Projects, /2 Areas, /3 Resources queue depth, errors, throughput, and ETA independently.',
      'Appliance load: Delphi CPU/GPU/memory, model queue depth, model latency, worker concurrency, and retry rate.',
      'Privacy posture: S4/S5 counts, blocked-policy counts, classification needs-review, and owner-label calibration drift.',
      'Cost/offload: local vs Venice/Grok escalation volume, success rate, timeout rate, and items waiting for trusted-provider vision.',
      'Freshness: last successful sync, last extraction progress, last embedding run, and stale-report age.',
    ],
  };
}

export function renderSourceIngestionDashboardHtml(model: DashboardViewModel): string {
  const dropbox = model.dropbox;
  const qa = dropbox.qa;
  const counts = dropbox.counts;
  const totalFiles = qa?.total_items ?? counts.indexed_items;
  const queued = counts.extraction_queued ?? 0;
  const leased = counts.extraction_leased ?? 0;
  const failed = counts.extraction_failed ?? 0;
  const remaining = queued + leased + failed;
  const chunkCoverage = totalFiles > 0 ? pct(model.aggregates.chunked_files / totalFiles) : 0;
  const artifactCoverage = totalFiles > 0 ? pct(model.aggregates.artifact_files / totalFiles) : 0;
  const embeddingCoverage = counts.chunks > 0 ? pct(counts.embedded_chunks / counts.chunks) : 0;
  const qaSegments = qa
    ? [
      { label: 'QA pass', value: qa.pass, className: 'good' },
      { label: 'Expected metadata-only', value: qa.metadata_only_expected, className: 'muted' },
      { label: 'Metadata gaps', value: qa.metadata_only_gap, className: 'warn' },
      { label: 'Low-confidence', value: qa.low_confidence, className: 'review' },
      { label: 'Pending', value: qa.pending, className: 'info' },
      { label: 'Blocked policy', value: qa.blocked_policy, className: 'danger' },
    ]
    : [];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <title>Olympus Source Ingestion Dashboard</title>
  <style>
    :root {
      --bg: #f7f8f4;
      --ink: #1c211f;
      --subtle: #5a625e;
      --line: #d8ddd2;
      --panel: #ffffff;
      --green: #2f7d5c;
      --teal: #177f86;
      --amber: #b97517;
      --red: #b5413d;
      --violet: #6d5cae;
      --blue: #3c6e9f;
      --gray: #7b817d;
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; background: var(--bg); }
    main { width: min(1480px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 40px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 16px 0 20px; border-bottom: 1px solid var(--line); }
    h1 { margin: 0; font-size: 28px; line-height: 1.15; font-weight: 750; letter-spacing: 0; }
    .subtitle { margin: 8px 0 0; color: var(--subtle); font-size: 14px; line-height: 1.45; max-width: 820px; }
    .status-pill { display: inline-flex; align-items: center; min-height: 32px; padding: 0 12px; border-radius: 6px; font-weight: 700; font-size: 13px; white-space: nowrap; border: 1px solid var(--line); background: var(--panel); }
    .status-pill.attention { color: var(--red); border-color: #efc0bb; background: #fff4f2; }
    .status-pill.ready { color: var(--green); border-color: #bddbc9; background: #f1fbf4; }
    .grid { display: grid; gap: 14px; }
    .process-summary { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 420px); gap: 14px; margin-top: 18px; align-items: stretch; }
    .process-copy { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .process-copy p { margin: 0; color: var(--subtle); font-size: 14px; line-height: 1.5; }
    .process-flow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
    .process-step { border: 1px solid var(--line); border-radius: 7px; padding: 10px; min-height: 72px; background: #fafbf8; }
    .process-step strong { display: block; font-size: 13px; }
    .process-step span { display: block; margin-top: 5px; color: var(--subtle); font-size: 12px; line-height: 1.3; }
    .overall { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-top: 18px; }
    .overall-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 12px; }
    .overall-title { margin: 0; font-size: 18px; line-height: 1.2; font-weight: 780; }
    .overall-note { margin: 6px 0 0; color: var(--subtle); font-size: 13px; line-height: 1.4; max-width: 960px; }
    .overall-value { text-align: right; font-variant-numeric: tabular-nums; font-weight: 760; white-space: nowrap; }
    .phase-grid { display: grid; grid-template-columns: repeat(2, minmax(360px, 1fr)); gap: 14px; }
    .phase-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 15px; min-height: 330px; display: grid; gap: 12px; align-content: start; }
    .phase-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .phase-title { margin: 0; font-size: 16px; line-height: 1.2; font-weight: 760; }
    .phase-desc { margin: 6px 0 0; color: var(--subtle); font-size: 12px; line-height: 1.35; }
    .phase-note { color: var(--subtle); font-size: 12px; line-height: 1.35; border-top: 1px solid var(--line); padding-top: 10px; }
    .primary-progress { display: grid; gap: 8px; }
    .progress-top { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .progress-label { font-weight: 730; font-size: 13px; }
    .progress-value { color: var(--subtle); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
    .progress-track { height: 14px; border-radius: 7px; background: #e9ede6; border: 1px solid #dfe4dc; overflow: hidden; }
    .progress-track.large { height: 18px; border-radius: 7px; }
    .progress-fill { height: 100%; min-width: 1px; background: var(--teal); }
    .progress-fill.good { background: var(--green); }
    .progress-fill.muted { background: var(--gray); }
    .progress-fill.warn { background: var(--amber); }
    .progress-fill.review { background: var(--violet); }
    .progress-fill.info { background: var(--blue); }
    .progress-fill.danger { background: var(--red); }
    .progress-help { color: var(--subtle); font-size: 12px; line-height: 1.35; }
    .phase-lanes { display: grid; gap: 8px; margin-top: 2px; }
    .ready-bar { display: grid; gap: 6px; border: 1px solid var(--line); border-radius: 7px; padding: 9px; background: #fafbf8; }
    .ready-bar .progress-label { font-size: 12px; }
    .lane { display: grid; gap: 5px; font-size: 12px; }
    .lane-row { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
    .lane-name { overflow-wrap: anywhere; font-weight: 650; }
    .lane-detail { color: var(--subtle); text-align: right; font-variant-numeric: tabular-nums; }
    .attention-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .attention-item { border-left: 4px solid var(--gray); border-radius: 6px; background: #fafbf8; padding: 8px 9px; min-height: 58px; }
    .attention-item.good { border-left-color: var(--green); }
    .attention-item.warn { border-left-color: var(--amber); }
    .attention-item.review { border-left-color: var(--violet); }
    .attention-item.info { border-left-color: var(--blue); }
    .attention-item.danger { border-left-color: var(--red); }
    .attention-item strong { display: block; font-size: 15px; line-height: 1; font-variant-numeric: tabular-nums; }
    .attention-item span { display: block; margin-top: 5px; color: var(--subtle); font-size: 11px; line-height: 1.25; }
    .speed-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .speed-kpi { border: 1px solid var(--line); border-radius: 7px; background: #fafbf8; padding: 8px; min-height: 56px; }
    .speed-kpi strong { display: block; font-size: 14px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .speed-kpi span { display: block; margin-top: 5px; color: var(--subtle); font-size: 11px; }
    .metrics { grid-template-columns: repeat(6, minmax(150px, 1fr)); margin-top: 18px; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; min-height: 104px; }
    .metric .label { color: var(--subtle); font-size: 12px; line-height: 1.3; font-weight: 650; text-transform: uppercase; }
    .metric .value { margin-top: 8px; font-size: 27px; line-height: 1; font-weight: 780; letter-spacing: 0; }
    .metric .hint { margin-top: 9px; color: var(--subtle); font-size: 12px; line-height: 1.35; }
    .sections { grid-template-columns: minmax(0, 1.15fr) minmax(360px, 0.85fr); margin-top: 14px; align-items: start; }
    section { background: transparent; border-top: 1px solid var(--line); padding-top: 18px; }
    h2 { margin: 0 0 12px; font-size: 17px; line-height: 1.2; letter-spacing: 0; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .progress-stack { height: 34px; display: flex; width: 100%; overflow: hidden; border-radius: 7px; border: 1px solid var(--line); background: #eef0eb; }
    .segment { min-width: 1px; height: 100%; }
    .segment.good { background: var(--green); }
    .segment.muted { background: var(--gray); }
    .segment.warn { background: var(--amber); }
    .segment.review { background: var(--violet); }
    .segment.info { background: var(--blue); }
    .segment.danger { background: var(--red); }
    .legend { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 14px; margin-top: 14px; }
    .legend-item { display: flex; align-items: center; gap: 8px; color: var(--subtle); font-size: 13px; min-width: 0; }
    .swatch { width: 11px; height: 11px; border-radius: 3px; flex: 0 0 auto; background: var(--gray); }
    .swatch.good { background: var(--green); }
    .swatch.muted { background: var(--gray); }
    .swatch.warn { background: var(--amber); }
    .swatch.review { background: var(--violet); }
    .swatch.info { background: var(--blue); }
    .swatch.danger { background: var(--red); }
    .bar-list { display: grid; gap: 9px; }
    .bar-row { display: grid; grid-template-columns: minmax(132px, 220px) minmax(120px, 1fr) 88px; gap: 10px; align-items: center; font-size: 13px; }
    .bar-label { color: var(--ink); overflow-wrap: anywhere; }
    .bar-track { height: 13px; border-radius: 5px; background: #ecefea; overflow: hidden; border: 1px solid #dfe4dc; }
    .bar-fill { height: 100%; background: var(--teal); min-width: 1px; }
    .bar-fill.warn { background: var(--amber); }
    .bar-fill.danger { background: var(--red); }
    .bar-fill.violet { background: var(--violet); }
    .bar-value { text-align: right; color: var(--subtle); font-variant-numeric: tabular-nums; }
    .scope-grid { display: grid; gap: 10px; }
    .scope { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
    .scope-title { font-weight: 760; font-size: 14px; }
    .scope-status { margin-top: 5px; color: var(--subtle); font-size: 12px; }
    .scope-kpis { display: grid; grid-template-columns: repeat(4, minmax(80px, 1fr)); gap: 8px; }
    .mini { padding: 8px; border-left: 3px solid var(--line); background: #fafbf8; min-height: 54px; }
    .mini strong { display: block; font-size: 16px; line-height: 1; }
    .mini span { display: block; margin-top: 5px; color: var(--subtle); font-size: 11px; line-height: 1.2; }
    .blockers { display: grid; gap: 8px; }
    .blocker { border-left: 4px solid var(--amber); background: var(--panel); border-radius: 6px; padding: 10px 12px; font-size: 13px; line-height: 1.35; color: var(--ink); }
    .blocker.danger { border-left-color: var(--red); }
    .brainstorm { columns: 2 320px; column-gap: 28px; margin: 0; padding-left: 18px; }
    .brainstorm li { break-inside: avoid; margin: 0 0 9px; line-height: 1.38; color: var(--ink); }
    .footer { margin-top: 18px; color: var(--subtle); font-size: 12px; line-height: 1.4; }
    @media (max-width: 1100px) {
      .metrics { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
      .sections { grid-template-columns: 1fr; }
      .phase-grid { grid-template-columns: 1fr; }
      .process-summary { grid-template-columns: 1fr; }
    }
    @media (max-width: 680px) {
      main { width: min(100% - 20px, 1480px); padding-top: 12px; }
      .topbar { flex-direction: column; gap: 12px; }
      .metrics { grid-template-columns: 1fr 1fr; }
      .overall-head { flex-direction: column; }
      .overall-value { text-align: left; }
      .legend { grid-template-columns: 1fr; }
      .bar-row { grid-template-columns: 1fr; gap: 5px; }
      .bar-value { text-align: left; }
      .scope { grid-template-columns: 1fr; }
      .scope-kpis { grid-template-columns: 1fr 1fr; }
      .phase-grid { grid-template-columns: 1fr; }
      .process-flow { grid-template-columns: 1fr; }
      .lane { grid-template-columns: 1fr; }
      .lane-detail { text-align: left; }
      .attention-grid, .speed-strip { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <div class="topbar">
      <div>
        <h1>Olympus Source Ingestion</h1>
        <p class="subtitle">Counts-only dashboard for Dropbox ingestion through the secure-local source pipeline. Generated ${escapeHtml(formatDateTime(model.generatedAt))}; readiness report ${escapeHtml(formatDateTime(model.readinessGeneratedAt))}${model.supervisorGeneratedAt ? `; supervisor report ${escapeHtml(formatDateTime(model.supervisorGeneratedAt))}` : ''}.</p>
      </div>
      <div class="status-pill ${escapeHtml(model.status)}">${escapeHtml(model.status.toUpperCase())}</div>
    </div>

    <section class="process-summary">
      <div class="process-copy">
        <h2>How Ingestion Works</h2>
        <p>Dropbox ingestion is a pipeline, not one single "done" state. Olympus first maps provider metadata, then plans content jobs, extracts secure-local derivatives, classifies/privacy-gates the results, embeds searchable chunks locally, and finally exposes bounded evidence to search and answers. A file can be mapped but not extracted, extracted but not embedded, embedded but still low-confidence, or blocked by policy.</p>
        <div class="process-flow">
          <div class="process-step"><strong>1. Metadata Sync</strong><span>Discover files, folders, revisions, MIME types, and provider freshness.</span></div>
          <div class="process-step"><strong>2. Plan & Queue</strong><span>Turn eligible mapped files and QA gaps into extraction jobs.</span></div>
          <div class="process-step"><strong>3. Extract</strong><span>Create text chunks, artifacts, facts, OCR/VLM outputs, or metadata-only terminal states.</span></div>
          <div class="process-step"><strong>4. Classify & QA</strong><span>Apply S0-S5/privacy policy and score whether extraction quality is good enough.</span></div>
          <div class="process-step"><strong>5. Embed</strong><span>Embed secure-local chunks with local-only embedding lanes.</span></div>
          <div class="process-step"><strong>6. Answer Ready</strong><span>Make bounded evidence searchable and usable by Castor without raw source leakage.</span></div>
        </div>
      </div>
      <div class="panel">
        <h2>Live Refresh</h2>
        <p class="subtitle">This static page auto-refreshes every 60 seconds. The speedometers update when the dashboard file is regenerated from the latest private-host reports or served by a live endpoint.</p>
        ${metricCard('Current status', model.status.toUpperCase(), 'Counts-only source-readiness posture.')}
      </div>
    </section>

    ${renderOverallProgress(model)}

    <section style="margin-top:18px">
      <h2>Phase Monitors</h2>
      <div class="phase-grid">
        ${model.phases.map(renderPhaseCard).join('\n')}
      </div>
    </section>

    <div class="grid metrics">
      ${metricCard('Files mapped', totalFiles, 'Known Dropbox file records in approved roots.')}
      ${metricCard('Queue remaining', remaining, `${formatNumber(queued)} queued, ${formatNumber(leased)} leased, ${formatNumber(failed)} failed.`)}
      ${metricCard('QA pass', qa?.pass ?? 0, `${qa ? pctLabel(qa.pass, totalFiles) : 'n/a'} of mapped files pass current QA.`)}
      ${metricCard('Visible gaps', qa?.visible_gaps ?? 0, 'Items still needing extraction, review, retry, or escalation.')}
      ${metricCard('Embedded chunks', `${formatNumber(counts.embedded_chunks)} / ${formatNumber(counts.chunks)}`, `${embeddingCoverage.toFixed(1)}% embedding coverage.`)}
      ${metricCard('Throughput', throughputLabel(model), etaHint(model))}
    </div>

    <section style="margin-top:18px">
      <h2>Corpus Embedding Parity</h2>
      <div class="panel">
        <div class="phase-lanes">
          ${model.corpusParity.map((corpus) => `
            <div class="lane">
              <div class="lane-row">
                <div class="lane-name">${escapeHtml(corpus.corpusId)}</div>
                <div class="lane-detail">${formatNumber(corpus.embeddedChunks)} / ${formatNumber(corpus.chunks)} embedded · ${formatNumber(corpus.missingChunks)} missing · ${corpus.refreshNeeded ? 'REFRESH NEEDED' : 'current'} · retrieval ${escapeHtml(corpus.retrievalState)}</div>
              </div>
            </div>`).join('\n')}
        </div>
      </div>
    </section>

    <div class="grid sections">
      <section>
        <h2>Ingestion State</h2>
        <div class="panel">
          ${stackedProgress(qaSegments, totalFiles)}
          <div class="legend">
            ${qaSegments.map((segment) => legendItem(segment.label, segment.value, totalFiles, segment.className)).join('\n')}
          </div>
        </div>
      </section>

      <section>
        <h2>Blockers</h2>
        <div class="blockers">
          ${blockers(model).map((blocker) => `<div class="blocker ${blocker.severity}">${escapeHtml(blocker.text)}</div>`).join('\n')}
        </div>
      </section>
    </div>

    <div class="grid sections">
      <section>
        <h2>Scope Health</h2>
        <div class="scope-grid">
          ${(model.supervisor?.scopes ?? []).map(renderScope).join('\n') || '<div class="panel">No supervisor scope report available.</div>'}
        </div>
      </section>

      <section>
        <h2>Queue And Job Mix</h2>
        <div class="panel">
          ${barList('Job status', model.aggregates.job_statuses, 'warn')}
          <div style="height:14px"></div>
          ${barList('Failed error kinds', model.aggregates.failed_error_kinds, 'danger')}
        </div>
      </section>
    </div>

    <div class="grid sections">
      <section>
        <h2>File Types</h2>
        <div class="panel">
          ${barList('Broad families', model.aggregates.file_types, 'teal')}
          <div style="height:14px"></div>
          ${barList('Top MIME types', model.aggregates.mime_types.slice(0, 10), 'violet')}
        </div>
      </section>

      <section>
        <h2>Coverage</h2>
        <div class="panel">
          ${barList('Extraction status', model.aggregates.extraction_statuses, 'warn')}
          <div style="height:14px"></div>
          ${coverageLine('Files with chunks', model.aggregates.chunked_files, totalFiles, chunkCoverage)}
          ${coverageLine('Files with artifacts', model.aggregates.artifact_files, totalFiles, artifactCoverage)}
          ${coverageLine('Embedded chunks', counts.embedded_chunks, counts.chunks, embeddingCoverage)}
        </div>
      </section>
    </div>

    <section style="margin-top:18px">
      <h2>What Else To Monitor</h2>
      <div class="panel">
        <ul class="brainstorm">
          ${model.monitorIdeas.map((idea) => `<li>${escapeHtml(idea)}</li>`).join('\n')}
        </ul>
      </div>
    </section>

    <div class="footer">This page is static. Refresh it by regenerating the dashboard from the latest counts-only reports.</div>
  </main>
</body>
</html>`;
}

export function readDropboxAggregateMetrics(dbPath: string): DropboxAggregateMetrics {
  const db = new Database(dbPath, { readonly: true });
  try {
    // Reads a live store the sync loop may be checkpointing: without a timeout
    // the dashboard fails instantly on contention instead of waiting for it.
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
    const fileRows = db.query(`
      SELECT mime_type AS mime_type, COUNT(*) AS count
      FROM entries
      WHERE entry_type = 'file' AND tombstoned = 0
      GROUP BY COALESCE(NULLIF(mime_type, ''), 'unknown')
      ORDER BY count DESC
      LIMIT 40
    `).all() as Array<{ mime_type: string | null; count: number }>;
    return {
      file_types: aggregateBroadFileTypes(fileRows),
      mime_types: fileRows.map((row) => ({ label: row.mime_type?.trim() || 'unknown', count: Number(row.count) })),
      extraction_statuses: countRows(db, `
        SELECT extraction_status AS label, COUNT(*) AS count
        FROM entries
        WHERE entry_type = 'file' AND tombstoned = 0
        GROUP BY extraction_status
        ORDER BY count DESC
      `),
      job_statuses: countRows(db, `
        SELECT status AS label, COUNT(*) AS count
        FROM content_extraction_jobs
        GROUP BY status
        ORDER BY count DESC
      `),
      failed_error_kinds: countRows(db, `
        SELECT COALESCE(NULLIF(last_error_kind, ''), 'unknown') AS label, COUNT(*) AS count
        FROM content_extraction_jobs
        WHERE status LIKE 'failed%'
        GROUP BY COALESCE(NULLIF(last_error_kind, ''), 'unknown')
        ORDER BY count DESC
      `),
      extractor_kinds: countRows(db, `
        SELECT extractor_kind AS label, COUNT(*) AS count
        FROM content_extraction_jobs
        GROUP BY extractor_kind
        ORDER BY count DESC
      `),
      sync_job_statuses: countRows(db, `
        SELECT status AS label, COUNT(*) AS count
        FROM sync_jobs
        GROUP BY status
        ORDER BY count DESC
      `),
      crawl_frontier_statuses: countRows(db, `
        SELECT status AS label, COUNT(*) AS count
        FROM crawl_frontier
        GROUP BY status
        ORDER BY count DESC
      `),
      embedding_lanes: aggregateEmbeddingLanes(db.query(`
        SELECT
          e.mime_type AS mime_type,
          COUNT(DISTINCT e.local_entry_id) AS files,
          COUNT(DISTINCT c.chunk_id) AS chunks,
          COUNT(DISTINCT emb.chunk_id) AS embedded_chunks
        FROM entries e
        LEFT JOIN content_chunks_secure_local c ON c.local_entry_id = e.local_entry_id
        LEFT JOIN content_chunk_embeddings_secure_local emb ON emb.chunk_id = c.chunk_id
        WHERE e.entry_type = 'file' AND e.tombstoned = 0
        GROUP BY COALESCE(NULLIF(e.mime_type, ''), 'unknown')
        ORDER BY chunks DESC, files DESC
        LIMIT 40
      `).all() as Array<{ mime_type: string | null; files: number; chunks: number; embedded_chunks: number }>),
      extraction_lanes: aggregateExtractionLanes(db.query(`
        SELECT
          e.mime_type AS mime_type,
          COUNT(*) AS files,
          SUM(CASE WHEN e.extraction_status = 'extracted' THEN 1 ELSE 0 END) AS extracted,
          SUM(CASE WHEN e.extraction_status IN ('extracted', 'metadata_only', 'skipped_unsupported', 'skipped_too_large', 'blocked_policy', 'failed') THEN 1 ELSE 0 END) AS terminal
        FROM entries e
        WHERE e.entry_type = 'file' AND e.tombstoned = 0
        GROUP BY COALESCE(NULLIF(e.mime_type, ''), 'unknown')
        ORDER BY files DESC
        LIMIT 40
      `).all() as Array<{ mime_type: string | null; files: number; extracted: number; terminal: number }>),
      planning_files: {
        planned_files: scalarCount(db, 'SELECT COUNT(DISTINCT local_entry_id) AS count FROM content_extraction_jobs'),
        indexed_files: scalarCount(db, "SELECT COUNT(DISTINCT local_entry_id) AS count FROM content_extraction_jobs WHERE status = 'indexed'"),
        queued_files: scalarCount(db, "SELECT COUNT(DISTINCT local_entry_id) AS count FROM content_extraction_jobs WHERE status = 'queued'"),
        leased_files: scalarCount(db, "SELECT COUNT(DISTINCT local_entry_id) AS count FROM content_extraction_jobs WHERE status = 'leased'"),
        retryable_files: scalarCount(db, "SELECT COUNT(DISTINCT local_entry_id) AS count FROM content_extraction_jobs WHERE status = 'failed_retryable'"),
        failed_terminal_files: scalarCount(db, "SELECT COUNT(DISTINCT local_entry_id) AS count FROM content_extraction_jobs WHERE status = 'failed_terminal'"),
      },
      chunked_files: scalarCount(db, 'SELECT COUNT(DISTINCT local_entry_id) AS count FROM content_chunks_secure_local'),
      artifact_files: scalarCount(db, 'SELECT COUNT(DISTINCT local_entry_id) AS count FROM content_artifacts_secure_local'),
    };
  } finally {
    db.close();
  }
}

function buildPhaseMonitors(
  dropbox: SourceReadinessCorpus,
  supervisor: SourceProcessingSupervisorReport | undefined,
  aggregates: DropboxAggregateMetrics,
  throughput: DashboardViewModel['throughput'],
): PhaseMonitor[] {
  const totalFiles = dropbox.qa?.total_items ?? dropbox.counts.indexed_items;
  const queued = dropbox.counts.extraction_queued ?? 0;
  const leased = dropbox.counts.extraction_leased ?? 0;
  const failed = dropbox.counts.extraction_failed ?? 0;
  const jobSpeed = throughput.scheduledJobsPerHour;
  const qa = dropbox.qa;

  const crawlTotal = sumCounts(aggregates.crawl_frontier_statuses);
  const crawlVisited = countByLabel(aggregates.crawl_frontier_statuses, 'visited');
  const crawlPending = countByLabel(aggregates.crawl_frontier_statuses, 'pending');
  const crawlRetryable = countByLabel(aggregates.crawl_frontier_statuses, 'retryable_failed');
  const crawlBlocked = countByLabel(aggregates.crawl_frontier_statuses, ['blocked', 'failed']);
  const metadataTotal = crawlTotal > 0 ? crawlTotal : totalFiles;
  const foldersSynced = crawlTotal > 0 ? crawlVisited : totalFiles;

  const jobTotal = sumCounts(aggregates.job_statuses);
  const hasJobRows = jobTotal > 0;
  const queuedJobs = hasJobRows ? countByLabel(aggregates.job_statuses, 'queued') : queued;
  const leasedJobs = hasJobRows ? countByLabel(aggregates.job_statuses, 'leased') : leased;
  const retryableJobs = hasJobRows ? countByLabel(aggregates.job_statuses, 'failed_retryable') : failed;
  const failedTerminalJobs = countByLabel(aggregates.job_statuses, 'failed_terminal');
  const indexedJobs = hasJobRows ? countByLabel(aggregates.job_statuses, 'indexed') : 0;
  const plannedJobTotal = hasJobRows ? jobTotal : queued + leased + failed;
  const plannedFiles = aggregates.planning_files.planned_files > 0 ? aggregates.planning_files.planned_files : plannedJobTotal;
  const indexedFiles = aggregates.planning_files.planned_files > 0 ? aggregates.planning_files.indexed_files : indexedJobs;
  const queuedFiles = aggregates.planning_files.planned_files > 0 ? aggregates.planning_files.queued_files : queuedJobs;
  const leasedFiles = aggregates.planning_files.planned_files > 0 ? aggregates.planning_files.leased_files : leasedJobs;
  const retryableFiles = aggregates.planning_files.planned_files > 0 ? aggregates.planning_files.retryable_files : retryableJobs;
  const failedTerminalFiles = aggregates.planning_files.planned_files > 0 ? aggregates.planning_files.failed_terminal_files : failedTerminalJobs;

  const extractedFiles = countByLabel(aggregates.extraction_statuses, 'extracted');
  const metadataOnlyFiles = countByLabel(aggregates.extraction_statuses, 'metadata_only');
  const skippedUnsupported = countByLabel(aggregates.extraction_statuses, 'skipped_unsupported');
  const skippedTooLarge = countByLabel(aggregates.extraction_statuses, 'skipped_too_large');
  const blockedPolicyFiles = countByLabel(aggregates.extraction_statuses, 'blocked_policy');
  const failedFiles = countByLabel(aggregates.extraction_statuses, 'failed');
  const fullExtractionTotal = qa
    ? qa.pass + qa.low_confidence + qa.metadata_only_gap + qa.pending + qa.failed_needs_operator
    : Math.max(0, totalFiles - metadataOnlyFiles - skippedUnsupported - skippedTooLarge - blockedPolicyFiles);
  const fullExtractionDone = qa ? qa.pass + qa.low_confidence : extractedFiles;
  const fullExtractionRemaining = Math.max(0, fullExtractionTotal - fullExtractionDone);
  const extractionLaneRows = aggregates.extraction_lanes.length > 0
    ? aggregates.extraction_lanes
    : aggregates.file_types.map((row) => ({ label: row.label, files: row.count, extracted: 0, terminal: 0 }));

  const qaAccepted = qa ? qa.pass + qa.metadata_only_expected : 0;
  const qaReview = qa ? qa.metadata_only_gap + qa.low_confidence : 0;
  const qaPending = qa?.pending ?? 0;
  const qaBlocked = qa ? qa.blocked_policy + qa.failed_needs_operator : 0;
  const qaRemaining = qa ? qa.metadata_only_gap + qa.low_confidence + qa.pending + qa.failed_needs_operator : 0;

  const embeddingTotal = dropbox.counts.chunks;
  const embeddingDone = dropbox.counts.embedded_chunks;
  const embeddingRemaining = Math.max(0, embeddingTotal - embeddingDone);
  const embeddingLanes = aggregates.embedding_lanes
    .filter((lane) => lane.files > 0 || lane.chunks > 0)
    .slice(0, 6)
    .map((lane) => ({
      label: lane.label,
      done: lane.embedded_chunks,
      total: lane.chunks,
      detail: `${formatNumber(lane.files)} files · ${formatNumber(lane.embedded_chunks)} / ${formatNumber(lane.chunks)} chunks`,
      tone: 'good' as const,
    }));

  const answerReady = qa?.pass ?? 0;
  const answerBlocked = qa?.blocked_policy ?? 0;
  const answerRemaining = Math.max(0, totalFiles - answerReady - answerBlocked);

  return [
    {
      id: 'metadata-sync',
      title: 'Metadata Sync',
      description: 'Discovers Dropbox folders/files, MIME types, revisions, sizes, and freshness before content extraction starts.',
      primaryLabel: crawlTotal > 0 ? 'Known folders synced' : 'Known files discovered',
      unit: crawlTotal > 0 ? 'folders' : 'files',
      total: metadataTotal,
      done: foldersSynced,
      remaining: Math.max(0, metadataTotal - foldersSynced),
      blocked: crawlBlocked,
      speedUnit: 'items',
      statusNote: crawlTotal > 0
        ? `${formatNumber(crawlPending)} folders are still waiting to sync. Retry and blocked folders are separated below because they require attention, not normal progress.`
        : 'Folder-level sync telemetry was not available in this report, so this card falls back to discovered files.',
      attention: [
        { label: 'Needs retry', value: crawlRetryable, detail: 'folder sync attempts that should run again', tone: 'warn' },
        { label: 'Blocked', value: crawlBlocked, detail: 'folders that cannot sync without operator attention', tone: 'danger' },
      ],
    },
    {
      id: 'plan-queue',
      title: 'Plan & Queue',
      description: 'Converts currently discovered files and QA gaps into idempotent extraction work without resetting completed work.',
      primaryLabel: 'Known files planned for work',
      unit: 'files',
      total: totalFiles,
      done: plannedFiles,
      remaining: Math.max(0, totalFiles - plannedFiles),
      blocked: retryableFiles + failedTerminalFiles,
      ...(jobSpeed !== undefined ? { speedPerHour: jobSpeed } : {}),
      speedUnit: 'jobs',
      ...(jobSpeed !== undefined ? { eta: phaseEta(queuedJobs + leasedJobs + retryableJobs, jobSpeed) } : {}),
      statusNote: `This is based on currently discovered files, not the final all-time corpus. It can grow until Metadata Sync completes. Latest supervisor pass: ${formatNumber(supervisor?.summary.jobs_planned ?? 0)} jobs newly planned, ${formatNumber(supervisor?.summary.jobs_existing ?? 0)} existing jobs found.`,
      ready: {
        label: 'Ready now: planned files indexed',
        done: indexedFiles,
        total: Math.max(1, plannedFiles),
        detail: `${formatNumber(indexedFiles)} indexed / ${formatNumber(plannedFiles)} planned files`,
        tone: 'good',
      },
      lanes: [
        { label: 'Queued files', done: queuedFiles, total: Math.max(1, plannedFiles), detail: `${formatNumber(queuedFiles)} queued / ${formatNumber(plannedFiles)} planned files`, tone: 'info' },
        { label: 'Indexed files', done: indexedFiles, total: Math.max(1, plannedFiles), detail: `${formatNumber(indexedFiles)} indexed / ${formatNumber(plannedFiles)} planned files`, tone: 'good' },
      ],
      attention: [
        { label: 'Leased', value: leasedFiles, detail: 'files active or waiting for lease recycle', tone: 'warn' },
        { label: 'Retryable', value: retryableFiles, detail: 'files that can be retried', tone: 'warn' },
        { label: 'Failed terminal', value: failedTerminalFiles, detail: 'files needing repair', tone: 'danger' },
      ],
    },
    {
      id: 'full-extraction',
      title: 'Full Extraction',
      description: 'Creates secure-local text chunks, bounded artifacts, OCR/VLM outputs, facts, or metadata-only terminal records.',
      primaryLabel: 'Known full-extraction candidates processed',
      unit: 'files',
      total: fullExtractionTotal,
      done: fullExtractionDone,
      remaining: fullExtractionRemaining,
      blocked: blockedPolicyFiles + failedFiles,
      ...(jobSpeed !== undefined ? { speedPerHour: jobSpeed } : {}),
      speedUnit: 'jobs',
      ...(jobSpeed !== undefined ? { eta: phaseEta(fullExtractionRemaining, jobSpeed) } : {}),
      statusNote: 'This known-total denominator excludes files that appear intentionally metadata-only. It can grow as metadata sync discovers more files. Per-type bars show the currently discovered file families.',
      ready: {
        label: 'Ready now: planned files text-extracted',
        done: extractedFiles,
        total: Math.max(1, plannedFiles),
        detail: `${formatNumber(extractedFiles)} extracted / ${formatNumber(plannedFiles)} planned files`,
        tone: 'good',
      },
      lanes: extractionLaneRows.slice(0, 6).map((row) => ({
        label: row.label,
        done: row.extracted,
        total: Math.max(1, row.files),
        detail: `${formatNumber(row.extracted)} text-extracted / ${formatNumber(row.files)} files`,
        tone: 'good' as const,
      })),
      attention: [
        { label: 'Metadata-only expected', value: qa?.metadata_only_expected ?? metadataOnlyFiles, detail: 'files not expected to produce full text', tone: 'muted' },
        { label: 'Metadata gaps', value: qa?.metadata_only_gap ?? 0, detail: 'files that likely should have text but do not yet', tone: 'warn' },
        { label: 'Skipped too large/unsupported', value: skippedTooLarge + skippedUnsupported, detail: 'terminal non-extraction states', tone: 'muted' },
        { label: 'Policy blocked', value: blockedPolicyFiles, detail: 'intentionally blocked by policy', tone: 'danger' },
      ],
    },
    {
      id: 'classify-qa',
      title: 'Classify & QA',
      description: 'Applies S0-S5/privacy policy, marks policy blocks, and decides whether extraction quality is good enough.',
      primaryLabel: 'Known files QA accepted',
      unit: 'files',
      total: totalFiles,
      done: qaAccepted,
      remaining: qaRemaining,
      blocked: qaBlocked,
      ...(jobSpeed !== undefined ? { speedPerHour: jobSpeed } : {}),
      speedUnit: 'jobs',
      ...(jobSpeed !== undefined ? { eta: phaseEta(qaRemaining, jobSpeed) } : {}),
      statusNote: 'This known-total denominator is currently discovered files. Visible gaps, low-confidence items, and policy blocks are separated so review work is visible.',
      ready: {
        label: 'Ready now: files reviewed by QA',
        done: qaAccepted + qaReview + qaBlocked,
        total: Math.max(1, qaAccepted + qaReview + qaPending + qaBlocked),
        detail: `${formatNumber(qaAccepted + qaReview + qaBlocked)} reviewed / ${formatNumber(qaAccepted + qaReview + qaPending + qaBlocked)} QA-visible files`,
        tone: 'review',
      },
      lanes: [
        { label: 'Local retry', done: qa?.low_confidence_retry_local ?? 0, total: Math.max(1, qa?.low_confidence ?? 0), detail: `${formatNumber(qa?.low_confidence_retry_local ?? 0)} low-confidence local retries`, tone: 'review' },
        { label: 'Grok/Venice escalation', done: qa?.low_confidence_candidate_for_venice ?? 0, total: Math.max(1, qa?.low_confidence ?? 0), detail: `${formatNumber(qa?.low_confidence_candidate_for_venice ?? 0)} hard-document candidates`, tone: 'review' },
        { label: 'Metadata gaps', done: qa?.metadata_only_gap ?? 0, total: Math.max(1, qa?.visible_gaps ?? 0), detail: `${formatNumber(qa?.metadata_only_gap ?? 0)} suspicious metadata-only items`, tone: 'warn' },
      ],
      attention: [
        { label: 'Needs review', value: qaReview, detail: 'low-confidence or suspicious extraction results', tone: 'review' },
        { label: 'Pending QA', value: qaPending, detail: 'items not classified/checked yet', tone: 'info' },
        { label: 'Blocked/failed', value: qaBlocked, detail: 'policy blocks or operator failures', tone: 'danger' },
      ],
    },
    {
      id: 'embeddings',
      title: 'Embeddings',
      description: 'Embeds secure-local chunks so retrieval can use semantic search without sending private source text outside Delphi/local services.',
      primaryLabel: 'Known chunks embedded',
      unit: 'chunks',
      total: embeddingTotal,
      done: embeddingDone,
      remaining: embeddingRemaining,
      blocked: 0,
      speedUnit: 'chunks',
      statusNote: 'The denominator is chunks currently created by extraction. It grows as full extraction produces more chunks. Speed will become exact once embedding deltas are reported.',
      ready: {
        label: 'Ready now: created chunks embedded',
        done: embeddingDone,
        total: Math.max(1, embeddingTotal),
        detail: `${formatNumber(embeddingDone)} embedded / ${formatNumber(embeddingTotal)} created chunks`,
        tone: 'good',
      },
      lanes: embeddingLanes.length > 0 ? embeddingLanes : [
        { label: 'All chunks', done: embeddingDone, total: embeddingTotal, detail: `${formatNumber(embeddingDone)} / ${formatNumber(embeddingTotal)} chunks`, tone: 'good' },
      ],
      attention: [
        { label: 'Waiting chunks', value: embeddingRemaining, detail: 'chunks still missing embeddings', tone: 'warn' },
      ],
    },
    {
      id: 'answer-ready',
      title: 'Answer Ready',
      description: 'Shows how much of Dropbox has passed the pipeline far enough to support cited source answers.',
      primaryLabel: 'Known files answer-ready',
      unit: 'files',
      total: totalFiles,
      done: answerReady,
      remaining: answerRemaining,
      blocked: answerBlocked,
      ...(jobSpeed !== undefined ? { speedPerHour: jobSpeed } : {}),
      speedUnit: 'files',
      ...(jobSpeed !== undefined ? { eta: phaseEta(answerRemaining, jobSpeed) } : {}),
      statusNote: 'This is the product-facing finish line. The denominator is currently discovered files and can grow until metadata sync completes.',
      ready: {
        label: 'Ready now: QA-passing files with chunks',
        done: Math.min(answerReady, aggregates.chunked_files),
        total: Math.max(1, answerReady),
        detail: `${formatNumber(Math.min(answerReady, aggregates.chunked_files))} chunk-backed / ${formatNumber(answerReady)} QA-passing files`,
        tone: 'good',
      },
      lanes: [
        { label: 'Files with chunks', done: aggregates.chunked_files, total: totalFiles, detail: `${formatNumber(aggregates.chunked_files)} / ${formatNumber(totalFiles)} files`, tone: 'good' },
        { label: 'Embedded chunks', done: embeddingDone, total: embeddingTotal, detail: `${formatNumber(embeddingDone)} / ${formatNumber(embeddingTotal)} chunks`, tone: 'good' },
        { label: 'QA pass', done: answerReady, total: totalFiles, detail: `${formatNumber(answerReady)} / ${formatNumber(totalFiles)} files`, tone: 'good' },
      ],
      attention: [
        { label: 'Needs pipeline work', value: answerRemaining, detail: 'not ready for cited answers yet', tone: 'warn' },
        { label: 'Policy blocked', value: answerBlocked, detail: 'intentionally unavailable for answers', tone: 'danger' },
      ],
    },
  ];
}

function renderPhaseCard(phase: PhaseMonitor): string {
  const status = phaseStatus(phase);
  return `<article class="phase-card" id="${escapeHtml(phase.id)}">
    <div class="phase-head">
      <div>
        <h3 class="phase-title">${escapeHtml(phase.title)}</h3>
        <p class="phase-desc">${escapeHtml(phase.description)}</p>
      </div>
      <div class="status-pill ${status}">${escapeHtml(status.toUpperCase())}</div>
    </div>
    ${phasePrimaryBar(phase)}
    ${phaseReadyBar(phase)}
    ${phaseLaneRows(phase)}
    ${phaseAttentionRows(phase)}
    ${phaseSpeedStrip(phase)}
    <div class="phase-note">${escapeHtml(phase.statusNote)}</div>
  </article>`;
}

function renderOverallProgress(model: DashboardViewModel): string {
  const dropbox = model.dropbox;
  const totalFiles = dropbox.qa?.total_items ?? dropbox.counts.indexed_items;
  const answerReady = dropbox.qa?.pass ?? 0;
  const crawlTotal = sumCounts(model.aggregates.crawl_frontier_statuses);
  const crawlVisited = countByLabel(model.aggregates.crawl_frontier_statuses, 'visited');
  const metadataNote = crawlTotal > 0
    ? `Metadata sync is ${formatNumber(crawlVisited)} / ${formatNumber(crawlTotal)} known folders, so the file denominator can still grow.`
    : 'Folder-level metadata sync telemetry is not available in this render, so the denominator is the currently discovered file set.';
  return `<section class="overall" aria-label="Overall answer readiness">
    <div class="overall-head">
      <div>
        <h2 class="overall-title">Overall Answer Ready</h2>
        <p class="overall-note">Final-boss progress across the known Dropbox corpus. ${escapeHtml(metadataNote)}</p>
      </div>
      <div class="overall-value">${formatNumber(answerReady)} / ${formatNumber(totalFiles)} files · ${pctLabel(answerReady, totalFiles)}</div>
    </div>
    <div class="progress-track large" role="progressbar" aria-label="Overall answer-ready files" aria-valuemin="0" aria-valuemax="${Math.max(0, totalFiles)}" aria-valuenow="${Math.min(Math.max(0, answerReady), Math.max(0, totalFiles))}" aria-valuetext="${escapeHtml(`${formatNumber(answerReady)} of ${formatNumber(totalFiles)} known files answer-ready`)}">
      <div class="progress-fill good" style="width:${progressWidth(answerReady, totalFiles)}%"></div>
    </div>
  </section>`;
}

function phasePrimaryBar(phase: PhaseMonitor): string {
  return `<div class="primary-progress">
    <div class="progress-top">
      <div class="progress-label">${escapeHtml(phase.primaryLabel)}</div>
      <div class="progress-value">${escapeHtml(formatNumber(phase.done))} / ${escapeHtml(formatNumber(phase.total))} ${escapeHtml(phase.unit)} · ${pctLabel(phase.done, phase.total)}</div>
    </div>
    <div class="progress-track large" role="progressbar" aria-label="${escapeHtml(phase.primaryLabel)}" aria-valuemin="0" aria-valuemax="${Math.max(0, phase.total)}" aria-valuenow="${Math.min(Math.max(0, phase.done), Math.max(0, phase.total))}" aria-valuetext="${escapeHtml(`${formatNumber(phase.done)} of ${formatNumber(phase.total)} ${phase.unit}`)}">
      <div class="progress-fill good" style="width:${progressWidth(phase.done, phase.total)}%"></div>
    </div>
    <div class="progress-help">${escapeHtml(formatNumber(phase.remaining))} remaining${phase.blocked > 0 ? ` · ${escapeHtml(formatNumber(phase.blocked))} blocked` : ''}</div>
  </div>`;
}

function phaseReadyBar(phase: PhaseMonitor): string {
  const ready = phase.ready;
  if (!ready) return '';
  return `<div class="ready-bar">
    <div class="progress-top">
      <div class="progress-label">${escapeHtml(ready.label)}</div>
      <div class="progress-value">${escapeHtml(ready.detail)} · ${pctLabel(ready.done, ready.total)}</div>
    </div>
    <div class="progress-track" role="progressbar" aria-label="${escapeHtml(ready.label)}" aria-valuemin="0" aria-valuemax="${Math.max(0, ready.total)}" aria-valuenow="${Math.min(Math.max(0, ready.done), Math.max(0, ready.total))}" aria-valuetext="${escapeHtml(ready.detail)}">
      <div class="progress-fill ${ready.tone ?? 'info'}" style="width:${progressWidth(ready.done, ready.total)}%"></div>
    </div>
  </div>`;
}

function phaseSpeedStrip(phase: PhaseMonitor): string {
  const speed = phase.speedPerHour;
  const speedText = speed === undefined ? 'not sampled' : `${speed.toFixed(1)} ${phase.speedUnit}/hr`;
  const etaText = phase.eta ?? (speed === undefined ? 'needs phase delta telemetry' : 'unavailable');
  return `<div class="speed-strip">
    <div class="speed-kpi"><strong>${escapeHtml(speedText)}</strong><span>Current speed</span></div>
    <div class="speed-kpi"><strong>${escapeHtml(etaText)}</strong><span>ETA</span></div>
    <div class="speed-kpi"><strong>${formatNumber(phase.remaining)}</strong><span>Remaining</span></div>
  </div>`;
}

function phaseLaneRows(phase: PhaseMonitor): string {
  const lanes = phase.lanes ?? [];
  if (lanes.length === 0) return '';
  return `<div class="phase-lanes">
    ${lanes.map((lane) => `<div class="lane">
      <div class="lane-row">
        <div class="lane-name">${escapeHtml(lane.label)}</div>
        <div class="lane-detail">${escapeHtml(lane.detail)}</div>
      </div>
      <div class="progress-track" role="progressbar" aria-label="${escapeHtml(lane.label)}" aria-valuemin="0" aria-valuemax="${Math.max(0, lane.total)}" aria-valuenow="${Math.min(Math.max(0, lane.done), Math.max(0, lane.total))}" aria-valuetext="${escapeHtml(lane.detail)}">
        <div class="progress-fill ${lane.tone ?? 'info'}" style="width:${progressWidth(lane.done, lane.total)}%"></div>
      </div>
    </div>`).join('\n')}
  </div>`;
}

function phaseAttentionRows(phase: PhaseMonitor): string {
  const attention = (phase.attention ?? []).filter((item) => item.value > 0);
  if (attention.length === 0) return '';
  return `<div class="attention-grid">
    ${attention.map((item) => `<div class="attention-item ${item.tone}">
      <strong>${formatNumber(item.value)}</strong>
      <span>${escapeHtml(item.label)}${item.detail ? ` · ${escapeHtml(item.detail)}` : ''}</span>
    </div>`).join('\n')}
  </div>`;
}

function renderScope(scope: SupervisorScope): string {
  const after = scope.after ?? scope.before;
  const queued = after?.extraction_queued ?? 0;
  const leased = after?.extraction_leased ?? 0;
  const failed = after?.extraction_failed ?? 0;
  const label = SCOPE_LABELS[scope.scope_key_hash] ?? scope.scope_key_hash;
  return `<div class="scope">
    <div>
      <div class="scope-title">${escapeHtml(label)}</div>
      <div class="scope-status">${escapeHtml(scope.status)}${scope.errors.length > 0 ? ` · ${escapeHtml(scope.errors[0]!)}` : ''}</div>
    </div>
    <div class="scope-kpis">
      ${mini('Planned', scope.jobs_planned)}
      ${mini('Completed', scope.terminal_progress_jobs)}
      ${mini('Queued', queued)}
      ${mini('Leased/failed', leased + failed)}
    </div>
  </div>`;
}

function metricCard(label: string, value: string | number, hint: string): string {
  return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(typeof value === 'number' ? formatNumber(value) : value)}</div><div class="hint">${escapeHtml(hint)}</div></div>`;
}

function mini(label: string, value: number): string {
  return `<div class="mini"><strong>${formatNumber(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function coverageLine(label: string, value: number, total: number, percent: number): string {
  return `<div class="bar-row">
    <div class="bar-label">${escapeHtml(label)}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${clampPercent(percent)}%"></div></div>
    <div class="bar-value">${formatNumber(value)} / ${formatNumber(total)}</div>
  </div>`;
}

function stackedProgress(segments: Array<{ label: string; value: number; className: string }>, total: number): string {
  if (segments.length === 0 || total <= 0) return '<div class="progress-stack"></div>';
  return `<div class="progress-stack" aria-label="QA distribution">
    ${segments.map((segment) => `<div class="segment ${segment.className}" style="width:${clampPercent(pct(segment.value / total))}%"></div>`).join('\n')}
  </div>`;
}

function legendItem(label: string, value: number, total: number, className: string): string {
  return `<div class="legend-item"><span class="swatch ${className}"></span><span>${escapeHtml(label)} · ${formatNumber(value)} · ${pctLabel(value, total)}</span></div>`;
}

function barList(title: string, rows: AggregateCount[], tone: 'teal' | 'warn' | 'danger' | 'violet'): string {
  const max = Math.max(1, ...rows.map((row) => row.count));
  const toneClass = tone === 'warn' ? 'warn' : tone === 'danger' ? 'danger' : tone === 'violet' ? 'violet' : '';
  return `<div class="bar-list" aria-label="${escapeHtml(title)}">
    ${rows.length > 0 ? rows.map((row) => `<div class="bar-row">
      <div class="bar-label">${escapeHtml(row.label)}</div>
      <div class="bar-track"><div class="bar-fill ${toneClass}" style="width:${clampPercent(pct(row.count / max))}%"></div></div>
      <div class="bar-value">${formatNumber(row.count)}</div>
    </div>`).join('\n') : '<div class="bar-row"><div class="bar-label">No data</div></div>'}
  </div>`;
}

function phaseStatus(phase: PhaseMonitor): DashboardStatus {
  if (phase.remaining <= 0 && phase.blocked <= 0) return 'ready';
  if (phase.blocked > 0) return 'attention';
  return 'watch';
}

function countByLabel(rows: AggregateCount[], label: string | string[]): number {
  const labels = new Set((Array.isArray(label) ? label : [label]).map((value) => value.toLowerCase()));
  return rows.reduce((total, row) => labels.has(row.label.toLowerCase()) ? total + row.count : total, 0);
}

function sumCounts(rows: AggregateCount[]): number {
  return rows.reduce((total, row) => total + row.count, 0);
}

function phaseEta(remaining: number, speedPerHour: number): string {
  return etaLabel(remaining, speedPerHour);
}

function progressWidth(done: number, total: number): number {
  if (total <= 0) return 0;
  return clampPercent(pct(done / total));
}

function humanLabel(label: string): string {
  return label
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Unknown';
}

function blockers(model: DashboardViewModel): Array<{ severity: 'warn' | 'danger'; text: string }> {
  const dropbox = model.dropbox;
  const output: Array<{ severity: 'warn' | 'danger'; text: string }> = [];
  const failed = dropbox.counts.extraction_failed ?? 0;
  const queued = dropbox.counts.extraction_queued ?? 0;
  const leased = dropbox.counts.extraction_leased ?? 0;
  if (failed > 0) output.push({ severity: 'danger', text: `${formatNumber(failed)} failed extraction job(s) need repair.` });
  if (queued > 0) output.push({ severity: 'warn', text: `${formatNumber(queued)} queued extraction job(s) remain.` });
  if (leased > 0) output.push({ severity: 'warn', text: `${formatNumber(leased)} leased job(s) are active or waiting for lease recycle.` });
  if (dropbox.qa?.visible_gaps) output.push({ severity: 'warn', text: `${formatNumber(dropbox.qa.visible_gaps)} extraction QA gaps are still visible.` });
  if (dropbox.qa?.low_confidence_candidate_for_venice) output.push({ severity: 'warn', text: `${formatNumber(dropbox.qa.low_confidence_candidate_for_venice)} low-confidence hard document item(s) may need Grok/Venice escalation.` });
  for (const scope of model.supervisor?.scopes ?? []) {
    if (scope.errors.length > 0) {
      output.push({
        severity: 'danger',
        text: `${SCOPE_LABELS[scope.scope_key_hash] ?? scope.scope_key_hash}: ${scope.errors.join('; ')}`,
      });
    }
  }
  return output.length > 0 ? output : [{ severity: 'warn', text: 'No current blockers reported by the latest counts-only reports.' }];
}

function throughputLabel(model: DashboardViewModel): string {
  if (model.throughput.scheduledJobsPerHour) return `${model.throughput.scheduledJobsPerHour.toFixed(1)} jobs/hr`;
  return `${formatNumber(model.throughput.terminalJobsLastRun)} last run`;
}

function etaHint(model: DashboardViewModel): string {
  const parts: string[] = [];
  if (model.throughput.scheduledEta) parts.push(`timer pace: ${model.throughput.scheduledEta}`);
  if (model.throughput.activeEta) parts.push(`active pace: ${model.throughput.activeEta}`);
  return parts.length > 0 ? parts.join(' · ') : 'No ETA until progress is observed.';
}

function aggregateBroadFileTypes(rows: Array<{ mime_type: string | null; count: number }>): AggregateCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = broadFileType(row.mime_type);
    counts.set(label, (counts.get(label) ?? 0) + Number(row.count));
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

function aggregateEmbeddingLanes(rows: Array<{ mime_type: string | null; files: number; chunks: number; embedded_chunks: number }>): DropboxEmbeddingLane[] {
  const lanes = new Map<string, DropboxEmbeddingLane>();
  for (const row of rows) {
    const label = broadFileType(row.mime_type);
    const current = lanes.get(label) ?? { label, files: 0, chunks: 0, embedded_chunks: 0 };
    current.files += Number(row.files);
    current.chunks += Number(row.chunks);
    current.embedded_chunks += Number(row.embedded_chunks);
    lanes.set(label, current);
  }
  return [...lanes.values()].sort((a, b) => {
    if (b.chunks !== a.chunks) return b.chunks - a.chunks;
    return b.files - a.files;
  });
}

function aggregateExtractionLanes(rows: Array<{ mime_type: string | null; files: number; extracted: number; terminal: number }>): DropboxExtractionLane[] {
  const lanes = new Map<string, DropboxExtractionLane>();
  for (const row of rows) {
    const label = broadFileType(row.mime_type);
    const current = lanes.get(label) ?? { label, files: 0, extracted: 0, terminal: 0 };
    current.files += Number(row.files);
    current.extracted += Number(row.extracted);
    current.terminal += Number(row.terminal);
    lanes.set(label, current);
  }
  return [...lanes.values()].sort((a, b) => {
    if (b.files !== a.files) return b.files - a.files;
    return b.extracted - a.extracted;
  });
}

function broadFileType(mimeType: string | null): string {
  const value = mimeType?.toLowerCase() ?? '';
  if (!value || value === 'unknown') return 'Unknown';
  if (value === 'application/pdf') return 'PDF';
  if (value.startsWith('image/')) return 'Images';
  if (value.startsWith('audio/')) return 'Audio';
  if (value.startsWith('video/')) return 'Video';
  if (value.includes('spreadsheet') || value.includes('excel')) return 'Spreadsheets';
  if (value.includes('presentation') || value.includes('powerpoint')) return 'Presentations';
  if (value.includes('wordprocessing') || value.includes('msword')) return 'Word documents';
  if (value.startsWith('text/') || value.includes('markdown') || value.includes('json') || value.includes('xml')) return 'Text/code';
  return 'Other documents';
}

function countRows(db: Database, sql: string): AggregateCount[] {
  return (db.query(sql).all() as Array<{ label: string | null; count: number }>)
    .map((row) => ({ label: row.label?.trim() || 'unknown', count: Number(row.count) }));
}

function scalarCount(db: Database, sql: string): number {
  const row = db.query(sql).get() as { count?: number } | null;
  return Number(row?.count ?? 0);
}

function emptyAggregates(): DropboxAggregateMetrics {
  return {
    file_types: [],
    mime_types: [],
    extraction_statuses: [],
    job_statuses: [],
    failed_error_kinds: [],
    extractor_kinds: [],
    sync_job_statuses: [],
    crawl_frontier_statuses: [],
    embedding_lanes: [],
    extraction_lanes: [],
    planning_files: {
      planned_files: 0,
      indexed_files: 0,
      queued_files: 0,
      leased_files: 0,
      retryable_files: 0,
      failed_terminal_files: 0,
    },
    chunked_files: 0,
    artifact_files: 0,
  };
}

function etaLabel(remainingJobs: number, jobsPerHour: number): string {
  if (remainingJobs <= 0) return 'complete';
  if (jobsPerHour <= 0) return 'unknown';
  const hours = remainingJobs / jobsPerHour;
  if (hours < 1) return `${Math.ceil(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} hr`;
  return `${(hours / 24).toFixed(1)} days`;
}

function pct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value * 100;
}

function pctLabel(value: number, total: number): string {
  if (total <= 0) return '0.0%';
  return `${pct(value / total).toFixed(1)}%`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function normalizeDashboardStatus(value: string): DashboardStatus {
  if (value === 'ready' || value === 'watch' || value === 'attention') return value;
  return 'unknown';
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function parseArgs(argv: string[]): {
  readinessPath?: string;
  supervisorPath?: string;
  dropboxDbPath?: string;
  outputPath?: string;
  timerIntervalMinutes?: number;
  latestRunDurationSeconds?: number;
} {
  const options: ReturnType<typeof parseArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      index += 1;
      return value;
    };
    if (arg === '--readiness') options.readinessPath = next();
    else if (arg === '--supervisor') options.supervisorPath = next();
    else if (arg === '--dropbox-db') options.dropboxDbPath = next();
    else if (arg === '--output') options.outputPath = next();
    else if (arg === '--timer-interval-minutes') options.timerIntervalMinutes = Number.parseFloat(next());
    else if (arg === '--latest-run-duration-seconds') options.latestRunDurationSeconds = Number.parseFloat(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function writeOutput(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.readinessPath) throw new Error('--readiness is required.');
  if (!options.outputPath) throw new Error('--output is required.');
  const readiness = readJsonFile<SourceReadinessReport>(options.readinessPath);
  const supervisor = options.supervisorPath && existsSync(options.supervisorPath)
    ? readJsonFile<SourceProcessingSupervisorReport>(options.supervisorPath)
    : undefined;
  const aggregates = options.dropboxDbPath && existsSync(options.dropboxDbPath)
    ? readDropboxAggregateMetrics(options.dropboxDbPath)
    : undefined;
  const model = buildSourceIngestionDashboardViewModel({
    readiness,
    ...(supervisor ? { supervisor } : {}),
    ...(aggregates ? { aggregates } : {}),
    ...(options.timerIntervalMinutes ? { timerIntervalMinutes: options.timerIntervalMinutes } : {}),
    ...(options.latestRunDurationSeconds ? { latestRunDurationSeconds: options.latestRunDurationSeconds } : {}),
  });
  writeOutput(options.outputPath, renderSourceIngestionDashboardHtml(model));
  console.log(JSON.stringify({
    kind: 'source_ingestion_dashboard',
    output_path: options.outputPath,
    generated_at: model.generatedAt,
    status: model.status,
    files: model.dropbox.qa?.total_items ?? model.dropbox.counts.indexed_items,
    queued: model.dropbox.counts.extraction_queued ?? 0,
    failed: model.dropbox.counts.extraction_failed ?? 0,
    corpus_embedding_parity: model.corpusParity.map((corpus) => ({
      corpus_id: corpus.corpusId,
      chunks: corpus.chunks,
      embedded_chunks: corpus.embeddedChunks,
      missing_chunks: corpus.missingChunks,
      refresh_needed: corpus.refreshNeeded,
    })),
  }, null, 2));
}
