import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, normalizeSourceWorkerBaseUrl } from '../src/core/config.ts';
import { withWorkerAuthHeader, workerAuthTokenFromConfig } from '../src/core/worker-auth.ts';
import { defaultSourceDashboardHistoryDbPath } from '../src/workers/source-dashboard.ts';
import type { SourceIngestionLedgerSnapshot, SourceIngestionLedgerRow } from '../src/workers/source-ingestion-ledger.ts';
import type { WorkerCredentialDegradation } from '../src/workers/credential-degradation.ts';

type DigestColor = 'GREEN' | 'YELLOW' | 'RED';

interface SourceIndexStatusForDigest {
  kind?: string;
  generated_at?: string;
  degraded_credentials?: WorkerCredentialDegradation[];
  ingestion_ledger?: unknown;
}

interface DigestTerminalClass {
  source_id: string;
  label: string;
  class_key: string;
  count: number;
  delta: number;
  oldest_age_hours?: number;
}

interface DigestDrainLane {
  source_id: string;
  label: string;
  state: string;
  queued_retryable: number;
  unit?: string;
}

interface DigestCredentialLane {
  display_name: string;
  state: string;
  affected_capabilities: string[];
}

interface DigestJanitorSummary {
  report_path?: string;
  generated_at?: string;
  requeued: number;
  escalated: number;
  skipped: number;
  warnings: number;
}

interface DigestState {
  generated_at: string;
  terminal_classes: Record<string, number>;
}

interface SourceIngestionDigest {
  kind: 'source_ingestion_digest';
  generated_at: string;
  status: DigestColor;
  worker_unreachable?: string;
  totals: {
    items: number;
    content_indexed: number;
    queued_retryable: number;
    active: number;
    failed_terminal: number;
    oldest_stuck_age_hours?: number;
  };
  terminal_classes: DigestTerminalClass[];
  janitor: DigestJanitorSummary;
  drain_lanes: DigestDrainLane[];
  credential_lanes: DigestCredentialLane[];
  red_items: string[];
  yellow_items: string[];
  next_actions: string[];
  report_path?: string;
}

export interface SourceIngestionDigestOptions {
  now?: Date;
  redOnly?: boolean;
  stateDir?: string;
  reportPath?: string;
  janitorReportPath?: string;
  janitorReportDir?: string;
  baseUrl?: string;
  authToken?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const INGESTION_STUCK_WARNING_HOURS = 24;
const INGESTION_STUCK_ERROR_HOURS = 72;

export async function runSourceIngestionDigest(
  options: SourceIngestionDigestOptions = {},
): Promise<{ digest: SourceIngestionDigest; text: string; emitted: boolean }> {
  const now = options.now ?? new Date();
  const stateDir = options.stateDir ?? defaultDigestStateDir(options.env);
  const statePath = join(stateDir, 'source-ingestion-digest-state.json');
  const previous = readDigestState(statePath);
  let digest: SourceIngestionDigest;

  try {
    const status = await fetchSourceIndexStatusForDigest(options);
    const ledger = sourceIngestionLedgerFromStatus(status);
    if (!ledger) throw new Error('worker response did not include source_ingestion_ledger');
    digest = buildSourceIngestionDigest({
      now,
      ledger,
      ...(previous ? { previous } : {}),
      degradedCredentials: status.degraded_credentials ?? [],
      janitor: readLatestJanitorSummary(options),
    });
    writeDigestState(statePath, stateFromDigest(digest));
  } catch (error) {
    digest = buildUnreachableDigest(now, error);
  }

  const reportPath = options.reportPath ?? datedReportPath(stateDir, now);
  digest.report_path = reportPath;
  const text = renderSourceIngestionDigest(digest);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${text}\n`);
  const emitted = !(options.redOnly && digest.status !== 'RED');
  return { digest, text: emitted ? text : '', emitted };
}

export function buildSourceIngestionDigest(input: {
  now: Date;
  ledger: SourceIngestionLedgerSnapshot;
  previous?: DigestState;
  degradedCredentials?: WorkerCredentialDegradation[];
  janitor?: DigestJanitorSummary;
}): SourceIngestionDigest {
  const rows = Array.isArray(input.ledger.rows) ? input.ledger.rows : [];
  const terminalClasses = terminalClassesFromRows(rows, input.previous);
  const drainLanes = drainLanesFromRows(rows);
  const credentialLanes = (input.degradedCredentials ?? [])
    .filter((lane) => isFailingCredentialState(lane.state))
    .map((lane) => ({
      display_name: lane.display_name || 'configured credential',
      state: lane.state,
      affected_capabilities: lane.affected_capabilities ?? [],
    }));
  const totals = totalsFromRows(rows);
  const redItems: string[] = [];
  const yellowItems: string[] = [];
  const nextActions: string[] = [];

  if ((totals.oldest_stuck_age_hours ?? 0) >= INGESTION_STUCK_ERROR_HOURS && totals.queued_retryable > 0) {
    redItems.push(`queued/retryable work oldest ${formatHours(totals.oldest_stuck_age_hours)} across ${totals.queued_retryable} item(s)`);
    nextActions.push('Run the source-processing janitor/supervisor lane for the affected source and check provider health before increasing batch size.');
  } else if ((totals.oldest_stuck_age_hours ?? 0) >= INGESTION_STUCK_WARNING_HOURS && totals.queued_retryable > 0) {
    yellowItems.push(`queued/retryable work oldest ${formatHours(totals.oldest_stuck_age_hours)} across ${totals.queued_retryable} item(s)`);
  }

  for (const lane of drainLanes) {
    if ((lane.state === 'disabled' || lane.state === 'held') && lane.queued_retryable > 0) {
      redItems.push(`${lane.label} drain ${lane.state} with ${lane.queued_retryable} queued/retryable item(s)`);
      nextActions.push(`${lane.label}: clear the drain ${lane.state === 'held' ? 'hold' : 'disable'} state or restart the source drain before more planning.`);
    } else if (lane.state === 'unknown' && lane.queued_retryable > 0) {
      yellowItems.push(`${lane.label} has ${lane.queued_retryable} queued/retryable item(s) and unknown drain state`);
    }
  }

  for (const lane of credentialLanes) {
    redItems.push(`${lane.display_name} credential lane is ${lane.state}`);
    nextActions.push(`${lane.display_name}: repair/recheck the credential lane, then restart the Olympus worker if the lane reports restart required.`);
  }

  const growingTerminal = terminalClasses.filter((item) => item.delta > 0);
  if (growingTerminal.length > 0) {
    yellowItems.push(`${growingTerminal.length} terminal class(es) grew since the previous digest`);
  }

  const status: DigestColor = redItems.length > 0 ? 'RED' : yellowItems.length > 0 ? 'YELLOW' : 'GREEN';
  return {
    kind: 'source_ingestion_digest',
    generated_at: input.now.toISOString(),
    status,
    totals,
    terminal_classes: terminalClasses,
    janitor: input.janitor ?? { requeued: 0, escalated: 0, skipped: 0, warnings: 0 },
    drain_lanes: drainLanes,
    credential_lanes: credentialLanes,
    red_items: redItems,
    yellow_items: yellowItems,
    next_actions: dedupe(nextActions),
  };
}

export function renderSourceIngestionDigest(digest: SourceIngestionDigest): string {
  const lines: string[] = [];
  const reason = digest.worker_unreachable
    ? ` - worker unreachable: ${digest.worker_unreachable}`
    : digest.red_items.length > 0
      ? ` - ${digest.red_items.length} red item(s)`
      : digest.yellow_items.length > 0
        ? ` - ${digest.yellow_items.length} yellow item(s)`
        : ' - no red or yellow conditions';
  lines.push(`${digest.status} source ingestion digest ${digest.generated_at}${reason}`);
  lines.push(`Stuck: oldest ${formatHours(digest.totals.oldest_stuck_age_hours)}; queued/retryable ${digest.totals.queued_retryable}; active ${digest.totals.active}; terminal ${digest.totals.failed_terminal}.`);
  lines.push(`Coverage counts: items ${digest.totals.items}; content-indexed ${digest.totals.content_indexed}.`);
  lines.push(`Terminal classes: ${formatTerminalClasses(digest.terminal_classes)}.`);
  lines.push(`Janitor: requeued ${digest.janitor.requeued}; escalated ${digest.janitor.escalated}; skipped ${digest.janitor.skipped}; warnings ${digest.janitor.warnings}.`);
  lines.push(`Drain lanes: ${formatDrainLanes(digest.drain_lanes)}.`);
  lines.push(`Credential lanes: ${formatCredentialLanes(digest.credential_lanes)}.`);
  if (digest.red_items.length > 0) lines.push(`Red items: ${digest.red_items.join('; ')}.`);
  if (digest.yellow_items.length > 0) lines.push(`Yellow items: ${digest.yellow_items.join('; ')}.`);
  if (digest.next_actions.length > 0) {
    lines.push('Next actions:');
    for (const action of digest.next_actions) lines.push(`- ${action}`);
  }
  return lines.join('\n');
}

async function fetchSourceIndexStatusForDigest(options: SourceIngestionDigestOptions): Promise<SourceIndexStatusForDigest> {
  const env = options.env ?? process.env;
  const config = loadConfig(env);
  const baseUrl = normalizeSourceWorkerBaseUrl(
    options.baseUrl
      ?? env.OLYMPUS_SOURCE_INGESTION_DIGEST_BASE_URL?.trim()
      ?? env.OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_BASE_URL?.trim()
      ?? config.email.baseUrl,
  );
  const authToken = options.authToken ?? workerAuthTokenFromConfig(config);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/source/index/status`, withWorkerAuthHeader({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_ingestion_ledger: true, include_items: false }),
      signal: controller.signal,
    }, authToken));
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    return (text ? JSON.parse(text) : {}) as SourceIndexStatusForDigest;
  } finally {
    clearTimeout(timeout);
  }
}

function sourceIngestionLedgerFromStatus(status: SourceIndexStatusForDigest): SourceIngestionLedgerSnapshot | undefined {
  const ledger = asRecord(status.ingestion_ledger);
  if (ledger.kind !== 'source_ingestion_ledger' || !Array.isArray(ledger.rows)) return undefined;
  return ledger as unknown as SourceIngestionLedgerSnapshot;
}

function terminalClassesFromRows(rows: SourceIngestionLedgerRow[], previous?: DigestState): DigestTerminalClass[] {
  const classes = new Map<string, DigestTerminalClass>();
  for (const row of rows) {
    for (const item of row.ingestion_health.stuck_work.by_class ?? []) {
      if (item.status !== 'failed_terminal') continue;
      const classKey = `${item.extractor_kind}:${item.error_class ?? 'unknown'}`;
      const stateKey = `${row.source_id}:${classKey}`;
      const existing = classes.get(stateKey);
      const count = toCount(item.count);
      if (existing) {
        existing.count += count;
        const oldest = minDefined(existing.oldest_age_hours, item.oldest_age_hours);
        if (oldest !== undefined) existing.oldest_age_hours = oldest;
      } else {
        classes.set(stateKey, {
          source_id: row.source_id,
          label: row.label,
          class_key: classKey,
          count,
          delta: 0,
          ...(typeof item.oldest_age_hours === 'number' ? { oldest_age_hours: item.oldest_age_hours } : {}),
        });
      }
    }
  }
  return [...classes.entries()]
    .map(([stateKey, item]) => ({
      ...item,
      delta: item.count - (previous?.terminal_classes[stateKey] ?? 0),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.class_key.localeCompare(b.class_key));
}

function drainLanesFromRows(rows: SourceIngestionLedgerRow[]): DigestDrainLane[] {
  return rows.map((row) => ({
    source_id: row.source_id,
    label: row.label,
    state: row.ingestion_health.drain.state,
    queued_retryable: row.ingestion_health.stuck_work.queued + row.ingestion_health.stuck_work.failed_retryable,
    ...(row.ingestion_health.drain.unit ? { unit: row.ingestion_health.drain.unit } : {}),
  }));
}

function totalsFromRows(rows: SourceIngestionLedgerRow[]): SourceIngestionDigest['totals'] {
  const oldest = rows
    .map((row) => row.ingestion_health.stuck_work.oldest_age_hours)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  return {
    items: sum(rows, (row) => row.items),
    content_indexed: sum(rows, (row) => row.content_indexed),
    queued_retryable: sum(rows, (row) => row.ingestion_health.stuck_work.queued + row.ingestion_health.stuck_work.failed_retryable),
    active: sum(rows, (row) => row.stuck.active),
    failed_terminal: sum(rows, (row) => row.ingestion_health.stuck_work.failed_terminal),
    ...(oldest !== undefined ? { oldest_stuck_age_hours: oldest } : {}),
  };
}

function readLatestJanitorSummary(options: SourceIngestionDigestOptions): DigestJanitorSummary {
  const reportPath = options.janitorReportPath
    ?? options.env?.OLYMPUS_SOURCE_INGESTION_DIGEST_JANITOR_REPORT?.trim()
    ?? options.env?.OLYMPUS_SOURCE_PROCESSING_JANITOR_REPORT_PATH?.trim()
    ?? latestJsonPath(options.janitorReportDir ?? options.env?.OLYMPUS_SOURCE_INGESTION_DIGEST_JANITOR_REPORT_DIR?.trim());
  if (!reportPath || !existsSync(reportPath)) return { requeued: 0, escalated: 0, skipped: 0, warnings: 0 };
  try {
    const report = asRecord(JSON.parse(readFileSync(reportPath, 'utf8')));
    const summary = asRecord(report.summary);
    const escalations = asRecord(report.escalations);
    const output: DigestJanitorSummary = {
      report_path: reportPath,
      requeued:
        toCount(summary.stale_leases_requeued)
        + toCount(summary.expired_retryable_requeued)
        + toCount(summary.terminal_requeued),
      escalated:
        toCount(summary.escalated)
        + toCount(summary.terminal_escalated)
        + toCount(escalations.escalated)
        + toCount(escalations.enqueued),
      skipped:
        toCount(summary.skipped_attempt_budget)
        + toCount(summary.skipped_already_janitor_requeued)
        + toCount(summary.skipped_policy_excluded)
        + toCount(summary.skipped_already_escalated)
        + toCount(summary.skipped_budget)
        + toCount(escalations.skipped)
        + toCount(escalations.policy_excluded)
        + toCount(escalations.already_escalated)
        + toCount(escalations.budget_skipped),
      warnings: Array.isArray(report.warnings) ? report.warnings.length : 0,
    };
    if (typeof report.generated_at === 'string') output.generated_at = report.generated_at;
    return output;
  } catch {
    return { report_path: reportPath, requeued: 0, escalated: 0, skipped: 0, warnings: 1 };
  }
}

function latestJsonPath(dir: string | undefined): string | undefined {
  if (!dir || !existsSync(dir)) return undefined;
  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

function buildUnreachableDigest(now: Date, error: unknown): SourceIngestionDigest {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    kind: 'source_ingestion_digest',
    generated_at: now.toISOString(),
    status: 'RED',
    worker_unreachable: detail,
    totals: { items: 0, content_indexed: 0, queued_retryable: 0, active: 0, failed_terminal: 0 },
    terminal_classes: [],
    janitor: { requeued: 0, escalated: 0, skipped: 0, warnings: 0 },
    drain_lanes: [],
    credential_lanes: [],
    red_items: ['source worker unreachable'],
    yellow_items: [],
    next_actions: ['Restore the Olympus source worker or its bearer-token configuration, then rerun the digest.'],
  };
}

function readDigestState(path: string): DigestState | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const record = asRecord(JSON.parse(readFileSync(path, 'utf8')));
    const terminal = asRecord(record.terminal_classes);
    return {
      generated_at: typeof record.generated_at === 'string' ? record.generated_at : new Date(0).toISOString(),
      terminal_classes: Object.fromEntries(Object.entries(terminal).map(([key, value]) => [key, toCount(value)])),
    };
  } catch {
    return undefined;
  }
}

function writeDigestState(path: string, state: DigestState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function stateFromDigest(digest: SourceIngestionDigest): DigestState {
  const terminal: Record<string, number> = {};
  for (const item of digest.terminal_classes) terminal[`${item.source_id}:${item.class_key}`] = item.count;
  return { generated_at: digest.generated_at, terminal_classes: terminal };
}

function datedReportPath(stateDir: string, now: Date): string {
  return join(stateDir, 'reports', `source-ingestion-digest-${now.toISOString().replace(/[:.]/g, '-')}.txt`);
}

function defaultDigestStateDir(env: Record<string, string | undefined> = process.env): string {
  return env.OLYMPUS_SOURCE_INGESTION_DIGEST_STATE_DIR?.trim()
    || join(dirname(defaultSourceDashboardHistoryDbPath(env)), 'source-ingestion-digest');
}

function formatTerminalClasses(classes: DigestTerminalClass[]): string {
  if (classes.length === 0) return 'none';
  return classes.map((item) => `${item.label} ${item.class_key}=${item.count} (${formatDelta(item.delta)})`).join('; ');
}

function formatDrainLanes(lanes: DigestDrainLane[]): string {
  if (lanes.length === 0) return 'none';
  return lanes.map((lane) => `${lane.label} ${lane.state} queued/retryable=${lane.queued_retryable}`).join('; ');
}

function formatCredentialLanes(lanes: DigestCredentialLane[]): string {
  if (lanes.length === 0) return 'healthy';
  return lanes.map((lane) => `${lane.display_name} ${lane.state}`).join('; ');
}

function formatHours(value: number | undefined): string {
  if (value === undefined) return 'unknown';
  return `${Math.round(value * 10) / 10}h`;
}

function formatDelta(value: number): string {
  if (value > 0) return `delta +${value}`;
  if (value < 0) return `delta ${value}`;
  return 'delta 0';
}

function isFailingCredentialState(state: string | undefined): boolean {
  return state === 'retrying' || state === 'stopped' || state === 'resolved_restart_required';
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function sum<T>(items: T[], fn: (item: T) => number): number {
  return items.reduce((total, item) => total + fn(item), 0);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function parseArgs(argv: string[]): Pick<SourceIngestionDigestOptions, 'redOnly' | 'stateDir' | 'reportPath' | 'janitorReportPath'> {
  const options: Pick<SourceIngestionDigestOptions, 'redOnly' | 'stateDir' | 'reportPath' | 'janitorReportPath'> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--red-only') {
      options.redOnly = true;
    } else if (arg === '--state-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--state-dir requires a path.');
      options.stateDir = resolve(value);
      index += 1;
    } else if (arg === '--report') {
      const value = argv[index + 1];
      if (!value) throw new Error('--report requires a path.');
      options.reportPath = resolve(value);
      index += 1;
    } else if (arg === '--janitor-report') {
      const value = argv[index + 1];
      if (!value) throw new Error('--janitor-report requires a path.');
      options.janitorReportPath = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (import.meta.main) {
  const result = await runSourceIngestionDigest(parseArgs(process.argv.slice(2)));
  if (result.emitted) console.log(result.text);
}
