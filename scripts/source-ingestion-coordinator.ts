import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_REPORT_DIR = '/tmp/olympus-source-processing-supervisor';
const DEFAULT_VENICE_PAUSE_FILE = '/tmp/olympus-source-processing-supervisor-venice-paused.json';
const DEFAULT_STALE_AFTER_SECONDS = 20 * 60;

type LaneStatus = 'active' | 'ok' | 'idle' | 'parked' | 'attention' | 'missing' | 'stale' | 'invalid';
type ReportState = 'present' | 'missing' | 'stale' | 'invalid';

export interface SourceIngestionCoordinatorOptions {
  reportDir?: string;
  reportPath?: string;
  venicePauseFile?: string;
  now?: Date;
  staleAfterMs?: number;
}

export interface SourceIngestionCoordinatorReport {
  kind: 'source_ingestion_coordinator_report';
  mode: 'shadow';
  generated_at: string;
  run_state: 'complete';
  report_dir_hash: string;
  stale_after_seconds: number;
  lanes: SourceIngestionCoordinatorLane[];
  active_lanes: string[];
  stale_lanes: string[];
  attention_lanes: string[];
  recommended_next_actions: string[];
  policy: {
    shadow_read_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    source_scope_keys_exposed: false;
    file_names_returned: false;
    provider_cursors_returned: false;
    secrets_returned: false;
    direct_db_mutation: false;
  };
}

export interface SourceIngestionCoordinatorLane {
  id: string;
  label: string;
  status: LaneStatus;
  report_state: ReportState;
  generated_at: string | null;
  updated_at: string | null;
  age_seconds: number | null;
  run_state: string | null;
  active_phase: string | null;
  active: boolean;
  stale: boolean;
  attention: boolean;
  counts: Record<string, number>;
  hashes: Record<string, string>;
  action_labels: string[];
}

interface LaneDefinition {
  id: string;
  label: string;
  fileName?: string;
  fallbackStatus: LaneStatus;
  missingAction: string;
  normalize: (raw: unknown) => LaneSnapshot;
}

interface LaneSnapshot {
  generatedAt: string | null;
  updatedAt: string | null;
  status: LaneStatus;
  runState: string | null;
  activePhase: string | null;
  counts: Record<string, number>;
  hashes: Record<string, string>;
  actionLabels: string[];
}

export function runSourceIngestionCoordinator(
  options: SourceIngestionCoordinatorOptions = {},
): SourceIngestionCoordinatorReport {
  const now = options.now ?? new Date();
  const reportDir = options.reportDir?.trim() || DEFAULT_REPORT_DIR;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_SECONDS * 1_000;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error('staleAfterMs must be a positive finite number.');
  }

  const lanes = laneDefinitions().map((definition) => readLane(definition, reportDir, now, staleAfterMs));
  lanes.push(readVenicePauseLane(reportDir, options.venicePauseFile ?? DEFAULT_VENICE_PAUSE_FILE, now, staleAfterMs));

  const activeLanes = lanes.filter((lane) => lane.active).map((lane) => lane.id);
  const staleLanes = lanes.filter((lane) => lane.stale).map((lane) => lane.id);
  const attentionLanes = lanes.filter((lane) => lane.attention).map((lane) => lane.id);
  const report: SourceIngestionCoordinatorReport = {
    kind: 'source_ingestion_coordinator_report',
    mode: 'shadow',
    generated_at: now.toISOString(),
    run_state: 'complete',
    report_dir_hash: hashString(reportDir),
    stale_after_seconds: Math.round(staleAfterMs / 1_000),
    lanes,
    active_lanes: activeLanes,
    stale_lanes: staleLanes,
    attention_lanes: attentionLanes,
    recommended_next_actions: recommendedActions(lanes),
    policy: {
      shadow_read_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      file_names_returned: false,
      provider_cursors_returned: false,
      secrets_returned: false,
      direct_db_mutation: false,
    },
  };

  if (options.reportPath) writeJsonFile(options.reportPath, report);
  return report;
}

function laneDefinitions(): LaneDefinition[] {
  return [
    {
      id: 'source_processing_supervisor',
      label: 'Source processing supervisor',
      fileName: 'current.json',
      fallbackStatus: 'missing',
      missingAction: 'source_processing_report_missing',
      normalize: normalizeSourceProcessingSupervisor,
    },
    {
      id: 'embedding_drain',
      label: 'Embedding drain',
      fileName: 'source-embedding-drain-current.json',
      fallbackStatus: 'missing',
      missingAction: 'embedding_report_missing',
      normalize: normalizeEmbeddingDrain,
    },
    {
      id: 'venice_credit',
      label: 'Venice credit monitor',
      fileName: 'venice-credit-status.json',
      fallbackStatus: 'missing',
      missingAction: 'venice_credit_report_missing',
      normalize: normalizeVeniceCredit,
    },
  ];
}

function readLane(
  definition: LaneDefinition,
  reportDir: string,
  now: Date,
  staleAfterMs: number,
): SourceIngestionCoordinatorLane {
  const path = join(reportDir, definition.fileName!);
  if (!existsSync(path)) return missingLane(definition);

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const snapshot = definition.normalize(raw);
    return laneFromSnapshot(definition, snapshot, now, staleAfterMs);
  } catch (error) {
    return {
      ...missingLane(definition),
      status: 'invalid',
      report_state: 'invalid',
      attention: true,
      action_labels: ['report_json_invalid'],
      hashes: { parse_error_hash: hashString(error instanceof Error ? error.message : String(error)) },
    };
  }
}

function readVenicePauseLane(
  reportDir: string,
  pauseFile: string,
  now: Date,
  staleAfterMs: number,
): SourceIngestionCoordinatorLane {
  const definition: LaneDefinition = {
    id: 'venice_provider_pause',
    label: 'Venice provider pause',
    fallbackStatus: 'missing',
    missingAction: 'venice_pause_marker_absent',
    normalize: normalizeVenicePause,
  };
  const candidates = [pauseFile, join(reportDir, 'venice-paused.json')];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) return missingLane(definition);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const snapshot = normalizeVenicePause(raw);
    return laneFromSnapshot(definition, snapshot, now, staleAfterMs);
  } catch (error) {
    return {
      ...missingLane(definition),
      status: 'invalid',
      report_state: 'invalid',
      attention: true,
      action_labels: ['venice_pause_marker_invalid'],
      hashes: { parse_error_hash: hashString(error instanceof Error ? error.message : String(error)) },
    };
  }
}

function laneFromSnapshot(
  definition: LaneDefinition,
  snapshot: LaneSnapshot,
  now: Date,
  staleAfterMs: number,
): SourceIngestionCoordinatorLane {
  const timestamp = snapshot.updatedAt ?? snapshot.generatedAt;
  const reportAgeSeconds = timestamp ? secondsSince(now, timestamp) : null;
  const invalidTimestamp = timestamp !== null && reportAgeSeconds === null;
  const stale = reportAgeSeconds !== null && reportAgeSeconds * 1_000 > staleAfterMs;
  const active = snapshot.runState === 'running' || (snapshot.activePhase !== null && snapshot.activePhase !== 'complete');
  const attention = invalidTimestamp || stale || snapshot.status === 'attention' || snapshot.status === 'parked';
  return {
    id: definition.id,
    label: definition.label,
    status: invalidTimestamp ? 'invalid' : stale ? 'stale' : active ? 'active' : snapshot.status,
    report_state: invalidTimestamp ? 'invalid' : stale ? 'stale' : 'present',
    generated_at: snapshot.generatedAt,
    updated_at: snapshot.updatedAt,
    age_seconds: reportAgeSeconds,
    run_state: snapshot.runState,
    active_phase: snapshot.activePhase,
    active,
    stale,
    attention,
    counts: snapshot.counts,
    hashes: snapshot.hashes,
    action_labels: invalidTimestamp
      ? unique([...snapshot.actionLabels, 'report_timestamp_invalid'])
      : stale
        ? unique([...snapshot.actionLabels, 'report_stale'])
        : snapshot.actionLabels,
  };
}

function missingLane(definition: LaneDefinition): SourceIngestionCoordinatorLane {
  return {
    id: definition.id,
    label: definition.label,
    status: definition.fallbackStatus,
    report_state: 'missing',
    generated_at: null,
    updated_at: null,
    age_seconds: null,
    run_state: null,
    active_phase: null,
    active: false,
    stale: false,
    attention: false,
    counts: {},
    hashes: {},
    action_labels: [definition.missingAction],
  };
}

function normalizeSourceProcessingSupervisor(raw: unknown): LaneSnapshot {
  const object = record(raw);
  const summary = record(object.summary);
  const status = statusValue(object.status);
  return {
    generatedAt: stringValue(object.generated_at),
    updatedAt: stringValue(object.updated_at),
    status,
    runState: stringValue(object.run_state),
    activePhase: stringValue(object.active_phase),
    counts: {
      ...pickNumbers(object, ['cycles_run', 'heartbeat_seq']),
      ...pickNumbers(summary, [
        'jobs_leased',
        'jobs_planned',
        'jobs_existing',
        'terminal_progress_jobs',
        'failed_retryable_jobs',
        'queued_before',
        'queued_after',
        'leased_before',
        'leased_after',
        'provider_backpressure_jobs',
        'qa_visible_gaps_after',
        'qa_low_confidence_candidate_for_venice_after',
      ]),
    },
    hashes: pickHashes(object, ['active_scope_hash']),
    actionLabels: actionLabels([
      [status === 'attention', 'source_processing_attention'],
      [status === 'parked' || object.provider_pause !== undefined, 'provider_pause_active'],
      [numberOrZero(summary.provider_backpressure_jobs) > 0, 'provider_backpressure_detected'],
      [numberOrZero(summary.qa_visible_gaps_after) > 0, 'qa_visible_gaps_remain'],
    ]),
  };
}

function normalizeEmbeddingDrain(raw: unknown): LaneSnapshot {
  const object = record(raw);
  const status = statusValue(object.status);
  return {
    generatedAt: stringValue(object.generated_at),
    updatedAt: stringValue(object.updated_at),
    status,
    runState: stringValue(object.run_state),
    activePhase: stringValue(object.active_phase),
    counts: pickNumbers(object, [
      'runs',
      'chunks_seen',
      'chunks_embedded',
      'chunks_skipped',
      'consecutive_failures',
      'transient_lock_retries',
    ]),
    hashes: pickHashes(object, ['active_scope_key_hash']),
    actionLabels: actionLabels([
      [status === 'attention', 'embedding_attention'],
      [numberOrZero(object.chunks_embedded) > 0, 'embedding_progress_seen'],
      [numberOrZero(object.transient_lock_retries) > 0, 'sqlite_writer_lock_backoff'],
      [status !== 'attention' && numberOrZero(object.chunks_embedded) === 0, 'embedding_idle'],
    ]),
  };
}

function normalizeVeniceCredit(raw: unknown): LaneSnapshot {
  const object = record(raw);
  const statusRaw = stringValue(object.status);
  const status: LaneStatus = statusRaw === 'ok' ? 'ok' : statusRaw === null ? 'invalid' : 'attention';
  const balances = record(object.balances);
  return {
    generatedAt: stringValue(object.generated_at),
    updatedAt: stringValue(object.generated_at),
    status,
    runState: null,
    activePhase: null,
    counts: {
      ...Object.fromEntries(Object.entries(balances)
        .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
        .map(([key, value]) => [`balance_${safeKey(key)}`, value as number])),
      ...(typeof object.can_consume === 'boolean' ? { can_consume: object.can_consume ? 1 : 0 } : {}),
    },
    hashes: pickHashes(object, ['error_kind']),
    actionLabels: actionLabels([
      [statusRaw === 'credit_exhausted', 'venice_credit_exhausted'],
      [statusRaw === 'auth_failed', 'venice_credit_auth_failed'],
      [statusRaw === 'rate_limited', 'venice_credit_rate_limited'],
      [statusRaw === 'not_configured', 'venice_credit_not_configured'],
      [statusRaw === 'unavailable', 'venice_credit_unavailable'],
    ]),
  };
}

function normalizeVenicePause(raw: unknown): LaneSnapshot {
  const object = record(raw);
  const active = object.active === true || stringValue(object.active) === 'true';
  return {
    generatedAt: stringValue(object.created_at) ?? stringValue(object.generated_at),
    updatedAt: stringValue(object.updated_at) ?? stringValue(object.created_at) ?? stringValue(object.generated_at),
    status: active ? 'parked' : 'ok',
    runState: null,
    activePhase: active ? 'paused' : null,
    counts: { active: active ? 1 : 0 },
    hashes: pickHashes(object, ['error_kind', 'reason']),
    actionLabels: active ? ['venice_provider_pause_active'] : [],
  };
}

function recommendedActions(lanes: SourceIngestionCoordinatorLane[]): string[] {
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  const actions: string[] = [];
  for (const lane of lanes) {
    if (lane.report_state === 'invalid') actions.push(`${lane.id}:repair_invalid_report_json`);
    if (lane.stale) actions.push(`${lane.id}:refresh_stale_report`);
    if (lane.attention && !lane.stale && lane.report_state === 'present') actions.push(`${lane.id}:inspect_attention_state`);
  }
  if (byId.get('source_processing_supervisor')?.status === 'missing') actions.push('source_processing:enable_shadow_report');
  if (byId.get('embedding_drain')?.status === 'missing') actions.push('embedding:enable_shadow_report');
  if (byId.get('venice_credit')?.attention) actions.push('venice:hold_or_repair_credit_lane');
  if (byId.get('venice_provider_pause')?.attention) actions.push('venice:respect_provider_pause_marker');
  return unique(actions);
}

function pickNumbers(object: Record<string, unknown>, keys: string[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const key of keys) {
    const value = numberValue(object[key]);
    if (value !== null) output[key] = value;
  }
  return output;
}

function pickHashes(object: Record<string, unknown>, keys: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of keys) {
    const value = stringValue(object[key]);
    if (!value) continue;
    output[key] = looksHashLike(value) ? value : hashString(value);
  }
  return output;
}

function statusValue(value: unknown): LaneStatus {
  const status = stringValue(value);
  if (
    status === 'active'
    || status === 'ok'
    || status === 'idle'
    || status === 'parked'
    || status === 'attention'
    || status === 'missing'
    || status === 'stale'
    || status === 'invalid'
  ) {
    return status;
  }
  if (status === 'progress' || status === 'ready') return 'ok';
  if (status === 'watch') return 'attention';
  return 'invalid';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown): number {
  return numberValue(value) ?? 0;
}

function secondsSince(now: Date, timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((now.getTime() - parsed) / 1_000));
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function looksHashLike(value: string): boolean {
  return /^[a-f0-9]{8,64}$/i.test(value) || /^[a-z0-9_-]{8,80}$/i.test(value);
}

function actionLabels(pairs: Array<[boolean, string]>): string[] {
  return pairs.filter(([enabled]) => enabled).map(([, label]) => label);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function safeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 48) || 'unknown';
}

function writeJsonFile(path: string, report: SourceIngestionCoordinatorReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(argv: string[]): SourceIngestionCoordinatorOptions {
  const options: SourceIngestionCoordinatorOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--report-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--report-dir requires a path.');
      options.reportDir = value;
      index += 1;
    } else if (arg === '--report') {
      const value = argv[index + 1];
      if (!value) throw new Error('--report requires a path.');
      options.reportPath = value;
      index += 1;
    } else if (arg === '--venice-pause-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--venice-pause-file requires a path.');
      options.venicePauseFile = value;
      index += 1;
    } else if (arg === '--stale-after-seconds') {
      const value = argv[index + 1];
      if (!value) throw new Error('--stale-after-seconds requires a positive number.');
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--stale-after-seconds requires a positive number.');
      options.staleAfterMs = parsed * 1_000;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (import.meta.main) {
  const report = runSourceIngestionCoordinator(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
}
