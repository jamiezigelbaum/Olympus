/**
 * The scheduler's daily-budget markers as limit stops (core/limit-stops.ts):
 * a task parked behind one reports a stop, and the stop clears when the
 * marker does, in the same transaction as the marker write.
 */
import type { Database } from 'bun:sqlite';
import { clearLimitStop, registerLimit, reportLimitStop } from '../core/limit-stops.ts';

// Labels use the existing daily-budget wait copy. Amounts are unknown here:
// scheduler markers carry neither the provider's daily ledger nor its config.
const DAILY_LIMITS = new Map<string, { id: string; kind: 'cost' | 'requests'; label: string }>(Object.entries({
  daily_cost_guard: { id: 'x.daily_cost', kind: 'cost', label: 'daily X API budget used' },
  daily_api_request_guard: { id: 'x.daily_requests', kind: 'requests', label: 'daily X API budget used' },
  daily_resource_read_guard: { id: 'x.daily_resource_reads', kind: 'requests', label: 'daily X API budget used' },
  // Background reconcile stops short of the day's budget to keep a reserve for new bookmarks.
  head_api_request_reserve_guard: { id: 'x.head_reserve_requests', kind: 'requests', label: 'daily X API budget used' },
  head_resource_read_reserve_guard: { id: 'x.head_reserve_reads', kind: 'requests', label: 'daily X API budget used' },
  head_cost_reserve_guard: { id: 'x.head_reserve_cost', kind: 'cost', label: 'daily X API budget used' },
  readwise_daily_api_request_guard: { id: 'readwise.daily_requests', kind: 'requests', label: 'daily Readwise API budget used' },
  gmail_daily_api_request_guard: { id: 'gmail.daily_requests', kind: 'requests', label: 'daily Gmail API budget used' },
  google_drive_daily_api_request_guard: { id: 'drive.daily_requests', kind: 'requests', label: 'daily Google Drive API budget used' },
}));

for (const limit of DAILY_LIMITS.values()) {
  registerLimit({ ...limit, scope: 'source', unit: limit.kind === 'cost' ? 'usd' : 'requests', continue: 'run_once' });
}

/** A scheduler stop's subject: `[source_id, corpus_id, task_id]` as JSON. */
export function schedulerLimitSubject(state: { sourceId: string; corpusId: string; taskId: string }): string {
  return JSON.stringify([state.sourceId, state.corpusId, state.taskId]);
}

/** Runs inside the background scheduler's marker transaction, never on a read. */
export function syncSchedulerLimitStop(db: Database, previousReason: string | undefined, state: {
  sourceId: string; corpusId: string; taskId: string; updatedAt: string;
  degradedReason?: string; notBeforeAt?: string;
}): void {
  const previous = previousReason ? DAILY_LIMITS.get(previousReason) : undefined;
  const current = state.degradedReason ? DAILY_LIMITS.get(state.degradedReason) : undefined;
  if (!previous && !current) return;
  // Tasks sharing a source can park and resume independently.
  const subject = schedulerLimitSubject(state);
  if (previous && previous.id !== current?.id) clearLimitStop(previous.id, subject, db);
  if (current) reportLimitStop({
    id: current.id, subject, since: state.updatedAt, limit: null, used: null,
    resumesAt: dailyResume(state.updatedAt, state.notBeforeAt),
  }, db);
}

/**
 * These budgets are per UTC day, and the scheduler treats their markers as
 * absent once the day they were set on has ended (source-scheduler.ts,
 * reportedDegradedReason), even if the task never runs again. The stop ends
 * then too, or earlier when the task is booked to retry earlier.
 */
function dailyResume(since: string, notBeforeAt: string | undefined): string {
  const day = new Date(since);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
  const retry = notBeforeAt ? Date.parse(notBeforeAt) : NaN;
  return new Date(Number.isFinite(retry) && retry < midnight ? retry : midnight).toISOString();
}
