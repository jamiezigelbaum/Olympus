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
import { SOURCE_RATE_LIMITED } from '../../core/provider-rate-limits.ts';
import { redactLogLine } from '../../core/log-redaction.ts';
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
  rate_limited: SOURCE_RATE_LIMITED,
  provider_rate_limit: SOURCE_RATE_LIMITED,
  'x.rate_limit': SOURCE_RATE_LIMITED,
  'evernote.rate_limit': SOURCE_RATE_LIMITED,
  'readwise.rate_limit': SOURCE_RATE_LIMITED,
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
      return 'daily_limit';
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

/** Support reports project closed codes only; escaping arbitrary text is insufficient. */
const SUPPORT_SOURCES = new Set(['gmail.email', 'google_drive.docs', 'dropbox.files', 'local.files', 'readwise.library', 'x.bookmarks', 'evernote.notes', 'telegram.messages', 'whatsapp.personal.messages', 'archive.imports']);
const SUPPORT_STATES = new Set(['Off', 'Waiting', 'Working', 'Fresh', 'Needs you', 'Failing', 'not_connected', 'needs_setup', 'awaiting_consent', 'reauth_required', 'connected', 'waiting_for_first_sync', 'syncing', 'synced']);
/**
 * What a source in Needs you or Failing waits on, as a closed code, so a report
 * whose failure is none still says why (owner, Sparta 2026-11-04: "State: Needs
 * you / Failure: none" named nothing).
 */
const SUPPORT_NEEDS = new Set(['finish_sign_in', 'sign_in', 'choose_folders', 'import_attention', 'waiting_for_credentials', 'scope_pending',
  'scope_root_missing', 'scope_root_permission_needed', 'scope_root_helper_needed', 'scope_root_unreadable', 'provider_unavailable', 'model_downloading', 'storage_move', 'disk_full', 'live_feed', 'answer_readiness', 'queue', 'unknown']);
export interface SourceSupportState { sourceId: unknown; state: unknown; failure?: unknown; ref?: unknown; need?: unknown }

export function sourceSupportDetails(input: SourceSupportState): string {
  const source = typeof input.sourceId === 'string' && SUPPORT_SOURCES.has(input.sourceId) ? input.sourceId : 'unknown';
  const state = typeof input.state === 'string' && SUPPORT_STATES.has(input.state) ? input.state : 'unknown';
  return [`Source: ${source}`, `State: ${state}`, `Failure: ${isSourceFailureKind(input.failure) ? input.failure : input.failure === undefined ? 'none' : 'unknown'}`,
    ...(input.need === undefined ? [] : [`Needs: ${typeof input.need === 'string' && SUPPORT_NEEDS.has(input.need) ? input.need : 'unknown'}`]),
    ...(sourceFailureRef(input.ref) ? [`Reference: ${sourceFailureRef(input.ref)}`] : [])].join('\n');
}

export interface SystemSupportFacts {
  version: string;
  os: string;
  osVersion: string;
  host: string;
  engine: string;
  model: string;
  remote: string;
  logs: readonly string[];
  downloads?: { search: string; transcription: string };
}

export function systemSupportReport(input: SystemSupportFacts & { sources: readonly SourceSupportState[] }): string {
  const pick = (value: string, allowed: readonly string[]) => allowed.includes(value) ? value : 'unknown';
  const version = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)\.\d{1,4})?$/.test(input.version) ? input.version : 'unknown';
  const osVersion = input.osVersion.match(/^\d{1,4}(?:\.\d{1,4}){0,3}(?=$|[-+])/)?.[0] ?? 'unknown';
  // Never copy a whole log line: even redactLogLine intentionally retains names.
  // Only this known event and its closed failure + hash fields cross into support.
  const logs = input.logs.flatMap(raw => {
    const line = redactLogLine(raw);
    if (!line.includes('[olympus:source-scheduler] task_failed ')) return [];
    const failure = line.match(/\berror_kind=([a-z_]+)(?:\s|$)/)?.[1];
    const ref = sourceFailureRef(line.match(/\berror_hash=([0-9a-f]{16})(?:\s|$)/)?.[1]);
    return [`task_failed failure=${sourceFailureKind(failure)}${ref ? ` ref=${ref}` : ''}`];
  }).slice(-5);
  return [
    `Olympus ${version}`, `OS: ${pick(input.os, ['darwin', 'linux', 'win32'])} ${osVersion}`,
    `Host: ${pick(input.host, ['standalone', 'openclaw'])}`, `Engine: ${pick(input.engine, ['running', 'stopped', 'starting', 'failed'])}`,
    `Private answer model: ${pick(input.model, ['not_started', 'downloading', 'verifying', 'loading', 'ready', 'failed', 'disabled'])}`,
    ...(input.downloads ? [`Search model: ${pick(input.downloads.search, ['custom', 'not_started', 'downloading', 'verifying', 'ready', 'failed'])}`, `Transcription model: ${pick(input.downloads.transcription, ['disabled', 'not_needed', 'not_downloaded', 'interrupted', 'downloading', 'verifying', 'ready', 'failed', 'load_failed'])}`] : []),
    `Remote access: ${pick(input.remote, ['on', 'off', 'not_connected', 'invalid', 'awaiting_terms'])}`,
    ...(input.sources.length ? input.sources.map(sourceSupportDetails) : ['Source states: unavailable']), 'Recent events:', ...(logs.length ? logs : ['No code-only events available.']),
  ].join('\n');
}
