/**
 * Why a source's sync is failing or paused, as one closed word (owner rule,
 * 2026-10-10: never say something is wrong without a way to find out exactly
 * what it is).
 *
 * The scheduler records a categorical `error_kind` per failure and a
 * day-scoped or provider-scoped `degraded_reason` marker; both are Olympus's
 * own tokens, never provider text. This maps them onto the words the
 * dashboard can say. A failure Olympus could not classify keeps the
 * scheduler's `error_hash`: the same value its log line carries
 * (`[olympus:source-scheduler] task_failed … error_hash=…` with the message),
 * so "look for <ref> in Olympus's log" leads to the exact error.
 */
import { OPERATOR_PAUSED_SCHEDULER_MARKERS } from './scheduler-markers.ts';

/**
 * Why a sync failed or a source is paused, as one closed word (owner rule,
 * 2026-10-10: never say something is wrong without a way to find out exactly
 * what it is). `unknown` is a failure Olympus could not classify: it comes
 * with a `ref`, the value Olympus's log carries beside the error's message.
 */
export const SOURCE_FAILURE_KINDS = [
  'sign_in',
  'network',
  'timeout',
  'rate_limited',
  'provider_busy',
  'provider_refused',
  'daily_limit',
  'search_model_unavailable',
  'reader_unavailable',
  'busy_here',
  'setup',
  'not_started',
  'unknown',
] as const;
export type SourceFailureKind = typeof SOURCE_FAILURE_KINDS[number];

const KIND_SET: ReadonlySet<string> = new Set(SOURCE_FAILURE_KINDS);

export function isSourceFailureKind(value: unknown): value is SourceFailureKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

const EXACT: Readonly<Record<string, SourceFailureKind>> = {
  credential_missing: 'sign_in',
  credential_reauth_required: 'sign_in',
  credential_session_latched: 'sign_in',
  credential_refresh_busy: 'busy_here',
  sqlite_busy: 'busy_here',
  network: 'network',
  timeout: 'timeout',
  rate_limited: 'rate_limited',
  provider_rate_limit: 'rate_limited',
  temporary: 'provider_busy',
  api_request_guard: 'provider_refused',
  embedding_backend_unavailable: 'search_model_unavailable',
  embedding_provider_unavailable: 'search_model_unavailable',
  embedding_items_failed: 'search_model_unavailable',
  vlm_backend_unavailable: 'reader_unavailable',
  config_missing_folder_argument: 'setup',
};

/**
 * The closed word for a scheduler error kind or degradation marker; `unknown`
 * for anything Olympus did not classify (its log has the message).
 */
export function sourceFailureKind(errorKind: string | undefined, degradedReason?: string): SourceFailureKind {
  for (const value of [errorKind, degradedReason]) {
    if (typeof value !== 'string' || !value) continue;
    const exact = EXACT[value];
    if (exact) return exact;
    if (OPERATOR_PAUSED_SCHEDULER_MARKERS.has(value) || value.endsWith('_request_guard') || value.endsWith('_clock_regression')) {
      return value === 'provider_rate_limit' ? 'rate_limited' : 'daily_limit';
    }
    if (value.endsWith('_ledger_busy')) return 'busy_here';
  }
  return 'unknown';
}

/**
 * The reference an unclassified failure is logged under: the scheduler's
 * 16-hex `error_hash`, or a fresh one minted beside a log line. Anything else
 * is dropped.
 */
export function sourceFailureRef(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) ? value : undefined;
}
