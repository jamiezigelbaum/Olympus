import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_STATUS_URL = 'http://127.0.0.1:8010/v1/source/scheduler/status';
const DEFAULT_STATE_DIR = join(
  homedir(),
  '.local',
  'state',
  'olympus',
  'source-scheduler-health-monitor',
);
const DEFAULT_STATE_PATH = join(DEFAULT_STATE_DIR, 'state.json');
const DEFAULT_REPORT_PATH = join(DEFAULT_STATE_DIR, 'current.json');
const DEFAULT_DELIVERY_SMOKE_REPORT_PATH = join(DEFAULT_STATE_DIR, 'delivery-smoke-current.json');
const DEFAULT_AUTH_HEADER_FILE = join(homedir(), '.config', 'olympus', 'curl-auth-header');
const DEFAULT_FAILURE_THRESHOLD = 1;
const DEFAULT_BOOTSTRAP_GRACE_SECONDS = 300;
const DEFAULT_NOTIFICATION_RETRY_SECONDS = 300;
const DEFAULT_NOTIFICATION_REMINDER_SECONDS = 21_600;
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_DEGRADE_NOTICE_BASENAME = 'degrade-notice-request.json';
const DEFAULT_DEGRADE_NOTICE_MAX_AGE_SECONDS = 300;
const MAX_DEGRADE_NOTICE_CLOCK_SKEW_MS = 30_000;
const MAX_DEGRADE_NOTICE_REASONS = 8;
const MAX_DEGRADE_NOTICE_COUNT = 1_000;
const TASK_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SAFE_STATE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

/**
 * Budget/quota refusals: the task was never given a chance to run. Explicit
 * enum, never a substring match — an unknown kind is a real failure.
 * Vocabulary: XApiUsageGuardKind (src/workers/x-bookmarks/live-control.ts),
 * the connector-level `api_request_guard`, and the Readwise daily budget park.
 *
 * The classification reads `last_error_kind` and nothing else. It used to fall
 * back to `degraded_reason` whenever the kind was the untyped `task_failed`,
 * because mapExplicitSchedulerErrorKind collapsed every explicit connector
 * kind into it. The scheduler now passes the refusal kinds through honestly,
 * so the fallback is gone with the ambiguity that required it — and a
 * degradation marker left over from an earlier run can no longer make a real
 * failure read as "the guard declined it".
 */
const REFUSAL_KINDS: ReadonlySet<string> = new Set([
  'api_request_guard',
  'daily_api_request_guard',
  'daily_resource_read_guard',
  'daily_cost_guard',
  'head_api_request_reserve_guard',
  'head_resource_read_reserve_guard',
  'head_cost_reserve_guard',
  'provider_rate_limit',
  'readwise_daily_api_request_guard',
]);

export interface SourceSchedulerMonitorTask {
  sourceId: string;
  taskId: string;
  maxAgeSeconds: number;
}

export interface SourceSchedulerHealthMonitorReport {
  kind: 'source_scheduler_health_monitor_report';
  generated_at: string;
  status: 'healthy' | 'attention';
  monitored_tasks: number;
  affected_tasks: number;
  affected_source_ids: string[];
  stale_tasks: number;
  failing_tasks: number;
  /** Subset of failing_tasks whose failure was a budget/quota refusal. */
  refused_tasks: number;
  missing_tasks: number;
  scheduler_inactive: boolean;
  scheduler_status_unavailable: boolean;
  notification: 'not_needed' | 'sent' | 'suppressed' | 'failed';
  last_error_hash?: string;
  policy: {
    counts_only: true;
    source_ids_exposed: true;
    task_ids_exposed: false;
    raw_source_exposed: false;
    source_text_returned: false;
    secrets_exposed: false;
  };
}

interface MonitorState {
  version: 1;
  first_seen_by_task_hash: Record<string, string>;
  last_notification_health?: 'healthy' | 'attention';
  last_notification_fingerprint?: string;
  last_notification_at?: string;
  last_notification_attempt_health?: 'healthy' | 'attention';
  last_notification_attempt_fingerprint?: string;
  last_notification_attempt_at?: string;
}

interface SchedulerTaskStatus {
  id?: unknown;
  consecutive_failures?: unknown;
  last_success_at?: unknown;
  last_attempt_at?: unknown;
  stale_anomaly?: unknown;
  last_error_kind?: unknown;
  degraded_reason?: unknown;
  last_result?: { status?: unknown };
}

interface SchedulerSourceStatus {
  source_id?: unknown;
  tasks?: unknown;
}

interface SchedulerStatus {
  kind?: unknown;
  enabled?: unknown;
  running?: unknown;
  sources?: unknown;
}

export interface RunSourceSchedulerHealthMonitorOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface RunSourceSchedulerHealthMonitorResult {
  report: SourceSchedulerHealthMonitorReport;
  exitCode: number;
}

/** Counts and safe categorical tokens only: no task ids and no free text. */
export interface DegradeNoticeRequest {
  kind: 'source_scheduler_degrade_notice_request';
  requested_at: string;
  reasons: string[];
  monitored_tasks: number;
  degraded_tasks: number;
}

export interface SourceSchedulerDeliverySmokeReport {
  kind: 'source_scheduler_delivery_smoke_report';
  generated_at: string;
  /**
   * `delivery_smoke` is the explicit non-incident test. `degrade_notice`
   * means this run consumed a bounded degrade request and announced a real
   * degraded deploy instead.
   */
  mode: 'delivery_smoke' | 'degrade_notice';
  status: 'sent' | 'failed';
  reasons?: string[];
  last_error_hash?: string;
  policy: {
    explicit_non_incident: boolean;
    counts_only: true;
    source_ids_exposed: false;
    task_ids_exposed: false;
    source_text_returned: false;
    secrets_exposed: false;
  };
}

export function parseSourceSchedulerMonitorTasks(value: string | undefined): SourceSchedulerMonitorTask[] {
  const raw = value?.trim();
  if (!raw) throw new Error('configuration: source scheduler monitor task selection is required.');
  const selected = raw.split(',').map((entry) => {
    const fields = entry.trim().split('/');
    if (fields.length !== 3) throw new Error('configuration: invalid source scheduler monitor task selection.');
    const [sourceId = '', taskId = '', maxAgeRaw = ''] = fields;
    const maxAgeSeconds = Number(maxAgeRaw);
    if (!TASK_KEY_PATTERN.test(sourceId) || !TASK_KEY_PATTERN.test(taskId)
        || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
      throw new Error('configuration: invalid source scheduler monitor task selection.');
    }
    return { sourceId, taskId, maxAgeSeconds };
  });
  const deduped = new Map(selected.map((task) => [`${task.sourceId}/${task.taskId}`, task]));
  if (deduped.size !== selected.length) {
    throw new Error('configuration: duplicate source scheduler monitor task selection.');
  }
  return [...deduped.values()];
}

export async function runSourceSchedulerHealthMonitor(
  options: RunSourceSchedulerHealthMonitorOptions = {},
): Promise<RunSourceSchedulerHealthMonitorResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = validDate((options.now ?? (() => new Date()))());
  const tasks = parseSourceSchedulerMonitorTasks(env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_TASKS);
  const statePath = env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_STATE_PATH?.trim() || DEFAULT_STATE_PATH;
  const reportPath = env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_REPORT_PATH?.trim() || DEFAULT_REPORT_PATH;
  const state = readMonitorState(statePath);
  const failureThreshold = positiveInteger(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_FAILURE_THRESHOLD,
    DEFAULT_FAILURE_THRESHOLD,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_FAILURE_THRESHOLD',
  );
  const bootstrapGraceSeconds = positiveInteger(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_BOOTSTRAP_GRACE_SECONDS,
    DEFAULT_BOOTSTRAP_GRACE_SECONDS,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_BOOTSTRAP_GRACE_SECONDS',
  );
  const notificationRetrySeconds = positiveInteger(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_NOTIFICATION_RETRY_SECONDS,
    DEFAULT_NOTIFICATION_RETRY_SECONDS,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_NOTIFICATION_RETRY_SECONDS',
  );
  const notificationReminderSeconds = positiveInteger(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_NOTIFICATION_REMINDER_SECONDS,
    DEFAULT_NOTIFICATION_REMINDER_SECONDS,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_NOTIFICATION_REMINDER_SECONDS',
  );
  const timeoutMs = positiveInteger(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_HTTP_TIMEOUT_MS,
    DEFAULT_HTTP_TIMEOUT_MS,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_HTTP_TIMEOUT_MS',
  );
  const hookUrl = validatedLoopbackHttpUrl(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_WAKE_HOOK_URL,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_WAKE_HOOK_URL',
  );
  const hookTokenFile = requiredPath(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_WAKE_HOOK_TOKEN_FILE,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_WAKE_HOOK_TOKEN_FILE',
  );
  const workerAuthHeaderFile = env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_WORKER_AUTH_HEADER_FILE?.trim()
    || DEFAULT_AUTH_HEADER_FILE;
  const statusUrl = validatedLoopbackHttpUrl(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_STATUS_URL || DEFAULT_STATUS_URL,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_STATUS_URL',
  );
  assertPrivateRegularFile(hookTokenFile, 'wake hook token file');
  assertPrivateRegularFile(workerAuthHeaderFile, 'worker authorization header file');

  let schedulerStatus: SchedulerStatus | undefined;
  let statusErrorHash: string | undefined;
  try {
    const authorization = readAuthorizationHeader(workerAuthHeaderFile);
    const response = await fetchWithTimeout(fetchImpl, statusUrl, {
      method: 'GET',
      headers: { Authorization: authorization },
    }, timeoutMs);
    if (!response.ok) throw new Error(`scheduler status returned HTTP ${response.status}`);
    schedulerStatus = await response.json() as SchedulerStatus;
    if (schedulerStatus?.kind !== 'source_scheduler_status') {
      throw new Error('scheduler status returned an invalid payload');
    }
  } catch (error) {
    statusErrorHash = hashFailure(error);
  }

  const evaluation = evaluateSchedulerHealth({
    status: schedulerStatus,
    tasks,
    state,
    now,
    failureThreshold,
    bootstrapGraceSeconds,
  });
  const health = evaluation.attention ? 'attention' : 'healthy';
  const fingerprint = health === 'healthy'
    ? 'healthy'
    : affectedSetFingerprint(evaluation.affectedTaskHashes, {
        schedulerInactive: evaluation.schedulerInactive,
        schedulerStatusUnavailable: schedulerStatus === undefined,
      });
  const notificationDecision = shouldNotify({
    health,
    fingerprint,
    state,
    now,
    retrySeconds: notificationRetrySeconds,
    reminderSeconds: notificationReminderSeconds,
  });
  let notification: SourceSchedulerHealthMonitorReport['notification'] = notificationDecision;
  let notificationErrorHash: string | undefined;

  if (notificationDecision === 'sent') {
    state.last_notification_attempt_health = health;
    state.last_notification_attempt_fingerprint = fingerprint;
    state.last_notification_attempt_at = now.toISOString();
    try {
      await postWakeNotification({
        fetchImpl,
        hookUrl,
        tokenFile: hookTokenFile,
        timeoutMs,
        health,
        monitoredTasks: tasks.length,
        affectedTasks: evaluation.affectedTasks,
        affectedSourceIds: evaluation.affectedSourceIds,
      });
      state.last_notification_health = health;
      state.last_notification_fingerprint = fingerprint;
      state.last_notification_at = now.toISOString();
    } catch (error) {
      notification = 'failed';
      notificationErrorHash = hashFailure(error);
    }
  }

  state.first_seen_by_task_hash = evaluation.firstSeenByTaskHash;
  writePrivateJson(statePath, state);
  const lastErrorHash = notificationErrorHash ?? statusErrorHash;
  const report: SourceSchedulerHealthMonitorReport = {
    kind: 'source_scheduler_health_monitor_report',
    generated_at: now.toISOString(),
    status: health,
    monitored_tasks: tasks.length,
    affected_tasks: evaluation.affectedTasks,
    affected_source_ids: evaluation.affectedSourceIds,
    stale_tasks: evaluation.staleTasks,
    failing_tasks: evaluation.failingTasks,
    refused_tasks: evaluation.refusedTasks,
    missing_tasks: evaluation.missingTasks,
    scheduler_inactive: evaluation.schedulerInactive,
    scheduler_status_unavailable: schedulerStatus === undefined,
    notification,
    ...(lastErrorHash ? { last_error_hash: lastErrorHash } : {}),
    policy: monitorPrivacyPolicy(),
  };
  writePrivateJson(reportPath, report);
  return {
    report,
    exitCode: notification === 'failed' ? 3 : health === 'attention' ? 2 : 0,
  };
}

export async function runSourceSchedulerDeliverySmoke(
  options: RunSourceSchedulerHealthMonitorOptions = {},
): Promise<{ report: SourceSchedulerDeliverySmokeReport; exitCode: number }> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = validDate((options.now ?? (() => new Date()))());
  const timeoutMs = positiveInteger(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_HTTP_TIMEOUT_MS,
    DEFAULT_HTTP_TIMEOUT_MS,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_HTTP_TIMEOUT_MS',
  );
  const hookUrl = validatedLoopbackHttpUrl(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_WAKE_HOOK_URL,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_WAKE_HOOK_URL',
  );
  const hookTokenFile = requiredPath(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_WAKE_HOOK_TOKEN_FILE,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_WAKE_HOOK_TOKEN_FILE',
  );
  const reportPath = env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_DELIVERY_SMOKE_REPORT_PATH?.trim()
    || DEFAULT_DELIVERY_SMOKE_REPORT_PATH;
  const noticePath = env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_DEGRADE_NOTICE_PATH?.trim()
    || join(dirname(reportPath), DEFAULT_DEGRADE_NOTICE_BASENAME);
  const noticeMaxAgeSeconds = positiveInteger(
    env.OLYMPUS_SOURCE_SCHEDULER_MONITOR_DEGRADE_NOTICE_MAX_AGE_SECONDS,
    DEFAULT_DEGRADE_NOTICE_MAX_AGE_SECONDS,
    'OLYMPUS_SOURCE_SCHEDULER_MONITOR_DEGRADE_NOTICE_MAX_AGE_SECONDS',
  );
  assertPrivateRegularFile(hookTokenFile, 'wake hook token file');
  const notice = takeDegradeNotice(noticePath, now, noticeMaxAgeSeconds);
  let status: SourceSchedulerDeliverySmokeReport['status'] = 'sent';
  let lastErrorHash: string | undefined;
  try {
    await postWakeText({
      fetchImpl,
      hookUrl,
      tokenFile: hookTokenFile,
      timeoutMs,
      text: notice
        ? `Olympus source synchronization finished a deploy DEGRADED: ${notice.degraded_tasks} of ${notice.monitored_tasks} monitored task(s) are degraded (${notice.reasons.join(', ')}). The scheduler health monitor stays armed until they recover.`
        : 'Olympus source-scheduler notification delivery smoke completed. This is an explicit non-incident test; no source is reporting an alert.',
    });
  } catch (error) {
    status = 'failed';
    lastErrorHash = hashFailure(error);
  }
  const report: SourceSchedulerDeliverySmokeReport = {
    kind: 'source_scheduler_delivery_smoke_report',
    generated_at: now.toISOString(),
    mode: notice ? 'degrade_notice' : 'delivery_smoke',
    status,
    ...(notice ? { reasons: notice.reasons } : {}),
    ...(lastErrorHash ? { last_error_hash: lastErrorHash } : {}),
    policy: {
      explicit_non_incident: notice === undefined,
      counts_only: true,
      source_ids_exposed: false,
      task_ids_exposed: false,
      source_text_returned: false,
      secrets_exposed: false,
    },
  };
  writePrivateJson(reportPath, report);
  return { report, exitCode: status === 'sent' ? 0 : 3 };
}

/**
 * Reads and consumes a bounded degrade-notice request. The request carries
 * counts and safe categorical reason tokens only — never ids, never text —
 * and is deleted on read so a notice can never be replayed as proof of a
 * later deploy. Anything absent, stale, or malformed leaves the delivery
 * smoke exactly as it was: an explicit non-incident test.
 */
function takeDegradeNotice(
  path: string,
  now: Date,
  maxAgeSeconds: number,
): DegradeNoticeRequest | undefined {
  let raw: string;
  try {
    assertPrivateRegularFile(path, 'degrade notice request file');
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    rmSync(path, { force: true });
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DegradeNoticeRequest>;
    const requestedAt = validTimestamp(parsed.requested_at);
    if (parsed.kind !== 'source_scheduler_degrade_notice_request' || !requestedAt) return undefined;
    const ageMs = now.getTime() - Date.parse(requestedAt);
    if (ageMs < -MAX_DEGRADE_NOTICE_CLOCK_SKEW_MS || ageMs > maxAgeSeconds * 1_000) return undefined;
    if (!Array.isArray(parsed.reasons) || parsed.reasons.length < 1
      || parsed.reasons.length > MAX_DEGRADE_NOTICE_REASONS
      || parsed.reasons.some((reason) => safeStateToken(reason) === undefined)) {
      return undefined;
    }
    const monitoredTasks = safeCount(parsed.monitored_tasks);
    const degradedTasks = safeCount(parsed.degraded_tasks);
    if (monitoredTasks === undefined || degradedTasks === undefined) return undefined;
    return {
      kind: 'source_scheduler_degrade_notice_request',
      requested_at: requestedAt,
      reasons: [...new Set(parsed.reasons)],
      monitored_tasks: monitoredTasks,
      degraded_tasks: degradedTasks,
    };
  } catch {
    return undefined;
  }
}

function safeCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DEGRADE_NOTICE_COUNT
    ? value as number
    : undefined;
}

function evaluateSchedulerHealth(input: {
  status: SchedulerStatus | undefined;
  tasks: readonly SourceSchedulerMonitorTask[];
  state: MonitorState;
  now: Date;
  failureThreshold: number;
  bootstrapGraceSeconds: number;
}): {
  attention: boolean;
  affectedTasks: number;
  staleTasks: number;
  failingTasks: number;
  refusedTasks: number;
  missingTasks: number;
  schedulerInactive: boolean;
  affectedTaskHashes: string[];
  affectedSourceIds: string[];
  firstSeenByTaskHash: Record<string, string>;
} {
  const firstSeenByTaskHash: Record<string, string> = {};
  if (!input.status) {
    return {
      attention: true,
      affectedTasks: input.tasks.length,
      staleTasks: 0,
      failingTasks: 0,
      refusedTasks: 0,
      missingTasks: input.tasks.length,
      schedulerInactive: false,
      affectedTaskHashes: input.tasks.map(taskHash).sort(),
      affectedSourceIds: [...new Set(input.tasks.map((task) => task.sourceId))].sort(),
      firstSeenByTaskHash,
    };
  }
  const schedulerInactive = input.status.enabled !== true || input.status.running !== true;
  const sources = Array.isArray(input.status.sources)
    ? input.status.sources as SchedulerSourceStatus[]
    : [];
  const affected = new Set<string>();
  const affectedSourceIds = new Set<string>();
  let staleTasks = 0;
  let failingTasks = 0;
  let refusedTasks = 0;
  let missingTasks = 0;

  for (const selected of input.tasks) {
    const selectedHash = taskHash(selected);
    const previousFirstSeen = input.state.first_seen_by_task_hash[selectedHash];
    const firstSeen = validTimestamp(previousFirstSeen) ?? input.now.toISOString();
    firstSeenByTaskHash[selectedHash] = firstSeen;
    const source = sources.find((entry) => entry?.source_id === selected.sourceId);
    const sourceTasks = source && Array.isArray(source.tasks) ? source.tasks as SchedulerTaskStatus[] : [];
    const task = sourceTasks.find((entry) => entry?.id === selected.taskId);
    if (!task) {
      missingTasks += 1;
      affected.add(selectedHash);
      affectedSourceIds.add(selected.sourceId);
      continue;
    }
    const consecutiveFailures = Number.isSafeInteger(task.consecutive_failures)
      ? Number(task.consecutive_failures)
      : 0;
    if (consecutiveFailures >= input.failureThreshold || task.last_result?.status === 'failed') {
      failingTasks += 1;
      if (isRefusedFailure(task)) refusedTasks += 1;
      affected.add(selectedHash);
      affectedSourceIds.add(selected.sourceId);
    }
    const lastSuccess = validTimestamp(task.last_success_at);
    const lastAttempt = validTimestamp(task.last_attempt_at);
    const bootstrapAnchor = latestTimestamp(firstSeen, lastAttempt);
    // A newly started scheduler reports stale_anomaly immediately when a task
    // has never succeeded. Give it one fixed five-minute bootstrap window,
    // anchored to the later of monitor first-seen and scheduler last-attempt,
    // before treating that provider-neutral flag as an incident.
    const bootstrapComplete = input.now.getTime() - Date.parse(bootstrapAnchor)
      > input.bootstrapGraceSeconds * 1_000;
    const stale = lastSuccess
      ? task.stale_anomaly === true
        || input.now.getTime() - Date.parse(lastSuccess) > selected.maxAgeSeconds * 1_000
      : bootstrapComplete;
    if (stale) {
      staleTasks += 1;
      affected.add(selectedHash);
      affectedSourceIds.add(selected.sourceId);
    }
  }

  if (schedulerInactive) {
    for (const selected of input.tasks) {
      affected.add(taskHash(selected));
      affectedSourceIds.add(selected.sourceId);
    }
  }
  return {
    attention: schedulerInactive || affected.size > 0,
    affectedTasks: affected.size,
    staleTasks,
    failingTasks,
    refusedTasks,
    missingTasks,
    schedulerInactive,
    affectedTaskHashes: [...affected].sort(),
    affectedSourceIds: [...affectedSourceIds].sort(),
    firstSeenByTaskHash,
  };
}

/**
 * A refused task was declined by a local budget/quota guard before any
 * provider work; it is not a provider or pipeline failure. Refusals still
 * count as failing tasks — this only makes them separable in the report.
 */
function isRefusedFailure(task: SchedulerTaskStatus): boolean {
  const errorKind = safeStateToken(task.last_error_kind);
  return errorKind !== undefined && REFUSAL_KINDS.has(errorKind);
}

function safeStateToken(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_STATE_TOKEN_PATTERN.test(value) ? value : undefined;
}

function shouldNotify(input: {
  health: 'healthy' | 'attention';
  fingerprint: string;
  state: MonitorState;
  now: Date;
  retrySeconds: number;
  reminderSeconds: number;
}): 'not_needed' | 'sent' | 'suppressed' {
  const attemptAt = validTimestamp(input.state.last_notification_attempt_at);
  if (input.state.last_notification_attempt_health === input.health
      && input.state.last_notification_attempt_fingerprint === input.fingerprint
      && attemptAt
      && input.now.getTime() - Date.parse(attemptAt) < input.retrySeconds * 1_000
      && input.state.last_notification_health !== input.health) {
    return 'suppressed';
  }
  if (input.health === 'healthy') {
    return input.state.last_notification_health === 'attention' ? 'sent' : 'not_needed';
  }
  if (input.state.last_notification_health !== 'attention'
      || input.state.last_notification_fingerprint !== input.fingerprint) return 'sent';
  const lastNotificationAt = validTimestamp(input.state.last_notification_at);
  if (!lastNotificationAt
      || input.now.getTime() - Date.parse(lastNotificationAt) >= input.reminderSeconds * 1_000) {
    return 'sent';
  }
  return 'suppressed';
}

async function postWakeNotification(input: {
  fetchImpl: typeof fetch;
  hookUrl: string;
  tokenFile: string;
  timeoutMs: number;
  health: 'healthy' | 'attention';
  monitoredTasks: number;
  affectedTasks: number;
  affectedSourceIds: string[];
}): Promise<void> {
  const namedSources = input.affectedSourceIds.length > 0
    ? ` Affected source(s): ${input.affectedSourceIds.join(', ')}.`
    : '';
  const text = input.health === 'attention'
    ? `Olympus source synchronization needs attention: ${input.affectedTasks} of ${input.monitoredTasks} monitored task(s) are stale, failing, or unavailable.${namedSources} Inspect the scheduler health report.`
    : `Olympus source synchronization recovered: all ${input.monitoredTasks} monitored task(s) are healthy.`;
  await postWakeText({ ...input, text });
}

async function postWakeText(input: {
  fetchImpl: typeof fetch;
  hookUrl: string;
  tokenFile: string;
  timeoutMs: number;
  text: string;
}): Promise<void> {
  assertPrivateRegularFile(input.tokenFile, 'wake hook token file');
  const token = readFileSync(input.tokenFile, 'utf8').trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('wake hook token file is invalid');
  const response = await fetchWithTimeout(input.fetchImpl, input.hookUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: input.text, mode: 'now' }),
  }, input.timeoutMs);
  if (!response.ok) throw new Error(`wake hook returned HTTP ${response.status}`);
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timeout.unref === 'function') timeout.unref();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function readAuthorizationHeader(path: string): string {
  assertPrivateRegularFile(path, 'worker authorization header file');
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  const authorization = lines.find((line) => /^Authorization:\s*/i.test(line));
  if (!authorization) throw new Error('worker authorization header file is invalid');
  const value = authorization.replace(/^Authorization:\s*/i, '').trim();
  if (!value || /[\r\n]/.test(value)) throw new Error('worker authorization header file is invalid');
  return value;
}

function readMonitorState(path: string): MonitorState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MonitorState>;
    if (parsed.version !== 1 || !isStringRecord(parsed.first_seen_by_task_hash)) {
      throw new Error('invalid state');
    }
    return {
      version: 1,
      first_seen_by_task_hash: parsed.first_seen_by_task_hash,
      ...(parsed.last_notification_health === 'healthy' || parsed.last_notification_health === 'attention'
        ? { last_notification_health: parsed.last_notification_health }
        : {}),
      ...(isHash(parsed.last_notification_fingerprint)
        || parsed.last_notification_fingerprint === 'healthy'
        ? { last_notification_fingerprint: parsed.last_notification_fingerprint }
        : {}),
      ...(validTimestamp(parsed.last_notification_at)
        ? { last_notification_at: parsed.last_notification_at }
        : {}),
      ...(parsed.last_notification_attempt_health === 'healthy'
        || parsed.last_notification_attempt_health === 'attention'
        ? { last_notification_attempt_health: parsed.last_notification_attempt_health }
        : {}),
      ...(isHash(parsed.last_notification_attempt_fingerprint)
        || parsed.last_notification_attempt_fingerprint === 'healthy'
        ? { last_notification_attempt_fingerprint: parsed.last_notification_attempt_fingerprint }
        : {}),
      ...(validTimestamp(parsed.last_notification_attempt_at)
        ? { last_notification_attempt_at: parsed.last_notification_attempt_at }
        : {}),
    };
  } catch {
    return { version: 1, first_seen_by_task_hash: {} };
  }
}

function writePrivateJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function taskHash(task: SourceSchedulerMonitorTask): string {
  return createHash('sha256').update(`${task.sourceId}\0${task.taskId}`).digest('hex');
}

function affectedSetFingerprint(
  taskHashes: readonly string[],
  flags: { schedulerInactive: boolean; schedulerStatusUnavailable: boolean },
): string {
  return createHash('sha256').update(JSON.stringify({
    task_hashes: [...taskHashes].sort(),
    scheduler_inactive: flags.schedulerInactive,
    scheduler_status_unavailable: flags.schedulerStatusUnavailable,
  })).digest('hex');
}

function latestTimestamp(first: string, second: string | undefined): string {
  if (!second) return first;
  return Date.parse(second) > Date.parse(first) ? second : first;
}

function hashFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.name}:${error.message}` : 'unknown';
  return createHash('sha256').update(message).digest('hex').slice(0, 16);
}

function validatedLoopbackHttpUrl(value: string | undefined, name: string): string {
  try {
    const parsed = new URL(value?.trim() ?? '');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid protocol');
    if (parsed.username || parsed.password) throw new Error('URL credentials are forbidden');
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') {
      throw new Error('non-loopback host');
    }
    return parsed.toString();
  } catch {
    throw new Error(`configuration: ${name} must be a credential-free loopback http(s) URL.`);
  }
}

function assertPrivateRegularFile(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`configuration: ${label} must be a private regular file.`);
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o400) === 0 || (stat.mode & 0o077) !== 0
      || (currentUid !== undefined && stat.uid !== currentUid)) {
    throw new Error(`configuration: ${label} must be a private regular file.`);
  }
}

function requiredPath(value: string | undefined, name: string): string {
  const path = value?.trim();
  if (!path || /[\r\n]/.test(path)) throw new Error(`configuration: ${name} must be a path.`);
  return path;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`configuration: ${name} must be a positive integer.`);
  }
  return parsed;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error('monitor clock returned an invalid date');
  return value;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function monitorPrivacyPolicy(): SourceSchedulerHealthMonitorReport['policy'] {
  return {
    counts_only: true,
    source_ids_exposed: true,
    task_ids_exposed: false,
    raw_source_exposed: false,
    source_text_returned: false,
    secrets_exposed: false,
  };
}

if (import.meta.main) {
  const command = process.argv.includes('--delivery-smoke')
    ? runSourceSchedulerDeliverySmoke()
    : runSourceSchedulerHealthMonitor();
  command
    .then((result) => {
      console.log(JSON.stringify(result.report));
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error(`Source scheduler health monitor failed safely (${hashFailure(error)}).`);
      process.exitCode = 3;
    });
}
