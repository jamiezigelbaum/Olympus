/**
 * The allowlisted response builder: the ONLY way a ChatGPT-bound response
 * leaves the engine. Every tool result (text content, structuredContent,
 * _meta) and every error message on the ChatGPT surface is built here.
 *
 * Rules, each enforced by construction rather than by a scan:
 * - Fields are copied one by one into fresh objects. Nothing is spread from an
 *   internal object, so a field added upstream never reaches ChatGPT by
 *   accident.
 * - Free text is either a fixed string from this module or the dashboard
 *   producer's closed vocabulary, or the released `answer` the release gate
 *   already decided the calling assistant may see.
 * - Only Public and Personal evidence is cited (titles, links, dates). Private
 *   and Secret items are never cited or summarized; a Private match adds one
 *   fixed sentence and, for the private answer panel, a capped count and the
 *   panel state (`structuredContent.privateMatch`) plus the panel's one-time
 *   job id in widget-only `_meta` (privateAnswerMeta). No private answer text,
 *   key or token ever passes through here. Secret locations, folder names,
 *   corpus ids, internal ids and timings are never copied.
 * - Errors carry a fixed sentence per error code, never the internal message.
 *
 * `_meta` reaches only the UI, never the model, but it still leaves the Mac
 * and passes through OpenAI, so it gets the same treatment.
 */
import { OperationError, type OperationErrorCode } from '../../core/operation-error.ts';
import { DASHBOARD_SUPPORTED_SOURCES } from '../source-dashboard.ts';
import type {
  ConnectionState,
  DashboardFix,
  DashboardItem,
  DashboardSource,
  DashboardViewModelV1,
} from './dashboard-contract.ts';
import { DASHBOARD_RESOURCE_URI, DASHBOARD_TOOL_NAME } from './dashboard-contract.ts';
import { DASHBOARD_CHATGPT_VOCABULARY } from '../dashboard/vocabulary.ts';
import { credentialInstallId } from '../../../connect-relay/shared/tokens.ts';
import {
  PRIVATE_ANSWER_META_KEY,
  PRIVATE_ANSWER_RESOURCE_URI,
  PRIVATE_MATCH_COUNT_CAP,
  type PrivateAnswerMetaV1,
  type PrivateAnswerPanelState,
  type PrivateMatchSummary,
} from './private-answer-contract.ts';

export interface ChatGptTextContent {
  type: 'text';
  text: string;
}

export interface ChatGptToolResult {
  [key: string]: unknown;
  content: ChatGptTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const MAX_TEXT = 400;
const MAX_ANSWER = 64 * 1024;
const MAX_CITATIONS = 20;
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

/** Tools the dashboard UI may name in a Fix. Anything else is dropped. */
const FIX_TOOLS = new Set<string>([DASHBOARD_TOOL_NAME]);
const FIX_HREF_HOST = 'olympusplugin.ai';

const CONNECTION_STATES = new Set<ConnectionState>(['not_installed', 'installing', 'ready', 'mac_offline', 'relay_unavailable']);
const CONNECTION_ACTIONS = new Set(['install', 'open_olympus', 'wake_mac', 'retry']);
const STATUSES = new Set(['Fresh', 'Working', 'Waiting', 'Needs you', 'Failing', 'Off']);
const UNITS = new Set(['files', 'messages', 'items']);
const EMBEDDING_STATES = new Set(['downloading', 'ready', 'failed']);
const ANSWER_KINDS = new Set(['built_in', 'venice', 'local']);
/** Trust domains whose item metadata may be cited. Private (secure_local) and Secret never. */
const CITABLE_TRUST_DOMAINS = new Set(['public_safe', 'internal']);

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export function dashboardToolResult(view: DashboardViewModelV1): ChatGptToolResult {
  const structured = copyDashboardViewModel(view);
  return {
    content: [{ type: 'text', text: dashboardSummary(structured) }],
    structuredContent: structured as unknown as Record<string, unknown>,
  };
}

/** Explicit, field-by-field copy of the v1 contract. */
export function copyDashboardViewModel(view: DashboardViewModelV1): DashboardViewModelV1 {
  const state = CONNECTION_STATES.has(view.connection?.state) ? view.connection.state : 'installing';
  const connection: DashboardViewModelV1['connection'] = { state };
  if (state === 'mac_offline' && iso(view.connection.lastSeenAt)) connection.lastSeenAt = iso(view.connection.lastSeenAt)!;
  if (view.connection.action && CONNECTION_ACTIONS.has(view.connection.action.id)) {
    const href = safeHref(view.connection.action.href);
    connection.action = { id: view.connection.action.id, ...(href ? { href } : {}) };
  }
  if (state === 'installing' && view.connection.progress) {
    connection.progress = {
      percent: percent(view.connection.progress.percent),
      label: text(view.connection.progress.label),
    };
  }
  const out: DashboardViewModelV1 = {
    v: 1,
    connection,
    needsYou: (view.needsYou ?? []).map(copyItem),
    sources: (view.sources ?? []).map(copySource),
    models: {
      embedding: {
        kind: view.models?.embedding?.kind === 'built_in' ? 'built_in' : 'custom',
        state: EMBEDDING_STATES.has(view.models?.embedding?.state) ? view.models.embedding.state : 'failed',
        ...(view.models?.embedding?.state === 'downloading' && finite(view.models.embedding.percent)
          ? { percent: percent(view.models.embedding.percent) }
          : {}),
      },
    },
    generatedAt: iso(view.generatedAt) ?? new Date().toISOString(),
  };
  if (view.blocker) out.blocker = copyItem(view.blocker);
  const answers = view.models?.answers;
  if (answers && ANSWER_KINDS.has(answers.kind)) {
    out.models.answers = { kind: answers.kind, label: text(answers.label), ready: answers.ready === true };
  }
  if (view.models?.change) out.models.change = copyFix(view.models.change);
  const progress = view.progress;
  if (progress) {
    out.progress = {
      unit: UNITS.has(progress.unit) ? progress.unit : 'items',
      phase: progress.phase === 'initial' ? 'initial' : 'refresh',
      percent: percent(progress.percent),
      itemsLeft: whole(progress.itemsLeft),
      ...(finite(progress.etaSeconds) ? { etaSeconds: whole(progress.etaSeconds) } : {}),
      stalled: progress.stalled === true,
      details: (progress.details ?? []).map((detail) => ({
        stage: text(detail.stage),
        unit: UNITS.has(detail.unit) ? detail.unit : 'items',
        done: whole(detail.done),
        total: whole(detail.total),
      })),
    };
  }
  return out;
}

function copyItem(item: DashboardItem): DashboardItem {
  return { id: identifier(item.id), sentence: text(item.sentence), fix: copyFix(item.fix) };
}

function copySource(source: DashboardSource): DashboardSource {
  const out: DashboardSource = {
    id: identifier(source.id),
    label: text(source.label),
    group: source.group === 'local' ? 'local' : 'cloud',
    status: STATUSES.has(source.status) ? source.status : 'Waiting',
  };
  if (source.detail) out.detail = text(source.detail);
  if (iso(source.lastSyncAt)) out.lastSyncAt = iso(source.lastSyncAt)!;
  if (source.primary) out.primary = copyFix(source.primary);
  if (source.menu && source.menu.length > 0) out.menu = source.menu.map(copyFix);
  return out;
}

function copyFix(fix: DashboardFix): DashboardFix {
  const out: DashboardFix = { label: text(fix?.label) };
  if (typeof fix?.tool === 'string' && FIX_TOOLS.has(fix.tool)) {
    out.tool = fix.tool;
    // Fix tools in v1 take no arguments; anything else is dropped.
    out.args = {};
  }
  const href = safeHref(fix?.href);
  if (href) out.href = href;
  if (fix?.disabledReason) out.disabledReason = text(fix.disabledReason);
  if (fix?.destructive === true) out.destructive = true;
  return out;
}

function dashboardSummary(view: DashboardViewModelV1): string {
  const parts: string[] = [];
  parts.push(view.connection.state === 'ready'
    ? 'Olympus is ready.'
    : `Olympus is ${view.connection.state.replace(/_/g, ' ')}${view.connection.progress ? `: ${view.connection.progress.label}` : ''}.`);
  const connected = view.sources.filter((source) => source.status !== 'Off');
  if (connected.length > 0) {
    parts.push(`Sources: ${connected.map((source) => `${source.label} (${source.status})`).join(', ')}.`);
  }
  if (view.progress) parts.push(`Indexing ${view.progress.percent}% done, ${view.progress.itemsLeft} ${view.progress.unit} left.`);
  if (view.needsYou.length > 0) parts.push(`Needs you: ${view.needsYou.map((item) => item.sentence.replace(/\.$/, '')).join('; ')}.`);
  return parts.join(' ');
}

/** The short status the source_index_status tool returns: dashboard rows only. */
export function sourceStatusToolResult(view: DashboardViewModelV1): ChatGptToolResult {
  const copy = copyDashboardViewModel(view);
  const sources = copy.sources.map((source) => ({
    label: source.label,
    status: source.status,
    ...(source.detail ? { detail: source.detail } : {}),
    ...(source.lastSyncAt ? { lastSyncAt: source.lastSyncAt } : {}),
  }));
  const structured = { ready: copy.connection.state === 'ready', sources };
  const lines = sources.map((source) => `${source.label}: ${source.status}${source.detail ? ` (${source.detail})` : ''}`);
  return {
    content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : 'No sources are set up in Olympus yet.' }],
    structuredContent: structured,
  };
}

/* ------------------------------------------------------------------ */
/* Answers                                                             */
/* ------------------------------------------------------------------ */

const PENDING_TEXT = 'Olympus is still preparing this answer on the Mac. Call source_answer_result with this job_id '
  + '(repeat while it says working). Do not ask the question again.';

export interface ChatGptCitation {
  source: string;
  title?: string;
  url?: string;
  date?: string;
}

export interface AnswerResultOptions {
  /** A Private item matched the question (found by the surface's own probe). */
  privateMatched?: boolean;
  /** The private answer panel's summary and job, when Private items matched. */
  privateMatch?: PrivateMatchSummary & { jobId?: string };
}

/**
 * A source_answer or source_answer_result outcome: the released answer and
 * citations, or the working marker with its job id.
 *
 * ChatGPT gets nothing tiered Private or Secret, summaries included. The
 * surface asks for Public and Personal evidence only; this is the second
 * line: Private evidence is never cited, and an answer whose synthesis used
 * Private context is withheld. Either way, or when the probe saw a Private
 * match, the reply carries one fixed sentence and nothing else about it.
 */
export function answerToolResult(raw: unknown, options: AnswerResultOptions = {}): ChatGptToolResult {
  const record = asRecord(raw);
  if (record?.status === 'working' && typeof record.job_id === 'string' && /^saj_[A-Za-z0-9_-]{1,64}$/.test(record.job_id)) {
    return {
      content: [{ type: 'text', text: PENDING_TEXT }],
      structuredContent: { status: 'working', job_id: record.job_id, next_tool: 'source_answer_result' },
    };
  }
  if (!record || typeof record.answer !== 'string') {
    return errorToolResult(new OperationError('source_index_error', 'unexpected answer shape'));
  }
  const panel = copyPrivateMatch(options.privateMatch);
  let privateMatched = options.privateMatched === true || panel !== undefined;
  const citations: ChatGptCitation[] = [];
  for (const value of Array.isArray(record.evidence) ? record.evidence : []) {
    const evidence = asRecord(value);
    if (!evidence) continue;
    if (typeof evidence.trust_domain !== 'string' || !CITABLE_TRUST_DOMAINS.has(evidence.trust_domain)) {
      privateMatched = true;
      continue;
    }
    const citation = citationFrom(evidence);
    if (citation && citations.length < MAX_CITATIONS) citations.push(citation);
  }
  const synthesis = asRecord(asRecord(record.audit)?.answer_synthesis);
  const usedPrivate = synthesis?.private_context_used === true
    || (typeof synthesis?.secure_local_items_consulted === 'number' && synthesis.secure_local_items_consulted > 0);
  if (usedPrivate) privateMatched = true;
  const answer = usedPrivate ? PRIVATE_ANSWER_WITHHELD : record.answer.replace(UNSAFE_CHARS, '').slice(0, MAX_ANSWER);
  const shownCitations = usedPrivate ? [] : citations;
  const notes = privateMatched ? [DASHBOARD_CHATGPT_VOCABULARY.privateMatches] : [];
  const textParts = [answer];
  if (shownCitations.length > 0) {
    textParts.push('', 'Sources:', ...shownCitations.map((citation, index) => `[${index + 1}] ${citationLine(citation)}`));
  }
  if (notes.length > 0) textParts.push('', ...notes);
  const structuredContent: Record<string, unknown> = {
    status: 'answered',
    answer,
    citations: shownCitations,
    ...(notes.length > 0 ? { notes } : {}),
  };
  if (!panel) return { content: [{ type: 'text', text: textParts.join('\n') }], structuredContent };
  structuredContent.privateMatch = {
    count: panel.count,
    panelState: panel.state,
    ...(panel.percent !== undefined ? { percent: panel.percent } : {}),
  };
  return {
    content: [{ type: 'text', text: textParts.join('\n') }],
    structuredContent,
    _meta: { [PRIVATE_ANSWER_META_KEY]: panel },
  };
}

const PANEL_STATES = new Set<PrivateAnswerPanelState>(['ready', 'no_model', 'model_downloading']);

/**
 * The private answer panel's `_meta` value, field by field: a capped count,
 * the state, the one-time job id (only when `ready`, only in the routable
 * private-job shape) and a download percent. Nothing else, ever: no key, no
 * fetch token, no answer. Undefined when there is no positive count.
 */
export function copyPrivateMatch(match: (PrivateMatchSummary & { jobId?: string }) | undefined): PrivateAnswerMetaV1 | undefined {
  if (!match || !finite(match.count)) return undefined;
  const count = Math.min(PRIVATE_MATCH_COUNT_CAP, whole(match.count));
  if (count === 0) return undefined;
  const state: PrivateAnswerPanelState = PANEL_STATES.has(match.panelState) ? match.panelState : 'no_model';
  const out: PrivateAnswerMetaV1 = { v: 1, count, state };
  if (state === 'ready') {
    if (typeof match.jobId !== 'string' || credentialInstallId('private', match.jobId) === undefined) {
      out.state = 'no_model';
    } else {
      out.jobId = match.jobId;
    }
  }
  if (state === 'model_downloading' && finite(match.percent)) out.percent = Math.max(0, Math.min(100, Math.round(match.percent)));
  return out;
}

/** Proposed vocabulary: the whole answer when only Private items could answer. */
export const PRIVATE_ANSWER_WITHHELD = 'Olympus can answer this only from private items, which stay on your Mac.';

/** Public or Personal evidence only; the caller has already dropped the rest. */
function citationFrom(evidence: Record<string, unknown>): ChatGptCitation | undefined {
  const source = sourceLabel(evidence.provider, evidence.family);
  if (!source) return undefined;
  const citation: ChatGptCitation = { source };
  if (typeof evidence.title === 'string' && evidence.title.trim()) citation.title = text(evidence.title);
  const url = httpsUrl(evidence.uri);
  if (url) citation.url = url;
  const date = dateOnly(evidence.authored_at) ?? dateOnly(evidence.updated_at);
  if (date) citation.date = date;
  return citation;
}

function citationLine(citation: ChatGptCitation): string {
  return [citation.source, citation.title, citation.date, citation.url].filter(Boolean).join(' · ');
}

/** The product's own name for a provider; unknown providers are not cited. */
function sourceLabel(provider: unknown, family: unknown): string | undefined {
  if (typeof provider !== 'string') return undefined;
  const definition = DASHBOARD_SUPPORTED_SOURCES.find((candidate) => candidate.provider === provider)
    ?? DASHBOARD_SUPPORTED_SOURCES.find((candidate) => candidate.source_id.split('.')[0] === provider);
  if (definition && definition.family !== 'model') return definition.label;
  if (family === 'file') return 'Files';
  if (family === 'email') return 'Mail';
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

const ERROR_TEXT: Record<OperationErrorCode | 'unavailable' | 'unknown_tool' | 'internal', string> = {
  invalid_params: 'The request was not valid. Check the arguments and try again.',
  invalid_request: 'The request was not valid. Check the arguments and try again.',
  unsupported_filter: 'That filter is not supported here.',
  config_error: 'Olympus on the Mac needs setup before it can answer. Open Olympus on the Mac.',
  argus_unreachable: 'The answer model on the Mac is not reachable right now. Try again shortly.',
  argus_error: 'The answer model on the Mac could not answer. Try again shortly.',
  email_not_configured: 'Olympus on the Mac needs setup before it can answer. Open Olympus on the Mac.',
  email_unreachable: 'Olympus on the Mac is not reachable right now. Try again shortly.',
  email_error: 'Olympus could not complete this request. Try again shortly.',
  email_policy_violation: 'Olympus withheld this result under the owner\'s privacy rules.',
  source_index_not_enabled: 'Searching sources is not turned on in Olympus on the Mac.',
  source_index_policy_violation: 'Olympus withheld this result under the owner\'s privacy rules.',
  source_index_error: 'Olympus could not complete this request. Try again shortly.',
  source_answer_busy: 'Olympus is busy with another answer. Wait for it to finish, then ask again.',
  source_answer_job_not_found: 'That answer is no longer available. Ask the question again with source_answer.',
  source_answer_deadline: 'Olympus took too long to answer. Ask a narrower question or try again.',
  source_answer_too_large: 'The answer was too large to return. Ask a narrower question.',
  unavailable: 'The Olympus dashboard is not available on the Mac right now. Try again shortly.',
  unknown_tool: 'Olympus does not have that tool.',
  internal: 'Olympus could not complete this request. Try again shortly.',
};

export type ChatGptErrorCode = keyof typeof ERROR_TEXT;

/** A tool-level error with a fixed sentence; the internal message never leaves. */
export function errorToolResult(error: unknown): ChatGptToolResult {
  const code = errorCode(error);
  return {
    content: [{ type: 'text', text: ERROR_TEXT[code] }],
    structuredContent: { error: code },
    isError: true,
  };
}

export function errorCode(error: unknown): ChatGptErrorCode {
  if (error instanceof OperationError && Object.prototype.hasOwnProperty.call(ERROR_TEXT, error.code)) return error.code;
  if (error instanceof ChatGptSurfaceError) return error.code;
  return 'internal';
}

export class ChatGptSurfaceError extends Error {
  constructor(readonly code: ChatGptErrorCode) {
    super(code);
    this.name = 'ChatGptSurfaceError';
  }
}

/** The fixed sentence for a protocol-level error (thrown, not a tool result). */
export function errorMessage(error: unknown): string {
  return ERROR_TEXT[errorCode(error)];
}

/* ------------------------------------------------------------------ */
/* Tool and resource metadata                                          */
/* ------------------------------------------------------------------ */

/** The dashboard tool's `_meta`: MCP Apps link plus OpenAI's sidebar entrypoint. */
export function dashboardToolMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: DASHBOARD_RESOURCE_URI },
    // Legacy alias some ChatGPT clients still read.
    'openai/outputTemplate': DASHBOARD_RESOURCE_URI,
    'openai/ui': { entrypoints: [{ type: 'global' }] },
  };
}

/**
 * The answer tools' `_meta`: their results render the private answer panel,
 * which shows nothing unless the result carries a private match.
 */
export function answerToolMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: PRIVATE_ANSWER_RESOURCE_URI },
    'openai/outputTemplate': PRIVATE_ANSWER_RESOURCE_URI,
  };
}

/* ------------------------------------------------------------------ */
/* Scalars                                                             */
/* ------------------------------------------------------------------ */

function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function identifier(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : '';
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function whole(value: unknown): number {
  return finite(value) ? Math.max(0, Math.round(value)) : 0;
}

function percent(value: unknown): number {
  return finite(value) ? Math.max(0, Math.min(100, Math.round(value * 10) / 10)) : 0;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

function dateOnly(value: unknown): string | undefined {
  return iso(value)?.slice(0, 10);
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function safeHref(value: unknown): string | undefined {
  const url = httpsUrl(value);
  if (!url) return undefined;
  const host = new URL(url).hostname;
  return host === FIX_HREF_HOST || host.endsWith(`.${FIX_HREF_HOST}`) ? url : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
