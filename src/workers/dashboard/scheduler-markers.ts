/**
 * The scheduler degradation markers that mean Olympus paused itself.
 *
 * None of them asks the reader for anything: the daily budgets park a lane
 * until the UTC rollover, and a provider rate limit clears on the provider's
 * own reset clock. Reconnecting a credential changes none of it.
 *
 * `api_request_guard` is deliberately absent — that one IS the provider
 * refusing, and reconnecting the credential is the way out.
 *
 * Shared by the view model, which must not arm a connect control on a lane in
 * this set, and the detail page, which translates the same marker into the
 * sentence above the checks. They read one list because a lane the card treats
 * as refusing and the page describes as paused is exactly the 2026-08-19
 * dashboard-honesty defect.
 */
import type { Database } from 'bun:sqlite';
import { clearLimitStop, registerLimit, reportLimitStop } from '../../core/limit-stops.ts';

// Labels use the existing daily-budget wait copy. Amounts are unknown here:
// scheduler markers carry neither the provider's daily ledger nor its config.
const DAILY_LIMITS = new Map<string, { id: string; kind: 'cost' | 'requests'; label: string }>(Object.entries({
  daily_cost_guard: { id: 'x.daily_cost', kind: 'cost', label: 'daily X API budget used' },
  daily_api_request_guard: { id: 'x.daily_requests', kind: 'requests', label: 'daily X API budget used' },
  daily_resource_read_guard: { id: 'x.daily_resource_reads', kind: 'requests', label: 'daily X API budget used' },
  readwise_daily_api_request_guard: { id: 'readwise.daily_requests', kind: 'requests', label: 'daily Readwise API budget used' },
  gmail_daily_api_request_guard: { id: 'gmail.daily_requests', kind: 'requests', label: 'daily Gmail API budget used' },
  google_drive_daily_api_request_guard: { id: 'drive.daily_requests', kind: 'requests', label: 'daily Google Drive API budget used' },
}));

for (const limit of DAILY_LIMITS.values()) {
  registerLimit({ ...limit, scope: 'source', unit: limit.kind === 'cost' ? 'usd' : 'requests', continue: 'run_once' });
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
  const subject = JSON.stringify([state.sourceId, state.corpusId, state.taskId]);
  if (previous && previous.id !== current?.id) clearLimitStop(previous.id, subject, db);
  if (current) reportLimitStop({
    id: current.id, subject, since: state.updatedAt, limit: null, used: null,
    ...(state.notBeforeAt ? { resumesAt: state.notBeforeAt } : {}),
  }, db);
}

export const OPERATOR_PAUSED_SCHEDULER_MARKERS: ReadonlySet<string> = new Set([
  'daily_api_request_guard',
  'daily_resource_read_guard',
  'daily_cost_guard',
  'readwise_daily_api_request_guard',
  'gmail_daily_api_request_guard',
  'google_drive_daily_api_request_guard',
  'head_api_request_reserve_guard',
  'head_resource_read_reserve_guard',
  'head_cost_reserve_guard',
  'provider_rate_limit',
]);
